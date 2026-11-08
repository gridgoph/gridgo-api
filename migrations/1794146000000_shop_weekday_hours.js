/** Optional JSONB weekday overrides. No default/backfill and no order writes:
 * old API readers keep their base calendar during the release transition. */
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION shop_weekday_overrides_valid(schedule jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE override_window jsonb; seen integer[] := '{}'; weekday integer;
    BEGIN
      IF schedule IS NULL OR NOT schedule ? 'weekdayOverrides' THEN RETURN true; END IF;
      IF schedule->'utcOffsetMinutes' IS DISTINCT FROM '480'::jsonb
        OR jsonb_typeof(schedule->'week') IS DISTINCT FROM 'array'
        OR jsonb_typeof(schedule->'weekdayOverrides') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(schedule->'weekdayOverrides') > 7 THEN RETURN false; END IF;
      FOR override_window IN SELECT value FROM jsonb_array_elements(schedule->'weekdayOverrides') LOOP
        IF jsonb_typeof(override_window) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
        IF override_window - ARRAY['weekday','opensMinute','closesMinute'] <> '{}'::jsonb
          OR jsonb_typeof(override_window->'weekday') IS DISTINCT FROM 'number'
          OR jsonb_typeof(override_window->'opensMinute') IS DISTINCT FROM 'number'
          OR jsonb_typeof(override_window->'closesMinute') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        IF (override_window->>'weekday')::numeric <> trunc((override_window->>'weekday')::numeric)
          OR (override_window->>'weekday')::numeric NOT BETWEEN 0 AND 6
          OR (override_window->>'opensMinute')::numeric <> trunc((override_window->>'opensMinute')::numeric)
          OR (override_window->>'closesMinute')::numeric <> trunc((override_window->>'closesMinute')::numeric)
          OR (override_window->>'opensMinute')::numeric < 0
          OR (override_window->>'closesMinute')::numeric > 1440
          OR (override_window->>'closesMinute')::numeric <= (override_window->>'opensMinute')::numeric THEN RETURN false; END IF;
        weekday := (override_window->>'weekday')::integer;
        IF weekday = ANY(seen) OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(schedule->'week') w WHERE w->'weekday' = override_window->'weekday'
        ) THEN RETURN false; END IF;
        seen := array_append(seen, weekday);
      END LOOP;
      RETURN true;
    END $$;
    ALTER TABLE supplier_profiles ADD CONSTRAINT supplier_weekday_overrides_check
      CHECK (shop_weekday_overrides_valid(schedule)) NOT VALID;
    ALTER TABLE supplier_profiles VALIDATE CONSTRAINT supplier_weekday_overrides_check;
  `);
}

export async function down() {
  throw new Error('Shop weekday hours require a forward migration once released.');
}
