import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t, state = 'production', configure = () => {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orders[0].state = state;
  store.orders[0].specialInstructions = 'Darker lines';
  store.orders[0].readyBy = '2030-10-10T00:00:00.000Z';
  store.orders[0].promiseBy = '2030-10-10T01:00:00.000Z';
  store.orders[0].timeline = [{ at: new Date().toISOString(), state, by: 'supplier' }];
  store.orders[0].shopAcceptance = { status: 'pending', deadlineAt: '2030-10-10T00:00:00.000Z' };
  store.files.push({ fileId: 'extra_payment', ownerId: 'client', purpose: 'payment_proof', state: 'ready', objectKey: 'private/payment',
    originalFilename: 'proof.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT });
  configure(store);
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t), before: (await loadStore(db)).orders[0] };
}
test('shop acceptance requires an explicit tick for notes, preserving old orders without notes', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, 'supplier_assigned');
  const refused = await api('supplier', 'POST', '/orders/order/transition', { state: 'payment_authorized' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'special_instructions_acknowledgement_required');
  const accepted = await api('supplier', 'POST', '/orders/order/transition', { state: 'payment_authorized', specialInstructionsRead: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await loadStore(db)).orders[0].specialInstructionsAcknowledgement.supplierId, 'supplier');
});
test('priced request needs client consent and a verified separate payment before changing the agreed spec', { skip: !DATABASE_URL }, async t => {
  const { api, db, before } = await setup(t);
  const created = await api('supplier', 'POST', '/orders/order/change-requests', { lineItemId: 'line', reason: 'Extra finishing',
    proposedSpec: 'Staple on left', extraPrincipalMinor: 1000 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const request = created.body.changeRequest;
  assert.equal(request.extraPrincipalMinor, 1000);
  assert.equal((await api('client', 'GET', `/orders/order/change-requests/${request.id}`)).body.changeRequest.totalMinor, 1100);
  const base = `/orders/order/change-requests/${request.id}`;
  assert.equal((await api('other', 'POST', `${base}/answer`, { expectedVersion: 1, answer: 'accept' })).status, 403);
  const answer = await api('client', 'POST', `${base}/answer`, { expectedVersion: 1, answer: 'accept' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.changeRequest.status, 'pending_payment');
  const prior = await api('supplier', 'GET', '/orders/order');
  assert.equal(prior.body.order.productionItems[0].agreedChange, undefined);
  const payment = await api('client', 'POST', `${base}/payment`, { expectedVersion: 2, proofFileId: 'extra_payment', reference: 'EXTRA-1' });
  assert.equal(payment.status, 200, JSON.stringify(payment.body));
  assert.equal((await api('ops', 'POST', `${base}/payment/confirm`, { expectedVersion: 3, amountMinor: 1000, reason: 'Verified' })).status, 409);
  const body = { expectedVersion: 3, amountMinor: 1100, reason: 'Verified transfer' };
  const confirmed = await api('ops', 'POST', `${base}/payment/confirm`, body, { key: 'confirm-extra' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.changeRequest.status, 'applied');
  assert.deepEqual((await api('ops', 'POST', `${base}/payment/confirm`, body, { key: 'confirm-extra' })).body, confirmed.body);
  const after = await loadStore(db);
  for (const field of ['supplierSubtotalMinor', 'totalMinor', 'payments', 'paymentAllocations', 'payoutMilestones']) assert.deepEqual(after.orders[0][field], before[field]);
  assert.equal(after.orderChangePayments.length, 1);
  const client = (await api('client', 'GET', '/orders/order')).body.order;
  assert.equal(client.productionItems[0].agreedChange.proposedSpec, 'Staple on left');
  assert.equal(client.changeRequests[0].extraPrincipalMinor, undefined);
  assert.equal(client.changeRequests[0].payout, undefined);
  assert.equal(client.changeRequests[0].totalMinor, 1100);
  assert.ok(after.auditLog.some(a => a.action === 'order.change_payment_confirmed'));
  for (const userId of ['ops', 'admin']) assert.ok(after.notifications.some(n => n.userId === userId && n.type === 'order_change_applied'));
});

async function paidChange(api) {
  const create = await api('supplier', 'POST', '/orders/order/change-requests', { lineItemId: 'line', reason: 'Additional finish', proposedSpec: 'Left staple', extraPrincipalMinor: 1000 });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const base = `/orders/order/change-requests/${create.body.changeRequest.id}`;
  assert.equal((await api('client', 'POST', `${base}/answer`, { expectedVersion: 1, answer: 'accept' })).status, 200);
  assert.equal((await api('client', 'POST', `${base}/payment`, { expectedVersion: 2, proofFileId: 'extra_payment', reference: 'EXTRA-PAID' })).status, 200);
  const confirmed = await api('ops', 'POST', `${base}/payment/confirm`, { expectedVersion: 3, amountMinor: 1100, reason: 'Verified' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return base;
}
test('notes persist per cart line, masking contacts before PostgreSQL sees them', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const cart = await api('client', 'POST', '/me/carts', { fulfillmentMode: 'delivery', defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' } });
  assert.equal(cart.status, 201, JSON.stringify(cart.body));
  const path = `/me/carts/${cart.body.cart.id}`;
  const added = await api('client', 'POST', `${path}/lines`, { catalogItemId: 'item_supplier', optionIds: [], quantity: 10, specialInstructions: 'Darker lines; 09171234567 me@example.com @contact https://example.com' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const text = added.body.cart.lines[0].specialInstructions;
  assert.equal(text, 'Darker lines; [masked] [masked] [masked] [masked]');
  const stored = await db.query('SELECT special_instructions FROM client_cart_lines');
  assert.equal(stored.rows[0].special_instructions, text);
  const lineId = added.body.cart.lines[0].id;
  assert.equal((await api('client', 'PATCH', `${path}/lines/${lineId}`, { specialInstructions: 'x'.repeat(301) })).status, 400);
  assert.equal((await api('client', 'PATCH', `${path}/lines/${lineId}`, { specialInstructions: 'Left staple' })).status, 200);
  assert.equal((await api('client', 'GET', path)).body.cart.lines[0].specialInstructions, 'Left staple');
});
test('legacy no-note acceptance remains compatible', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t, 'supplier_assigned', store => { delete store.orders[0].specialInstructions; });
  assert.equal((await api('supplier', 'POST', '/orders/order/transition', { state: 'payment_authorized' })).status, 200);
});
test('per-line notes require a tick, are immutable, and are searchable only by staff', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, 'supplier_assigned', store => {
    delete store.orders[0].specialInstructions; store.orderLineItems[0].specialInstructions = 'Darker outlines';
  });
  assert.equal((await api('supplier', 'POST', '/orders/order/transition', { state: 'payment_authorized' })).body.error, 'special_instructions_acknowledgement_required');
  const accepted = await api('supplier', 'POST', '/orders/order/transition', { state: 'payment_authorized', specialInstructionsRead: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const search = await api('ops', 'GET', '/ops/special-instructions?q=outlines');
  assert.equal(search.status, 200);
  assert.equal(search.body.orders[0].lines[0].text, 'Darker outlines');
  for (const actor of ['supplier', 'client', 'rider']) assert.equal((await api(actor, 'GET', '/ops/special-instructions?q=outlines')).status, 403);
  await assert.rejects(db.query("UPDATE order_line_items SET special_instructions='tampered'"));
});
test('zero-price changes apply only with client approval; declined or unpaid requests preserve original specifications', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  for (const actor of ['client', 'other', 'ops', 'replacement', 'rider', null]) {
    assert.equal((await api(actor, 'POST', '/orders/order/change-requests', { lineItemId: 'line', reason: 'New spec', proposedSpec: 'Left staple' })).status, actor ? 403 : 401);
  }
  const create = await api('supplier', 'POST', '/orders/order/change-requests', { lineItemId: 'line', reason: 'Confirmed finish', proposedSpec: 'Staple on left', proposedReadyBy: '2030-10-11T00:00:00Z' });
  const base = `/orders/order/change-requests/${create.body.changeRequest.id}`;
  assert.equal((await api('client', 'POST', `${base}/answer`, { expectedVersion: 1, answer: 'accept' })).body.changeRequest.status, 'applied');
  const stored = await loadStore(db);
  assert.equal(stored.orders[0].readyBy, '2030-10-11T00:00:00.000Z');
  assert.equal(stored.orders[0].promiseBy, '2030-10-11T01:00:00.000Z');
  assert.equal(stored.orderChangePayments.length, 0);
  const proposed = await api('supplier', 'POST', '/orders/order/change-requests', { lineItemId: 'line', reason: 'Different finish', proposedSpec: 'Right staple', extraPrincipalMinor: 1000 });
  const path = `/orders/order/change-requests/${proposed.body.changeRequest.id}`;
  await api('client', 'POST', `${path}/answer`, { expectedVersion: 1, answer: 'accept' });
  assert.equal((await api('client', 'GET', '/orders/order')).body.order.productionItems[0].agreedChange.proposedSpec, 'Staple on left');
  assert.equal((await api('client', 'POST', `${path}/answer`, { expectedVersion: 2, answer: 'decline' })).body.changeRequest.status, 'declined');
  const search = await api('ops', 'GET', '/ops/special-instructions?q=staple');
  assert.equal(search.body.orders.length, 1);
  await assert.rejects(db.query("UPDATE order_change_requests SET data=data || '{\"proposedSpec\":\"tampered\"}'::jsonb"));
});
test('supplement paid with final stage requires exact combined transfer receipt and cannot pay twice', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  await paidChange(api);
  await db.transaction(async () => {
    const store = await loadStore(db); store.orders[0].state = 'completed';
    store.files.push({ fileId: 'payout', ownerId: 'ops', purpose: 'payout_receipt', state: 'ready', objectKey: 'private/payout',
      originalFilename: 'payout.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT });
    await saveStore(db, store);
  });
  const path = '/orders/order/milestones/issue_window/release';
  assert.equal((await api('ops', 'POST', path, { reference: 'FINAL', receiptFileId: 'payout', amountMinor: 2500 })).body.error, 'supplement_payout_amount_mismatch');
  assert.notEqual((await loadStore(db)).orders[0].payoutMilestones.at(-1).status, 'released');
  const released = await api('ops', 'POST', path, { reference: 'FINAL', receiptFileId: 'payout', amountMinor: 3500 });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const after = await loadStore(db);
  assert.equal(after.orderChangePayouts[0].amountMinor, 1000);
  assert.equal(after.orders[0].payoutMilestones.at(-1).amountMinor, 2500);
  assert.equal(released.body.order.supplierSettlement.totalSupplierEarningsMinor, 11000);
  assert.equal(released.body.order.supplierSettlement.supplierReleasedMinor, 3500);
  await api('ops', 'POST', path, {});
  assert.equal((await loadStore(db)).orderChangePayouts.length, 1);
  await assert.rejects(db.query('DELETE FROM order_change_payments'));
  await assert.rejects(db.query('DELETE FROM order_change_payouts'));
});
test('refund includes verified supplemental principal and fee while original snapshots stay unchanged', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  await paidChange(api);
  const refund = await api('client', 'POST', '/orders/order/refund-requests', { kind: 'cancellation', reason: 'Cancel with shop agreement' });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  const preview = await api('ops', 'POST', `/refund-requests/${refund.body.refund.id}/settlement-preview`, { expectedVersion: 1, shopEntitlementMinor: 0, riderEntitlementMinor: 0 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.amounts.principalMinor, 11000);
  assert.equal(preview.body.amounts.feeMinor, 1100);
  assert.equal(preview.body.amounts.totalMinor, 13100);
  assert.equal((await loadStore(db)).orders[0].totalMinor, 12000);
});
test('frozen bracket increment excludes new discounts and refuses invalid amounts and late requests', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, 'production', store => {
    const order = store.orders[0];
    order.serviceFeeSchedule = { version: 2, rounding: 'half_up_once', brackets: [{ upToMinor: 200000, rateBps: 4500 }, { upToMinor: 2000000, rateBps: 2500 }, { upToMinor: null, rateBps: 1500 }] };
    order.serviceFeeWorking = [{ fromMinor: 0, upToMinor: 200000, rateBps: 4500, taxableMinor: 10000, amountMinor: 4500 }, { fromMinor: 200000, upToMinor: 2000000, rateBps: 2500, taxableMinor: 0, amountMinor: 0 }, { fromMinor: 2000000, upToMinor: null, rateBps: 1500, taxableMinor: 0, amountMinor: 0 }];
    order.serviceFeeRateBps = null; order.grossServiceFeeMinor = 4500;
    order.organizationDiscountRateBps = 500; order.organizationDiscountMinor = 500; order.serviceFeeMinor = 4000;
    order.totalMinor = order.onlineDueMinor = order.payments.initial.amountMinor = 15000;
    order.paymentAllocations[1].amountMinor = 4000;
    store.settings.serviceFeeSchedule = { version: 1, rateBps: 0 };
  });
  const input = { lineItemId: 'line', reason: 'Added finish', proposedSpec: 'Staple on left' };
  for (const extraPrincipalMinor of [-1, 0.5, '1000', Number.MAX_SAFE_INTEGER]) {
    assert.equal((await api('supplier', 'POST', '/orders/order/change-requests', { ...input, extraPrincipalMinor })).status, 400);
  }
  const create = await api('supplier', 'POST', '/orders/order/change-requests', { ...input, extraPrincipalMinor: 200000 });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const read = await api('ops', 'GET', `/orders/order/change-requests/${create.body.changeRequest.id}`);
  assert.equal(read.body.changeRequest.feeMinor, 88000); // fee(2100)=925; fee(100)=45 PHP.
  assert.equal(read.body.changeRequest.totalMinor, 288000);
  await db.transaction(async () => { const store = await loadStore(db); store.orders[0].state = 'ready_for_dispatch'; await saveStore(db, store); });
  assert.equal((await api('client', 'POST', `/orders/order/change-requests/${create.body.changeRequest.id}/answer`, { expectedVersion: 1, answer: 'accept' })).body.error, 'change_request_window_closed');
  assert.equal((await api('supplier', 'POST', '/orders/order/change-requests', input)).body.error, 'change_request_window_closed');
});
test('submitted proof cannot be stranded by shop cancellation; rejection keeps evidence and original terms', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const create = await api('supplier', 'POST', '/orders/order/change-requests', { lineItemId: 'line', reason: 'Extra finish', proposedSpec: 'Left staple', extraPrincipalMinor: 1000 });
  const base = `/orders/order/change-requests/${create.body.changeRequest.id}`;
  await api('client', 'POST', `${base}/answer`, { expectedVersion: 1, answer: 'accept' });
  await api('client', 'POST', `${base}/payment`, { expectedVersion: 2, proofFileId: 'extra_payment', reference: 'UNVERIFIED' });
  const cancelled = await api('supplier', 'POST', '/orders/order/shop-cancel', { reason: 'Cannot complete' });
  assert.equal(cancelled.body.error, 'change_payment_pending');
  assert.equal((await api('client', 'POST', '/orders/order/refund-requests', { kind: 'cancellation', reason: 'Cancel' })).body.error, 'change_payment_pending');
  assert.equal((await api('supplier', 'GET', `/files/extra_payment`)).status, 403);
  const rejected = await api('ops', 'POST', `${base}/payment/reject`, { expectedVersion: 3, reason: 'No matching transfer' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const stored = await loadStore(db);
  assert.equal(stored.orderChanges[0].status, 'pending_payment');
  assert.equal(stored.orderChanges[0].data.paymentHistory[0].proofFileId, 'extra_payment');
  assert.equal(stored.orderChangePayments.length, 0);
  assert.equal(stored.orders[0].shopRecovery, undefined);
});
test('concurrent requests and payment retries serialize to one proposal and one collection', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const input = { lineItemId: 'line', reason: 'Added finish', proposedSpec: 'Left staple', extraPrincipalMinor: 1000 };
  const results = await Promise.all([api('supplier', 'POST', '/orders/order/change-requests', input), api('supplier', 'POST', '/orders/order/change-requests', input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const base = `/orders/order/change-requests/${results.find(r => r.status === 201).body.changeRequest.id}`;
  await api('client', 'POST', `${base}/answer`, { expectedVersion: 1, answer: 'accept' });
  await api('client', 'POST', `${base}/payment`, { expectedVersion: 2, proofFileId: 'extra_payment', reference: 'RACE' });
  const body = { expectedVersion: 3, amountMinor: 1100, reason: 'Transfer verified' };
  const answers = await Promise.all([api('ops', 'POST', `${base}/payment/confirm`, body, { key: 'same-confirmation' }), api('ops', 'POST', `${base}/payment/confirm`, body, { key: 'same-confirmation' })]);
  assert.deepEqual(answers.map(r => r.status), [200, 200]);
  assert.equal((await loadStore(db)).orderChangePayments.length, 1);
  await assert.rejects(db.query("UPDATE order_payments SET data=data || '{\"reference\":\"RACE\"}'::jsonb WHERE order_id='order' AND code='initial'"));
});
test('refund settlement persists the full supplement and supersedes its unpaid final obligation', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  await paidChange(api);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.files.push({ fileId: 'refundqr', ownerId: 'client', purpose: 'refund_qr', state: 'ready', objectKey: 'private/refundqr',
      originalFilename: 'qr.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT });
    await saveStore(db, store);
  });
  const filed = await api('client', 'POST', '/orders/order/refund-requests', { kind: 'cancellation', reason: 'Shop agrees to full refund' });
  const base = `/refund-requests/${filed.body.refund.id}`;
  const destination = await api('client', 'PATCH', `${base}/destination`, { expectedVersion: 1, qrFileId: 'refundqr', provider: 'gcash', accountName: 'Client', ownershipConfirmed: true });
  assert.equal(destination.status, 200, JSON.stringify(destination.body));
  const review = await api('ops', 'POST', `${base}/review`, { expectedVersion: 2, reason: 'Receiving account verified', destinationVerified: true });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const settled = await api('ops', 'POST', `${base}/settle`, { expectedVersion: 3, reason: 'Agreed full cancellation', workStopped: true,
    shopAgreement: 'Shop waived all work including additional staple', deliveryEvidence: 'Not dispatched', shopEntitlementMinor: 0, riderEntitlementMinor: 0, totalMinor: 13100 });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  const stored = await loadStore(db);
  assert.equal(stored.refundSettlements[0].totalMinor, 13100);
  const read = await api('ops', 'GET', '/orders/order');
  assert.equal(read.body.order.changeRequests[0].payout.status, 'superseded');
  assert.equal((await api('ops', 'POST', '/orders/order/milestones/issue_window/release', {})).status, 409);
});
test('unpaid proposal closes during shop recovery and never follows the replacement', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const created = await api('supplier', 'POST', '/orders/order/change-requests', { lineItemId: 'line', reason: 'Need more finishing', proposedSpec: 'Left staple', extraPrincipalMinor: 1000 });
  assert.equal(created.status, 201);
  const cancellation = await api('supplier', 'POST', '/orders/order/shop-cancel', { reason: 'Special instructions not possible' });
  assert.equal(cancellation.status, 200, JSON.stringify(cancellation.body));
  const stored = await loadStore(db);
  assert.equal(stored.orderChanges[0].status, 'closed');
  assert.ok(stored.auditLog.some(row => row.action === 'order.change_closed'));
  assert.equal(stored.orderChangePayments.length, 0);
});
