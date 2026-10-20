/** Repair stale compatibility jobs without touching order promises or money. */
export const up = pgm => pgm.sql(`
  UPDATE order_jobs AS job
     SET state = parent.state, updated_at = parent.updated_at
    FROM orders AS parent
   WHERE parent.id = job.order_id
     AND parent.state IN ('picked_up', 'out_for_delivery', 'delivered', 'issue_window_open', 'completed', 'cancelled')
     AND job.state NOT IN ('completed', 'cancelled')
     AND job.state IS DISTINCT FROM parent.state;
`);
export const down = () => { throw new Error('Job lifecycle backfill cannot be reversed safely.'); };
