/**
 * Express: a shop's per-listing switch for same-day availability. Off on
 * every existing listing. Orders keep their Express tag in `orders.data`.
 * Contract: docs/EXPRESS_API.md.
 */
export async function up(pgm) {
  pgm.sql(`ALTER TABLE supplier_catalog_items ADD COLUMN express boolean NOT NULL DEFAULT false;`);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM supplier_catalog_items WHERE express) THEN
        RAISE EXCEPTION 'Listings have Express switched on; use a forward migration.';
      END IF;
    END $$;
    ALTER TABLE supplier_catalog_items DROP COLUMN express;
  `);
}
