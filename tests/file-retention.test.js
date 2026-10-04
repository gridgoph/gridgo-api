import test from 'node:test';
import assert from 'node:assert/strict';
import { retentionDecision, assertEarlyFileDeletion } from '../src/file-retention-policy.js';

const at = '2031-10-04T00:00:00.000Z';
const close = '2026-10-04T00:00:00.000Z';
function fixture(purpose = 'artwork') {
  const file = { fileId: 'file', ownerId: 'client', purpose, state: 'ready', createdAt: close,
    references: [{ type: 'order', id: 'order', field: purpose }] };
  const order = { id: 'order', clientId: 'client', state: 'completed', timeline: [{ state: 'completed', at: close }] };
  return { file, store: { files: [file], orders: [order], users: [{ id: 'client', accountStatus: 'active' }] } };
}
for (const [purpose, deadline] of [
  ['artwork', '2026-11-03'], ['mockup', '2026-11-03'],
  ['payment_proof', '2031-10-04'], ['payout_receipt', '2031-10-04'], ['refund_receipt', '2031-10-04'],
  ['refund_qr', '2031-10-04'], ['refund_evidence', '2031-10-04'],
  ['production_photo', '2027-10-04'], ['fulfilment_proof', '2027-10-04'],
  ['delivery_photo', '2027-10-04'], ['handoff_signature', '2027-10-04'],
]) test(`${purpose} expires at its deadline, never before`, () => {
  const { store, file } = fixture(purpose);
  const due = `${deadline}T00:00:00.000Z`;
  assert.equal(retentionDecision(store, file, new Date(Date.parse(due) - 1).toISOString()).eligible, false);
  assert.equal(retentionDecision(store, file, due).eligible, true);
});

test('all referenced orders must be closed; artwork requires completion and a stable timestamp', () => {
  const { store, file } = fixture();
  store.orders[0].state = 'cancelled';
  assert.equal(retentionDecision(store, file, at).eligible, false);
  store.orders[0].state = 'completed'; store.orders[0].timeline = [];
  assert.equal(retentionDecision(store, file, at).eligible, false);
  store.orders[0].timeline = [{ state: 'completed', at: close }];
  file.references.push({ type: 'order', id: 'missing' });
  assert.equal(retentionDecision(store, file, at).eligible, false);
});

for (const [collection, status] of [['issues', 'open'], ['claims', 'raised'], ['refundRequests', 'payment_unknown'], ['disputes', 'open'], ['escalations', 'open']]) {
  test(`${collection} blocks scheduled and Super Admin early deletion`, () => {
    const { store, file } = fixture();
    store[collection] = [{ id: 'case', orderId: 'order', status }];
    assert.equal(retentionDecision(store, file, at).eligible, false);
    assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'admin', role: 'super_admin' }, 'Written reason'), { code: 'file_retention_hold' });
  });
}

test('refund-only and reverse order-line links protect evidence', () => {
  const { store, file } = fixture('refund_receipt');
  file.references = [{ type: 'refund_request', id: 'refund' }];
  store.refundRequests = [{ id: 'refund', orderId: 'order', status: 'requested' }];
  assert.equal(retentionDecision(store, file, at).eligible, false);
  store.refundRequests[0].status = 'paid';
  assert.equal(retentionDecision(store, file, at).eligible, true);
  file.references = []; store.orderLineItems = [{ orderId: 'order', artworkFileId: 'file' }];
  store.issues = [{ orderId: 'order', status: 'open' }];
  assert.equal(retentionDecision(store, file, at).eligible, false);
});

for (const purpose of ['verification_document', 'rider_verification_document', 'business_verification_document', 'organization_verification_document']) {
  test(`${purpose} is retained for active/suspended accounts and one year after removal or rejection`, () => {
    const { store, file } = fixture(purpose);
    file.references = [{ type: 'user', id: 'client' }]; store.orders = [];
    assert.equal(retentionDecision(store, file, at).eligible, false);
    store.users[0].accountStatus = 'suspended'; store.users[0].accountStatusAt = close;
    assert.equal(retentionDecision(store, file, at).eligible, false);
    store.users[0].accountStatus = 'removed';
    assert.equal(retentionDecision(store, file, '2027-10-03T23:59:59Z').eligible, false);
    assert.equal(retentionDecision(store, file, '2027-10-04T00:00:00Z').eligible, true);
    store.users[0].accountStatus = 'active';
    store.approvalCases = [{ userId: 'client', kind: purpose.startsWith('rider') ? 'rider' : purpose === 'verification_document' ? 'supplier' : 'business_client', status: 'rejected', decidedAt: close }];
    assert.equal(retentionDecision(store, file, '2027-10-03T23:59:59Z').eligible, false);
    assert.equal(retentionDecision(store, file, '2027-10-04T00:00:00Z').eligible, true);
  });
}

test('unused files expire after upload grace; draft cart artwork remains in use', () => {
  const { store, file } = fixture('catalog_item_photo'); file.references = []; store.orders = [];
  assert.equal(retentionDecision(store, file, '2026-10-04T23:59:59Z').eligible, false);
  assert.equal(retentionDecision(store, file, '2026-10-05T00:00:00Z').eligible, true);
  file.purpose = 'artwork'; store.carts = [{ id: 'cart', state: 'draft' }];
  store.cartLines = [{ cartId: 'cart', artworkFileId: 'file' }];
  assert.equal(retentionDecision(store, file, at).eligible, false);
});

test('early delete: Super Admin reason, client ownership/completion, all other roles denied', () => {
  const { store, file } = fixture();
  for (const role of ['supplier', 'rider', 'ops_admin']) {
    assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'client', role }, 'reason'), { code: 'forbidden' });
  }
  assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'admin', role: 'super_admin' }, '  '), { code: 'reason_required' });
  assert.doesNotThrow(() => assertEarlyFileDeletion(store, file, { id: 'admin', role: 'super_admin' }, 'A written reason'));
  assert.doesNotThrow(() => assertEarlyFileDeletion(store, file, { id: 'client', role: 'client' }));
  assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'other', role: 'client' }), { code: 'forbidden' });
  store.orders[0].state = 'production';
  assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'client', role: 'client' }), { code: 'file_in_use' });
  file.references = []; store.orders = [];
  assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'client', role: 'client' }), { code: 'file_in_use' });
});

test('later payout and case activity cannot reset the artwork completion clock', () => {
  const { store, file } = fixture();
  store.orders[0].timeline.push({ state: 'completed', at: '2026-11-01T00:00:00Z', note: 'Payout released' });
  store.orders[0].updatedAt = '2026-11-01T00:00:00Z';
  assert.equal(retentionDecision(store, file, '2026-11-03T00:00:00Z').eligible, true);
});
test('direct issue references are held even if the case has no reverse file list', () => {
  const { store, file } = fixture();
  file.references = [{ type: 'issue', id: 'issue' }];
  store.issues = [{ id: 'issue', orderId: 'order', status: 'open' }];
  assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'admin', role: 'super_admin' }, 'Remove evidence'), { code: 'file_retention_hold' });
});

test('an announcement image still used by an inbox is not an orphan', () => {
  const { store, file } = fixture('announcement_image');
  file.references = []; store.orders = [];
  store.notifications = [{ imageUrl: 'https://api.example/public/announcement-images/file' }];
  assert.equal(retentionDecision(store, file, at).eligible, false);
});
test('replaced verification documents retain the account clock rather than the upload grace', () => {
  const { store, file } = fixture('verification_document');
  file.references = []; file.verificationDocumentType = 'valid_id'; store.orders = [];
  assert.equal(retentionDecision(store, file, at).eligible, false);
});
test('all orders sharing artwork must complete and pass their own 30-day window', () => {
  const { store, file } = fixture();
  store.orders.push({ id: 'second', clientId: 'client', state: 'production' });
  file.references.push({ type: 'order', id: 'second' });
  assert.equal(retentionDecision(store, file, at).eligible, false);
  store.orders[1].state = 'completed'; store.orders[1].completedAt = '2031-10-01T00:00:00Z';
  assert.equal(retentionDecision(store, file, at).eligible, false);
  assert.equal(retentionDecision(store, file, '2031-10-31T00:00:00Z').eligible, true);
});

test('invalid legacy completion timestamps fail closed rather than expiring in 1970', () => {
  const { store, file } = fixture(); store.orders[0].completedAt = 'invalid';
  assert.equal(retentionDecision(store, file, at).eligible, false);
});

for (const [collection, status] of [['issues', 'resolved'], ['issues', 'dismissed'], ['claims', 'released'], ['claims', 'resolved'], ['refundRequests', 'paid'], ['refundRequests', 'rejected'], ['refundRequests', 'withdrawn']]) {
  test(`terminal ${collection}/${status} releases the retention hold`, () => {
    const { store, file } = fixture(); store[collection] = [{ id: 'case', orderId: 'order', status }];
    assert.equal(retentionDecision(store, file, at).eligible, true);
  });
}
test('verification documents remain protected by open cases on the owner’s orders', () => {
  const { store, file } = fixture('verification_document'); file.references = [{ type: 'user', id: 'client' }];
  store.issues = [{ orderId: 'order', status: 'open' }];
  assert.throws(() => assertEarlyFileDeletion(store, file, { id: 'admin', role: 'super_admin' }, 'Review completed'), { code: 'file_retention_hold' });
});
