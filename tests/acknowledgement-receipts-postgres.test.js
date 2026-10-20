import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT, id, audit } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { PICKUP_CHECK_CODES } from '../src/operational-model.js';
import { issueAcknowledgement } from '../src/acknowledgement-receipts.js';

const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t, change = () => {}) {
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.users.push({ ...store.users.find(u => u.id === 'rider'), id: 'rider2', email: 'rider2@example.invalid', clerkUserId: 'clerk_rider2' });
  store.userRoleMemberships.push({ userId: 'rider2', role: 'rider', createdAt: AT });
  Object.assign(store.orders[0], { state: 'out_for_delivery', riderId: 'rider', riderAssignedAt: AT,
    riderProgress: { riderId: 'rider', assignedAt: AT, events: { arrived: AT } } });
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved',
    version: 1, applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT });
  store.approvalCases.push({ ...store.approvalCases.at(-1), id: 'case_rider2', userId: 'rider2' });
  for (const [fileId, purpose, field] of [['signature', 'handoff_signature', 'handoffSignatureFileIds'], ['drop', 'delivery_photo', 'deliveryPhotoFileIds']]) {
    store.files.push({ fileId, ownerId: 'rider', purpose, state: 'ready', objectKey: `private/${fileId}`, originalFilename: 'photo.png',
      declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT,
      references: [{ type: 'order', id: 'order', field }] });
    store.orders[0][field] = [fileId];
  }
  change(store);
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}
const path = '/orders/order/acknowledgement-receipt';
const ok = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; };

test('HTTP door delivery from assignment through signed pickup, receipt preparation and handover; client PDF', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, store => {
    Object.assign(store.orders[0], { state: 'ready_for_dispatch', riderId: null });
    store.orderJobs[0].state = 'ready_for_dispatch';
  });
  const transcript = [];
  const call = async (who, method, endpoint, body) => {
    const result = await api(who, method, endpoint, body);
    transcript.push({ who, method, endpoint, status: result.status, body: result.body });
    return result;
  };
  ok(await call('rider', 'POST', '/dispatch/order/accept', {}));
  assert.equal((await call('rider', 'POST', path, {})).status, 403);
  ok(await call('rider', 'POST', '/dispatch/order/pickup-checklist', {
    checks: PICKUP_CHECK_CODES.map(code => ({ code, passed: true })),
    counts: [{ lineItemId: 'line', countedQuantity: 10 }], signature: { fileId: 'signature', signerName: 'Shop Person' },
  }));
  ok(await call('rider', 'POST', '/orders/order/transition', { state: 'out_for_delivery' }));
  assert.equal((await call('rider', 'POST', path, {})).status, 403);
  assert.equal((await call('rider', 'GET', path)).status, 403);
  ok(await call('rider', 'POST', '/dispatch/order/milestones', { milestone: 'arrived' }));
  const receipt = ok(await call('rider', 'POST', path, {}), 201).receipt;
  assert.match(receipt.arNumber, /^AR-\d{10,}$/);
  assert.equal(receipt.grandTotalMinor, 12000);
  assert.equal(receipt.lines[0].subtotalMinor, 11000);
  assert.equal(receipt.deliveryFeeMinor, 1000);
  assert.deepEqual(ok(await call('rider', 'GET', path)).receipt, receipt);
  assert.deepEqual(ok(await call('client', 'GET', path)).receipt, receipt);
  assert.deepEqual(ok(await call('rider', 'POST', path, {})).receipt, receipt);
  ok(await call('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'drop' }));
  assert.equal((await loadStore(db)).orders[0].state, 'issue_window_open');
  assert.equal((await call('rider', 'GET', path)).status, 403);
  assert.equal((await call('rider', 'POST', path, {})).status, 403);
  assert.deepEqual(ok(await call('client', 'GET', path)).receipt, receipt);
  const pdf = await api('client', 'GET', `${path}/download`, null, { stream: true });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.match(pdf.headers.get('cache-control'), /no-store/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.ok(bytes.toString().startsWith('%PDF-1.4'));
  if (process.env.RECEIPT_PROOF_DIR) {
    await writeFile(`${process.env.RECEIPT_PROOF_DIR}/http-transcript.json`, JSON.stringify(transcript, null, 2));
    await writeFile(`${process.env.RECEIPT_PROOF_DIR}/acknowledgement.pdf`, bytes);
  }
  const saved = await loadStore(db);
  assert.equal(saved.auditLog.filter(row => row.action === 'acknowledgement_receipt.issued').length, 1);
  assert.deepEqual(saved.notifications.filter(row => row.type === 'acknowledgement_receipt_ready').map(row => row.appRole).sort(), ['client', 'ops_admin', 'super_admin']);
});

test('HTTP concurrent creation is idempotent; global numbers are contiguous across orders; failure consumes none', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, store => {
    for (let n = 2; n <= 4; n++) {
      store.orders.push({ ...structuredClone(store.orders[0]), id: `order${n}`, riderId: n === 2 ? 'rider2' : 'rider' });
      store.orders.at(-1).riderProgress.riderId = store.orders.at(-1).riderId;
      store.orderLineItems.push({ ...structuredClone(store.orderLineItems[0]), id: `line${n}`, orderId: `order${n}`, jobId: null });
    }
  });
  const before = (await db.query('SELECT last_number FROM acknowledgement_receipt_counter')).rows[0].last_number;
  await assert.rejects(db.transaction(async () => {
    const store = await loadStore(db);
    await issueAcknowledgement({ database: db, store, order: store.orders[0], user: store.users.find(u => u.id === 'rider'), now: () => AT, id, audit });
    throw new Error('simulate later audit/save failure');
  }), /simulate later/);
  assert.equal((await db.query('SELECT last_number FROM acknowledgement_receipt_counter')).rows[0].last_number, before);
  const secondApi = await apiForTest(t);
  const responses = await Promise.all(['order', 'order2', 'order', 'order3', 'order4', 'order2'].map((orderId, i) =>
    (i % 2 ? secondApi : api)(orderId === 'order2' ? 'rider2' : 'rider', 'POST', `/orders/${orderId}/acknowledgement-receipt`, {})));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 201, 201, 201, 201]);
  const rows = (await db.query('SELECT ar_sequence FROM acknowledgement_receipts ORDER BY ar_sequence')).rows;
  assert.deepEqual(rows.map(row => row.ar_sequence), [before + 1, before + 2, before + 3, before + 4]);
  assert.deepEqual(responses[0].body.receipt, responses[2].body.receipt);
  await assert.rejects(db.query("DELETE FROM acknowledgement_receipts WHERE order_id='order'"), /immutable/);
  await assert.rejects(db.query("UPDATE acknowledgement_receipts SET snapshot='{}' WHERE order_id='order'"), /immutable/);
  await assert.rejects(db.query('TRUNCATE acknowledgement_receipts'), /immutable/);
  await assert.rejects(db.query('UPDATE acknowledgement_receipt_counter SET last_number=0'), /advance once/);
});

test('HTTP ownership, assigned approved rider and staff boundaries; immutable snapshot survives account changes and reassignment', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  const original = ok(await api('rider', 'POST', path, {}), 201).receipt;
  for (const who of ['other', 'supplier', 'replacement', 'rider2']) {
    assert.equal((await api(who, 'GET', path)).status, 403);
    assert.equal((await api(who, 'GET', `${path}/download`)).status, 403);
    assert.equal((await api(who, 'POST', path, {})).status, 403);
  }
  assert.equal((await api(null, 'GET', path)).status, 401);
  assert.equal((await api('client', 'POST', path, {})).status, 403);
  assert.equal((await api('rider', 'GET', `${path}/download`)).status, 403);
  for (const who of ['ops', 'admin']) assert.deepEqual(ok(await api(who, 'GET', path)).receipt, original);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.users.find(u => u.id === 'client').name = 'Changed name';
    store.orders[0].riderId = null;
    await saveStore(db, store);
  });
  assert.equal((await api('rider', 'GET', path)).status, 403);
  assert.deepEqual(ok(await api('client', 'GET', path)).receipt, original);
});

test('HTTP older builds issue at delivery; hub pickup and historical unissued orders create no numbers', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, store => { delete store.orders[0].riderProgress; });
  assert.equal((await api('client', 'GET', path)).body.error, 'acknowledgement_receipt_not_found');
  ok(await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'drop' }));
  ok(await api('client', 'GET', path));
  await db.transaction(async () => {
    const store = await loadStore(db);
    const order = { ...structuredClone(store.orders[0]), id: 'historical', state: 'completed' };
    store.orders.push(order);
    store.orders.push({ ...order, id: 'pickup', state: 'out_for_delivery', fulfillmentMode: 'pickup', dropoff: null });
    await saveStore(db, store);
  });
  for (const orderId of ['historical', 'pickup']) assert.equal((await api('ops', 'POST', `/orders/${orderId}/acknowledgement-receipt`, {})).body.error, 'acknowledgement_not_available');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM acknowledgement_receipts')).rows[0].count, 1);
});

test('HTTP payment and malformed amount refusals leave both counter and delivery unchanged', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, store => { store.orders[0].payments.initial.status = 'pending_confirmation'; });
  const before = (await db.query('SELECT last_number FROM acknowledgement_receipt_counter')).rows[0].last_number;
  assert.equal((await api('rider', 'POST', path, {})).body.error, 'acknowledgement_payment_pending');
  assert.equal((await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'drop' })).body.error, 'acknowledgement_payment_pending');
  assert.equal((await loadStore(db)).orders[0].state, 'out_for_delivery');
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders[0].payments.initial.status = 'confirmed';
    store.orderInvoices.push({ orderId: 'order', invoiceNumber: 'INVALID-TEST-SNAPSHOT', issuedAt: AT,
      snapshot: { itemSubtotalMinor: 10000, serviceFeeRateBps: 1000, serviceFeeMinor: 1000, deliveryFeeMinor: 1000, totalMinor: 12000,
        lines: [{ id: 'bad-line', itemName: 'Invalid snapshot fixture', quantity: 1, unitPriceMinor: 100, amountMinor: 100 }] } });
    await saveStore(db, store);
  });
  assert.equal((await api('rider', 'POST', path, {})).body.error, 'acknowledgement_amount_mismatch');
  assert.equal((await db.query('SELECT last_number FROM acknowledgement_receipt_counter')).rows[0].last_number, before);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM acknowledgement_receipts')).rows[0].count, 0);
});

test('HTTP multi-shop basket receipts contain only their delivered group, including multi-item amounts and shared reference', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t, store => {
    const first = store.orders[0];
    Object.assign(first, { basketId: 'basket', groupLabel: 'Shop A', invoiceNumber: 'BASKET-TEST' });
    first.payments.initial.reference = 'SHARED-QR';
    const second = { ...structuredClone(first), id: 'second', groupLabel: 'Shop B', riderId: 'rider2' };
    second.riderProgress.riderId = 'rider2';
    store.orders.push(second);
    store.baskets.push({ id: 'basket', clientId: 'client', receiptOrderId: first.id, orderIds: [first.id, second.id],
      totalMinor: 24000, fulfillmentMode: 'delivery', payment: { method: 'qr_manual', reference: 'SHARED-QR', status: 'confirmed' }, createdAt: AT, updatedAt: AT });
    const groups = [
      { orderId: first.id, itemSubtotalMinor: 10000, serviceFeeMinor: 1000, serviceFeeRateBps: 1000, deliveryFeeMinor: 1000, totalMinor: 12000,
        lines: [{ id: 'first-item', itemName: 'Shop A flyers', quantity: 10, unitPriceMinor: 1000, amountMinor: 10000 }] },
      { orderId: second.id, itemSubtotalMinor: 10000, serviceFeeMinor: 1000, serviceFeeRateBps: 1000, deliveryFeeMinor: 1000, totalMinor: 12000,
        lines: [{ id: 'second-item', itemName: 'Shop B posters', quantity: 2, unitPriceMinor: 2500, amountMinor: 5000 },
          { id: 'third-item', itemName: 'Shop B cards', quantity: 5, unitPriceMinor: 1000, amountMinor: 5000 }] },
    ];
    store.orderInvoices.push({ orderId: first.id, invoiceNumber: 'BASKET-TEST', issuedAt: AT,
      snapshot: { groups, itemSubtotalMinor: 20000, serviceFeeMinor: 2000, serviceFeeRateBps: 1000, deliveryFeeMinor: 2000, totalMinor: 24000 } });
  });
  const first = ok(await api('rider', 'POST', path, {}), 201).receipt;
  const second = ok(await api('rider2', 'POST', '/orders/second/acknowledgement-receipt', {}), 201).receipt;
  assert.deepEqual(first.lines.map(line => line.description), ['Shop A flyers']);
  assert.deepEqual(second.lines.map(line => line.description), ['Shop B posters', 'Shop B cards']);
  for (const receipt of [first, second]) {
    assert.equal(receipt.lines.reduce((sum, line) => sum + line.subtotalMinor, 0) + receipt.deliveryFeeMinor, receipt.grandTotalMinor);
    assert.equal(receipt.grandTotalMinor, 12000);
    assert.equal(receipt.payments[0].amountMinor, 12000);
    assert.equal(receipt.payments[0].reference, 'SHARED-QR');
  }
  assert.notEqual(first.arNumber, second.arNumber);
  assert.equal((await api('rider2', 'GET', path)).status, 403);
  assert.deepEqual(ok(await api('client', 'GET', '/orders/second/acknowledgement-receipt')).receipt, second);
});

test('HTTP rider billing exists only in the active-handover receipt and disappears after completion or cancellation', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  const receipt = ok(await api('rider', 'POST', path, {}), 201).receipt;
  assert.equal(receipt.grandTotalMinor, 12000);
  const assertNoBilling = object => {
    for (const key of ['totalMinor', 'clientItemSubtotalMinor', 'grandTotalMinor', 'invoice', 'acknowledgementReceipt',
      'serviceFeeMinor', 'acceptedQuote', 'organizationDiscountMinor', 'voucherDiscountMinor']) assert.equal(object[key], undefined, key);
    for (const payment of Object.values(object.payments || {})) assert.deepEqual(Object.keys(payment), ['status']);
  };
  const ordinaryReads = async () => {
    assertNoBilling(ok(await api('rider', 'GET', '/orders/order')).order);
    const listed = ok(await api('rider', 'GET', '/orders')).orders.find(order => order.id === 'order');
    assert.ok(listed); assertNoBilling(listed);
  };
  await ordinaryReads();
  for (const state of ['delivered', 'issue_window_open', 'completed', 'cancelled']) {
    await db.transaction(async () => {
      const store = await loadStore(db);
      store.orders[0].state = state;
      if (state === 'cancelled') Object.assign(store.orders[0], { cancelledAt: AT, cancelledBy: 'ops', cancellationReason: 'Cancellation fixture' });
      await saveStore(db, store);
    });
    assert.equal((await api('rider', 'GET', path)).status, 403, state);
    assert.equal((await api('rider', 'POST', path, {})).status, 403, state);
    assert.equal((await api('rider', 'GET', `${path}/download`)).status, 403, state);
    assert.deepEqual(ok(await api('client', 'GET', path)).receipt, receipt);
    await ordinaryReads();
  }
});
