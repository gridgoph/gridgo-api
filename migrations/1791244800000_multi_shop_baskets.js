/** A basket owns one payment; its ordinary orders own fulfillment and money allocations. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE client_carts ADD COLUMN deadline timestamptz;
    CREATE TABLE order_baskets (
      id text PRIMARY KEY,
      client_id text NOT NULL REFERENCES users(id),
      receipt_order_id text NOT NULL REFERENCES orders(id),
      total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 9007199254740991),
      deadline timestamptz NOT NULL,
      fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('delivery','pickup')),
      payment jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE order_basket_groups (
      basket_id text NOT NULL REFERENCES order_baskets(id) ON DELETE CASCADE,
      order_id text NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      position integer NOT NULL CHECK (position >= 0),
      PRIMARY KEY (basket_id, position)
    );
    CREATE INDEX order_baskets_client_idx ON order_baskets(client_id, created_at);
    CREATE FUNCTION guard_basket_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR (TG_TABLE_NAME = 'order_basket_groups' AND TG_OP = 'UPDATE') THEN
        RAISE EXCEPTION 'basket groups are immutable' USING ERRCODE = '23514';
      END IF;
      IF (to_jsonb(NEW) - 'payment' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'payment' - 'updated_at') THEN
        RAISE EXCEPTION 'basket snapshot is immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.payment->>'status' = 'confirmed' AND NEW.payment IS DISTINCT FROM OLD.payment THEN
        RAISE EXCEPTION 'confirmed basket payment is immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER basket_snapshot_guard BEFORE UPDATE OR DELETE ON order_baskets
      FOR EACH ROW EXECUTE FUNCTION guard_basket_snapshot();
    CREATE TRIGGER basket_group_guard BEFORE UPDATE OR DELETE ON order_basket_groups
      FOR EACH ROW EXECUTE FUNCTION guard_basket_snapshot();
    CREATE FUNCTION validate_basket_payment() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target text; b order_baskets%ROWTYPE; group_count integer; total bigint;
    BEGIN
      IF TG_TABLE_NAME = 'order_baskets' THEN target := NEW.id;
      ELSIF TG_TABLE_NAME = 'order_basket_groups' THEN target := NEW.basket_id;
      ELSE
        SELECT basket_id INTO target FROM order_basket_groups WHERE order_id = COALESCE(NEW.order_id, OLD.order_id);
      END IF;
      IF target IS NULL THEN RETURN NULL; END IF;
      SELECT * INTO b FROM order_baskets WHERE id = target;
      SELECT count(*), sum(o.total_minor) INTO group_count, total FROM order_basket_groups g
        JOIN orders o ON o.id = g.order_id WHERE g.basket_id = target;
      IF group_count < 2 OR total IS DISTINCT FROM b.total_minor
        OR NOT EXISTS (SELECT 1 FROM order_basket_groups WHERE basket_id = target AND order_id = b.receipt_order_id AND position = 0)
        OR EXISTS (SELECT 1 FROM order_basket_groups g JOIN orders o ON o.id = g.order_id
          LEFT JOIN order_payments p ON p.order_id = o.id AND p.code = 'initial'
          LEFT JOIN order_payments f ON f.order_id = o.id AND f.code = 'final_online'
          WHERE g.basket_id = target AND (o.client_id <> b.client_id OR o.fulfillment_mode <> b.fulfillment_mode
            OR p.amount_minor IS DISTINCT FROM o.total_minor OR p.status IS DISTINCT FROM b.payment->>'status'
            OR p.method IS DISTINCT FROM 'qr_manual' OR p.data->>'reference' IS DISTINCT FROM b.payment->>'reference'
            OR p.data->>'proofFileId' IS DISTINCT FROM b.payment->>'proofFileId'
            OR f.amount_minor IS DISTINCT FROM 0::bigint OR f.status IS DISTINCT FROM 'not_required')) THEN
        RAISE EXCEPTION 'basket payment must cover every group exactly once' USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER basket_payment_check AFTER INSERT OR UPDATE ON order_baskets
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_basket_payment();
    CREATE CONSTRAINT TRIGGER basket_groups_check AFTER INSERT ON order_basket_groups
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_basket_payment();
    CREATE CONSTRAINT TRIGGER basket_allocations_check AFTER INSERT OR UPDATE OR DELETE ON order_payments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_basket_payment();
  `);
}
export async function down() { throw new Error('Forward migration only'); }
