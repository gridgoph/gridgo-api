/** Bounded design links travel with cart artwork and immutable checkout lines. */
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION valid_artwork_links(links jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE link jsonb;
    BEGIN
      IF jsonb_typeof(links) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(links) > 3 THEN RETURN false; END IF;
      FOR link IN SELECT value FROM jsonb_array_elements(links) LOOP
        IF jsonb_typeof(link) IS DISTINCT FROM 'object'
          OR jsonb_typeof(link->'url') IS DISTINCT FROM 'string'
          OR NOT COALESCE(link->>'formatCode' IN ('canva_link', 'other_link'), false)
          OR length(link->>'url') > 2000
          OR NOT (link->>'url' ~ '^https://[^/@[:space:]]+')
        THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    END $$;
    ALTER TABLE client_cart_lines ADD COLUMN artwork_links jsonb NOT NULL DEFAULT '[]'
      CONSTRAINT client_cart_artwork_links_check CHECK (valid_artwork_links(artwork_links));
    ALTER TABLE order_line_items ADD COLUMN artwork_links jsonb NOT NULL DEFAULT '[]'
      CONSTRAINT order_line_artwork_links_check CHECK (valid_artwork_links(artwork_links));
    CREATE FUNCTION prevent_order_artwork_link_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND NEW.artwork_links IS DISTINCT FROM OLD.artwork_links THEN
        RAISE EXCEPTION 'order artwork link snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_artwork_links_immutable_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_line_artwork_links_immutable_trigger BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION prevent_order_artwork_link_rewrite();
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER order_line_artwork_links_immutable_trigger ON order_line_items;
    DROP FUNCTION prevent_order_artwork_link_rewrite();
    ALTER TABLE order_line_items DROP COLUMN artwork_links;
    ALTER TABLE client_cart_lines DROP COLUMN artwork_links;
    DROP FUNCTION valid_artwork_links(jsonb);
  `);
}
