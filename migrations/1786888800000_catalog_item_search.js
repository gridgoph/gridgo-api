export async function up(pgm) {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

    ALTER TABLE supplier_catalog_items
      ADD COLUMN search_text text NOT NULL DEFAULT '';

    ALTER TABLE supplier_catalog_items
      ADD COLUMN search_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED;

    CREATE INDEX supplier_catalog_items_search_tsv_idx
      ON supplier_catalog_items USING gin (search_tsv);

    CREATE INDEX supplier_catalog_items_search_trgm_idx
      ON supplier_catalog_items USING gin (search_text public.gin_trgm_ops);

    CREATE INDEX supplier_catalog_items_supplier_active_sort_idx
      ON supplier_catalog_items (supplier_id, active, sort_order, id);

    CREATE OR REPLACE FUNCTION supplier_catalog_item_refresh_search(item_id text)
    RETURNS void LANGUAGE plpgsql AS $$
    DECLARE
      assembled text;
    BEGIN
      SELECT btrim(concat_ws(' ',
        NULLIF(btrim(item.name), ''),
        NULLIF(btrim(item.description), ''),
        NULLIF(btrim(sub.name), ''),
        (
          SELECT NULLIF(btrim(string_agg(opt.label, ' ' ORDER BY grp.sort_order, opt.sort_order, opt.id)), '')
            FROM supplier_catalog_option_groups grp
            JOIN supplier_catalog_options opt ON opt.option_group_id = grp.id
           WHERE grp.catalog_item_id = item.id
        ),
        (
          SELECT NULLIF(btrim(string_agg(step.title, ' ' ORDER BY step.sort_order, step.id)), '')
            FROM supplier_catalog_prep_steps step
           WHERE step.catalog_item_id = item.id
        )
      ))
        INTO assembled
        FROM supplier_catalog_items item
        LEFT JOIN taxonomy_subcategories sub ON sub.code = item.subcategory_code
       WHERE item.id = item_id;

      IF assembled IS NULL THEN
        RETURN;
      END IF;

      UPDATE supplier_catalog_items
         SET search_text = assembled
       WHERE id = item_id
         AND search_text IS DISTINCT FROM assembled;
    END;
    $$;

    CREATE OR REPLACE FUNCTION supplier_catalog_items_search_trigger()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM supplier_catalog_item_refresh_search(NEW.id);
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION supplier_catalog_options_search_trigger()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      item_id text;
    BEGIN
      SELECT grp.catalog_item_id INTO item_id
        FROM supplier_catalog_option_groups grp
       WHERE grp.id = COALESCE(NEW.option_group_id, OLD.option_group_id);
      IF item_id IS NOT NULL THEN
        PERFORM supplier_catalog_item_refresh_search(item_id);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION supplier_catalog_prep_steps_search_trigger()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM supplier_catalog_item_refresh_search(COALESCE(NEW.catalog_item_id, OLD.catalog_item_id));
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE OR REPLACE FUNCTION taxonomy_subcategories_catalog_search_trigger()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      item_id text;
    BEGIN
      FOR item_id IN
        SELECT id FROM supplier_catalog_items WHERE subcategory_code = NEW.code
      LOOP
        PERFORM supplier_catalog_item_refresh_search(item_id);
      END LOOP;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER supplier_catalog_items_search_refresh
      AFTER INSERT OR UPDATE OF name, description, subcategory_code
      ON supplier_catalog_items
      FOR EACH ROW EXECUTE FUNCTION supplier_catalog_items_search_trigger();

    CREATE TRIGGER supplier_catalog_options_search_refresh
      AFTER INSERT OR UPDATE OF label OR DELETE
      ON supplier_catalog_options
      FOR EACH ROW EXECUTE FUNCTION supplier_catalog_options_search_trigger();

    CREATE TRIGGER supplier_catalog_prep_steps_search_refresh
      AFTER INSERT OR UPDATE OF title OR DELETE
      ON supplier_catalog_prep_steps
      FOR EACH ROW EXECUTE FUNCTION supplier_catalog_prep_steps_search_trigger();

    CREATE TRIGGER taxonomy_subcategories_catalog_search_refresh
      AFTER UPDATE OF name
      ON taxonomy_subcategories
      FOR EACH ROW EXECUTE FUNCTION taxonomy_subcategories_catalog_search_trigger();

    SELECT supplier_catalog_item_refresh_search(id) FROM supplier_catalog_items;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS taxonomy_subcategories_catalog_search_refresh ON taxonomy_subcategories;
    DROP TRIGGER IF EXISTS supplier_catalog_prep_steps_search_refresh ON supplier_catalog_prep_steps;
    DROP TRIGGER IF EXISTS supplier_catalog_options_search_refresh ON supplier_catalog_options;
    DROP TRIGGER IF EXISTS supplier_catalog_items_search_refresh ON supplier_catalog_items;
    DROP FUNCTION IF EXISTS taxonomy_subcategories_catalog_search_trigger();
    DROP FUNCTION IF EXISTS supplier_catalog_prep_steps_search_trigger();
    DROP FUNCTION IF EXISTS supplier_catalog_options_search_trigger();
    DROP FUNCTION IF EXISTS supplier_catalog_items_search_trigger();
    DROP FUNCTION IF EXISTS supplier_catalog_item_refresh_search(text);
    DROP INDEX IF EXISTS supplier_catalog_items_supplier_active_sort_idx;
    DROP INDEX IF EXISTS supplier_catalog_items_search_trgm_idx;
    DROP INDEX IF EXISTS supplier_catalog_items_search_tsv_idx;
    ALTER TABLE supplier_catalog_items DROP COLUMN IF EXISTS search_tsv;
    ALTER TABLE supplier_catalog_items DROP COLUMN IF EXISTS search_text;
  `);
}
