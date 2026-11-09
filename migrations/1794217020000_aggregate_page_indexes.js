/** Separate concurrent builds, compatible with the deployment recovery runbook. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS performance_history_page_idx ON supplier_performance_events
    (supplier_id,(date_trunc('milliseconds',occurred_at AT TIME ZONE 'UTC')) DESC,id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS performance_no_fault_context_idx ON supplier_performance_events
    (supplier_id,order_id) WHERE kind='no_fault';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS promotion_invites_history_page_idx ON promotion_invites
    ((date_trunc('milliseconds',created_at AT TIME ZONE 'UTC')) DESC,id COLLATE "C" DESC);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS promotion_claims_history_page_idx ON vouchers
    ((date_trunc('milliseconds',issued_at AT TIME ZONE 'UTC')) DESC,id COLLATE "C" DESC)
    WHERE promotion_kind IN ('founding','friend_pass') AND (promotion_kind='founding' OR
      data->'upgradedAt' IS NOT NULL AND data->'upgradedAt' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb));`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ranking_review_totals_idx ON shop_reviews
    (supplier_id,order_id) INCLUDE (quality_stars,speed_stars,value_stars);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ranking_listing_prices_idx ON supplier_catalog_items
    (supplier_id,subcategory_code,base_price_minor) WHERE quote_request_id IS NULL;`);
}
export async function down() {
  throw new Error('Forward migrations only');
}
