import { actorUserId, isShopStaff } from './shop-team.js';
import { supplierCanWork } from './supplier-verification.js';
import { queueOrderInvalidate } from './notifications.js';
import { pickupPinOrder } from './pickup-pin.js';
import { quickMessages } from './quick-messages.js';

/**
 * Live tracker for every order, Express or not (docs/ORDER_TRACKING_API.md).
 *
 * Steps: sent -> accepted (by a named person) -> printing (start time, person,
 * optional "60 of 100" progress) -> ready -> picked_up (pickup) or delivered.
 * Each step change already writes the party inbox rows that push, so the app
 * can say "you don't need to keep this open". Progress counts never push.
 */

const ACCEPTED = new Set(['supplier_accepted', 'payment_authorized', 'awaiting_initial_payment', 'initial_payment_review']);
const READY = new Set(['ready_for_dispatch', 'awaiting_collection']);
const DONE = new Set(['delivered', 'issue_window_open', 'completed', 'payout_released']);
const AFTER_READY = new Set(['rider_assigned', 'picked_up', 'out_for_delivery', 'awaiting_collection']);
const PRINTING = new Set(['production', 'supplier_self_qc']);
const PROGRESS_UNITS = new Set(['pages', 'copies', 'pieces']);
const MAX_PROGRESS = 10_000_000;

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const firstName = (store, userId) => {
  const name = (store?.users || []).find(user => user.id === userId)?.name;
  return name ? String(name).trim().split(/\s+/)[0] : null;
};
const firstTimeline = (order, states, after = null) => (order.timeline || [])
  .find(entry => states.has(entry.state) && (!after || Date.parse(entry.at) >= Date.parse(after)));

function stepIndex(order) {
  if (order.expressOrder?.pickedUpAt || DONE.has(order.state)) return 4;
  if (READY.has(order.state) || AFTER_READY.has(order.state)) return 3;
  if (PRINTING.has(order.state)) return 2;
  if (ACCEPTED.has(order.state) || order.shopAcceptance?.status === 'accepted' && order.shopAcceptance.supplierId === order.supplierId) return 1;
  return 0;
}

/** Estimated ready time: the promise, or the progress pace once printing reports a count. */
export function readyByEstimate(order, role, at) {
  const promise = role === 'supplier' ? order.readyBy ?? order.promiseBy ?? null : order.promiseBy ?? null;
  const count = order.productionCount, started = firstTimeline(order, PRINTING)?.at;
  if (order.state === 'production' && count && started && count.done > 0 && count.done < count.total) {
    const elapsed = Date.parse(count.updatedAt) - Date.parse(started);
    if (elapsed > 0) {
      const finish = Date.parse(count.updatedAt) + Math.ceil(elapsed * (count.total - count.done) / count.done);
      if (Number.isFinite(finish)) return { readyBy: new Date(Math.max(finish, Date.parse(at))).toISOString(), readyBySource: 'progress' };
    }
  }
  return { readyBy: promise, readyBySource: promise ? 'promise' : null };
}

/** Client, assigned shop (owner/staff) and Operations. Riders use dispatch views. */
export function orderTracker(store, order, user, at = new Date().toISOString()) {
  const own = user?.role === 'client' && user.id === order.clientId;
  const shop = user?.role === 'supplier' && user.id === order.supplierId;
  const staff = ['ops_admin', 'super_admin'].includes(user?.role);
  if (!own && !shop && !staff) return null;
  if (!order.supplierId && order.state !== 'cancelled') return null;
  const current = stepIndex(order);
  const sentEvent = [...(order.expressOrder?.events || [])].reverse().find(event => event.state === 'sending' && event.supplierId === order.supplierId);
  const sentAt = sentEvent?.at || (order.shopAcceptance?.supplierId === order.supplierId ? order.shopAcceptance.assignedAt : null)
    || firstTimeline(order, new Set(['supplier_assigned']))?.at || order.createdAt || null;
  const acceptance = order.shopAcceptance?.status === 'accepted' && order.shopAcceptance.supplierId === order.supplierId ? order.shopAcceptance : null;
  const acceptedEntry = acceptance ? null : firstTimeline(order, ACCEPTED, sentAt);
  const acceptedAt = acceptance?.acceptedAt || acceptedEntry?.at || null;
  const acceptedBy = acceptance?.acceptedBy || acceptedEntry?.by || null;
  const printingEntry = firstTimeline(order, new Set(['production']), acceptedAt) || firstTimeline(order, PRINTING, acceptedAt);
  const readyAt = order.readyAt || order.awaitingCollectionAt || firstTimeline(order, READY)?.at || null;
  const finishedAt = order.expressOrder?.pickedUpAt || order.issueWindowOpenedAt || firstTimeline(order, DONE)?.at || null;
  const status = index => order.state === 'cancelled' ? (index < current ? 'done' : 'cancelled') : index < current || (index === 4 && current === 4) ? 'done' : index === current ? 'current' : 'upcoming';
  const count = order.productionCount;
  const delivery = order.fulfillmentMode === 'delivery';
  const estimate = readyByEstimate(order, shop ? 'supplier' : 'client', at);
  const steps = [
    { key: 'sent', status: status(0), at: sentAt },
    { key: 'accepted', status: status(1), at: current >= 1 ? acceptedAt : null, byFirstName: current >= 1 ? firstName(store, acceptedBy) : null },
    { key: 'printing', status: status(2), at: current >= 2 ? printingEntry?.at || null : null,
      byFirstName: current >= 2 ? firstName(store, printingEntry?.by) : null,
      progress: current === 2 && count ? { done: count.done, total: count.total, unit: count.unit, updatedAt: count.updatedAt } : null },
    { key: 'ready', status: status(3), at: current >= 3 ? readyAt : null, expectedAt: current < 3 ? estimate.readyBy : null },
    { key: delivery ? 'delivered' : 'picked_up', status: status(4), at: current >= 4 ? finishedAt : null },
  ];
  const e = order.expressOrder;
  return {
    version: 1,
    status: order.state === 'cancelled' ? 'cancelled' : steps[current].key,
    ...estimate,
    steps,
    notifiesEveryStep: true,
    pickup: !delivery && order.orderType === 'express' ? {
      handover: pickupPinOrder(order) ? 'on_my_way_pin' : 'counter_code',
      onMyWayAvailable: pickupPinOrder(order) && order.state === 'ready_for_dispatch' && !e?.pickedUpAt && own,
      onMyWayAt: e?.onMyWay?.at || null,
      walkMinutes: e?.onMyWay?.walkMinutes ?? null,
    } : null,
    quickMessages: own ? quickMessages(order, 'client') : shop ? quickMessages(order, 'supplier') : [],
    ratingDue: own && ratingAllowed(order) && !(store?.shopReviews || []).some(review => review.orderId === order.id),
  };
}

/** Express may be rated as soon as it is picked up or delivered; other orders after the issue window. */
export function ratingAllowed(order) {
  if (!order?.supplierId) return false;
  if (['completed', 'payout_released'].includes(order.state)) return true;
  return order.orderType === 'express' && order.state === 'issue_window_open';
}

/** Shop owner or staff: "60 of 100" while printing. No push; the tracker refreshes. */
export async function routeOrderTracking({ req, url, store, user, readBody, now, audit }) {
  const match = /^\/orders\/([^/]+)\/production-progress$/.exec(url.pathname);
  if (!match || req.method !== 'POST') return null;
  if (user?.role !== 'supplier') fail(403, 'forbidden');
  const order = store.orders.find(row => row.id === match[1]);
  if (!order) fail(404, 'order_not_found');
  if (order.supplierId !== user.id) fail(403, 'forbidden');
  if (!supplierCanWork(store, user.id)) fail(403, 'supplier_not_approved');
  if (order.state !== 'production') fail(409, 'production_progress_unavailable');
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['done', 'total', 'unit'].includes(key))
    || !Number.isSafeInteger(body.total) || body.total < 1 || body.total > MAX_PROGRESS
    || !Number.isSafeInteger(body.done) || body.done < 0 || body.done > body.total
    || (body.unit !== undefined && !PROGRESS_UNITS.has(body.unit))) fail(400, 'invalid_production_progress');
  const at = now();
  const before = order.productionCount ? { ...order.productionCount } : null;
  order.productionCount = { done: body.done, total: body.total, unit: body.unit || (order.orderType === 'express' ? 'pages' : 'pieces'),
    updatedAt: at, updatedBy: actorUserId(user) };
  order.updatedAt = at;
  audit(store, { actor: user, action: 'order.production_progress', entityType: 'order', entityId: order.id, orderId: order.id,
    before, after: { done: body.done, total: body.total }, detail: { staff: isShopStaff(user) } });
  queueOrderInvalidate(store, order, ['orders', 'jobs']);
  return { status: 200, body: { orderId: order.id, tracker: orderTracker(store, order, user, at) }, mutated: true };
}
