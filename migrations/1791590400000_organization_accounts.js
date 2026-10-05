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
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM organization_accounts)
         OR EXISTS (SELECT 1 FROM organization_email_challenges)
         OR EXISTS (SELECT 1 FROM approval_cases WHERE business_permit_required)
         OR EXISTS (SELECT 1 FROM files WHERE purpose = 'client_verification_document')
         OR EXISTS (SELECT 1 FROM approval_case_events WHERE snapshot->>'schemaVersion' = '1'
                    AND snapshot->>'accountType' IN ('business', 'organization')) THEN
        RAISE EXCEPTION 'client verification records exist; rollback would discard evidence';
      END IF;
    END $$;
    DROP TABLE organization_email_challenges;
    DROP TABLE organization_accounts;
    ALTER TABLE approval_cases DROP COLUMN business_permit_required;
  `);
}
