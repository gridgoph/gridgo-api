// Relational identity, limits, money and lifecycle; data contains bounded snapshots only.
const mappings = [
  ['promotion_settings', 'promotionSettings', { id: 'id', version: 'version', settings: 'settings' }],
  ['voucher_campaigns', 'voucherCampaigns', { id: 'id', name: 'name', purpose: 'purpose', code: 'code', mode: 'mode', status: 'status', covers_order_total: 'coversOrderTotal', value_minor: 'valueMinor', total_limit: 'totalLimit', per_account_limit: 'perAccountLimit', ends_at: 'endsAt', validity_days: 'validityDays', created_at: 'createdAt', updated_at: 'updatedAt' }],
  ['vouchers', 'vouchers', { id: 'id', campaign_id: 'campaignId', client_id: 'clientId', promotion_kind: 'promotionKind', status: 'status', value_minor: 'valueMinor', issued_at: 'issuedAt', expires_at: 'expiresAt', email_allowed: 'emailAllowed', data: 'data' }],
  ['voucher_reservations', 'voucherReservations', { id: 'id', voucher_id: 'voucherId', client_id: 'clientId', cart_id: 'cartId', status: 'status', expires_at: 'expiresAt', created_at: 'createdAt', data: 'data' }],
  ['voucher_redemptions', 'voucherRedemptions', { id: 'id', voucher_id: 'voucherId', reservation_id: 'reservationId', client_id: 'clientId', amount_minor: 'amountMinor', status: 'status', created_at: 'createdAt', data: 'data' }],
  ['voucher_ledger', 'voucherLedger', { id: 'id', voucher_id: 'voucherId', campaign_id: 'campaignId', client_id: 'clientId', kind: 'kind', amount_minor: 'amountMinor', at: 'at', data: 'data' }],
  ['voucher_code_attempts', 'voucherCodeAttempts', { id: 'id', window_at: 'windowAt', failures: 'failures', locked_until: 'lockedUntil' }],
  ['voucher_cart_choices', 'voucherCartChoices', { id: 'id', voucher_id: 'voucherId', removed: 'removed' }],
  ['voucher_email_outbox', 'voucherEmailOutbox', { id: 'id', voucher_id: 'voucherId', email: 'email', subject: 'subject', body: 'body', status: 'status', attempts: 'attempts', next_at: 'nextAt', created_at: 'createdAt' }],
  ['promotion_invites', 'promotionInvites', { id: 'id', founder_id: 'founderId', email: 'email', client_id: 'clientId', voucher_id: 'voucherId', status: 'status', created_at: 'createdAt', claimed_at: 'claimedAt', notified_at: 'notifiedAt', unmatched_reason: 'unmatchedReason' }],
];
export const voucherTables = mappings.map(([name, , fields]) => ({ name, keys: ['id'], columns: Object.keys(fields), ...(name === 'voucher_ledger' ? { appendOnly: true } : {}) }));
export const emptyVoucherStore = () => Object.fromEntries(mappings.map(([, collection]) => [collection, []]));
export function voucherRows(store, rows) {
  for (const [table, collection, fields] of mappings) rows[table] = (store[collection] || []).map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [sql, item[js] ?? (js === 'data' ? {} : js === 'purpose' ? 'manual' : js === 'coversOrderTotal' ? false : null)])));
}
export function loadVoucherRows(store, rows) {
  for (const [table, collection, fields] of mappings) store[collection] = rows[table].map(item => Object.fromEntries(Object.entries(fields).map(([sql, js]) => [js, item[sql]])));
}
