import { productionTimeCorrectionEvidence } from './helpers/production-time-review-evidence.js';

/** Repair databases that already ran release 2; never replay the Express conversion. */
export async function up(pgm) {
  pgm.sql(`
    WITH source AS (
      SELECT i.*, s.standard_turnaround_hours,
        CASE WHEN s.standard_turnaround_hours IS NOT NULL
          THEN s.standard_turnaround_days ELSE s.turnaround_days END AS inherited_days,
        (SELECT min(run_on) FROM pgmigrations WHERE name = '1791936000000_production_days') AS converted_at,
        (SELECT min(run_on) FROM pgmigrations WHERE name = '1792501000000_production_time_choice') AS choice_at
      FROM supplier_catalog_items i JOIN supplier_services s ON s.id = i.supplier_service_id
    ), evidence AS (
      SELECT source.*, ${productionTimeCorrectionEvidence} AS corrected_time_needs_review,
        EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'catalog_item.update'
          AND a.entity_type = 'supplier_catalog_item' AND a.entity_id = source.id AND a.at >= source.choice_at
          AND a.data #> '{detail,current,productionTimeReviewReasons}' = '[]'::jsonb) AS confirmed,
        EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'production_time.correct_39853344'
          AND a.entity_type = 'supplierServices' AND a.entity_id = source.supplier_service_id
          AND a.data #>> '{detail,duration,prefix}' IN ('turnaround', 'standardTurnaround', 'rushTurnaround')
          AND a.data #>> '{detail,duration,prefix}' <>
            CASE WHEN source.standard_turnaround_hours IS NOT NULL THEN 'standardTurnaround' ELSE 'turnaround' END
        ) AS unrelated_service_correction
      FROM source
    ), decisions AS (
      SELECT id, CASE
        WHEN confirmed THEN production_time_review_reasons
        WHEN created_at <= converted_at AND corrected_time_needs_review
          AND NOT ('legacy_one_working_day' = ANY(production_time_review_reasons))
          THEN array_append(production_time_review_reasons, 'legacy_one_working_day')
        WHEN NOT corrected_time_needs_review AND turnaround_mode = 'inherit'
          AND inherited_days IS DISTINCT FROM 1 AND unrelated_service_correction
          THEN array_remove(production_time_review_reasons, 'legacy_one_working_day')
        -- Already-converted Express rows lost their old mode/day count. Preserve
        -- ambiguous existing reminders rather than inventing their provenance.
        ELSE production_time_review_reasons END AS reasons
      FROM evidence
    )
    UPDATE supplier_catalog_items i SET production_time_review_reasons = d.reasons, version = i.version + 1
    FROM decisions d WHERE d.id = i.id AND i.production_time_review_reasons IS DISTINCT FROM d.reasons;
  `);
}

export async function down() { throw new Error('Production-time review evidence requires a forward migration'); }
