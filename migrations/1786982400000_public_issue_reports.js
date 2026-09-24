/**
 * Public issue reports from the landing site's /report page.
 * Anyone may file one; the reports site is written from them later.
 * Screenshot bytes live in MinIO; these rows keep only the private object keys.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE issue_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      issue text NOT NULL CHECK (btrim(issue) <> '' AND char_length(issue) <= 5000),
      category text CHECK (category IS NULL OR category IN ('bug', 'feature', 'other')),
      status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'published', 'dismissed')),
      published_in text CHECK (published_in IS NULL OR char_length(published_in) <= 200),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX issue_reports_status_created_idx ON issue_reports (status, created_at DESC);

    CREATE TABLE issue_report_screenshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id uuid NOT NULL REFERENCES issue_reports(id) ON UPDATE CASCADE ON DELETE CASCADE,
      position smallint NOT NULL CHECK (position >= 0),
      object_key text NOT NULL UNIQUE,
      content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
      size_bytes integer NOT NULL CHECK (size_bytes > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (report_id, position)
    );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS issue_report_screenshots;
    DROP TABLE IF EXISTS issue_reports;
  `);
}
