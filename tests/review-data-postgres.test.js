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
  assert.equal(reviewFinance.body.totals.expected, 2);
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
  assert.equal((await api('rider', 'POST', '/dispatch/order/accept', {})).body.error, 'review_data_assignment_mismatch');
  assert.equal((await api('rider', 'POST', '/dispatch/review_order/accept', {})).status, 200);
  assert.equal((await api('admin', 'POST', '/orders/review_order/milestones/production_started/release', {})).body.error, 'review_data_money_forbidden');
  assert.equal((await api('client', 'POST', '/funnel-events', { kind: 'product_viewed', productCode: 'review-product' })).status, 201);
  assert.equal((await mark('client', false, 2)).status, 200);
  const pricing = await api('admin', 'GET', '/admin/pricing');
  assert.equal(pricing.body.period.funnel.counts.product_viewed, 0);
  const included = await api('admin', 'GET', '/admin/pricing?includeReviewData=1');
  assert.equal(included.body.period.funnel.counts.product_viewed, 1);
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
  assert.equal(saved.auditLog.filter(a => a.action === 'user.review_data_change').length, 4);
  assert.ok(saved.notifications.filter(n => n.orderId === 'review_order').every(n => n.title.startsWith('[Review data]')));
  const command = await runReviewDataCommand(['rider', '--off', '--reason', 'End isolated review fixture'], db);
  assert.equal(command.reviewData, false);
  const systemAudit = (await loadStore(db)).auditLog.filter(a => a.action === 'user.review_data_change' && a.actorRole === 'system');
  assert.equal(systemAudit.length, 1);
  assert.equal(systemAudit[0].actorId, null);
  await assert.rejects(db.transaction(() => db.query("UPDATE orders SET review_data=false WHERE id='review_order'")), /review_data_snapshot_immutable/);
});
