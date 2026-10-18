/** Prospective warning policy; does not alter settings, prices or payout rows. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE supplier_performance_launch (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      launched_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO supplier_performance_launch (singleton) VALUES (true);
    CREATE TABLE supplier_performance_events (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id),
      supplier_id text NOT NULL REFERENCES users(id),
      kind text NOT NULL CHECK (kind IN ('late_finish', 'on_time_finish', 'declined', 'timed_out', 'cancelled', 'arrived_packed', 'no_fault')),
      source_key text NOT NULL,
      occurred_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
      UNIQUE (order_id, supplier_id, source_key)
    );
    CREATE INDEX supplier_performance_recent ON supplier_performance_events (supplier_id, occurred_at DESC);
    CREATE FUNCTION guard_supplier_performance_history() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'supplier performance history is append-only' USING ERRCODE = '23514';
    END; $$;
    CREATE TRIGGER supplier_performance_immutable BEFORE UPDATE OR DELETE ON supplier_performance_events
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_performance_history();
    CREATE TRIGGER supplier_performance_launch_immutable BEFORE UPDATE OR DELETE ON supplier_performance_launch
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_performance_history();
  `);
}
export async function down() { throw new Error('Forward-only supplier performance history'); }
