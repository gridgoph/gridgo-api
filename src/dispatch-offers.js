import { availableDispatch, riderOfferVisible } from './dispatch-policy.js';
import { eligibleRiderIds, queueInvalidate, queueOrderInvalidate } from './notifications.js';
import { notifyAdmins } from './domain-events.js';
import { sameReviewData } from './review-data.js';

export const DEFAULT_OFFER_TIMEOUT_SECONDS = 30;
export const offerTimeoutSeconds = settings => settings?.riderOfferTimeoutSeconds ?? DEFAULT_OFFER_TIMEOUT_SECONDS;
const stableId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = code => { throw Object.assign(new Error(code), { code, status: 409 }); };

function finish(store, order, status, ctx) {
  const offer = order.dispatchOffer;
  if (offer?.status !== 'offered') return;
  order.dispatchOffer = { ...offer, status, respondedAt: ctx.at };
  (order.dispatchOfferAttempts ||= []).push(structuredClone(order.dispatchOffer));
  ctx.audit(store, { action: `dispatch_offer.${status}`, entityType: 'order', entityId: order.id,
    orderId: order.id, detail: { offerId: offer.id, riderId: offer.riderId } });
  notifyAdmins(store, `dispatch_offer_${status}`, `Rider offer ${status}`, order, `${offer.id}:${status}`, { createId: ctx.id, at: ctx.at });
  queueInvalidate(store, { resource: 'dispatch', id: order.id, userIds: [offer.riderId] });
}

/** Run only on the complete graph under the domain transaction lock. No pricing or new eligibility filters. */
export function reconcileDispatchOffers(store, ctx) {
  let changed = false;
  const riders = eligibleRiderIds(store).map(id => store.users.find(u => u.id === id)).filter(Boolean);
  // Close obsolete reservations before allocating, so a hold/assignment releases its slot immediately.
  for (const order of store.orders || []) {
    if (order.dispatchOffer?.status !== 'offered') continue;
    const recipient = riders.find(r => r.id === order.dispatchOffer.riderId && sameReviewData(order, r));
    const status = order.riderId ? (order.riderId === order.dispatchOffer.riderId ? 'accepted' : 'withdrawn')
      : !availableDispatch(order, store, ctx.at) || !recipient ? 'withdrawn'
      : Date.parse(order.dispatchOffer.expiresAt) <= Date.parse(ctx.at) ? 'expired' : null;
    if (status) { finish(store, order, status, ctx); changed = true; }
  }
  const busy = new Set(store.orders.filter(o => o.dispatchOffer?.status === 'offered').map(o => o.dispatchOffer.riderId));
  const orders = [...store.orders].sort((a, b) => stableId(a.readyAt || a.createdAt || '', b.readyAt || b.createdAt || '') || stableId(a.id, b.id));
  for (const order of orders) {
    if (!availableDispatch(order, store, ctx.at) || ['offered', 'exhausted'].includes(order.dispatchOffer?.status)) continue;
    const attempted = new Set((order.dispatchOfferAttempts || []).filter(a => ['declined', 'expired'].includes(a.status)).map(a => a.riderId));
    const remaining = riders.filter(r => sameReviewData(order, r) && !attempted.has(r.id));
    const next = remaining.filter(r => !busy.has(r.id)).sort((a, b) => stableId(a.lastDispatchOfferAt || '', b.lastDispatchOfferAt || '') || stableId(a.id, b.id))[0];
    if (!next) {
      const status = remaining.length ? 'waiting' : 'exhausted';
      if (order.dispatchOffer?.status === status) continue;
      order.dispatchOffer = { status, at: ctx.at };
      if (status === 'exhausted') {
        notifyAdmins(store, 'dispatch_offer_exhausted', 'No rider accepted this delivery', order, `dispatch-exhausted:${order.id}:${ctx.at}`, { createId: ctx.id, at: ctx.at });
        ctx.audit(store, { action: 'dispatch_offer.exhausted', entityType: 'order', entityId: order.id, orderId: order.id });
      }
      queueOrderInvalidate(store, order, ['dispatch', 'orders']);
      changed = true;
      continue;
    }
    const timeoutSeconds = offerTimeoutSeconds(store.settings);
    const offer = { id: ctx.id('offer'), status: 'offered', riderId: next.id, offeredAt: ctx.at,
      timeoutSeconds, expiresAt: new Date(Date.parse(ctx.at) + timeoutSeconds * 1000).toISOString() };
    order.dispatchOffer = offer;
    next.lastDispatchOfferAt = ctx.at;
    busy.add(next.id);
    store.notifications.push({ id: ctx.id('ntf'), userId: next.id, appRole: 'rider', type: 'dispatch_available',
      orderId: order.id, offerId: offer.id, title: 'Delivery offer', body: 'Open GRIDGO to review your delivery offer.', at: ctx.at, read: false });
    notifyAdmins(store, 'dispatch_offer_created', 'Delivery offered to a rider', order, offer.id, { createId: ctx.id, at: ctx.at });
    ctx.audit(store, { action: 'dispatch_offer.created', entityType: 'order', entityId: order.id, orderId: order.id, detail: offer });
    queueInvalidate(store, { resource: 'dispatch', id: order.id, userIds: [next.id] });
    changed = true;
  }
  return changed;
}

export function requireDispatchOffer(store, order, riderId, offerId, at) {
  if (!order || !availableDispatch(order, store, at) || !riderOfferVisible(order, riderId, at)) fail('not_offerable');
  // Released rider builds can accept their current reservation without knowing its ID.
  if (offerId != null && offerId !== order.dispatchOffer.id) fail('dispatch_offer_stale');
}
export function declineDispatchOffer(store, order, riderId, offerId, ctx) {
  if (!offerId) fail('dispatch_offer_id_required');
  const previous = (order?.dispatchOfferAttempts || []).find(a => a.id === offerId && a.riderId === riderId && a.status === 'declined');
  if (previous) return false;
  requireDispatchOffer(store, order, riderId, offerId, ctx.at);
  finish(store, order, 'declined', ctx);
  reconcileDispatchOffers(store, ctx);
  return true;
}
