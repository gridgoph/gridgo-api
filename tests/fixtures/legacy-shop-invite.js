// Frozen shop_invites mapping and upsert from f6caaed4d25aa2a3dca15b147f082104ed40b8f7
// (src/shop-team-store.js and src/postgres-store.js). Keep lifetime_hours omitted.
const fields = { id: 'id', shop_id: 'shopId', kind: 'kind', identity: 'identity', token_hash: 'tokenHash', created_by: 'createdBy', created_at: 'createdAt', expires_at: 'expiresAt', claimed_by: 'claimedBy', claimed_at: 'claimedAt', revoked_at: 'revokedAt' };
const table = { name: 'shop_invites', keys: ['id'], columns: Object.keys(fields) };

export async function legacyInviteUpsert(database, item) {
  const row = Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? null]));
  const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(', ');
  const updatable = table.columns.filter(column => !table.keys.includes(column));
  const updates = updatable.map(column => `${column} = EXCLUDED.${column}`).join(', ');
  await database.query(
    `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${table.keys.join(', ')}) DO UPDATE SET ${updates}`,
    table.columns.map(column => row[column]),
  );
}
