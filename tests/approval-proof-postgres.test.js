import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { recordApprovalProof, approvalPolicy, approvalReviewSnapshot, approvalSnapshotSha256 } from '../src/approval-proof.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const device = { id: 'install-248', platform: 'ios', appVersion: '2.4.8' };
function setup() {
  const store = fixture();
  store.orders[0].approvalPolicy = approvalPolicy({ approvalProofRequired: true });
  for (const [fileId, purpose] of [['signature', 'approval_signature'], ['sample', 'approval_sample_photo']]) {
    store.files.push({ fileId, purpose, ownerId: 'client', state: 'ready', objectKey: `private/${fileId}`,
      contentSha256: 'a'.repeat(64), originalFilename: `${fileId}.png`, size: 100, detectedContentType: 'image/png', declaredContentType: 'image/png', createdAt: AT, references: [] });
  }
  return store;
}
const approval = store => ({ accepted: true, method: 'drawn', device, signatureFileId: 'signature', samplePhotoFileId: 'sample',
  expectedSnapshotSha256: approvalSnapshotSha256(approvalReviewSnapshot(store, store.orders[0])) });
const reset = db => resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');

test('database round trip preserves approval evidence and refuses rewriting, truncating, removing and policy changes', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  const store = setup(), order = store.orders[0];
  const first = recordApprovalProof({ store, order, user: store.users[0], approval: approval(store), at: AT, id });
  await db.transaction(() => saveStore(db, store));
  const loaded = await db.transaction(() => loadStore(db));
  assert.deepEqual(loaded.orders[0].approvalProofs[0], first);
  assert.equal(loaded.files.find(file => file.fileId === 'signature').references[0].id, order.id);
  for (const sql of [
    "UPDATE orders SET data = jsonb_set(data, '{approvalProofs,0,statement}', '\"changed\"') WHERE id='order'",
    "UPDATE orders SET data = jsonb_set(data, '{approvalProofs}', '[]') WHERE id='order'",
    "UPDATE orders SET data = data - 'approvalProofs' WHERE id='order'",
    "UPDATE orders SET data = jsonb_set(data, '{approvalPolicy,required}', 'false') WHERE id='order'",
  ]) await assert.rejects(db.query(sql), /immutable|append-only/);
  // Appending another signed record keeps the original record byte-for-byte.
  const nextOrder = loaded.orders[0];
  recordApprovalProof({ store: loaded, order: nextOrder, user: loaded.users[0], approval: approval(loaded), phase: 'sample', at: AT, id });
  await db.transaction(() => saveStore(db, loaded));
  const saved = await db.transaction(() => loadStore(db));
  assert.equal(saved.orders[0].approvalProofs.length, 2);
  assert.deepEqual(saved.orders[0].approvalProofs[0], first);
  saved.catalogItems[0].description = 'Later catalogue text';
  await db.transaction(() => saveStore(db, saved));
  assert.deepEqual((await db.transaction(() => loadStore(db))).orders[0].approvalProofs[0], first);
});

test('HTTP sample proof, private PDF and signed evidence reads use client/shop/Operations scope', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  const store = setup(); store.orders[0].state = 'proof_approval';
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  assert.equal((await api(null, 'GET', '/orders/order/approval-proof')).status, 401);
  assert.equal((await api('other', 'GET', '/orders/order/approval-proof')).status, 403);
  assert.equal((await api('supplier', 'GET', '/orders/order/approval-proof')).status, 403);
  const review = await api('client', 'GET', '/orders/order/approval-proof');
  assert.equal(review.status, 200); assert.deepEqual(review.body.approvalProofs, []);
  const body = { approval: { ...approval(store), expectedSnapshotSha256: review.body.review.snapshotSha256 } };
  const missingPhoto = await api('client', 'POST', '/orders/order/approval-proof', { approval: { ...body.approval, samplePhotoFileId: null } });
  assert.equal(missingPhoto.body.error, 'invalid_approval_file');
  assert.equal((await api('client', 'POST', '/orders/order/approval-proof', body, { headers: { 'User-Agent': 'approval-http-fixture' } })).status, 200);
  assert.equal((await api('client', 'POST', '/orders/order/transition', { state: 'approved_for_matching' })).status, 200);
  const storedProof = (await db.transaction(() => loadStore(db))).orders[0].approvalProofs[0];
  for (const user of ['client', 'supplier', 'ops', 'admin']) {
    const read = await api(user, 'GET', '/orders/order/approval-proof'); assert.equal(read.status, 200, user);
    assert.equal(read.body.approvalProofs[0].phase, 'sample');
    const pdf = await api(user, 'GET', '/orders/order/approval-proof/download', null, { raw: true });
    assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.match(pdf.headers.get('cache-control'), /no-store/); assert.ok(pdf.body.startsWith('%PDF'));
    if (user === 'supplier') {
      for (const key of ['account', 'device', 'userAgent']) assert.ok(!(key in read.body.approvalProofs[0]), key);
      for (const value of [storedProof.account.email, device.id, 'approval-http-fixture']) {
        assert.ok(!JSON.stringify(read.body).includes(value), value);
        assert.ok(!pdf.body.includes(value), value);
      }
      for (const label of ['Account:', 'Device and app:', 'App user agent:']) assert.ok(!pdf.body.includes(label), label);
    } else {
      assert.deepEqual(read.body.approvalProofs[0], storedProof);
      for (const value of [storedProof.account.email, device.id, 'approval-http-fixture']) assert.ok(pdf.body.includes(value), value);
    }
    assert.equal(read.body.approvalProofs[0].snapshotSha256, storedProof.snapshotSha256);
    assert.ok(pdf.body.includes(storedProof.snapshotSha256));
    const file = await api(user, 'GET', '/files/signature/download-url'); assert.equal(file.status, 200, JSON.stringify(file.body));
    assert.match(JSON.stringify(file.body), /X-Amz-Signature/);
  }
  for (const user of ['other', 'replacement', 'rider']) {
    assert.equal((await api(user, 'GET', '/orders/order/approval-proof')).status, 403, user);
    assert.equal((await api(user, 'GET', '/orders/order/approval-proof/download')).status, 403, user);
    assert.equal((await api(user, 'GET', '/files/signature/download-url')).status, 403, user);
  }
  assert.equal((await api(null, 'GET', '/orders/order/approval-proof/download')).status, 401);
  assert.deepEqual((await db.transaction(() => loadStore(db))).orders[0].approvalProofs[0], storedProof);
});

test('settings handshake is Super Admin only and new production transitions enforce snapshotted gate', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  const store = setup(); store.orders[0].state = 'payment_authorized';
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  const settings = await api('client', 'GET', '/settings');
  assert.equal(settings.body.settings.approvalProofRequired, false);
  const body = { expectedVersion: settings.body.version, reason: 'Companion apps released', approvalProofRequired: true };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, approvalProofRequired: 'yes' })).body.error, 'invalid_approval_proof_required');
  assert.equal((await api('admin', 'PATCH', '/settings', body)).status, 200);
  assert.equal((await api('supplier', 'POST', '/orders/order/transition', { state: 'production' })).body.error, 'approval_proof_required');
  const current = await db.transaction(() => loadStore(db));
  assert.equal(current.orders[0].state, 'payment_authorized');
  recordApprovalProof({ store: current, order: current.orders[0], user: current.users.find(user => user.id === 'client'), approval: approval(current), at: AT, id });
  await db.transaction(() => saveStore(db, current));
  const next = await api('supplier', 'POST', '/orders/order/transition', { state: 'production' });
  assert.equal(next.status, 200, JSON.stringify(next.body));
});

test('HTTP checkout rolls back the whole group on missing approval and stores explicit or legacy proof', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  const store = setup();
  for (const [fileId, purpose] of [['artwork', 'artwork'], ['receipt', 'payment_proof']]) {
    store.files.push({ fileId, purpose, ownerId: 'client', state: 'ready', objectKey: `private/${fileId}`,
      originalFilename: `${fileId}.pdf`, size: 100, detectedContentType: 'application/pdf', declaredContentType: 'application/pdf',
      artworkCheck: { status: 'passed', checkedAt: AT }, createdAt: AT, references: [] });
  }
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  for (const enabled of [false, true]) {
    const settings = await api('admin', 'GET', '/settings');
    assert.equal((await api('admin', 'PATCH', '/settings', { expectedVersion: settings.body.version, reason: 'Rollout test', approvalProofRequired: enabled })).status, 200);
    const made = await api('client', 'POST', '/me/carts', { fulfillmentMode: 'delivery', defaultDropoff: store.orders[0].dropoff });
    const path = `/me/carts/${made.body.cart.id}`;
    const added = await api('client', 'POST', `${path}/lines`, { catalogItemId: 'item_supplier', quantity: 1, optionIds: [], artworkFileId: 'artwork' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const body = { payment: { method: 'qr_manual', proofFileId: 'receipt', reference: 'CHECKOUT-248' } };
    if (enabled) {
      const before = await db.transaction(() => loadStore(db));
      const denied = await api('client', 'POST', `${path}/checkout`, body);
      assert.equal(denied.body.error, 'approval_proof_required');
      const after = await db.transaction(() => loadStore(db));
      assert.equal(after.orders.length, before.orders.length);
      assert.deepEqual(after.files, before.files);
      assert.equal(after.auditLog.length, before.auditLog.length);
      body.approval = { accepted: true, method: 'one_tap', device, expectedCartVersion: added.body.cart.version };
    }
    const placed = await api('client', 'POST', `${path}/checkout`, body);
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const proof = await api('client', 'GET', `/orders/${placed.body.order.id}/approval-proof`);
    assert.equal(proof.body.approvalProofs[0].status, enabled ? 'approved' : 'legacy_unrecorded');
    assert.equal(proof.body.approvalProofs[0].snapshot.artwork[0].fileId, 'artwork');
  }
});

test('quoted checkout binds final quote specs and requires a drawn approval at commercial commitment', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  const store = setup(), order = store.orders[0];
  order.approvalPolicy.method = 'drawn'; order.state = 'awaiting_checkout';
  order.commercialCommittedAt = null; order.moneyModelVersion = 2; order.quoteVersion = null;
  order.payments = {}; order.paymentAllocations = []; order.payoutMilestones = [];
  order.priceRange = { deliveryFeeStatus: 'estimate' };
  order.pendingQuote = { version: 1, supplierSubtotalMinor: 10000, serviceFeeRateBps: 1000,
    promisedDate: '2026-11-01T00:00:00Z', supplierShop: order.pickup,
    paymentTerms: { deliveryDownpaymentRateBps: 2500 },
    orderLines: [{ label: 'Quoted flyer', quantity: 10, size: 'A4', material: 'Matte', finish: 'Trimmed', amountMinor: 10000 }] };
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  const body = { state: 'awaiting_initial_payment', quoteVersion: 1, fulfillmentMode: 'delivery', paymentPlan: 'delivery_online' };
  assert.equal((await api('client', 'POST', '/orders/order/transition', body)).body.error, 'approval_proof_required');
  const review = await api('client', 'GET', '/orders/order/approval-proof');
  body.approval = { ...approval(store), expectedSnapshotSha256: review.body.review.snapshotSha256, method: 'one_tap' };
  assert.equal((await api('client', 'POST', '/orders/order/transition', body)).body.error, 'invalid_approval');
  body.approval.method = 'drawn';
  const result = await api('client', 'POST', '/orders/order/transition', body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const proof = (await api('client', 'GET', '/orders/order/approval-proof')).body.approvalProofs[0];
  assert.equal(proof.snapshot.quoteVersion, 1);
  assert.equal(proof.snapshot.quoteLines[0].material, 'Matte');
  assert.equal(proof.snapshot.quoteLines[0].amountMinor, undefined);
});
