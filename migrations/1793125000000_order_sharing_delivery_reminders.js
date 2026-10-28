export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE order_share_cards (
      order_id text PRIMARY KEY REFERENCES orders(id), client_id text NOT NULL REFERENCES users(id),
      first_shown_at timestamptz, dismissed_at timestamptz, repeat_shown_at timestamptz, closed_at timestamptz,
      CHECK (dismissed_at IS NULL OR dismissed_at >= first_shown_at AND first_shown_at IS NOT NULL),
      CHECK (repeat_shown_at IS NULL OR repeat_shown_at >= dismissed_at AND dismissed_at IS NOT NULL),
      CHECK (closed_at IS NULL OR closed_at >= first_shown_at AND first_shown_at IS NOT NULL)
    );
    CREATE TABLE order_share_taps (
      client_id text NOT NULL REFERENCES users(id), event_id uuid NOT NULL,
      order_id text NOT NULL REFERENCES orders(id), action text NOT NULL CHECK(action IN ('share','send_to_friend')),
      created_at timestamptz NOT NULL, PRIMARY KEY(client_id,event_id)
    );
    CREATE INDEX order_share_taps_order ON order_share_taps(order_id,action,created_at);
    CREATE INDEX order_share_taps_created ON order_share_taps(created_at,client_id);
    CREATE TABLE delivery_reminders (
      order_id text PRIMARY KEY REFERENCES orders(id), client_id text NOT NULL REFERENCES users(id),
      rider_id text NOT NULL REFERENCES users(id), delivered_at timestamptz NOT NULL,
      protocol_version integer NOT NULL CHECK(protocol_version IN (0,1)),
      reminded_client boolean NOT NULL, client_agreed_to_photo boolean NOT NULL,
      package_photo_file_id text REFERENCES files(file_id),
      CHECK(protocol_version <> 1 OR reminded_client),
      CHECK(protocol_version <> 0 OR NOT reminded_client AND NOT client_agreed_to_photo AND package_photo_file_id IS NULL),
      CHECK(package_photo_file_id IS NULL OR client_agreed_to_photo)
    );
    CREATE INDEX delivery_reminders_rider_week ON delivery_reminders(rider_id,delivered_at);
    CREATE FUNCTION guard_order_sharing_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND client_id=NEW.client_id) THEN
        RAISE EXCEPTION 'order sharing owner mismatch' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_share_cards_owner BEFORE INSERT OR UPDATE ON order_share_cards FOR EACH ROW EXECUTE FUNCTION guard_order_sharing_owner();
    CREATE TRIGGER order_share_taps_owner BEFORE INSERT ON order_share_taps FOR EACH ROW EXECUTE FUNCTION guard_order_sharing_owner();
    CREATE FUNCTION guard_sharing_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'sharing evidence is append-only' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER order_share_taps_immutable BEFORE UPDATE OR DELETE ON order_share_taps FOR EACH ROW EXECUTE FUNCTION guard_sharing_append_only();
    CREATE TRIGGER delivery_reminders_immutable BEFORE UPDATE OR DELETE ON delivery_reminders FOR EACH ROW EXECUTE FUNCTION guard_sharing_append_only();
    CREATE FUNCTION guard_share_card_history() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'share card history is immutable' USING ERRCODE='23514'; END IF;
      IF ROW(OLD.order_id,OLD.client_id) IS DISTINCT FROM ROW(NEW.order_id,NEW.client_id)
        OR (OLD.first_shown_at IS NOT NULL AND OLD.first_shown_at IS DISTINCT FROM NEW.first_shown_at)
        OR (OLD.dismissed_at IS NOT NULL AND OLD.dismissed_at IS DISTINCT FROM NEW.dismissed_at)
        OR (OLD.repeat_shown_at IS NOT NULL AND OLD.repeat_shown_at IS DISTINCT FROM NEW.repeat_shown_at)
        OR (OLD.closed_at IS NOT NULL AND OLD IS DISTINCT FROM NEW) THEN
        RAISE EXCEPTION 'share card history is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_share_card_history BEFORE UPDATE OR DELETE ON order_share_cards FOR EACH ROW EXECUTE FUNCTION guard_share_card_history();
    CREATE FUNCTION guard_delivery_reminder_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND client_id=NEW.client_id AND rider_id=NEW.rider_id AND fulfillment_mode='delivery') THEN
        RAISE EXCEPTION 'delivery reminder party mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.package_photo_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files f JOIN file_references r ON r.file_id=f.file_id
        WHERE f.file_id=NEW.package_photo_file_id AND f.owner_id=NEW.rider_id AND f.purpose='delivery_package_photo' AND f.state='ready'
          AND r.reference_type='order' AND r.reference_id=NEW.order_id) THEN
        RAISE EXCEPTION 'delivery package photo mismatch' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    -- File references are written after reminder rows by the compatibility adapter.
    CREATE CONSTRAINT TRIGGER delivery_reminder_owner AFTER INSERT ON delivery_reminders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_delivery_reminder_owner();
  `);
}
export async function down() { throw new Error('Sharing and delivery reminder history is forward-only'); }
