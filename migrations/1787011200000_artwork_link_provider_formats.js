/** Expand the bounded artwork URL registry without rewriting existing snapshots. */
export async function up(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION valid_artwork_links(links jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE link jsonb;
    BEGIN
      IF jsonb_typeof(links) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(links) > 3 THEN RETURN false; END IF;
      FOR link IN SELECT value FROM jsonb_array_elements(links) LOOP
        IF jsonb_typeof(link) IS DISTINCT FROM 'object'
          OR jsonb_typeof(link->'url') IS DISTINCT FROM 'string'
          OR NOT COALESCE(link->>'formatCode' IN ('canva_link', 'google_drive', 'dropbox', 'we_transfer', 'other_link'), false)
          OR length(link->>'url') > 2000
          OR NOT (link->>'url' ~ '^https://[^/@[:space:]]+')
        THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    END $$;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION valid_artwork_links(links jsonb) RETURNS boolean
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
    -- Refuse a rollback that would invalidate already stored links.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM client_cart_lines WHERE NOT valid_artwork_links(artwork_links))
        OR EXISTS (SELECT 1 FROM order_line_items WHERE NOT valid_artwork_links(artwork_links)) THEN
        RAISE EXCEPTION 'Cannot remove provider formats while artwork links use them';
      END IF;
    END $$;
  `);
}
