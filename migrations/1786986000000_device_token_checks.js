// When the stale-token sweep last dry-ran each registration against FCM
// (`validate_only`). Kept beside `device_tokens` rather than inside its `data`
// so the sweep never races the domain store's row writes; a pruned or removed
// registration takes its check row with it.
export const up = (pgm) => {
  pgm.sql(`CREATE TABLE device_token_checks (
    device_id TEXT PRIMARY KEY REFERENCES device_tokens(id) ON DELETE CASCADE,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_code TEXT
  ); CREATE INDEX device_token_checks_checked_at ON device_token_checks(checked_at);`);
};
export const down = (pgm) => pgm.dropTable("device_token_checks");
