import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultOperationalSettings, distanceMetersBetween, deliveryFeeForDistance, publicOrderFor } from '../src/operational-model.js';
import { requestDropoffConfirmation, routeDropoffConfirmation, deliveryDestination } from '../src/dropoff-confirmation.js';
import { clientNotificationDraft } from '../src/client-order-notifications.js';
import { takeQueuedInvalidates } from '../src/notifications.js';

const at = '2026-10-07T10:00:00.000Z';
function fixture(lat = 7.02) {
  const order = { id: 'order', clientId: 'client', riderId: 'rider', state: 'out_for_delivery', fulfillmentMode: 'delivery',
    pickup: { lat: 7, lng: 125.6, label: 'Pickup' }, dropoff: { lat, lng: 125.6, label: 'Original entrance' }, timeline: [] };
  const store = { orders: [order], settings: defaultOperationalSettings(), notifications: [], auditLog: [],
    userRoleMemberships: [{ userId: 'ops', role: 'ops_admin' }, { userId: 'admin', role: 'super_admin' }] };
  order.deliveryDistanceMeters = distanceMetersBetween(order.pickup, order.dropoff);
  order.deliveryFeeMinor = deliveryFeeForDistance(order.deliveryDistanceMeters, store.settings);
  requestDropoffConfirmation(store, order, at);
  return { store, order };
}
let sequence = 0;
function call(context, body, user = { id: 'client', role: 'client' }) {
  return routeDropoffConfirmation({ req: { method: 'POST' }, url: new URL('http://test/orders/order/dropoff-confirmation'),
    store: context.store, user, readBody: async () => body, now: () => at, id: () => `ntf_${++sequence}`,
    audit: (store, entry) => store.auditLog.push(entry) });
}
const changed = (lat) => ({ action: 'change', point: { lat, lng: 125.6, label: 'Updated entrance' } });

test('confirm preserves original snapshots and is idempotent; push asks for confirmation', async () => {
  const c = fixture();
  const before = structuredClone(c.order);
  assert.match(clientNotificationDraft(c.order).body, /Confirm your drop-off pin/);
  const result = await call(c, { action: 'confirm' });
  assert.equal(result.body.confirmation.status, 'confirmed');
  assert.deepEqual(deliveryDestination(c.order), before.dropoff);
  for (const key of ['dropoff', 'deliveryFeeMinor', 'deliveryDistanceMeters']) assert.deepEqual(c.order[key], before[key]);
  assert.equal(c.store.notifications.length, 3);
  assert.equal((await call(c, { action: 'confirm' })).mutated, false);
  assert.equal(c.store.notifications.length, 3);
  assert.ok(takeQueuedInvalidates(c.store).some(row => row.resource === 'dispatch'));
});

test('same-zone same-fee change becomes navigation pin without changing paid snapshots', async () => {
  const c = fixture(), before = structuredClone(c.order);
  const result = await call(c, changed(7.025));
  assert.equal(result.body.confirmation.status, 'confirmed');
  assert.deepEqual(deliveryDestination(c.order), changed(7.025).point);
  const rider = publicOrderFor(c.order, { id: 'rider', role: 'rider' }, c.store);
  assert.deepEqual(rider.dropoff, changed(7.025).point);
  assert.equal(rider.dropoffConfirmationPricing, undefined);
  assert.equal(rider.dropoffConfirmation.original, undefined);
  for (const key of ['dropoff', 'deliveryFeeMinor', 'deliveryDistanceMeters']) assert.deepEqual(c.order[key], before[key]);
  assert.equal((await call(c, changed(7.025))).mutated, false);
});

for (const [label, from, to] of [['zone boundary', 7.0449, 7.0451], ['same-zone fee boundary', 7.1438, 7.144]]) {
  test(`${label} keeps original pin and fee and notifies Operations once`, async () => {
    const c = fixture(from), before = structuredClone(c.order);
    const result = await call(c, changed(to));
    assert.equal(result.body.confirmation.status, 'needs_review');
    assert.deepEqual(result.body.confirmation.requestedPoint, changed(to).point);
    assert.deepEqual(deliveryDestination(c.order), before.dropoff);
    assert.equal(c.order.deliveryFeeMinor, before.deliveryFeeMinor);
    assert.deepEqual(c.store.notifications.map(row => row.userId), ['ops', 'admin']);
    assert.ok(c.store.notifications.every(row => row.body.includes(String(to))));
    assert.equal((await call(c, changed(to))).mutated, false);
    assert.equal(c.store.notifications.length, 2);
    const rider = publicOrderFor(c.order, { id: 'rider', role: 'rider' }, c.store);
    assert.equal(rider.dropoffConfirmation.requestedPoint, undefined);
  });
}

test('changed settings cannot silently reprice paid trips, while confirm still works', async () => {
  const c = fixture();
  c.order.deliveryFeeMinor = 1000;
  assert.equal((await call(c, changed(7.025))).body.confirmation.status, 'needs_review');
  const original = fixture();
  original.order.deliveryFeeMinor = 1000;
  assert.equal((await call(original, { action: 'confirm' })).body.confirmation.status, 'confirmed');
});

test('rejects invalid coordinates, foreign callers, closed trips, and a second different answer', async () => {
  const c = fixture();
  for (const point of [{ lat: 91, lng: 125 }, { lat: 7, lng: '125' }, { lat: null, lng: 125 }, { lat: 7, lng: Infinity }]) {
    await assert.rejects(call(c, { action: 'change', point: { ...point, label: 'Entrance' } }), { code: 'invalid_dropoff_point' });
  }
  for (const user of [{ id: 'other', role: 'client' }, { id: 'rider', role: 'rider' }, { id: 'client', role: 'supplier' }]) {
    await assert.rejects(call(c, { action: 'confirm' }, user), { status: 403 });
  }
  await assert.rejects(call(c, { action: 'confirm' }, null), { status: 401 });
  await call(c, { action: 'confirm' });
  await assert.rejects(call(c, changed(7.025)), { code: 'dropoff_confirmation_answered' });
  c.order.state = 'delivered';
  await assert.rejects(call(c, { action: 'confirm' }), { code: 'dropoff_confirmation_unavailable' });
});

test('hub pickup never prompts and repeated initialization does not erase an answer', async () => {
  const c = fixture();
  await call(c, { action: 'confirm' });
  requestDropoffConfirmation(c.store, c.order, at);
  assert.equal(c.order.dropoffConfirmation.status, 'confirmed');
  const hub = { ...c.order, fulfillmentMode: 'pickup' };
  delete hub.dropoffConfirmation;
  requestDropoffConfirmation(c.store, hub, at);
  assert.equal(hub.dropoffConfirmation, undefined);
  assert.doesNotMatch(clientNotificationDraft(hub).body, /Confirm your drop-off/);
});
