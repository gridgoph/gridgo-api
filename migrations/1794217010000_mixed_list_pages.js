/** Each concurrent build runs as its own top-level autocommit statement. */
export async function up(pgm) {
  pgm.noTransaction();
  for (const [table, prefix, owners] of [
    [
      'orders',
      'orders',
      ['client_id', 'supplier_id', 'rider_id', 'review_data'],
    ],
    ['order_baskets', 'baskets', ['client_id']],
    ['issues', 'issues', ['client_id', 'order_id', 'status']],
    ['credit_ledger', 'credits', ['user_id']],
  ]) {
    const predicate = table === 'order_baskets' ? ' WHERE length(id) >= 0' : '';
    const key = `(date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id COLLATE "C" DESC`;
    pgm.sql(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${prefix}_mixed_page_idx ON ${table} (${key})${predicate};`
    );
    for (const owner of owners)
      pgm.sql(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${prefix}_${owner}_mixed_page_idx ON ${table} (${owner},${key})${predicate};`
      );
  }
}
export async function down() {
  throw new Error('Forward migrations only');
}
