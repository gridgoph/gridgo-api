/** Close withdrawn shop work; do not alter the order's promise or money. */
export const up = pgm => pgm.sql(`
  WITH desired AS (
    SELECT job.id, parent.updated_at,
      CASE WHEN parent.data->'shopRecovery'->>'originalSupplierId' = job.supplier_id
             AND (parent.data->'shopRecovery'->>'status' IS DISTINCT FROM 'accepted'
                  OR parent.supplier_id IS DISTINCT FROM job.supplier_id)
           THEN 'cancelled'
           WHEN parent.state = 'payout_released' THEN 'completed'
           ELSE parent.state END AS state
      FROM order_jobs job JOIN orders parent ON parent.id = job.order_id
     WHERE parent.state IN ('picked_up', 'out_for_delivery', 'delivered', 'issue_window_open', 'completed', 'cancelled', 'payout_released')
        OR (parent.data->'shopRecovery'->>'originalSupplierId' = job.supplier_id
            AND (parent.data->'shopRecovery'->>'status' IS DISTINCT FROM 'accepted'
                 OR parent.supplier_id IS DISTINCT FROM job.supplier_id))
  )
  UPDATE order_jobs job SET state = desired.state, updated_at = desired.updated_at
    FROM desired WHERE job.id = desired.id
     AND job.state NOT IN ('completed', 'cancelled')
     AND job.state IS DISTINCT FROM desired.state;
`);
export const down = () => { throw new Error('Withdrawn work cannot be reopened by rollback.'); };
