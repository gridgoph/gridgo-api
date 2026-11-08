const mappings = [
  ['shop_memberships', 'shopMemberships', ['shop_id', 'user_id'], { shop_id: 'shopId', user_id: 'userId', role: 'role', status: 'status', created_at: 'createdAt', updated_at: 'updatedAt', decided_by: 'decidedBy' }],
  ['shop_invites', 'shopInvites', ['id'], { id: 'id', shop_id: 'shopId', kind: 'kind', identity: 'identity', token_hash: 'tokenHash', created_by: 'createdBy', created_at: 'createdAt', expires_at: 'expiresAt', claimed_by: 'claimedBy', claimed_at: 'claimedAt', revoked_at: 'revokedAt' }],
  ['order_actions', 'orderActions', ['id'], { id: 'id', order_id: 'orderId', actor_user_id: 'actorUserId', actor_name: 'actorName', actor_role: 'actorRole', action: 'action', at: 'at' }],
];
export const shopTeamTables = mappings.map(([name, , keys, fields]) => ({ name, keys, columns: Object.keys(fields), ...(name === 'order_actions' ? { appendOnly: true } : {}) }));
export const emptyShopTeam = () => ({ shopMemberships: [], shopInvites: [], orderActions: [] });
export function shopTeamRows(store, rows) {
  for (const [table, collection, , fields] of mappings) rows[table] = (store[collection] || []).map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? null])));
}
export function loadShopTeamRows(store, rows) {
  for (const [table, collection, , fields] of mappings) store[collection] = rows[table].map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
/** Also covers future supplier enrollments without changing their identity/session. */
export function ensureShopOwners(store) {
  store.shopMemberships ||= [];
  for (const membership of store.userRoleMemberships || []) {
    if (membership.role !== 'supplier' || store.shopMemberships.some(m => m.shopId === membership.userId && m.userId === membership.userId)) continue;
    store.shopMemberships.push({ shopId: membership.userId, userId: membership.userId, role: 'owner', status: 'active', createdAt: membership.createdAt, updatedAt: membership.createdAt });
  }
}
