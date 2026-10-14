import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t, change = () => {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await db.query('TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  for (const purpose of ['production_photo', 'packing_photo', 'supplier_invoice']) store.files.push({
    fileId: purpose, purpose, ownerId: 'supplier', state: 'ready', objectKey: `private/${purpose}`,
    originalFilename: 'Print%20proof.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [],
  });
  change(store);
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}
const attach = (api, fileId) => api('supplier', 'POST', `/files/${fileId}/attach`, { orderId: 'order' });
const move = (api, state, actor = 'supplier', extra = {}) => api(actor, 'POST', '/orders/order/transition', { state, ...extra });

test('real packaging and packing attachment window preserve the two evidence requirements', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const before = (await loadStore(db)).orders[0];
  const denied = await move(api, 'supplier_self_qc');
  assert.equal(denied.body.error, 'production_photo_required');
  assert.match(denied.body.message, /photo/i);
  assert.equal((await attach(api, 'production_photo')).status, 200);
  assert.equal((await move(api, 'supplier_self_qc')).status, 200);
  const packing = await move(api, 'ready_for_dispatch');
  assert.equal(packing.body.error, 'packing_photo_required');
  assert.equal((await attach(api, 'packing_photo')).status, 200);
  assert.equal((await move(api, 'ready_for_dispatch')).status, 200);
  const after = (await loadStore(db)).orders[0];
  assert.equal(after.totalMinor, before.totalMinor);
  assert.deepEqual(after.payoutMilestones, before.payoutMilestones);
  // A fresh packing file cannot be attached after dispatch readiness.
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.files.push({ ...store.files.find(f => f.fileId === 'packing_photo'), fileId: 'late', objectKey: 'private/late', references: [] });
    await saveStore(db, store);
  });
  assert.equal((await attach(api, 'late')).body.error, 'packing_photo_upload_not_allowed');
});

test('readiness lists all missing items before pressing the button and logs each refused step for Operations', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const job = (await api('supplier', 'GET', '/jobs')).body.jobs[0];
  assert.deepEqual(job.transitionReadiness.ready_for_dispatch.missing.map(x => x.code), ['production_photo_required', 'packing_photo_required']);
  assert.equal(job.transitionReadiness.ready_for_dispatch.receiptScan.required, false);
  const denied = await move(api, 'ready_for_dispatch');
  assert.equal(denied.body.error, 'production_photo_required');
  assert.deepEqual(denied.body.missing, job.transitionReadiness.ready_for_dispatch.missing);
  for (const item of denied.body.missing) assert.ok(item.message.length > 20);
  const invalid = await move(api, 'picked_up');
  assert.equal(invalid.body.error, 'transition_not_allowed');
  assert.match(invalid.body.message, /Refresh/);
  assert.ok(Array.isArray(invalid.body.missing));
  const audit = await api('ops', 'GET', '/audit?action=order.transition_refused&orderId=order');
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.body.audit.map(x => x.detail.code).sort(), ['production_photo_required', 'transition_not_allowed']);
  assert.ok(audit.body.audit.every(x => x.actorId === 'supplier' && x.reason));
  assert.equal((await api('ops', 'GET', '/audit')).status, 403);
  assert.equal((await loadStore(db)).orders[0].state, 'production');
});

test('an open claim without the legacy payoutHold flag blocks packaging and overrides', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, store => {
    store.claims.push({ id: 'claim', orderId: 'order', clientId: 'client', status: 'open', reason: 'Damaged print', createdAt: AT, updatedAt: AT });
  });
  await attach(api, 'production_photo'); await attach(api, 'packing_photo');
  for (const actor of ['supplier', 'ops']) {
    const result = await move(api, 'ready_for_dispatch', actor, { reason: 'Counter check' });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, 'claim_hold_active');
    assert.ok(result.body.missing.some(x => x.code === 'claim_hold_active'));
  }
  assert.equal((await loadStore(db)).orders[0].state, 'production');
});

test('supplier job uses immutable scoped specs, shop deadline, readable updates and decoded file names', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, store => {
    store.orderLineItems[0].structuredSpecSnapshot = { material: 'Coated paper' };
    store.zones.push({ id: 'nearby', code: 'nearby', name: 'Nearby', deliveryFeeMinor: 1000 });
    store.orders[0].zone = 'nearby';
    store.orders[0].timeline.push({ at: AT, state: 'production', milestoneCode: 'production_started', note: 'production_started ready' });
  });
  await attach(api, 'production_photo');
  const job = (await api('supplier', 'GET', '/jobs')).body.jobs[0];
  assert.equal(job.jobDetails.material, 'Coated paper');
  assert.equal(job.jobDetails.zone, 'Nearby');
  assert.equal(job.jobDetails.promisedDate, '2026-10-10T00:00:00.000Z');
  assert.deepEqual(job.jobDetails.missing, []);
  assert.equal(JSON.stringify(job.timeline).includes('production_started'), false);
  assert.ok(job.timeline.every(x => x.note && !x.milestoneCode));
  assert.equal((await api('supplier', 'GET', '/files/production_photo')).body.file.originalFilename, 'Print proof.png');
  assert.equal((await api('client', 'GET', '/orders/order')).body.order.jobDetails, undefined);
  assert.equal((await loadStore(db)).files.find(f => f.fileId === 'production_photo').originalFilename, 'Print%20proof.png');
});

test('missing job facts alert both staff memberships once and never fabricate prices or deadlines', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, store => {
    delete store.orders[0].readyBy; delete store.orders[0].promisedDate; delete store.orders[0].promiseBy;
  });
  const first = await move(api, 'ready_for_dispatch');
  assert.equal(first.status, 409);
  await move(api, 'ready_for_dispatch');
  const job = (await api('supplier', 'GET', '/jobs')).body.jobs[0];
  assert.deepEqual(job.jobDetails, { material: 'Not specified', zone: 'Not specified', promisedDate: 'Not specified', missing: ['material', 'zone', 'promisedDate'] });
  const saved = await loadStore(db);
  const alerts = saved.notifications.filter(n => n.type === 'order_job_details_missing');
  assert.deepEqual(alerts.map(n => n.appRole).sort(), ['ops_admin', 'super_admin']);
  assert.equal(saved.orders[0].deliveryFeeMinor, 1000);
  assert.equal(saved.orders[0].readyBy, undefined);
});

test('staff reason, common work holds and forbidden transitions return actionable audited refusals without changing order data', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const override = await move(api, 'ready_for_dispatch', 'ops');
  assert.equal(override.body.error, 'production_override_reason_required');
  assert.match(override.body.message, /Explain/);
  const stranger = await move(api, 'cancelled', 'other', { reason: 'Must not persist' });
  assert.ok([403, 409].includes(stranger.status));
  assert.ok(stranger.body.message);
  assert.equal((await loadStore(db)).orders[0].cancellationReason, undefined);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders[0].shopRecovery = { status: 'pending', reason: 'Shop unavailable' };
    await saveStore(db, store);
  });
  const held = await move(api, 'ready_for_dispatch');
  assert.equal(held.body.error, 'shop_recovery_pending');
  assert.ok(held.body.missing.some(x => x.code === 'shop_recovery_pending'));
  assert.ok(held.body.missing.some(x => x.code === 'production_photo_required'));
  const audit = await api('ops', 'GET', '/audit?action=order.transition_refused&orderId=order');
  assert.equal(audit.body.audit.length, 3);
  assert.ok(audit.body.audit.every(x => x.reason));
  assert.equal((await loadStore(db)).orders[0].state, 'production');
});
