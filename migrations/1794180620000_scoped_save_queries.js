export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_save_reference_idx
    ON order_payments (upper(btrim(data->>'reference'))) WHERE status='confirmed';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_save_proof_idx
    ON order_payments ((data->>'proofFileId')) WHERE status='confirmed';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_save_unusual_idx
    ON order_payments (order_id) WHERE status='confirmed' AND (data->>'reference') ~ '[^ -~]';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS pin_save_reference_idx
    ON delivery_pin_payments (upper(btrim(reference)));`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS pin_save_unusual_idx
    ON delivery_pin_payments (order_id) WHERE reference ~ '[^ -~]';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_save_pending_pin_idx
    ON orders (position) WHERE data#>>'{deliveryPin,change,status}'='pending_confirmation';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS files_save_pending_colour_idx
    ON files (file_id) WHERE data @? '$.colourAnalyses[*] ? (@.status == "pending")';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_save_fault_idx
    ON issues (order_id) WHERE data#>>'{faultDecision,status}'='approved';`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_save_approved_family_idx
    ON supplier_catalog_items ((approved_snapshot#>>'{item,subcategoryCode}'));`);
}
export async function down() { throw new Error('Forward migrations only'); }
