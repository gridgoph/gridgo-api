/** The pricing desk selects date ranges and monthly completion candidates. */
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_pricing_created_idx
    ON orders (created_at) WHERE NOT review_data;`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_pricing_completed_idx
    ON orders (updated_at) WHERE NOT review_data AND state IN ('completed','payout_released');`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_pricing_timeline_idx
    ON orders (id) WHERE NOT review_data
      AND data @? '$.timeline[*] ? (@.state == "completed" || @.state == "payout_released")';`);
}
export async function down() { throw new Error('Forward migrations only'); }
