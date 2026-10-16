/** Preserve existing day promises; original pre-conversion times require reviewed recovery. */
export async function up(pgm) {
  for (const [table, prefixes] of [
    ['supplier_services', ['turnaround', 'standard_turnaround', 'rush_turnaround']],
    ['supplier_catalog_items', ['turnaround', 'minimum_turnaround']],
    ['supplier_catalog_speed_tiers', ['turnaround']],
    ['listing_starters', ['default_turnaround']],
  ]) {
    for (const prefix of prefixes) pgm.sql(`ALTER TABLE ${table} ADD COLUMN ${prefix}_minutes integer CHECK (${prefix}_minutes > 0)`);
  }
  pgm.sql(`
    UPDATE supplier_services s SET
      turnaround_minutes = COALESCE(s.turnaround_days * production_day_minutes(p.schedule), s.turnaround_hours * 60),
      standard_turnaround_minutes = COALESCE(s.standard_turnaround_days * production_day_minutes(p.schedule), s.standard_turnaround_hours * 60),
      rush_turnaround_minutes = COALESCE(s.rush_turnaround_days * production_day_minutes(p.schedule), s.rush_turnaround_hours * 60)
    FROM (SELECT s.id, p.schedule FROM supplier_services s LEFT JOIN supplier_profiles p ON p.user_id=s.supplier_id) p WHERE p.id=s.id;
    UPDATE supplier_catalog_items i SET
      turnaround_minutes = COALESCE(i.turnaround_days * production_day_minutes(p.schedule), i.turnaround_hours * 60),
      minimum_turnaround_minutes = COALESCE(i.minimum_turnaround_days * production_day_minutes(p.schedule), i.minimum_turnaround_hours * 60)
    FROM (SELECT i.id, p.schedule FROM supplier_catalog_items i LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id) p WHERE p.id=i.id;
    UPDATE supplier_catalog_speed_tiers t SET turnaround_minutes = COALESCE(t.turnaround_days * production_day_minutes(p.schedule), t.turnaround_hours * 60)
    FROM supplier_catalog_items i LEFT JOIN supplier_profiles p ON p.user_id=i.supplier_id WHERE t.catalog_item_id=i.id;
    UPDATE listing_starters SET default_turnaround_minutes = COALESCE(default_turnaround_days * 600, default_turnaround_hours * 60);
    ALTER TABLE supplier_catalog_items ADD CONSTRAINT catalog_production_minutes_range CHECK (minimum_turnaround_minutes <= turnaround_minutes);

    ALTER TABLE order_line_items ADD COLUMN turnaround_minutes_snapshot integer CHECK (turnaround_minutes_snapshot > 0);
    CREATE FUNCTION guard_production_minute_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.snapshot_finalized AND OLD.turnaround_minutes_snapshot IS DISTINCT FROM NEW.turnaround_minutes_snapshot THEN
        RAISE EXCEPTION 'order production minute snapshots are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER production_minute_snapshot_immutable BEFORE UPDATE ON order_line_items
      FOR EACH ROW EXECUTE FUNCTION guard_production_minute_snapshot();
  `);
}

export async function down() { throw new Error('Production minutes require a forward migration once deployed'); }
