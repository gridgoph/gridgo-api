/**
 * Exact colours: the client's colour targets on a cart line, and the
 * immutable targets an order line keeps once checkout finalizes it.
 * Contract: docs/EXACT_COLOURS_API.md.
 */
export async function up(pgm) {
  pgm.sql(`
    -- One to eight targets, each with a text label and exactly one known format.
    CREATE FUNCTION color_targets_valid(targets jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT jsonb_typeof(targets) = 'array'
        AND jsonb_array_length(targets) BETWEEN 1 AND 8
        AND NOT jsonb_path_exists(targets, '$[*] ? (@.type() != "object"
          || !exists(@.label ? (@.type() == "string"))
          || !exists(@.value ? (@.type() == "string"))
          || !exists(@.format ? (@ == "pantone" || @ == "cmyk" || @ == "hex")))')
    $$;

    ALTER TABLE client_cart_lines ADD COLUMN color_targets jsonb,
      ADD CONSTRAINT client_cart_lines_color_targets_check CHECK (color_targets IS NULL OR color_targets_valid(color_targets));
    ALTER TABLE order_line_items ADD COLUMN color_targets jsonb,
      ADD CONSTRAINT order_line_color_targets_check CHECK (color_targets IS NULL OR (
        jsonb_typeof(color_targets) = 'object' AND color_targets->'version' = '1'::jsonb
        AND color_targets_valid(color_targets->'targets')));

    CREATE FUNCTION prevent_order_color_targets_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND NEW.color_targets IS DISTINCT FROM OLD.color_targets THEN
        RAISE EXCEPTION 'order colour targets are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_color_targets_immutable_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_line_color_targets_immutable_trigger BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION prevent_order_color_targets_rewrite();
  `);
}

export async function down() {
  throw new Error('Order colour target snapshots must be preserved; use a forward migration.');
}
