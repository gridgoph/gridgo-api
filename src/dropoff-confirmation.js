import { deliveryFeeForDistance, distanceMetersBetween, distanceZoneForDistance } from './operational-model.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function validPoint(point) {
  return point && typeof point.lat === 'number' && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && typeof point.lng === 'number' && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

function samePoint(a, b) {
  return a?.lat === b?.lat && a?.lng === b?.lng && a?.label === b?.label;
}

/** Start once, only on the physical delivery transition; older trips stay compatible. */
export function requestDropoffConfirmation(store, order, at) {
  if (order.fulfillmentMode !== 'delivery' || order.dropoffConfirmation || !validPoint(order.dropoff)) return;
  order.dropoffConfirmation = { status: 'pending', requestedAt: at, original: { ...order.dropoff } };
  // Compare both points with one fixed table, never rewrite the paid price.
  order.dropoffConfirmationPricing = structuredClone(store.settings);
}

export function publicDropoffConfirmation(order, role) {
  const confirmation = order.dropoffConfirmation;
  if (!confirmation || !['client', 'rider', 'ops_admin', 'super_admin'].includes(role)) return null;
  const { status, requestedAt, answeredAt, point, requestedPoint } = confirmation;
  return { status, requestedAt, ...(answeredAt ? { answeredAt } : {}), ...(point ? { point } : {}),
    ...(requestedPoint && role !== 'rider' ? { requestedPoint } : {}) };
}

export function deliveryDestination(order) {
  return order.fulfillmentMode === 'delivery' && order.dropoffConfirmation?.status === 'confirmed'
    ? order.dropoffConfirmation.point : order.dropoff;
}

function changeAllowed(order, point) {
  const settings = order.dropoffConfirmationPricing;
  if (!settings || !validPoint(order.pickup)) return false;
  const originalDistance = distanceMetersBetween(order.pickup, order.dropoffConfirmation.original);
  const newDistance = distanceMetersBetween(order.pickup, point);
  return distanceZoneForDistance(originalDistance, settings).key === distanceZoneForDistance(newDistance, settings).key
    && deliveryFeeForDistance(originalDistance, settings) === order.deliveryFeeMinor
    && deliveryFeeForDistance(newDistance, settings) === order.deliveryFeeMinor;
}

export async function routeDropoffConfirmation({ req, url, store, user, readBody, now, id, audit }) {
  const match = url.pathname.match(/^\/orders\/([^/]+)\/dropoff-confirmation$/);
  if (!match || req.method !== 'POST') return null;
  if (!user) fail(401, 'unauthorized', 'Sign in to confirm your drop-off.');
  const order = store.orders.find(row => row.id === match[1]);
  if (!order) fail(404, 'order_not_found', 'That order no longer exists.');
  if (user.role !== 'client' || order.clientId !== user.id) fail(403, 'forbidden', 'Only the client can confirm this drop-off.');
  if (order.state !== 'out_for_delivery' || order.fulfillmentMode !== 'delivery' || !order.dropoffConfirmation) {
    fail(409, 'dropoff_confirmation_unavailable', 'This delivery is no longer waiting for a drop-off confirmation.');
  }
  const body = await readBody(req);
  if (!body || !['confirm', 'change'].includes(body.action)) fail(400, 'invalid_dropoff_confirmation', 'Choose whether to confirm or change the pin.');
  let point = order.dropoffConfirmation.original;
  if (body.action === 'change') {
    if (!validPoint(body.point) || typeof body.point.label !== 'string' || !body.point.label.trim() || body.point.label.trim().length > 240) {
      fail(400, 'invalid_dropoff_point', 'Choose a valid pin and enter an address of up to 240 characters.');
    }
    point = { lat: body.point.lat, lng: body.point.lng, label: body.point.label.trim() };
  }
  const previous = order.dropoffConfirmation;
  if (previous.status !== 'pending') {
    if (samePoint(previous.point || previous.requestedPoint, point)) {
      return { status: 200, body: { confirmation: publicDropoffConfirmation(order, 'client') }, mutated: false };
    }
    fail(409, 'dropoff_confirmation_answered', 'This drop-off has already been answered. Refresh the order for the latest destination.');
  }
  const at = now();
  // Keeping the original coordinates is always allowed, including legacy paid fees.
  const allowed = (point.lat === previous.original.lat && point.lng === previous.original.lng) || changeAllowed(order, point);
  order.dropoffConfirmation = { ...previous, status: allowed ? 'confirmed' : 'needs_review', answeredAt: at,
    ...(allowed ? { point } : { requestedPoint: point }) };
  order.updatedAt = at;
  audit(store, { actor: user, action: allowed ? 'order.dropoff_confirmed' : 'order.dropoff_review_requested',
    entityType: 'order', entityId: order.id, orderId: order.id, detail: { point, original: previous.original } });
  const recipients = privilegedAdminMemberships(store).map(({ userId, role }) => ({ userId, appRole: role }));
  if (allowed && order.riderId) recipients.push({ userId: order.riderId, appRole: 'rider' });
  for (const recipient of recipients) {
    store.notifications.push({ id: id('ntf'), ...recipient, orderId: order.id, read: false, at,
      type: allowed ? 'order_dropoff_confirmed' : 'ops_dropoff_review_requested',
      title: allowed ? 'Drop-off confirmed' : 'Drop-off change needs review',
      body: allowed ? `The client confirmed ${point.label}. Refresh the trip to follow this pin.`
        : `The requested spot changes the delivery fee. Contact the client. Requested pin: ${point.lat}, ${point.lng} (${point.label}). The original destination and paid fee are unchanged.` });
  }
  queueOrderInvalidate(store, order, ['orders', 'dispatch', 'notifications']);
  return { status: 200, body: { confirmation: publicDropoffConfirmation(order, 'client') }, mutated: true };
}
