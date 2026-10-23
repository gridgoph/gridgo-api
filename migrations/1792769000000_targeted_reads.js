/** Indexes for inbox pages, queue reads and idle-worker probes. */
export async function up(pgm) {
  pgm.sql(`
    CREATE INDEX notifications_inbox_page_idx ON notifications (user_id, created_at DESC, position ASC) WHERE deleted_at IS NULL;
    CREATE INDEX notifications_watermark_idx ON notifications (user_id, position DESC);
    CREATE INDEX product_type_requests_page_idx ON product_type_requests (id COLLATE "en-x-icu");
    CREATE INDEX product_type_requests_status_page_idx ON product_type_requests (status, id COLLATE "en-x-icu");
    CREATE INDEX colour_catalog_candidates_idx ON supplier_catalog_items (id) WHERE priced_by_colour OR approved_snapshot #> '{item,pricedByColour}' = 'true'::jsonb;
    CREATE INDEX draft_carts_candidates_idx ON client_carts (id) WHERE state = 'draft';
    CREATE INDEX cart_lines_catalog_cart_idx ON client_cart_lines (catalog_item_id, cart_id);
    CREATE INDEX catalog_reviews_page_idx ON supplier_catalog_items ((COALESCE(review_status, 'approved')), id COLLATE "en-x-icu");
    CREATE INDEX shop_failures_orders_idx ON orders (position) WHERE jsonb_array_length(CASE WHEN jsonb_typeof(data->'shopFailureEvents') = 'array' THEN data->'shopFailureEvents' ELSE '[]'::jsonb END) > 0;
    CREATE INDEX files_pending_colour_idx ON files (file_id) WHERE state = 'ready' AND COALESCE(data->>'deleteRequestedAt', '') = '' AND data @? '$.colourAnalyses[*] ? (@.status == "pending")';
    CREATE INDEX shop_acceptance_candidates_idx ON orders (supplier_id) WHERE state = 'supplier_assigned' AND supplier_id IS NOT NULL;
    CREATE INDEX notification_push_outbox_expiry_idx ON notification_push_outbox (expires_at) WHERE status IN ('pending','sending');
  `);
}
export async function down() { throw new Error('Forward migrations only'); }
