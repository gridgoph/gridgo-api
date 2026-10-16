import { identityHasMembership } from './authorization-context.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
export const withAuditRequest = (req, callback) => context.run({ req, actor: null }, callback);
export function setAuditActor(actor) { if (context.getStore()) context.getStore().actor = actor; }

// Audit evidence is a business projection, never a copy of request bodies or files.
// Defense in depth also applies to the legacy detail objects supplied by writers.
const PRIVATE_KEY = /token|secret|password|authorization|cookie|clerkUserId|sessionId|objectKey|downloadUrl|uploadUrl|signedUrl|otp|credential|qrPayload|qrToken|inviteCode|codeHash|email|phone|address|documents?|permit|license|licence|birth|guardian|signature|artworkLinks|artworkAttachments|bankAccount|accountNumber|^text$|^resolution$|^details$|^bytes$|^base64$/i;
export function safeAuditValue(value, depth = 0) {
  if (depth > 12) return '[omitted]';
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 4000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => safeAuditValue(item, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key))
    .map(([key, item]) => [key, safeAuditValue(item, depth + 1)]));
}
const pick = (record, fields) => record == null ? null : safeAuditValue(Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])));
const COMMON = ['id', 'userId', 'orderId', 'status', 'state', 'version', 'createdAt', 'updatedAt'];
const TARGETS = {
  supplier_profile: ['supplierProfiles', [...COMMON, 'schedule', 'isClosed']],
  order: ['orders', [...COMMON, 'clientId', 'supplierId', 'riderId', 'readyBy', 'promiseBy', 'fulfillmentMode', 'pickup', 'dropoff', 'fileCheck', 'pickupChecklist', 'supplierSubtotalMinor', 'serviceFeeMinor', 'deliveryFeeMinor', 'totalMinor', 'payments', 'payoutMilestones', 'payoutHold', 'claimHold', 'rescheduleRequest', 'shopRecovery', 'refund', 'productionDeductionMinor', 'physicalInvoiceRequest', 'dropoffConfirmation', 'deliveryPin']],
  user: ['users', [...COMMON, 'name', 'role', 'accountType', 'accountStatus', 'accountStatusReason', 'verificationStatus', 'shop']],
  claim: ['claims', [...COMMON, 'holdReason', 'reason', 'releaseReason']],
  issue: ['issues', [...COMMON, 'kind', 'category', 'claimId']],
  escalation: ['escalations', [...COMMON, 'type', 'reason']],
  refund_request: ['refundRequests', [...COMMON, 'kind', 'amountMinor', 'reason', 'settlementId']],
  supplier_invoice: ['supplierInvoices', [...COMMON, 'supplierId', 'period', 'amountMinor', 'invoiceNumber', 'submittedAt', 'collectedAt']],
  voucher: ['vouchers', [...COMMON, 'campaignId', 'clientId', 'valueMinor', 'expiresAt']],
  voucher_campaign: ['voucherCampaigns', [...COMMON, 'name', 'purpose', 'mode', 'valueMinor', 'totalLimit', 'perAccountLimit', 'endsAt']],
  file: ['files', ['fileId', 'purpose', 'state', 'ownerId']],
  supplier_service: ['supplierServices', [...COMMON, 'supplierId', 'categoryCode', 'referenceRateMinor', 'pricingBasis', 'standardTurnaroundHours']],
  approval_case: ['approvalCases', [...COMMON, 'kind', 'decidedAt', 'decidedBy', 'decisionReason']],
  zone: ['zones', [...COMMON, 'name', 'feeMinor', 'minKm', 'maxKm']],
  season_window: ['seasonWindows', [...COMMON, 'name', 'startDate', 'endDate', 'demandLevel']],
  staff: ['staffProfiles', [...COMMON, 'roleCode', 'active']],
  staff_invite: ['staffInvites', [...COMMON, 'roleCode', 'createdBy', 'expiresAt', 'redeemedBy', 'redeemedAt', 'revokedAt']],
  basket: ['baskets', [...COMMON, 'clientId', 'totalMinor', 'payment']],
};
export function auditSnapshot(store, type, id) {
  if (!store) return null;
  if (type === 'settings') return safeAuditValue(store.settings);
  if (type === 'credits') return { balanceMinor: store.credits?.[id]?.balanceMinor || 0 };
  const target = TARGETS[type];
  if (!target) return null;
  const row = (store[target[0]] || []).find(item => (item.id ?? item.fileId ?? item.userId) === id);
  if (type === 'staff' && !row) return auditSnapshot(store, 'staff_invite', id) ?? pick((store.staffRoles || []).find(role => role.code === id), ['code', 'name', 'canHandout']);
  const snapshot = pick(row, target[1]);
  if (type === 'order' && snapshot?.deliveryPin) delete snapshot.deliveryPin.pricing;
  if (type === 'refund_request' && snapshot) {
    snapshot.settlements = (store.refundSettlements || []).filter(item => item.requestId === id).map(item => pick(item,
      ['id', 'sequence', 'disposition', 'shopEntitlementMinor', 'riderEntitlementMinor', 'principalMinor', 'feeMinor', 'deliveryMinor', 'totalMinor']));
    snapshot.attempts = (store.refundAttempts || []).filter(item => item.requestId === id).map(item => pick(item, ['id', 'status', 'amountMinor', 'provider']));
    snapshot.payments = (store.refundPayments || []).filter(item => item.requestId === id).map(item => pick(item, ['id', 'amountMinor', 'paidAt']));
  }
  return snapshot;
}
function sourceContext() {
  const req = context.getStore()?.req;
  if (!req) return { app: 'system', device: null };
  const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : null;
  return { app: clean(req.headers['x-gridgo-app']) || clean(req.headers.origin) || 'api', device: clean(req.headers['user-agent']) };
}
export function appendAudit(store, { actor, action, entityType, entityId, orderId, detail, reason, before, after }, { id = () => `aud_${randomUUID()}`, at = new Date().toISOString() } = {}) {
  const entry = { id: id('aud'), at, actorId: actor?.role === 'system' ? null : actor?.id || null,
    actorRole: actor?.role || 'system', actorName: actor?.name || (actor?.role === 'system' || !actor ? 'System' : null),
    action, entityType: entityType || null, entityId: entityId || null, orderId: orderId || null,
    detail: detail ?? null, reason: reason ?? null, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...sourceContext() };
  (store.auditLog ||= []).push(entry);
  return entry;
}

/** Fill only new entries, immediately before persistence, including non-HTTP writers. */
export function finalizeAuditEntries(store, baseline) {
  const oldIds = new Set((baseline?.auditLog || []).map(row => row.id));
  for (const entry of store.auditLog || []) {
    if (oldIds.has(entry.id)) continue;
    const actor = store.users?.find(user => user.id === entry.actorId) || baseline?.users?.find(user => user.id === entry.actorId);
    const active = context.getStore()?.actor;
    entry.actorName ||= actor?.name || (entry.actorId ? null : 'System');
    entry.actorRole ||= active?.id === entry.actorId ? active.role : actor?.role || 'system';
    const source = sourceContext();
    entry.app ??= source.app;
    entry.device ??= source.device;
    entry.orderId ||= entry.entityType === 'order' ? entry.entityId : entry.detail?.orderId || null;
    if (!entry.orderId) {
      const target = TARGETS[entry.entityType];
      entry.orderId = target ? (store[target[0]] || []).find(row => row.id === entry.entityId)?.orderId || null : null;
    }
    entry.before = safeAuditValue(entry.before !== undefined ? entry.before : entry.detail?.previous ?? entry.detail?.before ?? auditSnapshot(baseline, entry.entityType, entry.entityId) ?? entry.detail?.from ?? null);
    entry.after = safeAuditValue(entry.after !== undefined ? entry.after : entry.detail?.current ?? entry.detail?.after ?? auditSnapshot(store, entry.entityType, entry.entityId) ?? entry.detail?.to ?? null);
    entry.detail = safeAuditValue(entry.detail);
    entry.reason = safeAuditValue(entry.reason ?? entry.detail?.reason ?? null);
    const file = entry.entityType === 'file' ? (store.files || []).find(row => row.fileId === entry.entityId) : null;
    const orderIds = entry.entityType === 'basket'
      ? (store.baskets || []).find(row => row.id === entry.entityId)?.orderIds || entry.detail?.orderIds
      : file ? (file.references || []).filter(ref => ref.type === 'order').map(ref => ref.id) : null;
    if (Array.isArray(orderIds)) entry.orderIds = [...new Set(orderIds.filter(value => typeof value === 'string'))];
  }
}

/** Missing lifecycle records; existing purpose-specific audit actions remain intact. */
export function deriveMissingAudit(store, baseline) {
  if (!baseline) return;
  const actor = context.getStore()?.actor || { role: 'system', name: 'System' };
  const requestReason = context.getStore()?.req?.gridgoParsedBody?.reason;
  const reason = typeof requestReason === 'string' ? requestReason.trim() : null;
  const priorOrders = new Map((baseline.orders || []).map(row => [row.id, row]));
  for (const order of store.orders || []) {
    const prior = priorOrders.get(order.id);
    if (!prior || prior.state !== order.state) appendAudit(store, { actor,
      action: !prior ? 'order.created' : 'order.transition', entityType: 'order', entityId: order.id, orderId: order.id,
      reason: reason || (order.state === 'cancelled' ? order.cancellationReason : null) || order.timeline?.at(-1)?.note || null,
      before: prior ? { state: prior.state } : null, after: prior ? { state: order.state } : auditSnapshot(store, 'order', order.id) });
    if (prior && prior.supplierId !== order.supplierId) appendAudit(store, { actor, action: 'order.supplier_changed', entityType: 'order', entityId: order.id, reason,
      before: { supplierId: prior.supplierId ?? null }, after: { supplierId: order.supplierId ?? null } });
    if (prior && prior.riderId !== order.riderId) appendAudit(store, { actor, action: 'order.rider_assigned', entityType: 'order', entityId: order.id, reason,
      before: { riderId: prior.riderId ?? null }, after: { riderId: order.riderId ?? null } });
  }
  const priorUsers = new Set((baseline.users || []).map(row => row.id));
  const currentUsers = new Set((store.users || []).map(row => row.id));
  for (const user of store.users || []) if (!priorUsers.has(user.id)) {
    appendAudit(store, { actor: actor.id ? actor : user, action: 'user.created', entityType: 'user', entityId: user.id });
  }
  for (const user of baseline.users || []) if (!currentUsers.has(user.id)) {
    appendAudit(store, { actor, action: 'user.deleted', entityType: 'user', entityId: user.id });
  }
}

const OPERATIONAL_ACTIONS = ['order.production_override', 'order.transition_refused', 'file.early_delete', 'file.retention_delete'];
const fail = code => { throw Object.assign(new Error(code), { status: 400, code }); };
const csvCell = value => {
  let cell = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
};
export async function readAudit(database, user, params, scopedOrderId = null) {
  const superAdmin = identityHasMembership(user, 'super_admin');
  if (!superAdmin && !identityHasMembership(user, 'ops_admin')) return { status: 403, body: { error: 'forbidden' } };
  const action = params.get('action'), entityType = params.get('entityType'), entityId = params.get('entityId');
  if (!superAdmin && !scopedOrderId && !OPERATIONAL_ACTIONS.includes(action) && !(entityType === 'file' && entityId?.trim())) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const format = params.get('format') || 'json';
  if (!['json', 'csv'].includes(format)) fail('invalid_audit_format');
  const integer = (name, fallback, maximum) => {
    const raw = params.get(name);
    if (raw != null && !/^\d+$/.test(raw)) fail(`invalid_${name}`);
    const value = raw == null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0) || value > maximum) fail(`invalid_${name}`);
    return value;
  };
  const limit = integer('limit', 100, format === 'csv' ? 5000 : 500), offset = integer('offset', 0, 10000000);
  const clauses = [], values = [];
  const add = (sql, value) => { values.push(value); clauses.push(sql.replaceAll('?', `$${values.length}`)); };
  for (const [key, column, value] of [['action', 'action', action], ['entityType', 'entity_type', entityType], ['entityId', 'entity_id', entityId],
    ['orderId', 'order_id', scopedOrderId || params.get('orderId')], ['actorId', 'actor_id', params.get('actorId')]]) {
    if (value) { if (value.length > 200) fail(`invalid_${key}`); add(key === 'orderId' ? "(order_id = ? OR data->'orderIds' @> jsonb_build_array(?::text))" : `${column} = ?`, value); }
  }
  if (scopedOrderId && params.has('orderId') && params.get('orderId') !== scopedOrderId) fail('audit_order_mismatch');
  // Operations' order tab contains only the already permitted correction/deletion scopes.
  if (!superAdmin && scopedOrderId) add('action = ANY(?::text[])', OPERATIONAL_ACTIONS);
  for (const [key, sql] of [['person', "(actor_id ILIKE ? ESCAPE '\\' OR data->>'actorName' ILIKE ? ESCAPE '\\')"],
    ['q', "(action ILIKE ? ESCAPE '\\' OR entity_id ILIKE ? ESCAPE '\\' OR order_id ILIKE ? ESCAPE '\\' OR data->>'actorName' ILIKE ? ESCAPE '\\' OR data->>'reason' ILIKE ? ESCAPE '\\')"]]) {
    const value = params.get(key)?.trim();
    if (value) { if (value.length > 200) fail(`invalid_${key}`); add(sql, `%${value.replace(/[\\%_]/g, '\\$&')}%`); }
  }
  const dates = {};
  for (const [key, op] of [['from', '>='], ['to', '<=']]) {
    const raw = params.get(key);
    if (raw == null) continue;
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(raw) || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw.slice(0, 10)) fail(`invalid_${key}`);
    dates[key] = raw.length === 10 ? `${raw}T${key === 'to' ? '23:59:59.999' : '00:00:00.000'}Z` : raw;
    add(`at ${op} ?::timestamptz`, dates[key]);
  }
  if (dates.from && dates.to && Date.parse(dates.from) > Date.parse(dates.to)) fail('invalid_date_range');
  const rows = (await database.query(`SELECT * FROM audit_log ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit + 1, offset])).rows;
  const entries = rows.slice(0, limit).map(row => ({ ...safeAuditValue(row.data), id: row.id, at: row.at, actorId: row.actor_id,
    actorRole: row.actor_role, actorName: row.data.actorName ?? null, app: row.data.app ?? null, device: row.data.device ?? null,
    action: row.action, entityType: row.entity_type, entityId: row.entity_id, orderId: row.order_id,
    before: safeAuditValue(row.data.before), after: safeAuditValue(row.data.after), reason: row.data.reason ?? null }));
  const nextOffset = rows.length > limit ? offset + limit : null;
  if (format === 'csv') {
    const columns = ['id', 'at', 'actorId', 'actorName', 'actorRole', 'app', 'device', 'action', 'entityType', 'entityId', 'orderId', 'before', 'after', 'reason'];
    return { status: 200, csv: [columns.map(csvCell).join(','), ...entries.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n', nextOffset };
  }
  return { status: 200, body: { audit: entries, limit, offset, nextOffset } };
}
