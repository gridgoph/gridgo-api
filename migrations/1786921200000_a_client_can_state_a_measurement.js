/**
 * Let a client say how big the thing is.
 *
 * `src/pricing.js` has been able to bill by the square foot, the running foot
 * and the page since it landed, and the catalogue has been able to store those
 * shapes since the migration before this one. Nothing could order one: a cart
 * line carried a quantity and nothing else, so a tarpaulin listing priced by
 * area reached the pricer with no area and refused the whole basket.
 *
 * These are the client's own numbers, not the artwork's. GRIDGO reads a size
 * out of an uploaded file and offers it, but a person ordering a 4x8 tarpaulin
 * from a 1920x1080 mockup is not ordering a 1920x1080 tarpaulin, so what the
 * file said is a default and what is stored here is what was agreed.
 *
 * Thousandths of the listing's own `measure_unit`, matching the catalogue's
 * scale exactly, so a comparison against a shop's minimum is integer against
 * integer and no float ever touches a price. Pages are a plain count.
 */
export async function up(pgm) {
  for (const table of ["client_cart_lines", "order_line_items"]) {
    pgm.sql(`
      ALTER TABLE ${table}
        ADD COLUMN measure_pages integer
          CHECK (measure_pages IS NULL OR measure_pages > 0),
        ADD COLUMN measure_width_milli integer
          CHECK (measure_width_milli IS NULL OR measure_width_milli > 0),
        ADD COLUMN measure_height_milli integer
          CHECK (measure_height_milli IS NULL OR measure_height_milli > 0),
        ADD COLUMN measure_length_milli integer
          CHECK (measure_length_milli IS NULL OR measure_length_milli > 0),
        -- Width and height are one measurement, not two. A line holding a width
        -- and no height has no area, and would be priced as though it did.
        ADD CONSTRAINT ${table}_measure_area_check CHECK (
          (measure_width_milli IS NULL) = (measure_height_milli IS NULL)
        );
    `);
  }
}

export async function down(pgm) {
  for (const table of ["client_cart_lines", "order_line_items"]) {
    pgm.sql(`
      ALTER TABLE ${table}
        DROP CONSTRAINT ${table}_measure_area_check,
        DROP COLUMN measure_length_milli,
        DROP COLUMN measure_height_milli,
        DROP COLUMN measure_width_milli,
        DROP COLUMN measure_pages;
    `);
  }
}
