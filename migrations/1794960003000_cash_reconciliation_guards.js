export async function up(pgm) {
  pgm.sql(`
    DROP INDEX cash_incoming_transfer_unique;
    CREATE UNIQUE INDEX cash_incoming_transfer_unique ON cash_journals ((upper(evidence->>'reference')))
      WHERE kind IN('topup_confirmed','no_show_repaid','redelivery_paid') AND evidence->>'reference' IS NOT NULL;
    CREATE UNIQUE INDEX cash_remedy_decision_once ON cash_journals(order_id,(evidence->>'decisionId')) WHERE kind='remedy_paid';
    ALTER TABLE cash_journals ADD CONSTRAINT cash_kind_check CHECK(kind IN
      ('topup_pending','topup_confirmed','topup_rejected','wallet_reserved','wallet_released','gridgo_share_debited',
      'shop_paid','cash_collected','no_show_returned','no_show_repaid','remedy_paid','shop_recovery_created','voucher_funded','redelivery_paid','redelivery_settled'));
    CREATE OR REPLACE FUNCTION cash_balance_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text := COALESCE(to_jsonb(NEW)->>'journal_id',to_jsonb(NEW)->>'id'); count_entries integer;
    BEGIN
      SELECT count(*) INTO count_entries FROM cash_entries WHERE journal_id=target;
      IF count_entries=0 AND EXISTS(SELECT 1 FROM cash_journals WHERE id=target AND kind IN
        ('shop_paid','no_show_returned','redelivery_paid','redelivery_settled') AND evidence->>'amountMinor'='0') THEN RETURN NULL; END IF;
      IF count_entries<2 OR (SELECT sum(amount_minor::numeric) FROM cash_entries WHERE journal_id=target)<>0 THEN
        RAISE EXCEPTION 'cash_unbalanced' USING ERRCODE='23514'; END IF;
      RETURN NULL; END $$;
    CREATE OR REPLACE FUNCTION cash_account_initial() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.balance_minor<>0 OR NEW.wallet IS DISTINCT FROM (NEW.id LIKE 'wallet:%' OR NEW.id LIKE 'held:%')
        OR (NEW.wallet AND NEW.rider_id IS NULL) THEN
        RAISE EXCEPTION 'cash initial balances and wallet types are derived' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE FUNCTION cash_wallet_reconcile_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM cash_accounts WHERE wallet GROUP BY rider_id HAVING sum(balance_minor::numeric)>9007199254740991)
        OR EXISTS(SELECT 1 FROM cash_reservations r LEFT JOIN cash_accounts a ON a.id='held:'||r.order_id
          WHERE COALESCE(a.balance_minor,0)<>CASE WHEN r.released_at IS NULL THEN r.amount_minor ELSE 0 END) THEN
        RAISE EXCEPTION 'cash_wallet_reconciliation_required' USING ERRCODE='23514'; END IF;
      RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER cash_wallet_total AFTER INSERT ON cash_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_wallet_reconcile_guard();
    CREATE CONSTRAINT TRIGGER cash_reservation_balance AFTER INSERT OR UPDATE ON cash_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_wallet_reconcile_guard();
    CREATE OR REPLACE FUNCTION cash_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' OR OLD.released_at IS NOT NULL OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.rider_id IS DISTINCT FROM OLD.rider_id OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.released_at IS NULL OR NOT EXISTS(SELECT 1 FROM cash_journals WHERE event_key='release:'||OLD.order_id
          AND kind=CASE WHEN NEW.consumed THEN 'gridgo_share_debited' ELSE 'wallet_released' END) THEN
        RAISE EXCEPTION 'cash reservation is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE OR REPLACE FUNCTION cash_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE field text;
    BEGIN
      IF OLD.data->'cash' IS NOT NULL AND NEW.data->'cash' IS DISTINCT FROM OLD.data->'cash' THEN
        RAISE EXCEPTION 'cash snapshot is immutable' USING ERRCODE='23514'; END IF;
      FOREACH field IN ARRAY ARRAY['shopPaidAt','shopReceiptFileId','collectedAt','noShowApprovedAt','returnFileId','noShowRiderId','repaymentConfirmedAt'] LOOP
        IF OLD.data->'cashProgress'->field IS NOT NULL AND OLD.data->'cashProgress'->field IS DISTINCT FROM NEW.data->'cashProgress'->field THEN
          RAISE EXCEPTION 'cash custody facts are immutable' USING ERRCODE='23514'; END IF;
      END LOOP;
      IF OLD.data#>>'{cashProgress,redelivery,paidAt}' IS NOT NULL THEN
        FOREACH field IN ARRAY ARRAY['id','pickup','dropoff','feeMinor','riderCommissionBps','riderPayoutMinor','platformDeliveryShareMinor','payment','paidAt'] LOOP
          IF OLD.data->'cashProgress'->'redelivery'->field IS DISTINCT FROM NEW.data->'cashProgress'->'redelivery'->field THEN
            RAISE EXCEPTION 'paid redelivery terms are immutable' USING ERRCODE='23514'; END IF;
        END LOOP;
      END IF;
      RETURN NEW; END $$;
  `);
}
export async function down() { throw new Error('Cash reconciliation requires a forward migration'); }
