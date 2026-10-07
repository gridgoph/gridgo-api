/** Whole shop working days; keep hour columns for the installed app release gap. */
export async function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION production_day_minutes(schedule jsonb) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE shortest integer; longest integer;
    BEGIN
      IF schedule IS NULL THEN RETURN 600; END IF;
      IF jsonb_typeof(schedule->'week') IS DISTINCT FROM 'array' OR
         jsonb_array_length(schedule->'week') = 0 THEN
        RAISE EXCEPTION 'production_day_length_unavailable: no open days';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(schedule->'week') w WHERE
        w->>'weekday' IS NULL OR (w->>'weekday')::integer NOT BETWEEN 0 AND 6 OR
        w->>'opensMinute' IS NULL OR w->>'closesMinute' IS NULL OR
        (w->>'opensMinute')::integer < 0 OR (w->>'closesMinute')::integer > 1440 OR
        (w->>'closesMinute')::integer <= (w->>'opensMinute')::integer) THEN
        RAISE EXCEPTION 'production_day_length_unavailable: invalid open window';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(schedule->'week') WITH ORDINALITY a(w, n)
        JOIN jsonb_array_elements(schedule->'week') WITH ORDINALITY b(w, n) ON a.n < b.n
        WHERE a.w->>'weekday' = b.w->>'weekday'
          AND (a.w->>'opensMinute')::integer < (b.w->>'closesMinute')::integer
          AND (b.w->>'opensMinute')::integer < (a.w->>'closesMinute')::integer
      ) THEN RAISE EXCEPTION 'production_day_length_unavailable: overlapping open windows'; END IF;
      SELECT min(minutes), max(minutes) INTO shortest, longest FROM (
        SELECT sum((w->>'closesMinute')::integer - (w->>'opensMinute')::integer)::integer AS minutes
        FROM jsonb_array_elements(schedule->'week') w GROUP BY w->>'weekday'
      ) days;
      IF shortest IS NULL OR shortest <= 0 OR shortest <> longest THEN
        RAISE EXCEPTION 'production_day_length_unavailable: cannot convert shop schedule';
      END IF;
      RETURN shortest;
    END $$;

    CREATE FUNCTION production_days_json(record jsonb, minutes integer) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE prefix text; hours numeric; days integer; result jsonb := record;
    BEGIN
      IF record IS NULL THEN RETURN NULL; END IF;
      FOREACH prefix IN ARRAY ARRAY['turnaround', 'minimumTurnaround', 'standardTurnaround', 'rushTurnaround', 'defaultTurnaround'] LOOP
        IF record->>(prefix || 'Hours') IS NOT NULL THEN
          hours := (record->>(prefix || 'Hours'))::numeric;
          days := greatest(1, ceil(hours * 60 / minutes)::integer);
          result := result || jsonb_build_object(prefix || 'Days', days, prefix || 'Hours', days * minutes / 60.0);
        END IF;
      END LOOP;
      RETURN result;
    END $$;

    -- Validate every saved schedule before changing any duration. No guessed divisor.
    DO $$ BEGIN PERFORM production_day_minutes(schedule) FROM supplier_profiles; END $$;

    ALTER TABLE supplier_services
      ADD COLUMN turnaround_days integer CHECK (turnaround_days >= 1),
      ADD COLUMN standard_turnaround_days integer CHECK (standard_turnaround_days >= 1),
      ADD COLUMN rush_turnaround_days integer CHECK (rush_turnaround_days >= 1);
    ALTER TABLE supplier_catalog_items
      ADD COLUMN turnaround_days integer CHECK (turnaround_days >= 1),
      ADD COLUMN minimum_turnaround_days integer CHECK (minimum_turnaround_days >= 1),
      ADD CONSTRAINT catalog_production_days_range CHECK (minimum_turnaround_days <= turnaround_days);
    ALTER TABLE supplier_catalog_speed_tiers ADD COLUMN turnaround_days integer CHECK (turnaround_days >= 1);
    ALTER TABLE listing_starters ADD COLUMN default_turnaround_days integer CHECK (default_turnaround_days >= 1);

    ALTER TABLE order_line_items
      ADD COLUMN turnaround_days_snapshot integer CHECK (turnaround_days_snapshot >= 1),
      ADD COLUMN production_day_minutes_snapshot integer CHECK (production_day_minutes_snapshot > 0);
    ALTER TABLE order_jobs ADD COLUMN estimated_production_minutes integer CHECK (estimated_production_minutes > 0);
    CREATE FUNCTION guard_production_day_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.snapshot_finalized AND ROW(OLD.turnaround_days_snapshot, OLD.production_day_minutes_snapshot)
          IS DISTINCT FROM ROW(NEW.turnaround_days_snapshot, NEW.production_day_minutes_snapshot) THEN
        RAISE EXCEPTION 'order production day snapshots are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER production_day_snapshot_immutable BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION guard_production_day_snapshot();

    -- Two differently priced tiers may round to the same day. Retain both IDs/prices.
    DO $$ DECLARE constraint_name text; BEGIN
      SELECT conname INTO STRICT constraint_name FROM pg_constraint
      WHERE conrelid='supplier_catalog_speed_tiers'::regclass AND contype='u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (catalog_item_id, turnaround_hours)';
      EXECUTE format('ALTER TABLE supplier_catalog_speed_tiers DROP CONSTRAINT %I', constraint_name);
    END $$;

    UPDATE supplier_services s SET
      turnaround_days = greatest(1, ceil(s.turnaround_hours * 60.0 / production_day_minutes(p.schedule))),
      standard_turnaround_days = CASE WHEN s.standard_turnaround_hours IS NOT NULL THEN greatest(1, ceil(s.standard_turnaround_hours * 60.0 / production_day_minutes(p.schedule))) END,
      rush_turnaround_days = CASE WHEN s.rush_turnaround_hours IS NOT NULL THEN greatest(1, ceil(s.rush_turnaround_hours * 60.0 / production_day_minutes(p.schedule))) END
    FROM (SELECT s.id, p.schedule FROM supplier_services s LEFT JOIN supplier_profiles p ON p.user_id=s.supplier_id) p WHERE p.id=s.id;
    UPDATE supplier_catalog_items i SET
      turnaround_days = CASE WHEN i.turnaround_hours IS NOT NULL THEN greatest(1, ceil(i.turnaround_hours * 60.0 / production_day_minutes(p.schedule))) END,
      minimum_turnaround_days = CASE WHEN i.minimum_turnaround_hours IS NOT NULL THEN greatest(1, ceil(i.minimum_turnaround_hours * 60.0 / production_day_minutes(p.schedule))) END,
      approved_snapshot = CASE WHEN i.approved_snapshot IS NULL THEN NULL ELSE
        jsonb_set(jsonb_set(i.approved_snapshot, '{item}', production_days_json(i.approved_snapshot->'item', production_day_minutes(p.schedule))),
        '{catalogSpeedTiers}', COALESCE((SELECT jsonb_agg(production_days_json(t, production_day_minutes(p.schedule))) FROM jsonb_array_elements(i.approved_snapshot->'catalogSpeedTiers') t), '[]'::jsonb)) END
    FROM (SELECT i.id, p.schedule FROM supplier_catalog_items i LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id) p WHERE p.id=i.id;
    UPDATE supplier_catalog_speed_tiers t SET turnaround_days = greatest(1, ceil(t.turnaround_hours * 60.0 / production_day_minutes(p.schedule)))
    FROM supplier_catalog_items i LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id WHERE t.catalog_item_id=i.id;
    UPDATE listing_starters SET default_turnaround_days = greatest(1, ceil(default_turnaround_hours / 10.0)) WHERE default_turnaround_hours IS NOT NULL;

    UPDATE supplier_services s SET
      turnaround_hours = ceil(s.turnaround_days * production_day_minutes(p.schedule) / 60.0),
      standard_turnaround_hours = ceil(s.standard_turnaround_days * production_day_minutes(p.schedule) / 60.0),
      rush_turnaround_hours = ceil(s.rush_turnaround_days * production_day_minutes(p.schedule) / 60.0)
    FROM (SELECT s.id, p.schedule FROM supplier_services s LEFT JOIN supplier_profiles p ON p.user_id=s.supplier_id) p WHERE p.id=s.id;
    UPDATE supplier_catalog_items i SET
      turnaround_hours = ceil(i.turnaround_days * production_day_minutes(p.schedule) / 60.0),
      minimum_turnaround_hours = ceil(i.minimum_turnaround_days * production_day_minutes(p.schedule) / 60.0)
    FROM (SELECT i.id, p.schedule FROM supplier_catalog_items i LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id) p WHERE p.id=i.id;
    UPDATE supplier_catalog_speed_tiers t SET turnaround_hours = ceil(t.turnaround_days * production_day_minutes(p.schedule) / 60.0)
    FROM supplier_catalog_items i LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id WHERE t.catalog_item_id=i.id;
    UPDATE listing_starters SET default_turnaround_hours = default_turnaround_days * 10 WHERE default_turnaround_days IS NOT NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM supplier_services) OR EXISTS (SELECT 1 FROM supplier_catalog_items)
         OR EXISTS (SELECT 1 FROM supplier_catalog_speed_tiers) OR EXISTS (SELECT 1 FROM listing_starters)
         OR EXISTS (SELECT 1 FROM order_line_items WHERE turnaround_days_snapshot IS NOT NULL)
         OR EXISTS (SELECT 1 FROM order_jobs WHERE estimated_production_minutes IS NOT NULL) THEN
        RAISE EXCEPTION 'Production-day conversion requires a forward migration once used';
      END IF;
    END $$;
    ALTER TABLE supplier_services DROP COLUMN turnaround_days, DROP COLUMN standard_turnaround_days, DROP COLUMN rush_turnaround_days;
    ALTER TABLE supplier_catalog_items DROP CONSTRAINT catalog_production_days_range, DROP COLUMN turnaround_days, DROP COLUMN minimum_turnaround_days;
    ALTER TABLE supplier_catalog_speed_tiers DROP COLUMN turnaround_days, ADD UNIQUE (catalog_item_id, turnaround_hours);
    ALTER TABLE listing_starters DROP COLUMN default_turnaround_days;
    DROP TRIGGER production_day_snapshot_immutable ON order_line_items;
    DROP FUNCTION guard_production_day_snapshot();
    ALTER TABLE order_line_items DROP COLUMN turnaround_days_snapshot, DROP COLUMN production_day_minutes_snapshot;
    ALTER TABLE order_jobs DROP COLUMN estimated_production_minutes;
    DROP FUNCTION production_days_json(jsonb, integer);
    DROP FUNCTION production_day_minutes(jsonb);
  `);
}
