import { alwaysOpenOperatingHours } from './helpers/operating-hours.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { runReviewDataCommand } from '../src/review-data-cli.js';
import { resetDatabase } from './fixtures/reset-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
test('PostgreSQL review marking, immutable snapshots, assignment, queues and money refusals', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, funnel_events RESTART IDENTITY CASCADE');
  await db.transaction(() => saveStore(db, fixture()));
  const api = await apiForTest(t);
  const mark = (who, on, version = 1, actor = 'admin') => api(actor, 'PATCH', `/users/${who}/review-data`, {
    reviewData: on, expectedVersion: version, reason: 'Isolated review fixture',
  });
  assert.equal((await mark('client', true, 1, 'ops')).status, 403);
  assert.equal((await mark('client', true)).status, 200);
  assert.equal((await mark('client', true)).body.error, 'user_version_conflict');
  assert.equal((await mark('replacement', true)).status, 200);
  for (const [viewer, expected] of [[null, 'supplier'], ['other', 'supplier'], ['client', 'replacement']]) {
    const catalogue = await api(viewer, 'GET', '/catalog/shops?includeReviewData=1');
    assert.deepEqual(catalogue.body.shops.map(shop => shop.supplierId), [expected]);
    assert.match(catalogue.headers.get('cache-control'), /private.*no-store/);
  }
  for (const [viewer, expected] of [['other', 'supplier'], ['client', 'replacement']]) {
    const match = await api(viewer, 'POST', '/me/matches', { subcategoryCode: 'flyers',
      ranking: ['quality', 'speed', 'cost', 'distance'], fulfillmentMode: 'delivery',
      dropoff: { lat: 7.07, lng: 125.61, label: 'Dropoff' } });
    assert.equal(match.status, 200, JSON.stringify(match.body));
    assert.equal(match.body.shop.supplierId, expected);
  }

  assert.equal((await loadStore(db)).orders[0].reviewData, false);
  await db.transaction(async () => {
    const store = await loadStore(db);
    const order = structuredClone(store.orders[0]);
    Object.assign(order, { id: 'review_order', supplierId: 'replacement', reviewData: true, state: 'ready_for_dispatch',
      readyBy: null, operatingClock: null, rescheduleRequest: null });
    order.payments.initial.status = 'not_submitted';
    store.orders.push(order);
    for (const row of store.orders) store.supplierInvoices.push({ orderId: row.id, supplierId: row.supplierId,
      expectedAt: AT, month: '2026-10', fileId: null, number: null, date: null, amountMinor: null,
      submittedAt: null, updatedAt: null, version: 0, collectedAt: null, collectedBy: null });
    store.orders[0].state = 'ready_for_dispatch';
    await saveStore(db, store);
  });
  let response = await api('ops', 'GET', '/orders');
  assert.deepEqual(response.body.orders.map(o => o.id), ['order']);
  response = await api('ops', 'GET', '/orders?includeReviewData=1');
  assert.equal(response.body.orders.length, 2);
  const finance = await api('ops', 'GET', '/ops/finance/supplier-invoices?month=2026-10');
  assert.equal(finance.body.totals.expected, 1);
  const reviewFinance = await api('ops', 'GET', '/ops/finance/supplier-invoices?month=2026-10&includeReviewData=1');
  assert.equal(reviewFinance.body.totals.expected, 1);
  assert.equal((await api('replacement', 'GET', '/me/supplier-invoices?month=2026-10&includeReviewData=1')).body.totals.expected, 0);
  const detail = await api('admin', 'GET', '/users/replacement');
  assert.equal(detail.body.user.version, 2);
  assert.equal(detail.body.user.reviewData, true);
  assert.equal((await api('client', 'GET', '/orders')).body.orders.length, 2);
  response = await api('rider', 'GET', '/dispatch/offers');
  assert.deepEqual(response.body.offers.map(o => o.id), ['order']);
  assert.equal((await api('rider', 'POST', '/dispatch/review_order/accept', {})).body.error, 'review_data_assignment_mismatch');
  assert.equal((await mark('rider', true)).status, 200);
  response = await api('rider', 'GET', '/dispatch/offers');
  assert.deepEqual(response.body.offers.map(o => o.id), ['review_order']);
  const assertDisplaySplit = order => {
    assert.equal(order.deliveryFeeMinor, 1000);
    assert.equal(order.riderCommissionBps, 8500);
    assert.equal(order.riderPayoutMinor, 850);
    assert.equal(order.platformDeliveryShareMinor, 150);
  };
  assertDisplaySplit(response.body.offers[0]);
  assert.equal((await api('rider', 'POST', '/dispatch/order/accept', {})).body.error, 'review_data_assignment_mismatch');
  assert.equal((await api('rider', 'POST', '/dispatch/review_order/accept', {})).status, 200);
  assertDisplaySplit((await api('rider', 'GET', '/orders/review_order')).body.order);
  assertDisplaySplit((await api('rider', 'GET', '/orders')).body.orders.find(o => o.id === 'review_order'));
  assert.equal((await api('admin', 'POST', '/orders/review_order/milestones/production_started/release', {})).body.error, 'review_data_money_forbidden');
  assert.equal((await api('client', 'POST', '/funnel-events', { kind: 'product_viewed', productCode: 'review-product' })).status, 201);
  assert.equal((await mark('client', false, 2)).status, 200);
  const pricing = await api('admin', 'GET', '/admin/pricing');
  assert.equal(pricing.body.period.funnel.counts.product_viewed, 0);
  const included = await api('admin', 'GET', '/admin/pricing?includeReviewData=1');
  assert.equal(included.body.period.funnel.counts.product_viewed, 0);
  const audit = await api('admin', 'GET', '/audit?format=csv', undefined, { raw: true });
  assert.doesNotMatch(audit.body, /review_order/);
  const reviewAudit = await api('admin', 'GET', '/audit?format=csv&includeReviewData=1', undefined, { raw: true });
  assert.match(reviewAudit.body, /review_order/);
  await db.transaction(async () => {
    const store = await loadStore(db); store.orders.find(o => o.id === 'review_order').title = 'Retained snapshot';
    await saveStore(db, store);
  });
  const saved = await loadStore(db);
  assert.equal(saved.orders.find(o => o.id === 'review_order').reviewData, true);
  assert.equal(saved.orders.find(o => o.id === 'order').reviewData, false);
  assert.ok(saved.orders.find(o => o.id === 'review_order').payoutMilestones.every(stage => stage.status !== 'released'));
  assert.equal(saved.auditLog.filter(a => a.action === 'user.review_data_change').length, 4);
  assert.ok(saved.notifications.filter(n => n.orderId === 'review_order').every(n => n.title.startsWith('[Review data]')));
  const command = await runReviewDataCommand(['rider', '--off', '--reason', 'End isolated review fixture'], db);
  assert.equal(command.reviewData, false);
  const systemAudit = (await loadStore(db)).auditLog.filter(a => a.action === 'user.review_data_change' && a.actorRole === 'system');
  assert.equal(systemAudit.length, 1);
  assert.equal(systemAudit[0].actorId, null);
  await assert.rejects(db.transaction(() => db.query("UPDATE orders SET review_data=false WHERE id='review_order'")), /review_data_snapshot_immutable/);
});

import { PICKUP_CHECK_CODES, moneyReportingForOrder } from '../src/operational-model.js';
const checked = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};
async function paymentSetup(t, reviewData, downpaymentPercent = 75) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, funnel_events RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orders = []; store.orderJobs = []; store.orderLineItems = [];
  store.settings.downpaymentPercent = downpaymentPercent;
  store.settings.operatingHours = alwaysOpenOperatingHours();
  // Staff stay unmarked: a marked ops_admin is a test operations account.
  for (const user of store.users) if (!['ops', 'admin'].includes(user.id)) user.reviewData = reviewData;
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1,
    applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT });
  for (const [fileId, purpose, ownerId] of [['artwork', 'artwork', 'client'], ['receipt', 'payment_proof', 'client'],
    ['finished', 'finished_product_photo', 'supplier'], ['packed', 'packing_photo', 'rider'],
    ['signature', 'handoff_signature', 'rider'], ['delivered', 'delivery_photo', 'rider']]) {
    store.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, size: 100,
      originalFilename: fileId === 'artwork' ? 'artwork.pdf' : 'image.png',
      detectedContentType: fileId === 'artwork' ? 'application/pdf' : 'image/png',
      declaredContentType: fileId === 'artwork' ? 'application/pdf' : 'image/png',
      artworkCheck: { status: 'passed', checkedAt: AT }, createdAt: AT, references: [] });
  }
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  const cart = checked(await api('client', 'POST', '/me/carts', { fulfillmentMode: 'delivery',
    deadline: new Date(Date.now() + 90 * 86400000).toISOString(),
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Destination' } }), 201).cart;
  const add = async supplier => checked(await api('client', 'POST', `/me/carts/${cart.id}/lines`, {
    catalogItemId: `item_${supplier}`, quantity: 2, optionIds: [], artworkFileId: 'artwork',
  }), 201);
  const payment = { method: 'qr_manual', proofFileId: 'receipt', reference: 'REVIEW-TEST' };
  const checkout = () => api('client', 'POST', `/me/carts/${cart.id}/checkout`, { payment });
  return { db, api, add, payment, checkout };
}

for (const reviewData of [true, false]) test(`checkout, installments and delivery preserve work flow (review=${reviewData})`, { skip: !DATABASE_URL }, async t => {
  const { db, api, add, payment, checkout } = await paymentSetup(t, reviewData);
  await add('supplier');
  const placed = checked(await checkout(), 201).order;
  const orderId = placed.id;
  const post = (actor, path, body = {}) => api(actor, 'POST', `/orders/${orderId}/${path}`, body);
  const initial = (await loadStore(db)).orders.find(o => o.id === orderId).payments.initial;
  assert.equal(initial.status, 'pending_confirmation');
  assert.equal(initial.simulated, reviewData ? true : undefined);
  assert.equal((await post('client', 'payments/initial/confirm')).status, 403);
  checked(await post('ops', 'payments/initial/reject', { reason: 'Resubmit receipt' }));
  checked(await post('client', 'payments/initial/submit', payment));
  const confirmed = checked(await post('ops', 'payments/initial/confirm')).order;
  assert.equal(confirmed.state, 'needs_qa');
  assert.equal((await post('ops', 'payments/initial/confirm')).body.error, 'payment_not_pending');
  let persisted = (await loadStore(db)).orders.find(o => o.id === orderId);
  assert.equal(persisted.payments.initial.confirmationSource, reviewData ? 'review_data' : 'manual_ops');
  // Account changes cannot convert a historical simulation into real money.
  if (reviewData) checked(await api('admin', 'PATCH', '/users/client/review-data', {
    reviewData: false, expectedVersion: 1, reason: 'Verify immutable payment scope',
  }));
  checked(await post('client', 'payments/final_online/submit', payment));
  checked(await post('ops', 'payments/final_online/confirm'));
  checked(await post('ops', 'transition', { state: 'supplier_assigned',
    qaChecklist: { artwork: true, spec: true, quantity: true, address: true } }));
  checked(await post('supplier', 'transition', { state: 'payment_authorized' }));
  checked(await post('supplier', 'transition', { state: 'production' }));
  const attach = async (fileId, actor) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await api(actor, 'POST', `/files/${fileId}/attach`, { orderId });
      if (response.body.error !== 'storage_initializing') return checked(response);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('test storage did not initialize');
  };
  await attach('finished', 'supplier');
  checked(await post('supplier', 'production-finished'));
  checked(await post('ops', 'production-review', { decision: 'approved' }));
  checked(await post('supplier', 'transition', { state: 'ready_for_dispatch' }));
  checked(await api('rider', 'POST', `/dispatch/${orderId}/accept`, {}));
  const lines = (await loadStore(db)).orderLineItems.filter(line => line.orderId === orderId);
  checked(await api('rider', 'POST', `/dispatch/${orderId}/pickup-checklist`, {
    checks: PICKUP_CHECK_CODES.map(code => ({ code, passed: true })),
    counts: lines.map(line => ({ lineItemId: line.id, countedQuantity: line.quantity })),
  }));
  await attach('packed', 'rider'); await attach('signature', 'rider');
  checked(await api('rider', 'POST', `/dispatch/${orderId}/pickup-confirm`, {
    signature: { fileId: 'signature', signerName: 'Reviewer' },
  }));
  checked(await post('rider', 'transition', { state: 'out_for_delivery' }));
  await attach('delivered', 'rider');
  const handover = checked(await api('client', 'GET', `/orders/${orderId}/handover`)).handover;
  const delivered = checked(await api('rider', 'POST', `/dispatch/${orderId}/delivery`, {
    evidenceType: 'photo', evidenceFileId: 'delivered', otp: handover?.otp,
  })).order;
  assert.equal(delivered.state, 'issue_window_open');
  assert.equal(checked(await post('client', 'confirm')).order.state, 'completed');
  persisted = (await loadStore(db)).orders.find(o => o.id === orderId);
  assert.equal(persisted.payments.final_online.confirmationSource, reviewData ? 'review_data' : 'manual_ops');
  assert.ok(persisted.payoutMilestones.every(stage => stage.status !== 'released'));
  // Earnings and past jobs both read the rider's /orders collection.
  const riderHistory = checked(await api('rider', 'GET', '/orders')).orders.find(o => o.id === orderId);
  const riderDetail = checked(await api('rider', 'GET', `/orders/${orderId}`)).order;
  for (const view of [riderHistory, riderDetail]) {
    assert.equal(view.riderPayoutMinor, Math.round(persisted.deliveryFeeMinor * persisted.riderCommissionBps / 10000));
    assert.equal(view.platformDeliveryShareMinor, persisted.deliveryFeeMinor - view.riderPayoutMinor);
    assert.ok(view.riderPayoutMinor > 0);
  }
  const report = moneyReportingForOrder(persisted);
  assert.equal(report.platformRevenue.collectedMinor > 0, !reviewData);
  for (const suffix of ['', '&includeReviewData=1']) {
    const finance = checked(await api('ops', 'GET', `/ops/finance/supplier-invoices?month=${new Date().toISOString().slice(0, 7)}${suffix}`));
    assert.equal(finance.totals.expected, reviewData ? 0 : 1);
    const pricing = checked(await api('admin', 'GET', `/admin/pricing?period=this_month${suffix}`));
    assert.equal(pricing.completedThisMonth, reviewData ? 0 : 1);
  }
  if (reviewData) {
    assert.equal(checked(await api('ops', 'GET', '/orders')).orders.length, 0);
    assert.equal(checked(await api('ops', 'GET', '/orders?includeReviewData=1')).orders.length, 1);
    const auditCsv = await api('admin', 'GET', '/audit?format=csv', undefined, { raw: true });
    assert.ok(!auditCsv.body.includes(orderId));
    const sqlPayment = (await db.query('SELECT data FROM order_payments WHERE order_id=$1 AND code=$2', [orderId, 'initial'])).rows[0].data;
    assert.equal(sqlPayment.simulated, true); assert.equal(sqlPayment.confirmationSource, 'review_data');
    assert.equal((await post('ops', 'transition', { state: 'payout_released' })).body.error, 'review_data_money_forbidden');
    for (const code of ['production_started', 'delivered', 'issue_window']) {
      assert.equal((await post('ops', `milestones/${code}/release`)).body.error, 'review_data_money_forbidden');
    }
    // A request may exist for inspection; all money/reservation actions refuse it.
    await db.transaction(async () => {
      const store = await loadStore(db);
      store.refundRequests.push({ id: 'review_refund', orderId, clientId: 'client', kind: 'complaint', status: 'requested',
        reason: 'Review test', policyVersion: 'available_funds_v1', beforeProduction: false, late: false,
        orderStateAtFiling: 'completed', evidenceFileIds: [], version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await saveStore(db, store);
    });
    for (const action of ['settle', 'payment-attempts', 'payments', 'supplier-payout']) {
      const refused = await api('ops', 'POST', `/refund-requests/review_refund/${action}`, {});
      assert.equal(refused.body.error, 'review_data_money_forbidden', JSON.stringify(refused.body));
    }
    const saved = await loadStore(db);
    assert.equal(saved.refundPayments.length, 0); assert.equal(saved.refundAttempts.length, 0);
    assert.equal(saved.refundSettlements.length, 0);
  }
});

for (const reviewData of [true, false]) test(`basket payment simulation is atomic across groups (review=${reviewData})`, { skip: !DATABASE_URL }, async t => {
  const { db, api, add, payment, checkout } = await paymentSetup(t, reviewData);
  await add('supplier'); await add('replacement');
  const basket = checked(await checkout(), 201).basket;
  assert.ok(basket.id);
  assert.equal(checked(await api('ops', 'GET', '/baskets')).baskets.length, reviewData ? 0 : 1);
  assert.equal(checked(await api('ops', 'GET', '/baskets?includeReviewData=1')).baskets.length, 1);
  assert.equal(checked(await api('client', 'GET', '/baskets')).baskets.length, 1);
  const path = `/baskets/${basket.id}/payment`;
  checked(await api('ops', 'POST', `${path}/reject`, { reason: 'Resubmit receipt' }));
  checked(await api('client', 'POST', `${path}/submit`, payment));
  const confirmed = checked(await api('ops', 'POST', `${path}/confirm`, {})).basket;
  assert.ok(confirmed.groups.every(group => group.state === 'needs_qa'));
  const saved = await loadStore(db);
  assert.equal(saved.baskets[0].payment.confirmationSource, reviewData ? 'review_data' : 'manual_ops');
  for (const order of saved.orders) {
    assert.equal(order.payments.initial.simulated, reviewData ? true : undefined);
    assert.equal(order.payments.initial.confirmationSource, reviewData ? 'review_data' : 'manual_ops');
    assert.equal(order.payments.final_online.status, 'not_required');
  }
});
