/** Colour prices are shop-owned BIGINT rates; analysis/evidence is metadata. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN priced_by_colour boolean NOT NULL DEFAULT false,
      ADD COLUMN one_colour boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT colour_listing_mode CHECK (NOT priced_by_colour OR (pricing_unit='per_page' AND NOT one_colour AND cardinality(print_layouts)>0));
    CREATE TABLE supplier_catalog_colour_sizes (
      catalog_item_id text NOT NULL REFERENCES supplier_catalog_items(id) ON DELETE CASCADE,
      size_key text NOT NULL, paper_size text NOT NULL CHECK (length(paper_size) BETWEEN 1 AND 120),
      width_milli integer NOT NULL CHECK (width_milli BETWEEN 1 AND 20000000),
      height_milli integer NOT NULL CHECK (height_milli BETWEEN 1 AND 20000000),
      tier_set text NOT NULL CHECK (tier_set IN ('large_format','a3')),
      PRIMARY KEY (catalog_item_id,size_key),
      CHECK (tier_set <> 'a3' OR (LEAST(width_milli,height_milli)=297000 AND GREATEST(width_milli,height_milli)=420000))
    );
    CREATE TABLE supplier_catalog_colour_prices (
      catalog_item_id text NOT NULL, size_key text NOT NULL,
      tier_code text NOT NULL CHECK (tier_code IN ('none','up_to_25','up_to_50','above_50','monochrome','full_colour')),
      price_minor money_minor NOT NULL CHECK (price_minor >= 0),
      PRIMARY KEY (catalog_item_id,size_key,tier_code),
      FOREIGN KEY (catalog_item_id,size_key) REFERENCES supplier_catalog_colour_sizes(catalog_item_id,size_key) ON DELETE CASCADE
    );
    CREATE FUNCTION check_colour_price_tier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM supplier_catalog_colour_sizes s WHERE s.catalog_item_id=NEW.catalog_item_id AND s.size_key=NEW.size_key
        AND ((s.tier_set='large_format' AND NEW.tier_code IN ('none','up_to_25','up_to_50','above_50'))
          OR (s.tier_set='a3' AND NEW.tier_code IN ('monochrome','full_colour')))) THEN
        RAISE EXCEPTION 'colour price tier must match its paper tier set' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER colour_price_tier AFTER INSERT OR UPDATE ON supplier_catalog_colour_prices
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_colour_price_tier();
    CREATE FUNCTION check_colour_size_tiers() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM supplier_catalog_colour_prices p WHERE p.catalog_item_id=NEW.catalog_item_id AND p.size_key=NEW.size_key
        AND NOT ((NEW.tier_set='large_format' AND p.tier_code IN ('none','up_to_25','up_to_50','above_50'))
          OR (NEW.tier_set='a3' AND p.tier_code IN ('monochrome','full_colour')))) THEN
        RAISE EXCEPTION 'colour price tier must match its paper tier set' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER colour_size_tiers AFTER UPDATE ON supplier_catalog_colour_sizes
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_colour_size_tiers();
    ALTER TABLE client_cart_lines ADD COLUMN quantity_mode text
      CHECK (quantity_mode IN ('copies_each_page','document_sets'));
    ALTER TABLE order_line_items ADD COLUMN quantity_mode text
      CHECK (quantity_mode IN ('copies_each_page','document_sets')),
      ADD COLUMN colour_pricing jsonb CHECK (colour_pricing IS NULL OR (
        jsonb_typeof(colour_pricing)='object' AND colour_pricing->'version'='1'::jsonb
        AND jsonb_typeof(colour_pricing->'pages')='array'));
    CREATE FUNCTION check_order_colour_math() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE p jsonb; total numeric := 0; evidence jsonb := NEW.colour_pricing;
    BEGIN
      IF evidence->'pricedByColour' = 'true'::jsonb THEN
        IF (evidence->>'status'='priced' AND evidence->>'quantityMode'=NEW.quantity_mode
          AND (evidence->>'quantity')::numeric=NEW.quantity
          AND (evidence->>'totalSheets')::numeric=jsonb_array_length(evidence->'pages')::numeric*NEW.quantity
          AND (evidence->>'lineSubtotalMinor')::numeric=NEW.line_subtotal_minor) IS DISTINCT FROM TRUE THEN
          RAISE EXCEPTION 'colour order price requires complete evidence' USING ERRCODE='23514';
        END IF;
        FOR p IN SELECT * FROM jsonb_array_elements(evidence->'pages') LOOP
          IF (jsonb_typeof(p->'sheetPriceMinor')='number' AND (p->>'sheetPriceMinor')::numeric BETWEEN 0 AND 9007199254740991
            AND (p->>'sheetPriceMinor')::numeric=trunc((p->>'sheetPriceMinor')::numeric)
            AND jsonb_typeof(p->'strongColourBps')='number' AND (p->>'strongColourBps')::numeric BETWEEN 0 AND 10000
            AND (p->>'strongColourBps')::numeric=trunc((p->>'strongColourBps')::numeric)) IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'colour page price and coverage must be safe integers' USING ERRCODE='23514';
          END IF;
          total := total+(p->>'sheetPriceMinor')::numeric;
        END LOOP;
        IF total*NEW.quantity <> NEW.line_subtotal_minor THEN
          RAISE EXCEPTION 'colour pages must sum to the order line subtotal' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_colour_math BEFORE INSERT OR UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION check_order_colour_math();
    CREATE FUNCTION protect_order_colour_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.snapshot_finalized AND ROW(OLD.colour_pricing,OLD.quantity_mode) IS DISTINCT FROM ROW(NEW.colour_pricing,NEW.quantity_mode) THEN
        RAISE EXCEPTION 'order colour pricing evidence is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER order_colour_evidence_immutable BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION protect_order_colour_evidence();
    UPDATE platform_settings SET settings = settings || jsonb_build_object('colourDetection',
      jsonb_build_object('minSaturationBps',2500,'minLightnessBps',500,'maxLightnessBps',8500,'a3MonochromeMaxBps',1000)), version=version+1
      WHERE NOT settings ? 'colourDetection';
  `);
}
export async function down() {throw new Error('Colour pricing dispute evidence must be retained; use a forward migration.');}
