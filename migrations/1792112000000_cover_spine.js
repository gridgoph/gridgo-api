/**
 * Hardbound cover and spine: the client's cover choice and spine lettering on
 * a cart line, and the immutable form (or "not given") an order line keeps.
 * The Super Admin switch `coverSpineRequired` is a settings value that reads
 * as off while absent, so no settings row changes here.
 * Contract: docs/HARDBOUND_COVER_API.md.
 */
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION cover_spine_form_valid(form jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT jsonb_typeof(form) = 'object'
        AND jsonb_typeof(form->'cover') = 'string'
        AND form->>'cover' IN ('first_page', 'separate_file', 'text_only')
        AND CASE WHEN form->>'cover' = 'separate_file'
          THEN jsonb_typeof(form->'coverFileId') = 'string' AND char_length(form->>'coverFileId') BETWEEN 1 AND 120
          ELSE COALESCE(jsonb_typeof(form->'coverFileId'), 'null') = 'null' END
        AND jsonb_typeof(form->'spine') = 'object'
        AND (COALESCE(jsonb_typeof(form->'spine'->'institutionCode'), 'null') = 'null'
          OR (jsonb_typeof(form->'spine'->'institutionCode') = 'string' AND char_length(form->'spine'->>'institutionCode') BETWEEN 1 AND 24))
        AND jsonb_typeof(form->'spine'->'title') = 'string' AND char_length(form->'spine'->>'title') BETWEEN 1 AND 200
        AND jsonb_typeof(form->'spine'->'author') = 'string' AND char_length(form->'spine'->>'author') BETWEEN 1 AND 160
        -- CASE, not AND: SQL does not promise to test the type before the cast.
        AND CASE WHEN jsonb_typeof(form->'spine'->'month') = 'number'
          THEN (form->'spine'->>'month')::numeric IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12) ELSE false END
        AND CASE WHEN jsonb_typeof(form->'spine'->'year') = 'number'
          THEN (form->'spine'->>'year')::numeric BETWEEN 1950 AND 2100
            AND (form->'spine'->>'year')::numeric = trunc((form->'spine'->>'year')::numeric) ELSE false END
    $$;

    ALTER TABLE client_cart_lines ADD COLUMN cover_spine jsonb,
      ADD CONSTRAINT client_cart_lines_cover_spine_check CHECK (cover_spine IS NULL OR cover_spine_form_valid(cover_spine));
    ALTER TABLE order_line_items ADD COLUMN cover_spine jsonb,
      ADD CONSTRAINT order_line_cover_spine_check CHECK (cover_spine IS NULL OR (
        jsonb_typeof(cover_spine) = 'object' AND cover_spine->'version' = '1'::jsonb
        AND CASE cover_spine->>'status'
          WHEN 'given' THEN cover_spine_form_valid(cover_spine)
          WHEN 'not_given' THEN NOT (cover_spine ?| ARRAY['cover', 'coverFileId', 'spine'])
          ELSE false END));

    CREATE FUNCTION prevent_order_cover_spine_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND NEW.cover_spine IS DISTINCT FROM OLD.cover_spine THEN
        RAISE EXCEPTION 'order cover and spine snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_cover_spine_immutable_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_line_cover_spine_immutable_trigger BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION prevent_order_cover_spine_rewrite();
  `);
}

export async function down() {
  throw new Error('Order cover and spine snapshots must be preserved; use a forward migration.');
}
