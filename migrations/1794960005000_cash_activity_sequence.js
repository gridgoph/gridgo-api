export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE cash_journals ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
    CREATE UNIQUE INDEX cash_recovery_decision_once ON cash_journals(order_id,(evidence->>'decisionId')) WHERE kind='shop_recovery_created';
    CREATE OR REPLACE FUNCTION cash_account_initial() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.balance_minor<>0 OR NEW.wallet IS DISTINCT FROM (NEW.id LIKE 'wallet:%' OR NEW.id LIKE 'held:%')
        OR (NEW.wallet AND NEW.rider_id IS NULL) OR (NEW.id LIKE 'wallet:%' AND NEW.id<>'wallet:'||NEW.rider_id) THEN
        RAISE EXCEPTION 'cash initial balances and wallet types are derived' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE OR REPLACE FUNCTION cash_wallet_reconcile_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM cash_accounts WHERE wallet GROUP BY rider_id HAVING sum(balance_minor::numeric)>9007199254740991)
        OR EXISTS(SELECT 1 FROM cash_reservations r LEFT JOIN cash_accounts a ON a.id='held:'||r.order_id
          WHERE a.rider_id IS DISTINCT FROM r.rider_id OR COALESCE(a.balance_minor,0)<>CASE WHEN r.released_at IS NULL THEN r.amount_minor ELSE 0 END) THEN
        RAISE EXCEPTION 'cash_wallet_reconciliation_required' USING ERRCODE='23514'; END IF;
      RETURN NULL; END $$;
  `);
}
export async function down() { throw new Error('Cash activity requires a forward migration'); }
