/** Ordered, bounded artwork composites; legacy rows project without backfilling snapshots. */
export async function up(pgm) {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION valid_artwork_links(links jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE link jsonb;
    BEGIN
      IF jsonb_typeof(links) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(links) > 10 THEN RETURN false; END IF;
      FOR link IN SELECT value FROM jsonb_array_elements(links) LOOP
        IF jsonb_typeof(link) IS DISTINCT FROM 'object'
          OR jsonb_typeof(link->'url') IS DISTINCT FROM 'string'
          OR NOT COALESCE(link->>'formatCode' IN ('canva_link', 'google_drive', 'dropbox', 'we_transfer', 'other_link'), false)
          OR length(link->>'url') > 2000
          OR NOT (link->>'url' ~ '^https://[^/@[:space:]]+')
          OR (link ? 'label' AND (jsonb_typeof(link->'label') IS DISTINCT FROM 'string' OR length(link->>'label') > 80))
        THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    END $$;
    CREATE FUNCTION valid_artwork_attachments(entries jsonb, primary_file text, links jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE entry jsonb; first_file text; entry_links jsonb := '[]';
    BEGIN
      IF entries IS NULL THEN
        RETURN jsonb_array_length(links) + CASE WHEN primary_file IS NULL THEN 0 ELSE 1 END <= 10;
      END IF;
      IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(entries) > 10 THEN RETURN false; END IF;
      FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
        IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
          OR (entry ? 'label' AND (jsonb_typeof(entry->'label') IS DISTINCT FROM 'string' OR length(entry->>'label') > 80))
        THEN RETURN false; END IF;
        IF entry->>'kind' = 'file' THEN
          IF jsonb_typeof(entry->'fileId') IS DISTINCT FROM 'string'
            OR length(btrim(entry->>'fileId')) NOT BETWEEN 1 AND 120 OR entry ? 'url'
          THEN RETURN false; END IF;
          first_file := COALESCE(first_file, entry->>'fileId');
        ELSIF entry->>'kind' = 'link' THEN
          IF entry ? 'fileId' OR NOT valid_artwork_links(jsonb_build_array(entry)) THEN RETURN false; END IF;
          entry_links := entry_links || jsonb_build_array(entry - 'kind');
        ELSE RETURN false;
        END IF;
      END LOOP;
      RETURN first_file IS NOT DISTINCT FROM primary_file AND entry_links = links;
    END $$;
    ALTER TABLE client_cart_lines ADD COLUMN artwork_attachments jsonb,
      ADD CONSTRAINT client_cart_artwork_attachments_check CHECK (valid_artwork_attachments(artwork_attachments, artwork_file_id, artwork_links));
    ALTER TABLE order_line_items ADD COLUMN artwork_attachments jsonb,
      ADD CONSTRAINT order_line_artwork_attachments_check CHECK (valid_artwork_attachments(artwork_attachments, artwork_file_id, artwork_links));
    CREATE FUNCTION prevent_order_artwork_attachment_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND NEW.artwork_attachments IS DISTINCT FROM OLD.artwork_attachments THEN
        RAISE EXCEPTION 'order artwork attachment snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_artwork_attachments_immutable_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_line_artwork_attachments_immutable_trigger BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION prevent_order_artwork_attachment_rewrite();
  `);
}
export async function down() {
  throw new Error('Artwork attachment snapshots must be preserved; use a forward migration.');
}
