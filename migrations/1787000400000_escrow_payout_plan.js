/**
 * A shop is paid 40/35/25 of its own cost, and each order keeps the plan it
 * was placed under.
 *
 * The captain's escrow split (gridgo-api#68, #73): 40 percent when production
 * starts, 35 on delivery, 25 once the complaint window has closed -- every
 * share of the shop's own cost, never of the client's total, because GRIDGO is
 * the one paying the shop.
 *
 * Orders already placed were sold under four stages (50/15/25/10) and keep
 * them. So the plan becomes a per-order snapshot, `orders.payout_plan_version`:
 * 1 is the four-stage plan and every existing row, 2 is the escrow split. It is
 * part of the commitment, so the committed-snapshot trigger guards it with the
 * money it splits.
 *
 * The invariant that recomputes each share now reads the version stored beside
 * the stages. It still checks what it always checked -- a quoted order's
 * payments, its stages and the principal behind every release -- and it now
 * also checks the stages of an order-match order placed under the escrow plan.
 * Order-match orders placed before this keep their old exemption: nothing
 * about them was ever checked in SQL, and starting now would refuse the next
 * write to any of them that has drifted.
 *
 * The shares here mirror `src/payout-plan.js`. A new plan is a new version in
 * both places; a published plan is never edited in place.
 * Contract: docs/OPERATIONAL_MODEL_V2_API.md#supplier-payout-milestones.
 */

// Every published plan: (version, code, share in basis points, is it the last
// stage). The last stage of each takes the rounding remainder.
const PLAN_STAGES = `
  (VALUES
    (1, 'printing', 5000, false),
    (1, 'packaging_qc', 1500, false),
    (1, 'delivered', 2500, false),
    (1, 'retention', 1000, true),
    (2, 'production_started', 4000, false),
    (2, 'delivered', 3500, false),
    (2, 'issue_window', 2500, true)
  ) AS plan(version, code, share_bps, is_last)
`;

const PAYOUT_STAGE_CHECK = `
    CREATE FUNCTION validate_order_payout_stages(target_order_id text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE committed orders%ROWTYPE;
    BEGIN
      SELECT * INTO committed FROM orders WHERE id = target_order_id;
      -- Exactly the stages of the order's own plan, each but the last rounded
      -- half-up from the shop's payout and all of them summing to exactly it,
      -- so a set that sums right but splits wrong is still caught.
      IF (SELECT COALESCE(sum(amount_minor), 0) FROM payout_milestones WHERE order_id = committed.id)
           <> committed.supplier_platform_payout_minor OR
         (SELECT count(*) FROM payout_milestones WHERE order_id = committed.id) <>
           (SELECT count(*) FROM ${PLAN_STAGES} WHERE plan.version = committed.payout_plan_version) OR
         EXISTS (
           SELECT 1 FROM payout_milestones m
            WHERE m.order_id = committed.id
              AND NOT EXISTS (
                SELECT 1 FROM ${PLAN_STAGES}
                 WHERE plan.version = committed.payout_plan_version AND plan.code = m.code
              )
         ) OR
         EXISTS (
           SELECT 1
             FROM ${PLAN_STAGES}
             JOIN payout_milestones m ON m.order_id = committed.id AND m.code = plan.code
            WHERE plan.version = committed.payout_plan_version
              AND NOT plan.is_last
              AND m.amount_minor <> floor(
                (committed.supplier_platform_payout_minor::numeric * plan.share_bps + 5000) / 10000
              )
         ) THEN
        RAISE EXCEPTION 'payout milestones do not match committed supplier payout'
          USING ERRCODE = '23514', CONSTRAINT = 'payout_milestones_amount_check';
      END IF;
    END;
    $$;
`;

// The four-stage check as the previous migration wrote it, for `down`.
const FOUR_STAGE_CHECK = `
      SELECT COALESCE(sum(amount_minor), 0) INTO payout_sum
        FROM payout_milestones WHERE order_id = committed.id;
      IF payout_sum <> committed.supplier_platform_payout_minor OR
         (SELECT count(*) FROM payout_milestones WHERE order_id = committed.id) <> 4 OR
         EXISTS (SELECT 1 FROM payout_milestones
                  WHERE order_id = committed.id
                    AND code NOT IN ('printing','packaging_qc','delivered','retention')) OR
         (SELECT amount_minor FROM payout_milestones
           WHERE order_id = committed.id AND code = 'printing')
           IS DISTINCT FROM floor((committed.supplier_platform_payout_minor::numeric * 5000 + 5000) / 10000) OR
         (SELECT amount_minor FROM payout_milestones
           WHERE order_id = committed.id AND code = 'packaging_qc')
           IS DISTINCT FROM floor((committed.supplier_platform_payout_minor::numeric * 1500 + 5000) / 10000) OR
         (SELECT amount_minor FROM payout_milestones
           WHERE order_id = committed.id AND code = 'delivered')
           IS DISTINCT FROM floor((committed.supplier_platform_payout_minor::numeric * 2500 + 5000) / 10000) THEN
        RAISE EXCEPTION 'payout milestones do not match committed supplier payout'
          USING ERRCODE = '23514', CONSTRAINT = 'payout_milestones_amount_check';
      END IF;
`;

function financialChildrenFunction({ orderMatchCheck, payoutCheck }) {
  return `
    CREATE OR REPLACE FUNCTION validate_order_financial_children(target_order_id text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE committed orders%ROWTYPE;
    DECLARE expected_downpayment bigint;
    DECLARE expected_remainder bigint;
    DECLARE initial_amount bigint;
    DECLARE final_amount bigint;
    DECLARE payout_sum bigint;
    DECLARE confirmed_supplier_principal bigint;
    DECLARE released_supplier_principal bigint;
    BEGIN
      SELECT * INTO committed FROM orders WHERE id = target_order_id;
      ${orderMatchCheck}
      IF committed.id IS NULL OR committed.money_model_version <> 2 OR
         committed.commercial_committed_at IS NULL THEN
        RETURN;
      END IF;
      expected_downpayment := floor(
        (committed.supplier_subtotal_minor::numeric * committed.supplier_downpayment_rate_bps + 5000) / 10000
      );
      expected_remainder := committed.supplier_subtotal_minor - expected_downpayment;

      SELECT amount_minor INTO initial_amount FROM order_payments
       WHERE order_id = committed.id AND code = 'initial';
      SELECT amount_minor INTO final_amount FROM order_payments
       WHERE order_id = committed.id AND code = 'final_online';
      IF initial_amount IS DISTINCT FROM expected_downpayment + committed.service_fee_minor OR
         (SELECT count(*) FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial') <> 2 OR
         (SELECT amount_minor FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial' AND component = 'supplier_principal')
           IS DISTINCT FROM expected_downpayment OR
         (SELECT amount_minor FROM order_payment_allocations
           WHERE order_id = committed.id AND payment_code = 'initial' AND component = 'service_fee')
           IS DISTINCT FROM committed.service_fee_minor THEN
        RAISE EXCEPTION 'initial payment allocations do not match committed order'
          USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
      END IF;

      IF committed.payment_plan = 'delivery_online' THEN
        IF final_amount IS DISTINCT FROM expected_remainder + committed.delivery_fee_minor OR
           (SELECT count(*) FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online') <> 2 OR
           (SELECT amount_minor FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online' AND component = 'supplier_principal')
             IS DISTINCT FROM expected_remainder OR
           (SELECT amount_minor FROM order_payment_allocations
             WHERE order_id = committed.id AND payment_code = 'final_online' AND component = 'delivery_pass_through')
             IS DISTINCT FROM committed.delivery_fee_minor THEN
          RAISE EXCEPTION 'final payment allocations do not match committed delivery order'
            USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
        END IF;
      ELSIF final_amount IS NOT NULL OR EXISTS (
        SELECT 1 FROM order_payment_allocations
         WHERE order_id = committed.id AND payment_code = 'final_online'
      ) THEN
        RAISE EXCEPTION 'pickup order cannot have a final online payment'
          USING ERRCODE = '23514', CONSTRAINT = 'order_payment_allocations_shape_check';
      END IF;
      ${payoutCheck}
      SELECT COALESCE(sum(allocation.amount_minor), 0)
        INTO confirmed_supplier_principal
        FROM order_payment_allocations allocation
        JOIN order_payments payment
          ON payment.order_id = allocation.order_id
         AND payment.code = allocation.payment_code
       WHERE allocation.order_id = committed.id
         AND allocation.component = 'supplier_principal'
         AND payment.status = 'confirmed';
      SELECT COALESCE(sum(amount_minor), 0)
        INTO released_supplier_principal
        FROM payout_milestones
       WHERE order_id = committed.id
         AND status = 'released';
      IF released_supplier_principal > confirmed_supplier_principal THEN
        RAISE EXCEPTION 'released payout exceeds confirmed supplier principal'
          USING ERRCODE = '23514',
                CONSTRAINT = 'payout_milestones_collected_principal_check';
      END IF;
    END;
    $$;
  `;
}

function protectCommittedOrderMoney({ guardPayoutPlan }) {
  return `
    CREATE OR REPLACE FUNCTION protect_committed_order_money()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.commercial_committed_at IS NOT NULL AND
         OLD.state = 'awaiting_initial_payment' AND
         NEW.state = 'awaiting_checkout' AND
         NEW.commercial_committed_at IS NULL AND
         NEW.money_model_version IS NOT DISTINCT FROM OLD.money_model_version AND
         NOT EXISTS (SELECT 1 FROM order_payments WHERE order_id = OLD.id) THEN
        RETURN NEW;
      END IF;
      IF OLD.commercial_committed_at IS NOT NULL AND (
        NEW.money_model_version IS DISTINCT FROM OLD.money_model_version OR
        ${guardPayoutPlan ? "NEW.payout_plan_version IS DISTINCT FROM OLD.payout_plan_version OR" : ""}
        NEW.supplier_subtotal_minor IS DISTINCT FROM OLD.supplier_subtotal_minor OR
        NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR
        NEW.service_fee_rate_bps IS DISTINCT FROM OLD.service_fee_rate_bps OR
        NEW.service_fee_minor IS DISTINCT FROM OLD.service_fee_minor OR
        NEW.delivery_fee_minor IS DISTINCT FROM OLD.delivery_fee_minor OR
        NEW.total_minor IS DISTINCT FROM OLD.total_minor OR
        NEW.fulfillment_mode IS DISTINCT FROM OLD.fulfillment_mode OR
        NEW.payment_plan IS DISTINCT FROM OLD.payment_plan OR
        NEW.quote_version IS DISTINCT FROM OLD.quote_version OR
        NEW.supplier_downpayment_rate_bps IS DISTINCT FROM OLD.supplier_downpayment_rate_bps OR
        NEW.online_due_minor IS DISTINCT FROM OLD.online_due_minor OR
        NEW.direct_store_due_minor IS DISTINCT FROM OLD.direct_store_due_minor OR
        NEW.supplier_platform_payout_minor IS DISTINCT FROM OLD.supplier_platform_payout_minor OR
        NEW.dropoff_lat IS DISTINCT FROM OLD.dropoff_lat OR
        NEW.dropoff_lng IS DISTINCT FROM OLD.dropoff_lng OR
        NEW.dropoff_label IS DISTINCT FROM OLD.dropoff_label OR
        NEW.commercial_committed_at IS DISTINCT FROM OLD.commercial_committed_at
        OR NEW.data->'acceptedQuote' IS DISTINCT FROM OLD.data->'acceptedQuote'
        OR NEW.data->'promisedDate' IS DISTINCT FROM OLD.data->'promisedDate'
        OR NEW.data->'deliveryDistanceMeters' IS DISTINCT FROM OLD.data->'deliveryDistanceMeters'
        OR NEW.data->'initialSupplierPrincipalMinor' IS DISTINCT FROM OLD.data->'initialSupplierPrincipalMinor'
        OR NEW.data->'supplierRemainderMinor' IS DISTINCT FROM OLD.data->'supplierRemainderMinor'
        OR NEW.data->'initialOnlineMinor' IS DISTINCT FROM OLD.data->'initialOnlineMinor'
        OR NEW.data->'finalOnlineMinor' IS DISTINCT FROM OLD.data->'finalOnlineMinor'
      ) THEN
        RAISE EXCEPTION 'committed order money and fulfillment snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_committed_snapshot_immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `;
}

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE orders
      ADD COLUMN payout_plan_version integer NOT NULL DEFAULT 1
        CONSTRAINT orders_payout_plan_version_check CHECK (payout_plan_version IN (1, 2));

    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_code_check;
    ALTER TABLE payout_milestones
      ADD CONSTRAINT payout_milestones_code_check CHECK (code IN
        ('printing','packaging_qc','delivered','pickup_handover','retention','initial','completion',
         'production_started','issue_window'));
  `);
  pgm.sql(PAYOUT_STAGE_CHECK);
  pgm.sql(financialChildrenFunction({
    // An order-match order placed under the escrow plan has its stages checked
    // too. Its payments follow the order-match plan, which this function has
    // never modelled, so only the stages are.
    orderMatchCheck: `
      IF committed.id IS NOT NULL AND committed.money_model_version = 3 AND
         committed.payout_plan_version = 2 AND committed.commercial_committed_at IS NOT NULL THEN
        PERFORM validate_order_payout_stages(committed.id);
        RETURN;
      END IF;`,
    payoutCheck: "PERFORM validate_order_payout_stages(committed.id);",
  }));
  pgm.sql(protectCommittedOrderMoney({ guardPayoutPlan: true }));
}

/**
 * Back to the four-stage plan, only while nothing was sold under the escrow one.
 */
export async function down(pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM orders WHERE payout_plan_version <> 1) OR
         EXISTS (SELECT 1 FROM payout_milestones WHERE code IN ('production_started','issue_window')) THEN
        RAISE EXCEPTION 'orders placed under the escrow payout plan exist; their stages cannot be represented by the four-stage plan';
      END IF;
    END
    $$;
  `);
  pgm.sql(protectCommittedOrderMoney({ guardPayoutPlan: false }));
  pgm.sql(financialChildrenFunction({ orderMatchCheck: "", payoutCheck: FOUR_STAGE_CHECK }));
  pgm.sql(`
    DROP FUNCTION validate_order_payout_stages(text);
    ALTER TABLE payout_milestones DROP CONSTRAINT payout_milestones_code_check;
    ALTER TABLE payout_milestones
      ADD CONSTRAINT payout_milestones_code_check CHECK (code IN
        ('printing','packaging_qc','delivered','pickup_handover','retention','initial','completion'));
    ALTER TABLE orders DROP COLUMN payout_plan_version;
  `);
}
