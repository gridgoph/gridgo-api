/** Independent queue filters and the existing cross-order packed-arrival count. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS claims_status_idx ON claims (status);');
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_status_idx ON issues (status);');
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_client_idx ON issues (client_id);');
  pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS escalations_order_idx ON escalations (order_id);');
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_arrived_packed_idx
    ON orders USING gin ((data#>'{shopHandover,arrivedPacked}'))
    WHERE data#>'{shopHandover,arrivedPacked}' IS NOT NULL;`);
}
export async function down() { throw new Error('Forward migrations only'); }
