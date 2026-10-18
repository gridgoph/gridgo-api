import { reportOrderAllowed } from './review-data.js';
import { identityHasMembership } from './authorization-context.js';
import { defaultShopSchedule } from './availability.js';
import { productionTiming } from './production-penalties.js';
import { privilegedAdminMemberships, hasRole, queueOrderInvalidate, queueInvalidate } from './notifications.js';
import { writeDraft } from './client-order-notifications.js';
import { performanceEnabled, performanceDeadline, performanceTier, performanceCounts, performanceExemption, performanceTopPick, consequences } from './supplier-performance-policy.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const pair = (row, other) => row.orderId === other.orderId && row.supplierId === other.supplierId;
const chronological = (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

function appendEvent(store, input, { at, id, actor = null }) {
  const rows = store.supplierPerformanceEvents ||= [];
  if (rows.some(row => pair(row, input) && row.sourceKey === input.sourceKey)) return false;
  const event = { ...input, id: id('performance'), recordedAt: at };
  rows.push(event);
  const exempt = event.exemption || performanceExemption(store, event);
  const effect = exempt ? { warnings: [], hideTopPick: false, rosterReview: false }
    : consequences(event.kind, performanceCounts(store, event.supplierId, event.at));
  event.warningCodes = effect.warnings;
  event.rosterReviewTriggered = effect.rosterReview;
  event.topPickHiddenUntil = effect.hideTopPick ? new Date(Date.parse(event.at) + 7 * 86400000).toISOString() : null;
  const reason = event.reason || event.kind;
  const body = event.kind === 'late_finish'
    ? `Order ${event.orderId}: finished ${Number((event.workingLateMs / 3600000).toFixed(2))} shop hours after the committed ready-by (${event.tier}). Reason: ${reason}. ${exempt ? 'This event is exempt from performance consequences. ' : ''}Warning only; no money is deducted.`
    : event.kind === 'no_fault' ? `Order ${event.orderId}: Super Admin recorded a no-fault event. Reason: ${reason}. This order is excluded from performance consequences.`
      : `Order ${event.orderId}: ${reason}. ${effect.warnings.join(', ').replaceAll('_', ' ')}. Warning only; no money is deducted.`;
  if (event.kind === 'late_finish' || event.kind === 'no_fault' || effect.warnings.length) {
    event.message = body;
    for (const recipient of [{ userId: event.supplierId, role: 'supplier' }, ...privilegedAdminMemberships(store)]) {
      writeDraft(store, { userId: recipient.userId, appRole: recipient.role, type: 'supplier_performance_notice',
        occurrenceKey: event.id, orderId: event.orderId, title: 'Shop performance notice', body, read: false }, { id: id('ntf'), at });
    }
  }
  (store.auditLog ||= []).push({ id: id('aud'), at, actorId: actor?.id || null, actorRole: actor ? 'super_admin' : 'system',
    action: `supplier_performance.${event.kind}`, entityType: 'order', entityId: event.orderId, orderId: event.orderId,
    detail: structuredClone(event), reason });
  const order = store.orders.find(row => row.id === event.orderId);
  if (order) queueOrderInvalidate(store, order, ['orders', 'jobs']);
  queueInvalidate(store, { resource: 'catalog', supplierId: event.supplierId, userIds: [event.supplierId] });
  return true;
}

/** Called only inside the domain transaction, before save/outbox delivery. */
export function syncSupplierPerformance(store, { at, id, clockStore = store }) {
  if (!performanceEnabled(store, at)) return false;
  const start = Date.parse(store.supplierPerformanceLaunchedAt);
  let changed = false;
  const pending = [];
  const collect = (event) => { if (Date.parse(event.at) >= start && Date.parse(event.at) <= Date.parse(at)) pending.push(event); };
  for (const order of store.orders || []) {
    if (order.supplierId && order.commercialCommittedAt && order.readyBy && order.state !== 'cancelled') {
      const existing = (store.supplierPerformanceEvents || []).some(row => row.orderId === order.id
        && row.supplierId === order.supplierId && row.sourceKey === 'finish');
      if (!existing && (!order.readyAt || Date.parse(order.readyAt) >= start)) {
        // Separate adoption clock for older active work; original dates and legacy clocks stay immutable.
        if (order.performanceClock?.supplierId !== order.supplierId) {
          order.performanceClock = { ...structuredClone(order.shopClock?.supplierId === order.supplierId ? order.shopClock : {
            supplierId: order.supplierId, schedule: clockStore.supplierProfiles?.find(row => row.userId === order.supplierId)?.schedule || defaultShopSchedule(),
          }), version: 1 };
          changed = true;
        }
        const deadlineAt = performanceDeadline(order);
        const timing = productionTiming({ ...order, readyBy: deadlineAt, shopClock: order.performanceClock }, at);
        if (timing.finishedAt && !timing.pendingReview && Number.isFinite(timing.elapsedMs)) {
          const tier = performanceTier(timing.elapsedMs);
          collect({ orderId: order.id, supplierId: order.supplierId, sourceKey: 'finish',
            kind: tier ? 'late_finish' : 'on_time_finish', at: timing.finishedAt, tier,
            deadlineAt, workingLateMs: Math.max(0, timing.elapsedMs), reviewWaitMs: timing.reviewWaitMs,
            graceMinutes: 60, reason: tier ? 'Finished after the committed ready-by and one-hour grace window.' : 'Finished within the committed ready-by and grace window.',
            exemption: order.productionTimeCorrection?.penaltyExempt ? 'reviewed_time_correction' : null });
        }
      }
    }
    for (const failure of order.shopFailureEvents || []) {
      // Cancellation before acceptance is a decline, never an accepted-order cancellation.
      const kind = failure.kind === 'cancelled' && failure.stage === 'supplier_assigned' ? 'declined' : failure.kind;
      collect({ orderId: order.id, supplierId: failure.supplierId, sourceKey: `failure:${failure.id}`, kind,
        at: failure.at, reason: failure.reason, reasonCode: failure.reasonCode || null });
    }
    for (const packed of order.shopHandover?.arrivedPacked || []) {
      collect({ orderId: order.id, supplierId: packed.supplierId, sourceKey: 'arrived_packed', kind: 'arrived_packed',
        at: packed.at, reason: 'Items were already packed before rider inspection.' });
    }
  }
  pending.sort((a, b) => a.at.localeCompare(b.at) || a.orderId.localeCompare(b.orderId) || a.sourceKey.localeCompare(b.sourceKey));
  for (const event of pending) changed = appendEvent(store, event, { at, id }) || changed;
  return changed;
}

export function supplierPerformance(store, supplierId, at) {
  const rows = (store.supplierPerformanceEvents || []).filter(row => row.supplierId === supplierId && reportOrderAllowed(store, row.orderId) && Date.parse(row.at) <= Date.parse(at))
    .sort(chronological).reverse();
  const counts = performanceCounts(store, supplierId, at);
  const recent = rows.filter(row => Date.parse(row.at) > Date.parse(at) - 30 * 86400000);
  const finishes = recent.filter(row => ['late_finish', 'on_time_finish'].includes(row.kind)
    && !row.exemption && !performanceExemption(store, row));
  const onTime = finishes.filter(row => row.kind === 'on_time_finish').length;
  const project = row => ({ id: row.id, orderId: row.orderId, kind: row.kind, at: row.at, recordedAt: row.recordedAt,
    reason: row.reason, reasonCode: row.reasonCode || null, message: row.message || null,
    tier: row.tier || null, deadlineAt: row.deadlineAt || null,
    hoursLate: row.workingLateMs == null ? null : Number((row.workingLateMs / 3600000).toFixed(4)),
    workingLateMs: row.workingLateMs ?? null, graceMinutes: row.graceMinutes ?? null,
    exempt: Boolean(row.exemption || performanceExemption(store, row)),
    exemptionReason: row.exemption || performanceExemption(store, row)?.reason || null,
    warningCodes: row.warningCodes || [],
    active: !row.exemption && !performanceExemption(store, row)
      && consequences(row.kind, performanceCounts(store, supplierId, row.at)).warnings.length > 0 });
  return { supplierId, asOf: at, policy: 'warnings_only', windowDays: 30, graceMinutes: 60,
    counts, rosterReview: counts.lateFinishes >= 3 || counts.cancellations >= 2,
    topPick: performanceTopPick(store, supplierId, at),
    onTime: { completed: finishes.length, onTime, late: finishes.length - onTime,
      rate: finishes.length ? Number((onTime / finishes.length).toFixed(4)) : null },
    warnings: recent.filter(row => row.warningCodes?.length).map(project),
    notices: rows.filter(row => row.kind === 'late_finish').map(project),
    events: rows.map(project) };
}

export async function routeSupplierPerformance({ req, url, store, user, readBody, now, id }) {
  const own = url.pathname === '/me/performance';
  const staff = /^\/ops\/shops(?:\/([^/]+))?\/performance$/.exec(url.pathname);
  const noFault = /^\/orders\/([^/]+)\/performance-no-fault$/.exec(url.pathname);
  if (!own && !staff && !noFault) return null;
  if (!user) fail(401, 'unauthorized');
  const at = now();
  if (noFault) {
    if (!identityHasMembership(user, 'super_admin')) fail(403, 'forbidden');
    if (req.method !== 'POST') fail(405, 'method_not_allowed');
    const order = store.orders.find(row => row.id === noFault[1]);
    if (!order) fail(404, 'order_not_found');
    const body = await readBody(req);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 2000) fail(400, 'reason_required');
    const supplierId = body.supplierId || order.supplierId;
    if (!supplierId || (supplierId !== order.supplierId && !(store.supplierPerformanceEvents || []).some(row => row.orderId === order.id && row.supplierId === supplierId))) fail(404, 'supplier_not_found');
    if (!performanceEnabled(store, at)) fail(409, 'performance_not_active');
    const mutated = appendEvent(store, { orderId: order.id, supplierId, sourceKey: 'no_fault', kind: 'no_fault', at, reason }, { at, id, actor: user });
    const collected = syncSupplierPerformance(store, { at, id });
    // Returns the same immutable record on a retry, regardless of new text.
    return { status: 200, mutated: mutated || collected, body: { performance: supplierPerformance(store, supplierId, at) } };
  }
  if (own ? !identityHasMembership(user, 'supplier') : !identityHasMembership(user, 'ops_admin') && !identityHasMembership(user, 'super_admin')) fail(403, 'forbidden');
  if (req.method !== 'GET') fail(405, 'method_not_allowed');
  if (staff && !staff[1]) return { status: 200, body: { shops: (store.supplierProfiles || []).map(profile => supplierPerformance(store, profile.userId, at)) } };
  const supplierId = own ? user.id : staff[1];
  if (!hasRole(store, supplierId, 'supplier')) fail(404, 'supplier_not_found');
  return { status: 200, body: { performance: supplierPerformance(store, supplierId, at) } };
}
