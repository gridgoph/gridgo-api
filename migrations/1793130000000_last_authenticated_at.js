/**
 * The last time GRIDGO accepted this account's bearer token.
 *
 * Existing rows stay null. Account creation and old audit rows are not
 * sign-ins, so this column is never backfilled.
 */
export async function up(pgm) {
  pgm.sql(`ALTER TABLE users ADD COLUMN last_authenticated_at timestamptz`);
}

export async function down(pgm) {
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS last_authenticated_at`);
}
