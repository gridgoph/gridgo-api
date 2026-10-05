export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT users_role_check,
      ADD CONSTRAINT users_role_check CHECK (role IN ('client','supplier','rider','ops_admin','super_admin','staff'));
    ALTER TABLE user_role_memberships DROP CONSTRAINT user_role_memberships_role_check,
      ADD CONSTRAINT user_role_memberships_role_check CHECK (role IN ('client','supplier','rider','ops_admin','super_admin','staff'));
    CREATE TABLE staff_roles (
      code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
      can_handout boolean NOT NULL DEFAULT false
    );
    INSERT INTO staff_roles VALUES ('hub_staff', 'Hub staff', true);
    CREATE TABLE staff_profiles (
      user_id text PRIMARY KEY REFERENCES users(id),
      role_code text NOT NULL REFERENCES staff_roles(code),
      active boolean NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE staff_invites (
      id text PRIMARY KEY,
      code_hash text NOT NULL UNIQUE,
      role_code text NOT NULL REFERENCES staff_roles(code),
      created_by text NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
      redeemed_by text REFERENCES users(id),
      redeemed_at timestamptz,
      revoked_at timestamptz,
      CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL))
    );
    CREATE TABLE hub_handouts (
      id text PRIMARY KEY,
      order_id text NOT NULL UNIQUE REFERENCES orders(id),
      staff_id text NOT NULL REFERENCES users(id),
      staff_name text NOT NULL CHECK (btrim(staff_name) <> ''),
      hub_id text NOT NULL CHECK (hub_id = 'primary'),
      at timestamptz NOT NULL
    );
    CREATE INDEX hub_handouts_staff_time_idx ON hub_handouts(staff_id, at DESC);
    CREATE TRIGGER hub_handouts_append_only BEFORE UPDATE OR DELETE ON hub_handouts
      FOR EACH ROW EXECUTE FUNCTION reject_approval_case_event_mutation();
    CREATE FUNCTION protect_handover_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE previous jsonb; next_value jsonb; field text;
    BEGIN
      previous := OLD.data->'handover'; next_value := NEW.data->'handover';
      IF previous IS NOT NULL AND previous <> 'null'::jsonb THEN
        IF next_value IS NULL OR next_value = 'null'::jsonb THEN
          RAISE EXCEPTION 'handover must be preserved' USING ERRCODE='23514';
        END IF;
        FOREACH field IN ARRAY ARRAY['version','otp','qrToken','createdAt','hubId','point','schedule','readyAt'] LOOP
          IF previous->field IS DISTINCT FROM next_value->field THEN
            RAISE EXCEPTION 'handover credentials are immutable' USING ERRCODE='23514';
          END IF;
        END LOOP;
        IF previous->>'consumedAt' IS NOT NULL AND previous->'consumedAt' IS DISTINCT FROM next_value->'consumedAt' THEN
          RAISE EXCEPTION 'handover consumption is final' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER orders_handover_immutable BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION protect_handover_credentials();
  `);
}

export async function down() { throw new Error('Staff handovers require a forward migration to preserve the handout ledger.'); }
