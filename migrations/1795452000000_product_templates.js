/** Additive reference/configuration and workflow records; no operational rewrite. */
export async function up(pgm) {
  pgm.sql(`
    -- Relax a bound only; legacy upserts remain valid during overlap/rollback.
    ALTER TABLE supplier_catalog_options DROP CONSTRAINT supplier_catalog_options_sort_order_check;
    ALTER TABLE supplier_catalog_options ADD CONSTRAINT supplier_catalog_options_sort_order_check CHECK (sort_order BETWEEN 0 AND 199);
    DO $$ DECLARE prior text; BEGIN
      SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint
        WHERE conrelid='file_references'::regclass AND conname='file_references_reference_type_check';
      IF prior IS NULL THEN RAISE EXCEPTION 'file reference policy must exist before template migration'; END IF;
      ALTER TABLE file_references DROP CONSTRAINT file_references_reference_type_check;
      EXECUTE format('ALTER TABLE file_references ADD CONSTRAINT file_references_reference_type_check CHECK ((%s) OR reference_type = %L)', prior, 'product_setup_request');
    END $$;
    CREATE TABLE product_templates (
      id text PRIMARY KEY,
      subcategory_code text NOT NULL REFERENCES taxonomy_subcategories(code) ON DELETE RESTRICT,
      active boolean NOT NULL DEFAULT true,
      version integer NOT NULL CHECK (version > 0), data jsonb NOT NULL
    );
    CREATE INDEX product_templates_subcategory ON product_templates(subcategory_code);
    CREATE TABLE product_setup_requests (
      id text PRIMARY KEY, supplier_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('template','setup')),
      status text NOT NULL CHECK (status IN ('pending','completed','needs_revision')),
      version integer NOT NULL CHECK (version > 0),
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX product_setup_requests_supplier ON product_setup_requests(supplier_id,id);
    CREATE INDEX product_setup_requests_queue ON product_setup_requests(status,kind,id);
    ALTER TABLE supplier_catalog_items ADD COLUMN template_data jsonb;
  `);
}
export async function down() {
  throw new Error(
    "Forward only: product templates and shop confirmations must be retained.",
  );
}
