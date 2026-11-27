const mappings = [
  ['shop_team_settings', 'shopTeamSettings', ['shop_id'], {shop_id:'shopId',jobs_handled_by:'jobsHandledBy',show_ranking_to_staff:'showRankingToStaff',updated_at:'updatedAt'}],
  ['shop_team_member_settings', 'shopTeamMemberSettings', ['shop_id','user_id'], {shop_id:'shopId',user_id:'userId',manager:'manager',job_alerts:'jobAlerts',photo_file_id:'photoFileId'}],
  ['shop_pin_staff', 'shopPinStaff', ['id'], {id:'id',shop_id:'shopId',name:'name',role:'role',status:'status',pin_hash:'pinHash',pin_version:'pinVersion',failed_attempts:'failedAttempts',blocked_until:'blockedUntil',job_alerts:'jobAlerts',photo_file_id:'photoFileId',created_at:'createdAt',updated_at:'updatedAt'}],
  ['shop_worker_sessions', 'shopWorkerSessions', ['shop_id','user_id','session_hash'], {shop_id:'shopId',user_id:'userId',session_hash:'sessionHash',pin_staff_id:'pinStaffId',pin_version:'pinVersion',token_hash:'tokenHash',expires_at:'expiresAt',failed_attempts:'failedAttempts',blocked_until:'blockedUntil',updated_at:'updatedAt'}],
  ['shop_memberships', 'shopMemberships', ['shop_id', 'user_id'], { shop_id: 'shopId', user_id: 'userId', role: 'role', status: 'status', created_at: 'createdAt', updated_at: 'updatedAt', decided_by: 'decidedBy', last_used_at: 'lastUsedAt' }],
  ['shop_invites', 'shopInvites', ['id'], { id: 'id', shop_id: 'shopId', kind: 'kind', identity: 'identity', token_hash: 'tokenHash', created_by: 'createdBy', created_at: 'createdAt', expires_at: 'expiresAt', claimed_by: 'claimedBy', claimed_at: 'claimedAt', revoked_at: 'revokedAt', lifetime_hours: 'lifetimeHours', join_role: 'joinRole', refresh_seconds: 'refreshSeconds' }],
  ['order_actions', 'orderActions', ['id'], { id: 'id', order_id: 'orderId', actor_user_id: 'actorUserId', actor_name: 'actorName', actor_role: 'actorRole', action: 'action', at: 'at', shop_id:'shopId', actor_pin_staff_id:'actorPinStaffId', acceptance_milliseconds:'acceptanceMilliseconds' }],
];
const writeOrder=['shop_memberships','shop_invites','shop_team_settings','shop_team_member_settings','shop_pin_staff','shop_worker_sessions','order_actions'];
export const shopTeamTables = [...mappings].sort((a,b)=>writeOrder.indexOf(a[0])-writeOrder.indexOf(b[0])).map(([name, , keys, fields]) => ({ name, keys, columns: Object.keys(fields), ...(name === 'order_actions' ? { appendOnly: true } : {}) }));
export const emptyShopTeam = () => Object.fromEntries(mappings.map(([,collection]) => [collection, []]));
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
