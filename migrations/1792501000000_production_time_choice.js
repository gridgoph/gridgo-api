/** Listing-only release 2 adapter. Never update orders, jobs or immutable line snapshots. */
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE supplier_catalog_items ADD COLUMN production_time_review_reasons text[] NOT NULL DEFAULT '{}'
      CHECK (production_time_review_reasons <@ ARRAY['legacy_one_working_day', 'express_missing_hours']::text[]);

    WITH source AS (
      SELECT i.*, s.standard_turnaround_days, s.turnaround_days AS service_days,
        CASE WHEN i.turnaround_mode = 'override' THEN
          CASE WHEN i.turnaround_days IS NOT NULL THEN i.turnaround_days * production_day_minutes(p.schedule)
            ELSE COALESCE(i.turnaround_minutes, i.turnaround_hours * 60) END
        ELSE CASE WHEN s.standard_turnaround_hours IS NOT NULL THEN
          CASE WHEN s.standard_turnaround_days IS NOT NULL THEN s.standard_turnaround_days * production_day_minutes(p.schedule)
            ELSE COALESCE(s.standard_turnaround_minutes, s.standard_turnaround_hours * 60) END
          ELSE CASE WHEN s.turnaround_days IS NOT NULL THEN s.turnaround_days * production_day_minutes(p.schedule)
            ELSE COALESCE(s.turnaround_minutes, s.turnaround_hours * 60) END END END AS maximum_minutes,
        CASE WHEN i.minimum_turnaround_days IS NOT NULL THEN i.minimum_turnaround_days * production_day_minutes(p.schedule)
          ELSE COALESCE(i.minimum_turnaround_minutes, i.minimum_turnaround_hours * 60) END AS minimum_minutes,
        s.standard_turnaround_hours, p.schedule AS shop_schedule,
        (SELECT min(run_on) FROM pgmigrations WHERE name = '1791936000000_production_days') AS converted_at
      FROM supplier_catalog_items i JOIN supplier_services s ON s.id = i.supplier_service_id
      LEFT JOIN supplier_profiles p ON p.user_id = i.supplier_id
    ), decisions AS (
      SELECT source.*,
        express AND maximum_minutes > 0 AS convert_express,
        array_remove(ARRAY[
          CASE WHEN created_at <= converted_at AND (
            (turnaround_mode = 'override' AND (turnaround_days = 1 OR minimum_turnaround_days = 1))
            OR (turnaround_mode = 'inherit' AND CASE WHEN standard_turnaround_hours IS NOT NULL
                THEN standard_turnaround_days ELSE service_days END = 1)
            OR EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'production_time.correct_39853344'
              AND a.data #>> '{detail,duration,oldMinutes}' = production_day_minutes(source.shop_schedule)::text
              AND ((a.entity_type IN ('catalogItems', 'approvedCatalogItems') AND a.entity_id = source.id)
                OR (source.turnaround_mode = 'inherit' AND a.entity_type = 'supplierServices' AND a.entity_id = source.supplier_service_id)))
          ) THEN 'legacy_one_working_day' END,
          CASE WHEN express AND (maximum_minutes IS NULL OR maximum_minutes <= 0) THEN 'express_missing_hours' END
        ]::text[], NULL) AS reasons
      FROM source
    )
    UPDATE supplier_catalog_items i SET
      express = CASE WHEN d.convert_express THEN false ELSE i.express END,
      turnaround_mode = CASE WHEN d.convert_express THEN 'override' ELSE i.turnaround_mode END,
      turnaround_days = CASE WHEN d.convert_express THEN NULL ELSE i.turnaround_days END,
      turnaround_minutes = CASE WHEN d.convert_express THEN d.maximum_minutes ELSE i.turnaround_minutes END,
      turnaround_hours = CASE WHEN d.convert_express THEN ceil(d.maximum_minutes / 60.0)::integer ELSE i.turnaround_hours END,
      minimum_turnaround_days = CASE WHEN d.convert_express THEN NULL ELSE i.minimum_turnaround_days END,
      minimum_turnaround_minutes = CASE WHEN d.convert_express THEN COALESCE(d.minimum_minutes, d.maximum_minutes) ELSE i.minimum_turnaround_minutes END,
      minimum_turnaround_hours = CASE WHEN d.convert_express THEN ceil(COALESCE(d.minimum_minutes, d.maximum_minutes) / 60.0)::integer ELSE i.minimum_turnaround_hours END,
      production_time_review_reasons = d.reasons,
      version = i.version + 1
    FROM decisions d WHERE d.id = i.id AND (d.convert_express OR cardinality(d.reasons) > 0);
  `);
}

export async function down() { throw new Error('Production-time confirmation and Express conversion require a forward migration'); }
