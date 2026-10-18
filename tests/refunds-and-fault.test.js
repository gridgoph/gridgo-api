import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, actors, id, audit, AT } from './fixtures/reschedule.js';
import { cancellationQuote, publicCancellationQuote } from '../src/fault-policy.js';
import { gatherIssueEvidence, problemPhotos, publicIssue } from '../src/issue-evidence.js';
import { routeIssueDecisions } from '../src/issue-decisions.js';
import { routeRefunds } from '../src/refunds.js';
import { retentionDecision } from '../src/file-retention-policy.js';

const code = expected => error => { assert.equal(error.code, expected); return true; };
const call = (store, who, method, path, body = {}, key = id('key')) => routeRefunds({ store,
  user: actors[who], req: { method, headers: { 'idempotency-key': key } }, url: new URL(path, 'http://test'),
  readBody: async () => body, now: () => AT, id, audit });
const decide = (store, who, body, action = 'decision') => routeIssueDecisions({ store,
  user: actors[who], req: { method: 'POST' }, url: new URL(`/issues/issue/${action}`, 'http://test'),
  readBody: async () => body, now: () => AT, id, audit });

for (const released of [false, true]) test(`post-production cancellation protects the start payout; released=${released}`, () => {
  const store = fixture(), order = store.orders[0];
  if (released) order.payoutMilestones[0].status = 'released';
  const { amounts } = cancellationQuote(store, order);
  assert.equal(amounts.shopEntitlementMinor, 4000);
  assert.equal(amounts.principalMinor, 6000);
  assert.equal(amounts.feeMinor, 600);
  assert.equal(amounts.deliveryMinor, 1000);
  assert.equal(amounts.totalMinor, 7600);
  const publicQuote = publicCancellationQuote(cancellationQuote(store, order));
  assert.deepEqual(Object.keys(publicQuote.refund), ['principalMinor', 'feeMinor', 'deliveryMinor', 'totalMinor']);
  assert.ok(!JSON.stringify(publicQuote).includes('shopEntitlement'));
});

test('pre-production refunds all verified cash; 75 percent collection is not the full order price', () => {
  const store = fixture(), order = store.orders[0];
  order.state = 'payment_authorized'; order.timeline = [];
  assert.equal(cancellationQuote(store, order).amounts.totalMinor, 12000);
  order.payments.initial.amountMinor = 9000;
  order.paymentAllocations.forEach(row => { row.amountMinor = row.amountMinor * 3 / 4; });
  assert.equal(cancellationQuote(store, order).amounts.totalMinor, 9000);
  order.state = 'production';
  assert.equal(cancellationQuote(store, order).amounts.totalMinor, 4600);
});

test('quote refuses historical, already settled, pending cash, and delivery obligations safely', () => {
  for (const [mutate, expected] of [
    [o => { o.payoutPlanVersion = 1; }, 'cancellation_legacy_review_required'],
    [o => { o.state = 'cancelled'; }, 'refund_state_conflict'],
    [o => { o.payments.final_online.status = 'pending_confirmation'; }, 'refund_collection_reconciliation_required'],
    [o => { o.directStoreDueMinor = 10; }, 'refund_collection_reconciliation_required'],
    [o => { o.state = 'rider_assigned'; }, 'cancellation_delivery_review_required'],
    [o => { o.state = 'issue_window_open'; }, 'cancellation_after_delivery'],
    [o => { o.payoutMilestones[0].productionDeductionMinor = 100; }, 'cancellation_manual_review_required'],
  ]) {
    const store = fixture(); mutate(store.orders[0]);
    assert.throws(() => cancellationQuote(store, store.orders[0]), code(expected));
  }
});

test('quote role checks and stale confirmation never create a refund; matching confirmation is idempotent', async () => {
  const store = fixture();
  for (const who of ['other', 'supplier', 'rider']) await assert.rejects(call(store, who, 'GET', '/orders/order/cancellation-quote'), code('forbidden'));
  const quote = (await call(store, 'client', 'GET', '/orders/order/cancellation-quote')).body.quote;
  const body = { kind: 'cancellation', reason: 'Please cancel.', cancellationQuoteToken: quote.quoteToken };
  store.orders[0].updatedAt = '2026-10-06T00:00:00Z';
  await assert.rejects(call(store, 'client', 'POST', '/orders/order/refund-requests', body), code('cancellation_quote_stale'));
  assert.equal(store.refundRequests.length, 0);
  body.cancellationQuoteToken = cancellationQuote(store, store.orders[0]).quoteToken;
  const first = await call(store, 'client', 'POST', '/orders/order/refund-requests', body, 'confirm');
  const replay = await call(store, 'client', 'POST', '/orders/order/refund-requests', body, 'confirm');
  assert.deepEqual(replay.body, first.body);
  assert.equal(store.refundRequests.length, 1);
  assert.equal(first.body.refund.cancellationQuote.refund.totalMinor, 7600);
  assert.equal(store.refundEvents[0].data.cancellationQuote.amounts.shopEntitlementMinor, 4000);
  assert.ok(store.auditLog.some(row => row.action === 'refund.requested'));
});

test('staff cannot settle a confirmed quote for another amount or entitlement', async () => {
  const store = fixture();
  const quote = cancellationQuote(store, store.orders[0]);
  await call(store, 'client', 'POST', '/orders/order/refund-requests', { kind: 'cancellation', reason: 'Cancel', cancellationQuoteToken: quote.quoteToken });
  const request = store.refundRequests[0]; request.status = 'reviewed';
  const path = `/refund-requests/${request.id}/settle`;
  const body = { expectedVersion: request.version, workStopped: true, reason: 'Agreed cancellation', shopAgreement: 'Start payout retained',
    deliveryEvidence: 'No trip started', shopEntitlementMinor: 4000, riderEntitlementMinor: 0, totalMinor: 7600 };
  await assert.rejects(call(store, 'ops', 'POST', path, { ...body, shopEntitlementMinor: 5000, totalMinor: 6500 }), code('cancellation_quote_mismatch'));
  await assert.rejects(call(store, 'ops', 'POST', path, { ...body, principalMinor: 5000, totalMinor: 6500 }), code('cancellation_quote_mismatch'));
  const result = await call(store, 'ops', 'POST', path, body);
  assert.equal(result.body.refund.settlement.totalMinor, 7600);
  assert.equal(store.orders[0].state, 'cancelled');
  assert.equal(store.refundSupplierPayouts[0].amountMinor, 4000);
});

function evidenceStore() {
  const store = fixture(), order = store.orders[0], line = store.orderLineItems[0];
  line.artworkFileId = 'art'; line.specialInstructions = 'Keep the approved border';
  line.artworkGuidance = { files: [{ fileId: 'art', warnings: [{ code: 'low_resolution', acceptedAt: AT }] }] };
  order.approvalProofs = [{ id: 'approval', status: 'approved', at: AT, account: { private: true },
    snapshot: { specification: { size: 'A4' }, items: [{ specialInstructions: 'Approved text' }] } }];
  order.fileCheck = { status: 'passed', checklist: { artwork: true } };
  order.shopHandover = { finished: { photoFileIds: ['qa'] }, review: { decision: 'approved' } };
  order.pickupChecklist = { checks: { quantity: true }, counts: [{ lineId: 'line', count: 10 }],
    packedPhotoFileIds: ['packed'], handoffSignature: { fileId: 'signature' } };
  order.deliveryEvidence = { fileId: 'delivery', evidenceType: 'photo', recordedAt: AT };
  for (const [fileId, purpose, ownerId] of [['art', 'artwork', 'client'], ['qa', 'finished_product_photo', 'supplier'],
    ['packed', 'packing_photo', 'rider'], ['signature', 'handoff_signature', 'rider'],
    ['delivery', 'delivery_photo', 'rider'], ['problem', 'refund_evidence', 'client'], ['unrelated', 'artwork', 'other']]) {
    store.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, detectedContentType: 'image/png',
      declaredContentType: 'image/png', originalFilename: `${fileId}.png`, size: 100, createdAt: AT, references: [],
      ...(fileId === 'art' ? { artworkCheck: { status: 'passed' }, detected: { width: 1000 } } : {}) });
  }
  return store;
}

test('evidence gathers actual preflight, accepted warnings, approved spec, QA, packing, delivery and signatures immutably', () => {
  const store = evidenceStore(), order = store.orders[0];
  const photos = problemPhotos(store, actors.client, { problemType: 'damage', photoFileIds: ['problem'] });
  const snapshot = gatherIssueEvidence(store, order, photos, AT), original = structuredClone(snapshot);
  assert.deepEqual(snapshot.files.map(row => row.fileId), ['art', 'delivery', 'packed', 'problem', 'qa', 'signature']);
  assert.equal(snapshot.files.find(row => row.fileId === 'art').artworkCheck.status, 'passed');
  assert.equal(snapshot.groups[0].data.items[0].artworkGuidance.files[0].warnings[0].acceptedAt, AT);
  assert.equal(snapshot.groups[1].data[0].snapshot.specification.size, 'A4');
  store.orderLineItems[0].specialInstructions = 'Changed';
  order.pickupChecklist.counts[0].count = 3; store.files.find(row => row.fileId === 'art').artworkCheck.status = 'failed';
  assert.deepEqual(snapshot, original);
  for (const forbidden of ['objectKey', 'private/', 'account', 'unrelated']) assert.ok(!JSON.stringify(snapshot).includes(forbidden));
  const issue = { id: 'issue', orderId: 'order', clientId: 'client', status: 'open', evidenceSnapshot: snapshot };
  store.issues.push(issue);
  for (const who of ['client', 'supplier', 'rider']) assert.equal(publicIssue(issue, actors[who]).evidenceSnapshot, undefined);
  for (const who of ['ops', 'admin']) assert.deepEqual(publicIssue(issue, actors[who]).evidenceSnapshot, snapshot);
  assert.equal(retentionDecision(store, store.files.find(row => row.fileId === 'art'), AT).reason, 'open_case');
});

test('new reports require owned ready photos; legacy intake remains compatible and missing proof is explicit', () => {
  const store = evidenceStore();
  assert.deepEqual(problemPhotos(store, actors.client, { kind: 'damage' }), []);
  assert.throws(() => problemPhotos(store, actors.client, { problemType: 'damage', photoFileIds: [] }), code('problem_photos_required'));
  assert.throws(() => problemPhotos(store, actors.other, { problemType: 'damage', photoFileIds: ['problem'] }), code('invalid_problem_photo'));
  store.files.find(row => row.fileId === 'problem').state = 'delete_pending';
  assert.throws(() => problemPhotos(store, actors.client, { problemType: 'damage', photoFileIds: ['problem'] }), code('invalid_problem_photo'));
  const legacy = fixture();
  const snapshot = gatherIssueEvidence(legacy, legacy.orders[0], [], AT);
  assert.deepEqual(snapshot.groups.find(row => row.id === 'approvals').data, []);
  assert.equal(snapshot.groups.find(row => row.id === 'file_check').data, null);
});

function caseStore() {
  const store = evidenceStore();
  store.issues.push({ id: 'issue', orderId: 'order', clientId: 'client', status: 'open', version: 1,
    evidenceSnapshot: gatherIssueEvidence(store, store.orders[0], [], AT) });
  return store;
}
const decisionBody = fault => ({ expectedVersion: 1, fault, remedy: fault === 'client' ? 'none' : 'reprint',
  reason: 'Custody and approved evidence reviewed manually.', evidenceIds: ['shop_qa', 'rider_check'],
  costMinor: fault === 'client' ? 0 : 100000, gridgoCostMinor: ['rider', 'gridgo'].includes(fault) ? 100000 : 0 });
for (const fault of ['shop', 'rider', 'gridgo', 'client']) test(`Operations records ${fault} fault without automated money or claim changes`, async () => {
  const store = caseStore(), before = structuredClone(store.orders[0]);
  const result = await decide(store, 'ops', decisionBody(fault));
  assert.equal(result.body.issue.faultDecision.fault, fault);
  assert.equal(result.body.issue.faultDecision.status, 'approved');
  assert.deepEqual(store.orders[0], before);
  assert.equal(store.refundSettlements.length, 0);
  assert.equal(store.claims.length, 0);
  assert.equal(store.auditLog.at(-1).action, 'issue.fault_recorded');
  for (const actor of ['client', 'ops', 'admin']) assert.ok(store.notifications.some(row => row.userId === actor));
});

test('GRIDGO funding above 1000 including a shop advance needs exact-version Super Admin approval', async () => {
  for (const fault of ['shop', 'rider', 'gridgo']) {
    const store = caseStore();
    let result = await decide(store, 'ops', { ...decisionBody(fault), costMinor: 100001, gridgoCostMinor: 100001 });
    const issue = result.body.issue;
    assert.equal(issue.faultDecision.status, 'awaiting_approval');
    const approval = { expectedVersion: 2, decisionId: issue.faultDecision.id, reason: 'Approve this amount' };
    await assert.rejects(decide(store, 'ops', approval, 'approve-decision'), code('fault_super_admin_required'));
    await assert.rejects(decide(store, 'admin', { ...approval, expectedVersion: 1 }, 'approve-decision'), code('issue_stale'));
    result = await decide(store, 'admin', approval, 'approve-decision');
    assert.equal(result.body.issue.faultDecision.status, 'approved');
    assert.equal(result.body.issue.faultDecisionHistory.length, 2);
    assert.equal(store.auditLog.at(-1).action, 'issue.fault_approved');
  }
});

test('manual decision refuses outsiders, missing evidence, client refunds and unaccounted funding', async () => {
  for (const who of ['client', 'supplier', 'rider', 'other']) await assert.rejects(decide(caseStore(), who, decisionBody('shop')), code('forbidden'));
  await assert.rejects(decide(caseStore(), 'ops', { ...decisionBody('shop'), evidenceIds: ['invented'] }), code('fault_evidence_required'));
  await assert.rejects(decide(caseStore(), 'ops', { ...decisionBody('client'), remedy: 'full_refund' }), code('fault_client_no_refund'));
  await assert.rejects(decide(caseStore(), 'ops', { ...decisionBody('rider'), gridgoCostMinor: 0 }), code('invalid_fault_funding'));
  await assert.rejects(decide(caseStore(), 'ops', { ...decisionBody('shop'), remedy: 'full_refund' }), code('fault_reason_required'));
});

test('complaint settlement cannot bypass a pending funded decision or a non-refund remedy', async () => {
  const store = caseStore();
  await call(store, 'client', 'POST', '/orders/order/refund-requests', { kind: 'complaint', reason: 'Defect found' });
  const refund = store.refundRequests[0]; refund.status = 'reviewed';
  await decide(store, 'ops', { ...decisionBody('shop'), remedy: 'full_refund', alternativesReason: 'No usable work', costMinor: 100001, gridgoCostMinor: 100001 });
  const body = { expectedVersion: refund.version, reason: 'Settle the complaint', workStopped: true, shopAgreement: 'Agreed',
    deliveryEvidence: 'Not delivered', shopEntitlementMinor: 0, riderEntitlementMinor: 0, totalMinor: 12000 };
  await assert.rejects(call(store, 'ops', 'POST', `/refund-requests/${refund.id}/settle`, body), code('fault_approval_pending'));
  await decide(store, 'ops', { ...decisionBody('client'), expectedVersion: 2 });
  await assert.rejects(call(store, 'ops', 'POST', `/refund-requests/${refund.id}/settle`, body), code('fault_refund_not_authorized'));
  assert.equal(store.refundSettlements.length, 0);
});
