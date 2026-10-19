import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { AT, fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const reason = 'This artwork contains an item prohibited by GRIDGO policy.';
const hold = { state: 'client_correction', reasonCode: 'prohibited_item', note: reason };
const cancel = { kind: 'cancellation', reasonCode: 'prohibited_item', reason };
async function setup(t, mutate = () => {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  const order = store.orders[0];
  order.state = 'needs_qa'; order.timeline = [{ at: AT, state: 'needs_qa', by: 'ops' }];
  order.fileCheck = { status: 'pending', requestedAt: AT };
  store.orderJobs[0].state = 'needs_qa';
  for (const [fileId, ownerId, purpose] of [['refund_qr', 'client', 'refund_qr'], ['refund_receipt', 'ops', 'refund_receipt']]) {
    store.files.push({ fileId, ownerId, purpose, state: 'ready', objectKey: `private/${fileId}`, originalFilename: 'proof.png',
      declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [] });
  }
  mutate(store, order);
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  return { db, api, read: () => db.transaction(() => loadStore(db)) };
}

test('prohibited item holds are private to client/staff, audited, notified, and only staff can release to QA', { skip: !DATABASE_URL }, async t => {
  const { api, read } = await setup(t);
  const held = await api('ops', 'POST', '/orders/order/transition', hold);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.order.fileCheck.reasonCode, 'prohibited_item');
  assert.equal(held.body.order.fileCheck.reason, reason);
  assert.equal(held.body.order.fileCheck.reviewedBy, 'ops');
  const own = await api('client', 'GET', '/orders/order');
  assert.equal(own.body.order.fileCheck.reason, reason);
  assert.equal(own.body.order.fileCheck.reviewedBy, undefined);
  assert.equal((await api('supplier', 'GET', '/orders/order')).status, 403);
  for (const state of ['submitted', 'needs_qa']) {
    assert.equal((await api('client', 'POST', '/orders/order/transition', { state })).body.error, 'prohibited_item_hold');
  }
  assert.equal((await api('ops', 'POST', '/orders/order/transition', { state: 'cancelled', reason })).body.error, 'prohibited_item_refund_required');
  const saved = await read();
  assert.ok(saved.auditLog.some(row => row.action === 'order.file_check' && row.actorId === 'ops' && row.reason === reason));
  assert.ok(saved.notifications.some(row => row.userId === 'client' && /prohibited item/i.test(row.body)));
  for (const userId of ['ops', 'admin']) assert.ok(saved.notifications.some(row => row.userId === userId && row.orderId === 'order'));
  assert.equal(saved.notifications.some(row => row.appRole === 'supplier' && row.orderId === 'order'), false);
  const released = await api('admin', 'POST', '/orders/order/transition', { state: 'needs_qa', note: 'Reviewed the revised artwork; hold lifted.' });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.order.fileCheck.status, 'pending');
  assert.equal(released.body.order.fileCheck.reasonCode, undefined);
  assert.equal((await api('supplier', 'GET', '/orders/order')).status, 403, 'release still requires QA pass');
  assert.ok((await read()).auditLog.some(row => row.action === 'order.file_check' && row.actorId === 'admin' && row.reason === 'Reviewed the revised artwork; hold lifted.'));
});

test('file-check cancellation uses existing full-refund settlement and transfer, with idempotent intake', { skip: !DATABASE_URL }, async t => {
  const { api, read } = await setup(t);
  const opened = await api('ops', 'POST', '/orders/order/refund-requests', cancel, { key: 'prohibited-cancel' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.deepEqual((await api('ops', 'POST', '/orders/order/refund-requests', cancel, { key: 'prohibited-cancel' })).body, opened.body);
  let refund = opened.body.refund;
  let saved = await read();
  assert.equal(saved.orders[0].state, 'client_correction');
  assert.equal(saved.orders[0].fileCheck.reasonCode, 'prohibited_item');
  assert.equal(saved.orders[0].fileCheck.refundRequestId, refund.id);
  assert.equal(saved.notifications.some(row => row.appRole === 'supplier' && row.orderId === 'order'), false);
  assert.equal((await api('admin', 'POST', '/orders/order/transition', { state: 'needs_qa', note: 'Release' })).status, 409);
  const path = `/refund-requests/${refund.id}`;
  refund = (await api('client', 'PATCH', `${path}/destination`, { expectedVersion: refund.version, qrFileId: 'refund_qr',
    provider: 'gcash', accountName: 'Client', ownershipConfirmed: true })).body.refund;
  refund = (await api('ops', 'POST', `${path}/review`, { expectedVersion: refund.version, reason: 'Receiving account verified.', destinationVerified: true })).body.refund;
  const terms = { expectedVersion: refund.version, shopEntitlementMinor: 0, riderEntitlementMinor: 0 };
  const preview = await api('ops', 'POST', `${path}/settlement-preview`, terms);
  assert.equal(preview.body.amounts.totalMinor, 12000);
  assert.equal((await api('ops', 'POST', `${path}/settlement-preview`, { ...terms, principalMinor: 5000 })).status, 409);
  const settled = await api('ops', 'POST', `${path}/settle`, { ...terms, totalMinor: 12000, workStopped: true,
    shopAgreement: 'No production or shop entitlement.', deliveryEvidence: 'No trip or rider entitlement.', reason });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  refund = settled.body.refund;
  saved = await read();
  assert.equal(saved.orders[0].state, 'cancelled');
  assert.equal(saved.orderJobs[0].state, 'cancelled');
  assert.equal(saved.orders[0].fileCheck.status, 'cancelled');
  assert.equal(saved.orders[0].fileCheck.reason, reason);
  assert.equal(saved.orders[0].payments.initial.amountMinor, 12000);
  assert.ok(saved.orders[0].payoutMilestones.every(row => row.status === 'superseded'));
  assert.equal(saved.refundPayments.length, 0, 'approval does not claim a transfer');
  refund = (await api('ops', 'POST', `${path}/payment-attempts`, { expectedVersion: refund.version, reason: 'Ready to transfer.',
    destinationRevision: 1, destinationVerified: true, provider: 'gcash', sourceWallet: 'test-wallet' })).body.refund;
  const paid = await api('ops', 'POST', `${path}/payments`, { expectedVersion: refund.version, reason: 'Transfer recorded.',
    attemptId: refund.attempt.id, amountMinor: 12000, reference: 'PROHIBITED-REFUND', receiptFileId: 'refund_receipt', paidAt: AT });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.refund.status, 'paid');
  assert.equal((await read()).refundPayments[0].amountMinor, 12000);
});

test('only Operations and Super Admin can impose a prohibited-item decision', { skip: !DATABASE_URL }, async t => {
  const { api, read } = await setup(t);
  for (const actor of [null, 'client', 'other', 'supplier', 'rider']) {
    for (const [path, body] of [['/orders/order/transition', hold], ['/orders/order/refund-requests', cancel]]) {
      assert.equal((await api(actor, 'POST', path, body)).status, actor ? 403 : 401, `${actor}: ${path}`);
    }
  }
  assert.equal((await read()).orders[0].state, 'needs_qa');
  assert.equal((await api('admin', 'POST', '/orders/order/transition', hold)).status, 200);
});

test('prohibited-item decisions refuse production history even when current state was corrected to QA', { skip: !DATABASE_URL }, async t => {
  const { api, read } = await setup(t, (store, order) => order.timeline.unshift({ state: 'production', at: AT, by: 'supplier' }));
  for (const [path, body] of [['/orders/order/transition', hold], ['/orders/order/refund-requests', cancel]]) {
    const result = await api('ops', 'POST', path, body);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'prohibited_item_before_production_only');
  }
  assert.equal((await read()).refundRequests.length, 0);
});

test('review-data can be held but never receives a cash refund', { skip: !DATABASE_URL }, async t => {
  const { api, read } = await setup(t, (store, order) => {
    order.reviewData = true;
    for (const user of store.users) if (['client', 'supplier'].includes(user.role)) user.reviewData = true;
  });
  assert.equal((await api('ops', 'POST', '/orders/order/transition', hold)).status, 200);
  const result = await api('ops', 'POST', '/orders/order/refund-requests', cancel);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'review_data_money_forbidden');
  assert.equal((await read()).refundRequests.length, 0);
  const cancelled = await api('ops', 'POST', '/orders/order/transition', { state: 'cancelled', reasonCode: 'prohibited_item', reason });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.order.fileCheck.status, 'cancelled');
  assert.equal((await read()).refundPayments.length, 0);
});

test('rejecting or withdrawing a refund leaves the prohibited-item hold for staff to release', { skip: !DATABASE_URL }, async t => {
  const { api, read } = await setup(t);
  let refund = (await api('ops', 'POST', '/orders/order/refund-requests', cancel)).body.refund;
  const withdrawn = await api('client', 'POST', `/refund-requests/${refund.id}/withdraw`, { expectedVersion: refund.version, reason: 'I want to replace my artwork.' });
  assert.equal(withdrawn.status, 200);
  assert.equal((await api('client', 'POST', '/orders/order/transition', { state: 'needs_qa' })).body.error, 'prohibited_item_hold');
  refund = (await api('admin', 'POST', '/orders/order/refund-requests', cancel)).body.refund;
  const rejected = await api('admin', 'POST', `/refund-requests/${refund.id}/reject`, { expectedVersion: refund.version, reason: 'Artwork can be corrected.' });
  assert.equal(rejected.status, 200);
  assert.equal((await read()).orders[0].fileCheck.reasonCode, 'prohibited_item');
  assert.equal((await api('ops', 'POST', '/orders/order/transition', { state: 'needs_qa', note: 'Correction reviewed.' })).status, 200);
});

test('hold and release require reasons; release and QA approval cannot bypass an active hold', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t);
  assert.equal((await api('ops', 'POST', '/orders/order/transition', { ...hold, note: ' ' })).body.error, 'file_check_reason_required');
  await api('ops', 'POST', '/orders/order/transition', hold);
  assert.equal((await api('ops', 'POST', '/orders/order/transition', { state: 'needs_qa' })).body.error, 'file_check_reason_required');
  for (const state of ['supplier_assigned', 'approved_for_matching', 'proof_approval', 'production']) {
    assert.equal((await api('ops', 'POST', '/orders/order/transition', { state })).body.error, 'prohibited_item_hold');
  }
});

test('a legacy 75% payment refunds only the cash collected, including all collected fees', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t, (store, order) => {
    delete order.downpaymentPercent;
    order.payments.initial.amountMinor = 9000;
    order.payments.final_online = { amountMinor: 3000, method: 'qr_manual', status: 'not_submitted' };
    const final = [];
    for (const allocation of order.paymentAllocations) {
      final.push({ ...allocation, paymentCode: 'final_online', amountMinor: allocation.amountMinor / 4 });
      allocation.amountMinor = allocation.amountMinor * 3 / 4;
    }
    order.paymentAllocations.push(...final);
  });
  const opened = await api('admin', 'POST', '/orders/order/refund-requests', cancel);
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const refund = opened.body.refund;
  const preview = await api('ops', 'POST', `/refund-requests/${refund.id}/settlement-preview`, {
    expectedVersion: refund.version, shopEntitlementMinor: 0, riderEntitlementMinor: 0 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.body.amounts.principalMinor, preview.body.amounts.feeMinor, preview.body.amounts.deliveryMinor], [7500, 750, 750]);
  assert.equal(preview.body.amounts.totalMinor, 9000);
});
