/** Preserve issued invite deadlines and every existing identity/session. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE shop_memberships ADD COLUMN last_used_at timestamptz;
    ALTER TABLE shop_invites ADD COLUMN lifetime_hours smallint NOT NULL DEFAULT 48;
    ALTER TABLE shop_invites ALTER COLUMN lifetime_hours SET DEFAULT 24;
    DO $$ DECLARE constraint_name text;
    BEGIN
      SELECT conname INTO STRICT constraint_name FROM pg_constraint
        WHERE conrelid = 'shop_invites'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%expires_at%created_at%';
      EXECUTE format('ALTER TABLE shop_invites DROP CONSTRAINT %I', constraint_name);
    END $$;
    ALTER TABLE shop_invites ADD CONSTRAINT shop_invites_lifetime_check CHECK (
      lifetime_hours IN (24,48) AND expires_at = created_at + make_interval(hours => lifetime_hours)
    );
    CREATE OR REPLACE FUNCTION shop_invite_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.id,NEW.shop_id,NEW.kind,NEW.identity,NEW.token_hash,NEW.created_by,NEW.created_at,NEW.expires_at,NEW.lifetime_hours)
        IS DISTINCT FROM (OLD.id,OLD.shop_id,OLD.kind,OLD.identity,OLD.token_hash,OLD.created_by,OLD.created_at,OLD.expires_at,OLD.lifetime_hours)
        OR (OLD.claimed_at IS NOT NULL AND (NEW.claimed_at,NEW.claimed_by) IS DISTINCT FROM (OLD.claimed_at,OLD.claimed_by))
        OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
      THEN RAISE EXCEPTION 'shop invite is immutable after consumption'; END IF;
      RETURN NEW;
    END $$;
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
