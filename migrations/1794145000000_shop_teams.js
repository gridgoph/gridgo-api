/** Shop identities remain the existing supplier user IDs. No Clerk/session changes. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE shop_memberships (
      shop_id text NOT NULL REFERENCES users(id),
      user_id text NOT NULL REFERENCES users(id),
      role text NOT NULL CHECK (role IN ('owner','staff')),
      status text NOT NULL CHECK (status IN ('pending','active','removed')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      decided_by text REFERENCES users(id),
      PRIMARY KEY (shop_id,user_id)
    );
    CREATE INDEX shop_memberships_user_idx ON shop_memberships(user_id,status);
    INSERT INTO shop_memberships(shop_id,user_id,role,status,created_at,updated_at)
      SELECT user_id,user_id,'owner','active',created_at,created_at
      FROM user_role_memberships WHERE role='supplier';
    CREATE TABLE shop_invites (
      id text PRIMARY KEY,
      shop_id text NOT NULL REFERENCES users(id),
      kind text NOT NULL CHECK (kind IN ('email','phone','qr','link')),
      identity text,
      token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      created_by text NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      claimed_by text REFERENCES users(id),
      claimed_at timestamptz,
      revoked_at timestamptz,
      CHECK (expires_at = created_at + interval '48 hours'),
      CHECK ((kind IN ('email','phone')) = (identity IS NOT NULL)),
      CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
      CHECK (claimed_at IS NULL OR revoked_at IS NULL)
    );
    CREATE INDEX shop_invites_shop_idx ON shop_invites(shop_id,created_at);
    CREATE INDEX shop_invites_identity_idx ON shop_invites(kind,identity) WHERE claimed_at IS NULL AND revoked_at IS NULL;
    CREATE FUNCTION shop_invite_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.id,NEW.shop_id,NEW.kind,NEW.identity,NEW.token_hash,NEW.created_by,NEW.created_at,NEW.expires_at)
        IS DISTINCT FROM (OLD.id,OLD.shop_id,OLD.kind,OLD.identity,OLD.token_hash,OLD.created_by,OLD.created_at,OLD.expires_at)
        OR (OLD.claimed_at IS NOT NULL AND (NEW.claimed_at,NEW.claimed_by) IS DISTINCT FROM (OLD.claimed_at,OLD.claimed_by))
        OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
      THEN RAISE EXCEPTION 'shop invite is immutable after consumption'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER shop_invite_once BEFORE UPDATE ON shop_invites FOR EACH ROW EXECUTE FUNCTION shop_invite_once();
    CREATE TABLE order_actions (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id),
      actor_user_id text,
      actor_name text NOT NULL,
      actor_role text NOT NULL,
      action text NOT NULL,
      at timestamptz NOT NULL
    );
    CREATE INDEX order_actions_order_idx ON order_actions(order_id,at,id);
    CREATE FUNCTION order_actions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'order actions are append-only'; END $$;
    CREATE TRIGGER order_actions_immutable BEFORE UPDATE OR DELETE ON order_actions FOR EACH ROW EXECUTE FUNCTION order_actions_immutable();
    INSERT INTO order_actions(id,order_id,actor_user_id,actor_name,actor_role,action,at)
      SELECT a.id,a.order_id,a.actor_id,COALESCE(a.data->>'actorName',u.name,'Unknown'),
        CASE WHEN a.actor_role='supplier' THEN 'owner' ELSE COALESCE(a.actor_role,'system') END,a.action,a.at
      FROM audit_log a JOIN orders o ON o.id=a.order_id LEFT JOIN users u ON u.id=a.actor_id;
  `);
}
export async function down() { throw new Error('Forward-only migration'); }
