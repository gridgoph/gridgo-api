/** The pre-dispatch boundary resolves only one signed-in device's lock. */
export async function up(pgm) {
  pgm.sql(`CREATE INDEX shop_worker_sessions_user_session_idx
    ON shop_worker_sessions(user_id,session_hash) WHERE expires_at IS NOT NULL;`);
}
export async function down() { throw new Error('Forward-only migration'); }
