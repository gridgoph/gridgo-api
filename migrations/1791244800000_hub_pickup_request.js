/** Opt-in pre-match fulfillment; existing carts and orders keep their flow. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_carts ADD COLUMN request_fulfillment jsonb
      CHECK (request_fulfillment IS NULL OR (
        jsonb_typeof(request_fulfillment) = 'object'
        AND request_fulfillment->>'fulfillmentMode' IN ('delivery', 'pickup')
        AND jsonb_typeof(request_fulfillment->'dropoff') = 'object'
      ));
    UPDATE platform_settings
       SET settings = settings || '{"hubPickup":{"schedule":null,"feeMinor":0}}'::jsonb
     WHERE NOT settings ? 'hubPickup';

    CREATE FUNCTION protect_request_fulfillment_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.commercial_committed_at IS NOT NULL AND (
        NEW.data->'requestFulfillment' IS DISTINCT FROM OLD.data->'requestFulfillment' OR
        NEW.data->'hubPickup' IS DISTINCT FROM OLD.data->'hubPickup' OR
        NEW.data->'pickupFeeMinor' IS DISTINCT FROM OLD.data->'pickupFeeMinor'
      ) THEN
        RAISE EXCEPTION 'committed request fulfillment is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_request_fulfillment_immutable';
      END IF;
      IF NEW.data ? 'hubPickup' AND (
        NEW.fulfillment_mode IS DISTINCT FROM 'pickup' OR
        NEW.rider_commission_bps IS DISTINCT FROM 0 OR
        NEW.delivery_fee_minor IS DISTINCT FROM (NEW.data->>'pickupFeeMinor')::bigint OR
        NEW.delivery_fee_minor IS DISTINCT FROM (NEW.data->'hubPickup'->>'feeMinor')::bigint
      ) THEN
        RAISE EXCEPTION 'hub pickup charge must be a platform-only fulfillment charge'
          USING ERRCODE = '23514', CONSTRAINT = 'orders_hub_pickup_charge_check';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER orders_request_fulfillment_snapshot
      BEFORE INSERT OR UPDATE ON orders FOR EACH ROW
      EXECUTE FUNCTION protect_request_fulfillment_snapshot();
  `);
}

export async function down() {
  throw new Error('Forward-only: request fulfillment snapshots must be preserved.');
}
