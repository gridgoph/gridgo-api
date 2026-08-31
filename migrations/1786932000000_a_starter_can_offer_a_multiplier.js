/**
 * Let a starter template carry a multiplying add-on.
 *
 * `1786917600000_catalogue_pricing_shapes` gave a live listing option a
 * `price_multiplier_bps`, because Lovis prices back-to-back as "x2 the price"
 * and a flat amount has to be re-entered by hand every time the base price
 * moves. The starter templates a shop copies were never given the same column,
 * so a starter offering back-to-back produced an option worth nothing and the
 * add-on was silently free.
 *
 * Basis points, so no float reaches the money, and the same either-or rule the
 * live option carries: an option multiplies or it adds, never both.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE listing_starter_options
      ADD COLUMN price_multiplier_bps integer
        CHECK (price_multiplier_bps IS NULL OR price_multiplier_bps > 0),
      ADD CONSTRAINT listing_starter_options_price_shape_check CHECK (
        price_multiplier_bps IS NULL OR price_modifier_minor = 0
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE listing_starter_options
      DROP CONSTRAINT listing_starter_options_price_shape_check,
      DROP COLUMN price_multiplier_bps;
  `);
}
