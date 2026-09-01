/**
 * Let the four new pricing units past the package-quantity rule.
 *
 * `1786917600000_catalogue_pricing_shapes` widened the unit list from two to
 * six, but a second constraint written when there were only two still spelled
 * both of them out: package_qty had to be null AND the unit had to be
 * `per_unit`, or the unit had to be `per_package`. A listing priced by the
 * square foot satisfied neither, so the catalogue accepted the new units in
 * one constraint and refused them in the next -- which is how a tarpaulin
 * priced by the square foot could be described but never stored.
 *
 * The rule the original was reaching for survives intact: a package quantity
 * belongs to a listing sold by the package, and nothing else may carry one.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      DROP CONSTRAINT supplier_catalog_items_check;

    ALTER TABLE supplier_catalog_items
      ADD CONSTRAINT supplier_catalog_items_package_qty_check CHECK (
        (pricing_unit = 'per_package' AND package_qty >= 2)
        OR (pricing_unit <> 'per_package' AND package_qty IS NULL)
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    -- Anything the old rule could not express has to go before it comes back.
    UPDATE supplier_catalog_items
       SET pricing_unit = 'per_unit', package_qty = NULL
     WHERE pricing_unit NOT IN ('per_unit', 'per_package');

    ALTER TABLE supplier_catalog_items
      DROP CONSTRAINT supplier_catalog_items_package_qty_check;

    ALTER TABLE supplier_catalog_items
      ADD CONSTRAINT supplier_catalog_items_check CHECK (
        (pricing_unit = 'per_unit' AND package_qty IS NULL)
        OR (pricing_unit = 'per_package' AND package_qty >= 2)
      );
  `);
}
