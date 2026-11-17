/** Durable reservation metadata uses orders.data and users.data; object bytes remain private MinIO files. */
export async function up(pgm) {
  pgm.sql(`
    UPDATE platform_settings SET settings = '{"riderOfferTimeoutSeconds":30}'::jsonb || settings,
      version = version + 1 WHERE NOT settings ? 'riderOfferTimeoutSeconds';
    CREATE INDEX orders_dispatch_offer_rider ON orders ((data#>>'{dispatchOffer,riderId}'))
      WHERE state = 'ready_for_dispatch' AND rider_id IS NULL AND data#>>'{dispatchOffer,status}' = 'offered';
    CREATE INDEX orders_dispatch_offer_expiry ON orders (((data#>>'{dispatchOffer,expiresAt}')))
      WHERE state = 'ready_for_dispatch' AND rider_id IS NULL AND data#>>'{dispatchOffer,status}' = 'offered';
    CREATE FUNCTION guard_exclusive_dispatch_offer() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM orders WHERE state = 'ready_for_dispatch' AND rider_id IS NULL
          AND data#>>'{dispatchOffer,status}' = 'offered'
          AND NOT EXISTS (SELECT 1 FROM order_removals removed WHERE removed.order_id = orders.id)
          AND data#>>'{dispatchOffer,riderId}' = NEW.data#>>'{dispatchOffer,riderId}'
          GROUP BY data#>>'{dispatchOffer,riderId}' HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'rider already has an exclusive dispatch offer' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER orders_exclusive_dispatch_offer AFTER INSERT OR UPDATE ON orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_exclusive_dispatch_offer();
    CREATE FUNCTION guard_acknowledgement_signature() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.data->'acknowledgementSignature' IS NOT NULL
          AND NEW.data->'acknowledgementSignature' IS DISTINCT FROM OLD.data->'acknowledgementSignature' THEN
        RAISE EXCEPTION 'acknowledgement signature is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER orders_acknowledgement_signature_immutable BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION guard_acknowledgement_signature();
  `);
}
export async function down() { throw new Error('Use a forward migration for signed receipts and rider offers'); }
