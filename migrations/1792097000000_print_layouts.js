/**
 * Print layouts: which layouts a shop prints for a listing, the client's
 * choice on a cart line, and the immutable choice and fit check an order line
 * keeps. Contract: docs/PRINT_LAYOUT_API.md.
 */
const LAYOUTS = "ARRAY['fit_to_paper', 'actual_size_centered', 'actual_size_original_position']::text[]";

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items ADD COLUMN print_layouts text[] NOT NULL DEFAULT '{}',
      ADD CONSTRAINT supplier_catalog_items_print_layouts_check
        CHECK (print_layouts <@ ${LAYOUTS} AND cardinality(print_layouts) <= 3 AND array_position(print_layouts, NULL) IS NULL);
    ALTER TABLE client_cart_lines ADD COLUMN print_layout text,
      ADD CONSTRAINT client_cart_lines_print_layout_check CHECK (print_layout IS NULL OR print_layout = ANY (${LAYOUTS}));
    ALTER TABLE order_line_items ADD COLUMN print_layout jsonb,
      ADD CONSTRAINT order_line_print_layout_check CHECK (print_layout IS NULL OR (
        jsonb_typeof(print_layout) = 'object' AND print_layout->'version' = '1'::jsonb
        AND jsonb_typeof(print_layout->'code') = 'string' AND print_layout->>'code' = ANY (${LAYOUTS})
        AND (NOT print_layout ? 'check' OR jsonb_typeof(print_layout->'check') IN ('object', 'null'))));

    CREATE FUNCTION prevent_order_print_layout_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND NEW.print_layout IS DISTINCT FROM OLD.print_layout THEN
        RAISE EXCEPTION 'order print layout snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_print_layout_immutable_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_line_print_layout_immutable_trigger BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION prevent_order_print_layout_rewrite();
  `);
}

export async function down() {
  throw new Error('Order print layout snapshots must be preserved; use a forward migration.');
}
