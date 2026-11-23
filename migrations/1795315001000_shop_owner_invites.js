export async function up(pgm) {
  pgm.sql(`
    DO $$ DECLARE c record;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='shop_invites'::regclass
        AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%'
      LOOP EXECUTE format('ALTER TABLE shop_invites DROP CONSTRAINT %I',c.conname); END LOOP;
    END $$;
    ALTER TABLE shop_invites ADD CONSTRAINT shop_invite_kind_check CHECK (kind IN ('email','phone','qr','link','owner'));
    ALTER TABLE shop_invites ADD CONSTRAINT shop_invite_identity_check CHECK ((kind IN ('email','phone','owner'))=(identity IS NOT NULL));
    -- A historical handler treats an unknown invite kind as an unverified
    -- Staff claim. Fail closed rather than consume an ownership credential.
    CREATE FUNCTION shop_owner_invite_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='owner' AND NEW.claimed_at IS NOT NULL AND OLD.claimed_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM shop_memberships WHERE shop_id=NEW.shop_id AND user_id=NEW.claimed_by AND role='owner' AND status='active'
      ) THEN RAISE EXCEPTION 'owner invite requires an explicit owner claim'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER shop_owner_invite_claim_guard BEFORE UPDATE ON shop_invites FOR EACH ROW EXECUTE FUNCTION shop_owner_invite_claim_guard();
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
