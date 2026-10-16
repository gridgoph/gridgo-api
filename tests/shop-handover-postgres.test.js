import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { PICKUP_CHECK_CODES, createPayoutMilestones, snapshotPayoutPlan } from '../src/operational-model.js';
import { assessProductionLapses } from '../src/production-penalties.js';
import { onTimeRate } from '../src/order-match.js';
import { up } from '../migrations/1792029000000_shop_handover_sequence.js';

const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t, change = () => {}, http = true) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orders[0].shopHandoverVersion = 2;
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1, applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT });
  for (const [fileId, purpose, ownerId] of [['finished', 'finished_product_photo', 'supplier'], ['finished2', 'finished_product_photo', 'supplier'],
    ['start', 'production_photo', 'supplier'], ['packed', 'packing_photo', 'rider'], ['packed2', 'packing_photo', 'rider'],
    ['shop_packed', 'packing_photo', 'supplier'], ['signature', 'handoff_signature', 'rider'], ['signature2', 'handoff_signature', 'rider'], ['failure', 'delivery_photo', 'rider']]) {
    store.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, originalFilename: 'photo.png',
      declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [] });
  }
  change(store);
  await db.transaction(() => saveStore(db, store));
  const api = http ? await apiForTest(t) : null;
  const attach = async (fileId, actor = 'supplier') => {
    for (let attempt = 0; ; attempt++) {
      const result = await api(actor, 'POST', `/files/${fileId}/attach`, { orderId: 'order' });
      if (result.body.error !== 'storage_initializing' || attempt === 99) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const post = (actor, endpoint, body = {}) => api(actor, 'POST', `/orders/order/${endpoint}`, body);
  const dispatch = (endpoint, body = {}, actor = 'rider') => api(actor, 'POST', `/dispatch/order/${endpoint}`, body);
  return { db, api, attach, post, dispatch };
}
const checks = PICKUP_CHECK_CODES.map(code => ({ code, passed: true }));
const counts = [{ lineItemId: 'line', countedQuantity: 10 }];
const inspect = ctx => ctx.dispatch('pickup-checklist', { checks, counts });
const confirm = ctx => ctx.dispatch('pickup-confirm', { signature: { fileId: 'signature', signerName: 'Shop Person' } });
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
async function ready(ctx) {
  ok(await ctx.attach('finished'));
  ok(await ctx.post('supplier', 'production-finished'));
  ok(await ctx.post('ops', 'production-review', { decision: 'approved' }));
  ok(await ctx.post('supplier', 'transition', { state: 'ready_for_dispatch' }));
  ok(await ctx.dispatch('accept'));
}

test('finished photos, QA, unpacked checks, rider packing and signature enforce the new sequence without changing money', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t);
  const before = (await loadStore(ctx.db)).orders[0];
  assert.equal((await ctx.post('supplier', 'transition', { state: 'ready_for_dispatch' })).body.error, 'production_finished_required');
  ok(await ctx.attach('start'));
  assert.equal((await ctx.post('supplier', 'production-finished')).body.error, 'finished_product_photo_required');
  ok(await ctx.attach('finished'));
  ok(await ctx.post('supplier', 'production-finished'));
  assert.equal((await ctx.post('supplier', 'transition', { state: 'ready_for_dispatch' })).body.error, 'production_review_required');
  assert.equal((await ctx.post('supplier', 'production-review', { decision: 'approved' })).status, 403);
  ok(await ctx.post('ops', 'production-review', { decision: 'approved' }));
  assert.equal((await ctx.attach('shop_packed')).status, 403);
  const readyOrder = ok(await ctx.post('supplier', 'transition', { state: 'ready_for_dispatch' })).order;
  assert.equal(readyOrder.transitionReadiness.ready_for_dispatch.receiptScan.required, false);
  assert.equal(readyOrder.handoverFlow, 'rider_packs');
  ok(await ctx.dispatch('accept'));
  assert.equal((await ctx.attach('packed', 'rider')).body.error, 'unpacked_inspection_required');
  assert.equal((await confirm(ctx)).body.error, 'unpacked_inspection_required');
  const inspected = ok(await inspect(ctx)).order;
  assert.equal(inspected.state, 'rider_assigned');
  assert.equal(inspected.pickupChecklist.status, 'inspected');
  assert.equal((await confirm(ctx)).body.error, 'packing_photo_required');
  ok(await ctx.attach('packed', 'rider'));
  assert.equal((await confirm(ctx)).body.error, 'invalid_handoff_signature');
  ok(await ctx.attach('signature', 'rider'));
  const picked = ok(await confirm(ctx)).order;
  assert.equal(picked.state, 'picked_up');
  assert.deepEqual(picked.pickupChecklist.packedPhotoFileIds, ['packed']);
  assert.equal((await inspect(ctx)).status, 409);
  const after = (await loadStore(ctx.db)).orders[0];
  assert.deepEqual(after.payoutMilestones, before.payoutMilestones);
  assert.deepEqual(after.payments, before.payments);
  assert.equal(after.totalMinor, before.totalMinor);
  assert.equal(after.shopHandover.inspections.length, 1);
  const audit = (await loadStore(ctx.db)).auditLog;
  for (const action of ['order.production_finished', 'order.production_review', 'pickup_checklist.inspected', 'order.rider_packing_photo', 'pickup_checklist.handoff_signed']) assert.ok(audit.some(row => row.action === action), action);
});

test('rejected QA requires new photos and preserves reviewed evidence; unrelated roles cannot mutate it', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.post('other', 'production-finished')).status, 403);
  ok(await ctx.attach('finished'));
  ok(await ctx.post('supplier', 'production-finished'));
  assert.equal((await ctx.attach('finished2')).body.error, 'finished_product_photo_upload_not_allowed');
  assert.equal((await ctx.post('ops', 'production-review', { decision: 'rejected' })).body.error, 'production_review_note_required');
  ok(await ctx.post('ops', 'production-review', { decision: 'rejected', note: 'Reprint the damaged copies' }));
  assert.equal((await ctx.post('supplier', 'production-finished')).body.error, 'finished_product_photo_required');
  ok(await ctx.attach('finished2'));
  ok(await ctx.post('supplier', 'production-finished'));
  ok(await ctx.post('admin', 'production-review', { decision: 'approved' }));
  const order = (await loadStore(ctx.db)).orders[0];
  assert.equal(order.shopHandover.attempts.length, 2);
  assert.deepEqual(order.shopHandover.finished.photoFileIds, ['finished2']);
});

test('forced steps require reason code plus note and append actor, time, skipped checks and a visible tag', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.post('ops', 'transition', { state: 'ready_for_dispatch' })).body.error, 'production_override_reason_required');
  assert.equal((await ctx.post('ops', 'transition', { state: 'ready_for_dispatch', reason: 'Verified at counter' })).body.error, 'production_override_reason_code_required');
  const order = ok(await ctx.post('ops', 'transition', { state: 'ready_for_dispatch', reasonCode: 'evidence_verified_offline', reason: 'Verified at counter' })).order;
  assert.equal(order.forcedByGridgo, true);
  assert.deepEqual(order.forcedSteps[0].skippedChecks, ['production_finished_required', 'production_review_required']);
  const clientOrder = ok(await ctx.api('client', 'GET', '/orders/order')).order;
  assert.equal(clientOrder.forcedByGridgo, true);
  assert.equal(clientOrder.forcedSteps, undefined);
  assert.equal(clientOrder.shopHandover, undefined);
  const record = (await loadStore(ctx.db)).auditLog.find(row => row.action === 'order.production_override');
  assert.equal(record.actorId, 'ops');
  assert.equal(record.reason, 'Verified at counter');
  assert.equal(record.detail.reasonCode, 'evidence_verified_offline');
  assert.deepEqual(record.detail.skippedChecks, order.forcedSteps[0].skippedChecks);
  await assert.rejects(ctx.db.query("UPDATE audit_log SET data = data || jsonb_build_object('reason', $1::text) WHERE id = $2", ['changed', record.id]), /append.only|immutable/i);
  assert.equal((await ctx.dispatch('pickup-confirm', {}, 'ops')).status, 403);
});

test('arrived-packed is immutable, idempotent and counted for staff; rechecks invalidate old packing and signatures', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t); await ready(ctx);
  ok(await ctx.dispatch('arrived-packed')); ok(await ctx.dispatch('arrived-packed'));
  assert.equal(ok(await ctx.api('ops', 'GET', '/orders/order')).order.shopArrivedPackedCount, 1);
  assert.equal(ok(await ctx.api('client', 'GET', '/orders/order')).order.shopArrivedPackedCount, undefined);
  ok(await inspect(ctx)); ok(await ctx.attach('packed', 'rider')); ok(await ctx.attach('signature', 'rider'));
  const riderPhoto = await ctx.api('rider', 'GET', '/files/packed'); assert.equal(riderPhoto.status, 200);
  assert.equal((await ctx.api('other', 'GET', '/files/packed')).status, 403);
  ok(await inspect(ctx));
  assert.equal((await confirm(ctx)).body.error, 'packing_photo_required');
  ok(await ctx.attach('packed2', 'rider'));
  assert.equal((await confirm(ctx)).body.error, 'invalid_handoff_signature');
  ok(await ctx.attach('signature2', 'rider'));
  ok(await ctx.dispatch('pickup-confirm', { signature: { fileId: 'signature2', signerName: 'Shop Person' } }));
});

test('count mismatch still escalates and pays nobody; claims and refund holds cannot be forced through', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t); await ready(ctx);
  ok(await ctx.attach('failure', 'rider'));
  const mismatch = ok(await ctx.dispatch('pickup-checklist', { checks, counts: [{ lineItemId: 'line', countedQuantity: 9 }], failureNote: 'One missing', evidenceFileIds: ['failure'] }));
  assert.equal(mismatch.order.pickupChecklist.status, 'failed_escalated');
  assert.equal(mismatch.order.state, 'rider_assigned');
  assert.equal((await ctx.attach('packed', 'rider')).status, 409);
  assert.equal((await inspect(ctx)).body.error, 'pickup_escalation_open');
  await ctx.db.transaction(async () => { const store = await loadStore(ctx.db); store.orders[0].payoutHold = true; await saveStore(ctx.db, store); });
  assert.equal((await confirm(ctx)).status, 409);
  assert.ok((await loadStore(ctx.db)).orders[0].payoutMilestones.every(stage => stage.status !== 'released'));
});

test('migration snapshots legacy and past-readiness compatibility; new commitments opt in without changing payout shares', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t, () => {}, false);
  const statements = []; up({ sql: sql => statements.push(sql) });
  for (const [version, state, history, expected] of [[1, 'production', [], 1], [2, 'production', [], 2], [2, 'ready_for_dispatch', [], 1],
    [2, 'rider_assigned', [], 1], [2, 'production', [{ state: 'ready_for_dispatch', at: AT }], 1]]) {
    await resetDatabase(ctx.db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
    await ctx.db.transaction(async () => {
      const store = fixture(); const order = store.orders[0]; order.payoutPlanVersion = version; order.state = state; order.timeline = history;
      order.payoutMilestones = createPayoutMilestones(order, { version }); delete order.shopHandoverVersion; await saveStore(ctx.db, store);
    });
    await ctx.db.query(statements[0]);
    assert.equal((await loadStore(ctx.db)).orders[0].shopHandoverVersion, expected);
  }
  const order = { supplierPlatformPayoutMinor: 10000 }; snapshotPayoutPlan(order);
  assert.equal(order.shopHandoverVersion, 2);
  assert.deepEqual(order.payoutMilestones.map(stage => stage.sharePercent), [40, 35, 25]);
});

test('new production holds are enforced for suppliers and forced staff corrections; legacy corrections also require both reasons', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t, store => {
    store.claims.push({ id: 'claim', orderId: 'order', clientId: 'client', status: 'open', reason: 'Review damaged work', createdAt: AT, updatedAt: AT });
  });
  ok(await ctx.attach('finished'));
  assert.equal((await ctx.post('supplier', 'production-finished')).body.error, 'claim_hold_active');
  assert.equal((await ctx.post('admin', 'transition', { state: 'ready_for_dispatch', reasonCode: 'operational_correction', reason: 'Counter review' })).body.error, 'claim_hold_active');
  assert.equal((await loadStore(ctx.db)).orders[0].forcedSteps, undefined);
  await ctx.db.transaction(async () => {
    const store = await loadStore(ctx.db); store.claims[0].status = 'resolved'; store.orders[0].shopHandoverVersion = 1; await saveStore(ctx.db, store);
  });
  assert.equal((await ctx.post('ops', 'transition', { state: 'supplier_self_qc', reason: 'Legacy correction' })).body.error, 'production_override_reason_code_required');
  for (const state of ['supplier_self_qc', 'ready_for_dispatch']) ok(await ctx.post('ops', 'transition', { state, reason: 'Legacy correction', reasonCode: 'operational_correction' }));
  const order = (await loadStore(ctx.db)).orders[0];
  assert.equal(order.forcedSteps.length, 2);
  assert.deepEqual(order.forcedSteps[1].skippedChecks, ['packing_photo_required']);
});

test('packing attachment and pickup recheck holds after inspection; old inspection cannot transfer to another rider', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t); await ready(ctx); ok(await inspect(ctx));
  await ctx.db.transaction(async () => {
    const store = await loadStore(ctx.db); store.orders[0].payoutHold = true; await saveStore(ctx.db, store);
  });
  assert.equal((await ctx.attach('packed', 'rider')).body.error, 'pickup_held');
  assert.equal((await confirm(ctx)).body.error, 'claim_hold_active');
  await ctx.db.transaction(async () => {
    const store = await loadStore(ctx.db); store.orders[0].payoutHold = false;
    store.orders[0].shopRecovery = { status: 'pending', reason: 'Shop unavailable' }; await saveStore(ctx.db, store);
  });
  assert.equal((await ctx.attach('packed', 'rider')).body.error, 'shop_recovery_pending');
  assert.equal((await confirm(ctx)).body.error, 'shop_recovery_pending');
  await ctx.db.transaction(async () => {
    const store = await loadStore(ctx.db); delete store.orders[0].shopRecovery;
    store.orders[0].pickupChecklist.completedBy = 'former_rider'; await saveStore(ctx.db, store);
  });
  assert.equal((await confirm(ctx)).body.error, 'unpacked_inspection_required');
});


test('PostgreSQL regression: an on-time finished job waiting days for QA keeps its payout and on-time record', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t, store => {
    const order = store.orders[0];
    order.state = 'supplier_self_qc';
    order.shopHandover = { finished: { at: '2026-10-09T23:00:00.000Z', supplierId: 'supplier', by: 'supplier', photoFileIds: ['finished'] }, review: null };
    store.files.find(file => file.fileId === 'finished').references = [{ type: 'order', id: 'order', field: 'finishedProductPhotoFileIds' }];
    store.settings.productionPenalty.deductionsEnabled = true;
  });
  const before = (await loadStore(ctx.db)).orders[0].payoutMilestones;
  for (const at of ['2026-10-11T01:00:00.000Z', '2026-10-11T01:01:00.000Z']) await ctx.db.transaction(async () => {
    const store = await loadStore(ctx.db);
    assessProductionLapses(store, { at, createId: prefix => `${prefix}_${at}` });
    await saveStore(ctx.db, store);
  });
  let saved = await loadStore(ctx.db);
  assert.deepEqual(saved.productionLapses, []);
  assert.deepEqual(saved.orders[0].payoutMilestones, before);
  assert.equal(onTimeRate(saved, 'supplier'), null, 'pending QA is not completed production');
  assert.equal((await ctx.post('ops', 'production-no-communication', { reason: 'Review is still pending' })).body.error, 'production_deadline_not_missed');
  ok(await ctx.post('ops', 'production-review', { decision: 'approved' }));
  ok(await ctx.post('supplier', 'transition', { state: 'ready_for_dispatch' }));
  saved = await loadStore(ctx.db);
  assert.deepEqual(saved.productionLapses, []);
  assert.deepEqual(saved.orders[0].payoutMilestones, before);
  assert.deepEqual(onTimeRate(saved, 'supplier'), { count: 1, rate: 1 });
  assert.equal(saved.orders[0].readyBy, '2026-10-10T00:00:00.000Z');
});

const allWeek = { utcOffsetMinutes: 480, week: Array.from({ length: 7 }, (_, weekday) => ({ weekday, opensMinute: 0, closesMinute: 1440 })), closures: [] };
const openHours = { timeZone: 'Asia/Manila', artworkReviewMinutes: 60, priorityDispatchCutoffMinute: 960, schedule: allWeek };
function closedHours() {
  // Close today and tomorrow in Manila so the test does not depend on the machine clock.
  const today = new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { ...openHours, schedule: { ...allWeek, closures: [{ startDay: today, endDay: tomorrow }] } };
}
const withClock = hours => store => {
  store.settings.operatingHours = hours;
  store.orders[0].operatingClock = { version: 1, settingsVersion: 1, schedule: structuredClone(allWeek) };
};
async function closeGridgo(ctx) {
  await ctx.db.transaction(async () => {
    const store = await loadStore(ctx.db); store.settings.operatingHours = closedHours(); await saveStore(ctx.db, store);
  });
}

test('an assigned rider completes the rider-packs handover and delivery after operating hours; the timeline marks each step', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t, withClock(openHours)); await ready(ctx);
  await closeGridgo(ctx);
  ok(await inspect(ctx));
  ok(await ctx.attach('packed', 'rider'));
  ok(await ctx.attach('signature', 'rider'));
  const picked = ok(await confirm(ctx)).order;
  assert.equal(picked.state, 'picked_up');
  ok(await ctx.post('rider', 'transition', { state: 'out_for_delivery' }));
  ok(await ctx.attach('failure', 'rider'));
  const delivered = ok(await ctx.dispatch('delivery', { evidenceType: 'photo', evidenceFileId: 'failure' })).order;
  assert.equal(delivered.state, 'issue_window_open');
  const timeline = (await loadStore(ctx.db)).orders[0].timeline;
  for (const state of ['picked_up', 'out_for_delivery', 'delivered']) {
    assert.equal(timeline.find(row => row.state === state)?.outsideOperatingHours, true, state);
  }
  assert.equal(timeline.find(row => row.state === 'rider_assigned').outsideOperatingHours, undefined);
});

test('a new rider assignment after operating hours is still refused', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t, withClock(closedHours()));
  ok(await ctx.attach('finished'));
  ok(await ctx.post('supplier', 'production-finished'));
  ok(await ctx.post('ops', 'production-review', { decision: 'approved' }));
  ok(await ctx.post('supplier', 'transition', { state: 'ready_for_dispatch' }));
  const accepted = await ctx.dispatch('accept');
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.error, 'outside_operating_hours');
  const assigned = await ctx.post('ops', 'transition', { state: 'rider_assigned', riderId: 'rider' });
  assert.equal(assigned.body.error, 'outside_operating_hours');
  assert.equal((await loadStore(ctx.db)).orders[0].riderId ?? null, null);
});

test('rider-packs handoff signature names the first missing step: unpacked inspection, then packing photo', { skip: !DATABASE_URL }, async t => {
  const ctx = await setup(t); await ready(ctx);
  const early = await ctx.attach('signature', 'rider');
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'unpacked_inspection_required');
  ok(await inspect(ctx));
  assert.equal((await ctx.attach('signature', 'rider')).body.error, 'packing_photo_required');
  ok(await ctx.attach('packed', 'rider'));
  ok(await ctx.attach('signature', 'rider'));
  assert.equal(ok(await confirm(ctx)).order.state, 'picked_up');
});
