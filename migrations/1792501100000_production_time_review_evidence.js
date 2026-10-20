import { correctionEvidence } from './helpers/production-time-review-evidence.js';

/** Repair databases that already ran release 2; never replay the Express conversion. */
export async function up(pgm) {
  pgm.sql(`
    WITH listings AS (
      SELECT i.*, s.standard_turnaround_hours,
        CASE WHEN s.standard_turnaround_hours IS NOT NULL
          THEN s.standard_turnaround_days ELSE s.turnaround_days END AS inherited_days,
        (SELECT min(run_on) FROM pgmigrations WHERE name = '1791936000000_production_days') AS converted_at,
        (SELECT min(run_on) FROM pgmigrations WHERE name = '1792501000000_production_time_choice') AS choice_at
      FROM supplier_catalog_items i JOIN supplier_services s ON s.id = i.supplier_service_id
    ), source AS MATERIALIZED (
      SELECT listings.*,
        -- Only the last pre-release edit can establish the old mode. A newer
        -- edit without a snapshot invalidates older evidence; approved pricing
        -- snapshots are deliberately not used as current timing provenance.
        (SELECT a.data #>> '{detail,current,turnaroundMode}' FROM audit_log a
          WHERE a.action IN ('catalog_item.update', 'catalog_item.create')
            AND a.entity_type = 'supplier_catalog_item' AND a.entity_id = listings.id
            AND a.at < listings.choice_at ORDER BY a.at DESC LIMIT 1) AS pre_conversion_mode
      FROM listings
    ), evidence AS MATERIALIZED (
      SELECT source.*, ${correctionEvidence(`source.turnaround_mode = 'inherit' OR (
        source.turnaround_mode = 'override' AND a.at < source.choice_at AND (
          source.pre_conversion_mode = 'inherit' OR (
            source.pre_conversion_mode IS NULL
            -- Express can have been toggled again after conversion without
            -- confirming the duration. Its current value is not provenance.
            AND source.version > 1
            AND source.turnaround_days IS NULL AND source.minimum_turnaround_days IS NULL
            AND source.minimum_turnaround_minutes > 0
            AND source.minimum_turnaround_minutes <= source.turnaround_minutes
            AND source.turnaround_hours = ceil(source.turnaround_minutes / 60.0)
            AND source.minimum_turnaround_hours = ceil(source.minimum_turnaround_minutes / 60.0)
            AND a.data #>> '{detail,duration,correctedMinutes}' = source.turnaround_minutes::text
          )
        ))`)} AS corrected_time_needs_review,
        EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'catalog_item.update'
          AND a.entity_type = 'supplier_catalog_item' AND a.entity_id = source.id AND a.at >= source.choice_at
          AND (a.data #> '{detail,productionTimeConfirmed}' = 'true'::jsonb
            OR (a.data #> '{detail,current,productionTimeReviewReasons}' = '[]'::jsonb
              AND (
                -- Old audits have no explicit marker: require actual reason
                -- clearing or a duration difference, never an Express-only edit.
                ((a.data #> '{detail,previous}') ? 'productionTimeReviewReasons'
                  AND a.data #> '{detail,previous,productionTimeReviewReasons}' <> '[]'::jsonb)
                OR EXISTS (SELECT 1 FROM unnest(ARRAY['turnaroundMode','turnaroundDays','turnaroundMinutes',
                  'turnaroundHours','minimumTurnaroundDays','minimumTurnaroundMinutes','minimumTurnaroundHours']) AS f(field)
                  WHERE (a.data #> '{detail,previous}') ? f.field AND (a.data #> '{detail,current}') ? f.field
                    AND a.data #> ARRAY['detail','previous',f.field]
                      IS DISTINCT FROM a.data #> ARRAY['detail','current',f.field])
              )))) AS confirmed,
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
        -- Preserve ambiguous existing reminders when provenance cannot disprove them.
        ELSE production_time_review_reasons END AS reasons
      FROM evidence
    )
    UPDATE supplier_catalog_items i SET production_time_review_reasons = d.reasons, version = i.version + 1
    FROM decisions d WHERE d.id = i.id AND i.production_time_review_reasons IS DISTINCT FROM d.reasons;
  `);
}

export async function down() { throw new Error('Production-time review evidence requires a forward migration'); }
