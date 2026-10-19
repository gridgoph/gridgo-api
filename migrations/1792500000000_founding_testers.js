/** Forward-only tester entitlement; progress derives from existing domain facts. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE voucher_campaigns DROP CONSTRAINT voucher_campaigns_purpose_check;
    ALTER TABLE voucher_campaigns ADD CHECK (purpose IN ('manual','survey','founding_tester'));
    ALTER TABLE order_surveys DROP CONSTRAINT order_surveys_reward_status_check;
    ALTER TABLE order_surveys ADD CHECK (reward_status IN ('issued','cooldown','founding_tester'));
    CREATE TABLE founding_testers (
      client_id text PRIMARY KEY REFERENCES users(id),
      awarded_at timestamptz,
      reward_voucher_id text UNIQUE REFERENCES vouchers(id),
      reward_reused boolean NOT NULL DEFAULT false,
      reminded_2_at timestamptz,
      reminded_5_at timestamptz,
      CHECK ((awarded_at IS NULL) = (reward_voucher_id IS NULL)),
      CHECK (NOT reward_reused OR awarded_at IS NOT NULL)
    );
    CREATE INDEX founding_testers_awarded_idx ON founding_testers(awarded_at) WHERE awarded_at IS NOT NULL;
    CREATE FUNCTION guard_founding_tester() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tester history is immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='UPDATE' AND (OLD.client_id IS DISTINCT FROM NEW.client_id
        OR (OLD.awarded_at IS NOT NULL AND ROW(OLD.awarded_at,OLD.reward_voucher_id,OLD.reward_reused)
          IS DISTINCT FROM ROW(NEW.awarded_at,NEW.reward_voucher_id,NEW.reward_reused))
        OR (OLD.reminded_2_at IS NOT NULL AND OLD.reminded_2_at IS DISTINCT FROM NEW.reminded_2_at)
        OR (OLD.reminded_5_at IS NOT NULL AND OLD.reminded_5_at IS DISTINCT FROM NEW.reminded_5_at)) THEN
        RAISE EXCEPTION 'tester history is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.awarded_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM vouchers v JOIN voucher_campaigns c ON c.id=v.campaign_id
        JOIN users u ON u.id=v.client_id WHERE v.id=NEW.reward_voucher_id AND v.client_id=NEW.client_id
          AND NOT u.review_data AND v.value_minor=1500 AND NOT v.email_allowed
          AND v.expires_at=v.issued_at + interval '720 hours'
          AND ((NEW.reward_reused AND c.purpose='survey' AND EXISTS
            (SELECT 1 FROM order_surveys s WHERE s.client_id=NEW.client_id AND s.reward_voucher_id=v.id))
            OR (NOT NEW.reward_reused AND c.purpose='founding_tester' AND v.issued_at=NEW.awarded_at))
      ) THEN RAISE EXCEPTION 'invalid tester reward' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER founding_testers_guard BEFORE INSERT OR UPDATE OR DELETE ON founding_testers
      FOR EACH ROW EXECUTE FUNCTION guard_founding_tester();
  `);
}
export async function down() { throw new Error('Tester entitlement history is forward-only'); }
