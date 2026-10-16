/** One immutable response per handover; rewards use the existing voucher ledger. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE voucher_campaigns ADD COLUMN purpose text NOT NULL DEFAULT 'manual'
      CHECK (purpose IN ('manual', 'survey'));
    CREATE TABLE survey_launch (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      launched_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
    );
    INSERT INTO survey_launch DEFAULT VALUES;
    CREATE TABLE order_surveys (
      order_id text PRIMARY KEY REFERENCES orders(id),
      client_id text NOT NULL REFERENCES users(id),
      completed_at timestamptz NOT NULL,
      opened_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at = opened_at + interval '168 hours'),
      fulfillment_kind text NOT NULL CHECK (fulfillment_kind IN ('delivery','pickup')),
      notified_at timestamptz NOT NULL,
      dismissed_at timestamptz,
      submitted_at timestamptz,
      fulfillment_stars integer CHECK (fulfillment_stars BETWEEN 1 AND 5),
      ease_stars integer CHECK (ease_stars BETWEEN 1 AND 5),
      price_feeling integer CHECK (price_feeling BETWEEN 1 AND 5),
      expected_price_minor money_minor CHECK (expected_price_minor >= 0),
      quality_stars integer CHECK (quality_stars BETWEEN 1 AND 5),
      recommend_score integer CHECK (recommend_score BETWEEN 0 AND 10),
      improvement_note text CHECK (length(improvement_note) <= 2000),
      fulfillment_tags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fulfillment_tags) = 'array' AND jsonb_array_length(fulfillment_tags) <= 8),
      ease_tags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(ease_tags) = 'array' AND jsonb_array_length(ease_tags) <= 8),
      needs_follow_up boolean NOT NULL DEFAULT false,
      reward_status text CHECK (reward_status IN ('issued','cooldown')),
      reward_voucher_id text UNIQUE REFERENCES vouchers(id),
      CHECK (completed_at <= opened_at),
      CHECK (submitted_at IS NULL OR (submitted_at >= opened_at AND submitted_at < expires_at
        AND fulfillment_stars IS NOT NULL AND ease_stars IS NOT NULL AND price_feeling IS NOT NULL AND reward_status IS NOT NULL)),
      CHECK ((reward_status = 'issued' AND reward_voucher_id IS NOT NULL) OR (reward_status IS DISTINCT FROM 'issued' AND reward_voucher_id IS NULL)),
      CHECK (reward_status IS NULL OR submitted_at IS NOT NULL)
    );
    CREATE INDEX order_surveys_client_idx ON order_surveys(client_id, submitted_at DESC);
    CREATE INDEX order_surveys_admin_idx ON order_surveys(submitted_at DESC, needs_follow_up) WHERE submitted_at IS NOT NULL;
    CREATE FUNCTION guard_order_survey() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'survey history is immutable' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'UPDATE' AND (OLD.submitted_at IS NOT NULL OR
        ROW(OLD.order_id,OLD.client_id,OLD.completed_at,OLD.opened_at,OLD.expires_at,OLD.fulfillment_kind,OLD.notified_at)
        IS DISTINCT FROM ROW(NEW.order_id,NEW.client_id,NEW.completed_at,NEW.opened_at,NEW.expires_at,NEW.fulfillment_kind,NEW.notified_at)) THEN
        RAISE EXCEPTION 'survey facts and submitted answers are immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM orders WHERE id=NEW.order_id AND client_id=NEW.client_id) THEN
        RAISE EXCEPTION 'survey owner mismatch' USING ERRCODE = '23514';
      END IF;
      IF NEW.reward_voucher_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'));
        IF NOT EXISTS (SELECT 1 FROM vouchers v JOIN voucher_campaigns c ON c.id=v.campaign_id
          WHERE v.id=NEW.reward_voucher_id AND v.client_id=NEW.client_id AND v.value_minor=1500
          AND v.issued_at=NEW.submitted_at AND v.expires_at=v.issued_at + interval '720 hours'
          AND NOT v.email_allowed AND c.purpose='survey') THEN
          RAISE EXCEPTION 'invalid survey reward' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM order_surveys s WHERE s.client_id=NEW.client_id AND s.order_id<>NEW.order_id
          AND s.reward_voucher_id IS NOT NULL AND s.submitted_at > NEW.submitted_at - interval '168 hours'
          AND s.submitted_at < NEW.submitted_at + interval '168 hours') THEN
          RAISE EXCEPTION 'survey reward cooldown' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_surveys_guard BEFORE INSERT OR UPDATE OR DELETE ON order_surveys
      FOR EACH ROW EXECUTE FUNCTION guard_order_survey();
    CREATE TRIGGER survey_launch_immutable BEFORE UPDATE OR DELETE ON survey_launch
      FOR EACH ROW EXECUTE FUNCTION voucher_append_only();
  `);
}
export async function down() { throw new Error('Survey launch and response history are forward-only'); }
