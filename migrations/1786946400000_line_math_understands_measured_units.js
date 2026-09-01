/**
 * Teach the order-line arithmetic check about the units it now has to accept.
 *
 * It asserted two things: that a line's unit price is its base plus the
 * modifiers of the options chosen, and that its subtotal is that price times
 * the quantity. Both were true when a listing could only be sold by the piece
 * or the pack. Neither survived the catalogue growing.
 *
 * A volume break replaces the rate outright, so the unit price stops being
 * base-plus-modifiers the moment a shop offers one. And a listing sold by the
 * square foot, the running foot or the page multiplies by measured size, not
 * by quantity — so the product was wrong for every measured line.
 *
 * The effect was the worst kind: a measured listing could be described,
 * stored, priced and put in a basket, and then refused by the database at the
 * moment it became an order. The client has already chosen and committed by
 * then.
 *
 * What survives is the part SQL can still own without keeping a second copy of
 * the pricing engine: money is never negative, and where the subtotal really
 * is a rate times a count, it still has to be. Everything else is
 * `src/pricing.js`, which is the one place that arithmetic should live.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION check_order_line_item_math() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      target_id text;
      line_row order_line_items%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME = 'order_line_items' THEN
        target_id := COALESCE(NEW.id, OLD.id);
      ELSE
        target_id := COALESCE(NEW.order_line_item_id, OLD.order_line_item_id);
      END IF;
      SELECT * INTO line_row FROM order_line_items WHERE id = target_id;
      IF NOT FOUND THEN RETURN NULL; END IF;

      IF line_row.effective_unit_price_minor < 0 OR line_row.line_subtotal_minor < 0 THEN
        RAISE EXCEPTION 'order line snapshot money cannot be negative'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_snapshot_math_check';
      END IF;

      -- Only where the subtotal genuinely is a rate times a count. A measured
      -- line multiplies by size, and restating that here would be a second
      -- pricing engine to keep in step with the first.
      IF line_row.pricing_unit_snapshot IN ('per_unit', 'per_package')
         AND line_row.line_subtotal_minor <> line_row.effective_unit_price_minor * line_row.quantity THEN
        RAISE EXCEPTION 'order line snapshot totals do not match selected options'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_snapshot_math_check';
      END IF;

      RETURN NULL;
    END;
    $$;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION check_order_line_item_math() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      target_id text;
      line_row order_line_items%ROWTYPE;
      modifier_total money_minor;
      expected_unit money_minor;
    BEGIN
      IF TG_TABLE_NAME = 'order_line_items' THEN
        target_id := COALESCE(NEW.id, OLD.id);
      ELSE
        target_id := COALESCE(NEW.order_line_item_id, OLD.order_line_item_id);
      END IF;
      SELECT * INTO line_row FROM order_line_items WHERE id = target_id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT COALESCE(sum(price_modifier_minor), 0)
        INTO modifier_total FROM order_line_item_options WHERE order_line_item_id = target_id;
      expected_unit := GREATEST(0, line_row.base_unit_price_minor + modifier_total);
      IF line_row.effective_unit_price_minor <> expected_unit
         OR line_row.line_subtotal_minor <> expected_unit * line_row.quantity THEN
        RAISE EXCEPTION 'order line snapshot totals do not match selected options'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_snapshot_math_check';
      END IF;
      RETURN NULL;
    END;
    $$;
  `);
}
