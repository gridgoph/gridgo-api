/** No historical backfill. A transactional counter, never a PostgreSQL sequence. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE acknowledgement_receipt_counter (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      last_number bigint NOT NULL CHECK (last_number BETWEEN 0 AND 9007199254740991)
    );
    INSERT INTO acknowledgement_receipt_counter(singleton,last_number) VALUES(true,0);
    CREATE TABLE acknowledgement_receipts (
      order_id text PRIMARY KEY REFERENCES orders(id),
      ar_sequence bigint NOT NULL UNIQUE CHECK (ar_sequence BETWEEN 1 AND 9007199254740991),
      issued_at timestamptz NOT NULL,
      grand_total_minor money_minor NOT NULL CHECK (grand_total_minor >= 0),
      rounding_adjustment_minor money_minor NOT NULL,
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      CHECK ((snapshot->>'grandTotalMinor')::bigint = grand_total_minor),
      CHECK ((snapshot->>'roundingAdjustmentMinor')::bigint = rounding_adjustment_minor),
      CHECK (abs(rounding_adjustment_minor) <= jsonb_array_length(snapshot->'lines'))
    );
    CREATE FUNCTION guard_acknowledgement_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'acknowledgement receipts are immutable' USING ERRCODE='23514';
    END $$;
    CREATE TRIGGER acknowledgement_receipts_immutable BEFORE UPDATE OR DELETE ON acknowledgement_receipts
      FOR EACH ROW EXECUTE FUNCTION guard_acknowledgement_receipt();
    CREATE TRIGGER acknowledgement_receipts_no_truncate BEFORE TRUNCATE ON acknowledgement_receipts
      FOR EACH STATEMENT EXECUTE FUNCTION guard_acknowledgement_receipt();
    CREATE FUNCTION guard_acknowledgement_counter() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'acknowledgement counter cannot be reset' USING ERRCODE='23514';
      END IF;
      IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.last_number <> OLD.last_number + 1 THEN
        RAISE EXCEPTION 'acknowledgement counter must advance once' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER acknowledgement_counter_monotonic BEFORE UPDATE OR DELETE ON acknowledgement_receipt_counter
      FOR EACH ROW EXECUTE FUNCTION guard_acknowledgement_counter();
    CREATE TRIGGER acknowledgement_counter_no_truncate BEFORE TRUNCATE ON acknowledgement_receipt_counter
      FOR EACH STATEMENT EXECUTE FUNCTION guard_acknowledgement_counter();
  `);
}
export async function down() { throw new Error('Acknowledgement receipt numbers must never be reset or reused.'); }
