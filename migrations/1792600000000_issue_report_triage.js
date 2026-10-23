/**
 * Manual triage of issue reports, kept apart from AI review. Staff set a
 * validity verdict, their own category (the reporter's `category` is never
 * rewritten), free slug labels and an optional duplicate target; AI review
 * records only its own suggestion beside them, so an AI write never touches
 * a human verdict. Contract: docs/ISSUE_REPORTS_API.md#triage-and-ai-review.
 */
const CATEGORIES = "'bug', 'feature', 'question', 'feedback', 'other'";
const LABELS_CHECK = (column) => `issue_report_labels_valid(${column})`;

export async function up(pgm) {
  pgm.sql(`
    -- Up to 10 lowercase slugs, each 1-32 characters; the API also removes repeats.
    CREATE FUNCTION issue_report_labels_valid(labels text[]) RETURNS boolean
      LANGUAGE sql IMMUTABLE STRICT
      AS $$ SELECT cardinality(labels) <= 10
        AND NOT EXISTS (SELECT 1 FROM unnest(labels) AS label WHERE label IS NULL OR label !~ '^[a-z0-9][a-z0-9-]{0,31}$') $$;
    ALTER TABLE issue_reports
      ADD COLUMN validity text NOT NULL DEFAULT 'unreviewed'
        CONSTRAINT issue_reports_validity_check CHECK (validity IN ('unreviewed', 'valid', 'spam', 'duplicate')),
      ADD COLUMN triage_category text
        CONSTRAINT issue_reports_triage_category_check CHECK (triage_category IS NULL OR triage_category IN (${CATEGORIES})),
      ADD COLUMN labels text[] NOT NULL DEFAULT '{}'
        CONSTRAINT issue_reports_labels_check CHECK (${LABELS_CHECK("labels")}),
      ADD COLUMN duplicate_of uuid REFERENCES issue_reports(id) ON DELETE SET NULL,
      ADD COLUMN triaged_by text,
      ADD COLUMN triaged_at timestamptz,
      ADD COLUMN ai_reviewed_at timestamptz,
      ADD COLUMN ai_validity text
        CONSTRAINT issue_reports_ai_validity_check CHECK (ai_validity IS NULL OR ai_validity IN ('valid', 'spam', 'duplicate')),
      ADD COLUMN ai_category text
        CONSTRAINT issue_reports_ai_category_check CHECK (ai_category IS NULL OR ai_category IN (${CATEGORIES})),
      ADD COLUMN ai_labels text[] NOT NULL DEFAULT '{}'
        CONSTRAINT issue_reports_ai_labels_check CHECK (${LABELS_CHECK("ai_labels")}),
      ADD COLUMN ai_duplicate_of uuid REFERENCES issue_reports(id) ON DELETE SET NULL,
      ADD COLUMN ai_note text
        CONSTRAINT issue_reports_ai_note_check CHECK (ai_note IS NULL OR (btrim(ai_note) <> '' AND char_length(ai_note) <= 500)),
      ADD CONSTRAINT issue_reports_duplicate_check CHECK (
        (duplicate_of IS NULL OR (validity = 'duplicate' AND duplicate_of <> id))
        AND (ai_duplicate_of IS NULL OR (ai_validity = 'duplicate' AND ai_duplicate_of <> id))),
      ADD CONSTRAINT issue_reports_triaged_check CHECK ((triaged_by IS NULL) = (triaged_at IS NULL)),
      ADD CONSTRAINT issue_reports_ai_review_check CHECK (
        (ai_reviewed_at IS NULL) = (ai_validity IS NULL)
        AND (ai_reviewed_at IS NOT NULL
          OR (ai_category IS NULL AND cardinality(ai_labels) = 0 AND ai_duplicate_of IS NULL AND ai_note IS NULL)));
    CREATE INDEX issue_reports_validity_page_idx ON issue_reports (validity, created_at DESC, id DESC);
    CREATE INDEX issue_reports_labels_idx ON issue_reports USING gin (labels);
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM issue_reports WHERE triaged_at IS NOT NULL OR ai_reviewed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Issue report triage exists; it must be retained';
      END IF;
    END $$;
    DROP INDEX issue_reports_labels_idx;
    DROP INDEX issue_reports_validity_page_idx;
    ALTER TABLE issue_reports
      DROP CONSTRAINT issue_reports_duplicate_check,
      DROP CONSTRAINT issue_reports_triaged_check,
      DROP CONSTRAINT issue_reports_ai_review_check,
      DROP COLUMN validity, DROP COLUMN triage_category, DROP COLUMN labels, DROP COLUMN duplicate_of,
      DROP COLUMN triaged_by, DROP COLUMN triaged_at,
      DROP COLUMN ai_reviewed_at, DROP COLUMN ai_validity, DROP COLUMN ai_category, DROP COLUMN ai_labels,
      DROP COLUMN ai_duplicate_of, DROP COLUMN ai_note;
    DROP FUNCTION issue_report_labels_valid(text[]);
  `);
}
