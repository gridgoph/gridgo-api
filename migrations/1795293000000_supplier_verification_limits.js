/** Add the ledger and widen evidence rules for audited zero-transfer offsets.
 * Existing legacy INSERT/upsert column shapes remain valid. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE supplier_verification_ledger (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES users(id),
      order_id text REFERENCES orders(id),
      payout_key text NOT NULL,
      kind text NOT NULL CHECK(kind IN ('held','available','reserved','released','recovery_due','recovered','reminder','reservation_cancelled')),
      amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 9007199254740991),
      created_at timestamptz NOT NULL,
      actor_id text REFERENCES users(id),
      position integer NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX supplier_verification_ledger_key_idx ON supplier_verification_ledger(payout_key,position DESC);
    CREATE INDEX supplier_verification_ledger_shop_idx ON supplier_verification_ledger(supplier_id,created_at,id);
    CREATE UNIQUE INDEX supplier_verification_release_once_idx ON supplier_verification_ledger(payout_key) WHERE kind='released';
    CREATE UNIQUE INDEX supplier_verification_debt_once_idx ON supplier_verification_ledger(payout_key) WHERE kind IN ('recovery_due','recovered','reminder');
    CREATE TRIGGER supplier_verification_ledger_immutable BEFORE UPDATE OR DELETE ON supplier_verification_ledger
      FOR EACH ROW EXECUTE FUNCTION protect_refund_ledger();
    ALTER TABLE order_change_payouts ALTER COLUMN receipt_file_id DROP NOT NULL;
    ALTER TABLE order_change_payouts ADD CONSTRAINT order_change_verification_offset CHECK(receipt_file_id IS NOT NULL OR reference LIKE 'verification-offset:%');
    DO $$ DECLARE constraint_name text; BEGIN
      SELECT conname INTO STRICT constraint_name FROM pg_constraint WHERE conrelid='refund_supplier_payouts'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%receipt_file_id%';
      EXECUTE format('ALTER TABLE refund_supplier_payouts DROP CONSTRAINT %I',constraint_name);
    END $$;
    ALTER TABLE refund_supplier_payouts ADD CONSTRAINT refund_supplier_payout_evidence CHECK(
      (status='released')=(reference IS NOT NULL AND btrim(reference)<>'' AND released_at IS NOT NULL AND released_by IS NOT NULL
        AND (receipt_file_id IS NOT NULL OR reference LIKE 'verification-offset:%')));
    ALTER TABLE orders DROP CONSTRAINT orders_payout_plan_version_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payout_plan_version_check CHECK(payout_plan_version IN(1,2,3,4));
    DO $patch$ DECLARE definition text;
    BEGIN
      SELECT pg_get_functiondef('validate_order_payout_stages(text)'::regprocedure) INTO definition;
      definition:=replace(definition,'BEGIN','BEGIN
        IF EXISTS(SELECT 1 FROM orders WHERE id=target_order_id AND payout_plan_version=4) THEN
          IF (SELECT count(*) FROM payout_milestones WHERE order_id=target_order_id)<>1
            OR NOT EXISTS(SELECT 1 FROM payout_milestones m JOIN orders o ON o.id=m.order_id
              WHERE o.id=target_order_id AND m.code=''delivered'' AND m.share_percent=100
              AND m.amount_minor+m.production_deduction_minor-COALESCE((m.data->>''priceAdjustmentMinor'')::bigint,0)=o.supplier_platform_payout_minor)
          THEN RAISE EXCEPTION ''invalid Express payout plan'' USING ERRCODE=''23514''; END IF;
          RETURN;
        END IF;');
      EXECUTE definition;
    END $patch$;
    CREATE FUNCTION supplier_verification_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      -- The compatibility adapter proposes an INSERT even for an existing row.
      -- Preserve an issued cash protocol before evaluating a genuinely new one.
      IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM orders WHERE id=NEW.id) THEN RETURN NEW; END IF;
      IF TG_OP='UPDATE' AND (OLD.payment_plan='cash_delivery' OR jsonb_typeof(OLD.data->'cash')='object') THEN RETURN NEW; END IF;
      IF (NEW.payment_plan='cash_delivery' OR jsonb_typeof(NEW.data->'cash')='object') AND NOT EXISTS(SELECT 1 FROM approval_cases WHERE user_id=NEW.supplier_id AND kind='supplier' AND status='approved')
      THEN RAISE EXCEPTION 'cash_supplier_verification_required' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER supplier_verification_new_cash BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION supplier_verification_cash_guard();
    -- Deferred release checks also protect a legacy writer during rolling deploys.
    -- They inspect committed children, rather than CHECKing an old upsert's proposed INSERT.
    CREATE FUNCTION supplier_verification_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; shop text; cap bigint; paid numeric; target_plan int;
    BEGIN
      target:=COALESCE(to_jsonb(NEW)->>'order_id',to_jsonb(NEW)->>'id');
      SELECT supplier_id,payout_plan_version INTO shop,target_plan FROM orders WHERE id=target;
      IF target_plan=4 THEN PERFORM validate_order_payout_stages(target); END IF;
      IF TG_TABLE_NAME='orders' OR shop IS NULL OR EXISTS(SELECT 1 FROM orders WHERE id=target AND (payout_plan_version=3 OR jsonb_typeof(data->'cash')='object')) THEN RETURN NULL; END IF;
      IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>'status')='released' THEN RETURN NULL; END IF;
      IF TG_TABLE_NAME<>'order_change_payouts' AND (to_jsonb(NEW)->>'status') IS DISTINCT FROM 'released' THEN RETURN NULL; END IF;
      IF TG_TABLE_NAME IN ('order_change_payouts','refund_supplier_payouts') AND (to_jsonb(NEW)->>'receipt_file_id') IS NULL
        AND NOT EXISTS(SELECT 1 FROM supplier_verification_ledger l WHERE l.kind='released' AND l.order_id=target
          AND l.payout_key=CASE WHEN TG_TABLE_NAME='order_change_payouts' THEN 'change:'||target||':'||(to_jsonb(NEW)->>'change_id') ELSE 'settlement:'||(to_jsonb(NEW)->>'id') END
          AND l.amount_minor=(to_jsonb(NEW)->>'amount_minor')::bigint
          AND (l.data->>'netAmountMinor')::bigint=0 AND (l.data->>'recoveryMinor')::bigint=l.amount_minor)
      THEN RAISE EXCEPTION 'verification offset ledger required' USING ERRCODE='23514'; END IF;
      IF NOT EXISTS(SELECT 1 FROM approval_cases WHERE user_id=shop AND kind='supplier' AND status='pending') THEN RETURN NULL; END IF;
      SELECT COALESCE((settings#>>'{supplierVerification,payoutCapMinor}')::bigint,500000) INTO cap FROM platform_settings WHERE singleton;
      SELECT COALESCE(sum(amount),0) INTO paid FROM (
        SELECT COALESCE((l.data->>'netAmountMinor')::bigint,m.amount_minor) AS amount
          FROM payout_milestones m JOIN orders o ON o.id=m.order_id
          LEFT JOIN supplier_verification_ledger l ON l.payout_key='stage:'||m.order_id||':'||m.code AND l.kind='released'
          WHERE o.supplier_id=shop AND o.payout_plan_version<>3 AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND NOT o.review_data AND m.status='released'
        UNION ALL SELECT COALESCE((l.data->>'netAmountMinor')::bigint,p.amount_minor)
          FROM refund_supplier_payouts p JOIN orders o ON o.id=p.order_id
          LEFT JOIN supplier_verification_ledger l ON l.payout_key='settlement:'||p.id AND l.kind='released'
          WHERE p.supplier_id=shop AND p.status='released' AND o.payout_plan_version<>3 AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND NOT o.review_data
        UNION ALL SELECT COALESCE((l.data->>'netAmountMinor')::bigint,p.amount_minor)
          FROM order_change_payouts p JOIN orders o ON o.id=p.order_id
          LEFT JOIN supplier_verification_ledger l ON l.payout_key='change:'||p.order_id||':'||p.change_id AND l.kind='released'
          WHERE p.supplier_id=shop AND o.payout_plan_version<>3 AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND NOT o.review_data
      ) totals;
      IF paid>COALESCE(cap,500000) THEN RAISE EXCEPTION 'verification_payout_cap' USING ERRCODE='23514'; END IF;
      IF EXISTS(SELECT 1 FROM orders WHERE id=target AND data->>'orderType' IS DISTINCT FROM 'express'
        AND state NOT IN ('delivered','issue_window_open','completed','payout_released','cancelled'))
        AND (SELECT count(*) FROM orders o WHERE o.supplier_id=shop AND o.payout_plan_version<>3 AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object'
          AND NOT o.review_data AND o.data->>'orderType' IS DISTINCT FROM 'express'
          AND o.state NOT IN ('delivered','issue_window_open','completed','payout_released','cancelled')
          AND EXISTS(SELECT 1 FROM payout_milestones m WHERE m.order_id=o.id AND m.status='released' AND m.amount_minor>0))>2
      THEN RAISE EXCEPTION 'verification_open_jobs' USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER supplier_verification_stage_release AFTER INSERT OR UPDATE ON payout_milestones
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_verification_release_guard();
    CREATE CONSTRAINT TRIGGER supplier_verification_settlement_release AFTER INSERT OR UPDATE ON refund_supplier_payouts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_verification_release_guard();
    CREATE CONSTRAINT TRIGGER supplier_verification_change_release AFTER INSERT OR UPDATE ON order_change_payouts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_verification_release_guard();
    CREATE CONSTRAINT TRIGGER supplier_verification_express_plan AFTER INSERT OR UPDATE ON orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_verification_release_guard();
    UPDATE platform_settings SET settings=settings || jsonb_build_object(
      'supplierVerification',COALESCE(settings->'supplierVerification','{"payoutCapMinor":500000,"windowDays":30}'::jsonb));
  `);
}
export async function down() {throw new Error('Forward-only migration');}
