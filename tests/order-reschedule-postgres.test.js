import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, request, answer, call, id, PROPOSED } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { expireRescheduleRequests } from '../src/order-reschedule.js';
import { assessProductionLapses } from '../src/production-penalties.js';

const DATABASE_URL = process.env.DATABASE_URL;
const setup = async (db, store = fixture()) => {
  await db.query('TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  await db.transaction(() => saveStore(db, store));
};
const mutate = (db, action) => db.transaction(async () => {
  const store = await loadStore(db);
  const result = await action(store);
  await saveStore(db, store);
  return result;
});

test('PostgreSQL persists requests, atomic outcomes, immutable original facts and renewed warnings', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await setup(db);
  await mutate(db, request);
  await mutate(db, store => answer(store, 'accept'));
  let store = await loadStore(db);
  assert.equal(store.orders[0].readyBy, PROPOSED);
  assert.equal(store.orders[0].rescheduleRequest.status, 'accepted');
  assert.equal(store.notifications.filter(row => row.type === 'order_reschedule_accepted').length, 4);
  assert.equal(store.auditLog.filter(row => row.action === 'order.reschedule_accepted').length, 1);
  await assert.rejects(db.query("UPDATE orders SET data=data-'rescheduleRequest' WHERE id='order'"), /must be preserved/);
  await assert.rejects(db.query("UPDATE orders SET data=jsonb_set(data,'{rescheduleRequest,status}','\"pending\"') WHERE id='order'"), /answer is final/);

  const late = fixture(); late.orders[0].readyBy = '2026-10-04T00:00:00.000Z';
  await setup(db, late);
  await mutate(db, store => assessProductionLapses(store, { at: '2026-10-05T00:00:00.000Z', createId: id }));
  await mutate(db, request); await mutate(db, store => answer(store, 'accept'));
  await mutate(db, store => assessProductionLapses(store, { at: '2026-10-12T01:00:00.000Z', createId: id }));
  store = await loadStore(db);
  assert.equal(store.productionLapses[0].tier, 'minor');
  assert.equal(store.orders[0].rescheduleRequest.priorLapse.tier, 'moderate');
});

test('PostgreSQL rematch preserves finalized lines, scopes jobs to replacement and serializes competing client choices', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await setup(db); await mutate(db, request); await mutate(db, store => answer(store, 'decline'));
  const before = await loadStore(db), requestId = before.orders[0].rescheduleRequest.id;
  const offerId = before.orders[0].rescheduleRequest.offer.id;
  const results = await Promise.allSettled([
    mutate(db, store => call(store, 'client', 'rematch', { requestId, offerId, action: 'accept' })),
    mutate(db, store => call(store, 'client', 'refund', { requestId })),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const after = await loadStore(db);
  assert.deepEqual(after.orderLineItems, before.orderLineItems);
  if (after.orders[0].rescheduleRequest.resolution === 'rematched') {
    assert.equal(after.orders[0].supplierId, 'replacement');
    assert.equal(after.orderJobs[0].supplierId, 'replacement');
    assert.equal(after.refundRequests.length, 0);
  } else assert.equal(after.refundRequests.length, 1);
});

test('expiry persists once at the boundary and keeps the original deadline', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await setup(db); await mutate(db, request);
  const expire = store => expireRescheduleRequests(store, { at: '2026-10-06T00:00:00.000Z', id });
  assert.equal(await mutate(db, expire), true);
  assert.equal(await mutate(db, expire), false);
  const store = await loadStore(db);
  assert.equal(store.orders[0].readyBy, '2026-10-10T00:00:00.000Z');
  assert.equal(store.notifications.filter(row => row.type === 'order_reschedule_expired').length, 4);
});

test('HTTP routes authenticate every actor, expose safe projections and block work and payout after decline', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  const store = fixture();
  store.orders[0].readyBy = '2099-01-01T00:00:00.000Z'; store.orders[0].promiseBy = '2099-01-01T01:00:00.000Z';
  await setup(db, store);
  const api = await apiForTest(t);
  const path = '/orders/order/reschedule-request';
  const body = { reason: 'Equipment repair', proposedReadyBy: '2099-01-02T00:00:00.000Z' };
  assert.equal((await api(null, 'POST', path, body)).status, 401);
  assert.equal((await api('other', 'GET', path)).status, 403);
  assert.equal((await api('client', 'GET', '/ops/reschedule-requests')).status, 403);
  const created = await api('supplier', 'POST', path, body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const requestId = created.body.request.id;
  assert.equal((await api('supplier', 'POST', path, body)).body.error, 'reschedule_already_requested');
  const read = await api('client', 'GET', path);
  assert.equal(read.body.request.proposedReadyBy, undefined);
  assert.equal(read.body.request.proposedPromiseBy, '2099-01-02T01:00:00.000Z');
  const declined = await api('client', 'POST', `${path}/answer`, { requestId, answer: 'decline' });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.equal(declined.body.request.resolution, 'rematch_offered');
  const work = await api('supplier', 'POST', '/orders/order/transition', { state: 'supplier_self_qc' });
  assert.equal(work.body.error, 'reschedule_fulfillment_stopped');
  const queue = await api('ops', 'GET', '/ops/reschedule-requests');
  assert.equal(queue.body.requests[0].id, requestId);
  const refund = await api('client', 'POST', `${path}/refund`, { requestId });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(refund.body.request.resolution, 'refund_requested');
});

test('declined reschedule can reach an approved full refund through the existing settlement ledger', { skip: !DATABASE_URL }, async t => {
  const { routeRefunds } = await import('../src/refunds.js');
  const { actors, audit, AT } = await import('./fixtures/reschedule.js');
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  const store = fixture();
  store.files.push({ fileId: 'refund_qr', ownerId: 'client', purpose: 'refund_qr', state: 'ready',
    objectKey: 'private/refund', originalFilename: 'qr.png', declaredContentType: 'image/png', detectedContentType: 'image/png',
    size: 100, createdAt: AT, references: [] });
  await setup(db, store); await mutate(db, request); await mutate(db, s => answer(s, 'decline'));
  await mutate(db, s => call(s, 'client', 'refund', { requestId: s.orders[0].rescheduleRequest.id,
    destination: { qrFileId: 'refund_qr', provider: 'other', accountName: 'Account holder', ownershipConfirmed: true } }));
  const refundCall = async (action, input) => mutate(db, async s => {
    const refund = s.refundRequests[0];
    return routeRefunds({ req: { method: 'POST', headers: { 'idempotency-key': id('key') } },
      url: new URL(`http://api.test/refund-requests/${refund.id}/${action}`), store: s, user: actors.ops,
      readBody: async () => ({ expectedVersion: refund.version, reason: 'Full cancellation agreed.', ...input }),
      now: () => AT, id, audit });
  });
  await refundCall('review', { destinationVerified: true });
  const result = await refundCall('settle', { workStopped: true, shopAgreement: 'No remaining shop entitlement.',
    deliveryEvidence: 'No delivery took place.', shopEntitlementMinor: 0, riderEntitlementMinor: 0, totalMinor: 12000 });
  assert.equal(result.body.refund.settlement.totalMinor, 12000);
  const persisted = await loadStore(db);
  assert.equal(persisted.refundSettlements[0].totalMinor, 12000);
  assert.equal(persisted.orders[0].state, 'cancelled');
  assert.equal(persisted.refundPayments.length, 0, 'approval never invents a client transfer');
});

test('applied penalty ledger remains immutable when request or consent is routed to Operations', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  for (const alreadyRequested of [false, true]) {
    const store = fixture(); store.orders[0].readyBy = '2026-10-03T00:00:00.000Z';
    store.settings.productionPenalty.deductionsEnabled = true;
    await setup(db, store);
    if (alreadyRequested) await mutate(db, request);
    await mutate(db, s => assessProductionLapses(s, { at: '2026-10-05T00:00:00.000Z', createId: id }));
    await mutate(db, s => assessProductionLapses(s, { at: '2026-10-05T00:00:01.000Z', createId: id }));
    const before = await loadStore(db);
    assert.equal(before.productionLapses[0].deductionMinor, 3000);
    if (!alreadyRequested) await mutate(db, request);
    await mutate(db, s => answer(s, 'accept'));
    const after = await loadStore(db);
    assert.equal(after.orders[0].readyBy, '2026-10-03T00:00:00.000Z');
    assert.equal(after.orders[0].rescheduleRequest.status, 'operations_required');
    assert.equal(after.orders[0].rescheduleRequest.appliedDeductionMinor, 3000);
    assert.deepEqual(after.productionLapses, before.productionLapses);
    assert.deepEqual(after.orders[0].payoutMilestones, before.orders[0].payoutMilestones);
  }
});
