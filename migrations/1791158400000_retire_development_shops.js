/**
 * Retire the four fixed seed identities in #133 (18 copied listings: 8/6/3/1).
 * Fingerprints keep identifying labels out of this public migration. They are
 * exact md5(users.id) matches, not name, email, photo, or "test" heuristics.
 * Missing identities and every historical order/money association are logged
 * and left for an operator to review. No data or storage objects are deleted.
 */
export async function up(pgm) {
  if (process.env.NODE_ENV !== "production") {
    console.log("demo retirement skipped outside production; development fixtures preserved");
    return;
  }
  pgm.sql(`
    SELECT pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));

    DO $retire$
    DECLARE
      fingerprint text;
      account users%ROWTYPE;
      approval approval_cases%ROWTYPE;
      retired_at timestamptz := transaction_timestamp();
      retirement_reason text := 'Development sample retirement (gridgo-api#133)';
      retirement_actor text := 'migration:1791158400000';
      service_ids jsonb;
    BEGIN
      FOREACH fingerprint IN ARRAY ARRAY[
        'd6b92139ce4bfacd39fef11157849025',
        '1c7445d59be791ec17901e865e2765d0',
        'fccced1631ee734cbff5154a6c191729',
        'ead969007167aa27e5f5a0808810df4e'
      ] LOOP
        SELECT * INTO account FROM users WHERE md5(id) = fingerprint FOR UPDATE;
        IF NOT FOUND THEN
          RAISE LOG 'demo retirement % skipped: identity not found; operator review required', fingerprint;
          RAISE NOTICE 'demo retirement % skipped: identity not found; operator review required', fingerprint;
          CONTINUE;
        END IF;

        -- No distinction between sample and real history: any association is
        -- enough to refuse. Payments and milestone payouts belong to orders;
        -- settlement payouts also have their own explicit supplier recipient.
        IF EXISTS (
          SELECT 1 FROM orders o
           WHERE account.id IN (o.supplier_id, o.client_id, o.rider_id)
              OR jsonb_path_exists(o.data, '$.**.supplierId ? (@ == $id)',
                   jsonb_build_object('id', account.id))
        ) OR EXISTS (
          SELECT 1 FROM order_jobs j WHERE account.id IN (j.supplier_id, j.rider_id)
        ) OR EXISTS (
          SELECT 1 FROM refund_supplier_payouts p WHERE p.supplier_id = account.id
        ) THEN
          RAISE LOG 'demo retirement % skipped: order/payment/payout history; operator decision required', fingerprint;
          RAISE NOTICE 'demo retirement % skipped: order/payment/payout history; operator decision required', fingerprint;
          CONTINUE;
        END IF;

        IF account.account_status <> 'active' THEN
          RAISE LOG 'demo retirement % skipped: account already inactive', fingerprint;
          RAISE NOTICE 'demo retirement % skipped: account already inactive', fingerprint;
          CONTINUE;
        END IF;

        SELECT * INTO approval FROM approval_cases
         WHERE user_id = account.id AND kind = 'supplier' FOR UPDATE;
        IF NOT FOUND OR NOT EXISTS (
          SELECT 1 FROM user_role_memberships WHERE user_id = account.id AND role = 'supplier'
        ) OR EXISTS (
          SELECT 1 FROM user_role_memberships WHERE user_id = account.id AND role IN ('ops_admin', 'super_admin')
        ) THEN
          RAISE LOG 'demo retirement % skipped: supplier identity incomplete or privileged; operator review required', fingerprint;
          RAISE NOTICE 'demo retirement % skipped: supplier identity incomplete or privileged; operator review required', fingerprint;
          CONTINUE;
        END IF;

        SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO service_ids
          FROM supplier_services WHERE supplier_id = account.id AND state = 'live';

        UPDATE users SET account_status = 'suspended',
          account_status_reason = retirement_reason, account_status_at = retired_at,
          account_status_by = retirement_actor,
          verification_status = CASE WHEN role IN ('supplier', 'rider') THEN 'suspended' ELSE verification_status END
          WHERE id = account.id;

        UPDATE approval_cases SET status = 'suspended', suspension_reason = retirement_reason,
          version = version + 1, decided_at = retired_at, decided_by = NULL, updated_at = retired_at
          WHERE id = approval.id;

        UPDATE supplier_services SET state = 'suspended', updated_at = retired_at,
          data = data || jsonb_build_object(
            'approvalSuspensionCaseId', approval.id,
            'approvalSuspensionPreviousState', 'live',
            'suspendedAt', retired_at, 'suspendedBy', retirement_actor,
            'suspendReason', retirement_reason)
          WHERE supplier_id = account.id AND state = 'live';

        INSERT INTO approval_case_events (id, approval_case_id, application_revision,
          from_status, to_status, actor_kind, reason, request_id, snapshot, created_at)
          VALUES ('ace_demo_retirement_' || fingerprint, approval.id, approval.application_revision,
            approval.status, 'suspended', 'system', retirement_reason,
            retirement_actor || ':' || fingerprint,
            jsonb_build_object('suspendedServiceIds', service_ids, 'issue', 'gridgo-api#133'), retired_at);

        INSERT INTO audit_log (id, at, action, entity_type, entity_id, position, data)
          VALUES ('aud_demo_retirement_' || fingerprint, retired_at, 'user.account_suspend',
            'user', account.id, (SELECT COALESCE(max(position), -1) + 1 FROM audit_log),
            jsonb_build_object('reason', retirement_reason, 'detail', jsonb_build_object(
              'status', 'suspended', 'source', retirement_actor, 'suspendedServiceIds', service_ids)));

        -- Durable inbox copies for the owner and every current administrator
        -- membership, including a separate copy for each role of a dual member.
        WITH recipients AS (
          SELECT account.id AS user_id, 'supplier'::text AS role
          UNION
          SELECT user_id, role FROM user_role_memberships WHERE role IN ('ops_admin', 'super_admin')
        )
        INSERT INTO notifications (id, user_id, type, created_at, position, data)
          SELECT 'ntf_demo_retirement_' || fingerprint || '_' || md5(r.user_id || ':' || r.role),
            r.user_id, 'approval_suspended', retired_at,
            (SELECT COALESCE(max(position), -1) FROM notifications) + row_number() OVER (ORDER BY r.user_id, r.role),
            jsonb_build_object('title', 'Development sample account suspended',
              'body', retirement_reason, 'approvalCaseId', approval.id, 'appRole', r.role,
              'domainEventKey', 'approval_case:' || approval.id || ':' || retirement_actor || ':' || fingerprint)
          FROM recipients r;

        RAISE LOG 'demo retirement % suspended; listings retained and hidden', fingerprint;
        RAISE NOTICE 'demo retirement % suspended; listings retained and hidden', fingerprint;
      END LOOP;
    END;
    $retire$;
  `);
}

// Restoring an account is an audited operator decision, never a rollback side effect.
export async function down() {}
