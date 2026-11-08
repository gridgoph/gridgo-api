import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, loadDeliveryStore, loadProductionSweepStore, loadHotReadStore, saveStore } from '../src/postgres-store.js';
import { setupOperationsReads } from './fixtures/operations-reads.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { orderRemovalBlock } from '../src/order-removal.js';
import { publicOrderFor } from '../src/operational-model.js';
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

for (const removedId of ['review', 'review_offer']) for (const paymentStatus of ['not_submitted', 'pending_confirmation']) {
  test(`basket removal hides combined invoice/cart and refuses sibling payment actions: ${removedId}, ${paymentStatus}`, { skip }, async t => {
    const { db, api } = await setup(t);
    const orderIds = ['review', 'review_offer'], siblingId = orderIds.find(id => id !== removedId);
    await db.transaction(async () => {
      const store = await loadStore(db);
      for (const order of store.orders.filter(row => orderIds.includes(row.id))) {
        order.payments.initial = { amountMinor: 12000, status: paymentStatus, method: 'qr_manual' };
        order.basketId = 'shared_basket';
        order.state = paymentStatus === 'not_submitted' ? 'awaiting_initial_payment' : 'initial_payment_review';
      }
      store.files.push({ fileId: 'basket_remove_proof', ownerId: 'review_client', purpose: 'payment_proof', state: 'ready',
        objectKey: 'private/basket_remove_proof', originalFilename: 'proof.png', declaredContentType: 'image/png',
        detectedContentType: 'image/png', size: 100, createdAt: AT, references: [] });
      store.baskets.push({ id: 'shared_basket', clientId: 'review_client', receiptOrderId: 'review', orderIds,
        totalMinor: 24000, fulfillmentMode: 'delivery', deadline: '2099-01-01T00:00:00.000Z',
        payment: { status: paymentStatus, method: 'qr_manual' }, createdAt: AT, updatedAt: AT });
      store.carts.push({ id: 'shared_cart', clientId: 'review_client', state: 'checked_out', version: 1, serviceLevel: 'standard',
        fulfillmentMode: 'delivery', checkedOutOrderId: 'review', createdAt: AT, updatedAt: AT, checkedOutAt: AT });
      const groups = orderIds.map(orderId => ({ orderId, itemSubtotalMinor: 10000, serviceFeeMinor: 1000, serviceFeeRateBps: 1000,
        deliveryFeeMinor: 1000, totalMinor: 12000, lines: [{ itemName: `Private ${orderId} product`, quantity: 10, unitPriceMinor: 1000, amountMinor: 10000 }] }));
      store.orderInvoices.push({ orderId: 'review', invoiceNumber: 'BASKET-REMOVAL', issuedAt: AT,
        snapshot: { basketId: 'shared_basket', itemSubtotalMinor: 20000, serviceFeeMinor: 2000, serviceFeeRateBps: 1000,
          deliveryFeeMinor: 2000, totalMinor: 24000, groups } });
      await saveStore(db, store);
    });
    const before = await api('review_client', 'GET', `/orders/${siblingId}/invoice`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.invoice.groups.length, 2);
    assert.equal(before.body.invoice.itemSubtotalMinor, undefined, 'legacy combined invoice keeps client pricing privacy');
    const retained = async () => Object.fromEntries(await Promise.all([
      ['order_payments', "WHERE order_id IN ('review','review_offer') ORDER BY order_id,code"],
      ['order_baskets', "WHERE id='shared_basket'"], ['order_basket_groups', "WHERE basket_id='shared_basket' ORDER BY position"],
      ['order_invoices', "WHERE order_id='review'"], ['client_carts', "WHERE id='shared_cart'"],
    ].map(async ([table, where]) => [table, (await db.query(`SELECT * FROM ${table} ${where}`)).rows])));
    const rows = await retained();
    assert.equal((await api('admin', 'POST', `/ops/orders/${removedId}/remove`, body)).status, 200);
    for (const who of ['review_client', 'admin', 'ops', 'test_ops']) {
      assert.equal((await api(who, 'GET', `/orders/${siblingId}/invoice`)).status, 404, `${who} combined invoice`);
      assert.equal((await api(who, 'GET', '/baskets/shared_basket')).status, 404, `${who} basket`);
      for (const action of ['submit', 'confirm', 'reject']) {
        const response = await api(who, 'POST', `/orders/${siblingId}/payments/initial/${action}`,
          { method: 'qr_manual', reference: 'BASKET-REMOVAL', proofFileId: 'basket_remove_proof', reason: 'Review rejected' });
        if (who === 'test_ops' && action === 'submit') {
          assert.equal(response.status, 403);
          assert.equal(response.body.error, 'test_operations_forbidden', 'the existing test-Operations allowlist stays authoritative');
          continue;
        }
        assert.equal(response.status, 409, `${who} ${action}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.error, 'basket_payment_unavailable', `${who} ${action}`);
        assert.ok(response.body.message);
      }
    }
    assert.equal((await api('review_client', 'GET', '/me/carts/shared_cart')).status, 404, 'checked-out cart follows every basket group');
    assert.equal((await api('review_client', 'GET', `/orders/${siblingId}`)).status, 200, 'active sibling remains readable');
    assert.equal((await api('review_client', 'GET', `/orders/${removedId}`)).status, 404);
    assert.equal((await api('review_supplier', 'POST', `/orders/${siblingId}/payments/initial/confirm`, {})).status, 403);
    const active = await loadStore(db);
    assert.ok(!JSON.stringify(active).includes('removedBasketMemberships'), 'payment guard facts stay non-public');
    await db.transaction(async () => { const s = await loadStore(db); s.settings.promiseAllowanceMinutes++; await saveStore(db, s); });
    assert.deepEqual(await retained(), rows, 'removal, refusals and unrelated saves retain immutable basket money and receipt snapshots');
  });
}

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

test('Super Admin eligibility agrees with POST for persisted money, assignment and eligible fixture states', { skip }, async t => {
  const { db, api, store } = await setup(t);
  const base = store.orders.find(row => row.id === 'unpaid');
  const cases = [
    ['released', { state: 'payout_released' }, 'payout_released'],
    ['refund', {}, 'refund_activity'],
    ['paid', { payments: { ...base.payments, initial: { ...base.payments.initial, status: 'confirmed' } } }, 'payment_submitted'],
    ['submitted', { payments: { ...base.payments, initial: { ...base.payments.initial, status: 'pending_confirmation' } } }, 'payment_submitted'],
    ['basket', { payments: { ...base.payments,
      initial: { ...base.payments.initial, status: 'pending_confirmation' } } }, 'payment_submitted'],
    ['credit', {}, 'financial_activity'],
    ['reservation', {}, 'financial_activity'],
    ['redemption', {}, 'financial_activity'],
    ['ledger', {}, 'financial_activity'],
    ['shop', { supplierId: 'supplier' }, 'shop_assigned'],
    ['job', {}, 'shop_assigned'],
    ['eligible', {}, null],
    ['simulated', { reviewData: true, clientId: 'review_client', supplierId: 'review_supplier', payments: {
      ...base.payments, initial: { ...base.payments.initial, status: 'confirmed', simulated: true } } }, null],
  ];
  for (const [name, patch] of cases) store.orders.push({ ...structuredClone(base), ...patch, id: `eligibility_${name}` });
  store.refundRequests.push({ ...structuredClone(store.refundRequests[0]), id: 'eligibility_refund', orderId: 'eligibility_refund' });
  store.orderJobs.push({ ...structuredClone(store.orderJobs[0]), id: 'eligibility_job', orderId: 'eligibility_job' });
  const basketOrder = store.orders.find(row => row.id === 'eligibility_basket');
  store.orders.push({ ...structuredClone(basketOrder), id: 'eligibility_basket_sibling' });
  store.baskets.push({ id: 'eligibility_basket', clientId: 'client', receiptOrderId: 'eligibility_basket',
    orderIds: ['eligibility_basket', 'eligibility_basket_sibling'], totalMinor: 24000, fulfillmentMode: 'delivery', payment: { status: 'pending_confirmation', method: 'qr_manual' }, createdAt: AT, updatedAt: AT });
  store.credits.client = { balanceMinor: 100, ledger: [{ id: 'eligibility_credit', orderId: 'eligibility_credit',
    amountMinor: 100, balanceAfterMinor: 100, type: 'grant', at: AT, actorId: 'admin' }] };
  store.carts.push({ id: 'eligibility_cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard',
    fulfillmentMode: 'delivery', createdAt: AT, updatedAt: AT });
  const voucher = store.vouchers[0];
  store.voucherReservations.push({ id: 'eligibility_reservation', voucherId: voucher.id, clientId: 'client', cartId: 'eligibility_cart',
    status: 'consumed', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: AT, data: { orderIds: ['eligibility_reservation'] } });
  store.voucherRedemptions.push({ id: 'eligibility_redemption', voucherId: voucher.id, reservationId: 'eligibility_reservation', clientId: 'client',
    amountMinor: 100, status: 'restored', createdAt: AT, data: { orderIds: ['eligibility_redemption'] } });
  store.voucherLedger.push({ id: 'eligibility_ledger', voucherId: voucher.id, campaignId: voucher.campaignId, clientId: 'client',
    kind: 'restored', amountMinor: 100, at: AT, data: { orderIds: ['eligibility_ledger'] } });
  await db.transaction(() => saveStore(db, store));
  const list = await api('admin', 'GET', '/orders?includeReviewData=1');
  assert.equal(list.status, 200);
  for (const who of ['admin', 'ops', 'client']) {
    const basket = await api(who, 'GET', '/baskets/eligibility_basket');
    assert.equal(basket.status, 200, who);
    for (const group of basket.body.basket.groups) {
      if (who === 'admin') assert.deepEqual(group.order.removal, { allowed: false, blockedReason: 'payment_submitted' });
      else assert.equal(Object.hasOwn(group.order, 'removal'), false, who);
    }
  }
  const messages = {
    payout_released: 'This order has a released payout and must stay in the financial records.',
    refund_activity: 'This order has a refund in progress or a completed refund and must stay in the financial records.',
    payment_submitted: 'This order has a submitted or confirmed payment. Keep it for payment review and financial records.',
    financial_activity: 'This order has financial activity and must stay in the financial records.',
    shop_assigned: 'This order already has an assigned shop. Use the existing order recovery or cancellation process.',
  };
  for (const [name, patch, blockedReason] of cases) {
    const orderId = `eligibility_${name}`;
    const expected = { allowed: blockedReason === null, blockedReason };
    const detail = await api('admin', 'GET', `/orders/${orderId}`);
    assert.equal(detail.status, 200, name);
    assert.deepEqual(detail.body.order.removal, expected, `${name} detail`);
    assert.deepEqual(list.body.orders.find(row => row.id === orderId).removal, expected, `${name} list`);
    const removed = await api('admin', 'POST', `/ops/orders/${orderId}/remove`, { reason: 'Eligibility regression',
      confirmEmail: patch.clientId === 'review_client' ? 'review_client@example.invalid' : 'client@example.invalid' });
    assert.equal(removed.status, expected.allowed ? 200 : 409, `${name}: ${JSON.stringify(removed.body)}`);
    if (!expected.allowed) {
      assert.equal(removed.body.error, 'order_removal_blocked', name);
      assert.equal(removed.body.message, messages[blockedReason], name);
    }
  }
});
test('HTTP removal eligibility is absent for every non-Super Admin role', { skip }, async t => {
  const { api } = await setup(t);
  for (const [who, orderId] of [['ops', 'a_active'], ['test_ops', 'review'], ['client', 'a_active'],
    ['supplier', 'a_active'], ['rider', 'a_active']]) {
    const detail = await api(who, 'GET', `/orders/${orderId}`);
    assert.equal(detail.status, 200, who);
    assert.equal(Object.hasOwn(detail.body.order, 'removal'), false, who);
    const list = await api(who, 'GET', '/orders?includeReviewData=1');
    assert.equal(list.status, 200, who);
    assert.ok(list.body.orders.every(order => !Object.hasOwn(order, 'removal')), who);
  }
  assert.equal((await api('staff', 'GET', '/orders/a_active')).status, 403);
});

test('scoped and full Super Admin reads agree on a retained basket transfer without a simulation marker', { skip }, async t => {
  const db = createDatabase(process.env); t.after(() => db.close());
  const store = await setupOperationsReads(db);
  for (const order of store.orders.filter(row => ['review', 'review_offer'].includes(row.id))) {
    order.payments.initial = { amountMinor: 12000, status: 'pending_confirmation', method: 'qr_manual', simulated: true };
  }
  store.baskets.push({ id: 'parity_basket', clientId: 'review_client', receiptOrderId: 'review', orderIds: ['review', 'review_offer'],
    totalMinor: 24000, fulfillmentMode: 'delivery', payment: { status: 'pending_confirmation', method: 'qr_manual' }, createdAt: AT, updatedAt: AT });
  await db.transaction(() => saveStore(db, store));
  // Historical rows can lack the server marker even though new fixture saves
  // always normalize it. No HTTP request/save runs between this edit and reads.
  await db.query("UPDATE order_baskets SET payment = payment - 'simulated' WHERE id = 'parity_basket'");
  for (const simulated of [false, true]) {
    if (simulated) await db.query("UPDATE order_baskets SET payment = payment || '{\"simulated\":true}' WHERE id = 'parity_basket'");
    const full = await loadStore(db);
    const scoped = await loadHotReadStore(db, 'clerk_admin', '/orders/review');
    const expected = simulated ? { allowed: true, blockedReason: null } : { allowed: false, blockedReason: 'payment_submitted' };
    for (const graph of [full, scoped]) {
      const order = graph.orders.find(row => row.id === 'review');
      assert.deepEqual(publicOrderFor(order, { role: 'super_admin' }, graph).removal, expected);
      assert.equal(orderRemovalBlock(graph, order), expected.blockedReason);
    }
  }
});
