/** Shared implementation priority, independent of report workflow status. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE issue_reports
      ADD COLUMN priority boolean NOT NULL DEFAULT false,
      ADD COLUMN priority_updated_by text,
      ADD COLUMN priority_updated_at timestamptz;
    CREATE INDEX issue_reports_priority_page_idx ON issue_reports (created_at DESC, id DESC) WHERE priority;
  `);
}
export async function down(pgm) {
  pgm.sql(`DROP INDEX issue_reports_priority_page_idx;
    ALTER TABLE issue_reports DROP COLUMN priority, DROP COLUMN priority_updated_by, DROP COLUMN priority_updated_at;`);
}
