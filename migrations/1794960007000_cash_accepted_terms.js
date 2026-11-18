export async function up(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION cash_stage_paid_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.code='cash_shop' AND (OLD.status='released' OR EXISTS(SELECT 1 FROM orders WHERE id=OLD.order_id AND data#>'{cashProgress,acceptedCashAmounts}' IS NOT NULL))
        AND (TG_OP='DELETE' OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.production_deduction_minor IS DISTINCT FROM OLD.production_deduction_minor
          OR NEW.share_percent IS DISTINCT FROM OLD.share_percent) THEN
        RAISE EXCEPTION 'accepted cash shop amount is immutable' USING ERRCODE='23514'; END IF;
      IF OLD.code='cash_shop' AND OLD.status='released' AND (TG_OP='DELETE' OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.data->'receiptFileId' IS DISTINCT FROM OLD.data->'receiptFileId') THEN
        RAISE EXCEPTION 'paid cash shop facts are immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
    CREATE FUNCTION cash_accepted_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.data#>'{cashProgress,acceptedCashAmounts}' IS NOT NULL AND OLD.data#>'{cashProgress,acceptedCashAmounts}' IS DISTINCT FROM NEW.data#>'{cashProgress,acceptedCashAmounts}' THEN
        RAISE EXCEPTION 'accepted cash custody is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_accepted_terms BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION cash_accepted_terms_guard();
  `);
}
export async function down() { throw new Error('Accepted cash terms require a forward migration'); }
