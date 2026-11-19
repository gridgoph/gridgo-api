/** Keep Express drafts and accepted line print settings across request boundaries. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_carts ADD COLUMN order_type text;
    ALTER TABLE client_carts ADD COLUMN express_location jsonb;
    ALTER TABLE client_cart_lines ADD COLUMN express_print jsonb;
    ALTER TABLE order_line_items ADD COLUMN express_print jsonb;

    CREATE FUNCTION protect_express_line_print() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND OLD.express_print IS DISTINCT FROM NEW.express_print THEN
        RAISE EXCEPTION 'Express line print snapshot is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_express_print_immutable BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION protect_express_line_print();
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
