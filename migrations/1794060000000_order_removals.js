/** Additive recorded removal. Existing orders, snapshots and money are untouched. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE order_removals (
      order_id text PRIMARY KEY REFERENCES orders(id),
      removed_at timestamptz NOT NULL,
      removed_by text NOT NULL REFERENCES users(id),
      reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000)
    );
    CREATE FUNCTION protect_order_removal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'order removals are immutable' USING ERRCODE = '23514';
    END $$;
    CREATE TRIGGER order_removals_immutable BEFORE UPDATE OR DELETE ON order_removals
      FOR EACH ROW EXECUTE FUNCTION protect_order_removal();
  `);
}
export async function down() {
  throw new Error('Order removals are permanent; this migration is forward-only');
}
