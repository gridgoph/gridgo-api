/**
 * Express pickup PIN after "I'm on my way" (docs/EXPRESS_API.md#on-my-way-and-pickup-pin).
 *
 * Version 1 orders keep their immutable checkout `pickupCode`. A version 2
 * order (`expressOrder.handoverVersion = 2`) is created without one: its
 * `pickupPin` appears only when the client says they are on the way. The
 * handover version can never change, so an order cannot switch flows.
 */
export async function up(pgm) {
 pgm.sql(`
 CREATE OR REPLACE FUNCTION protect_express_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
   IF TG_OP='UPDATE' AND OLD.data->>'orderType'='express' AND
     (NEW.data->>'orderType' IS DISTINCT FROM OLD.data->>'orderType'
      OR NEW.data#>'{expressOrder,originalSupplierId}' IS DISTINCT FROM OLD.data#>'{expressOrder,originalSupplierId}'
      OR NEW.data#>'{expressOrder,printSettings}' IS DISTINCT FROM OLD.data#>'{expressOrder,printSettings}'
      OR NEW.data#>'{expressOrder,pickupCode}' IS DISTINCT FROM OLD.data#>'{expressOrder,pickupCode}'
      OR NEW.data#>'{expressOrder,handoverVersion}' IS DISTINCT FROM OLD.data#>'{expressOrder,handoverVersion}') THEN
     RAISE EXCEPTION 'Express checkout snapshot is immutable';
   END IF;
   IF NEW.data->>'orderType'='express' AND
     (NEW.data#>>'{expressOrder,version}' IS DISTINCT FROM '1'
      OR NULLIF(NEW.data#>>'{expressOrder,originalSupplierId}','') IS NULL
      OR CASE COALESCE(NEW.data#>>'{expressOrder,handoverVersion}','1')
           WHEN '1' THEN COALESCE(NEW.data#>>'{expressOrder,pickupCode}','') !~ '^[0-9]{6}$'
           WHEN '2' THEN NEW.data->'expressOrder' ? 'pickupCode'
             OR COALESCE(NEW.data#>>'{expressOrder,pickupPin,code}','000000') !~ '^[0-9]{6}$'
           ELSE true END
      OR COALESCE(NEW.data#>>'{expressOrder,riderPin,code}','000000') !~ '^[0-9]{6}$') THEN
     RAISE EXCEPTION 'Invalid Express checkout snapshot';
   END IF;
   RETURN NEW;
 END $$;
 `);
}
export async function down() { throw new Error('Forward-only migration'); }
