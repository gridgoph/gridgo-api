// A submitted hint, resolved with reporter ownership on every staff read. Keep
// it after chat deletion so an explicit ID never falls back to a different ID
// in the original issue text. No chat/file lifetime depends on the report.
export async function up(pgm) {
  pgm.sql(`ALTER TABLE issue_reports ADD COLUMN support_thread_id uuid;`);
}

export async function down(pgm) {
  pgm.sql(`ALTER TABLE issue_reports DROP COLUMN support_thread_id;`);
}
