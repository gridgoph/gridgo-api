import { alwaysOpenOperatingHours } from './helpers/operating-hours.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { PICKUP_CHECK_CODES } from '../src/operational-model.js';
import { TEST_OPERATIONS_ROUTES } from '../src/test-operations.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { resetDatabase } from './fixtures/reset-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
// Every unmarked identifier, name and email below carries this marker.
const REAL = 'zzreal';
const REAL_PHONE = '+639170009999';
const checked = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};

/**
 * Review world: client, supplier, rider and the test operations account `ops`.
 * Unmarked world: a client, shop, rider, Operations and Super Admin whose ids,
 * names and emails all contain REAL, with an order, claim, issue, escalation,
 * refund request, location ping, approval cases and inbox rows.
 */
function world() {
  const store = JSON.parse(JSON.stringify(fixture()).replaceAll('replacement', `${REAL}shop`).replaceAll('"admin"', `"${REAL}admin"`)
    .replaceAll('clerk_admin', `clerk_${REAL}admin`).replaceAll('"other"', `"${REAL}client"`).replaceAll('clerk_other', `clerk_${REAL}client`));
  store.settings.operatingHours = alwaysOpenOperatingHours();
  for (const [id, role] of [[`${REAL}rider`, 'rider'], [`${REAL}ops`, 'ops_admin']]) {
    store.users.push({ id, role, clerkUserId: `clerk_${id}`, createdAt: AT, ...(role === 'rider' ? { verificationStatus: 'approved' } : {}) });
    store.userRoleMemberships.push({ userId: id, role, createdAt: AT });
  }
  for (const user of store.users) {
    if (user.id.startsWith(REAL)) Object.assign(user, { name: `${REAL} ${user.id} Person`, email: `${user.id}@${REAL}.example.invalid`, phone: REAL_PHONE });
    else user.reviewData = true;
  }
  store.supplierProfiles.find(row => row.userId === `${REAL}shop`).shopName = `${REAL} Printing Co`;
  for (const [id, userId, kind, status] of [['case_rider', 'rider', 'rider', 'approved'], [`case_${REAL}rider`, `${REAL}rider`, 'rider', 'pending'],
    ['case_rider2', 'rider2', 'rider', 'pending']]) {
    store.approvalCases.push({ id, userId, kind, status, version: 1, applicationRevision: 1, submittedAt: AT,
      ...(status === 'approved' ? { decidedAt: AT } : {}), createdAt: AT, updatedAt: AT });
  }
  store.users.push({ id: 'rider2', role: 'rider', clerkUserId: 'clerk_rider2', name: 'Review rider two', email: 'rider2@example.invalid', reviewData: true, verificationStatus: 'pending', createdAt: AT });
  store.userRoleMemberships.push({ userId: 'rider2', role: 'rider', createdAt: AT });
  const review = store.orders[0];
  const real = JSON.parse(JSON.stringify(review).replaceAll('"order"', `"${REAL}order"`));
  Object.assign(real, { clientId: `${REAL}client`, supplierId: `${REAL}shop`, riderId: `${REAL}rider`, state: 'rider_assigned',
    title: `${REAL} banner job`, dropoff: { lat: 7.07, lng: 125.61, label: `${REAL} street` } });
  store.orders.push(real);
  const line = store.orderLineItems[0];
  store.orderLineItems.push({ ...JSON.parse(JSON.stringify(line)), id: `${REAL}line`, orderId: real.id, jobId: `${REAL}job` });
  store.orderJobs.push({ ...JSON.parse(JSON.stringify(store.orderJobs[0])), id: `${REAL}job`, orderId: real.id, supplierId: `${REAL}shop`, riderId: `${REAL}rider` });
  for (const order of [review, real]) {
    const prefix = order === real ? REAL : 'review';
    store.claims.push({ id: `${prefix}claim`, orderId: order.id, clientId: order.clientId, status: 'open', reason: `${prefix} damaged print`, createdAt: AT, updatedAt: AT });
    store.issues.push({ id: `${prefix}issue`, orderId: order.id, clientId: order.clientId, status: 'open', version: 1, kind: 'quality',
      description: `${prefix} smudged`, createdAt: AT, updatedAt: AT });
    store.escalations.push({ id: `${prefix}escalation`, orderId: order.id, riderId: order.riderId || 'rider', status: 'open', reason: `${prefix} gate closed`, createdAt: AT, updatedAt: AT });
    store.refundRequests.push({ id: `${prefix}refund`, orderId: order.id, clientId: order.clientId, kind: 'complaint', status: 'requested',
      reason: `${prefix} refund`, policyVersion: 'available_funds_v1', beforeProduction: false, late: false,
      orderStateAtFiling: order.state, evidenceFileIds: [], version: 1, createdAt: AT, updatedAt: AT });
    store.notifications.push({ id: `${prefix}notice`, userId: 'ops', appRole: 'ops_admin', orderId: order.id, type: 'ops_payment_submitted',
      title: `${prefix} payment submitted`, body: 'Open GRIDGO to review the latest update.', read: false, at: AT });
  }
  store.locationPings.push({ id: `${REAL}ping`, orderId: real.id, riderId: `${REAL}rider`, lat: 7.06, lng: 125.6, accuracy: 5, at: new Date().toISOString() });
  store.notifications.push({ id: `${REAL}desk`, userId: 'ops', appRole: 'ops_admin', type: 'ops_support_message',
    title: `${REAL} desk notice`, body: 'Open GRIDGO to review the latest update.', read: false, at: AT });
  store.notifications.push({ id: `${REAL}case_notice`, userId: 'ops', appRole: 'ops_admin', approvalCaseId: `case_${REAL}rider`,
    type: 'ops_approval_submitted', title: `${REAL} rider applied`, body: 'Open GRIDGO.', read: false, at: AT });
  store.files.push({ fileId: `${REAL}file`, ownerId: `${REAL}client`, purpose: 'artwork', state: 'ready', objectKey: `private/${REAL}file`,
    size: 100, originalFilename: `${REAL}.pdf`, detectedContentType: 'application/pdf', declaredContentType: 'application/pdf', createdAt: AT,
    references: [{ type: 'order', id: real.id, field: 'artwork' }] });
  return store;
}

async function setup(t, mutate = () => {}) {
  const db = createDatabase({ DATABASE_URL });
  // Support chat tests count every thread on the desk; leave none behind.
  t.after(async () => { await db.query('DELETE FROM support_chat_threads'); await db.close(); });
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, funnel_events RESTART IDENTITY CASCADE');
  const store = world();
  mutate(store);
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  return { db, api };
}

const clean = (label, text) => {
  assert.ok(!text.includes(REAL) && !text.includes(REAL_PHONE), `${label} exposed unmarked data: ${text.slice(0, 600)}`);
};

test('a test operations session carries a review order through the operations desk', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, store => {
    store.orders = store.orders.filter(order => order.id !== 'order');
    store.orderJobs = store.orderJobs.filter(job => job.orderId !== 'order');
    store.orderLineItems = store.orderLineItems.filter(line => line.orderId !== 'order');
    for (const key of ['claims', 'issues', 'escalations', 'refundRequests', 'notifications']) store[key] = store[key].filter(row => row.orderId !== 'order');
    store.settings.downpaymentPercent = 75;
    for (const [fileId, purpose, ownerId] of [['artwork', 'artwork', 'client'], ['receipt', 'payment_proof', 'client'],
      ['finished', 'finished_product_photo', 'supplier'], ['packed', 'packing_photo', 'rider'],
      ['signature', 'handoff_signature', 'rider'], ['delivered', 'delivery_photo', 'rider']]) {
      store.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, size: 100,
        originalFilename: fileId === 'artwork' ? 'artwork.pdf' : 'image.png',
        detectedContentType: fileId === 'artwork' ? 'application/pdf' : 'image/png',
        declaredContentType: fileId === 'artwork' ? 'application/pdf' : 'image/png',
        artworkCheck: { status: 'passed', checkedAt: AT }, createdAt: AT, references: [] });
    }
  });
  const me = checked(await api('ops', 'GET', '/auth/me/ops'));
  assert.equal(me.testOperations, true);
  assert.equal(checked(await api('ops', 'GET', '/auth/me')).testOperations, true);
  assert.equal(checked(await api(`${REAL}ops`, 'GET', '/auth/me/ops')).testOperations, false);
  assert.equal(checked(await api(`${REAL}admin`, 'GET', '/auth/me')).testOperations, false);
  assert.equal(checked(await api('client', 'GET', '/auth/me')).testOperations, undefined);

  const cart = checked(await api('client', 'POST', '/me/carts', { fulfillmentMode: 'delivery',
    deadline: new Date(Date.now() + 90 * 86400000).toISOString(),
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Destination' } }), 201).cart;
  checked(await api('client', 'POST', `/me/carts/${cart.id}/lines`, { catalogItemId: 'item_supplier', quantity: 2, optionIds: [], artworkFileId: 'artwork' }), 201);
  const payment = { method: 'qr_manual', proofFileId: 'receipt', reference: 'REVIEW-TEST' };
  const orderId = checked(await api('client', 'POST', `/me/carts/${cart.id}/checkout`, { payment }), 201).order.id;
  const post = (actor, path, body = {}) => api(actor, 'POST', `/orders/${orderId}/${path}`, body);

  // The desk sees the review order without any reporting flag, and nothing unmarked.
  const queue = checked(await api('ops', 'GET', '/orders'));
  assert.deepEqual(queue.orders.map(order => order.id), [orderId]);
  clean('desk queue', JSON.stringify(queue));
  checked(await post('ops', 'payments/initial/reject', { reason: 'Resubmit receipt' }));
  checked(await post('client', 'payments/initial/submit', payment));
  assert.equal(checked(await post('ops', 'payments/initial/confirm')).order.state, 'needs_qa');
  checked(await post('client', 'payments/final_online/submit', payment));
  checked(await post('ops', 'payments/final_online/confirm'));
  checked(await post('ops', 'transition', { state: 'supplier_assigned', qaChecklist: { artwork: true, spec: true, quantity: true, address: true } }));
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
  checked(await api('rider', 'POST', `/dispatch/${orderId}/pickup-confirm`, { signature: { fileId: 'signature', signerName: 'Reviewer' } }));
  checked(await post('rider', 'transition', { state: 'out_for_delivery' }));
  clean('rider tracking', JSON.stringify(checked(await api('ops', 'GET', '/ops/riders/locations'))));
  checked(await api('ops', 'GET', `/dispatch/${orderId}/location`));
  await attach('delivered', 'rider');
  const handover = checked(await api('client', 'GET', `/orders/${orderId}/handover`)).handover;
  checked(await api('rider', 'POST', `/dispatch/${orderId}/delivery`, { evidenceType: 'photo', evidenceFileId: 'delivered', otp: handover?.otp }));
  assert.equal(checked(await post('client', 'confirm')).order.state, 'completed');

  // The desk chats with review accounts only; approval decisions stay Super Admin work.
  const thread = checked(await api('ops', 'POST', '/support-chat/threads', { userId: 'client', role: 'client' })).thread;
  checked(await api('ops', 'POST', `/support-chat/threads/${thread.id}/messages`, { body: 'Your order is on its way' }), 201);
  assert.equal((await api('ops', 'POST', '/support-chat/threads', { userId: `${REAL}client`, role: 'client' })).body.error, 'support_chat_person_not_found');
  assert.equal((await api('ops', 'POST', '/approval-cases/case_rider2/reject', { expectedVersion: 1, requestId: 'r', reason: 'No' })).body.error, 'forbidden');
  // Unmarked targets are invisible: the same 404 as an unknown id.
  assert.deepEqual((await api('ops', 'POST', `/orders/${REAL}order/payments/initial/confirm`, {})).body, { error: 'order_not_found' });
  assert.deepEqual((await api('ops', 'POST', '/orders/missing/payments/initial/confirm', {})).body, { error: 'order_not_found' });
  for (const [path, body] of [[`/escalations/${REAL}escalation/resolve`, { resolution: 'No' }], [`/claims/${REAL}claim/hold`, {}], [`/issues/${REAL}issue/resolve`, {}],
    [`/refund-requests/${REAL}refund/reject`, { reason: 'No' }], [`/files/${REAL}file/attach`, { orderId }], [`/dispatch/${REAL}order/location`, null]]) {
    const response = await api('ops', body ? 'POST' : 'GET', path, body ?? undefined);
    assert.equal(response.status, 404, `${path} ${JSON.stringify(response.body)}`);
    clean(path, JSON.stringify(response.body));
  }
  const saved = await loadStore(db);
  const order = saved.orders.find(row => row.id === orderId);
  assert.equal(order.payments.initial.confirmationSource, 'review_data');
  assert.ok(order.payoutMilestones.every(stage => stage.status !== 'released'));
  assert.equal(saved.orders.find(row => row.id === `${REAL}order`).state, 'rider_assigned');
  assert.equal(saved.escalations.find(row => row.id === `${REAL}escalation`).status, 'open');
  assert.equal(saved.approvalCases.find(row => row.id === `case_${REAL}rider`).status, 'pending');
  // Ordinary staff keep today's behaviour and still see the unmarked order by default.
  assert.deepEqual(checked(await api(`${REAL}ops`, 'GET', '/orders')).orders.map(row => row.id), [`${REAL}order`]);
});

test('routes off the test operations allowlist answer test_operations_forbidden', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  for (const [method, path, body] of [
    ['GET', '/ops/finance/supplier-invoices?month=2026-10'], ['GET', '/audit'], ['GET', '/audit?format=csv'], ['GET', '/settings'],
    ['PATCH', '/settings', { serviceFeeRateBps: 1 }], ['GET', '/admin/pricing'], ['GET', '/admin/staff'], ['GET', '/admin/privacy-requests'],
    ['GET', '/ops/issue-reports'], ['GET', '/issue-reports'], ['GET', '/admin/tracker'], ['GET', '/ops/account-deletion-requests'],
    ['PATCH', `/users/${REAL}client/review-data`, { reviewData: true, expectedVersion: 1, reason: 'x' }],
    ['PATCH', `/users/${REAL}client/role`, { role: 'ops_admin' }], ['PATCH', 'users/client/account', {}],
    ['POST', '/orders/order/milestones/production_started/release', {}], ['POST', '/refund-requests/reviewrefund/settle', {}],
    ['POST', '/credits/grant', { userId: 'client', amountMinor: 100 }], ['GET', '/ops/vouchers'], ['GET', '/ops/organizations'],
    ['GET', `/orders/order/audit`], ['GET', '/ops/push/stats'], ['DELETE', '/support-chat/threads/00000000-0000-4000-8000-000000000000'],
    ['GET', '/support-chat/me'], ['POST', '/announcements', { title: 'x', body: 'y', audience: 'everyone' }],
  ]) {
    const response = await api('ops', method, path.startsWith('/') ? path : `/${path}`, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.deepEqual(response.body, { error: 'test_operations_forbidden' }, `${method} ${path}`);
  }
  // Ordinary Operations is unchanged on the same routes.
  assert.equal((await api(`${REAL}ops`, 'GET', '/ops/finance/supplier-invoices?month=2026-10')).status, 200);
  assert.equal((await api(`${REAL}admin`, 'GET', '/audit')).status, 200);
  // Nothing changed for the refused writes.
  const saved = await loadStore(db);
  assert.equal(saved.users.find(row => row.id === `${REAL}client`).reviewData, false);
});

// One path per registered GET route; `{x}` placeholders expand to review and unmarked ids.
const GET_ROUTES = [
  '/health', '/auth/me', '/auth/me/client', '/auth/me/supplier', '/auth/me/rider', '/auth/me/ops', '/auth/me/admin', '/staff/me',
  '/me', '/me/legal/pending', '/legal/documents', '/legal/versions/missing', '/featured-prints', '/season-windows',
  '/catalog', '/catalog/shops', '/catalog/shops?includeReviewData=1', '/catalog/shops/{shop}', '/catalog/items/{item}', '/catalog/media/{photo}',
  '/taxonomy', '/taxonomy/categories', '/taxonomy/subcategories', '/taxonomy/materials', '/taxonomy/finishes', '/zones',
  '/accepted-file-formats', '/listing-starters', '/supplier-payment-terms', '/settings', '/settings/payment-qr', '/settings/service-fee/preview', '/announcements',
  '/web-push/public-key', '/devices', '/notifications', '/notifications?role=ops_admin', '/credits/balance?userId={user}',
  '/orders', '/orders?includeReviewData=1', '/orders/{order}', '/jobs', '/jobs?includeReviewData=1', '/baskets', '/baskets?includeReviewData=1',
  ...['artwork-downloads', 'eligible-suppliers', 'issues', 'invoice', 'qa-checks', 'cancellation-quote', 'refund-requests', 'dropoff-confirmation',
    'physical-invoice', 'handover', 'approval-proof', 'approval-proof/download', 'delivery-pin', 'reschedule-request', 'change-requests',
    'client-shop-chat', 'pickup-chat', 'delivery-chat', 'calls', 'survey', 'audit'].map(path => `/orders/{order}/${path}`),
  '/claims', '/claims?includeReviewData=1', '/claims/{claim}', '/issues', '/issues?includeReviewData=1', '/issues/{issue}',
  '/escalations', '/escalations?includeReviewData=1', '/refund-requests', '/refund-requests?includeReviewData=1', '/refund-requests/{refund}',
  '/refund-requests/{refund}/settlement-preview', '/dispatch/offers', '/dispatch/{order}/location',
  '/ops/riders/locations', '/ops/riders/locations?includeReviewData=1', '/ops/orders/{order}/location-diagnostics',
  '/ops/hub/escalations', '/ops/hub/receipt-scans', '/ops/hub/unclaimed', '/ops/hub/handouts', '/ops/shop-failures',
  '/ops/colour-price-checks', '/ops/special-instructions', '/ops/reschedule-requests', '/ops/client-shop-chats',
  '/ops/shops/hours', '/ops/shops/{shop}/hours', '/ops/shops/performance', '/ops/shops/{shop}/performance', '/ops/push/stats',
  '/ops/finance/supplier-invoices', '/ops/organizations', '/ops/organizations/{user}', '/ops/organizations/{user}/statements',
  '/ops/account-deletion-requests', '/ops/issue-reports', '/ops/vouchers', '/ops/catalog-items', '/ops/catalog-items/{item}',
  '/ops/catalog/shops', '/ops/catalog/shops/{shop}', '/ops/catalog/items/{item}', '/ops/catalog-reviews', '/ops/product-type-requests',
  '/approval-cases', '/approval-cases/{case}', '/users', '/users?role=client', '/users/{user}', '/users/{user}/verification-documents',
  '/users/{user}/production-lapses', '/users/{user}/payout-account', '/supplier-services', '/supplier-services/{service}',
  '/files/{file}', '/files/{file}/download-url', '/files/{file}/content', '/files/{file}/preview-url',
  '/support-chat/threads', '/support-chat/threads?role=staff', '/support-chat/people', '/support-chat/people?role=staff',
  '/support-chat/threads/{thread}', '/support-chat/threads/{thread}/messages', '/support-chat/me', '/support-chat/me/messages',
  '/admin/pricing', '/admin/shop-rankings', '/admin/survey-responses', '/admin/pricing-feedback', '/admin/checkout-exit-feedback',
  '/admin/voucher-redemptions', '/admin/voucher-campaigns', '/admin/staff', '/admin/staff/roles', '/admin/staff/invites',
  '/admin/legal/acceptances', '/admin/legal/documents', '/admin/privacy-requests', '/admin/season-windows',
  '/admin/season-windows/push-settings', '/admin/files/retention', '/admin/tracker', '/admin/me', '/audit', '/audit?format=csv',
  '/issue-reports', '/support-tickets', '/me/account-deletion-request', '/me/privacy-requests', '/staff/hub/claims',
  '/me/carts', '/me/addresses', '/me/preferences', '/me/deadline-days', '/me/catalog-items', '/me/supplier-profile',
  '/me/supplier-readiness', '/me/supplier-services', '/me/shop-hours', '/me/supplier-payment-terms', '/me/rider-profile', '/me/reviews',
  '/me/production-lapses', '/me/performance', '/me/surveys', '/me/vouchers', '/me/organization', '/me/organization/statements',
  '/me/client-application', '/me/client-application/checklist', '/me/product-types', '/me/product-type-requests',
  '/me/supplier-invoices', '/me/payout-account', '/me/catalog-preview', '/me/shop-failures',
];

test('every GET route as test operations exposes no unmarked id, email, phone or name', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t);
  const thread = async (actor, body) => checked(await api(actor, 'POST', '/support-chat/me/messages', { body }), 201).thread.id;
  const realThread = await thread(`${REAL}client`, `${REAL} wants a refund`);
  const reviewThread = await thread('client', 'Review question');
  checked(await api(`${REAL}ops`, 'POST', `/support-chat/threads/${reviewThread}/messages`, { body: 'Real staff reply' }), 201);
  // An unmarked staff peer thread with the test operations account stays hidden too.
  const staffThread = checked(await api(`${REAL}ops`, 'POST', '/support-chat/threads', { userId: 'ops', role: 'ops_admin' })).thread.id;
  checked(await api(`${REAL}ops`, 'POST', `/support-chat/threads/${staffThread}/messages`, { body: `${REAL} staff note` }), 201);
  const ids = {
    order: ['order', `${REAL}order`], shop: ['supplier', `${REAL}shop`], item: ['item_supplier', `item_${REAL}shop`],
    photo: ['photo_supplier', `photo_${REAL}shop`], user: ['client', 'supplier', 'rider', `${REAL}client`, `${REAL}shop`, `${REAL}rider`, `${REAL}ops`, `${REAL}admin`],
    claim: ['reviewclaim', `${REAL}claim`], issue: ['reviewissue', `${REAL}issue`], refund: ['reviewrefund', `${REAL}refund`],
    case: ['case_rider', `case_${REAL}rider`], service: ['service_supplier', `service_${REAL}shop`], file: ['photo_supplier', `${REAL}file`, `photo_${REAL}shop`],
    thread: [reviewThread, realThread, staffThread],
  };
  // The unmarked fixture is visible to ordinary staff, so an empty sweep cannot pass by accident.
  assert.match(JSON.stringify(checked(await api(`${REAL}ops`, 'GET', '/orders'))), new RegExp(REAL));
  assert.match(JSON.stringify(checked(await api(`${REAL}ops`, 'GET', '/support-chat/threads'))), new RegExp(REAL));
  let reviewVisible = 0;
  for (const template of GET_ROUTES) {
    const [placeholder] = template.match(/\{(\w+)\}/)?.slice(1) || [];
    for (const value of placeholder ? ids[placeholder] : [null]) {
      const path = placeholder ? template.replace(`{${placeholder}}`, value) : template;
      const response = await api('ops', 'GET', path, undefined, { raw: true });
      assert.ok(response.status < 500, `${path} ${response.status} ${response.body.slice(0, 300)}`);
      clean(`GET ${path}`, response.body);
      if (response.status === 200 && /"order"|reviewclaim|case_rider|Review question/.test(response.body)) reviewVisible += 1;
    }
  }
  assert.ok(reviewVisible > 10, `review data stayed visible on ${reviewVisible} reads`);
  // The allowlist is exercised: each allowed GET pattern matches some swept path.
  const swept = GET_ROUTES.map(path => path.split('?')[0].replace(/\{\w+\}/, 'x'));
  for (const row of TEST_OPERATIONS_ROUTES.filter(row => row.methods.includes('GET'))) {
    assert.ok(swept.some(path => row.pattern.test(path)), `no sweep path for ${row.pattern}`);
  }
});

test('the GET sweep lists every literal GET route in the source', () => {
  const swept = new Set(GET_ROUTES.map(path => path.split('?')[0]));
  const literal = /(?:req\.)?method === ["']GET["'] && (?:url\.)?(?:pathname|path) === ["']([^"']+)["']/g;
  for (const file of fs.readdirSync('src').filter(name => name.endsWith('.js'))) {
    for (const [, path] of fs.readFileSync(`src/${file}`, 'utf8').matchAll(literal)) {
      if (['/notifications/stream', '/support-chat/stream'].includes(path) || path.startsWith('/firstmate/')) continue;
      assert.ok(swept.has(path), `${file} registers GET ${path}; add it to the test operations sweep`);
    }
  }
});

async function readStream(api, path, trigger) {
  const controller = new AbortController();
  const response = await api('ops', 'GET', path, undefined, { stream: true, signal: controller.signal });
  const reader = response.body.getReader();
  let text = '';
  const reading = (async () => {
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch {}
  })();
  await new Promise(resolve => setTimeout(resolve, 300));
  await trigger();
  await new Promise(resolve => setTimeout(resolve, 1500));
  controller.abort();
  await reading;
  return text;
}

test('test operations streams deliver only review-data events', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t, store => {
    for (const order of store.orders) order.pickupChecklist = { status: 'failed_escalated' };
  });
  const inbox = await readStream(api, '/notifications/stream?role=ops_admin', async () => {
    checked(await api(`${REAL}ops`, 'POST', `/escalations/${REAL}escalation/resolve`, { resolution: `${REAL} resolved` }));
    checked(await api(`${REAL}ops`, 'POST', '/escalations/reviewescalation/resolve', { resolution: 'Review resolved' }));
  });
  clean('notification stream', inbox);
  assert.match(inbox, /reviewnotice|"id":"order"|order/);
  const chat = await readStream(api, '/support-chat/stream', async () => {
    checked(await api(`${REAL}client`, 'POST', '/support-chat/me/messages', { body: `${REAL} needs help` }), 201);
    checked(await api('client', 'POST', '/support-chat/me/messages', { body: 'Review needs help' }), 201);
  });
  clean('support chat stream', chat);
  assert.match(chat, /Review needs help/);
});
