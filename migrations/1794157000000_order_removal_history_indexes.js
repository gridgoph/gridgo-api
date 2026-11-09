/** Indexed containment across root/nested scalar and array order references. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_ledger_order_refs_idx
    ON credit_ledger USING gin (data jsonb_path_ops);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS voucher_reservations_order_refs_idx
    ON voucher_reservations USING gin (data jsonb_path_ops);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS voucher_redemptions_order_refs_idx
    ON voucher_redemptions USING gin (data jsonb_path_ops);`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS voucher_ledger_order_refs_idx
    ON voucher_ledger USING gin (data jsonb_path_ops);`);
}
export async function down() { throw new Error('Forward migrations only'); }
