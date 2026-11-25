// Members and the perk ledger are priced synchronously, so they live in the
// domain store. List contacts and invite mail never do: see member-list.js.
const mappings = [
  ['organization_partners', 'organizationPartners', ['user_id'], { user_id: 'userId', label: 'label', status: 'status', partner_since: 'partnerSince', version: 'version', created_at: 'createdAt', updated_at: 'updatedAt', data: 'data' }],
  ['member_perk_settings', 'memberPerkSettings', ['id'], { id: 'id', organization_user_id: 'organizationUserId', enabled: 'enabled', amount_minor: 'amountMinor', max_orders_per_term: 'maxOrdersPerTerm', ends_at: 'endsAt', budget_cap_minor: 'budgetCapMinor', version: 'version', updated_at: 'updatedAt', updated_by: 'updatedBy' }],
  ['organization_memberships', 'organizationMemberships', ['id'], { id: 'id', organization_user_id: 'organizationUserId', client_id: 'clientId', status: 'status', source: 'source', term: 'term', term_ends_at: 'termEndsAt', member_since: 'memberSince', requested_at: 'requestedAt', version: 'version', created_at: 'createdAt', updated_at: 'updatedAt', data: 'data' }],
  ['member_perk_uses', 'memberPerkUses', ['id'], { id: 'id', membership_id: 'membershipId', organization_user_id: 'organizationUserId', client_id: 'clientId', term: 'term', amount_minor: 'amountMinor', status: 'status', created_at: 'createdAt', data: 'data' }],
];
export const memberTables = mappings.map(([name, , keys, fields]) => ({ name, keys, columns: Object.keys(fields) }));
export const emptyMemberStore = () => Object.fromEntries(mappings.map(([, collection]) => [collection, []]));
export function memberRows(store, rows) {
  for (const [table, collection, , fields] of mappings) rows[table] = (store[collection] || []).map(item =>
    Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? (js === 'data' ? {} : null)])));
}
export function loadMemberRows(store, rows) {
  for (const [table, collection, , fields] of mappings) store[collection] = (rows[table] || []).map(item =>
    Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
