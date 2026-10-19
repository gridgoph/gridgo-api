import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStore } from '../src/postgres-store.js';
import { notificationVisible } from '../src/notifications.js';
import { isTestOperationsUser, mergeTestOperationsView, reviewSubject, testOperationsRouteAllowed, testOperationsView } from '../src/test-operations.js';

function store() {
  const s = emptyStore();
  s.settings = { serviceFeeRateBps: 1000 };
  for (const [id, role, reviewData] of [['tester', 'ops_admin', true], ['ops', 'ops_admin', false], ['boss', 'super_admin', true],
    ['client', 'client', true], ['real', 'client', false], ['shop', 'supplier', true], ['realshop', 'supplier', false]]) {
    s.users.push({ id, role, reviewData, name: id, email: `${id}@example.invalid` });
    s.userRoleMemberships.push({ userId: id, role });
  }
  s.userRoleMemberships.push({ userId: 'boss', role: 'ops_admin' });
  s.orders.push({ id: 'review', clientId: 'client', supplierId: 'shop', reviewData: true },
    { id: 'order', clientId: 'real', supplierId: 'realshop', reviewData: false });
  s.orderJobs.push({ id: 'job_review', orderId: 'review', supplierId: 'shop' }, { id: 'job', orderId: 'order', supplierId: 'realshop' });
  s.refundRequests.push({ id: 'refund_review', orderId: 'review' }, { id: 'refund', orderId: 'order' });
  s.refundEvents.push({ id: 'event_review', requestId: 'refund_review' }, { id: 'event', requestId: 'refund' });
  s.approvalCases.push({ id: 'case_review', userId: 'shop', kind: 'supplier' }, { id: 'case', userId: 'realshop', kind: 'supplier' });
  s.catalogItems.push({ id: 'item_review', supplierId: 'shop' }, { id: 'item', supplierId: 'realshop' });
  s.catalogOptionGroups.push({ id: 'group_review', catalogItemId: 'item_review' }, { id: 'group', catalogItemId: 'item' });
  s.catalogOptions.push({ id: 'option_review', optionGroupId: 'group_review' }, { id: 'option', optionGroupId: 'group' });
  s.baskets.push({ id: 'basket_review', orderIds: ['review'] }, { id: 'basket', orderIds: ['order'] });
  s.files.push({ fileId: 'proof', ownerId: 'real', references: [{ type: 'order', id: 'review' }] },
    { fileId: 'secret', ownerId: 'real', references: [{ type: 'order', id: 'order' }] }, { fileId: 'qr', ownerId: 'ops', references: [] });
  s.notifications.push({ id: 'n_review', userId: 'tester', orderId: 'review' }, { id: 'n_real', userId: 'tester', orderId: 'order' },
    { id: 'n_desk', userId: 'tester', appRole: 'ops_admin' }, { id: 'n_staff_review', userId: 'ops', orderId: 'review' }, { id: 'n_case', userId: 'tester', approvalCaseId: 'case_review' });
  s.zones.push({ id: 'zone' });
  s.credits = { client: { balanceMinor: 0 }, real: { balanceMinor: 500 } };
  return s;
}
const ids = rows => rows.map(row => row.id || row.fileId || row.userId);

test('the test operations identity is a marked ops_admin without Super Admin', () => {
  const s = store();
  assert.equal(isTestOperationsUser(s, 'tester'), true);
  assert.equal(isTestOperationsUser(s, 'ops'), false);
  assert.equal(isTestOperationsUser(s, 'boss'), false);
  assert.equal(isTestOperationsUser(s, 'client'), false);
});

test('the review view keeps only review rows and their children', () => {
  const s = store();
  const view = testOperationsView(s, s.users[0]);
  assert.deepEqual(ids(view.users), ['tester', 'boss', 'client', 'shop']);
  assert.deepEqual(ids(view.orders), ['review']);
  for (const [key, expected] of [['orderJobs', ['job_review']], ['refundRequests', ['refund_review']], ['refundEvents', ['event_review']],
    ['approvalCases', ['case_review']], ['catalogItems', ['item_review']], ['catalogOptionGroups', ['group_review']],
    ['catalogOptions', ['option_review']], ['baskets', ['basket_review']], ['files', ['proof']],
    ['notifications', ['n_review', 'n_staff_review', 'n_case']]]) assert.deepEqual(ids(view[key]), expected, key);
  // Inbox fan-out still reaches every staff membership; the staff rows themselves stay hidden.
  assert.ok(view.userRoleMemberships.some(row => row.userId === 'ops' && row.role === 'ops_admin'));
  assert.ok(!view.userRoleMemberships.some(row => row.userId === 'real'));
  assert.deepEqual(Object.keys(view.credits), ['client']);
  assert.equal(view.zones, s.zones);
  assert.equal(view.settings, s.settings);
});

test('view writes merge back into the full store', () => {
  const s = store();
  const view = testOperationsView(s, s.users[0]);
  view.orders[0].state = 'needs_qa';
  view.notifications.push({ id: 'n_new', userId: 'client', orderId: 'review' });
  view.orderJobs.splice(0, 1);
  view.credits.client.balanceMinor = 0;
  view.settings = { serviceFeeRateBps: 900 };
  assert.equal(mergeTestOperationsView(view), s);
  assert.equal(s.orders[0].state, 'needs_qa');
  assert.deepEqual(ids(s.notifications).slice(-1), ['n_new']);
  assert.equal(s.notifications.length, 6);
  assert.deepEqual(ids(s.orderJobs), ['job']);
  assert.equal(s.credits.real.balanceMinor, 500);
  assert.equal(s.settings.serviceFeeRateBps, 900);
  // A second save only applies what changed since the first.
  view.notifications.push({ id: 'n_later', userId: 'client', orderId: 'review' });
  mergeTestOperationsView(view);
  assert.equal(s.notifications.filter(row => row.id === 'n_new').length, 1);
  assert.deepEqual(ids(s.notifications).slice(-2), ['n_new', 'n_later']);
  const plain = store();
  assert.equal(mergeTestOperationsView(plain), plain);
});

test('the route allowlist denies by default', () => {
  for (const [method, path] of [['GET', '/orders'], ['POST', '/orders/o/payments/initial/confirm'], ['POST', '/orders/o/transition'],
    ['GET', '/support-chat/threads'], ['GET', '/notifications/stream'], ['GET', '/ops/riders/locations'], ['POST', '/baskets/b/payment/confirm'],
    ['OPTIONS', '/admin/staff'], ['HEAD', '/orders'], ['GET', '/settings'], ['GET', '/ops/hub'], ['GET', '/dispatch/offers'],
    ['POST', '/orders/o/artwork-downloads']]) assert.equal(testOperationsRouteAllowed(method, path), true, `${method} ${path}`);
  for (const [method, path] of [['PATCH', '/settings'], ['POST', '/settings/service-fee/preview'], ['GET', '/settings/payment-qr'],
    ['GET', '/orders/o/artwork-downloads'], ['PATCH', '/users/u/review-data'], ['PATCH', '/users/u/role'], ['GET', '/audit'],
    ['GET', '/ops/finance/supplier-invoices'], ['POST', '/orders/o/milestones/delivered/release'], ['POST', '/refund-requests/r/settle'],
    ['GET', '/admin/staff'], ['GET', '/ops/issue-reports'], ['GET', '/orders/o/audit'], ['DELETE', '/files/f'], ['GET', '/api/support-chat/threads'],
    ['GET', '/orders/o/extra/segment'], ['POST', '/credits/grant'], ['GET', '/ops/organizations']]) {
    assert.equal(testOperationsRouteAllowed(method, path), false, `${method} ${path}`);
  }
});

test('notifications and refetch pings reach test operations only for review subjects', () => {
  const s = store();
  const visible = id => notificationVisible(s, s.notifications.find(row => row.id === id), 'tester');
  assert.deepEqual(['n_review', 'n_real', 'n_desk', 'n_case'].filter(visible), ['n_review', 'n_case']);
  s.notifications.push({ id: 'n_ops', userId: 'ops', orderId: 'order' }, { id: 'n_ops_desk', userId: 'ops' });
  assert.ok(notificationVisible(s, s.notifications.at(-2), 'ops'));
  assert.ok(notificationVisible(s, s.notifications.at(-1), 'ops'));
  for (const [subject, expected] of [[{ resource: 'orders', id: 'review' }, true], [{ resource: 'orders', id: 'order' }, false],
    [{ resource: 'jobs', id: 'job_review' }, true], [{ resource: 'jobs', id: 'job' }, false], [{ resource: 'catalog', id: 'item' }, false],
    [{ resource: 'catalog', id: 'item_review' }, true], [{ resource: 'approvals', id: 'case_review' }, true], [{ resource: 'orders' }, false],
    [{ resource: 'notifications' }, true], [{ resource: 'identity', id: 'real' }, false], [{ resource: 'chat', id: 'unknown' }, false]]) {
    assert.equal(reviewSubject(s, subject), expected, JSON.stringify(subject));
  }
});
