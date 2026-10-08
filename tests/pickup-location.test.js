import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const PATH = '/dispatch/order/location';
async function setup(t, orderPatch = {}) {
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await db.query('TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  Object.assign(store.orders[0], { riderId: 'rider', state: 'rider_assigned',
    dropoff: { lat: 7.06, lng: 125.6 }, ...orderPatch }); // Even a client next to the shop must not see this leg.
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1,
    applicationRevision: 1, createdAt: AT, updatedAt: AT });
  store.users.push({ id: 'rider2', role: 'rider', clerkUserId: 'clerk_rider2', name: 'Other rider',
    email: 'rider2@example.invalid', verificationStatus: 'approved', createdAt: AT });
  store.userRoleMemberships.push({ userId: 'rider2', role: 'rider', createdAt: AT });
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}
async function change(db, mutate) {
  await db.transaction(async () => {
    const store = await loadStore(db);
    mutate(store.orders[0], store);
    await saveStore(db, store);
  });
}

test('HTTP: pick-up leg accepts assigned rider fixes; only the shop, rider and staff see them', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, shop: { lat: 7.06, lng: 125.6 } });
  await change(db, (order, store) => store.locationPings.push({ id: 'previous_leg', orderId: order.id,
    riderId: 'rider', lat: 8, lng: 126, leg: 'delivery', at: new Date(Date.now() - 10000).toISOString() }));
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, shop: { lat: 7.06, lng: 125.6 } }, 'a historical delivery leg never reaches the shop');
  for (const actor of ['client', 'supplier', 'replacement', 'ops']) {
    assert.equal((await api(actor, 'POST', PATH, { lat: 7.06, lng: 125.6 })).status, 403);
  }
  assert.equal((await api('rider2', 'POST', PATH, { lat: 7.06, lng: 125.6 })).status, 404);
  const sent = await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6, accuracy: 5,
    recordedAt: new Date(Date.now() - 2000).toISOString() });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal((await loadStore(db)).locationPings.find(p => p.id === sent.body.ping.id).leg, 'pickup');
  for (const actor of ['supplier', 'rider', 'ops', 'admin']) {
    const read = await api(actor, 'GET', PATH);
    assert.equal(read.status, 200);
    assert.equal(read.body.ping.id, sent.body.ping.id);
  }
  for (const actor of ['replacement', 'other', 'rider2']) assert.equal((await api(actor, 'GET', PATH)).status, 403);
  assert.deepEqual((await api('client', 'GET', PATH)).body, { ping: null });
  // Existing staff map only covers the delivery leg.
  assert.deepEqual((await api('ops', 'GET', '/ops/riders/locations')).body, { riders: [] });

  const pickupAt = new Date().toISOString();
  await change(db, order => { order.state = 'picked_up'; order.pickupChecklist = { status: 'passed', completedAt: pickupAt }; });
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, hidden: 'picked_up' });
  assert.deepEqual((await api('client', 'GET', PATH)).body, { ping: null }, 'stored pick-up fix stays private after handoff');
  assert.equal((await api('ops', 'GET', PATH)).body.ping.id, sent.body.ping.id);

  // A fix taken before handoff but posted after it must not escape the boundary.
  const delayed = await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6,
    recordedAt: new Date(Date.parse(pickupAt) - 1).toISOString() });
  assert.equal(delayed.status, 201);
  assert.equal(delayed.body.ping.leg, 'pickup');
  assert.deepEqual((await api('client', 'GET', PATH)).body, { ping: null });
  const delivery = await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6 });
  assert.equal(delivery.status, 201);
  assert.equal(delivery.body.ping.leg, 'delivery');
  assert.equal((await api('client', 'GET', PATH)).body.ping.id, delivery.body.ping.id);
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, hidden: 'picked_up' });
  assert.equal((await api('admin', 'GET', '/ops/riders/locations')).body.riders[0].lat, 7.06);
  await change(db, order => { order.state = 'out_for_delivery'; order.dropoffConfirmation = { status: 'confirmed', point: { lat: 8, lng: 126 } }; });
  assert.deepEqual((await api('client', 'GET', PATH)).body, { ping: null }, 'existing reveal radius still applies');
  await change(db, order => { order.state = 'completed'; });
  assert.equal((await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6 })).status, 409);
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, hidden: 'picked_up' });
});

test('HTTP: GRIDGO Office tracking and reassignment do not leak a previous rider fix', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, { fulfillmentMode: 'pickup' });
  assert.equal((await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6 })).status, 201);
  assert.ok((await api('supplier', 'GET', PATH)).body.ping);
  assert.equal((await api('client', 'GET', PATH)).status, 403);
  await change(db, order => { order.riderId = 'rider2'; });
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, shop: { lat: 7.06, lng: 125.6 } });
  assert.equal((await api('rider', 'GET', PATH)).status, 403);
});
