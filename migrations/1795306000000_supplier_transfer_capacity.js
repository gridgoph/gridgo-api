/** Prepared transfers consume capacity for old and new writers alike. */
export async function up(pgm) {
  pgm.sql(`
    CREATE VIEW supplier_verification_capacity_items AS
    WITH paid AS (
      SELECT o.supplier_id, o.id AS order_id, 'stage:'||m.order_id||':'||m.code AS payout_key,
        m.amount_minor AS gross_minor, COALESCE(l.net_amount_minor,m.amount_minor) AS amount_minor
      FROM payout_milestones m JOIN orders o ON o.id=m.order_id
      LEFT JOIN supplier_verification_ledger l ON l.payout_key='stage:'||m.order_id||':'||m.code
        AND l.kind='released' AND l.supplier_id=o.supplier_id AND l.order_id=o.id
      WHERE m.status='released' AND o.payout_plan_version<>3
        AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND NOT o.review_data
      UNION ALL
      SELECT p.supplier_id,p.order_id,'settlement:'||p.id,p.amount_minor,COALESCE(l.net_amount_minor,p.amount_minor)
      FROM refund_supplier_payouts p JOIN orders o ON o.id=p.order_id
      LEFT JOIN supplier_verification_ledger l ON l.payout_key='settlement:'||p.id AND l.kind='released'
        AND l.supplier_id=p.supplier_id AND l.order_id=o.id
      WHERE p.status='released' AND o.payout_plan_version<>3
        AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND NOT o.review_data
      UNION ALL
      SELECT p.supplier_id,p.order_id,'change:'||p.order_id||':'||p.change_id,p.amount_minor,COALESCE(l.net_amount_minor,p.amount_minor)
      FROM order_change_payouts p JOIN orders o ON o.id=p.order_id
      LEFT JOIN supplier_verification_ledger l ON l.payout_key='change:'||p.order_id||':'||p.change_id AND l.kind='released'
        AND l.supplier_id=p.supplier_id AND l.order_id=o.id
      WHERE o.payout_plan_version<>3 AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND NOT o.review_data
    ), latest AS (SELECT DISTINCT ON(payout_key) * FROM supplier_verification_ledger ORDER BY payout_key,position DESC)
    SELECT *, 'paid'::text AS capacity_kind FROM paid
    UNION ALL
    SELECT l.supplier_id,l.order_id,l.payout_key,l.amount_minor,l.net_amount_minor,'reserved'
    FROM latest l JOIN orders o ON o.id=l.order_id
    WHERE l.kind='reserved' AND o.payout_plan_version<>3
      AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND NOT o.review_data
      AND NOT EXISTS(SELECT 1 FROM paid p WHERE p.payout_key=l.payout_key AND p.order_id=l.order_id
        AND p.supplier_id=l.supplier_id AND p.amount_minor=l.net_amount_minor);

    CREATE OR REPLACE FUNCTION supplier_verification_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; shop text; cap bigint; paid numeric; exposure numeric; payout text; target_plan int;
    BEGIN
      target:=COALESCE(to_jsonb(NEW)->>'order_id',to_jsonb(NEW)->>'id');
      SELECT supplier_id,payout_plan_version INTO shop,target_plan FROM orders WHERE id=target;
      IF target_plan=4 THEN PERFORM validate_order_payout_stages(target); END IF;
      IF TG_TABLE_NAME='orders' OR shop IS NULL OR EXISTS(SELECT 1 FROM orders WHERE id=target
        AND (payout_plan_version=3 OR jsonb_typeof(data->'cash')='object')) THEN RETURN NULL; END IF;
      IF TG_TABLE_NAME='supplier_verification_ledger' THEN
        IF NEW.kind NOT IN ('reserved','released') THEN RETURN NULL; END IF;
      ELSE
        IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>'status')='released' THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME<>'order_change_payouts' AND (to_jsonb(NEW)->>'status') IS DISTINCT FROM 'released' THEN RETURN NULL; END IF;
      END IF;
      IF TG_TABLE_NAME IN ('order_change_payouts','refund_supplier_payouts') AND (to_jsonb(NEW)->>'receipt_file_id') IS NULL
        AND NOT EXISTS(SELECT 1 FROM supplier_verification_ledger l WHERE l.kind='released' AND l.order_id=target
          AND l.payout_key=CASE WHEN TG_TABLE_NAME='order_change_payouts' THEN 'change:'||target||':'||(to_jsonb(NEW)->>'change_id') ELSE 'settlement:'||(to_jsonb(NEW)->>'id') END
          AND l.amount_minor=(to_jsonb(NEW)->>'amount_minor')::bigint AND l.net_amount_minor=0 AND l.recovery_minor=l.amount_minor)
      THEN RAISE EXCEPTION 'verification offset ledger required' USING ERRCODE='23514'; END IF;
      IF TG_TABLE_NAME='payout_milestones' THEN
       IF NEW.data ? 'transferReconciliation' AND NOT EXISTS(SELECT 1 FROM supplier_verification_ledger l
          WHERE l.payout_key='stage:'||target||':'||NEW.code AND l.kind='released' AND l.order_id=target AND l.supplier_id=shop
            AND l.amount_minor=NEW.amount_minor AND l.data->>'reconciled'='true'
            AND l.data->>'attemptId'=NEW.data#>>'{transferReconciliation,attemptId}'
            AND l.data->>'transferReference'=NEW.data#>>'{transferReconciliation,reference}'
            AND l.data->>'transferReceiptFileId'=NEW.data#>>'{transferReconciliation,receiptFileId}'
            AND (l.data->>'transferAmountMinor')::bigint=(NEW.data#>>'{transferReconciliation,amountMinor}')::bigint)
      THEN RAISE EXCEPTION 'supplier_transfer_reconciliation_ledger_required' USING ERRCODE='23514'; END IF;
      END IF;
      IF NOT EXISTS(SELECT 1 FROM approval_cases WHERE user_id=shop AND kind='supplier' AND status='pending') THEN RETURN NULL; END IF;
      SELECT COALESCE((settings#>>'{supplierVerification,payoutCapMinor}')::bigint,500000) INTO cap FROM platform_settings WHERE singleton;
      SELECT COALESCE(sum(amount_minor),0) INTO paid FROM supplier_verification_capacity_items WHERE supplier_id=shop;
      payout:=CASE WHEN TG_TABLE_NAME='payout_milestones' THEN 'stage:'||target||':'||(to_jsonb(NEW)->>'code')
        WHEN TG_TABLE_NAME='refund_supplier_payouts' THEN 'settlement:'||(to_jsonb(NEW)->>'id')
        WHEN TG_TABLE_NAME='order_change_payouts' THEN 'change:'||target||':'||(to_jsonb(NEW)->>'change_id') ELSE to_jsonb(NEW)->>'payout_key' END;
      SELECT COALESCE(max(amount_minor),0) INTO exposure FROM supplier_verification_capacity_items WHERE payout_key=payout AND supplier_id=shop;
      IF exposure>0 AND paid>COALESCE(cap,500000) THEN RAISE EXCEPTION 'verification_payout_cap' USING ERRCODE='23514'; END IF;
      IF (SELECT count(DISTINCT o.id) FROM orders o JOIN supplier_verification_capacity_items c ON c.order_id=o.id
          WHERE c.supplier_id=shop AND c.gross_minor>0 AND o.data->>'orderType' IS DISTINCT FROM 'express'
            AND o.state NOT IN ('delivered','issue_window_open','completed','payout_released','cancelled'))>2
      THEN RAISE EXCEPTION 'verification_open_jobs' USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER supplier_verification_reservation_capacity AFTER INSERT ON supplier_verification_ledger
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_verification_release_guard();
    CREATE FUNCTION supplier_verification_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE new_cap bigint; old_cap bigint;
    BEGIN
      new_cap:=COALESCE((NEW.settings#>>'{supplierVerification,payoutCapMinor}')::bigint,500000);
      old_cap:=COALESCE((OLD.settings#>>'{supplierVerification,payoutCapMinor}')::bigint,500000);
      IF new_cap<old_cap AND EXISTS(SELECT 1 FROM supplier_verification_capacity_items c
        JOIN approval_cases a ON a.user_id=c.supplier_id AND a.kind='supplier' AND a.status='pending'
        GROUP BY c.supplier_id HAVING sum(c.amount_minor)>new_cap AND bool_or(c.capacity_kind='reserved'))
      THEN RAISE EXCEPTION 'verification_policy_reconciliation_required' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER supplier_verification_policy_capacity BEFORE UPDATE ON platform_settings
      FOR EACH ROW EXECUTE FUNCTION supplier_verification_policy_guard();

    CREATE FUNCTION supplier_transfer_context_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text;
    BEGIN
      IF TG_TABLE_NAME='orders' THEN
        IF OLD.supplier_id IS NOT DISTINCT FROM NEW.supplier_id THEN RETURN NEW; END IF;
        target:=NEW.id;
      ELSE target:=NEW.order_id; END IF;
      IF EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(payout_key) order_id,kind FROM supplier_verification_ledger
        WHERE order_id=target ORDER BY payout_key,position DESC) l WHERE l.kind='reserved')
      THEN RAISE EXCEPTION 'supplier_transfer_reconciliation_required' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER supplier_transfer_beneficiary_guard BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION supplier_transfer_context_guard();
    CREATE CONSTRAINT TRIGGER supplier_transfer_settlement_guard AFTER INSERT ON refund_settlements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_transfer_context_guard();
    CREATE FUNCTION supplier_prepared_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE key text;
    BEGIN
      key:=CASE WHEN TG_TABLE_NAME='payout_milestones' THEN 'stage:'||OLD.order_id||':'||(to_jsonb(OLD)->>'code') ELSE 'settlement:'||(to_jsonb(OLD)->>'id') END;
      IF (NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
          OR (to_jsonb(NEW)->>'production_deduction_minor') IS DISTINCT FROM (to_jsonb(OLD)->>'production_deduction_minor')
          OR (NEW.status='superseded' AND OLD.status IS DISTINCT FROM 'superseded'))
        AND (SELECT kind FROM supplier_verification_ledger WHERE payout_key=key ORDER BY position DESC LIMIT 1)='reserved'
      THEN RAISE EXCEPTION 'supplier_transfer_reconciliation_required' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER supplier_prepared_stage_snapshot BEFORE UPDATE ON payout_milestones
      FOR EACH ROW EXECUTE FUNCTION supplier_prepared_item_guard();
    CREATE TRIGGER supplier_prepared_settlement_snapshot BEFORE UPDATE ON refund_supplier_payouts
      FOR EACH ROW EXECUTE FUNCTION supplier_prepared_item_guard();

    CREATE FUNCTION supplier_prepared_stage_recording_allowed(target text,stage text,amount bigint,details jsonb)
      RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT COALESCE((details#>>'{transferReconciliation,fundsSentConfirmed}')='true'
        AND (details#>>'{transferReconciliation,amountMinor}')::bigint>0
        AND EXISTS(SELECT 1 FROM supplier_verification_ledger l JOIN orders o ON o.id=l.order_id
          WHERE l.payout_key='stage:'||target||':'||stage AND l.kind='reserved'
            AND l.order_id=target AND l.supplier_id=o.supplier_id AND l.amount_minor=amount
            AND l.position=(SELECT max(position) FROM supplier_verification_ledger WHERE payout_key=l.payout_key)
            AND COALESCE(l.data->>'attemptId',l.id)=details#>>'{transferReconciliation,attemptId}')
        AND EXISTS(SELECT 1 FROM files f WHERE f.file_id=details#>>'{transferReconciliation,receiptFileId}'
          AND f.state='ready' AND f.purpose='payout_receipt' AND f.object_key IS NOT NULL)
        AND length(details#>>'{transferReconciliation,reference}')>0,false);
    $$;
    -- Preserve all existing refund/credit exceptions and immutable closed stages.
    -- Only an evidenced frozen attempt may pass the original-stage hold; its
    -- matching released ledger proof is checked again at COMMIT above.
    DO $patch$ DECLARE definition text; refusal text;
    BEGIN
      refusal:='RAISE EXCEPTION ''refund holds the original payout stages'' USING ERRCODE=''23514'', CONSTRAINT=''refund_milestone_held'';';
      SELECT pg_get_functiondef('protect_refund_milestone()'::regprocedure) INTO definition;
      IF position(refusal IN definition)=0 THEN RAISE EXCEPTION 'refund milestone guard changed; review reconciliation exception'; END IF;
      definition:=replace(definition,refusal,'IF NOT supplier_prepared_stage_recording_allowed(NEW.order_id,NEW.code,NEW.amount_minor,NEW.data) THEN '||refusal||' END IF;');
      EXECUTE definition;
    END $patch$;
  `);
}
export async function down() {throw new Error('Forward-only migration');}
