/** Staff page ordering and assignment-scoped location history. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_staff_page_idx
    ON supplier_catalog_items ((date_trunc('milliseconds', updated_at AT TIME ZONE 'UTC')) DESC, id COLLATE "en-x-icu") WHERE quote_request_id IS NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_services_owner_idx ON supplier_services (supplier_id);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS location_pings_assignment_latest_idx
    ON location_pings (order_id, rider_id, at DESC, position);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS location_pings_received_samples_idx
    ON location_pings (order_id, rider_id, (data->>'receivedAt') COLLATE "en-x-icu" DESC, position DESC)
    WHERE data->>'receivedAt' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_reschedule_desk_idx
    ON orders ((data#>>'{rescheduleRequest,supplierId}')) WHERE data->'rescheduleRequest' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_hub_escalation_desk_idx
    ON orders (position) WHERE data#>'{handover,escalation}' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_hub_unclaimed_desk_idx
    ON orders (position) WHERE state='awaiting_collection' AND data#>>'{handover,qrToken}' IS NOT NULL;`);
}
export async function down() { throw new Error('Forward migrations only'); }
