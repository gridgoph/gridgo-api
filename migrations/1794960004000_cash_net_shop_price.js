export async function up(pgm) {
  pgm.sql(`
    DO $patch$ DECLARE definition text; updated text;
    BEGIN
      SELECT pg_get_functiondef('validate_cash_order(text)'::regprocedure) INTO definition;
      updated:=replace(definition,'stage.amount_minor IS DISTINCT FROM o.supplier_subtotal_minor',
        'stage.amount_minor+stage.production_deduction_minor IS DISTINCT FROM o.supplier_subtotal_minor');
      IF updated=definition THEN RAISE EXCEPTION 'cash net-price patch failed'; END IF;
      EXECUTE updated;
    END $patch$;
    CREATE FUNCTION cash_stage_paid_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.code='cash_shop' AND OLD.status='released' AND (TG_OP='DELETE' OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.production_deduction_minor IS DISTINCT FROM OLD.production_deduction_minor OR NEW.share_percent IS DISTINCT FROM OLD.share_percent
        OR NEW.status IS DISTINCT FROM OLD.status OR NEW.data->'receiptFileId' IS DISTINCT FROM OLD.data->'receiptFileId') THEN
        RAISE EXCEPTION 'paid cash shop amount is immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
    CREATE TRIGGER cash_stage_paid BEFORE UPDATE OR DELETE ON payout_milestones FOR EACH ROW EXECUTE FUNCTION cash_stage_paid_guard();
    CREATE OR REPLACE FUNCTION cash_order_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM validate_cash_order(COALESCE(to_jsonb(NEW)->>'order_id',to_jsonb(OLD)->>'order_id',to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id'));
      RETURN NULL; END $$;
    DROP TRIGGER cash_payment_shape ON order_payments;
    DROP TRIGGER cash_stage_shape ON payout_milestones;
    CREATE CONSTRAINT TRIGGER cash_payment_shape AFTER INSERT OR UPDATE OR DELETE ON order_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_order_check();
    CREATE CONSTRAINT TRIGGER cash_stage_shape AFTER INSERT OR UPDATE OR DELETE ON payout_milestones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_order_check();
    CREATE CONSTRAINT TRIGGER cash_allocation_shape AFTER INSERT OR UPDATE OR DELETE ON order_payment_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_order_check();
  `);
}
export async function down() { throw new Error('Cash net payout protection requires a forward migration'); }
