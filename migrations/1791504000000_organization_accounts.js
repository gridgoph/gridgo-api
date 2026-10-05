export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE organization_accounts (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      name_key text NOT NULL CHECK (length(name_key) BETWEEN 1 AND 200),
      school_key text NOT NULL CHECK (length(school_key) BETWEEN 1 AND 200),
      data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
      UNIQUE (name_key, school_key)
    );
    CREATE TABLE organization_email_challenges (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
    );
    ALTER TABLE approval_cases ADD COLUMN business_permit_required boolean NOT NULL DEFAULT false;
  `);
}
export async function down() {
  throw new Error('Organization verification and officer history require a forward migration; rollback would discard evidence.');
}
