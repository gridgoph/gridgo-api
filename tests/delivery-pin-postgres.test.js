import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { deliveryFeeForDistance, distanceMetersBetween, deliverySplit } from '../src/operational-model.js';

const DATABASE_URL = process.env.DATABASE_URL;
const point = km => ({ lat: 7.06 + km / 111.195, lng: 125.6, label: `${km} km entrance` });
function file(store, fileId, ownerId, purpose) {
  store.files.push({ fileId, ownerId, purpose, state: 'ready', objectKey: `private/${fileId}`, originalFilename: 'proof.png',
    declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT,
    ...(purpose === 'finished_product_photo' ? { references: [{ type: 'order', id: 'order', field: 'production:finished' }] } : {}) });
}
async function setup(t, km = 1, rate = 8500) {
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(), order = store.orders[0];
  order.shopHandoverVersion = 2;
  order.riderCommissionBps = rate;
  order.dropoff = point(km);
  order.requestedDropoff = point(km);
  order.requestFulfillment = { mode: 'delivery', dropoff: point(km) };
  order.deliveryDistanceMeters = distanceMetersBetween(order.pickup, order.dropoff);
  order.deliveryFeeMinor = deliveryFeeForDistance(order.deliveryDistanceMeters, store.settings);
  order.totalMinor = order.onlineDueMinor = 11000 + order.deliveryFeeMinor;
  order.payments.initial.amountMinor = order.totalMinor;
  order.paymentAllocations[2].amountMinor = order.deliveryFeeMinor;
  Object.assign(store.orderJobs[0], { riderCommissionBps: rate, dropoff: order.dropoff, deliveryFeeMinor: order.deliveryFeeMinor });
  store.approvalCases.push({ id: 'rider_case', userId: 'rider', kind: 'rider', status: 'approved', version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
  file(store, 'finished', 'supplier', 'finished_product_photo');
  file(store, 'payment', 'client', 'payment_proof');
  file(store, 'refundqr', 'client', 'refund_qr');
  file(store, 'refundreceipt', 'ops', 'refund_receipt');
  await db.transaction(() => saveStore(db, store));
  const persistedBefore = (await loadStore(db)).orders[0];
  const api = await apiForTest(t);
  const finished = await api('supplier', 'POST', '/orders/order/production-finished', {});
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const clientRead = await api('client', 'GET', '/orders/order');
  assert.equal(clientRead.status, 200, JSON.stringify(clientRead.body));
  assert.equal(clientRead.body.order.deliveryPin?.status, 'pending', JSON.stringify(clientRead.body));
  return { db, api, before: persistedBefore, pin: clientRead.body.order.deliveryPin };
}
const route = action => `/orders/order/delivery-pin${action ? `/${action}` : ''}`;
async function change(api, pin, km) {
  const preview = await api('client', 'POST', route('preview'), { point: point(km) });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const result = await api('client', 'POST', route('change'), { expectedVersion: pin.version, point: point(km),
    feeDifferenceMinor: preview.body.preview.feeDifferenceMinor, acknowledgeOneChange: true,
    notes: 'Blue gate', receiverName: 'Alex' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.deliveryPin;
}
async function ready(db) {
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders[0].state = 'ready_for_dispatch';
    store.orderJobs[0].state = 'ready_for_dispatch';
    await saveStore(db, store);
  });
}

test('production prompt, role privacy, same-zone one change, immutable snapshots and append-only audit', { skip: !DATABASE_URL }, async t => {
  const { db, api, pin, before } = await setup(t);
  for (const actor of [null, 'other', 'supplier', 'rider', 'ops']) {
    const result = await api(actor, 'POST', route('confirm'), { expectedVersion: pin.version });
    assert.equal(result.status, actor ? 403 : 401);
  }
  const confirmed = await api('client', 'POST', route('confirm'), { expectedVersion: pin.version });
  assert.equal(confirmed.status, 200);
  const updated = await change(api, confirmed.body.deliveryPin, 2);
  assert.equal(updated.change.feeDifferenceMinor, 0);
  assert.equal(updated.status, 'confirmed');
  assert.equal(updated.changeUsed, true);
  const second = await api('client', 'POST', route('change'), { expectedVersion: updated.version, point: point(3), feeDifferenceMinor: 0, acknowledgeOneChange: true });
  assert.equal(second.body.error, 'delivery_pin_change_used');
  const stored = await loadStore(db);
  for (const key of ['dropoff', 'deliveryFeeMinor', 'payments', 'paymentAllocations', 'payoutMilestones', 'totalMinor']) assert.deepEqual(stored.orders[0][key], before[key]);
  assert.ok(stored.notifications.some(n => n.userId === 'client' && n.type === 'delivery_pin_requested'));
  for (const userId of ['ops', 'admin']) assert.ok(stored.notifications.some(n => n.userId === userId && n.type === 'delivery_pin_changed'));
  assert.ok(stored.auditLog.some(a => a.action === 'order.delivery_pin_changed'));
  await ready(db);
  const accepted = await api('rider', 'POST', '/dispatch/order/accept', {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.order.dropoff, point(2));
  assert.equal(accepted.body.order.address, point(2).label);
  assert.equal(accepted.body.order.requestedDropoff, undefined);
  assert.equal(accepted.body.order.requestFulfillment, undefined);
  assert.equal(accepted.body.order.deliveryPin.receiverName, 'Alex');
  assert.equal(accepted.body.order.deliveryPin.original, undefined);
  assert.equal(accepted.body.order.deliveryPin.change, undefined);
  const supplier = await api('supplier', 'GET', '/orders/order');
  assert.equal(supplier.body.order.deliveryPin, undefined);
  await assert.rejects(db.query("UPDATE audit_log SET action='tampered' WHERE action='order.delivery_pin_changed'"));
});

test('higher-zone proof holds dispatch; verified payment atomically applies pin and split with idempotent replay', { skip: !DATABASE_URL }, async t => {
  const { db, api, pin, before } = await setup(t, 1, 6327);
  const proposed = await change(api, pin, 8);
  assert.equal(proposed.change.status, 'pending_payment');
  assert.deepEqual((await api('client', 'GET', '/orders/order')).body.order.dropoff, before.dropoff);
  const submitted = await api('client', 'POST', route('payment'), { expectedVersion: proposed.version, proofFileId: 'payment', reference: 'TOPUP-1' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  await ready(db);
  assert.equal((await api('rider', 'POST', '/dispatch/order/accept', {})).status, 409);
  const body = { expectedVersion: submitted.body.deliveryPin.version, amountMinor: proposed.change.feeDifferenceMinor, reason: 'Transfer verified' };
  const confirmed = await api('ops', 'POST', route('payment/confirm'), body, { key: 'verify-once' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.deepEqual((await api('ops', 'POST', route('payment/confirm'), body, { key: 'verify-once' })).body, confirmed.body);
  const stored = await loadStore(db);
  assert.equal(stored.deliveryPinPayments.length, 1);
  assert.equal(stored.orders[0].payments.initial.amountMinor, before.payments.initial.amountMinor);
  const accepted = await api('rider', 'POST', '/dispatch/order/accept', {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.order.dropoff, point(8));
  const delta = deliverySplit(proposed.change.feeDifferenceMinor, before.riderCommissionBps);
  assert.equal(accepted.body.order.riderPayoutMinor, deliverySplit(before.deliveryFeeMinor, before.riderCommissionBps).riderPayoutMinor + delta.riderPayoutMinor);
  assert.equal(accepted.body.order.platformDeliveryShareMinor, deliverySplit(before.deliveryFeeMinor, before.riderCommissionBps).platformDeliveryShareMinor + delta.platformDeliveryShareMinor);
  const staffOrder = (await api('ops', 'GET', '/orders/order')).body.order;
  assert.equal(staffOrder.deliverySettlement.collectedMinor, before.deliveryFeeMinor + proposed.change.feeDifferenceMinor);
  assert.equal(staffOrder.platformRevenue.collectedMinor, 1000 + staffOrder.platformDeliveryShareMinor);
  assert.equal((await api('client', 'POST', route('confirm'), { expectedVersion: confirmed.body.deliveryPin.version })).status, 200);
  await assert.rejects(db.query('DELETE FROM delivery_pin_payments'));
  const refund = await api('client', 'POST', '/orders/order/refund-requests', { kind: 'cancellation', reason: 'Cancel after pin change' });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  const settlement = await api('ops', 'POST', `/refund-requests/${refund.body.refund.id}/settlement-preview`, { expectedVersion: 1, shopEntitlementMinor: 10000, riderEntitlementMinor: 0 });
  assert.equal(settlement.status, 200, JSON.stringify(settlement.body));
  assert.equal(settlement.body.amounts.deliveryMinor, before.deliveryFeeMinor + proposed.change.feeDifferenceMinor);
});

test('lower-zone credit uses reserved manual refund without cancelling work or superseding shop stages', { skip: !DATABASE_URL }, async t => {
  const { db, api, pin, before } = await setup(t, 12);
  const changed = await change(api, pin, 1);
  assert.ok(changed.change.feeDifferenceMinor < 0);
  const requestId = changed.change.refundRequestId;
  let refund = (await api('client', 'GET', `/refund-requests/${requestId}`)).body.refund;
  assert.equal(refund.kind, 'delivery_pin');
  assert.equal(refund.settlement.totalMinor, -changed.change.feeDifferenceMinor);
  const update = async (actor, method, action, body) => {
    const result = await api(actor, method, `/refund-requests/${requestId}/${action}`, { expectedVersion: refund.version, ...body });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    refund = result.body.refund;
  };
  await update('client', 'PATCH', 'destination', { qrFileId: 'refundqr', provider: 'gcash', accountName: 'Client', ownershipConfirmed: true });
  await update('ops', 'POST', 'review', { reason: 'Account verified', destinationVerified: true });
  await update('ops', 'POST', 'payment-attempts', { reason: 'Sending credit', destinationRevision: 1, destinationVerified: true, provider: 'gcash', sourceWallet: 'ops-wallet' });
  const attemptId = refund.attempt.id;
  await update('ops', 'POST', 'reconcile', { reason: 'Timeout', outcome: 'unknown' });
  assert.equal((await api('ops', 'POST', `/refund-requests/${requestId}/payment-attempts`, { expectedVersion: refund.version, reason: 'Retry' })).status, 409);
  await update('ops', 'POST', 'payments', { reason: 'Original transfer found', attemptId, amountMinor: -changed.change.feeDifferenceMinor, reference: 'REF-1', receiptFileId: 'refundreceipt', paidAt: new Date().toISOString() });
  assert.equal(refund.status, 'paid');
  const stored = await loadStore(db);
  assert.equal(stored.orders[0].state, 'supplier_self_qc');
  assert.deepEqual(stored.orders[0].payoutMilestones, before.payoutMilestones);
  const orderRead = (await api('client', 'GET', '/orders/order')).body.order;
  assert.equal(orderRead.refundHold, false);
  assert.equal(orderRead.refundDisposition, null);
  await ready(db);
  assert.equal((await api('rider', 'POST', '/dispatch/order/accept', {})).status, 200);
  const cancellation = await api('client', 'POST', '/orders/order/refund-requests', { kind: 'cancellation', reason: 'Cancel after delivery credit' });
  assert.equal(cancellation.status, 201, JSON.stringify(cancellation.body));
  const settlement = await api('ops', 'POST', `/refund-requests/${cancellation.body.refund.id}/settlement-preview`, { expectedVersion: 1, shopEntitlementMinor: 10000, riderEntitlementMinor: 0 });
  assert.equal(settlement.status, 200, JSON.stringify(settlement.body));
  assert.equal(settlement.body.amounts.deliveryMinor, before.deliveryFeeMinor + changed.change.feeDifferenceMinor);
});

test('Out of Zone reprices in both directions; invalid points and stale quotes are rejected', { skip: !DATABASE_URL }, async t => {
  const { api, pin } = await setup(t, 16);
  for (const km of [17, 15.5, 1000]) {
    const preview = await api('client', 'POST', route('preview'), { point: point(km) });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.preview.zone, 'out_of_zone');
    assert.equal(preview.body.preview.feeDifferenceMinor, km === 17 ? 1500 : km === 15.5 ? 0 : 1476000);
  }
  assert.equal((await api('client', 'POST', route('preview'), { point: { lat: 91, lng: 125, label: 'Invalid' } })).status, 400);
  const stale = await api('client', 'POST', route('change'), { expectedVersion: pin.version, point: point(17), feeDifferenceMinor: 0, acknowledgeOneChange: true });
  assert.equal(stale.body.error, 'delivery_pin_fee_changed');
});

test('unanswered prompt and unpaid proposal do not prevent dispatch and cannot change after first assignment', { skip: !DATABASE_URL }, async t => {
  const { db, api, pin, before } = await setup(t);
  await change(api, pin, 8);
  await ready(db);
  const accepted = await api('rider', 'POST', '/dispatch/order/accept', {});
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.order.dropoff, before.dropoff);
  assert.equal(accepted.body.order.deliveryPin.status, 'pending');
  assert.equal((await api('client', 'POST', '/orders/order/dropoff-confirmation', { action: 'change', point: point(2) })).status, 409);
  assert.equal((await api('client', 'POST', route('preview'), { point: point(2) })).body.error, 'delivery_pin_locked');
  const lateConfirmation = await api('client', 'POST', route('confirm'), { expectedVersion: accepted.body.order.deliveryPin.version, receiverName: 'Alex' });
  assert.equal(lateConfirmation.status, 200);
  assert.deepEqual(lateConfirmation.body.deliveryPin.point, before.dropoff);
  assert.equal(lateConfirmation.body.deliveryPin.status, 'confirmed');
  const inbox = await api('rider', 'GET', '/notifications');
  assert.ok(inbox.body.notifications.some(n => n.type === 'delivery_pin_confirmed'));
});

test('Out of Zone decrease preserves released shop pay, permits remaining stages, and reserves exact refund cents', { skip: !DATABASE_URL }, async t => {
  const { db, api, pin } = await setup(t, 17);
  await db.transaction(async () => {
    const store = await loadStore(db);
    Object.assign(store.orders[0].payoutMilestones[0], { status: 'released', releasedAt: AT, releasedBy: 'ops' });
    await saveStore(db, store);
  });
  const changed = await change(api, pin, 16);
  assert.equal(changed.change.feeDifferenceMinor, -1500);
  let stored = await loadStore(db);
  assert.equal(stored.orders[0].payoutMilestones[0].status, 'released');
  assert.equal(stored.refundSettlements[0].platformDeliveryMinor, 225);
  // A delivery credit must not engage the cancellation refund's SQL payout hold.
  await db.transaction(async () => {
    const store = await loadStore(db);
    Object.assign(store.orders[0].payoutMilestones[1], { status: 'released', releasedAt: AT, releasedBy: 'ops' });
    await saveStore(db, store);
  });
  await ready(db);
  const accepted = await api('rider', 'POST', '/dispatch/order/accept', {});
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.order.effectiveTotalMinor, undefined);
  assert.equal(accepted.body.order.deliveryPin.original, undefined);
  stored = await loadStore(db);
  await assert.rejects(db.query("UPDATE orders SET data=jsonb_set(data,'{deliveryPin,point,lat}','8') WHERE id='order'"));
  const credit = stored.refundSettlements[0];
  await assert.rejects(db.query('DELETE FROM refund_settlements WHERE id=$1', [credit.id]));
});

test('preview locks settings, bad proof and stale versions fail; rejection unlocks original-pin dispatch', { skip: !DATABASE_URL }, async t => {
  const { db, api, pin, before } = await setup(t);
  const firstPreview = await api('client', 'POST', route('preview'), { point: point(12) });
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.settings.deliveryFeeBands[2].feeMinor += 1234;
    await saveStore(db, store);
  });
  assert.deepEqual((await api('client', 'POST', route('preview'), { point: point(12) })).body, firstPreview.body);
  const proposal = await change(api, pin, 12);
  assert.equal((await api('client', 'POST', route('payment'), { expectedVersion: proposal.version, proofFileId: 'finished', reference: 'BAD' })).body.error, 'payment_proof_invalid');
  assert.equal((await api('client', 'POST', route('confirm'), { expectedVersion: pin.version })).body.error, 'delivery_pin_stale');
  const submit = await api('client', 'POST', route('payment'), { expectedVersion: proposal.version, proofFileId: 'payment', reference: 'REJECTED' });
  assert.equal(submit.status, 200);
  assert.equal((await api('client', 'POST', '/orders/order/refund-requests', { kind: 'cancellation', reason: 'Cancel' })).body.error, 'delivery_pin_payment_pending');
  const rejected = await api('ops', 'POST', route('payment/reject'), { expectedVersion: submit.body.deliveryPin.version, reason: 'No matching transfer' });
  assert.equal(rejected.status, 200);
  await ready(db);
  const accept = await api('rider', 'POST', '/dispatch/order/accept', {});
  assert.equal(accept.status, 200);
  assert.deepEqual(accept.body.order.dropoff, before.dropoff);
  const read = await loadStore(db);
  assert.equal(read.deliveryPinPayments.length, 0);
  assert.ok(read.files.find(f => f.fileId === 'payment').references.length);
});

test('simultaneous changes commit once; all distance bands are inclusive and same-zone flat fees remain fixed', { skip: !DATABASE_URL }, async t => {
  const { api, pin } = await setup(t);
  for (const [km, zone] of [[5, 'nearby'], [5.001, 'away'], [10, 'away'], [10.001, 'long_distance'], [15, 'long_distance'], [15.001, 'out_of_zone']]) {
    const res = await api('client', 'POST', route('preview'), { point: point(km) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.preview.zone, zone);
  }
  const body = km => ({ expectedVersion: pin.version, point: point(km), feeDifferenceMinor: 0, acknowledgeOneChange: true });
  const attempts = await Promise.all([api('client', 'POST', route('change'), body(2)), api('client', 'POST', route('change'), body(3))]);
  assert.deepEqual(attempts.map(a => a.status).sort(), [200, 409]);
});

test('Operations can reconcile an already submitted surcharge during a later independent work hold', { skip: !DATABASE_URL }, async t => {
  const { db, api, pin } = await setup(t);
  const proposal = await change(api, pin, 8);
  const submitted = await api('client', 'POST', route('payment'), { expectedVersion: proposal.version, proofFileId: 'payment', reference: 'HELD-TRANSFER' });
  assert.equal(submitted.status, 200);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders[0].rescheduleRequest = { id: 'schedule', supplierId: 'supplier', status: 'declined', resolution: 'operations_required' };
    await saveStore(db, store);
  });
  const rejected = await api('ops', 'POST', route('payment/reject'), { expectedVersion: submitted.body.deliveryPin.version, reason: 'No matching transfer' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const stored = await loadStore(db);
  assert.equal(stored.orders[0].rescheduleRequest.resolution, 'operations_required');
  assert.equal(stored.orders[0].deliveryPin.change.status, 'pending_payment');
  assert.equal((await api('client', 'POST', route('change'), { expectedVersion: rejected.body.deliveryPin.version })).body.error, 'reschedule_fulfillment_stopped');
});
