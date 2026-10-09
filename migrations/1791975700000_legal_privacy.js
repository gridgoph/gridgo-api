export const up = (pgm) => pgm.sql(`
  CREATE TABLE legal_documents (
    id text PRIMARY KEY, draft jsonb NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    launch_slot boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE legal_versions (
    id text PRIMARY KEY, document_id text NOT NULL REFERENCES legal_documents(id),
    version integer NOT NULL CHECK (version > 0), audience text NOT NULL CHECK (audience IN ('all','client','supplier','rider','staff')),
    effective_at timestamptz NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
    placeholder boolean NOT NULL, material boolean NOT NULL, penalties boolean NOT NULL DEFAULT false,
    snapshot jsonb NOT NULL, pdf_file_id text REFERENCES files(file_id),
    UNIQUE(document_id, version), CHECK (NOT placeholder OR NOT penalties)
  );
  CREATE INDEX legal_versions_effective ON legal_versions(document_id, effective_at, version);
  CREATE TABLE legal_acceptances (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), version_id text NOT NULL REFERENCES legal_versions(id),
    accepted_at timestamptz NOT NULL DEFAULT now(), method text NOT NULL CHECK (method IN ('checkbox','blocking_screen')),
    app text NOT NULL CHECK (length(app) BETWEEN 1 AND 80), device text NOT NULL CHECK (length(device) BETWEEN 1 AND 200),
    purpose text NOT NULL CHECK (purpose IN ('document','enrollment','artwork')),
    order_id text REFERENCES orders(id), marketing boolean, junior boolean, guardian boolean,
    CHECK ((purpose = 'artwork') = (order_id IS NOT NULL)), CHECK (junior IS DISTINCT FROM true OR guardian IS true)
  );
  CREATE INDEX legal_acceptances_user ON legal_acceptances(user_id, accepted_at, id);
  CREATE INDEX legal_acceptances_version ON legal_acceptances(version_id,user_id);
  CREATE UNIQUE INDEX legal_acceptances_once ON legal_acceptances(user_id,version_id,purpose,COALESCE(order_id,''));
  CREATE FUNCTION legal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'legal history is append only' USING ERRCODE='23514';
  END $$;
  CREATE TRIGGER legal_versions_immutable BEFORE UPDATE OR DELETE ON legal_versions FOR EACH ROW EXECUTE FUNCTION legal_immutable();
  CREATE TRIGGER legal_acceptances_immutable BEFORE UPDATE OR DELETE ON legal_acceptances FOR EACH ROW EXECUTE FUNCTION legal_immutable();
  CREATE TABLE privacy_requests (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
    kind text NOT NULL CHECK (kind IN ('access','correction','deletion')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','rejected')),
    details text NOT NULL DEFAULT '', resolution text NOT NULL DEFAULT '',
    requested_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz NOT NULL DEFAULT now() + interval '15 days',
    handler_id text REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL DEFAULT 1
  );
  CREATE INDEX privacy_requests_queue ON privacy_requests(status,due_at,id);
`);
export const down = () => { throw new Error('Forward only: legal evidence must be retained.'); };
