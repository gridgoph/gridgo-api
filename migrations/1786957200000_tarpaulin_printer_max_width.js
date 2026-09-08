/**
 * A tarpaulin listing has to say how wide the shop's printer can go.
 *
 * `minimum_width_milli` is the smallest size the shop will bill for. This is
 * the machine's maximum width in feet -- Polymedia's presses stop at 5 ft,
 * another shop's at 7 -- and a client asking for 6 ft on a 5 ft printer is
 * not a match. The two numbers are not the same thing and do not share a
 * column.
 *
 * Required in application code for `tarpaulins_outdoor_banners`; every other
 * subcategory stores NULL. Range is 1 through 20 inclusive.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN printer_max_width_feet integer
        CHECK (
          printer_max_width_feet IS NULL
          OR (printer_max_width_feet >= 1 AND printer_max_width_feet <= 20)
        );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      DROP COLUMN IF EXISTS printer_max_width_feet;
  `);
}
