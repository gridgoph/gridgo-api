export const up = pgm => {
  pgm.addColumn('client_cart_lines', { speed_tier_id: { type: 'text' } });
  pgm.addColumn('order_line_items', { speed_tier_snapshot: { type: 'jsonb' } });
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
         AND line_row.line_subtotal_minor <> line_row.effective_unit_price_minor * line_row.quantity
           + COALESCE((line_row.speed_tier_snapshot->>'surchargeMinor')::bigint, 0) THEN
        RAISE EXCEPTION 'order line snapshot totals do not match selected options'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_snapshot_math_check';
      END IF;

      RETURN NULL;
    END;
    $$;

    CREATE FUNCTION guard_speed_tier_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.snapshot_finalized AND OLD.speed_tier_snapshot IS DISTINCT FROM NEW.speed_tier_snapshot THEN
        RAISE EXCEPTION 'order speed tier snapshots are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER speed_tier_snapshot_immutable BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION guard_speed_tier_snapshot();
  `);
};
export const down = () => { throw new Error('Tier price snapshots require a forward migration once deployed'); };
