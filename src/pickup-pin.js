import { randomInt, timingSafeEqual } from 'node:crypto';
import { homeDistance } from './home-printers.js';
import { paymentSettled } from './operational-model.js';
import { writeDraft } from './client-order-notifications.js';
import { notifyAdmins } from './domain-events.js';
import { queueOrderInvalidate } from './notifications.js';

/**
 * Pickup PIN hand-over (docs/EXPRESS_API.md#on-my-way-and-pickup-pin).
 *
 * Version 2 Express pickup orders have no counter code at checkout. The client
 * taps "I'm on my way"; only then a 6-digit PIN exists, is shown to that client
 * and the shop is told who is coming and roughly how far away they are. The
 * shop hands over only with that PIN. Orders placed before this (version 1,
 * `pickupCode`) keep the old counter code unchanged.
 *
 * Delivery orders give the PIN step to the assigned rider instead.
 */

export const PICKUP_PIN_VERSION = 2;
export const PICKUP_PIN_RETRY_ATTEMPTS = 5;
export const PICKUP_PIN_RETRY_MS = 15 * 60_000;
export const PICKUP_PIN_LOCK_ATTEMPTS = 10;
export const WALK_METERS_PER_MINUTE = 80;
const READY_STATE = 'ready_for_dispatch';

const fail = (status, code, details) => { throw Object.assign(new Error(code), { status, code, ...(details ? { details } : {}) }); };
const newPin = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** A checkout that asked for the on-my-way PIN, for a single-client pickup. */
export function pickupPinOrder(order) {
  return order?.orderType === 'express' && order.expressOrder?.handoverVersion === PICKUP_PIN_VERSION;
}
export function wantsPickupPin(body, { fulfillmentMode, group }) {
  if (body?.expressPickupPin === undefined) return false;
  if (body.expressPickupPin !== 'on_my_way') fail(400, 'invalid_express_pickup_pin');
  return fulfillmentMode === 'pickup' && !group;
}

/** Counter cash the shop collects at hand-over, in minor units; 0 when nothing is owed there. */
export function counterCashDueMinor(order) {
  if (order?.paymentMethod !== 'counter_cash') return 0;
  const settled = Object.values(order.payments || {}).filter(paymentSettled)
    .reduce((sum, payment) => sum + (Number.isSafeInteger(payment.amountMinor) ? payment.amountMinor : 0), 0);
  return Math.max(0, (order.totalMinor || 0) - settled);
}

/** Straight-line walk estimate; a home printer's point is rounded the same way as its shop card. */
export function walkEstimate(order, from) {
  const to = order.pickup;
  if (!from || !to) return { walkMinutes: null, walkEstimateSource: null };
  let meters = homeDistance(from, to);
  if (!Number.isFinite(meters)) return { walkMinutes: null, walkEstimateSource: null };
  if (order.homePrinter) meters = Math.max(500, Math.ceil(meters / 500) * 500);
  return { walkMinutes: Math.max(1, Math.ceil(meters / WALK_METERS_PER_MINUTE)), walkEstimateSource: 'straight_line_80m_per_minute' };
}

function parsePoint(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(value.lat) || !Number.isFinite(value.lng)
    || Math.abs(value.lat) > 90 || Math.abs(value.lng) > 180) fail(400, 'invalid_location');
  return { lat: value.lat, lng: value.lng };
}

const firstNameAndInitial = name => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Your client';
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0];
};

function shopNotice(store, order, { type, title, body, occurrenceKey }, { id, at }) {
  writeDraft(store, { userId: order.supplierId, appRole: 'supplier', type, occurrenceKey, orderId: order.id, title, body, read: false }, { id: id('ntf'), at });
}
function clientNotice(store, order, { type, title, body, occurrenceKey }, { id, at }) {
  writeDraft(store, { userId: order.clientId, appRole: 'client', type, occurrenceKey, orderId: order.id, title, body, read: false }, { id: id('ntf'), at });
}

/**
 * Client: "I'm on my way". Allowed once the print is ready. Idempotent: a
 * repeated tap keeps the same PIN and only refreshes the walk estimate.
 */
export function clientOnMyWay(store, order, body, { at, id, audit, user }) {
  if (!pickupPinOrder(order) || order.fulfillmentMode !== 'pickup') fail(409, 'express_on_my_way_unavailable');
  if (order.expressOrder.pickedUpAt) fail(409, 'express_already_picked_up');
  if (order.state !== READY_STATE) fail(409, 'express_not_ready');
  if (body && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'location'))) fail(400, 'invalid_request');
  const e = order.expressOrder;
  const estimate = walkEstimate(order, parsePoint(body?.location) || e.location);
  const first = !e.pickupPin;
  const client = store.users.find(row => row.id === order.clientId);
  // The counter card reads "Jana R. is on the way": first name and initial only.
  e.onMyWay = { at: e.onMyWay?.at || at, updatedAt: at, ...estimate, clientLabel: firstNameAndInitial(client?.name) };
  if (first) e.pickupPin = { code: newPin(), issuedAt: at, failedAttempts: 0, totalFailedAttempts: 0 };
  order.updatedAt = at;
  if (first) {
    shopNotice(store, order, { type: 'shop_client_on_the_way', occurrenceKey: `on-my-way:${order.id}`,
      title: `${e.onMyWay.clientLabel} is on the way`,
      body: `${estimate.walkMinutes ? `About ${estimate.walkMinutes} min away. ` : ''}Ask for the 6-digit pickup PIN before you hand over.` }, { id, at });
    audit(store, { actor: user, action: 'express.on_my_way', entityType: 'order', entityId: order.id, orderId: order.id, detail: { walkMinutes: estimate.walkMinutes } });
  }
  queueOrderInvalidate(store, order, ['orders', 'jobs']);
}

/** Rider: on the way to the shop. Delivery orders give the PIN step to the rider. */
export function riderOnMyWay(store, order, user, { at, id, audit }) {
  if (order.orderType !== 'express' || order.fulfillmentMode !== 'delivery') fail(409, 'express_on_my_way_unavailable');
  if (order.riderId !== user.id) fail(403, 'forbidden');
  if (order.state !== 'rider_assigned') fail(409, 'express_rider_pin_unavailable');
  const e = order.expressOrder;
  if (e.riderPin?.riderId === user.id) return;
  e.riderPin = { riderId: user.id, code: newPin(), issuedAt: at, verifiedAt: null, failedAttempts: 0, totalFailedAttempts: 0 };
  order.updatedAt = at;
  shopNotice(store, order, { type: 'shop_rider_on_the_way', occurrenceKey: `rider-on-my-way:${order.id}:${user.id}`,
    title: 'Your rider is on the way', body: 'Ask the rider for the 6-digit PIN before you hand over.' }, { id, at });
  audit(store, { actor: user, action: 'express.rider_on_my_way', entityType: 'order', entityId: order.id, orderId: order.id });
  queueOrderInvalidate(store, order, ['orders', 'jobs', 'dispatch']);
}

/**
 * Check one PIN attempt. Returns a refusal response (which still commits the
 * attempt count) or null when the PIN matched.
 * Five wrong tries in a row wait 15 minutes; ten wrong tries lock the PIN
 * until Operations resets it.
 */
export function checkPinAttempt(store, order, pin, value, { at, id, kind }) {
  if (pin.lockedAt) return { status: 423, body: { error: 'express_pickup_pin_locked' }, mutated: false };
  if (Date.parse(pin.retryAfter || '') > Date.parse(at)) return { status: 429, body: { error: 'express_pickup_attempts_exceeded', retryAfter: pin.retryAfter }, mutated: false };
  if (pin.retryAfter) { delete pin.retryAfter; pin.failedAttempts = 0; }
  const code = typeof value === 'string' ? value : '';
  if (/^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(code), Buffer.from(pin.code))) return null;
  pin.failedAttempts = (pin.failedAttempts || 0) + 1;
  pin.totalFailedAttempts = (pin.totalFailedAttempts || 0) + 1;
  order.updatedAt = at;
  if (pin.totalFailedAttempts >= PICKUP_PIN_LOCK_ATTEMPTS) {
    pin.lockedAt = at;
    notifyAdmins(store, 'ops_express_pickup_pin_locked', 'Pickup PIN locked after wrong tries', order, `pin-lock:${order.id}:${kind}:${pin.issuedAt}`, { createId: id, at });
    if (kind === 'client') clientNotice(store, order, { type: 'order_pickup_pin_locked', occurrenceKey: `pin-lock:${order.id}:${pin.issuedAt}`,
      title: 'Pickup PIN locked', body: 'Too many wrong PINs were tried at the counter. GRIDGO will send you a new PIN. Nothing was handed over.' }, { id, at });
    queueOrderInvalidate(store, order, ['orders', 'jobs']);
    return { status: 423, body: { error: 'express_pickup_pin_locked' }, mutated: true };
  }
  if (pin.failedAttempts >= PICKUP_PIN_RETRY_ATTEMPTS) pin.retryAfter = new Date(Date.parse(at) + PICKUP_PIN_RETRY_MS).toISOString();
  return { status: 409, body: { error: 'express_pickup_code_mismatch', attemptsLeft: Math.max(0, PICKUP_PIN_LOCK_ATTEMPTS - pin.totalFailedAttempts) }, mutated: true };
}

/** The cash the shop states it took must equal what is owed at the counter. */
export function parseCashCollected(order, body) {
  const due = counterCashDueMinor(order);
  const value = body?.cashCollectedMinor;
  if (due === 0) {
    if (value !== undefined && value !== 0) fail(400, 'cash_not_due');
    return 0;
  }
  if (!Number.isSafeInteger(value)) fail(400, 'cash_collected_required', { amountDueMinor: due });
  if (value !== due) fail(409, 'cash_collected_mismatch', { amountDueMinor: due });
  return value;
}

/** Operations: unlock after repeated wrong tries. The old PIN stops working. */
export function resetPickupPin(store, order, body, { at, id, audit, user }) {
  if (order.orderType !== 'express') fail(404, 'order_not_found');
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 2000) fail(400, 'reason_required');
  const kind = body?.pin === 'rider' ? 'rider' : 'client';
  const pin = kind === 'rider' ? order.expressOrder.riderPin : order.expressOrder.pickupPin;
  if (!pin || (kind === 'rider' ? pin.verifiedAt : order.expressOrder.pickedUpAt)) fail(409, 'express_pickup_pin_not_active');
  const before = { lockedAt: pin.lockedAt || null, totalFailedAttempts: pin.totalFailedAttempts || 0 };
  Object.assign(pin, { code: newPin(), issuedAt: at, failedAttempts: 0, totalFailedAttempts: 0, rotatedAt: at });
  delete pin.lockedAt; delete pin.retryAfter;
  order.updatedAt = at;
  if (kind === 'client') clientNotice(store, order, { type: 'order_pickup_pin_reset', occurrenceKey: `pin-reset:${order.id}:${at}`,
    title: 'New pickup PIN', body: 'GRIDGO gave you a new pickup PIN. Open the order to see it. The old PIN no longer works.' }, { id, at });
  audit(store, { actor: user, action: 'express.pickup_pin_reset', entityType: 'order', entityId: order.id, orderId: order.id, reason, before, after: { pin: kind } });
  queueOrderInvalidate(store, order, ['orders', 'jobs', 'dispatch']);
}

/** Whether the rider's pickup checks must wait for the shop to confirm the rider PIN. */
export function riderPinBlocksPickup(store, order) {
  if (order?.orderType !== 'express' || order.fulfillmentMode !== 'delivery') return false;
  const pin = order.expressOrder?.riderPin;
  if (pin?.riderId === order.riderId && pin.verifiedAt) return false;
  return store?.settings?.expressRiderPinRequired === true;
}

/** Fields the client, shop, rider and Operations may each see; only the right party sees a PIN. */
export function publicPickupPin(order, user, { own, shop, staff }) {
  const e = order.expressOrder || {};
  const out = {};
  if (pickupPinOrder(order)) {
    const pin = e.pickupPin;
    out.pickupHandover = 'on_my_way_pin';
    out.onMyWay = e.onMyWay ? structuredClone(e.onMyWay) : null;
    out.pickupPinIssued = Boolean(pin);
    if (pin) {
      out.pickupPinLocked = Boolean(pin.lockedAt);
      if (shop || staff) out.pickupPinRetryAfter = pin.retryAfter || null;
    }
    if (own && pin && !e.pickedUpAt && !pin.lockedAt) out.pickupPin = pin.code;
    if ((shop || staff) && e.onMyWay && !e.pickedUpAt) out.counterCollection = { amountMinor: counterCashDueMinor(order) };
  } else if (order.fulfillmentMode === 'pickup') out.pickupHandover = 'counter_code';
  if (e.pickupHandover && (own || shop || staff)) {
    out.handedOver = { at: e.pickupHandover.at, method: e.pickupHandover.method,
      ...(shop || staff ? { cashCollectedMinor: e.pickupHandover.cashCollectedMinor } : {}) };
  }
  if (order.fulfillmentMode === 'delivery' && e.riderPin) {
    const rider = user?.role === 'rider' && user.id === order.riderId && e.riderPin.riderId === user.id;
    const current = e.riderPin.riderId === order.riderId;
    if (rider || ((shop || staff) && current)) out.riderPin = { issuedAt: e.riderPin.issuedAt, verifiedAt: e.riderPin.verifiedAt || null, locked: Boolean(e.riderPin.lockedAt),
      ...(rider && !e.riderPin.verifiedAt && !e.riderPin.lockedAt ? { code: e.riderPin.code } : {}) };
  }
  return out;
}
