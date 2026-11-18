/** Cash stays off. Existing online financial functions and snapshots are unchanged. */
export async function up(pgm) {
  pgm.sql(`
    UPDATE platform_settings SET settings=jsonb_set(settings,'{cash}',
      '{"enabled":false,"limitMinor":150000,"noShowWaitSeconds":600}'),version=version+1 WHERE NOT settings ? 'cash';
    CREATE TABLE cash_accounts (
      id text PRIMARY KEY, rider_id text REFERENCES users(id), wallet boolean NOT NULL,
      balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor BETWEEN -9007199254740991 AND 9007199254740991),
      CHECK (NOT wallet OR balance_minor >= 0)
    );
    CREATE TABLE cash_journals (
      id text PRIMARY KEY, event_key text NOT NULL UNIQUE, kind text NOT NULL,
      order_id text REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
      rider_id text REFERENCES users(id), actor_id text NOT NULL REFERENCES users(id),
      fingerprint text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX cash_journals_order ON cash_journals(order_id,created_at);
    CREATE INDEX cash_journals_rider ON cash_journals(rider_id,created_at);
    CREATE TABLE cash_entries (
      journal_id text NOT NULL REFERENCES cash_journals(id), position integer NOT NULL,
      account_id text NOT NULL REFERENCES cash_accounts(id),
      amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
      PRIMARY KEY(journal_id,position)
    );
    CREATE INDEX cash_entries_account ON cash_entries(account_id);
    CREATE TABLE cash_reservations (
      order_id text PRIMARY KEY REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
      rider_id text NOT NULL REFERENCES users(id), amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 9007199254740991),
      released_at timestamptz, consumed boolean NOT NULL DEFAULT false
    );
    CREATE TABLE cash_requests (
      actor_id text NOT NULL REFERENCES users(id), request_key text NOT NULL,
      fingerprint text NOT NULL, response jsonb NOT NULL, PRIMARY KEY(actor_id,request_key)
    );
    CREATE FUNCTION cash_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'cash ledger is immutable' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER cash_journals_immutable BEFORE UPDATE OR DELETE ON cash_journals FOR EACH ROW EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_entries_immutable BEFORE UPDATE OR DELETE ON cash_entries FOR EACH ROW EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_requests_immutable BEFORE UPDATE OR DELETE ON cash_requests FOR EACH ROW EXECUTE FUNCTION cash_immutable();
    CREATE FUNCTION cash_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' OR pg_trigger_depth()<2 OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.wallet IS DISTINCT FROM OLD.wallet OR NEW.rider_id IS DISTINCT FROM OLD.rider_id THEN
        RAISE EXCEPTION 'cash account balances are derived' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_accounts_derived BEFORE UPDATE OR DELETE ON cash_accounts FOR EACH ROW EXECUTE FUNCTION cash_account_guard();
    CREATE FUNCTION cash_post_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE cash_accounts SET balance_minor=balance_minor+CASE WHEN wallet THEN -NEW.amount_minor ELSE NEW.amount_minor END
        WHERE id=NEW.account_id;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_post AFTER INSERT ON cash_entries FOR EACH ROW EXECUTE FUNCTION cash_post_entry();
    CREATE FUNCTION cash_balance_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text := COALESCE(to_jsonb(NEW)->>'journal_id',to_jsonb(NEW)->>'id');
    BEGIN
      IF (SELECT count(*) FROM cash_entries WHERE journal_id=target)<2 OR
        (SELECT sum(amount_minor::numeric) FROM cash_entries WHERE journal_id=target)<>0 THEN
        RAISE EXCEPTION 'cash_unbalanced' USING ERRCODE='23514'; END IF;
      RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER cash_balanced_journal AFTER INSERT ON cash_journals DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION cash_balance_journal();
    CREATE CONSTRAINT TRIGGER cash_balanced_entry AFTER INSERT ON cash_entries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION cash_balance_journal();
    CREATE FUNCTION cash_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' OR OLD.released_at IS NOT NULL OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.rider_id IS DISTINCT FROM OLD.rider_id OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.released_at IS NULL THEN RAISE EXCEPTION 'cash reservation is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_reservation_immutable BEFORE UPDATE OR DELETE ON cash_reservations FOR EACH ROW EXECUTE FUNCTION cash_reservation_guard();
  `);
}
export async function down() { throw new Error('Cash custody requires a forward migration'); }
