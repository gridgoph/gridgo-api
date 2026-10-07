import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArtworkBytes, checkArtworkUpload } from '../src/artwork-file-check.js';
import { supplierArtworkReleased, fileCheckProjection, recordFileCheckTransition } from '../src/artwork-gates.js';
import { canAccessOrder, invalidateAudienceIds } from '../src/notifications.js';
import { deriveDomainEvents } from '../src/domain-events.js';
import { canReadOrderArtwork } from '../src/order-file-access.js';
import { publicOrderFor } from '../src/operational-model.js';

const AT = '2026-10-05T00:00:00.000Z';
const pdf = readFileSync(new URL('./fixtures/artwork-check/page.pdf', import.meta.url));
const png = readFileSync(new URL('./fixtures/artwork-check/pixel.png', import.meta.url));
test('automatic artwork file check rejects truncated, encrypted and unreadable bytes', async () => {
  const check = bytes => checkArtworkBytes(bytes, bytes, bytes.length, 'application/pdf', AT);
  assert.equal(check(pdf).status, 'passed');
  for (const bytes of [Buffer.from('%PDF-1.7'), Buffer.from('broken'), Buffer.from(pdf.toString().replace('/Type', '/Encrypt 2 0 R /Type'))]) {
    const result = check(bytes);
    assert.equal(result.status, 'failed');
    assert.match(result.message, /upload and replace/);
  }
  assert.equal((await checkArtworkUpload({ tempPath: '/missing-artwork-check-file' }, 'application/pdf', AT)).status, 'failed');
});
test('image and design headers alone never pass the file check', () => {
  for (const [type, bytes] of [
    ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['image/jpeg', Buffer.from('ffd8ffffd9', 'hex')],
    ['image/webp', Buffer.from('RIFF0000WEBP')],
    ['image/vnd.adobe.photoshop', Buffer.from('8BPS')],
  ]) assert.equal(checkArtworkBytes(bytes, bytes, bytes.length, type, AT).status, 'failed');
});

function fixture() {
  const order = { id: 'order', clientId: 'client', supplierId: 'shop', state: 'initial_payment_review',
    timeline: [], createdAt: AT, fileCheck: { status: 'pending', requestedAt: AT } };
  return { order, store: { orders: [order], users: [{ id: 'shop', role: 'supplier', verificationStatus: 'approved' }],
    userRoleMemberships: [{ userId: 'shop', role: 'supplier' }, { userId: 'ops', role: 'ops_admin' }, { userId: 'super', role: 'super_admin' }],
    notifications: [], orderJobs: [{ id: 'job', orderId: 'order', supplierId: 'shop' }],
    orderLineItems: [{ id: 'line', orderId: 'order', jobId: 'job', artworkFileId: 'file', artworkLinks: [{ url: 'https://example.com/private', formatCode: 'other_link' }] }] } };
}

test('pending and failed review block shop reads, artwork, inbox and realtime even with a known assignment', () => {
  for (const status of ['pending', 'failed']) {
    const { store, order } = fixture();
    order.fileCheck.status = status;
    assert.equal(canAccessOrder(store, 'shop', order, { role: 'supplier' }), false);
    assert.equal(canReadOrderArtwork({ id: 'shop', role: 'supplier' }, store, order, 'file', 'artwork'), false);
    assert.deepEqual(publicOrderFor(order, { id: 'shop', role: 'supplier' }, store).productionItems, []);
    assert.equal(invalidateAudienceIds(store, { resource: 'jobs', id: order.id, supplierId: 'shop' }).includes('shop'), false);
    const before = structuredClone(store);
    order.state = 'cancelled';
    order.updatedAt = AT;
    deriveDomainEvents(store, before, { at: AT, createId: prefix => `${prefix}_${store.notifications.length}` });
    assert.equal(store.notifications.some(row => row.appRole === 'supplier'), false);
  }
});

test('Operations decision and resubmission expose elapsed wait and audit actor without releasing on a timer', () => {
  const { order } = fixture();
  assert.equal(fileCheckProjection(order, '2026-10-05T04:00:00Z').waitingSeconds, 14400);
  assert.equal(supplierArtworkReleased(order), false);
  recordFileCheckTransition(order, 'needs_qa', 'client_correction', { id: 'ops' }, AT, '  Export readable artwork  ');
  assert.equal(order.fileCheck.reason, 'Export readable artwork');
  assert.equal(supplierArtworkReleased(order), false);
  recordFileCheckTransition(order, 'client_correction', 'needs_qa', { id: 'client' }, AT, '');
  assert.equal(order.fileCheck.status, 'pending');
  recordFileCheckTransition(order, 'needs_qa', 'supplier_assigned', { id: 'ops' }, AT, '');
  assert.equal(supplierArtworkReleased(order), true);
  assert.equal(order.fileCheck.reviewedBy, 'ops');
  assert.equal(fileCheckProjection(order, AT).waitingSeconds, 0);
});

test('legacy production remains readable while legacy intake stays held', () => {
  assert.equal(supplierArtworkReleased({ state: 'production' }), true);
  assert.equal(supplierArtworkReleased({ state: 'needs_qa' }), false);
  assert.equal(supplierArtworkReleased({ state: 'initial_payment_review', timeline: [{ state: 'supplier_assigned' }] }), true);
});

test('complete PNG passes, and bad checksums or missing image data fail', () => {
  assert.equal(checkArtworkBytes(png, png, png.length, 'image/png', AT).status, 'passed');
  const corrupt = Buffer.from(png); corrupt[45] ^= 1;
  assert.equal(checkArtworkBytes(corrupt, corrupt, corrupt.length, 'image/png', AT).status, 'failed');
  const noData = Buffer.concat([png.subarray(0, 33), png.subarray(-12)]);
  assert.equal(checkArtworkBytes(noData, noData, noData.length, 'image/png', AT).status, 'failed');
});

test('WebP and Photoshop structural checks accept supported complete containers and refuse inconsistent lengths', () => {
  const webp = Buffer.from('52494646220000005745425056503820160000003001009d012a010001000ec0fe25a400037000000000', 'hex');
  assert.equal(checkArtworkBytes(webp, webp, webp.length, 'image/webp', AT).status, 'passed');
  const shortened = webp.subarray(0, -1);
  assert.equal(checkArtworkBytes(shortened, shortened, shortened.length, 'image/webp', AT).status, 'failed');
  const psd = Buffer.alloc(43);
  psd.write('8BPS'); psd.writeUInt16BE(1, 4); psd.writeUInt16BE(3, 12);
  psd.writeUInt32BE(1, 14); psd.writeUInt32BE(1, 18); psd.writeUInt16BE(8, 22); psd.writeUInt16BE(3, 24);
  assert.equal(checkArtworkBytes(psd, psd, psd.length, 'image/vnd.adobe.photoshop', AT).status, 'passed');
  assert.equal(checkArtworkBytes(psd.subarray(0, -1), psd.subarray(0, -1), psd.length - 1, 'image/vnd.adobe.photoshop', AT).status, 'failed');
});

test('resubmitting through the legacy submitted state restarts the review, and cancellation stops its wait', () => {
  const { order } = fixture();
  order.fileCheck.status = 'failed';
  recordFileCheckTransition(order, 'client_correction', 'submitted', { id: 'client' }, AT, '');
  assert.equal(order.fileCheck.status, 'pending');
  recordFileCheckTransition(order, 'submitted', 'cancelled', { id: 'ops' }, AT, '');
  assert.equal(order.fileCheck.status, 'cancelled');
  assert.equal(fileCheckProjection(order, '2026-10-06T00:00:00Z').waitingSeconds, 0);
  assert.equal(supplierArtworkReleased(order), false);
});

const QA_TICKS = { artwork: true, spec: true, quantity: true, address: true };
test('QA preserves explicit item results with the authenticated reviewer and clears them on resubmission', () => {
  const { order, store } = fixture();
  const checks = { ...QA_TICKS, artwork: false };
  recordFileCheckTransition(order, 'needs_qa', 'client_correction', { id: 'ops' }, AT, 'Replace artwork', checks);
  assert.deepEqual(order.fileCheck.checklist, { version: 1, checks });
  assert.equal(order.fileCheck.reviewedBy, 'ops');
  assert.equal(order.fileCheck.reviewedAt, AT);
  checks.spec = false;
  assert.equal(order.fileCheck.checklist.checks.spec, true, 'snapshot must not retain input references');
  assert.equal(publicOrderFor(order, { id: 'client', role: 'client' }, store).fileCheck.checklist, undefined);
  assert.equal(publicOrderFor(order, { id: 'shop', role: 'supplier' }, store).fileCheck, undefined);
  recordFileCheckTransition(order, 'client_correction', 'needs_qa', { id: 'client' }, AT, '');
  assert.equal(order.fileCheck.checklist, null);
  recordFileCheckTransition(order, 'needs_qa', 'supplier_assigned', { id: 'ops' }, AT, '', QA_TICKS);
  assert.deepEqual(fileCheckProjection(order, AT).checklist, { version: 1, checks: QA_TICKS });
});

test('legacy decisions never fabricate per-item results', () => {
  const { order } = fixture();
  recordFileCheckTransition(order, 'needs_qa', 'supplier_assigned', { id: 'ops' }, AT, '');
  assert.equal(fileCheckProjection(order, AT).checklist, null);
  delete order.fileCheck.checklist;
  assert.equal(fileCheckProjection(order, AT).checklist, null);
});

test('QA rejects partial, unknown, nonboolean and incomplete approval checklists', () => {
  for (const checks of [null, [], {}, { ...QA_TICKS, extra: true }, { ...QA_TICKS, artwork: 'true' }, { ...QA_TICKS, artwork: false }]) {
    const { order } = fixture();
    const before = structuredClone(order);
    assert.throws(() => recordFileCheckTransition(order, 'needs_qa', 'supplier_assigned', { id: 'ops' }, AT, '', checks),
      error => error.status === 400 && error.code === 'invalid_qa_checklist');
    assert.deepEqual(order, before);
  }
});

test('legacy intake can record an explicit checklist without inventing an earlier review', () => {
  const { order } = fixture();
  delete order.fileCheck;
  recordFileCheckTransition(order, 'needs_qa', 'supplier_assigned', { id: 'ops' }, AT, '', QA_TICKS);
  assert.deepEqual(order.fileCheck.checklist, { version: 1, checks: QA_TICKS });
  assert.equal(order.fileCheck.reviewedAt, AT);
});
