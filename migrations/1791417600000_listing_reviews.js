/** Existing listings retain approval; new HTTP listings enter Operations review. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN review_status text NOT NULL DEFAULT 'approved'
        CHECK (review_status IN ('pending','approved','needs_revision')),
      ADD COLUMN review_reason text CHECK (review_reason IS NULL OR (length(btrim(review_reason)) BETWEEN 1 AND 2000)),
      ADD COLUMN reviewed_at timestamptz,
      ADD COLUMN reviewed_by text REFERENCES users(id) ON DELETE RESTRICT,
      ADD COLUMN approved_snapshot jsonb CHECK (approved_snapshot IS NULL OR jsonb_typeof(approved_snapshot) = 'object'),
      ADD CONSTRAINT listing_review_reason_check CHECK (review_status <> 'needs_revision' OR review_reason IS NOT NULL);
    UPDATE supplier_catalog_items SET review_status = 'pending'
      WHERE active = false OR NOT EXISTS (
        SELECT 1 FROM supplier_services service WHERE service.id = supplier_service_id AND service.state = 'live'
      );
    ALTER TABLE supplier_catalog_items ALTER COLUMN review_status SET DEFAULT 'pending';
    CREATE INDEX supplier_catalog_review_queue ON supplier_catalog_items(review_status, id);
    CREATE TABLE product_type_requests (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      category_code text NOT NULL REFERENCES taxonomy_categories(code) ON DELETE RESTRICT,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
      description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
      status text NOT NULL CHECK (status IN ('pending','approved','needs_revision')),
      reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
      product_type_code text REFERENCES taxonomy_subcategories(code) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      reviewed_at timestamptz,
      reviewed_by text REFERENCES users(id) ON DELETE RESTRICT,
      CHECK (status <> 'needs_revision' OR reason IS NOT NULL),
      CHECK (status <> 'approved' OR product_type_code IS NOT NULL)
    );
    CREATE INDEX product_type_requests_queue ON product_type_requests(status, id);
    CREATE INDEX product_type_requests_supplier ON product_type_requests(supplier_id, id);
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM supplier_catalog_items WHERE review_status <> 'approved' OR approved_snapshot IS NOT NULL)
         OR EXISTS (SELECT 1 FROM product_type_requests) THEN
        RAISE EXCEPTION 'listing reviews exist; rollback would discard review decisions';
      END IF;
    END $$;
    DROP TABLE product_type_requests;
    ALTER TABLE supplier_catalog_items DROP CONSTRAINT listing_review_reason_check,
      DROP COLUMN review_status, DROP COLUMN review_reason, DROP COLUMN reviewed_at,
      DROP COLUMN reviewed_by, DROP COLUMN approved_snapshot;
  `);
}
