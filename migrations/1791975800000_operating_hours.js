/** Prospective rollout: no orders, promises, lapses or payout rows are rewritten. */
export async function up(pgm) {
  pgm.sql(`
    UPDATE platform_settings SET settings = settings || '{"operatingHours":{
      "timeZone":"Asia/Manila","artworkReviewMinutes":60,"priorityDispatchCutoffMinute":960,
      "schedule":{"utcOffsetMinutes":480,"week":[
        {"weekday":1,"opensMinute":480,"closesMinute":1020},
        {"weekday":2,"opensMinute":480,"closesMinute":1020},
        {"weekday":3,"opensMinute":480,"closesMinute":1020},
        {"weekday":4,"opensMinute":480,"closesMinute":1020},
        {"weekday":5,"opensMinute":480,"closesMinute":1020},
        {"weekday":6,"opensMinute":480,"closesMinute":1020}],"closures":[]}}}'::jsonb,
      version = version + 1 WHERE NOT settings ? 'operatingHours';
  `);
}
export async function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM orders WHERE data ? 'operatingClock') THEN
        RAISE EXCEPTION 'Operating-clock orders exist; use a forward migration';
      END IF;
    END $$;
    UPDATE platform_settings SET settings = settings - 'operatingHours', version = version + 1
      WHERE settings ? 'operatingHours';
  `);
}
