/** Add role QR grants without rewriting existing invites, memberships or sessions. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE shop_invites ADD COLUMN join_role text;
    ALTER TABLE shop_invites ADD COLUMN refresh_seconds smallint;
    ALTER TABLE shop_invites DROP CONSTRAINT shop_invites_lifetime_check;
    ALTER TABLE shop_invites ADD CONSTRAINT shop_invites_lifetime_check CHECK (
      lifetime_hours IN (24,48) AND (
        (join_role IS NULL AND refresh_seconds IS NULL
          AND expires_at = created_at + make_interval(hours => lifetime_hours))
        OR (join_role IS NOT NULL AND join_role IN ('manager','staff') AND kind = 'qr'
          AND refresh_seconds IS NOT NULL AND refresh_seconds BETWEEN 15 AND 300
          AND expires_at = created_at + make_interval(secs => refresh_seconds))
      )
    );
    CREATE OR REPLACE FUNCTION shop_invite_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.id,NEW.shop_id,NEW.kind,NEW.identity,NEW.token_hash,NEW.created_by,NEW.created_at,NEW.expires_at,NEW.lifetime_hours,NEW.join_role,NEW.refresh_seconds)
        IS DISTINCT FROM (OLD.id,OLD.shop_id,OLD.kind,OLD.identity,OLD.token_hash,OLD.created_by,OLD.created_at,OLD.expires_at,OLD.lifetime_hours,OLD.join_role,OLD.refresh_seconds)
        OR (OLD.claimed_at IS NOT NULL AND (NEW.claimed_at,NEW.claimed_by) IS DISTINCT FROM (OLD.claimed_at,OLD.claimed_by))
        OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
      THEN RAISE EXCEPTION 'shop invite is immutable after consumption'; END IF;
      RETURN NEW;
    END $$;
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
