/** Public Android waitlist and durable, private mail hand-off. */
export const up = pgm => pgm.sql(`
  CREATE TABLE early_access_signups (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
    token text NOT NULL UNIQUE CHECK (token ~ '^[a-f0-9]{64}$'),
    consent_at timestamptz NOT NULL,
    source text CHECK (source ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    platform text NOT NULL CHECK (platform = 'android'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted')),
    created_at timestamptz NOT NULL,
    granted_at timestamptz,
    granted_by text,
    opt_in_url text,
    CHECK ((status = 'pending' AND granted_at IS NULL AND granted_by IS NULL AND opt_in_url IS NULL)
      OR (status = 'granted' AND granted_at IS NOT NULL AND granted_by IS NOT NULL AND opt_in_url IS NOT NULL))
  );
  CREATE INDEX early_access_status_date_idx ON early_access_signups(status,created_at DESC,id DESC);
  CREATE TABLE early_access_email_outbox (
    id uuid PRIMARY KEY,
    signup_id uuid NOT NULL REFERENCES early_access_signups(id),
    kind text NOT NULL CHECK (kind IN ('team','access')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (signup_id,kind)
  );
  CREATE INDEX early_access_mail_due_idx ON early_access_email_outbox(next_at) WHERE status='pending';
`);
export const down = () => { throw new Error('Early access consent and grant history require a forward migration'); };
