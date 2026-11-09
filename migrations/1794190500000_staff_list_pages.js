/** Opt-in staff keyset pages. Each build is a separate autocommit statement. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS staff_profiles_page_idx
    ON staff_profiles ((date_trunc('milliseconds', updated_at AT TIME ZONE 'UTC')) DESC, user_id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS staff_invites_page_idx
    ON staff_invites ((date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS staff_roles_page_idx ON staff_roles (code COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS voucher_campaigns_page_idx
    ON voucher_campaigns ((date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS vouchers_client_page_idx
    ON vouchers (client_id, (date_trunc('milliseconds', issued_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS vouchers_client_status_page_idx
    ON vouchers (client_id, status, (date_trunc('milliseconds', issued_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS vouchers_client_expiry_idx
    ON vouchers (client_id, status, (date_trunc('milliseconds', expires_at AT TIME ZONE 'UTC')));`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_hub_escalation_page_idx
    ON orders (position, id COLLATE "C") WHERE data#>'{handover,escalation}' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_hub_unclaimed_page_idx
    ON orders (position, id COLLATE "C") WHERE state='awaiting_collection' AND data#>>'{handover,qrToken}' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS production_lapses_page_idx
    ON production_lapses (supplier_id, (date_trunc('milliseconds', detected_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_services_page_idx ON supplier_services (position, id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_services_owner_page_idx ON supplier_services (supplier_id, position, id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_services_state_page_idx ON supplier_services (state, position, id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_services_owner_state_page_idx ON supplier_services (supplier_id, state, position, id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_profiles_page_idx ON supplier_profiles (user_id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_reschedule_page_idx
    ON orders (((data#>>'{rescheduleRequest,requestedAt}') COLLATE "C") DESC, id COLLATE "C" DESC) WHERE data->'rescheduleRequest' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_reschedule_filter_page_idx
    ON orders ((data#>>'{rescheduleRequest,supplierId}'), (data#>>'{rescheduleRequest,status}'), ((data#>>'{rescheduleRequest,requestedAt}') COLLATE "C") DESC, id COLLATE "C" DESC) WHERE data->'rescheduleRequest' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_reschedule_supplier_page_idx
    ON orders ((data#>>'{rescheduleRequest,supplierId}'), ((data#>>'{rescheduleRequest,requestedAt}') COLLATE "C") DESC, id COLLATE "C" DESC) WHERE data->'rescheduleRequest' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_reschedule_status_page_idx
    ON orders ((data#>>'{rescheduleRequest,status}'), ((data#>>'{rescheduleRequest,requestedAt}') COLLATE "C") DESC, id COLLATE "C" DESC) WHERE data->'rescheduleRequest' IS NOT NULL;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_reschedule_count_idx
    ON orders (review_data, id)
    WHERE data->'rescheduleRequest' IS NOT NULL AND data->'rescheduleRequest' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS refund_requests_page_idx ON refund_requests (id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS refund_requests_status_page_idx ON refund_requests (status, id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS refund_requests_client_page_idx ON refund_requests (client_id, id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS users_page_idx ON users (id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS memberships_role_page_idx ON user_role_memberships (role, user_id COLLATE "C");`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS claims_page_idx
    ON claims ((date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS claims_status_page_idx
    ON claims (status, (date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS escalations_page_idx
    ON escalations ((date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS escalations_status_page_idx
    ON escalations (status, (date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS season_windows_page_idx ON season_windows (id COLLATE "C");`);
}
export async function down() { throw new Error('Forward migrations only'); }
