import { resetDatabase } from './fixtures/reset-database.js';
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
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
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
  assert.equal((await api('client', 'GET', PATH)).body.ping, null);
  // Operations also sees riders heading to the shop.
  assert.equal((await api('ops', 'GET', '/ops/riders/locations')).body.riders[0].riderId, 'rider');

  const pickupAt = new Date().toISOString();
  await change(db, order => { order.state = 'picked_up'; order.pickupChecklist = { status: 'passed', completedAt: pickupAt }; });
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, hidden: 'picked_up' });
  assert.equal((await api('client', 'GET', PATH)).body.ping, null, 'stored pick-up fix stays private after handoff');
  assert.equal((await api('ops', 'GET', PATH)).body.ping.id, sent.body.ping.id);

  // A fix taken before handoff but posted after it must not escape the boundary.
  const delayed = await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6,
    recordedAt: new Date(Date.parse(pickupAt) - 1).toISOString() });
  assert.equal(delayed.status, 201);
  assert.equal(delayed.body.ping.leg, 'pickup');
  assert.equal((await api('client', 'GET', PATH)).body.ping, null);
  const delivery = await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6 });
  assert.equal(delivery.status, 201);
  assert.equal(delivery.body.ping.leg, 'delivery');
  assert.equal((await api('client', 'GET', PATH)).body.ping.id, delivery.body.ping.id);
  assert.deepEqual((await api('supplier', 'GET', PATH)).body, { ping: null, hidden: 'picked_up' });
  assert.equal((await api('admin', 'GET', '/ops/riders/locations')).body.riders[0].lat, 7.06);
  await change(db, order => { order.state = 'out_for_delivery'; order.dropoffConfirmation = { status: 'confirmed', point: { lat: 8, lng: 126 } }; });
  assert.equal((await api('client', 'GET', PATH)).body.ping.id, delivery.body.ping.id, 'distance does not hide the delivery leg');
  await change(db, order => { order.state = 'completed'; });
  assert.equal((await api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6 })).status, 409);
  assert.equal((await api('client', 'GET', PATH)).body.ping, null);
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

test('HTTP: stale and absent fixes remain visible to Operations; clients retain only eligible delivery fixes', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  const mapPath = '/ops/riders/locations';
  let map = (await api('ops', 'GET', mapPath)).body.riders[0];
  assert.equal(map.stale, true);
  assert.equal(map.lat, null);
  const pickupAt = new Date(Date.now() - 180000).toISOString();
  await change(db, order => { order.state = 'picked_up'; order.pickupChecklist = { completedAt: pickupAt, status: 'passed' }; });
  let read = (await api('client', 'GET', PATH)).body;
  assert.equal(read.ping, null);
  assert.equal(read.tracking.status, 'stale');
  assert.equal(read.tracking.message, 'Rider location temporarily unavailable');
  const recordedAt = new Date(Date.now() - 130000).toISOString();
  const posted = await api('rider', 'POST', PATH, { lat: 8, lng: 126, accuracy: 8, recordedAt });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.ping.at, recordedAt);
  assert.ok(posted.body.ping.receivedAt);
  assert.ok(posted.body.ping.processedAt);
  const stored = (await loadStore(db)).locationPings[0];
  assert.equal(stored.receivedAt, posted.body.ping.receivedAt);
  read = (await api('client', 'GET', PATH)).body;
  assert.equal(read.ping.id, posted.body.ping.id);
  assert.equal(read.tracking.lastUpdatedAt, recordedAt);
  assert.equal(read.tracking.stale, true);
  assert.equal(read.ping.receivedAt, undefined);
  assert.equal(read.shop, undefined);
  map = (await api('admin', 'GET', mapPath)).body.riders[0];
  assert.equal(map.stale, true);
  assert.equal(map.lat, 8);
  assert.equal(map.receivedAt, stored.receivedAt);
  const fresh = await api('rider', 'POST', PATH, { lat: 8.01, lng: 126.01 });
  assert.equal(fresh.status, 201);
  const duplicate = await api('rider', 'POST', PATH, { lat: 7, lng: 125, recordedAt });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.ignored, true);
  assert.equal(duplicate.body.ping.id, fresh.body.ping.id);
  for (const body of [{ lat: 91, lng: 0 }, { lat: '7', lng: 125 }, { lat: 7, lng: 125, accuracy: -1 },
    { lat: 7, lng: 125, recordedAt: 2026 }, { lat: 7, lng: 125, recordedAt: new Date(Date.now() - 360000).toISOString() },
    { lat: 7, lng: 125, recordedAt: new Date(Date.now() + 60000).toISOString() }]) {
    assert.equal((await api('rider', 'POST', PATH, body)).status, 400);
  }
  read = (await api('client', 'GET', PATH)).body;
  assert.equal(read.tracking.status, 'live');
  assert.equal(read.ping.id, fresh.body.ping.id);
  const diagnosticsPath = '/ops/orders/order/location-diagnostics';
  for (const role of [null, 'client', 'rider', 'supplier']) assert.equal((await api(role, 'GET', diagnosticsPath)).status, role ? 403 : 401);
  const diagnostics = (await api('ops', 'GET', diagnosticsPath)).body;
  assert.equal(diagnostics.sampleCount, 2);
  assert.ok(diagnostics.maxReceiveGapSeconds >= 0);
  assert.ok(diagnostics.samples[0].sourceDelaySeconds >= 130);
  assert.doesNotMatch(JSON.stringify(diagnostics), /"lat"|"lng"/);
  for (const state of ['delivered', 'issue_window_open', 'completed']) {
    await change(db, order => { order.state = state; });
    read = (await api('client', 'GET', PATH)).body;
    assert.equal(read.ping, null);
    assert.equal(read.tracking.status, 'inactive');
    assert.equal(read.tracking.lastUpdatedAt, null);
  }
});

test('HTTP: all client milestones are available without GPS, and rider events preserve handoff gates', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  const milestonePath = '/dispatch/order/milestones';
  const initial = (await api('client', 'GET', '/orders/order')).body.order;
  assert.equal(initial.pickup, undefined);
  assert.deepEqual(initial.deliveryMilestones.map(row => row.code), ['rider_assigned', 'heading_to_shop', 'at_shop', 'picked_up', 'on_the_way', 'arrived']);
  for (const role of ['client', 'supplier', 'ops', 'admin']) assert.equal((await api(role, 'POST', milestonePath, { milestone: 'at_shop' })).status, 403);
  assert.equal((await api('rider2', 'POST', milestonePath, { milestone: 'at_shop' })).status, 404);
  assert.equal((await api('rider', 'POST', milestonePath, { milestone: 'picked_up' })).status, 400);
  assert.equal((await api('rider', 'POST', milestonePath, { milestone: 'arrived' })).status, 409);
  for (const milestone of ['heading_to_shop', 'at_shop']) {
    const posted = await api('rider', 'POST', milestonePath, { milestone });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const first = posted.body.order.deliveryMilestones.find(row => row.code === milestone);
    assert.equal(first.status, 'completed');
    assert.ok(first.at);
    const repeated = await api('rider', 'POST', milestonePath, { milestone });
    assert.deepEqual(repeated.body.order.deliveryMilestones.find(row => row.code === milestone), first);
  }
  let store = await loadStore(db);
  assert.equal(store.orders[0].state, 'rider_assigned');
  assert.equal(store.auditLog.filter(row => row.action === 'dispatch.milestone').length, 2);
  for (const userId of ['client', 'ops', 'admin']) {
    assert.equal(store.notifications.filter(row => row.type === 'rider_delivery_milestone' && row.userId === userId).length, 2);
  }
  let clientOrder = (await api('client', 'GET', '/orders/order')).body.order;
  assert.equal(clientOrder.riderProgress, undefined);
  assert.equal(clientOrder.deliveryMilestones[2].status, 'completed');
  assert.equal((await api('client', 'GET', PATH)).body.ping, null);
  const at = new Date().toISOString();
  await change(db, order => { order.state = 'out_for_delivery'; order.pickupChecklist = { completedAt: at, status: 'passed' };
    order.timeline.push({ at, state: 'picked_up' }, { at, state: 'out_for_delivery' }); });
  assert.equal((await api('rider', 'POST', milestonePath, { milestone: 'at_shop' })).status, 409);
  const arrived = await api('rider', 'POST', milestonePath, { milestone: 'arrived' });
  assert.equal(arrived.status, 200);
  assert.equal(arrived.body.order.state, 'out_for_delivery', 'arrival never records delivery or opens the issue window');
  clientOrder = (await api('client', 'GET', '/orders/order')).body.order;
  assert.ok(clientOrder.deliveryMilestones.every(row => row.status === 'completed'));
  assert.equal(clientOrder.deliveryEvidence, undefined);
  await change(db, order => { order.state = 'rider_assigned'; order.riderId = 'rider2'; order.pickupChecklist = null;
    order.riderAssignedAt = new Date().toISOString(); });
  clientOrder = (await api('client', 'GET', '/orders/order')).body.order;
  assert.equal(clientOrder.deliveryMilestones[2].status, 'pending');
  assert.equal((await api('rider', 'POST', milestonePath, { milestone: 'at_shop' })).status, 404);
});

test('HTTP: both tracking settings require Super Admin, reason and current version, and apply immediately', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, { state: 'picked_up', pickupChecklist: { status: 'passed', completedAt: new Date(Date.now() - 120000).toISOString() } });
  await api('rider', 'POST', PATH, { lat: 8, lng: 126, recordedAt: new Date(Date.now() - 60000).toISOString() });
  const current = (await api('admin', 'GET', '/settings')).body;
  assert.equal(current.settings.riderLocationRefreshIntervalSeconds, 20);
  assert.equal(current.settings.riderLocationStaleAfterSeconds, 120);
  const body = { expectedVersion: current.version, reason: 'Tracking freshness', riderLocationRefreshIntervalSeconds: 15, riderLocationStaleAfterSeconds: 30 };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, reason: '' })).body.error, 'settings_reason_required');
  for (const [field, values] of [['riderLocationRefreshIntervalSeconds', [null, '20', 14, 31, 15.5]], ['riderLocationStaleAfterSeconds', [null, '120', 29, 601, 30.5]]]) {
    for (const value of values) assert.equal((await api('admin', 'PATCH', '/settings', { ...body, [field]: value })).body.error, 'invalid_rider_tracking_setting');
  }
  const patched = await api('admin', 'PATCH', '/settings', body);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal((await api('admin', 'PATCH', '/settings', body)).body.error, 'settings_version_conflict');
  const tracking = (await api('client', 'GET', PATH)).body.tracking;
  assert.equal(tracking.settingsVersion, patched.body.version);
  assert.equal(tracking.refreshIntervalSeconds, 15);
  assert.equal(tracking.stale, true);
  const stored = await loadStore(db);
  assert.equal(stored.settings.riderLocationStaleAfterSeconds, 30);
  assert.ok(stored.auditLog.some(row => row.action === 'settings.operational_update'));
});

test('PostgreSQL: tracking migration preserves edits, fills legacy defaults and bumps the settings handshake once', { skip: !DATABASE_URL }, async t => {
  const { db } = await setup(t);
  await db.query(`UPDATE platform_settings SET settings = (settings - 'riderLocationStaleAfterSeconds')
    || '{"riderLocationRefreshIntervalSeconds":25}'::jsonb`);
  const before = (await db.query('SELECT version FROM platform_settings')).rows[0].version;
  const { up } = await import('../migrations/1791986400000_rider_tracking_settings.js');
  let sql;
  await up({ sql: text => { sql = text; } });
  await db.transaction(() => db.query(sql));
  const after = (await db.query('SELECT version, settings FROM platform_settings')).rows[0];
  assert.equal(after.version, before + 1);
  assert.equal(after.settings.riderLocationRefreshIntervalSeconds, 25);
  assert.equal(after.settings.riderLocationStaleAfterSeconds, 120);
  await db.transaction(() => db.query(sql));
  assert.equal((await db.query('SELECT version FROM platform_settings')).rows[0].version, after.version);
});

test('HTTP: a valid GPS fix does not age into rejection while waiting for the domain lock', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  let pending;
  await db.transaction(async () => {
    pending = api('rider', 'POST', PATH, { lat: 7.06, lng: 125.6,
      recordedAt: new Date(Date.now() - 298000).toISOString() });
    let waiting = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'");
      if (result.rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true, 'the isolated API request is waiting on our domain lock');
    await new Promise(resolve => setTimeout(resolve, 2500));
  });
  const sent = await pending;
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const { at, receivedAt, processedAt } = sent.body.ping;
  assert.ok(Date.parse(receivedAt) - Date.parse(at) < 300000);
  assert.ok(Date.parse(processedAt) - Date.parse(at) > 300000);
});
