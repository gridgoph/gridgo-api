import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { deliveryFeeForDistance, distanceMetersBetween } from '../src/operational-model.js';

const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t) {
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await db.query('TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(), order = store.orders[0];
  Object.assign(order, { state: 'picked_up', riderId: 'rider', pickupChecklist: { status: 'passed' } });
  order.deliveryDistanceMeters = distanceMetersBetween(order.pickup, order.dropoff);
  order.deliveryFeeMinor = deliveryFeeForDistance(order.deliveryDistanceMeters, store.settings);
  store.approvalCases.push({ id: 'rider_case', userId: 'rider', kind: 'rider', status: 'approved', version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t), before: structuredClone(order) };
}

test('HTTP transition prompts, client changes pin, rider refresh reads persisted destination; money stays fixed', { skip: !DATABASE_URL }, async t => {
  const { db, api, before } = await setup(t);
  const started = await api('rider', 'POST', '/orders/order/transition', { state: 'out_for_delivery' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.order.dropoffConfirmation.status, 'pending');
  const pending = await loadStore(db);
  assert.ok(pending.notifications.some(n => n.userId === 'client' && n.body.includes('Confirm your drop-off pin')));
  for (const actor of [null, 'other', 'rider', 'supplier', 'ops']) {
    const denied = await api(actor, 'POST', '/orders/order/dropoff-confirmation', { action: 'confirm' });
    assert.equal(denied.status, actor ? 403 : 401, JSON.stringify(denied.body));
  }
  const point = { lat: 7.071, lng: 125.611, label: 'Updated entrance' };
  const changed = await api('client', 'POST', '/orders/order/dropoff-confirmation', { action: 'change', point });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.confirmation.status, 'confirmed');
  const after = await loadStore(db);
  for (const key of ['dropoff', 'deliveryFeeMinor', 'totalMinor', 'payments', 'payoutMilestones']) assert.deepEqual(after.orders[0][key], before[key]);
  for (const actor of ['rider', 'client', 'ops']) {
    const read = await api(actor, 'GET', '/orders/order');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.order.dropoff, point);
    assert.equal(read.body.order.dropoffConfirmationPricing, undefined);
  }
  const retry = await api('client', 'POST', '/orders/order/dropoff-confirmation', { action: 'change', point });
  assert.equal(retry.status, 200);
  assert.equal((await loadStore(db)).notifications.length, after.notifications.length);
});

test('HTTP fee-changing request commits Operations notification but never replaces the paid destination', { skip: !DATABASE_URL }, async t => {
  const { db, api, before } = await setup(t);
  await api('rider', 'POST', '/orders/order/transition', { state: 'out_for_delivery' });
  const point = { lat: 7.2, lng: 125.6, label: 'Requested entrance' };
  const result = await api('client', 'POST', '/orders/order/dropoff-confirmation', { action: 'change', point });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.confirmation.status, 'needs_review');
  const persisted = await loadStore(db);
  assert.deepEqual(persisted.orders[0].dropoff, before.dropoff);
  assert.equal(persisted.orders[0].deliveryFeeMinor, before.deliveryFeeMinor);
  for (const actor of ['ops', 'admin']) {
    const inbox = await api(actor, 'GET', '/notifications');
    assert.equal(inbox.status, 200);
    assert.ok(inbox.body.notifications.some(n => n.type === 'ops_dropoff_review_requested' && n.body.includes('7.2')));
  }
  const read = await api('rider', 'GET', '/orders/order');
  assert.deepEqual(read.body.order.dropoff, before.dropoff);
  assert.equal(read.body.order.dropoffConfirmation.requestedPoint, undefined);
});
