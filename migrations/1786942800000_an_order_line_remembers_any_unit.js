/**
 * Let an order line record the unit it was actually priced in.
 *
 * The last of the two-unit rules written before the catalogue could express
 * six. A listing sold by the page, the square foot, the running foot or as a
 * whole job could be described, stored and priced — and then refused at the
 * moment it became an order, because the line that snapshots what was bought
 * would only accept `per_unit` or `per_package`.
 *
 * That made every measured listing on the board unbuyable at the last step,
 * which is the worst place to find out: the client has chosen, priced and
 * committed by then.
 */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE order_line_items
      DROP CONSTRAINT order_line_items_pricing_unit_snapshot_check;

    ALTER TABLE order_line_items
      ADD CONSTRAINT order_line_items_pricing_unit_snapshot_check CHECK (
        pricing_unit_snapshot IN ('per_unit', 'per_package', 'per_page', 'per_area', 'per_length', 'whole_job')
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    -- Anything the old rule could not express has to go before it comes back.
    UPDATE order_line_items
       SET pricing_unit_snapshot = 'per_unit'
     WHERE pricing_unit_snapshot NOT IN ('per_unit', 'per_package');

    ALTER TABLE order_line_items
      DROP CONSTRAINT order_line_items_pricing_unit_snapshot_check;

    ALTER TABLE order_line_items
      ADD CONSTRAINT order_line_items_pricing_unit_snapshot_check CHECK (
        pricing_unit_snapshot = ANY (ARRAY['per_unit'::text, 'per_package'::text])
      );
  `);
}
