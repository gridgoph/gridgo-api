import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, loadDeliveryStore, loadProductionSweepStore, saveStore } from '../src/postgres-store.js';
import { setupOperationsReads } from './fixtures/operations-reads.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { orderRemovalBlock } from '../src/order-removal.js';
import { reconcileCalls, purgeClosedCalls } from '../src/order-calls.js';
import { purgeClosedPickupChats } from '../src/pickup-chat.js';
import { purgeClosedDeliveryChats } from '../src/delivery-chat.js';
import { matchShop } from '../src/order-match.js';
import { fileRelationships } from '../src/file-retention-policy.js';
import { reviewSubject } from '../src/test-operations.js';
import { readFunnelSummary } from '../src/pricing-dashboard.js';
import { AT, id } from './fixtures/reschedule.js';

const skip = !process.env.DATABASE_URL;
const body = { reason: '  Retire unfinished test order  ', confirmEmail: 'review_client@example.invalid' };
async function setup(t) {
  const db = createDatabase(process.env); t.after(() => db.close());
  const store = await setupOperationsReads(db);
  // Funnel telemetry intentionally has no user FK, so the fixture's user
  // reset cannot clear it between repeated runs or other test files.
  await db.query('TRUNCATE funnel_events');
  // Keep other test data out of timer maintenance during this HTTP test.
  for (const order of store.orders) order.readyBy = order.promiseBy = '2099-01-01T00:00:00.000Z';
  const unpaid = { ...structuredClone(store.orders[0]), id: 'unpaid', supplierId: null };
  unpaid.payments.initial.status = 'not_submitted'; store.orders.push(unpaid);
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t), store };
}

test('removal enforces Super Admin, exact email, reason and immutable audited success through the local API', { skip }, async t => {
  const { db, api } = await setup(t);
  for (const who of [null, 'ops', 'test_ops', 'client', 'supplier', 'rider', 'staff']) {
    const response = await api(who, 'POST', '/ops/orders/review/remove', body);
    assert.equal(response.status, 403, who); assert.equal(response.body.error, 'forbidden', who);
  }
  for (const reason of ['', ' \t\n ', null, 7, 'x'.repeat(2001)]) {
    const response = await api('admin', 'POST', '/ops/orders/review/remove', { ...body, reason });
    assert.equal(response.status, 400); assert.equal(response.body.error, 'reason_required');
  }
  for (const confirmEmail of ['REVIEW_client@example.invalid', 'other@example.invalid', 'review_client@example.invalid ', null]) {
    const response = await api('admin', 'POST', '/ops/orders/review/remove', { ...body, confirmEmail });
    assert.equal(response.status, 400); assert.equal(response.body.error, 'confirm_email_mismatch');
  }
  const missing = await api('admin', 'POST', '/ops/orders/missing/remove', body);
  assert.equal(missing.status, 404); assert.equal(missing.body.error, 'order_not_found');
  const before = (await db.query("SELECT to_jsonb(o) AS row FROM orders o WHERE id='review'")).rows[0].row;
  const money = (await db.query("SELECT * FROM order_payments WHERE order_id='review' ORDER BY code")).rows;
  const response = await api('admin', 'POST', '/ops/orders/review/remove', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.id, 'review'); assert.ok(Number.isFinite(Date.parse(response.body.removedAt)));
  assert.deepEqual((await db.query("SELECT to_jsonb(o) AS row FROM orders o WHERE id='review'")).rows[0].row, before);
  assert.deepEqual((await db.query("SELECT * FROM order_payments WHERE order_id='review' ORDER BY code")).rows, money);
  const marker = (await db.query("SELECT * FROM order_removals WHERE order_id='review'")).rows[0];
  assert.equal(marker.removed_by, 'admin'); assert.equal(marker.reason, 'Retire unfinished test order');
  const audit = (await db.query("SELECT * FROM audit_log WHERE action='order.remove' AND order_id='review'")).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, 'admin');
  assert.equal(audit[0].data.reason, 'Retire unfinished test order');
  const auditRead = await api('admin', 'GET', '/audit?action=order.remove&includeReviewData=1');
  assert.equal(auditRead.status, 200); assert.equal(auditRead.body.audit[0].orderId, 'review');
  const repeated = await api('admin', 'POST', '/ops/orders/review/remove', body);
  assert.equal(repeated.status, 409); assert.equal(repeated.body.error, 'order_already_removed');
  await assert.rejects(db.query("DELETE FROM order_removals WHERE order_id='review'"), /immutable/);
  // A later compatibility save cannot delete or rewrite the retained graph.
  await db.transaction(async () => { const store = await loadStore(db); store.settings.promiseAllowanceMinutes++; await saveStore(db, store); });
  assert.deepEqual((await db.query("SELECT to_jsonb(o) AS row FROM orders o WHERE id='review'")).rows[0].row, before);
  assert.deepEqual((await db.query("SELECT * FROM order_payments WHERE order_id='review' ORDER BY code")).rows, money);
});

test('only Super Admin receives clientEmail for typed order confirmation', { skip }, async t => {
  const { api } = await setup(t);
  for (const who of ['admin', 'ops', 'client', 'supplier', 'rider']) {
    const response = await api(who, 'GET', '/orders/a_active');
    assert.equal(response.status, 200, who);
    assert.equal(response.body.order.clientEmail, who === 'admin' ? 'client@example.invalid' : undefined, who);
  }
});

test('removed order and children disappear from every role graph, queue, chat, export, notification and workload', { skip }, async t => {
  const { db, api } = await setup(t);
  const before = await loadStore(db);
  assert.ok(before.orderJobs.some(row => row.orderId === 'review'));
  const verification = { fileId: 'held_verification', ownerId: 'review_supplier', purpose: 'verification_document' };
  assert.equal(fileRelationships(before, verification).held, true);
  assert.equal((await api('admin', 'POST', '/ops/orders/review/remove', body)).status, 200);
  for (const who of ['admin', 'ops', 'test_ops', 'review_client', 'review_supplier', 'review_rider']) {
    const detail = await api(who, 'GET', '/orders/review');
    assert.equal(detail.status, 404, who); assert.equal(detail.body.error, 'order_not_found');
    for (const path of ['/orders?includeReviewData=1', '/jobs', '/dispatch/offers', '/notifications']) {
      const response = await api(who, 'GET', path);
      assert.ok([200, 403].includes(response.status), `${who} ${path}: ${response.status}`);
      if (response.status === 200) {
        assert.ok(!JSON.stringify(response.body).includes('"orderId":"review"'), `${who} ${path}`);
        assert.ok(!JSON.stringify(response.body).includes('"id":"review"'), `${who} ${path}`);
      }
    }
  }
  for (const path of ['/orders/review/invoice', '/orders/review/audit', '/orders/review/calls',
    '/orders/review/pickup-chat', '/orders/review/delivery-chat', '/orders/review/client-shop-chat',
    '/ops/orders/review/location-diagnostics', '/orders/review/eligible-suppliers']) {
    assert.equal((await api('admin', 'GET', path)).status, 404, path);
  }
  for (const path of ['/claims?includeReviewData=1', '/issues?includeReviewData=1', '/escalations?includeReviewData=1',
    '/admin/pricing?includeReviewData=1', '/ops/hub', '/ops/client-shop-chats', '/ops/finance/supplier-invoices']) {
    const response = await api('admin', 'GET', path);
    if (response.status === 200) assert.ok(!JSON.stringify(response.body).includes('"orderId":"review"'), path);
  }
  const after = await loadStore(db);
  assert.equal(fileRelationships(after, verification).held, true, 'removal cannot release a verification evidence hold');
  const transport = await loadDeliveryStore(db, { userIds: ['test_ops'], subjectId: 'review' });
  assert.equal(reviewSubject(transport, { id: 'review', resource: 'orders' }), true, 'separate API replicas can refresh review queues');
  assert.equal(reviewSubject(transport, { orderId: 'review' }), false, 'removed notifications never regain visibility');
  assert.ok(!JSON.stringify(transport).includes('removedReviewOrderIds'));
  for (const key of ['orders', 'orderJobs', 'orderLineItems', 'claims', 'issues', 'escalations', 'notifications']) {
    assert.ok(!after[key].some(row => row.orderId === 'review' || key === 'orders' && row.id === 'review'), key);
  }
  assert.ok(!(await loadProductionSweepStore(db)).orders.some(row => row.id === 'review'));
  // The same matcher that supplies mobile/cart queue positions sees no removed work.
  const workloadView = store => ({ ...store,
    catalogItems: store.catalogItems.filter(row => row.supplierId === 'supplier'),
    orders: store.orders.map(row => row.id === 'review' ? { ...row, supplierId: 'supplier', reviewData: false } : row),
    orderJobs: store.orderJobs.map(row => row.orderId === 'review' ? { ...row, supplierId: 'supplier' } : row),
  });
  const args = { subcategoryCode: 'flyers', units: 10, ranking: ['speed', 'cost', 'quality', 'distance'], now: AT };
  const matchedBefore = matchShop(workloadView(before), args);
  const matchedAfter = matchShop(workloadView(after), args);
  assert.ok(matchedBefore.listings.length && matchedAfter.listings.length);
  const queue = result => result.queue.jobsAhead;
  assert.equal(queue(matchedAfter), queue(matchedBefore) - 1);
});

test('linked carts, quotes, samples, combined baskets and SQL reporting retain rows but hide removed work', { skip }, async t => {
  const { db, api } = await setup(t);
  await db.transaction(async () => {
    const s = await loadStore(db);
    s.carts.push({ id: 'retired_cart', clientId: 'review_client', state: 'checked_out', version: 1, serviceLevel: 'standard',
      fulfillmentMode: 'delivery', checkedOutOrderId: 'review', createdAt: AT, updatedAt: AT, checkedOutAt: AT });
    s.quoteRequests.push({ id: 'retired_quote', clientId: 'review_client', status: 'ordered', subcategoryCode: 'flyers', quantity: 10,
      orderId: 'review', createdAt: AT, updatedAt: AT, version: 1 });
    s.quoteReplies.push({ id: 'retired_reply', quoteRequestId: 'retired_quote', supplierId: 'review_supplier', status: 'active',
      priceMinor: 10000, version: 1, createdAt: AT, updatedAt: AT });
    s.sampleBatchDrafts.push({ id: 'sbd_retired', clientId: 'review_client', supplierId: 'review_supplier', catalogItemId: 'item_supplier',
      sampleOrderId: 'review', status: 'awaiting_sample', holdDays: 14, batch: {}, heldPricing: {}, version: 1, createdAt: AT, updatedAt: AT });
    s.baskets.push({ id: 'retired_basket', clientId: 'review_client', receiptOrderId: 'review', orderIds: ['review', 'review_offer'],
      totalMinor: 24000, fulfillmentMode: 'delivery', payment: { status: 'confirmed', method: 'qr_manual' }, createdAt: AT, updatedAt: AT });
    await saveStore(db, s);
    await db.query("INSERT INTO funnel_events (id,at,client_id,kind,order_id) VALUES ('removed_funnel',$1,'review_client','checkout_reached','review')", [AT]);
  });
  const range = { from: AT, to: '2026-10-06T00:00:00.000Z' };
  assert.equal((await readFunnelSummary(db, range, {}, Date.parse(range.to))).counts.checkout_reached, 1);
  assert.equal((await api('admin', 'POST', '/ops/orders/review/remove', body)).status, 200);
  const after = await loadStore(db);
  for (const [key, id] of [['carts', 'retired_cart'], ['quoteRequests', 'retired_quote'], ['quoteReplies', 'retired_reply'],
    ['sampleBatchDrafts', 'sbd_retired'], ['baskets', 'retired_basket']]) assert.ok(!after[key].some(row => row.id === id), key);
  assert.ok(after.orders.some(row => row.id === 'review_offer'), 'another group order is retained and readable');
  for (const path of ['/me/carts/retired_cart', '/me/quote-requests/retired_quote', '/baskets/retired_basket']) {
    assert.equal((await api('review_client', 'GET', path)).status, 404, path);
  }
  assert.equal((await readFunnelSummary(db, range, {}, Date.parse(range.to))).counts.checkout_reached, 0);
  await db.transaction(async () => { const s = await loadStore(db); s.settings.promiseAllowanceMinutes++; await saveStore(db, s); });
  for (const table of ['client_carts', 'quote_requests', 'quote_replies', 'sample_batch_drafts', 'order_baskets', 'funnel_events']) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1, table);
  }
});

test('removal emits orders invalidation, preserves history and suppresses pending order work without party notices', { skip }, async t => {
  const { db, api } = await setup(t);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.notifications.push({ id: 'remove_pending', userId: 'review_client', appRole: 'client', orderId: 'review', type: 'order_created',
      title: 'Old', body: 'Old queued notice', at: AT, read: false });
    store.deviceTokens.push({ id: 'remove_device', userId: 'review_client', token: 'removal-device-token', platform: 'android', appRole: 'client', createdAt: AT, updatedAt: AT });
    await saveStore(db, store);
    await db.query("INSERT INTO notification_push_outbox(notification_id,user_id,device_id) VALUES ('remove_pending','review_client','remove_device')");
    await db.query(`INSERT INTO order_calls (order_id,pair,rider_id,caller_id,callee_id,caller_role,callee_role,state,
      created_at,ring_expires_at,caller_seen_at,callee_seen_at) VALUES ('review','delivery','review_rider','review_client','review_rider',
      'client','rider','ringing',now(),now()+interval '1 hour',now(),now())`);
    await db.query(`INSERT INTO pickup_chat_messages (order_id,rider_id,sender_user_id,sender_role,body)
      VALUES ('review','review_rider','review_supplier','supplier','Retained history')`);
    await db.query(`INSERT INTO delivery_chat_messages (order_id,rider_id,sender_user_id,sender_role,body)
      VALUES ('review','review_rider','review_client','client','Retained history')`);
  });
  const controller = new AbortController(); t.after(() => controller.abort());
  const frames = { admin: '', test_ops: '' }, readings = [];
  for (const who of Object.keys(frames)) {
    const stream = await api(who, 'GET', '/notifications/stream', null, { stream: true, signal: controller.signal });
    const reader = stream.body.getReader();
    readings.push((async () => { try { while (true) { const { value, done } = await reader.read(); if (done) break; frames[who] += new TextDecoder().decode(value); } } catch {} })());
  }
  const before = (await db.query("SELECT id FROM notifications WHERE order_id='review' ORDER BY id")).rows;
  assert.equal((await api('admin', 'POST', '/ops/orders/review/remove', body)).status, 200);
  for (let i = 0; i < 100 && Object.values(frames).some(value => !value.includes('"resource":"orders","id":"review"')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(); await Promise.all(readings);
  for (const [who, value] of Object.entries(frames)) assert.match(value, /event: invalidate\ndata: .*"resource":"orders","id":"review"/, who);
  assert.deepEqual((await db.query("SELECT id FROM notifications WHERE order_id='review' ORDER BY id")).rows, before);
  assert.equal((await db.query("SELECT status FROM notification_push_outbox WHERE notification_id='remove_pending'")).rows[0].status, 'suppressed');
  const notices = (await db.query("SELECT count(*)::int AS n FROM notifications WHERE order_id='review'")).rows[0].n;
  await db.transaction(async () => {
    const s = await loadStore(db), at = '2099-01-01T00:00:00Z';
    await reconcileCalls(db, s, { createId: id, at });
    await purgeClosedCalls(db, s, at); await purgeClosedPickupChats(db, at); await purgeClosedDeliveryChats(db, at);
    await saveStore(db, s);
  });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications WHERE order_id='review'")).rows[0].n, notices);
  for (const table of ['order_calls', 'pickup_chat_messages', 'delivery_chat_messages']) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE order_id='review'`)).rows[0].n, 1, table);
  }
});

test('real unpaid unassigned orders can be removed; submitted/confirmed money, shop assignment, refunds and payouts stay blocked', { skip }, async t => {
  const { db, api } = await setup(t);
  const attempt = () => api('admin', 'POST', '/ops/orders/order/remove', { ...body, confirmEmail: 'client@example.invalid' });
  const blocked = await attempt(); assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'order_removal_blocked'); assert.ok(blocked.body.message);
  assert.equal((await api('admin', 'POST', '/ops/orders/unpaid/remove', { ...body, confirmEmail: 'client@example.invalid' })).status, 200);
  const base = structuredClone((await loadStore(db)).orders.find(row => row.id === 'review'));
  const store = await loadStore(db);
  const check = (patch, extra = {}, expected = true) => {
    const order = { ...structuredClone(base), ...patch };
    const graph = { ...store, ...extra };
    assert.equal(Boolean(orderRemovalBlock(graph, order)), expected, JSON.stringify(patch));
  };
  check({}, {}, false);
  check({ payoutMilestones: [{ status: 'released' }] });
  check({}, { refundRequests: [{ orderId: 'review', status: 'requested' }] });
  check({}, { refundRequests: [{ orderId: 'review', status: 'paid' }] });
  check({ reviewData: false });
  check({ payments: { initial: { status: 'pending_confirmation' } } });
  check({ payments: { initial: { status: 'confirmed' } } });
  check({}, { baskets: [{ orderIds: ['review'], payment: { status: 'confirmed' } }] });
  check({}, { credits: { client: { ledger: [{ orderId: 'review', amountMinor: 100 }] } } });
  check({}, { voucherReservations: [{ data: { orderIds: ['review'] } }] });
  check({}, { orderChanges: [{ orderId: 'review', status: 'pending_confirmation' }] });
  check({ deliveryPin: { change: { status: 'pending_confirmation' } } });
});
