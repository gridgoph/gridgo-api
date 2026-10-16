/** Keep past-readiness jobs and every plan-1 job on their published flow. */
export const up = pgm => pgm.sql(`
  UPDATE orders SET data = data || jsonb_build_object('shopHandoverVersion', CASE
    WHEN payout_plan_version = 2
      AND state NOT IN ('ready_for_dispatch','rider_assigned','picked_up','out_for_delivery','awaiting_collection','delivered','issue_window_open','completed','payout_released','cancelled')
      AND ready_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'timeline','[]'::jsonb)) event
        WHERE event->>'state' IN ('ready_for_dispatch','rider_assigned','picked_up','out_for_delivery','awaiting_collection','delivered','issue_window_open','completed','payout_released'))
    THEN 2 ELSE 1 END);
`);
export const down = () => { throw new Error('Forward-only handover compatibility snapshot'); };
