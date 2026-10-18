import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, AT, id } from './fixtures/reschedule.js';
import { routeSupplierCatalog } from '../src/catalog-routes.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { routeOrganizationStatements } from '../src/organization-statements.js';

const call = (route, store, user, path, method = 'GET', body = {}) => route({ store, user,
  req: { method }, url: new URL(path, 'http://test'), readBody: async () => body, now: () => AT, id });

test('catalogue isolates review shops in both directions, including direct items and media', async () => {
  const store = fixture();
  store.users.find(u => u.id === 'supplier').reviewData = true;
  for (const [user, expected, hidden] of [[null, 'replacement', 'supplier'], [{ id: 'client', role: 'client' }, 'replacement', 'supplier'],
    [{ id: 'client', role: 'client', reviewData: true }, 'supplier', 'replacement']]) {
    const response = await call(routeSupplierCatalog, store, user, '/catalog/shops');
    assert.deepEqual(response.body.shops.map(s => s.supplierId), [expected]);
    for (const path of [`/catalog/shops/${hidden}`, `/catalog/items/item_${hidden}`, `/catalog/media/photo_${hidden}`]) {
      assert.equal((await call(routeSupplierCatalog, store, user, path)).status, 404);
    }
  }
});

test('matching never offers a shop across the review boundary', async () => {
  const store = fixture();
  store.users.find(u => u.id === 'supplier').reviewData = true;
  for (const reviewData of [false, true]) {
    const user = store.users.find(u => u.id === 'client'); user.reviewData = reviewData;
    const result = await call(routeOrderMatch, store, user, '/me/matches', 'POST', {
      subcategoryCode: 'flyers', ranking: ['quality', 'speed', 'cost', 'distance'],
      dropoff: { lat: 7.07, lng: 125.61, label: 'Dropoff' }, fulfillmentMode: 'delivery',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.shop.supplierId, reviewData ? 'supplier' : 'replacement');
  }
});

test('statement totals and CSV exclude review orders; only staff can opt in', () => {
  const store = fixture();
  store.users.find(u => u.id === 'client').accountType = 'organization';
  store.approvalCases.push({ userId: 'client', kind: 'business_client', status: 'approved' });
  store.orders[0].state = 'completed'; store.orders[0].timeline.push({ state: 'completed', at: AT });
  store.orders.push({ ...structuredClone(store.orders[0]), id: 'review_order', reviewData: true, totalMinor: 99000 });
  const run = (user, path) => routeOrganizationStatements({ req: { method: 'GET' }, url: new URL(path, 'http://test'), store, user, now: () => AT });
  const path = '/ops/organizations/client/statements?period=this_month';
  assert.equal(run({ role: 'super_admin' }, path).body.statement.totalSpendMinor, 12000);
  assert.equal(run({ role: 'super_admin' }, `${path}&includeReviewData=1`).body.statement.totalSpendMinor, 111000);
  assert.doesNotMatch(run({ role: 'super_admin' }, `${path}&format=csv`).bytes.toString(), /review_order/);
  assert.match(run({ role: 'super_admin' }, `${path}&format=csv&includeReviewData=1`).bytes.toString(), /review_order/);
  assert.equal(run({ id: 'client', role: 'client' }, '/me/organization/statements?includeReviewData=1').body.statement.orderCount, 1);
});

import { enforceReviewData, setReviewData, reviewReportView, labelReviewNotifications } from '../src/review-data.js';

test('order marks snapshot the client, preserve history and fence new assignments both ways', () => {
  for (const reviewData of [false, true]) {
    const store = fixture(); store.orders = []; store.orderJobs = [];
    store.users.find(u => u.id === 'client').reviewData = reviewData;
    store.users.find(u => u.id === 'supplier').reviewData = reviewData;
    store.users.find(u => u.id === 'rider').reviewData = reviewData;
    store.orders.push({ id: 'new', clientId: 'client', supplierId: 'supplier', riderId: 'rider', reviewData: !reviewData });
    enforceReviewData(store, { orders: [] });
    assert.equal(store.orders[0].reviewData, reviewData);
    const before = structuredClone(store);
    store.users.find(u => u.id === 'client').reviewData = !reviewData;
    enforceReviewData(store, before);
    assert.equal(store.orders[0].reviewData, reviewData);
    store.orders[0].reviewData = !reviewData;
    assert.throws(() => enforceReviewData(store, before), { code: 'review_data_snapshot_immutable' });
    store.orders[0].reviewData = reviewData;
    const unassigned = structuredClone(before); unassigned.orders[0].riderId = null;
    store.users.find(u => u.id === 'rider').reviewData = !reviewData;
    assert.throws(() => enforceReviewData(store, unassigned), { code: 'review_data_assignment_mismatch' });
  }
});

test('review mark requires Super Admin, reason and current version and audits system setup identically', () => {
  const store = fixture();
  const input = { reviewData: true, expectedVersion: 1, reason: 'Store review setup' };
  assert.throws(() => setReviewData(store, { role: 'ops_admin' }, 'client', input), { code: 'forbidden' });
  assert.throws(() => setReviewData(store, { role: 'super_admin' }, 'client', { ...input, reason: '' }), { code: 'reason_required' });
  assert.throws(() => setReviewData(store, { role: 'super_admin' }, 'client', { ...input, expectedVersion: 2 }), { code: 'user_version_conflict' });
  setReviewData(store, { id: 'admin', role: 'super_admin' }, 'client', input);
  setReviewData(store, { role: 'system' }, 'client', { ...input, reviewData: false, expectedVersion: 2 });
  assert.equal(store.auditLog.length, 2);
  assert.deepEqual(store.auditLog.map(a => [a.action, a.actorRole, a.before.reviewData, a.after.reviewData]), [
    ['user.review_data_change', 'super_admin', false, true], ['user.review_data_change', 'system', true, false],
  ]);
  assert.equal(store.users.find(u => u.id === 'client').version, 3);
});

test('review money cannot be collected, reserved or released through graph writers', () => {
  const before = fixture(); before.orders[0].reviewData = true;
  for (const mutate of [
    s => { s.orders[0].payoutMilestones[0].status = 'released'; },
    s => { s.orders[0].payments.initial.reference = 'new-transfer'; },
    s => { s.orders[0].state = 'payout_released'; },
    s => { s.refundRequests.push({ id: 'r', orderId: 'order' }); s.refundAttempts.push({ id: 'a', requestId: 'r', status: 'in_progress' }); },
    s => { s.orderChangePayments.push({ id: 'p', orderId: 'order' }); },
    s => { s.deliveryPinPayments.push({ id: 'p', orderId: 'order' }); },
    s => { s.orders[0].deliveryPin = { change: { status: 'pending_confirmation' } }; },
    s => { s.orderChanges.push({ id: 'change', orderId: 'order', status: 'pending_confirmation' }); },
  ]) {
    const store = structuredClone(before); mutate(store);
    assert.throws(() => enforceReviewData(store, before), { code: 'review_data_money_forbidden' });
  }
  const real = fixture(), store = structuredClone(real); store.orders[0].payoutMilestones[0].status = 'released';
  assert.doesNotThrow(() => enforceReviewData(store, real));
});

test('queue views remove review orders and children without changing the writable graph; notices are labelled', () => {
  const store = fixture(); store.orders[0].reviewData = true;
  store.claims.push({ id: 'claim', orderId: 'order' });
  const view = reviewReportView(store);
  assert.equal(view.orders.length, 0); assert.equal(view.orderJobs.length, 0); assert.equal(view.claims.length, 0);
  assert.equal(store.orders.length, 1); assert.equal(reviewReportView(store, true).orders.length, 1);
  assert.throws(() => enforceReviewData(view, store), /read-only/);
  store.notifications.push({ id: 'n', orderId: 'order', title: 'Production started', appRole: 'ops_admin' });
  labelReviewNotifications(store, { notifications: [] });
  assert.equal(store.notifications[0].reviewData, true);
  assert.match(store.notifications[0].title, /^\[Review data\]/);
});

import { releaseMilestone, expireIssueWindows, createPayoutMilestones } from '../src/operational-model.js';
import { pricingDashboard } from '../src/pricing-dashboard.js';
import { canAccessOrder } from '../src/notifications.js';
import { findRescheduleReplacement } from '../src/order-reschedule-match.js';

test('legacy issue-window completion never releases review retention', () => {
  const store = fixture(), order = store.orders[0];
  order.reviewData = true; order.payoutPlanVersion = 1; order.state = 'issue_window_open';
  order.issueWindowExpiresAt = AT; order.payoutMilestones = createPayoutMilestones(order, { version: 1 });
  order.payoutMilestones.find(p => p.code === 'retention').pofFileIds = ['proof'];
  assert.equal(expireIssueWindows(store, '2026-10-06T00:00:00Z'), true);
  assert.equal(order.state, 'completed');
  assert.notEqual(order.payoutMilestones.find(p => p.code === 'retention').status, 'released');
  assert.throws(() => releaseMilestone(order, 'retention', { role: 'super_admin' }, AT, store), { code: 'review_data_money_forbidden' });
});

test('pricing month-end totals exclude review orders unless explicitly included', () => {
  const store = fixture(); store.orders[0].state = 'completed'; store.orders[0].completedAt = AT;
  store.orders[0].timeline.push({ state: 'completed', at: AT });
  store.orders.push({ ...structuredClone(store.orders[0]), id: 'review', reviewData: true });
  const input = { orders: store.orders, users: store.users, now: AT };
  assert.equal(pricingDashboard(input).completedThisMonth, 1);
  assert.equal(pricingDashboard({ ...input, query: { includeReviewData: '1' } }).completedThisMonth, 2);
});

test('rider offer notifications and replacement matching respect the order snapshot', () => {
  const store = fixture(), order = store.orders[0]; order.state = 'ready_for_dispatch'; order.reviewData = true;
  assert.equal(canAccessOrder(store, 'rider', order, { role: 'rider', offer: true }), false);
  store.users.find(u => u.id === 'rider').reviewData = true;
  assert.equal(canAccessOrder(store, 'rider', order, { role: 'rider', offer: true }), true);
  order.state = 'production';
  assert.equal(findRescheduleReplacement(store, order, AT), null);
});

import { publicFeaturedPrints } from '../src/featured-prints.js';
import { shopRating } from '../src/shop-rating.js';
import { performanceCounts } from '../src/supplier-performance-policy.js';

test('featured catalogue respects the viewer and review history never changes ordinary quality totals', () => {
  const store = fixture();
  store.users.find(u => u.id === 'supplier').reviewData = true;
  store.settings.featuredPrints = { catalogItemIds: ['item_supplier', 'item_replacement'] };
  assert.deepEqual(publicFeaturedPrints(store, { reviewData: true }).items.map(row => row.id), ['item_supplier']);
  assert.deepEqual(publicFeaturedPrints(store).items.map(row => row.id), ['item_replacement']);
  store.orders[0].reviewData = true;
  store.shopReviews.push({ orderId: 'order', supplierId: 'supplier', qualityStars: 5 });
  store.supplierPerformanceEvents.push({ orderId: 'order', supplierId: 'supplier', kind: 'late_finish', at: AT });
  assert.equal(shopRating(store, 'supplier'), null);
  assert.equal(performanceCounts(store, 'supplier', AT).lateFinishes, 0);
  assert.equal(shopRating(reviewReportView(store, true), 'supplier').count, 1);
  assert.equal(performanceCounts(reviewReportView(store, true), 'supplier', AT).lateFinishes, 1);
});

import { pushMessageFor } from '../src/push.js';
test('review notifications stay labelled in private push copy without extending push data', () => {
  const push = pushMessageFor({ id: 'notice', type: 'ops_payment_submitted', orderId: 'review', reviewData: true,
    title: '[Review data] Payment submitted', at: AT });
  assert.match(push.title, /Review data/);
  assert.deepEqual(Object.keys(push.data).sort(), ['at', 'notificationId', 'orderId', 'type']);
});

test('review credits and voucher reservations cannot consume real budgets', () => {
  const before = fixture(); before.users.find(u => u.id === 'client').reviewData = true;
  for (const mutate of [
    s => { s.credits.client = { balanceMinor: 100, ledger: [{ id: 'credit', amountMinor: 100 }] }; },
    s => { s.vouchers.push({ id: 'v', clientId: 'client', status: 'available', valueMinor: 100 }); },
    s => { s.voucherReservations.push({ id: 'v', clientId: 'client', status: 'reserved' }); },
  ]) {
    const store = structuredClone(before); mutate(store);
    assert.throws(() => enforceReviewData(store, before), { code: 'review_data_money_forbidden' });
  }
});

import { surveyReport } from '../src/surveys.js';
import { checkoutExitReport } from '../src/pricing-feedback.js';
import { shopScoreboard } from '../src/shop-reviews.js';
test('survey exports, checkout feedback and shop summaries exclude review activity', () => {
  const store = fixture(); store.orders[0].reviewData = true;
  store.users.find(u => u.id === 'client').reviewData = true;
  store.orderSurveys.push({ orderId: 'order', clientId: 'client', submittedAt: AT, qualityStars: 5 });
  store.checkoutExitPrompts.push({ id: 'prompt', clientId: 'client', cartId: 'cart', reachedAt: AT, askedAt: AT,
    categoryCodes: [], answeredAt: AT, reason: 'just_browsing' });
  store.shopReviews.push({ id: 'review', orderId: 'order', supplierId: 'supplier', qualityStars: 5, speedStars: 5, valueStars: 5, createdAt: AT });
  const ordinary = reviewReportView(store);
  assert.equal(surveyReport(ordinary, new URLSearchParams()).total, 0);
  assert.doesNotMatch(surveyReport(ordinary, new URLSearchParams('format=csv')).bytes.toString(), /"client"/);
  assert.equal(checkoutExitReport(ordinary, new URLSearchParams()).total, 0);
  assert.equal(surveyReport(reviewReportView(store, true), new URLSearchParams()).total, 1);
  assert.equal(checkoutExitReport(reviewReportView(store, true), new URLSearchParams()).total, 1);
  assert.equal(shopScoreboard(store).shops.find(shop => shop.supplierId === 'supplier').overall.count, 0);
});
