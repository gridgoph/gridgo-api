import { assertRefundWorkAllowed } from './refund-policy.js';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { publicHubPickup } from './hub-pickup.js';
import { paymentSettled, issueWindowExpiresAt, carriedToOffice } from './operational-model.js';
import { notifyOrderParties } from './client-order-notifications.js';
import { notifyAdmins } from './domain-events.js';
import { queueOrderInvalidate } from './notifications.js';
import { staffError as fail, staffAccess, activeAccount, hasMembership, routeStaffAccess } from './staff-access.js';

const READY_STATES = ['ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery'];
export const hubRecord = settings => ({ id: 'primary', name: 'GRIDGO pickup hub', ...publicHubPickup(settings) });

/** Mint once at the physical handover boundary, never on a read. */
export function prepareHandover(store, order, { at }) {
  if (store.settings.handoverOtpEnabled !== true || order.handover || !(carriedToOffice(order) ? order.state === 'awaiting_collection' : order.fulfillmentMode === 'delivery' && READY_STATES.includes(order.state))) return false;
  const hub = hubRecord(store.settings);
  const activeCodes = new Set((store.orders || []).filter(o => o.handover && !o.handover.consumedAt && !['cancelled', 'completed', 'payout_released'].includes(o.state)).map(o => o.handover.otp));
  if (activeCodes.size >= 1000000) fail(503, 'handover_codes_exhausted');
  let otp;
  do { otp = String(randomInt(0, 1000000)).padStart(6, '0'); } while (activeCodes.has(otp));
  order.handover = { version: 1, otp, createdAt: at,
    ...(carriedToOffice(order) ? { qrToken: randomBytes(32).toString('base64url'), hubId: hub.id, point: hub.point, schedule: hub.schedule,
      readyAt: order.awaitingCollectionAt || at, notifiedDays: [], missedDays: 0, operationsRequired: false } : {}) };
  return true;
}
export function verifyHandoverOtp(order, value) {
  const expected = order.handover?.otp;
  if (!expected) fail(409, 'handover_not_ready');
  if (order.handover.consumedAt) fail(409, 'handover_already_completed');
  const actual = typeof value === 'string' ? value : '';
  if (!/^\d{6}$/.test(actual) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    fail(409, 'handover_otp_mismatch', 'The codes do not match. Do not hand over the order; escalate to Operations.', { canEscalate: true, escalatePath: `/orders/${order.id}/handover/escalate` });
  }
}

// Refusals return a response so the transaction commits the retry budget.
export function checkHandoverAttempt(order, otp, at) {
  const h = order.handover;
  if (Date.parse(h?.retryAfter || '') > Date.parse(at)) return { status: 429, body: { error: 'handover_attempts_exceeded', retryAfter: h.retryAfter, canEscalate: true, escalatePath: `/orders/${order.id}/handover/escalate` }, mutated: true };
  if (h?.retryAfter) { h.failedAttempts = 0; delete h.retryAfter; }
  try { verifyHandoverOtp(order, otp); }
  catch (error) {
    if (error.code !== 'handover_otp_mismatch') throw error;
    h.failedAttempts = (h.failedAttempts || 0) + 1;
    if (h.failedAttempts >= 5) h.retryAfter = new Date(Date.parse(at) + 15 * 60000).toISOString();
    return { status: error.status, body: { error: error.code, message: error.message, ...error.details }, mutated: true };
  }
  return null;
}

/** Both the rider proof and hub scan use this event; payouts keep their existing Operations gates. */
export function completeHandover(store, order, { actor, at, id, note, fileId }) {
  order.state = 'delivered';
  order.timeline.push({ at, state: 'delivered', by: actor.id, note, ...(fileId ? { fileId } : {}) });
  if (order.handover) order.handover.consumedAt = at;
  order.issueWindowOpenedAt = at;
  order.issueWindowExpiresAt = issueWindowExpiresAt(at, store.settings.issueWindowHours);
  order.state = 'issue_window_open'; order.updatedAt = at;
  order.timeline.push({ at, state: 'issue_window_open', by: 'system', note: `Issue window opened for ${store.settings.issueWindowHours} hours` });
  notifyOrderParties(store, order, { createId: id, at });
  notifyAdmins(store, 'handover_completed', 'Order handed over', order, `handover:${order.id}`, { createId: id, at });
  queueOrderInvalidate(store, order, ['orders', 'jobs']);
}
function clientNotice(store, order, type, body, at, id) {
  store.notifications.push({ id: id('ntf'), userId: order.clientId, appRole: 'client', orderId: order.id, type, title: 'Pickup at GRIDGO', body, read: false, at });
  notifyAdmins(store, `ops_${type}`, 'Hub pickup reminder', order, `${type}:${order.id}:${order.handover.missedDays}`, { createId: id, at });
}
export function sweepHubReminders(store, { at, id }) {
  let changed = false;
  for (const order of store.orders || []) {
    const h = order.handover;
    if (order.state !== 'awaiting_collection' || !h?.qrToken || h.consumedAt) continue;
    const schedule = h.schedule;
    const readyMs = Date.parse(h.readyAt), nowMs = Date.parse(at);
    if (nowMs < readyMs) continue;
    if (!h.readyNotifiedAt) {
      const alreadyNotified = store.notifications.some(n => n.orderId === order.id && n.userId === order.clientId && n.type === 'order_ready_for_pickup');
      if (!alreadyNotified) clientNotice(store, order, 'hub_ready', schedule
        ? 'Your order is ready. Bring its QR and matching code during hub hours.'
        : 'Your order is ready. Collection hours are not set yet. Contact Operations to arrange pickup.', at, id);
      h.readyNotifiedAt = at; changed = true;
    }
    if (!schedule) {
      if (changed) queueOrderInvalidate(store, order, ['orders']);
      continue;
    }
    const offset = schedule.utcOffsetMinutes * 60000;
    const first = Date.parse(new Date(readyMs + offset).toISOString().slice(0, 10) + 'T00:00:00Z');
    const last = Date.parse(new Date(nowMs + offset).toISOString().slice(0, 10) + 'T00:00:00Z');
    for (let day = first; day <= last; day += 86400000) {
      const date = new Date(day), key = date.toISOString().slice(0, 10);
      if (h.notifiedDays.includes(key) || (schedule.closures || []).some(c => key >= c.startDay && key <= c.endDay)) continue;
      const windows = schedule.week.filter(w => w.weekday === date.getUTCDay());
      if (!windows.length) continue;
      const close = day + Math.max(...windows.map(w => w.closesMinute)) * 60000 - offset;
      if (close <= readyMs || close > nowMs) continue;
      h.notifiedDays.push(key); h.missedDays++;
      clientNotice(store, order, h.missedDays >= 2 ? 'hub_unclaimed_warning' : 'hub_unclaimed_reminder',
        h.missedDays >= 3 ? 'Three hub days missed. Contact Operations or request redelivery at your own cost. Your order is not forfeited.'
          : h.missedDays === 2 ? 'Two hub days missed. Please collect your order on the next hub day.' : 'Your order is still waiting at the hub. Bring its QR and matching code.', at, id);
      if (h.missedDays >= 3 && !h.operationsRequired) {
        h.operationsRequired = true;
        notifyAdmins(store, 'hub_unclaimed_escalated', 'Unclaimed pickup needs Operations', order, `hub-unclaimed:${order.id}`, { createId: id, at });
        store.auditLog.push({ id: id('aud'), at, actorId: null, actorRole: 'system', action: 'hub.unclaimed_escalated', entityType: 'order', entityId: order.id, orderId: order.id, detail: { missedDays: h.missedDays } });
      }
      changed = true;
    }
    if (changed) queueOrderInvalidate(store, order, ['orders']);
  }
  return changed;
}
const ops = (store, user) => hasMembership(store, user, 'ops_admin') || hasMembership(store, user, 'super_admin');
const summary = order => ({ orderId: order.id, state: order.state, readyAt: order.handover?.readyAt, missedDays: order.handover?.missedDays || 0,
  operationsRequired: Boolean(order.handover?.operationsRequired), redeliveryRequest: order.handover?.redeliveryRequest || null });
const SOP = ['Wear GRIDGO identification during hub hours.', 'Scan the client QR and verify the matching OTP before handover.', 'On a mismatch, stop and escalate to Operations.', 'Check the package and record each handout under your own account.', 'Do not discuss shop pricing, solicit clients, or share supplier contacts.'];

export async function routeHubHandover(context) {
  const staffResponse = await routeStaffAccess(context);
  if (staffResponse) return staffResponse;
  const { req, url, store, user, readBody, now, id, audit } = context;
  const path = url.pathname, match = path.match(/^\/orders\/([^/]+)\/(handover(?:\/escalate)?|hub-redelivery)$/);
  if (!match && !path.startsWith('/staff/hub') && !path.startsWith('/ops/hub')) return null;
  if (!user) fail(401, 'unauthorized');
  if (!activeAccount(user)) fail(403, 'forbidden');
  const staff = staffAccess(store, user), isOps = ops(store, user), at = now();
  if (path.startsWith('/staff/hub') && !staff) fail(403, 'forbidden');
  if (path.startsWith('/ops/hub') && !isOps) fail(403, 'forbidden');
  if (req.method === 'GET' && ['/staff/hub', '/ops/hub'].includes(path)) return { status: 200, body: { hub: hubRecord(store.settings), sop: SOP } };
  if (req.method === 'GET' && path === '/ops/hub/receipt-scans') {
    const month = url.searchParams.get('month');
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(400, 'invalid_month');
    const supplierId = url.searchParams.get('supplierId');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const before = url.searchParams.get('before');
    const rows = store.files.filter(f => f.purpose === 'supplier_invoice' && f.state === 'ready'
      && (!supplierId || f.ownerId === supplierId) && (!month || f.createdAt.startsWith(month)))
      .flatMap(f => (f.references || []).filter(r => r.type === 'order').map(r => ({ fileId: f.fileId, supplierId: f.ownerId, orderId: r.id, at: f.createdAt })))
      .filter(r => !before || `${r.at}|${r.fileId}` < before)
      .sort((a, b) => `${b.at}|${b.fileId}`.localeCompare(`${a.at}|${a.fileId}`)).slice(0, limit);
    return { status: 200, body: { scans: rows, nextCursor: rows.length === limit ? `${rows.at(-1).at}|${rows.at(-1).fileId}` : null } };
  }
  if (req.method === 'GET' && path === '/ops/hub/escalations') return { status: 200, body: { escalations: store.orders.filter(o => o.handover?.escalation).map(o => ({ ...summary(o), escalation: o.handover.escalation })) } };
  if (req.method === 'GET' && path === '/ops/hub/unclaimed') return { status: 200, body: { orders: store.orders.filter(o => o.state === 'awaiting_collection' && o.handover?.qrToken).map(summary) } };
  if (req.method === 'GET' && ['/staff/hub/handouts', '/ops/hub/handouts'].includes(path)) {
    const rows = (store.hubHandouts || []).filter(r => path.startsWith('/ops/') || r.staffId === user.id);
    const staffTotals = Object.values(rows.reduce((all, row) => { const entry = all[row.staffId] ||= { staffId: row.staffId, name: row.staffName, count: 0 }; entry.count++; return all; }, {}));
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const before = url.searchParams.get('before');
    const handouts = rows.filter(r => !before || `${r.at}|${r.id}` < before).sort((a, b) => `${b.at}|${b.id}`.localeCompare(`${a.at}|${a.id}`)).slice(0, limit);
    return { status: 200, body: { handouts, staffTotals, nextCursor: handouts.length === limit ? `${handouts.at(-1).at}|${handouts.at(-1).id}` : null } };
  }
  if (req.method === 'POST' && path === '/staff/hub/claims') {
    if (!staff.canHandout) fail(403, 'forbidden');
    const body = await readBody(req);
    const order = store.orders.find(o => typeof body.qrToken === 'string' && o.handover?.qrToken === body.qrToken);
    if (!order) fail(404, 'claim_not_found');
    if (order.handover?.consumedAt) fail(409, 'handover_already_completed');
    const denied = checkHandoverAttempt(order, body.otp, at);
    if (denied) return denied;
    assertRefundWorkAllowed(store, order);
    if (!carriedToOffice(order) || order.state !== 'awaiting_collection') fail(409, 'collection_not_available');
    if (!paymentSettled(order.payments?.final_online)) fail(409, 'final_payment_not_confirmed');
    const handout = { id: id('handout'), orderId: order.id, staffId: user.id, staffName: user.name, hubId: order.handover.hubId, at };
    store.hubHandouts.push(handout);
    order.collection = { receivedBy: 'Verified QR and OTP holder', recordedBy: user.id, at, handoutId: handout.id };
    completeHandover(store, order, { actor: user, at, id, note: 'Collected at GRIDGO hub with matching QR and OTP' });
    audit(store, { actor: user, action: 'hub.order_claimed', entityType: 'order', entityId: order.id, orderId: order.id, detail: { handoutId: handout.id } });
    return { status: 200, body: { handout, order: summary(order) }, mutated: true };
  }
  if (match) {
    const order = store.orders.find(o => o.id === match[1]);
    if (!order) fail(404, 'order_not_found');
    const client = hasMembership(store, user, 'client') && order.clientId === user.id;
    const rider = hasMembership(store, user, 'rider') && order.riderId === user.id;
    const h = order.handover;
    if (match[2] === 'handover' && req.method === 'GET') {
      if (!client && !(rider && order.fulfillmentMode === 'delivery')) fail(403, 'forbidden');
      const available = h && !h.consumedAt && (carriedToOffice(order) ? order.state === 'awaiting_collection' : READY_STATES.includes(order.state));
      return { status: 200, body: { handover: available ? { otp: h.otp, ...(client && h.qrToken ? { qrToken: h.qrToken, hub: { id: h.hubId, point: h.point, schedule: h.schedule }, ...summary(order) } : {}) } : null } };
    }
    if (match[2] === 'handover/escalate' && req.method === 'POST') {
      if (!client && !rider && !staff?.canHandout) fail(403, 'forbidden');
      const body = await readBody(req);
      if (staff?.canHandout && !client && !rider && (!h?.qrToken || body.qrToken !== h.qrToken)) fail(403, 'forbidden');
      if (!h || h.consumedAt || !['awaiting_collection', ...READY_STATES].includes(order.state)) fail(409, 'handover_not_ready');
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) fail(400, 'reason_required');
      if (!h.escalation) {
        h.escalation = { by: user.id, at, reason: body.reason.trim() };
        notifyAdmins(store, 'handover_escalated', 'Handover code mismatch needs Operations', order, `handover-mismatch:${order.id}`, { createId: id, at });
        audit(store, { actor: user, action: 'handover.escalated', entityType: 'order', entityId: order.id, orderId: order.id, detail: { reason: h.escalation.reason } });
        queueOrderInvalidate(store, order, ['orders', 'escalations']);
      }
      return { status: 200, body: { escalated: true }, mutated: true };
    }
    if (match[2] === 'hub-redelivery' && req.method === 'POST') {
      if (!client) fail(403, 'forbidden');
      if (!h?.operationsRequired || order.state !== 'awaiting_collection') fail(409, 'redelivery_not_available');
      const body = await readBody(req);
      if (body.costAccepted !== true) fail(400, 'redelivery_cost_acceptance_required');
      if (!h.redeliveryRequest) {
        h.redeliveryRequest = { status: 'pending_operations', costAccepted: true, at, by: user.id };
        notifyAdmins(store, 'hub_redelivery_requested', 'Client requests paid redelivery', order, `hub-redelivery:${order.id}`, { createId: id, at });
        audit(store, { actor: user, action: 'hub.redelivery_requested', entityType: 'order', entityId: order.id, orderId: order.id, detail: { costAccepted: true } });
        queueOrderInvalidate(store, order, ['orders']);
      }
      return { status: 200, body: { request: h.redeliveryRequest }, mutated: true };
    }
  }
  return { status: 404, body: { error: 'not_found' } };
}
