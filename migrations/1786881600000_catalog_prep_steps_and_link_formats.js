export async function up(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS supplier_catalog_options_group_trigger ON supplier_catalog_options;
    DROP TRIGGER IF EXISTS supplier_catalog_groups_option_trigger ON supplier_catalog_option_groups;
    DROP FUNCTION IF EXISTS check_catalog_option_group_has_option();

    CREATE TABLE supplier_catalog_prep_steps (
      id text PRIMARY KEY,
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 7),
      title text NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 80),
      body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 1000),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (catalog_item_id, sort_order) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX supplier_catalog_prep_steps_item_idx
      ON supplier_catalog_prep_steps (catalog_item_id, sort_order, id);

    INSERT INTO accepted_file_formats
      (code, display_name, input_kind, extensions, mime_types)
    VALUES
      ('google_drive', 'Google Drive', 'url', '{}', '{}'),
      ('dropbox', 'Dropbox', 'url', '{}', '{}'),
      ('we_transfer', 'WeTransfer', 'url', '{}', '{}'),
      ('other_link', 'Other link', 'url', '{}', '{}')
    ON CONFLICT (code) DO NOTHING;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS supplier_catalog_prep_steps;
    DELETE FROM accepted_file_formats
     WHERE code IN ('google_drive', 'dropbox', 'we_transfer', 'other_link');

    CREATE OR REPLACE FUNCTION check_catalog_option_group_has_option()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      target_id text;
    BEGIN
      IF TG_TABLE_NAME = 'supplier_catalog_option_groups' THEN
        target_id := COALESCE(NEW.id, OLD.id);
      ELSE
        target_id := COALESCE(NEW.option_group_id, OLD.option_group_id);
      END IF;
      IF EXISTS (SELECT 1 FROM supplier_catalog_option_groups WHERE id = target_id)
         AND NOT EXISTS (
           SELECT 1 FROM supplier_catalog_options
            WHERE option_group_id = target_id AND active = true
         ) THEN
        RAISE EXCEPTION 'catalog option group requires an active option'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_catalog_group_active_option_check';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER supplier_catalog_groups_option_trigger
      AFTER INSERT OR UPDATE ON supplier_catalog_option_groups
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION check_catalog_option_group_has_option();
    CREATE CONSTRAINT TRIGGER supplier_catalog_options_group_trigger
      AFTER INSERT OR UPDATE OR DELETE ON supplier_catalog_options
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION check_catalog_option_group_has_option();
  `);
}
