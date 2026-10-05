// Explicit relational mappings for the invite and handout ledger.
const mappings = [
  ['staff_roles', 'staffRoles', ['code'], { code: 'code', name: 'name', can_handout: 'canHandout' }],
  ['staff_profiles', 'staffProfiles', ['user_id'], { user_id: 'userId', role_code: 'roleCode', active: 'active', updated_at: 'updatedAt' }],
  ['staff_invites', 'staffInvites', ['id'], { id: 'id', code_hash: 'codeHash', role_code: 'roleCode', created_by: 'createdBy', created_at: 'createdAt', expires_at: 'expiresAt', redeemed_by: 'redeemedBy', redeemed_at: 'redeemedAt', revoked_at: 'revokedAt' }],
  ['hub_handouts', 'hubHandouts', ['id'], { id: 'id', order_id: 'orderId', staff_id: 'staffId', staff_name: 'staffName', hub_id: 'hubId', at: 'at' }],
];
export const staffTables = mappings.map(([name, , keys, fields]) => ({ name, keys, columns: Object.keys(fields), ...(name === 'hub_handouts' ? { appendOnly: true } : {}) }));
export const emptyStaffStore = () => ({ staffRoles: [{ code: 'hub_staff', name: 'Hub staff', canHandout: true }], staffProfiles: [], staffInvites: [], hubHandouts: [] });
export function staffRows(store, rows) {
  for (const [table, collection, , fields] of mappings) rows[table] = (store[collection] || []).map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? null])));
}
export function loadStaffRows(store, rows) {
  for (const [table, collection, , fields] of mappings) store[collection] = rows[table].map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
