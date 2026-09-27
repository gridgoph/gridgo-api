/**
 * Account standing is separate from supplier/rider accreditation.
 *
 * `verification_status` and approval-case suspend only stop matching.
 * These columns say whether the person can use GRIDGO at all. `removed`
 * is a soft state: the user row, memberships, orders, and Clerk user stay.
 * Existing rows are active, with no reason, time, or actor.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN account_status text NOT NULL DEFAULT 'active',
      ADD COLUMN account_status_reason text,
      ADD COLUMN account_status_at timestamptz,
      ADD COLUMN account_status_by text;

    ALTER TABLE users
      ADD CONSTRAINT users_account_status_check
        CHECK (account_status IN ('active', 'suspended', 'removed')),
      ADD CONSTRAINT users_account_status_fields_check
        CHECK (
          (
            account_status = 'active'
            AND account_status_reason IS NULL
            AND account_status_at IS NULL
            AND account_status_by IS NULL
          )
          OR (
            account_status IN ('suspended', 'removed')
            AND account_status_reason IS NOT NULL
            AND btrim(account_status_reason) <> ''
            AND account_status_at IS NOT NULL
            AND account_status_by IS NOT NULL
            AND btrim(account_status_by) <> ''
          )
        );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_fields_check;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
    ALTER TABLE users
      DROP COLUMN IF EXISTS account_status_by,
      DROP COLUMN IF EXISTS account_status_at,
      DROP COLUMN IF EXISTS account_status_reason,
      DROP COLUMN IF EXISTS account_status;
  `);
}
