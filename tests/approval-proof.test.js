import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalPolicy, approvalReviewSnapshot, approvalSnapshotSha256, recordApprovalProof, assertApprovalBeforeProceeding, approveSample,
  routeApprovalProof, approvalProofPdf } from '../src/approval-proof.js';
import { publicOrderFor } from '../src/operational-model.js';
import { authorizeFileRead, authorizeFileUpload, validateUpload, resolveFileTarget, PURPOSE_POLICIES } from '../src/attachments.js';
import { retentionDecision, assertEarlyFileDeletion } from '../src/file-retention-policy.js';
import { fixture, actors, AT, id } from './fixtures/reschedule.js';

export const device = { id: 'install-test', platform: 'android', appVersion: '2.4.8' };
export function approvalFor(store, method = 'one_tap') {
  return { accepted: true, method, device, signatureFileId: method === 'drawn' ? 'signature' : undefined,
    samplePhotoFileId: 'sample', expectedSnapshotSha256: approvalSnapshotSha256(approvalReviewSnapshot(store, store.orders[0])) };
}
export function proofFixture() {
  const store = fixture();
  const order = store.orders[0];
  order.approvalPolicy = approvalPolicy({ approvalProofRequired: true });
  for (const [fileId, purpose] of [['signature', 'approval_signature'], ['sample', 'approval_sample_photo']]) {
    store.files.push({ fileId, purpose, ownerId: 'client', state: 'ready', objectKey: `private/${fileId}`,
      contentSha256: 'a'.repeat(64), originalFilename: `${fileId}.png`, size: 100, detectedContentType: 'image/png', declaredContentType: 'image/png', createdAt: AT, references: [] });
  }
  return store;
}
const record = (store, approval, options = {}) => recordApprovalProof({ store, order: store.orders[0], user: actors.client, approval, at: AT, id, ...options });
const call = (store, user, path = '', method = 'GET', body) => routeApprovalProof({ store, user, req: { method },
  url: new URL(`http://test/orders/order/approval-proof${path}`), readBody: async () => body, now: () => AT, id });

test('approval method follows merchandise taxonomy and quoted jobs, rollout defaults off', () => {
  assert.deepEqual(approvalPolicy(), { version: 1, required: false, method: 'one_tap' });
  assert.equal(approvalPolicy({}, { categories: ['corporate_event_merch'] }).method, 'drawn');
  assert.equal(approvalPolicy({}, { quoted: true }).method, 'drawn');
});

test('approval uploads are client-only PNG signatures and photo evidence, bound only at approval', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = { originalFilename: 'signature.png', size: png.length, buffer: png, sniffBytes: png, declaredContentType: 'image/png' };
  for (const purpose of ['approval_signature', 'approval_sample_photo']) {
    authorizeFileUpload(actors.client, purpose);
    assert.equal(validateUpload(file, purpose), 'image/png');
    for (const actor of [actors.supplier, actors.rider, actors.ops, actors.admin]) assert.throws(() => authorizeFileUpload(actor, purpose), { code: 'forbidden' });
    assert.throws(() => resolveFileTarget(proofFixture(), purpose, { orderId: 'order' }, actors.client), { code: 'invalid_file_purpose' });
  }
  assert.throws(() => validateUpload({ ...file, size: 2097153 }, 'approval_signature'), { code: 'file_too_large' });
});

test('proof freezes agreed snapshots and excludes supplier money and private storage keys', () => {
  const store = proofFixture(), order = store.orders[0], line = store.orderLineItems[0];
  Object.assign(line, { printLayout: { version: 1, code: 'fit' }, colorTargets: { targets: [{ value: '#123456' }] },
    artworkGuidance: { warnings: [{ code: 'low_resolution', accepted: true }] },
    coverSpine: { cover: 'text_only', spine: { title: 'Approved title' } }, specialInstructions: 'Keep this margin',
    colourPricing: { version: 1, quantity: 10, totalSheets: 10, lineSubtotalMinor: 9876, pages: [{ fileId: 'art', page: 1, tier: 'heavy', sheetPriceMinor: 9876 }] } });
  const proof = record(store, approvalFor(store));
  const original = structuredClone(proof);
  line.specialInstructions = 'Changed later'; line.colorTargets.targets[0].value = '#ffffff';
  store.catalogItems[0].name = 'New listing'; store.users[0].name = 'New name';
  store.settings.approvalProofRequired = false;
  assert.deepEqual(order.approvalProofs[0], original);
  const text = JSON.stringify(proof);
  for (const secret of ['supplierSubtotalMinor', 'lineSubtotalMinor', 'sheetPriceMinor', 'payoutMilestones', 'objectKey', 'clerkUserId']) assert.ok(!text.includes(secret), secret);
  assert.equal(proof.snapshot.items[0].colourPricing.pages[0].tier, 'heavy');
  assertApprovalBeforeProceeding(order);
  order.quoteVersion = 2;
  assert.throws(() => assertApprovalBeforeProceeding(order), { code: 'approval_proof_required' });
});

test('explicit approvals bind device, current specs and correct owned ready signature', () => {
  const store = proofFixture(); store.orders[0].approvalPolicy.method = 'drawn';
  assert.throws(() => record(store), { code: 'approval_proof_required' });
  assert.throws(() => record(store, approvalFor(store)), { code: 'invalid_approval' });
  assert.throws(() => record(store, { ...approvalFor(store, 'drawn'), device: null }), { code: 'approval_device_required' });
  assert.throws(() => record(store, { ...approvalFor(store, 'drawn'), expectedSnapshotSha256: 'old' }), { code: 'approval_snapshot_stale' });
  store.files.find(file => file.fileId === 'signature').ownerId = 'other';
  assert.throws(() => record(store, approvalFor(store, 'drawn')), { code: 'invalid_approval_file' });
  store.files.find(file => file.fileId === 'signature').ownerId = 'client';
  store.files.find(file => file.fileId === 'signature').state = 'pending_upload';
  assert.throws(() => record(store, approvalFor(store, 'drawn')), { code: 'file_not_ready' });
  store.files.find(file => file.fileId === 'signature').state = 'ready';
  assert.equal(record(store, approvalFor(store, 'drawn')).method, 'drawn');
});

test('legacy builds retain a truthful unrecorded snapshot and are not retroactively gated', () => {
  const store = proofFixture(), order = store.orders[0];
  order.approvalPolicy.required = false;
  const proof = record(store);
  assert.equal(proof.status, 'legacy_unrecorded'); assert.equal(proof.method, null); assert.equal(proof.statement, null);
  assertApprovalBeforeProceeding(order);
  assertApprovalBeforeProceeding({ state: 'production' });
});

test('sample approval requires handwriting plus sample photo and cannot carry over a new sample round', async () => {
  const store = proofFixture(), order = store.orders[0]; order.state = 'proof_approval';
  const context = { store, order, user: actors.client, at: AT, id };
  assert.throws(() => approveSample(context), { code: 'approval_proof_required' });
  assert.throws(() => approveSample({ ...context, approval: { ...approvalFor(store, 'drawn'), samplePhotoFileId: null } }), { code: 'invalid_approval_file' });
  const firstApproval = approvalFor(store, 'drawn');
  await call(store, actors.client, '', 'POST', { approval: firstApproval });
  assert.equal(order.approvalProofs[0].samplePhotoFileId, 'sample');
  approveSample(context); assert.equal(order.approvalProofs.length, 1);
  order.timeline.push({ state: 'proof_approval', at: '2026-10-06T00:00:00Z' });
  assert.throws(() => approveSample(context), { code: 'approval_proof_required' });
  assert.throws(() => approveSample({ ...context, approval: firstApproval }), { code: 'approval_snapshot_stale' });
});

test('proof and evidence reads are role scoped, supplier gated by file check, rider stripped', async () => {
  const store = proofFixture(), order = store.orders[0];
  record(store, approvalFor(store, 'drawn'));
  for (const actor of ['client', 'supplier', 'ops', 'admin']) {
    const result = await call(store, actors[actor]); assert.equal(result.status, 200, actor);
    authorizeFileRead(store.users.find(user => user.id === actors[actor].id), store, store.files.find(file => file.fileId === 'signature'));
  }
  for (const actor of ['other', 'replacement', 'rider']) {
    await assert.rejects(call(store, actors[actor]), { code: 'forbidden' });
    assert.throws(() => authorizeFileRead(store.users.find(user => user.id === actors[actor].id), store, store.files.find(file => file.fileId === 'signature')), { code: 'forbidden' });
  }
  await assert.rejects(call(store, null), { code: 'unauthorized' });
  const rider = publicOrderFor({ ...order, riderId: 'rider' }, actors.rider, store);
  assert.ok(!('approvalProofs' in rider)); assert.ok(!('approvalProof' in rider));
  assert.ok(!('approvalPolicy' in rider));
  const client = publicOrderFor(order, actors.client, store);
  assert.ok(client.approvalProof); assert.ok(!('approvalProofs' in client));
  client.approvalProof.requirement.required = false;
  assert.equal(order.approvalPolicy.required, true);
  assert.doesNotThrow(() => publicOrderFor(order, actors.supplier));
  order.fileCheck = { status: 'pending' };
  await assert.rejects(call(store, actors.supplier), { code: 'forbidden' });
  store.orderJobs.push({ id: 'otherjob', orderId: order.id, supplierId: 'replacement' });
  order.fileCheck.status = 'passed';
  await assert.rejects(call(store, actors.supplier), { code: 'forbidden' });
});

for (const actor of ['client', 'supplier', 'ops', 'admin']) {
  test(`${actor} proof JSON and PDF apply client identity privacy without changing stored evidence`, async () => {
    const store = proofFixture(), order = store.orders[0];
    const proof = record(store, approvalFor(store, 'drawn'), {
      user: { ...actors.client, name: 'Approval fixture', email: 'approval@example.invalid' },
      req: { headers: { 'user-agent': 'approval-fixture-agent' } },
    });
    // Future evidence fields must not silently widen the shop projection.
    proof.ipAddress = '192.0.2.10';
    const original = structuredClone(proof);
    const read = await call(store, actors[actor]);
    const projected = read.body.approvalProofs[0];
    const pdf = (await call(store, actors[actor], '/download')).pdf.toString();
    if (actor === 'supplier') {
      for (const key of ['account', 'device', 'userAgent', 'ipAddress']) assert.ok(!(key in projected), key);
      for (const value of ['Approval fixture', 'approval@example.invalid', 'install-test', 'approval-fixture-agent', '192.0.2.10']) {
        assert.ok(!JSON.stringify(read.body).includes(value), value);
        assert.ok(!pdf.includes(value), value);
      }
      for (const label of ['Account:', 'Device and app:', 'App user agent:']) assert.ok(!pdf.includes(label), label);
    } else {
      assert.deepEqual(projected, original);
      for (const value of ['Approval fixture', 'approval@example.invalid', 'install-test', 'approval-fixture-agent']) assert.ok(pdf.includes(value), value);
    }
    assert.deepEqual(projected.snapshot, original.snapshot);
    assert.equal(projected.snapshotSha256, original.snapshotSha256);
    assert.equal(projected.signatureFileId, 'signature');
    assert.ok(pdf.includes(original.snapshotSha256));
    assert.deepEqual(order.approvalProofs[0], original);
  });
}

for (const actor of [actors.other, actors.replacement, actors.rider, { id: 'staff', role: 'staff' }, { id: 'unknown', role: 'unknown' }, null]) {
  test(`${actor?.role ?? 'anonymous'} unauthorized proof reads deny both JSON and PDF`, async () => {
    const store = proofFixture(); record(store, approvalFor(store));
    for (const path of ['', '/download']) await assert.rejects(call(store, actor, path), { code: actor ? 'forbidden' : 'unauthorized' });
  });
}

test('PDF is paginated, uses exact immutable records, and signature retention follows evidence policy', async () => {
  const store = proofFixture(), order = store.orders[0];
  const proof = record(store, approvalFor(store, 'drawn'));
  const pdf = approvalProofPdf([proof]).toString();
  assert.ok(pdf.startsWith('%PDF-1.4')); assert.ok(pdf.includes(proof.snapshotSha256)); assert.ok(pdf.endsWith('%%EOF\n'));
  assert.equal((await call(store, actors.client, '/download')).pdf.toString(), pdf);
  assert.equal(PURPOSE_POLICIES.approval_signature.maxBytes, 2097152);
  assert.deepEqual(PURPOSE_POLICIES.approval_signature.contentTypes, ['image/png']);
  order.state = 'completed'; order.completedAt = '2025-10-01T00:00:00Z';
  const file = store.files.find(file => file.fileId === 'signature');
  assert.equal(retentionDecision(store, file, AT).eligible, true);
  store.issues.push({ id: 'issue', orderId: order.id, status: 'open' });
  assert.equal(retentionDecision(store, file, AT).reason, 'open_case');
  assert.throws(() => assertEarlyFileDeletion(store, file, actors.admin, 'requested'), { code: 'file_retention_hold' });
});
