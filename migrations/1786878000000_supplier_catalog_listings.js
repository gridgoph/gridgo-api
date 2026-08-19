export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_profiles
      ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
    ALTER TABLE supplier_payment_terms
      ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

    ALTER TABLE supplier_services
      ADD COLUMN pricing_basis text,
      ADD COLUMN standard_turnaround_hours integer,
      ADD COLUMN rush_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN rush_turnaround_hours integer,
      ADD COLUMN rush_price_minor money_minor,
      ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      ADD CONSTRAINT supplier_services_owner_uidx UNIQUE (id, supplier_id),
      ADD CONSTRAINT supplier_services_pricing_basis_check
        CHECK (pricing_basis IS NULL OR btrim(pricing_basis) <> ''),
      ADD CONSTRAINT supplier_services_standard_turnaround_check
        CHECK (standard_turnaround_hours IS NULL OR standard_turnaround_hours > 0),
      ADD CONSTRAINT supplier_services_rush_check CHECK (
        (rush_enabled = false AND rush_turnaround_hours IS NULL AND rush_price_minor IS NULL)
        OR
        (rush_enabled = true
          AND rush_turnaround_hours IS NOT NULL AND rush_turnaround_hours > 0
          AND rush_price_minor IS NOT NULL AND rush_price_minor >= 0)
      );

    UPDATE supplier_services
       SET pricing_basis = COALESCE(NULLIF(btrim(data->>'pricingBasis'), ''), 'per_unit'),
           standard_turnaround_hours = turnaround_hours;

    ALTER TABLE file_references
      DROP CONSTRAINT file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN (
          'order', 'supplier_service', 'user', 'rider_document',
          'supplier_catalog_item', 'supplier_shop_media'
        ));

    CREATE TABLE supplier_service_price_tiers (
      id text PRIMARY KEY,
      supplier_service_id text NOT NULL REFERENCES supplier_services(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      tier_code text NOT NULL CHECK (btrim(tier_code) <> ''),
      color_tier text CHECK (color_tier IN ('greyscale','color')),
      min_quantity integer NOT NULL DEFAULT 1 CHECK (min_quantity > 0),
      max_quantity integer CHECK (max_quantity IS NULL OR max_quantity >= min_quantity),
      unit_price_minor money_minor NOT NULL CHECK (unit_price_minor >= 0),
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      UNIQUE (supplier_service_id, tier_code),
      UNIQUE (supplier_service_id, sort_order)
    );

    CREATE TABLE accepted_file_formats (
      code text PRIMARY KEY,
      display_name text NOT NULL CHECK (btrim(display_name) <> ''),
      input_kind text NOT NULL CHECK (input_kind IN ('file','url')),
      extensions text[] NOT NULL DEFAULT '{}',
      mime_types text[] NOT NULL DEFAULT '{}',
      active boolean NOT NULL DEFAULT true
    );

    INSERT INTO accepted_file_formats
      (code, display_name, input_kind, extensions, mime_types)
    VALUES
      ('pdf', 'PDF', 'file', ARRAY['pdf'], ARRAY['application/pdf']),
      ('png', 'PNG', 'file', ARRAY['png'], ARRAY['image/png']),
      ('jpeg', 'JPEG', 'file', ARRAY['jpg','jpeg'], ARRAY['image/jpeg']),
      ('psd', 'Adobe Photoshop', 'file', ARRAY['psd'], ARRAY['image/vnd.adobe.photoshop','application/octet-stream']),
      ('canva_link', 'Canva link', 'url', '{}', '{}'),
      ('3mf', '3MF', 'file', ARRAY['3mf'], ARRAY['model/3mf','application/vnd.ms-package.3dmanufacturing-3dmodel+xml']),
      ('stl', 'STL', 'file', ARRAY['stl'], ARRAY['model/stl','application/sla']);

    CREATE TABLE supplier_service_file_formats (
      supplier_service_id text NOT NULL REFERENCES supplier_services(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      format_code text NOT NULL REFERENCES accepted_file_formats(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      PRIMARY KEY (supplier_service_id, format_code)
    );

    CREATE TABLE supplier_catalog_items (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      supplier_service_id text NOT NULL,
      subcategory_code text NOT NULL REFERENCES taxonomy_subcategories(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      name text NOT NULL CHECK (btrim(name) <> ''),
      description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
      base_price_minor money_minor NOT NULL CHECK (base_price_minor >= 0),
      pricing_unit text NOT NULL DEFAULT 'per_unit'
        CHECK (pricing_unit IN ('per_unit','per_package')),
      package_qty integer,
      turnaround_mode text NOT NULL DEFAULT 'inherit'
        CHECK (turnaround_mode IN ('inherit','override')),
      turnaround_hours integer,
      file_format_mode text NOT NULL DEFAULT 'inherit'
        CHECK (file_format_mode IN ('inherit','override')),
      active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      FOREIGN KEY (supplier_service_id, supplier_id)
        REFERENCES supplier_services(id, supplier_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      CHECK (
        (pricing_unit = 'per_unit' AND package_qty IS NULL)
        OR (pricing_unit = 'per_package' AND package_qty >= 2)
      ),
      CHECK (
        (turnaround_mode = 'inherit' AND turnaround_hours IS NULL)
        OR (turnaround_mode = 'override' AND turnaround_hours > 0)
      )
    );
    CREATE INDEX supplier_catalog_public_page_idx
      ON supplier_catalog_items (supplier_id, supplier_service_id, active, sort_order, id);
    CREATE INDEX supplier_catalog_service_idx
      ON supplier_catalog_items (supplier_service_id, active, sort_order, id);
    CREATE INDEX supplier_catalog_subcategory_idx
      ON supplier_catalog_items (subcategory_code, active, sort_order, id);

    CREATE TABLE supplier_catalog_item_photos (
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      file_id text NOT NULL UNIQUE REFERENCES files(file_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 7),
      alt_text text CHECK (alt_text IS NULL OR char_length(alt_text) <= 240),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (catalog_item_id, file_id),
      UNIQUE (catalog_item_id, sort_order) DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE supplier_shop_media (
      supplier_id text NOT NULL REFERENCES supplier_profiles(user_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      slot text NOT NULL CHECK (slot IN ('logo','cover')),
      file_id text NOT NULL UNIQUE REFERENCES files(file_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (supplier_id, slot)
    );

    CREATE TABLE supplier_catalog_option_groups (
      id text PRIMARY KEY,
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      name text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
      kind text NOT NULL DEFAULT 'spec' CHECK (kind IN ('spec','addon')),
      help_text text CHECK (help_text IS NULL OR char_length(help_text) <= 240),
      required boolean NOT NULL DEFAULT true,
      selection_mode text NOT NULL DEFAULT 'single'
        CHECK (selection_mode = 'single'),
      sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 5),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (catalog_item_id, sort_order) DEFERRABLE INITIALLY DEFERRED,
      CHECK (kind <> 'addon' OR required = false)
    );
    CREATE UNIQUE INDEX supplier_catalog_group_name_uidx
      ON supplier_catalog_option_groups (catalog_item_id, lower(name));

    CREATE TABLE supplier_catalog_options (
      id text PRIMARY KEY,
      option_group_id text NOT NULL REFERENCES supplier_catalog_option_groups(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      label text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 100),
      price_modifier_minor money_minor NOT NULL DEFAULT 0,
      spec_binding jsonb,
      active boolean NOT NULL DEFAULT true,
      sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 19),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (option_group_id, sort_order) DEFERRABLE INITIALLY DEFERRED,
      CHECK (spec_binding IS NULL OR jsonb_typeof(spec_binding) = 'object')
    );
    CREATE UNIQUE INDEX supplier_catalog_option_label_uidx
      ON supplier_catalog_options (option_group_id, lower(label));

    CREATE TABLE supplier_catalog_item_file_formats (
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      format_code text NOT NULL REFERENCES accepted_file_formats(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      PRIMARY KEY (catalog_item_id, format_code)
    );

    CREATE TABLE listing_starters (
      id text PRIMARY KEY,
      subcategory_code text NOT NULL REFERENCES taxonomy_subcategories(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      name text NOT NULL CHECK (btrim(name) <> ''),
      default_pricing_unit text NOT NULL DEFAULT 'per_unit'
        CHECK (default_pricing_unit IN ('per_unit','per_package')),
      default_package_qty integer,
      default_turnaround_hours integer CHECK (default_turnaround_hours IS NULL OR default_turnaround_hours > 0),
      default_format_codes text[] NOT NULL DEFAULT '{}',
      CHECK (
        (default_pricing_unit = 'per_unit' AND default_package_qty IS NULL)
        OR (default_pricing_unit = 'per_package' AND default_package_qty >= 2)
      )
    );

    CREATE TABLE listing_starter_groups (
      id text PRIMARY KEY,
      starter_id text NOT NULL REFERENCES listing_starters(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      name text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
      kind text NOT NULL DEFAULT 'spec' CHECK (kind IN ('spec','addon')),
      help_text text CHECK (help_text IS NULL OR char_length(help_text) <= 240),
      required boolean NOT NULL DEFAULT true,
      sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 5),
      UNIQUE (starter_id, sort_order),
      CHECK (kind <> 'addon' OR required = false)
    );

    CREATE TABLE listing_starter_options (
      id text PRIMARY KEY,
      starter_group_id text NOT NULL REFERENCES listing_starter_groups(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      label text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 100),
      price_modifier_minor money_minor NOT NULL DEFAULT 0,
      spec_binding jsonb,
      sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 19),
      UNIQUE (starter_group_id, sort_order),
      CHECK (spec_binding IS NULL OR jsonb_typeof(spec_binding) = 'object')
    );

    CREATE TABLE order_line_items (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      source_catalog_item_id text REFERENCES supplier_catalog_items(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      source_supplier_service_id text REFERENCES supplier_services(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      item_name_snapshot text NOT NULL CHECK (btrim(item_name_snapshot) <> ''),
      description_snapshot text NOT NULL DEFAULT '',
      pricing_basis_snapshot text NOT NULL CHECK (btrim(pricing_basis_snapshot) <> ''),
      pricing_unit_snapshot text NOT NULL CHECK (pricing_unit_snapshot IN ('per_unit','per_package')),
      package_qty_snapshot integer,
      turnaround_hours_snapshot integer,
      base_unit_price_minor money_minor NOT NULL CHECK (base_unit_price_minor >= 0),
      effective_unit_price_minor money_minor NOT NULL CHECK (effective_unit_price_minor >= 0),
      quantity integer NOT NULL CHECK (quantity > 0),
      line_subtotal_minor money_minor NOT NULL CHECK (line_subtotal_minor >= 0),
      accepted_format_codes_snapshot text[] NOT NULL CHECK (cardinality(accepted_format_codes_snapshot) > 0),
      structured_spec_snapshot jsonb NOT NULL CHECK (jsonb_typeof(structured_spec_snapshot) = 'object'),
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      snapshot_finalized boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL,
      UNIQUE (order_id, sort_order)
    );
    CREATE INDEX order_line_items_source_idx
      ON order_line_items (source_catalog_item_id, order_id);

    CREATE TABLE order_line_item_options (
      id text PRIMARY KEY,
      order_line_item_id text NOT NULL REFERENCES order_line_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      source_option_group_id text REFERENCES supplier_catalog_option_groups(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      source_option_id text REFERENCES supplier_catalog_options(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      group_name_snapshot text NOT NULL CHECK (btrim(group_name_snapshot) <> ''),
      group_kind_snapshot text NOT NULL CHECK (group_kind_snapshot IN ('spec','addon')),
      option_label_snapshot text NOT NULL CHECK (btrim(option_label_snapshot) <> ''),
      price_modifier_minor money_minor NOT NULL,
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      UNIQUE (order_line_item_id, sort_order)
    );

    CREATE OR REPLACE FUNCTION check_catalog_item_subcategory()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      service_category text;
      resolved_category text;
    BEGIN
      SELECT category_code INTO service_category
        FROM supplier_services WHERE id = NEW.supplier_service_id;
      SELECT COALESCE(
        (SELECT category_code FROM taxonomy_category_aliases WHERE code = service_category),
        service_category
      ) INTO resolved_category;
      IF NOT EXISTS (
        SELECT 1 FROM taxonomy_subcategories
         WHERE code = NEW.subcategory_code
           AND category_code = resolved_category
      ) THEN
        RAISE EXCEPTION 'catalog item subcategory must match the owning service category'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_catalog_item_subcategory_check';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER supplier_catalog_items_subcategory_trigger
      BEFORE INSERT OR UPDATE OF supplier_service_id, subcategory_code ON supplier_catalog_items
      FOR EACH ROW EXECUTE FUNCTION check_catalog_item_subcategory();

    CREATE OR REPLACE FUNCTION check_catalog_item_file_formats()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      target_id text;
      target_mode text;
      active_count integer;
      row_count integer;
    BEGIN
      IF TG_TABLE_NAME = 'supplier_catalog_items' THEN
        target_id := COALESCE(NEW.id, OLD.id);
      ELSE
        target_id := COALESCE(NEW.catalog_item_id, OLD.catalog_item_id);
      END IF;
      SELECT file_format_mode INTO target_mode FROM supplier_catalog_items WHERE id = target_id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT count(*), count(*) FILTER (WHERE registry.active)
        INTO row_count, active_count
        FROM supplier_catalog_item_file_formats item_format
        JOIN accepted_file_formats registry ON registry.code = item_format.format_code
       WHERE item_format.catalog_item_id = target_id;
      IF target_mode = 'inherit' AND row_count <> 0 THEN
        RAISE EXCEPTION 'inherit mode cannot have item file formats'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_catalog_item_format_mode_check';
      END IF;
      IF target_mode = 'override' AND active_count = 0 THEN
        RAISE EXCEPTION 'override mode requires an active accepted format'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_catalog_item_format_mode_check';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER supplier_catalog_items_format_mode_trigger
      AFTER INSERT OR UPDATE OF file_format_mode ON supplier_catalog_items
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION check_catalog_item_file_formats();
    CREATE CONSTRAINT TRIGGER supplier_catalog_item_formats_mode_trigger
      AFTER INSERT OR UPDATE OR DELETE ON supplier_catalog_item_file_formats
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION check_catalog_item_file_formats();

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

    CREATE OR REPLACE FUNCTION check_order_line_item_math()
    RETURNS trigger LANGUAGE plpgsql AS $$
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
    CREATE CONSTRAINT TRIGGER order_line_items_math_trigger
      AFTER INSERT OR UPDATE ON order_line_items
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION check_order_line_item_math();
    CREATE CONSTRAINT TRIGGER order_line_item_options_math_trigger
      AFTER INSERT OR UPDATE OR DELETE ON order_line_item_options
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION check_order_line_item_math();

    CREATE OR REPLACE FUNCTION check_order_line_snapshot_finalized()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM order_line_items
         WHERE id = COALESCE(NEW.id, OLD.id) AND snapshot_finalized = false
      ) THEN
        RAISE EXCEPTION 'order line snapshot must be finalized before commit'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_snapshot_finalized_check';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER order_line_items_finalized_trigger
      AFTER INSERT OR UPDATE ON order_line_items
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION check_order_line_snapshot_finalized();

    CREATE OR REPLACE FUNCTION preserve_order_line_snapshot()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.snapshot_finalized = false THEN RETURN OLD; END IF;
        IF EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id) THEN
          RAISE EXCEPTION 'order line snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_immutable_check';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.snapshot_finalized = false THEN RETURN NEW; END IF;
      IF NEW.snapshot_finalized IS DISTINCT FROM OLD.snapshot_finalized THEN
        RAISE EXCEPTION 'order line snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_immutable_check';
      END IF;
      IF ROW(
        NEW.id, NEW.order_id, NEW.item_name_snapshot, NEW.description_snapshot,
        NEW.pricing_basis_snapshot, NEW.pricing_unit_snapshot, NEW.package_qty_snapshot,
        NEW.turnaround_hours_snapshot, NEW.base_unit_price_minor, NEW.effective_unit_price_minor,
        NEW.quantity, NEW.line_subtotal_minor, NEW.accepted_format_codes_snapshot,
        NEW.structured_spec_snapshot, NEW.sort_order, NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.id, OLD.order_id, OLD.item_name_snapshot, OLD.description_snapshot,
        OLD.pricing_basis_snapshot, OLD.pricing_unit_snapshot, OLD.package_qty_snapshot,
        OLD.turnaround_hours_snapshot, OLD.base_unit_price_minor, OLD.effective_unit_price_minor,
        OLD.quantity, OLD.line_subtotal_minor, OLD.accepted_format_codes_snapshot,
        OLD.structured_spec_snapshot, OLD.sort_order, OLD.created_at
      ) THEN
        RAISE EXCEPTION 'order line snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_immutable_check';
      END IF;
      IF NEW.source_catalog_item_id IS DISTINCT FROM OLD.source_catalog_item_id
         AND NOT (OLD.source_catalog_item_id IS NOT NULL AND NEW.source_catalog_item_id IS NULL) THEN
        RAISE EXCEPTION 'order line snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_immutable_check';
      END IF;
      IF NEW.source_supplier_service_id IS DISTINCT FROM OLD.source_supplier_service_id
         AND NOT (OLD.source_supplier_service_id IS NOT NULL AND NEW.source_supplier_service_id IS NULL) THEN
        RAISE EXCEPTION 'order line snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_items_immutable_check';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER order_line_items_immutable_trigger
      BEFORE UPDATE OR DELETE ON order_line_items FOR EACH ROW
      EXECUTE FUNCTION preserve_order_line_snapshot();

    CREATE OR REPLACE FUNCTION preserve_order_line_option_snapshot()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      old_finalized boolean := false;
      new_finalized boolean := false;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        SELECT snapshot_finalized INTO old_finalized
          FROM order_line_items WHERE id = OLD.order_line_item_id;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        SELECT snapshot_finalized INTO new_finalized
          FROM order_line_items WHERE id = NEW.order_line_item_id;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF new_finalized THEN
          RAISE EXCEPTION 'order line option snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_line_item_options_immutable_check';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF old_finalized THEN
          RAISE EXCEPTION 'order line option snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_line_item_options_immutable_check';
        END IF;
        RETURN OLD;
      END IF;
      IF NOT old_finalized AND NOT new_finalized THEN RETURN NEW; END IF;
      IF ROW(
        NEW.id, NEW.order_line_item_id, NEW.group_name_snapshot, NEW.group_kind_snapshot,
        NEW.option_label_snapshot, NEW.price_modifier_minor, NEW.sort_order
      ) IS DISTINCT FROM ROW(
        OLD.id, OLD.order_line_item_id, OLD.group_name_snapshot, OLD.group_kind_snapshot,
        OLD.option_label_snapshot, OLD.price_modifier_minor, OLD.sort_order
      ) THEN
        RAISE EXCEPTION 'order line option snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_item_options_immutable_check';
      END IF;
      IF NEW.source_option_group_id IS DISTINCT FROM OLD.source_option_group_id
         AND NOT (OLD.source_option_group_id IS NOT NULL AND NEW.source_option_group_id IS NULL) THEN
        RAISE EXCEPTION 'order line option snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_item_options_immutable_check';
      END IF;
      IF NEW.source_option_id IS DISTINCT FROM OLD.source_option_id
         AND NOT (OLD.source_option_id IS NOT NULL AND NEW.source_option_id IS NULL) THEN
        RAISE EXCEPTION 'order line option snapshots are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'order_line_item_options_immutable_check';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER order_line_item_options_immutable_trigger
      BEFORE INSERT OR UPDATE OR DELETE ON order_line_item_options FOR EACH ROW
      EXECUTE FUNCTION preserve_order_line_option_snapshot();
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS order_line_item_options_immutable_trigger ON order_line_item_options;
    DROP TRIGGER IF EXISTS order_line_items_immutable_trigger ON order_line_items;
    DROP TRIGGER IF EXISTS order_line_items_finalized_trigger ON order_line_items;
    DROP TRIGGER IF EXISTS order_line_item_options_math_trigger ON order_line_item_options;
    DROP TRIGGER IF EXISTS order_line_items_math_trigger ON order_line_items;
    DROP TRIGGER IF EXISTS supplier_catalog_options_group_trigger ON supplier_catalog_options;
    DROP TRIGGER IF EXISTS supplier_catalog_groups_option_trigger ON supplier_catalog_option_groups;
    DROP TRIGGER IF EXISTS supplier_catalog_item_formats_mode_trigger ON supplier_catalog_item_file_formats;
    DROP TRIGGER IF EXISTS supplier_catalog_items_format_mode_trigger ON supplier_catalog_items;
    DROP TRIGGER IF EXISTS supplier_catalog_items_subcategory_trigger ON supplier_catalog_items;
    DROP FUNCTION IF EXISTS preserve_order_line_option_snapshot();
    DROP FUNCTION IF EXISTS preserve_order_line_snapshot();
    DROP FUNCTION IF EXISTS check_order_line_snapshot_finalized();
    DROP FUNCTION IF EXISTS check_order_line_item_math();
    DROP FUNCTION IF EXISTS check_catalog_option_group_has_option();
    DROP FUNCTION IF EXISTS check_catalog_item_file_formats();
    DROP FUNCTION IF EXISTS check_catalog_item_subcategory();
    DROP TABLE IF EXISTS order_line_item_options;
    DROP TABLE IF EXISTS order_line_items;
    DROP TABLE IF EXISTS listing_starter_options;
    DROP TABLE IF EXISTS listing_starter_groups;
    DROP TABLE IF EXISTS listing_starters;
    DROP TABLE IF EXISTS supplier_catalog_item_file_formats;
    DROP TABLE IF EXISTS supplier_catalog_options;
    DROP TABLE IF EXISTS supplier_catalog_option_groups;
    DROP TABLE IF EXISTS supplier_shop_media;
    DROP TABLE IF EXISTS supplier_catalog_item_photos;
    DROP TABLE IF EXISTS supplier_catalog_items;
    DROP TABLE IF EXISTS supplier_service_file_formats;
    DROP TABLE IF EXISTS accepted_file_formats;
    DROP TABLE IF EXISTS supplier_service_price_tiers;
    ALTER TABLE file_references
      DROP CONSTRAINT IF EXISTS file_references_reference_type_check;
    ALTER TABLE file_references
      ADD CONSTRAINT file_references_reference_type_check
        CHECK (reference_type IN ('order', 'supplier_service', 'user', 'rider_document'));
    ALTER TABLE supplier_services
      DROP CONSTRAINT IF EXISTS supplier_services_rush_check,
      DROP CONSTRAINT IF EXISTS supplier_services_standard_turnaround_check,
      DROP CONSTRAINT IF EXISTS supplier_services_pricing_basis_check,
      DROP CONSTRAINT IF EXISTS supplier_services_owner_uidx,
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS rush_price_minor,
      DROP COLUMN IF EXISTS rush_turnaround_hours,
      DROP COLUMN IF EXISTS rush_enabled,
      DROP COLUMN IF EXISTS standard_turnaround_hours,
      DROP COLUMN IF EXISTS pricing_basis;
    ALTER TABLE supplier_payment_terms DROP COLUMN IF EXISTS version;
    ALTER TABLE supplier_profiles DROP COLUMN IF EXISTS version;
  `);
}
