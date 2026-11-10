/** Preserve installed clients while allowing arbitrary Home card colors. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE home_promotions ADD COLUMN color text;
    UPDATE home_promotions SET color = CASE style WHEN 'yellow' THEN '#FFDE58' ELSE '#FFFFFF' END;
    -- Old API processes remain live between migration and image replacement.
    -- Only infer color for legacy inserts or an actual style-only change.
    CREATE FUNCTION home_promotion_legacy_color() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.color IS NULL THEN
          NEW.color := CASE NEW.style WHEN 'yellow' THEN '#FFDE58' ELSE '#FFFFFF' END;
        END IF;
      ELSIF NEW.style IS DISTINCT FROM OLD.style AND NEW.color IS NOT DISTINCT FROM OLD.color THEN
        NEW.color := CASE NEW.style WHEN 'yellow' THEN '#FFDE58' ELSE '#FFFFFF' END;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER home_promotion_legacy_color
      BEFORE INSERT OR UPDATE ON home_promotions
      FOR EACH ROW EXECUTE FUNCTION home_promotion_legacy_color();
    ALTER TABLE home_promotions ALTER COLUMN color SET NOT NULL;
    ALTER TABLE home_promotions ADD CONSTRAINT home_promotions_color_check
      CHECK (char_length(color) = 7 AND color ~ '^#[0-9A-F]{6}$');
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
