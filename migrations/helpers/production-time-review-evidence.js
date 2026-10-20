// Frozen evidence predicate for scheduling release 2 migrations. The caller's
// `source` CTE supplies the listing plus standard_turnaround_hours.
export function correctionEvidence(inherits = "source.turnaround_mode = 'inherit'") {
  return `
  EXISTS (SELECT 1 FROM audit_log a
    WHERE a.action = 'production_time.correct_39853344'
      AND ((a.entity_type IN ('catalogItems', 'approvedCatalogItems') AND a.entity_id = source.id)
        OR ((${inherits}) AND a.entity_type = 'supplierServices'
          AND a.entity_id = source.supplier_service_id
          AND a.data #>> '{detail,duration,prefix}' =
            CASE WHEN source.standard_turnaround_hours IS NOT NULL THEN 'standardTurnaround' ELSE 'turnaround' END))
      AND CASE
        WHEN a.data #>> '{detail,duration,oldDays}' ~ '^[1-9][0-9]*$'
          THEN a.data #>> '{detail,duration,oldDays}' = '1'
        WHEN a.data #>> '{detail,duration,productionDayMinutes}' ~ '^[1-9][0-9]*$'
          AND a.data #>> '{detail,duration,oldMinutes}' ~ '^[1-9][0-9]*$'
          THEN (a.data #>> '{detail,duration,oldMinutes}')::numeric =
            (a.data #>> '{detail,duration,productionDayMinutes}')::numeric
        -- Older corrections did not record a divisor. Ask for confirmation;
        -- today's shop calendar cannot prove how many days oldMinutes meant.
        ELSE true
      END)
`;
}

export const productionTimeCorrectionEvidence = correctionEvidence();
