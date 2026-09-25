/**
 * Super Admin Tracker decisions.
 *
 * The tracker items themselves are GitHub issues and stay there; GRIDGO keeps
 * only what a Super Admin decided on one while it needed a decision, so
 * firstmate can pick the decision up (`processed_at` stays null until it does).
 * Attachment bytes live in MinIO as ordinary `tracker_decision` files; this row
 * names them by opaque file id and `file_references` pins each one to its
 * decision so it cannot be deleted from under it. Contract: docs/TRACKER_API.md.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE tracker_decisions (
      id text PRIMARY KEY,
      repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9._-]+$'),
      issue_number integer NOT NULL CHECK (issue_number > 0),
      text text NOT NULL CHECK (btrim(text) <> '' AND char_length(text) <= 5000),
      attachment_ids text[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(attachment_ids) <= 6),
      decided_by text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      decided_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz
    );

    CREATE INDEX tracker_decisions_item_idx ON tracker_decisions (repo, issue_number, decided_at);
    CREATE INDEX tracker_decisions_unprocessed_idx ON tracker_decisions (decided_at)
      WHERE processed_at IS NULL;

    ALTER TABLE file_references
      DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN (
          'order', 'supplier_service', 'user', 'rider_document',
          'supplier_catalog_item', 'supplier_shop_media', 'supplier_payout_account',
          'tracker_decision'
        ));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DELETE FROM file_references WHERE reference_type = 'tracker_decision';
    ALTER TABLE file_references
      DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN (
          'order', 'supplier_service', 'user', 'rider_document',
          'supplier_catalog_item', 'supplier_shop_media', 'supplier_payout_account'
        ));
    DROP TABLE IF EXISTS tracker_decisions;
  `);
}
