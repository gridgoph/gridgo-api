import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { prepareHandover } from '../src/hub-handover.js';

const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t, ready = true) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await db.query('TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.settings.handoverOtpEnabled = true;
  store.settings.hubPickupEnabled = false;
  const order = store.orders[0];
  Object.assign(order, { fulfillmentMode: 'pickup', riderId: 'rider', state: ready ? 'awaiting_collection' : 'out_for_delivery', awaitingCollectionAt: AT });
  store.staffRoles = [{ code: 'hub_staff', name: 'Hub staff', canHandout: true }];
  if (ready) prepareHandover(store, order, { at: AT });
  store.files.push({ fileId: 'drop_photo', ownerId: 'rider', purpose: 'delivery_photo', state: 'ready', objectKey: 'private/drop_photo', originalFilename: 'photo.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [{ type: 'order', id: 'order', field: 'deliveryPhotoFileIds' }] });
  order.deliveryPhotoFileIds = ['drop_photo'];
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}
async function enroll(api, key = 'other') {
  const invited = await api('admin', 'POST', '/admin/staff/invites', { roleCode: 'hub_staff' });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const redeemed = await api(key, 'POST', '/auth/staff/redeem', { code: invited.body.code });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  return invited.body.code;
}

test('HTTP invitation uses Clerk subject, role membership, single-use codes and revocation; profile is caller scoped', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  assert.equal((await api(null, 'GET', '/staff/me')).status, 401);
  assert.equal((await api('client', 'POST', '/admin/staff/invites', { roleCode: 'hub_staff' })).status, 403);
  assert.equal((await api('client', 'GET', '/staff/me', null, { claims: { role: 'staff' } })).status, 403);
  const code = await enroll(api);
  assert.equal((await api('other', 'POST', '/auth/staff/redeem', { code })).status, 200);
  assert.equal((await api('client', 'POST', '/auth/staff/redeem', { code })).body.error, 'staff_invite_used');
  const me = await api('other', 'GET', '/staff/me');
  assert.equal(me.body.staff.role, 'hub_staff');
  assert.equal(JSON.stringify(me.body).includes('clerk_'), false);
  const store = await loadStore(db);
  assert.ok(store.userRoleMemberships.some(m => m.userId === 'other' && m.role === 'staff'));
  assert.equal(store.users.find(u => u.id === 'other').role, 'client');
  assert.notEqual(store.staffInvites[0].codeHash, code);
  const revoke = await api('admin', 'PATCH', '/admin/staff/other', { active: false, roleCode: 'hub_staff' });
  assert.equal(revoke.status, 200);
  assert.equal((await api('other', 'GET', '/staff/me')).status, 403);
});

test('HTTP QR claims commit exactly once under concurrency, preserve money, deny alternate completion and private credential reads', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await enroll(api);
  const before = await loadStore(db), order = before.orders[0];
  for (const actor of ['supplier', 'admin', 'other', 'rider']) assert.equal((await api(actor, 'GET', '/orders/order/handover')).status, 403);
  const credentials = await api('client', 'GET', '/orders/order/handover');
  assert.equal(credentials.status, 200);
  assert.match(credentials.headers.get('cache-control'), /no-store/);
  const ordinary = await api('client', 'GET', '/orders/order');
  assert.equal(ordinary.body.order.handover, undefined);
  const bypass = await api('admin', 'POST', '/orders/order/transition', { state: 'delivered' });
  assert.equal(bypass.status, 409, JSON.stringify(bypass.body));
  assert.equal((await api('admin', 'POST', '/orders/order/collection', { receivedBy: 'Receiver' })).body.error, 'hub_claim_required');
  const mismatch = await api('other', 'POST', '/staff/hub/claims', { ...credentials.body.handover, otp: 'bad' });
  assert.equal(mismatch.body.error, 'handover_otp_mismatch');
  assert.equal((await loadStore(db)).orders[0].state, 'awaiting_collection');
  const results = await Promise.all([1, 2].map(() => api('other', 'POST', '/staff/hub/claims', credentials.body.handover)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const after = await loadStore(db);
  assert.equal(after.orders[0].state, 'issue_window_open');
  assert.equal(after.hubHandouts.length, 1);
  assert.deepEqual(after.orders[0].payoutMilestones, order.payoutMilestones);
  assert.equal(after.orders[0].totalMinor, order.totalMinor);
  assert.equal((await api('other', 'GET', '/staff/hub/handouts')).body.staffTotals[0].count, 1);
  assert.equal((await api('ops', 'GET', '/ops/hub/handouts')).body.handouts.length, 1);
  await assert.rejects(db.query("DELETE FROM hub_handouts WHERE order_id='order'"), /append-only/);
  await assert.rejects(db.query("UPDATE orders SET data=data-'handover' WHERE id='order'"), /handover must be preserved/);
});

test('rider arrival mints hub credentials and does not start issue window; delivery mismatch blocks then correct OTP opens the shared event', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, false);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.users.find(u => u.id === 'rider').verificationStatus = 'approved';
    store.approvalCases.push({ id: 'rider_case', userId: 'rider', kind: 'rider', status: 'approved', version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
    await saveStore(db, store);
  });
  const proof = { evidenceType: 'photo', evidenceFileId: 'drop_photo' };
  const arrived = await api('rider', 'POST', '/dispatch/order/delivery', proof);
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  const waiting = (await loadStore(db)).orders[0];
  assert.equal(waiting.state, 'awaiting_collection');
  assert.equal(waiting.issueWindowOpenedAt, undefined);
  assert.ok(waiting.handover.qrToken);
  // Independent delivery order, so the immutable hub token never gets repurposed.
  await db.transaction(async () => {
    const store = await loadStore(db);
    const delivery = { ...store.orders[0], id: 'delivery', fulfillmentMode: 'delivery', state: 'out_for_delivery', timeline: [], handover: undefined };
    prepareHandover(store, delivery, { at: AT });
    store.orders.push(delivery);
    store.files.find(f => f.fileId === 'drop_photo').references.push({ type: 'order', id: 'delivery', field: 'deliveryPhotoFileIds' });
    await saveStore(db, store);
  });
  const bad = await api('rider', 'POST', '/dispatch/delivery/delivery', { ...proof, otp: 'bad' });
  assert.equal(bad.body.error, 'handover_otp_mismatch');
  const client = await api('client', 'GET', '/orders/delivery/handover');
  const rider = await api('rider', 'GET', '/orders/delivery/handover');
  assert.equal(client.body.handover.otp, rider.body.handover.otp);
  const delivered = await api('rider', 'POST', '/dispatch/delivery/delivery', { ...proof, otp: rider.body.handover.otp });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.order.state, 'issue_window_open');
});

test('legacy counter collection and delivery evidence remain available for already-ready orders without OTP credentials', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, false);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders[0].state = 'awaiting_collection';
    await saveStore(db, store);
  });
  const collected = await api('ops', 'POST', '/orders/order/collection', { receivedBy: 'Receiver' });
  assert.equal(collected.status, 200, JSON.stringify(collected.body));
  assert.equal(collected.body.order.state, 'issue_window_open');
  assert.equal((await loadStore(db)).orders[0].handover, undefined);
});

test('supplier invoice attachment writes a private receipt feed and durable alerts to both administrator memberships', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.files.push({ fileId: 'invoice_scan', ownerId: 'supplier', purpose: 'supplier_invoice', state: 'ready', objectKey: 'private/invoice_scan', originalFilename: 'scan.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [] });
    await saveStore(db, store);
  });
  const attached = await api('supplier', 'POST', '/files/invoice_scan/attach', { orderId: 'order' });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const feed = await api('ops', 'GET', '/ops/hub/receipt-scans');
  assert.equal(feed.body.scans[0].fileId, 'invoice_scan');
  for (const actor of ['client', 'rider', 'other']) {
    assert.equal((await api(actor, 'GET', '/ops/hub/receipt-scans')).status, 403);
    assert.equal((await api(actor, 'GET', '/files/invoice_scan')).status, 403);
  }
  const store = await loadStore(db);
  assert.ok(store.notifications.some(n => n.userId === 'admin' && n.type === 'supplier_invoice_scanned'));
  assert.ok(store.notifications.some(n => n.userId === 'ops' && n.type === 'supplier_invoice_scanned'));
});

test('Super Admin alone can enable OTP rollout through audited settings, with invalid types rejected', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t, false);
  const current = (await api('admin', 'GET', '/settings')).body;
  const body = { expectedVersion: current.version, reason: 'Companion app rollout', handoverOtpEnabled: false };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, handoverOtpEnabled: 'yes' })).body.error, 'invalid_handover_otp_setting');
  const updated = await api('admin', 'PATCH', '/settings', body);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.settings.handoverOtpEnabled, false);
});

test('a newly invited Clerk subject persists as staff without client or privileged memberships', { skip: !DATABASE_URL }, async t => {
  const { redeemStaffInvite } = await import('../src/staff-access.js');
  const { id, audit } = await import('./fixtures/reschedule.js');
  const { db, api } = await setup(t);
  const invited = await api('admin', 'POST', '/admin/staff/invites', { roleCode: 'hub_staff' });
  await db.transaction(async () => {
    const store = await loadStore(db);
    redeemStaffInvite({ store, claims: { sub: 'clerk_staff_new' }, clerkUser: { username: 'Staff profile', primaryEmailAddress: { emailAddress: ['newstaff', 'example.invalid'].join('@') } }, code: invited.body.code, at: AT, id, audit });
    await saveStore(db, store);
  });
  const me = await api('staff_new', 'GET', '/staff/me', null, { headers: { 'X-GRIDGO-Role': 'staff' } });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.staff.role, 'hub_staff');
  assert.equal((await api('staff_new', 'GET', '/orders/order')).status, 403);
  const store = await loadStore(db);
  assert.deepEqual(store.userRoleMemberships.filter(m => m.userId === me.body.staff.id).map(m => m.role), ['staff']);
});

test('HTTP settings and staff hub agree on unset, configured and cleared schedules', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await enroll(api);
  const custom = { utcOffsetMinutes: 480,
    week: [{ weekday: 2, opensMinute: 600, closesMinute: 900 }],
    closures: [{ startDay: '2026-10-06', endDay: '2026-10-06' }] };
  const compare = async schedule => {
    const settings = await api('client', 'GET', '/settings');
    const hub = await api('other', 'GET', '/staff/hub');
    assert.equal(settings.status, 200);
    assert.equal(hub.status, 200);
    assert.deepEqual(settings.body.settings.hubPickup.schedule, schedule);
    assert.deepEqual(hub.body.hub.schedule, schedule);
    return settings.body.version;
  };
  let version = await compare(null);
  for (const schedule of [custom, null]) {
    const result = await api('admin', 'PATCH', '/settings', {
      expectedVersion: version, reason: 'Update collection hours', hubPickup: { schedule, feeMinor: 0 },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    version = await compare(schedule);
    const store = await loadStore(db);
    assert.deepEqual(store.settings.hubPickup.schedule, schedule);
    assert.deepEqual(store.orders[0].handover.schedule, null);
  }
});

test('pickup availability defaults off and requires Super Admin, reason and current version', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await db.query("UPDATE platform_settings SET settings = settings - 'hubPickupEnabled'");
  let current = (await api('client', 'GET', '/settings')).body;
  assert.equal(current.settings.hubPickupEnabled, false);
  const body = { expectedVersion: current.version, reason: 'Enable new pickup orders', hubPickupEnabled: true };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('client', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, reason: '' })).body.error, 'settings_reason_required');
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, hubPickupEnabled: 'true' })).body.error, 'invalid_hub_pickup_enabled');
  const enabled = await api('admin', 'PATCH', '/settings', body);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.settings.hubPickupEnabled, true);
  assert.equal((await api('admin', 'PATCH', '/settings', body)).body.error, 'settings_version_conflict');
  current = (await api('client', 'GET', '/settings')).body;
  assert.equal(current.settings.hubPickupEnabled, true);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, expectedVersion: current.version, hubPickupEnabled: false })).status, 200);
  const saved = await loadStore(db);
  assert.equal(saved.settings.hubPickupEnabled, false);
  const updates = saved.auditLog.filter(row => row.action === 'settings.operational_update');
  assert.equal(updates.length, 2);
  assert.equal(updates[0].detail.current.hubPickupEnabled, true);
});
