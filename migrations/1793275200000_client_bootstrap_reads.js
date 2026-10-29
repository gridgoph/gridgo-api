/** Indexed identity/progress graphs and unresolved invitation probes. */
export async function up(pgm) {
  // Each build must be its own autocommit command, including with the runner's
  // default singleTransaction option. See DEPLOYMENT.md for interrupted builds.
  pgm.noTransaction();
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS users_bootstrap_email_idx ON users (lower(btrim(email)));');
  pgm.sql("CREATE INDEX CONCURRENTLY IF NOT EXISTS users_bootstrap_unusual_email_idx ON users (id) WHERE email ~ '[^!-~]';");
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS tester_invites_unmatched_idx ON tester_invites (id) WHERE client_id IS NULL;');
  pgm.sql("CREATE INDEX CONCURRENTLY IF NOT EXISTS promotion_invites_pending_idx ON promotion_invites (id) WHERE status = 'invited';");
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS promotion_invites_client_idx ON promotion_invites (client_id);');
}
export async function down() { throw new Error('Forward migrations only'); }
