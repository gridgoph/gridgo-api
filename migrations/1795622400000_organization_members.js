/** Organization members and the GRIDGO-set member perk (api#446). Additive only. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE organization_partners (
      user_id text PRIMARY KEY REFERENCES users(id),
      label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 40),
      status text NOT NULL CHECK (status IN ('active','ended')),
      partner_since date NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    -- id 'standard' is the one standard perk; any other id is that organization's override.
    CREATE TABLE member_perk_settings (
      id text PRIMARY KEY,
      organization_user_id text UNIQUE REFERENCES organization_partners(user_id),
      enabled boolean NOT NULL,
      amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
      max_orders_per_term integer NOT NULL CHECK (max_orders_per_term > 0),
      ends_at timestamptz NOT NULL,
      budget_cap_minor bigint NOT NULL CHECK (budget_cap_minor > 0 AND budget_cap_minor <= 9007199254740991),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_at timestamptz NOT NULL,
      updated_by text REFERENCES users(id),
      CHECK ((id = 'standard') = (organization_user_id IS NULL)),
      CHECK (organization_user_id IS NULL OR id = organization_user_id)
    );

    CREATE TABLE organization_memberships (
      id text PRIMARY KEY,
      organization_user_id text NOT NULL REFERENCES organization_partners(user_id),
      client_id text NOT NULL REFERENCES users(id),
      status text NOT NULL CHECK (status IN ('pending','active','expired','removed')),
      source text NOT NULL CHECK (source IN ('qr','link','list')),
      term text NOT NULL,
      term_ends_at timestamptz NOT NULL,
      member_since date,
      requested_at timestamptz NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (organization_user_id, client_id),
      CHECK (organization_user_id <> client_id),
      CHECK (status <> 'active' OR member_since IS NOT NULL)
    );
    CREATE INDEX organization_memberships_client_idx ON organization_memberships (client_id);
    CREATE INDEX organization_memberships_term_idx ON organization_memberships (term_ends_at) WHERE status IN ('pending','active');

    CREATE TABLE member_perk_uses (
      id text PRIMARY KEY,
      membership_id text NOT NULL REFERENCES organization_memberships(id),
      organization_user_id text NOT NULL REFERENCES organization_partners(user_id),
      client_id text NOT NULL REFERENCES users(id),
      term text NOT NULL,
      amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
      status text NOT NULL CHECK (status IN ('reserved','confirmed','returned')),
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX member_perk_uses_member_idx ON member_perk_uses (membership_id, term);
    CREATE INDEX member_perk_uses_budget_idx ON member_perk_uses (organization_user_id) WHERE status <> 'returned';

    -- Caps and budget hold even if two writers ever bypass the domain lock: the
    -- organization row is locked before its uses are counted.
    CREATE FUNCTION guard_member_perk_use() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE perk member_perk_settings%ROWTYPE; used bigint; spent numeric;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'member perk uses are a ledger' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.membership_id, NEW.organization_user_id, NEW.client_id, NEW.term, NEW.amount_minor, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.membership_id, OLD.organization_user_id, OLD.client_id, OLD.term, OLD.amount_minor, OLD.created_at)
          OR OLD.status = 'returned' AND NEW.status <> 'returned'
          OR OLD.status = 'confirmed' AND NEW.status = 'reserved' THEN
          RAISE EXCEPTION 'member perk use is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.status = 'returned' THEN RETURN NEW; END IF;
      PERFORM 1 FROM organization_partners WHERE user_id = NEW.organization_user_id FOR UPDATE;
      PERFORM 1 FROM organization_memberships m WHERE m.id = NEW.membership_id
        AND m.organization_user_id = NEW.organization_user_id AND m.client_id = NEW.client_id
        AND m.term = NEW.term AND m.status = 'active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'member perk needs an active membership' USING ERRCODE = '23514'; END IF;
      SELECT * INTO perk FROM member_perk_settings WHERE id IN (NEW.organization_user_id, 'standard')
        ORDER BY (id = 'standard') LIMIT 1;
      IF NOT FOUND OR NOT perk.enabled OR NEW.amount_minor > perk.amount_minor THEN
        RAISE EXCEPTION 'member perk is not set' USING ERRCODE = '23514';
      END IF;
      SELECT count(*) INTO used FROM member_perk_uses u WHERE u.membership_id = NEW.membership_id
        AND u.term = NEW.term AND u.status <> 'returned';
      SELECT COALESCE(sum(u.amount_minor), 0) INTO spent FROM member_perk_uses u
        WHERE u.organization_user_id = NEW.organization_user_id AND u.status <> 'returned';
      IF used >= perk.max_orders_per_term THEN RAISE EXCEPTION 'member perk limit reached' USING ERRCODE = '23514'; END IF;
      IF spent + NEW.amount_minor > perk.budget_cap_minor THEN RAISE EXCEPTION 'member perk budget reached' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER member_perk_use_guard BEFORE INSERT OR UPDATE OR DELETE ON member_perk_uses
      FOR EACH ROW EXECUTE FUNCTION guard_member_perk_use();

    -- One shareable join link (also the QR payload) per organization and term.
    CREATE TABLE member_join_links (
      organization_user_id text NOT NULL REFERENCES organization_partners(user_id),
      term text NOT NULL,
      token text NOT NULL UNIQUE CHECK (length(token) >= 32),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (organization_user_id, term)
    );
    CREATE TABLE member_join_attempts (
      client_id text PRIMARY KEY REFERENCES users(id),
      window_at timestamptz NOT NULL,
      attempts integer NOT NULL,
      failures integer NOT NULL,
      locked_until timestamptz
    );
    -- How many list rows an organization checked per Manila day (abuse limit).
    CREATE TABLE member_list_usage (
      organization_user_id text NOT NULL REFERENCES organization_partners(user_id),
      day date NOT NULL,
      rows integer NOT NULL,
      PRIMARY KEY (organization_user_id, day)
    );

    -- Contacts live only here and only while an entry is open.
    CREATE TABLE member_list_entries (
      id text PRIMARY KEY,
      organization_user_id text NOT NULL REFERENCES organization_partners(user_id),
      term text NOT NULL,
      status text NOT NULL CHECK (status IN ('open','accepted','dismissed','expired','removed')),
      name text,
      contact_kind text NOT NULL CHECK (contact_kind IN ('email','mobile')),
      contact text,
      contact_key text,
      member_since date NOT NULL,
      matched_client_id text REFERENCES users(id),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      closed_at timestamptz,
      CHECK ((status = 'open') = (contact IS NOT NULL)),
      CHECK (status = 'open' OR name IS NULL),
      CHECK ((status = 'open') = (closed_at IS NULL))
    );
    CREATE UNIQUE INDEX member_list_entries_open_contact_idx ON member_list_entries (organization_user_id, term, contact) WHERE status = 'open';
    CREATE INDEX member_list_entries_contact_idx ON member_list_entries (contact) WHERE status = 'open';
    CREATE INDEX member_list_entries_key_idx ON member_list_entries (organization_user_id, term, contact_key) WHERE contact_key IS NOT NULL;
    CREATE INDEX member_list_entries_expiry_idx ON member_list_entries (expires_at) WHERE status = 'open';
    CREATE INDEX member_list_entries_matched_idx ON member_list_entries (matched_client_id) WHERE status = 'open';

    -- One invite and at most one reminder per entry. No address is copied here.
    CREATE TABLE member_invite_outbox (
      id text PRIMARY KEY,
      entry_id text NOT NULL REFERENCES member_list_entries(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('invite','reminder')),
      status text NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
      attempts integer NOT NULL DEFAULT 0,
      next_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (entry_id, kind)
    );
    CREATE INDEX member_invite_outbox_due_idx ON member_invite_outbox (next_at) WHERE status = 'pending';

    -- Liquidation records: an organization's own orders grouped by event.
    CREATE TABLE organization_events (
      id text PRIMARY KEY,
      organization_user_id text NOT NULL REFERENCES users(id),
      name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE INDEX organization_events_owner_idx ON organization_events (organization_user_id, created_at);
    CREATE TABLE organization_event_orders (
      order_id text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      event_id text NOT NULL REFERENCES organization_events(id) ON DELETE CASCADE
    );
    CREATE INDEX organization_event_orders_event_idx ON organization_event_orders (event_id);

    -- The perk is a second GRIDGO-funded reduction of the service fee. It never
    -- stacks with the organization discount. With no perk (every existing row)
    -- the checks are exactly the previous ones.
    CREATE OR REPLACE FUNCTION guard_organization_discount() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE rate numeric; discount numeric; gross numeric; perk numeric;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.commercial_committed_at IS NOT NULL AND NEW.commercial_committed_at IS NOT NULL
        AND (NEW.data->'organizationDiscountRateBps' IS DISTINCT FROM OLD.data->'organizationDiscountRateBps'
          OR NEW.data->'organizationDiscountMinor' IS DISTINCT FROM OLD.data->'organizationDiscountMinor'
          OR NEW.data->'memberPerkMinor' IS DISTINCT FROM OLD.data->'memberPerkMinor'
          OR NEW.data->'memberPerk' IS DISTINCT FROM OLD.data->'memberPerk'
          OR NEW.data->'grossServiceFeeMinor' IS DISTINCT FROM OLD.data->'grossServiceFeeMinor') THEN
        RAISE EXCEPTION 'committed organization discount is immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.commercial_committed_at IS NULL OR NOT (NEW.data ?| ARRAY['organizationDiscountMinor','organizationDiscountRateBps','grossServiceFeeMinor','memberPerkMinor','memberPerk']) THEN RETURN NEW; END IF;
      rate := (NEW.data->>'organizationDiscountRateBps')::numeric;
      discount := (NEW.data->>'organizationDiscountMinor')::numeric;
      gross := (NEW.data->>'grossServiceFeeMinor')::numeric;
      perk := COALESCE((NEW.data->>'memberPerkMinor')::numeric, 0);
      IF rate IS NULL OR discount IS NULL OR gross IS NULL
        OR jsonb_typeof(NEW.data->'organizationDiscountRateBps') <> 'number'
        OR jsonb_typeof(NEW.data->'organizationDiscountMinor') <> 'number'
        OR jsonb_typeof(NEW.data->'grossServiceFeeMinor') <> 'number'
        OR rate <> trunc(rate) OR rate < 0 OR rate > (CASE WHEN NEW.data->'serviceFeeSchedule'->>'version' IN ('1','2') THEN 10000 ELSE NEW.service_fee_rate_bps END)
        OR gross <> gridgo_service_fee(NEW.supplier_subtotal_minor, COALESCE(NEW.data->'serviceFeeSchedule', jsonb_build_object('version',1,'rateBps',NEW.service_fee_rate_bps)))
        OR discount <> least(gross, floor((NEW.supplier_subtotal_minor::numeric * rate + 5000) / 10000))
        OR perk <> trunc(perk) OR perk < 0 OR perk > gross OR (perk > 0 AND discount <> 0)
        OR (perk > 0) IS DISTINCT FROM (NEW.data ? 'memberPerk')
        OR (perk > 0 AND (NEW.data->'memberPerk'->>'fundedBy' IS DISTINCT FROM 'GRIDGO'
          OR (NEW.data->'memberPerk'->>'amountMinor')::numeric IS DISTINCT FROM perk))
        OR NEW.service_fee_minor IS DISTINCT FROM gross - discount - perk
        OR NEW.total_minor IS DISTINCT FROM NEW.supplier_subtotal_minor + NEW.service_fee_minor + NEW.delivery_fee_minor - COALESCE((NEW.data->>'voucherDiscountMinor')::bigint, 0)
        OR NEW.supplier_platform_payout_minor IS DISTINCT FROM NEW.supplier_subtotal_minor - NEW.direct_store_due_minor THEN
        RAISE EXCEPTION 'organization discount must be funded only from service fee' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;

    DO $$ DECLARE definition text; updated text; BEGIN
      SELECT pg_get_functiondef('enforce_committed_order_money()'::regprocedure) INTO definition;
      updated := replace(definition, 'expected_fee - COALESCE((NEW.data->>''organizationDiscountMinor'')::bigint, 0)',
        'expected_fee - COALESCE((NEW.data->>''organizationDiscountMinor'')::bigint, 0) - COALESCE((NEW.data->>''memberPerkMinor'')::bigint, 0)');
      IF updated = definition THEN RAISE EXCEPTION 'enforce_committed_order_money changed; review the member perk term'; END IF;
      EXECUTE updated;
    END $$;
  `);
}
export async function down() { throw new Error('Member and perk records require a forward migration'); }
