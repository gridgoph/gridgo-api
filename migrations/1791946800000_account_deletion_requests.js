export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE account_deletion_requests (
      id uuid PRIMARY KEY,
      user_id text REFERENCES users(id) ON DELETE SET NULL,
      contact_email text CHECK (char_length(contact_email) <= 254),
      source text NOT NULL CHECK (source IN ('app','web')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
      completed_at timestamptz,
      completed_by text REFERENCES users(id) ON DELETE SET NULL,
      CHECK ((status='pending' AND completed_at IS NULL) OR (status='done' AND completed_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX account_deletion_pending_user ON account_deletion_requests(user_id) WHERE status='pending' AND user_id IS NOT NULL;
    CREATE UNIQUE INDEX account_deletion_pending_web_email ON account_deletion_requests(contact_email) WHERE status='pending' AND source='web';
    CREATE INDEX account_deletion_queue ON account_deletion_requests(status,requested_at,id);
  `);
}
