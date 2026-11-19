/** Express credentials and accepted print facts stay immutable across reassignment. */
export async function up(pgm) {
 pgm.sql(`
 CREATE FUNCTION protect_express_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
   IF TG_OP='UPDATE' AND OLD.data->>'orderType'='express' AND
     (NEW.data->>'orderType' IS DISTINCT FROM OLD.data->>'orderType'
      OR NEW.data#>'{expressOrder,originalSupplierId}' IS DISTINCT FROM OLD.data#>'{expressOrder,originalSupplierId}'
      OR NEW.data#>'{expressOrder,printSettings}' IS DISTINCT FROM OLD.data#>'{expressOrder,printSettings}'
      OR NEW.data#>'{expressOrder,pickupCode}' IS DISTINCT FROM OLD.data#>'{expressOrder,pickupCode}') THEN
     RAISE EXCEPTION 'Express checkout snapshot is immutable';
   END IF;
   IF NEW.data->>'orderType'='express' AND
     (NEW.data#>>'{expressOrder,version}' IS DISTINCT FROM '1'
      OR COALESCE(NEW.data#>>'{expressOrder,pickupCode}','') !~ '^[0-9]{6}$'
      OR NULLIF(NEW.data#>>'{expressOrder,originalSupplierId}','') IS NULL) THEN
     RAISE EXCEPTION 'Invalid Express checkout snapshot';
   END IF;
   RETURN NEW;
 END $$;
 CREATE TRIGGER orders_express_snapshot BEFORE INSERT OR UPDATE ON orders
 FOR EACH ROW EXECUTE FUNCTION protect_express_order_snapshot();
 `);
}
export async function down() { throw new Error('Forward-only migration'); }
