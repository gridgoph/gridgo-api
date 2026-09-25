/**
 * An issue report can become a GitHub tracker issue: status `tracked` means it
 * was filed on, or linked to, one, and `tracker_issue_url` names it. The link
 * is kept for `tracked` and `published` and cleared on `new` and `dismissed`.
 * Contract: docs/ISSUE_REPORTS_API.md.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE issue_reports
      DROP CONSTRAINT issue_reports_status_check;
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_status_check
        CHECK (status IN ('new', 'tracked', 'published', 'dismissed'));
    ALTER TABLE issue_reports
      ADD COLUMN tracker_issue_url text
        CONSTRAINT issue_reports_tracker_issue_url_check
        CHECK (tracker_issue_url IS NULL OR tracker_issue_url ~ '^https://github\\.com/gridgoph/[A-Za-z0-9._-]+/issues/[1-9][0-9]*$');
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE issue_reports DROP COLUMN IF EXISTS tracker_issue_url;
    UPDATE issue_reports SET status = 'new' WHERE status = 'tracked';
    ALTER TABLE issue_reports
      DROP CONSTRAINT issue_reports_status_check;
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_status_check
        CHECK (status IN ('new', 'published', 'dismissed'));
  `);
}
