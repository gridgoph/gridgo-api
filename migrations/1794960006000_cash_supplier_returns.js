export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE cash_journals DROP CONSTRAINT cash_kind_check;
    ALTER TABLE cash_journals ADD CONSTRAINT cash_kind_check CHECK(kind IN
      ('topup_pending','topup_confirmed','topup_rejected','wallet_reserved','wallet_released','gridgo_share_debited',
      'shop_paid','cash_collected','no_show_returned','no_show_repaid','remedy_paid','shop_recovery_created','voucher_funded',
      'redelivery_paid','redelivery_settled','cash_incident_opened','cash_incident_resolution'));
    CREATE TABLE cash_incidents (
      id text PRIMARY KEY, order_id text NOT NULL UNIQUE REFERENCES orders(id),
      supplier_id text NOT NULL REFERENCES users(id), rider_id text NOT NULL REFERENCES users(id),
      source_payment_id text NOT NULL UNIQUE REFERENCES cash_journals(id),
      amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 9007199254740991),
      resolved_minor bigint NOT NULL DEFAULT 0 CHECK(resolved_minor BETWEEN 0 AND amount_minor),
      status text NOT NULL DEFAULT 'outstanding' CHECK(status IN('outstanding','resolved')),
      reason text NOT NULL, evidence_file_id text NOT NULL REFERENCES files(file_id),
      created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL,
      version integer NOT NULL DEFAULT 1
    );
    CREATE INDEX cash_incidents_queue ON cash_incidents(status,created_at);
    CREATE INDEX cash_incidents_rider ON cash_incidents(rider_id,status);
    CREATE TABLE cash_incident_resolutions (
      id text PRIMARY KEY, incident_id text NOT NULL REFERENCES cash_incidents(id),
      resolution_type text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 9007199254740991),
      receipt_file_id text NOT NULL UNIQUE REFERENCES files(file_id),
      journal_id text NOT NULL UNIQUE REFERENCES cash_journals(id),
      actor_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE TRIGGER cash_no_truncate BEFORE TRUNCATE ON cash_incidents FOR EACH STATEMENT EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_no_truncate BEFORE TRUNCATE ON cash_incident_resolutions FOR EACH STATEMENT EXECUTE FUNCTION cash_immutable();
    CREATE TRIGGER cash_resolution_immutable BEFORE UPDATE OR DELETE ON cash_incident_resolutions FOR EACH ROW EXECUTE FUNCTION cash_immutable();
    CREATE FUNCTION cash_incident_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.rider_id IS DISTINCT FROM OLD.rider_id
        OR NEW.source_payment_id IS DISTINCT FROM OLD.source_payment_id OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.evidence_file_id IS DISTINCT FROM OLD.evidence_file_id
        OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR pg_trigger_depth()<2 THEN
        RAISE EXCEPTION 'cash incident facts are immutable; balances are derived' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_incident_immutable BEFORE UPDATE OR DELETE ON cash_incidents FOR EACH ROW EXECUTE FUNCTION cash_incident_guard();
    CREATE FUNCTION cash_resolution_post() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE cash_incidents SET resolved_minor=(SELECT sum(amount_minor) FROM cash_incident_resolutions WHERE incident_id=NEW.incident_id),
        status=CASE WHEN amount_minor=(SELECT sum(amount_minor) FROM cash_incident_resolutions WHERE incident_id=NEW.incident_id) THEN 'resolved' ELSE 'outstanding' END,
        version=version+1 WHERE id=NEW.incident_id;
      RETURN NEW; END $$;
    CREATE TRIGGER cash_resolution_total AFTER INSERT ON cash_incident_resolutions FOR EACH ROW EXECUTE FUNCTION cash_resolution_post();
    CREATE OR REPLACE FUNCTION cash_balance_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text := COALESCE(to_jsonb(NEW)->>'journal_id',to_jsonb(NEW)->>'id'); count_entries integer;
    BEGIN
      SELECT count(*) INTO count_entries FROM cash_entries WHERE journal_id=target;
      IF count_entries=0 AND EXISTS(SELECT 1 FROM cash_journals WHERE id=target AND kind IN
        ('shop_paid','no_show_returned','redelivery_paid','redelivery_settled','cash_incident_opened','cash_incident_resolution') AND evidence->>'amountMinor'='0') THEN RETURN NULL; END IF;
      IF count_entries<2 OR (SELECT sum(amount_minor::numeric) FROM cash_entries WHERE journal_id=target)<>0 THEN
        RAISE EXCEPTION 'cash_unbalanced' USING ERRCODE='23514'; END IF;
      RETURN NULL; END $$;
  `);
}
export async function down() { throw new Error('Cash supplier returns require a forward migration'); }
