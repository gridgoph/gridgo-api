/** Indexed identity/progress graphs and unresolved invitation probes. */
export async function up(pgm) {
  pgm.sql(`
    CREATE INDEX users_bootstrap_email_idx ON users (lower(btrim(email)));
    CREATE INDEX users_bootstrap_unusual_email_idx ON users (id) WHERE email ~ '[^!-~]';
    CREATE INDEX tester_invites_unmatched_idx ON tester_invites (id) WHERE client_id IS NULL;
    CREATE INDEX promotion_invites_pending_idx ON promotion_invites (id) WHERE status = 'invited';
    CREATE INDEX promotion_invites_client_idx ON promotion_invites (client_id);
    CREATE INDEX voucher_reservations_active_voucher_idx ON voucher_reservations (voucher_id) WHERE status = 'reserved';
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
