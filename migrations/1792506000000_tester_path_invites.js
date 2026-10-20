/** Additive: records existing awards but never creates a voucher or completes a mission. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE founding_testers ADD COLUMN added_at timestamptz;
    CREATE FUNCTION guard_tester_cart_step() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.added_at IS NOT NULL AND OLD.added_at IS DISTINCT FROM NEW.added_at THEN
        RAISE EXCEPTION 'tester cart history is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER tester_cart_step_guard BEFORE UPDATE ON founding_testers FOR EACH ROW EXECUTE FUNCTION guard_tester_cart_step();
    ALTER TABLE voucher_campaigns DROP CONSTRAINT voucher_campaigns_purpose_check;
    ALTER TABLE voucher_campaigns ADD CONSTRAINT voucher_campaigns_purpose_check CHECK (purpose IN ('manual','survey','founding_tester','tester_referral'));
    CREATE TABLE tester_invite_codes (
      client_id text PRIMARY KEY REFERENCES users(id), code text UNIQUE NOT NULL,
      created_at timestamptz NOT NULL, UNIQUE(client_id,code)
    );
    CREATE TABLE tester_installations (
      client_id text NOT NULL REFERENCES users(id), installation_id uuid NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY(client_id,installation_id)
    );
    CREATE INDEX tester_installations_signal ON tester_installations(installation_id);
    CREATE TABLE tester_tracking (
      client_id text NOT NULL REFERENCES users(id), order_id text NOT NULL REFERENCES orders(id), created_at timestamptz NOT NULL,
      PRIMARY KEY(client_id,order_id)
    );
    CREATE TABLE tester_invites (
      id text PRIMARY KEY, inviter_id text NOT NULL REFERENCES users(id), code text NOT NULL,
      email text UNIQUE NOT NULL, client_id text UNIQUE REFERENCES users(id),
      created_at timestamptz NOT NULL, matched_at timestamptz, completed_at timestamptz, unmatched_reason text,
      FOREIGN KEY(inviter_id,code) REFERENCES tester_invite_codes(client_id,code),
      CHECK(client_id IS NULL OR client_id <> inviter_id),
      CHECK((client_id IS NULL) = (matched_at IS NULL)), CHECK(completed_at IS NULL OR matched_at IS NOT NULL)
    );
    CREATE INDEX tester_invites_inviter ON tester_invites(inviter_id);
    CREATE TABLE tester_rewards (
      id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('mission','referral')),
      client_id text NOT NULL REFERENCES users(id), inviter_id text REFERENCES users(id), invite_id text UNIQUE REFERENCES tester_invites(id),
      amount_minor bigint NOT NULL CHECK(amount_minor IN (0,1500,3000)),
      status text NOT NULL CHECK(status IN ('issued','paused','voided','blocked')),
      created_at timestamptz NOT NULL, issued_at timestamptz, voided_at timestamptz,
      voucher_id text UNIQUE REFERENCES vouchers(id), inviter_voucher_id text UNIQUE REFERENCES vouchers(id),
      reason text, checks jsonb NOT NULL DEFAULT '{}', evidence jsonb NOT NULL DEFAULT '{}', UNIQUE(kind,client_id),
      CHECK((kind='mission' AND inviter_id IS NULL AND invite_id IS NULL AND amount_minor IN (0,1500) AND inviter_voucher_id IS NULL)
        OR (kind='referral' AND inviter_id IS NOT NULL AND invite_id IS NOT NULL AND inviter_id <> client_id AND amount_minor=3000)),
      CHECK((issued_at IS NULL) = (voucher_id IS NULL)),
      CHECK(kind <> 'referral' OR (issued_at IS NULL) = (inviter_voucher_id IS NULL)),
      CHECK(status NOT IN ('paused','blocked') OR issued_at IS NULL),
      CHECK(status <> 'issued' OR issued_at IS NOT NULL), CHECK(status <> 'voided' OR voided_at IS NOT NULL)
    );
    CREATE INDEX tester_rewards_staff ON tester_rewards(status,created_at);
    INSERT INTO tester_rewards(id,kind,client_id,amount_minor,status,created_at,issued_at,voucher_id,reason)
      SELECT 'legacy-mission:' || f.client_id,'mission',f.client_id,CASE WHEN f.reward_reused THEN 0 ELSE 1500 END,
        CASE WHEN v.status='void' THEN 'voided' ELSE 'issued' END,f.awarded_at,f.awarded_at,f.reward_voucher_id,
        CASE WHEN f.reward_reused THEN 'existing_survey_reward' ELSE NULL END
      FROM founding_testers f JOIN vouchers v ON v.id=f.reward_voucher_id WHERE f.awarded_at IS NOT NULL AND v.status <> 'void';
    -- Existing void wallets also keep their irrevocable entitlement; no new issue.
    INSERT INTO tester_rewards(id,kind,client_id,amount_minor,status,created_at,issued_at,voided_at,voucher_id,reason)
      SELECT 'legacy-mission:' || f.client_id,'mission',f.client_id,CASE WHEN f.reward_reused THEN 0 ELSE 1500 END,
        'voided',f.awarded_at,f.awarded_at,COALESCE((v.data->>'voidedAt')::timestamptz,f.awarded_at),f.reward_voucher_id,'legacy_void'
      FROM founding_testers f JOIN vouchers v ON v.id=f.reward_voucher_id WHERE f.awarded_at IS NOT NULL AND v.status='void';
    CREATE FUNCTION guard_tester_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'tester evidence is append-only' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER tester_codes_immutable BEFORE UPDATE OR DELETE ON tester_invite_codes FOR EACH ROW EXECUTE FUNCTION guard_tester_append_only();
    CREATE TRIGGER tester_installations_immutable BEFORE UPDATE OR DELETE ON tester_installations FOR EACH ROW EXECUTE FUNCTION guard_tester_append_only();
    CREATE TRIGGER tester_tracking_immutable BEFORE UPDATE OR DELETE ON tester_tracking FOR EACH ROW EXECUTE FUNCTION guard_tester_append_only();
    CREATE FUNCTION guard_tester_tracking_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND client_id=NEW.client_id) THEN
        RAISE EXCEPTION 'tester tracking owner mismatch' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER tester_tracking_owner BEFORE INSERT ON tester_tracking FOR EACH ROW EXECUTE FUNCTION guard_tester_tracking_owner();
    CREATE FUNCTION guard_tester_reward() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tester reward history is immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='UPDATE' AND (ROW(OLD.id,OLD.kind,OLD.client_id,OLD.inviter_id,OLD.invite_id,OLD.amount_minor,OLD.created_at)
        IS DISTINCT FROM ROW(NEW.id,NEW.kind,NEW.client_id,NEW.inviter_id,NEW.invite_id,NEW.amount_minor,NEW.created_at)
        OR (OLD.status IN ('voided','blocked') AND OLD IS DISTINCT FROM NEW)
        OR (OLD.issued_at IS NOT NULL AND (ROW(OLD.issued_at,OLD.voucher_id,OLD.inviter_voucher_id,OLD.checks,OLD.evidence)
          IS DISTINCT FROM ROW(NEW.issued_at,NEW.voucher_id,NEW.inviter_voucher_id,NEW.checks,NEW.evidence) OR NEW.status NOT IN ('issued','voided')))) THEN
        RAISE EXCEPTION 'tester reward history is immutable' USING ERRCODE='23514';
      END IF;
      IF NEW.kind='referral' AND NOT EXISTS(SELECT 1 FROM tester_invites WHERE id=NEW.invite_id AND client_id=NEW.client_id AND inviter_id=NEW.inviter_id) THEN
        RAISE EXCEPTION 'tester reward attribution mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.voucher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM vouchers WHERE id=NEW.voucher_id AND client_id=NEW.client_id AND value_minor=1500) THEN
        RAISE EXCEPTION 'tester reward owner mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.inviter_voucher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM vouchers WHERE id=NEW.inviter_voucher_id AND client_id=NEW.inviter_id AND value_minor=1500) THEN
        RAISE EXCEPTION 'tester inviter reward owner mismatch' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER tester_reward_guard BEFORE INSERT OR UPDATE OR DELETE ON tester_rewards FOR EACH ROW EXECUTE FUNCTION guard_tester_reward();
    CREATE FUNCTION guard_tester_invite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tester attribution is immutable' USING ERRCODE='23514'; END IF;
      IF ROW(OLD.id,OLD.inviter_id,OLD.code,OLD.email,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.inviter_id,NEW.code,NEW.email,NEW.created_at)
        OR (OLD.client_id IS NOT NULL AND ROW(OLD.client_id,OLD.matched_at) IS DISTINCT FROM ROW(NEW.client_id,NEW.matched_at))
        OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at) THEN
        RAISE EXCEPTION 'tester attribution is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER tester_invite_guard BEFORE UPDATE OR DELETE ON tester_invites FOR EACH ROW EXECUTE FUNCTION guard_tester_invite();
  `);
}
export async function down() { throw new Error('Tester program history is forward-only'); }
