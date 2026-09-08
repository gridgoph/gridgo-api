/**
 * Public landing-page support tickets and the username/password desk that
 * replies to them. Independent of Clerk identity and of Operations/Super Admin.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE support_admins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (btrim(username) <> '' AND btrim(password_hash) <> '')
    );

    CREATE TABLE support_tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      email text NOT NULL,
      subject text NOT NULL,
      message text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      admin_reply text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (btrim(name) <> '' AND btrim(email) <> ''),
      CHECK (btrim(subject) <> '' AND btrim(message) <> '')
    );

    CREATE INDEX support_tickets_created_at_idx ON support_tickets (created_at DESC);
    CREATE INDEX support_tickets_status_idx ON support_tickets (status);
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS support_tickets;
    DROP TABLE IF EXISTS support_admins;
  `);
}
