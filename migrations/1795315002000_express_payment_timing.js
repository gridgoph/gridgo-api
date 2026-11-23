export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION protect_express_payment_timing() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.data#>'{expressOrder,paymentTiming}' IS NOT NULL AND NEW.data#>'{expressOrder,paymentTiming}' IS DISTINCT FROM OLD.data#>'{expressOrder,paymentTiming}'
      THEN RAISE EXCEPTION 'Express payment timing is immutable'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER orders_express_payment_timing BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_express_payment_timing();
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
