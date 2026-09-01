/**
 * Let a listing starter offer the same six pricing units a listing can hold.
 *
 * Starters are the templates a shop copies when it puts something on its
 * board, and they were still restricted to the original two units — so the
 * catalogue could store a document priced by the page while no starter could
 * suggest one, and the five Documents & Publications starters could not be
 * seeded at all.
 *
 * Two constraints, the same pair as on `supplier_catalog_items`: one listing
 * the units, and one older one written when there were two of them that
 * spelled both out by name. The rule the second was reaching for survives
 * intact -- a package quantity belongs to a template sold by the package.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE listing_starters
      DROP CONSTRAINT listing_starters_default_pricing_unit_check,
      DROP CONSTRAINT listing_starters_check;

    ALTER TABLE listing_starters
      ADD CONSTRAINT listing_starters_default_pricing_unit_check CHECK (
        default_pricing_unit IN ('per_unit', 'per_package', 'per_page', 'per_area', 'per_length', 'whole_job')
      ),
      ADD CONSTRAINT listing_starters_package_qty_check CHECK (
        (default_pricing_unit = 'per_package' AND default_package_qty >= 2)
        OR (default_pricing_unit <> 'per_package' AND default_package_qty IS NULL)
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    -- Anything the old rule could not express has to go before it comes back.
    UPDATE listing_starters
       SET default_pricing_unit = 'per_unit', default_package_qty = NULL
     WHERE default_pricing_unit NOT IN ('per_unit', 'per_package');

    ALTER TABLE listing_starters
      DROP CONSTRAINT listing_starters_package_qty_check,
      DROP CONSTRAINT listing_starters_default_pricing_unit_check;

    ALTER TABLE listing_starters
      ADD CONSTRAINT listing_starters_default_pricing_unit_check CHECK (
        default_pricing_unit = ANY (ARRAY['per_unit'::text, 'per_package'::text])
      ),
      ADD CONSTRAINT listing_starters_check CHECK (
        (default_pricing_unit = 'per_unit' AND default_package_qty IS NULL)
        OR (default_pricing_unit = 'per_package' AND default_package_qty >= 2)
      );
  `);
}
