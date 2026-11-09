/** Only finished, promised orders participate in ranking clock summaries. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ranking_finished_orders_idx ON orders (supplier_id)
    WHERE ready_by IS NOT NULL AND (ready_at IS NOT NULL OR data#>'{shopHandover,finished}' IS NOT NULL);`);
}
export async function down() {
  throw new Error("Forward migrations only");
}
