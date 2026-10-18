export const up = pgm => {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN review_data boolean NOT NULL DEFAULT false;
    ALTER TABLE orders ADD COLUMN review_data boolean NOT NULL DEFAULT false;
    ALTER TABLE funnel_events ADD COLUMN review_data boolean NOT NULL DEFAULT false;
    CREATE FUNCTION guard_order_review_data() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.id) THEN
        NEW.review_data := (SELECT review_data FROM users WHERE id = NEW.client_id);
      ELSIF TG_OP = 'UPDATE' AND NEW.review_data IS DISTINCT FROM OLD.review_data THEN
        RAISE EXCEPTION 'review_data_snapshot_immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_review_data_guard BEFORE INSERT OR UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION guard_order_review_data();
    CREATE FUNCTION snapshot_funnel_review_data() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.review_data := COALESCE((SELECT review_data FROM users WHERE id = NEW.client_id), false)
        OR COALESCE((SELECT review_data FROM orders WHERE id = NEW.order_id), false);
      RETURN NEW;
    END $$;
    CREATE TRIGGER funnel_review_data_snapshot BEFORE INSERT ON funnel_events
      FOR EACH ROW EXECUTE FUNCTION snapshot_funnel_review_data();
  `);
};
export const down = () => { throw new Error('Forward-only migration'); };
