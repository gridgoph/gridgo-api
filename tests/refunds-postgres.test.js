import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createDatabase } from '../src/database.js';
import { emptyStore, loadStore, saveStore } from '../src/postgres-store.js';
import { createFileRetention } from '../src/file-retention.js';
import { routeRefunds } from '../src/refunds.js';
import { calculateRefundSettlement, collectedRefundComponents, assertRefundWorkAllowed } from '../src/refund-policy.js';
import { createPayoutMilestones, defaultOperationalSettings, publicOrderFor, expireIssueWindows, confirmIssueWindow, releaseMilestone } from '../src/operational-model.js';
import { authorizeFileRead, authorizeFileUpload, markFileDeletePending } from '../src/attachments.js';
import { selectActorRole, resolveAuthorizationContext } from '../src/authorization-context.js';

const DATABASE_URL = process.env.DATABASE_URL;
const AT = '2026-09-28T00:00:00.000Z';
const POINT = { lat: 7.06, lng: 125.6, label: 'Davao' };
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const roles = { client: 'client', other: 'client', supplier: 'supplier', rider: 'rider', ops: 'ops_admin', ops2: 'ops_admin', super: 'super_admin' };
const actor = (store, key) => {
  const user = store.users.find((row) => row.id === key);
  return selectActorRole(store, { ...user, context: resolveAuthorizationContext(store, user) }, user.role);
};
function readyFile(fileId, purpose = 'refund_qr', ownerId = 'client') {
  return { fileId, ownerId, purpose, state: 'ready', originalFilename: `${fileId}.png`, declaredContentType: 'image/png',
    detectedContentType: 'image/png', size: 100, objectKey: `private/${fileId}`, createdAt: AT, readyAt: AT, references: [] };
}
function orderFixture({ state = 'payment_authorized', paidPercent = 100, releases = 0, version = 2, delivery = 5000,
  principal = 100000, fee = 10000, deadline = '2099-01-01T00:00:00.000Z' } = {}) {
  const total = principal + fee + delivery;
  const initialFee = Math.round(fee * paidPercent / 100);
  const initialDelivery = Math.round(delivery * paidPercent / 100);
  const initial = Math.round(total * paidPercent / 100);
  const initialPrincipal = initial - initialFee - initialDelivery;
  const order = { id: 'order', clientId: 'client', supplierId: 'supplier', riderId: 'rider', state,
    supplierSubtotalMinor: principal, subtotalMinor: principal, serviceFeeRateBps: 1000, serviceFeeMinor: fee,
    deliveryFeeMinor: delivery, riderCommissionBps: 8500, totalMinor: total, onlineDueMinor: total, directStoreDueMinor: 0,
    supplierPlatformPayoutMinor: principal, moneyModelVersion: 3, commercialCommittedAt: AT, quoteVersion: 1,
    fulfillmentMode: delivery ? 'delivery' : 'pickup', paymentPlan: 'order_match_qr_75_25',
    pickup: POINT, dropoff: delivery ? POINT : null, payoutPlanVersion: version,
    payments: { initial: { amountMinor: initial, method: 'qr_manual', status: 'confirmed' },
      final_online: { amountMinor: total - initial, method: 'qr_manual', status: paidPercent === 100 ? 'not_required' : 'not_submitted' } },
    paymentAllocations: [
      { paymentCode: 'initial', component: 'supplier_principal', amountMinor: initialPrincipal },
      { paymentCode: 'initial', component: 'service_fee', amountMinor: initialFee },
      { paymentCode: 'initial', component: 'delivery_pass_through', amountMinor: initialDelivery },
      { paymentCode: 'final_online', component: 'supplier_principal', amountMinor: principal - initialPrincipal },
      { paymentCode: 'final_online', component: 'service_fee', amountMinor: fee - initialFee },
      { paymentCode: 'final_online', component: 'delivery_pass_through', amountMinor: delivery - initialDelivery },
    ].filter((row) => row.amountMinor > 0), revenueAdjustments: [], timeline: [{ at: AT, state, by: 'ops' }],
    createdAt: AT, updatedAt: AT };
  if (paidPercent === 100) order.downpaymentPercent = 100; // Missing 75% snapshot is a historical order.
  order.payoutMilestones = createPayoutMilestones(order, { version });
  for (let n = 0; n < releases; n++) Object.assign(order.payoutMilestones[n], { status: 'released', releasedAt: AT, releasedBy: 'ops' });
  if (['issue_window_open', 'completed', 'payout_released'].includes(state)) {
    order.issueWindowOpenedAt = AT; order.issueWindowExpiresAt = deadline;
  }
  return order;
}
async function fixture(db, options = {}) {
  await db.query('TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  const store = emptyStore(); store.settings = defaultOperationalSettings();
  store.users = Object.entries(roles).map(([key, role]) => ({ id: key, role, clerkUserId: `clerk_${key}`,
    email: `${key}@refund.test`, name: key, createdAt: AT, ...(role === 'client' ? { accountType: 'individual' } : {}),
    ...(['supplier', 'rider'].includes(role) ? { verificationStatus: 'approved' } : {}) }));
  store.userRoleMemberships = Object.entries(roles).map(([userId, role]) => ({ userId, role, createdAt: AT }));
  store.clientProfiles = ['client', 'other'].map((userId) => ({ userId, clientKind: 'personal', updatedAt: AT }));
  store.supplierProfiles = [{ userId: 'supplier', shopName: 'Shop', contactName: 'Printer', shop: POINT, pickupAvailable: true, updatedAt: AT }];
  store.riderProfiles = [{ userId: 'rider', vehicleType: 'motorcycle', plateNumber: 'TEST', updatedAt: AT }];
  store.approvalCases = ['supplier', 'rider'].map((kind) => ({ id: `case_${kind}`, userId: kind, kind, status: 'approved',
    version: 1, applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT }));
  store.orders = [orderFixture(options)];
  store.files = [readyFile('qr'), readyFile('qr2'), readyFile('other_qr', 'refund_qr', 'other'),
    readyFile('evidence', 'refund_evidence'), readyFile('receipt', 'refund_receipt', 'ops'),
    readyFile('receipt2', 'refund_receipt', 'ops'), readyFile('shop_receipt', 'payout_receipt', 'ops'),
    readyFile('shop_qr', 'supplier_payout_qr', 'supplier')];
  store.supplierPayoutAccounts = [{ supplierId: 'supplier', provider: 'gcash', accountName: 'Shop', qrFileId: 'shop_qr', version: 1, updatedAt: AT }];
  store.files.at(-1).references.push({ type: 'supplier_payout_account', id: 'supplier', field: 'qr' });
  await db.transaction(() => saveStore(db, store));
}
function audit(store, entry) {
  store.auditLog.push({ id: id('audit'), at: AT, actorId: entry.actor.id, actorRole: entry.actor.role,
    action: entry.action, entityType: entry.entityType, entityId: entry.entityId, orderId: entry.orderId, detail: entry.detail });
}
async function call(db, key, method, path, body = {}, options = {}) {
  return db.transaction(async () => {
    const store = await loadStore(db);
    const result = await routeRefunds({ req: { method, headers: { 'idempotency-key': options.key || id('key') } },
      url: new URL(path, 'http://refund.test'), store, user: key ? actor(store, key) : null,
      readBody: async () => body, now: () => options.at || AT, id, audit });
    if (result.mutated) await saveStore(db, store);
    return result;
  });
}
const qr = { qrFileId: 'qr', provider: 'gcash', accountName: 'Client Wallet', ownershipConfirmed: true };
async function request(db, options = {}) {
  return (await call(db, options.actor || 'client', 'POST', '/orders/order/refund-requests', {
    kind: options.kind || 'cancellation', reason: 'Please cancel my order.', evidenceFileIds: ['evidence'], destination: qr,
    ...options.body,
  }, options)).body.refund;
}
async function review(db, refund, key = 'ops', options = {}) {
  return (await call(db, key, 'POST', `/refund-requests/${refund.id}/review`, { expectedVersion: refund.version,
    destinationVerified: true, substantiated: true, reason: 'Evidence reviewed; client destination verified.' }, options)).body.refund;
}
async function settle(db, refund, { shop = 0, rider = 0, total = 115000, principal, actor: key = 'ops', ...options } = {}) {
  return (await call(db, key, 'POST', `/refund-requests/${refund.id}/settle`, { expectedVersion: refund.version,
    shopEntitlementMinor: shop, riderEntitlementMinor: rider, ...(principal == null ? {} : { principalMinor: principal }), totalMinor: total,
    workStopped: true, shopAgreement: 'Shop agreed the recorded final entitlement.', deliveryEvidence: 'Trip and earnings reconciled.',
    reason: 'Agreed available-funds refund.' }, options)).body.refund;
}
async function reserve(db, refund, options = {}) {
  return (await call(db, options.actor || 'ops', 'POST', `/refund-requests/${refund.id}/payment-attempts`, {
    expectedVersion: refund.version, destinationRevision: refund.destination.revision, destinationVerified: true,
    provider: 'gcash', sourceWallet: 'ops-wallet-1', reason: 'Paying the client from the verified wallet.',
  }, options)).body.refund;
}
async function pay(db, refund, options = {}) {
  return (await call(db, options.actor || 'ops', 'POST', `/refund-requests/${refund.id}/payments`, {
    expectedVersion: refund.version, attemptId: refund.attempt.id, amountMinor: refund.settlement.totalMinor,
    receiptFileId: options.receipt || 'receipt', reference: options.reference || 'REF-123', paidAt: AT,
    reason: 'Wallet transfer completed.', ...options.body,
  }, options)).body.refund;
}
const errorCode = (code) => (error) => { assert.equal(error.code, code, error.message); return true; };

// Every row in report section 2, including both historical 75/25 calculations.
const examples = [
  ['before acceptance', { state: 'supplier_assigned' }, 0, 0, 115000, 100000, 10000, 5000],
  ['accepted before production', {}, 0, 0, 115000, 100000, 10000, 5000],
  ['40% released before delivery', { state: 'production', releases: 1 }, 40000, 0, 71000, 60000, 6000, 5000],
  ['delivered with 75% released', { state: 'issue_window_open', releases: 2 }, 75000, 4250, 27500, 25000, 2500, 0],
  ['75/25 unstarted', { paidPercent: 75 }, 0, 0, 86250, 75000, 7500, 3750],
  ['75/25 after 400 released', { paidPercent: 75, state: 'production', releases: 1 }, 40000, 0, 42250, 35000, 3500, 3750],
  ['aborted trip with 2000 earned', { state: 'picked_up', releases: 1 }, 40000, 2000, 69000, 60000, 6000, 3000],
  ['at office before client collection: trip completed, filing still open', { state: 'awaiting_collection', releases: 1 }, 40000, 4250, 66000, 60000, 6000, 0],
  ['zero-charge pickup', { state: 'production', releases: 1, delivery: 0 }, 40000, 0, 66000, 60000, 6000, 0],
  ['legacy plan 1 after 50% released', { state: 'production', releases: 1, version: 1, paidPercent: 75 }, 50000, 0, 31250, 25000, 2500, 3750],
];

test('available-funds settlements persist worked examples on real PostgreSQL', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  for (const [name, options, shop, rider, total, principal, fee, delivery] of examples) await t.test(name, async () => {
    await fixture(db, options);
    const original = (await loadStore(db)).orders[0];
    let refund = await request(db, { kind: options.state === 'issue_window_open' ? 'complaint' : 'cancellation' });
    refund = await review(db, refund);
    refund = await settle(db, refund, { shop, rider, total });
    assert.deepEqual([refund.settlement.principalMinor, refund.settlement.feeMinor, refund.settlement.deliveryMinor], [principal, fee, delivery]);
    let store = await loadStore(db);
    assert.equal(store.refundSettlements.length, 1);
    assert.equal(store.refundEvents.length, 3);
    assert.equal(store.orders[0].totalMinor, original.totalMinor);
    assert.deepEqual(store.orders[0].paymentAllocations, original.paymentAllocations);
    assert.deepEqual(store.orders[0].payoutMilestones.map((row) => row.amountMinor), original.payoutMilestones.map((row) => row.amountMinor));
    assert.ok(store.orders[0].payoutMilestones.every((row) => ['released', 'superseded'].includes(row.status)));
    refund = await reserve(db, refund);
    refund = await pay(db, refund);
    assert.equal(refund.status, 'paid');
    store = await loadStore(db);
    assert.equal(store.refundPayments[0].amountMinor, total);
    assert.equal(store.orders[0].state, options.state === 'issue_window_open' ? 'completed' : 'cancelled');
    assert.equal(store.credits.client, undefined);
    assert.ok(store.notifications.some((row) => row.userId === 'super' && row.type === 'refund_paid'));
    assert.ok(store.notifications.some((row) => row.userId === 'supplier' && row.type === 'refund_settled'));
    const clientOrder = publicOrderFor(store.orders[0], actor(store, 'client'), store);
    assert.equal(clientOrder.supplierSettlementPayouts, undefined);
    assert.equal(clientOrder.refundFinance, undefined);
  });
});

test('closed-window all-paid row, no replacement, limits, holds, QR privacy and reconciliation', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await t.test('all stages paid: late cases are Super Admin only; no principal can be recovered', async () => {
    await fixture(db, { state: 'completed', releases: 3 });
    await assert.rejects(request(db), errorCode('refund_window_closed'));
    let refund = await request(db, { actor: 'super', body: { destination: undefined, evidenceFileIds: [] } });
    refund = (await call(db, 'client', 'PATCH', `/refund-requests/${refund.id}/destination`, { ...qr, expectedVersion: refund.version })).body.refund;
    refund = await review(db, refund, 'super');
    await assert.rejects(settle(db, refund, { actor: 'super', shop: 75000, rider: 4250, total: 27500 }), errorCode('refund_requires_super_admin'));
    await assert.rejects(settle(db, refund, { actor: 'super', shop: 100000, rider: 4250, total: 1, principal: 1 }), errorCode('refund_exceeds_available_funds'));
    await assert.rejects(settle(db, refund, { actor: 'super', shop: 100000, rider: 4250, total: 0 }), errorCode('refund_no_available_funds'));
  });
  await t.test('no replacement is refundable and intake stops every production start', async () => {
    await fixture(db, { state: 'approved_for_matching' });
    let refund = await request(db);
    const store = await loadStore(db);
    assert.throws(() => assertRefundWorkAllowed(store, store.orders[0]), errorCode('refund_fulfillment_stopped'));
    refund = await settle(db, await review(db, refund));
    assert.equal(refund.settlement.totalMinor, 115000);
  });
  await t.test('timely filing survives deadline and holds independently of released claims', async () => {
    await fixture(db, { state: 'issue_window_open', releases: 2, deadline: '2026-09-28T01:00:00.000Z' });
    let refund = await request(db, { kind: 'complaint' });
    let store = await loadStore(db);
    store.claims = [{ id: 'claim', orderId: 'order', status: 'released' }];
    assert.equal(expireIssueWindows(store, '2026-09-28T02:00:00.000Z'), false);
    assert.throws(() => confirmIssueWindow(store, store.orders[0], actor(store, 'client'), AT), errorCode('issue_open'));
    assert.throws(() => releaseMilestone(store.orders[0], 'issue_window', actor(store, 'ops'), AT, store), errorCode('payout_held'));
    refund = await review(db, refund, 'ops', { at: '2026-09-28T02:00:00.000Z' });
    refund = await settle(db, refund, { shop: 75000, rider: 4250, total: 27500, at: '2026-09-28T02:01:00.000Z' });
    assert.equal(refund.status, 'approved');
  });
  await t.test('paid rider earnings and maximum available funds cannot be overridden by Super Admin', async () => {
    await fixture(db, { state: 'production', releases: 1 });
    const refund = await review(db, await request(db));
    await assert.rejects(settle(db, refund, { shop: 40000, principal: 60001, total: 71001 }), errorCode('refund_exceeds_available_funds'));
    await assert.rejects(settle(db, refund, { shop: 39999, total: 71000 }), errorCode('refund_requires_super_admin'));
    assert.equal((await loadStore(db)).refundSettlements.length, 0);
    await fixture(db, { state: 'issue_window_open', releases: 2 });
    const delivered = await review(db, await request(db, { kind: 'complaint' }));
    await assert.rejects(settle(db, delivered, { shop: 75000, rider: 4249, total: 27500 }), errorCode('refund_requires_super_admin'));
  });
  await t.test('one payer, stale QR review, unknown external transfer and idempotent record', async () => {
    await fixture(db);
    let refund = await settle(db, await review(db, await request(db)));
    refund = (await call(db, 'client', 'PATCH', `/refund-requests/${refund.id}/destination`, { ...qr, qrFileId: 'qr2', expectedVersion: refund.version })).body.refund;
    assert.equal(refund.status, 'destination_review');
    await assert.rejects(reserve(db, refund), errorCode('refund_payment_reserved'));
    refund = await review(db, refund);
    const attempts = await Promise.allSettled([reserve(db, refund), reserve(db, refund, { actor: 'ops2' })]);
    assert.equal(attempts.filter((row) => row.status === 'fulfilled').length, 1);
    refund = attempts.find((row) => row.status === 'fulfilled').value;
    const payer = refund.attempt.payerId;
    await assert.rejects(call(db, 'client', 'PATCH', `/refund-requests/${refund.id}/destination`, { ...qr, expectedVersion: refund.version }), errorCode('refund_destination_locked'));
    refund = (await call(db, payer, 'POST', `/refund-requests/${refund.id}/reconcile`, { expectedVersion: refund.version, outcome: 'unknown', reason: 'Wallet timed out.' })).body.refund;
    await assert.rejects(reserve(db, refund), errorCode('refund_payment_reserved'));
    const args = { expectedVersion: refund.version, attemptId: refund.attempt.id, amountMinor: refund.settlement.totalMinor,
      receiptFileId: 'receipt', reference: 'RECONCILED-1', paidAt: AT, reason: 'Located the original wallet transfer.' };
    if (payer !== 'ops') await db.transaction(async () => { const s = await loadStore(db); s.files.find((f) => f.fileId === 'receipt').ownerId = payer; await saveStore(db, s); });
    const paid = await call(db, payer, 'POST', `/refund-requests/${refund.id}/payments`, args, { key: 'same-pay' });
    const replay = await call(db, payer, 'POST', `/refund-requests/${refund.id}/payments`, args, { key: 'same-pay' });
    assert.deepEqual(replay.body, paid.body);
    assert.equal((await loadStore(db)).refundPayments.length, 1);
  });
  await t.test('private purpose ACLs, ownership, retention pins and role-safe projections', async () => {
    await fixture(db);
    await assert.rejects(request(db, { body: { destination: { ...qr, qrFileId: 'other_qr' } } }), errorCode('invalid_refund_file'));
    let refund = await request(db);
    for (const key of ['other', 'supplier', 'rider']) {
      await assert.rejects(call(db, key, 'GET', `/refund-requests/${refund.id}`), errorCode('forbidden'));
    }
    await assert.rejects(call(db, null, 'GET', `/refund-requests/${refund.id}`), errorCode('unauthorized'));
    for (const key of ['client', 'other', 'supplier', 'rider']) {
      await assert.rejects(review(db, refund, key), errorCode('forbidden'));
    }
    const store = await loadStore(db);
    for (const key of ['client', 'ops', 'super']) assert.doesNotThrow(() => authorizeFileRead(actor(store, key), store, store.files.find((f) => f.fileId === 'qr')));
    for (const key of ['other', 'supplier', 'rider']) assert.throws(() => authorizeFileRead(actor(store, key), store, store.files.find((f) => f.fileId === 'qr')), errorCode('forbidden'));
    assert.throws(() => markFileDeletePending(store.files.find((f) => f.fileId === 'qr'), actor(store, 'client'), AT), errorCode('forbidden'));
    assert.throws(() => authorizeFileUpload(actor(store, 'supplier'), 'refund_qr'), errorCode('forbidden'));
    assert.throws(() => authorizeFileUpload(actor(store, 'client'), 'refund_receipt'), errorCode('forbidden'));
    refund = await pay(db, await reserve(db, await settle(db, await review(db, refund))));
    const paidStore = await loadStore(db);
    for (const key of ['client', 'ops', 'super']) assert.doesNotThrow(() => authorizeFileRead(actor(paidStore, key), paidStore, paidStore.files.find((f) => f.fileId === 'receipt')));
    for (const key of ['other', 'supplier', 'rider']) assert.throws(() => authorizeFileRead(actor(paidStore, key), paidStore, paidStore.files.find((f) => f.fileId === 'receipt')), errorCode('forbidden'));
    const clientRead = (await call(db, 'client', 'GET', `/refund-requests/${refund.id}`)).body.refund;
    assert.equal(clientRead.settlement.shopEntitlementMinor, undefined);
    assert.equal(clientRead.settlement.snapshot, undefined);
    assert.equal(clientRead.payment.sourceWallet, undefined);
    assert.doesNotMatch(JSON.stringify(clientRead), /private\/|objectKey|releasedMinor/);
  });
});

test('agreed shop remainder is one exact payout, with immutable stages and PostgreSQL net caps', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { state: 'production', releases: 1 });
  let refund = await settle(db, await review(db, await request(db)), { shop: 60000, total: 49000 });
  let store = await loadStore(db);
  assert.deepEqual(store.orders[0].payoutMilestones.map((row) => [row.amountMinor, row.status]), [[40000, 'released'], [35000, 'superseded'], [25000, 'superseded']]);
  assert.equal(store.refundSupplierPayouts[0].amountMinor, 20000);
  const supplier = publicOrderFor(store.orders[0], actor(store, 'supplier'), store);
  assert.equal(supplier.supplierSettlementPayouts[0].label, 'Agreed refund settlement payout');
  assert.equal(supplier.supplierSettlement.supplierOutstandingMinor, 20000);
  const body = { expectedVersion: refund.version, amountMinor: 20000, payoutAccountVersion: 1, destinationVerified: true,
    reference: 'SHOP-200', receiptFileId: 'shop_receipt', reason: 'Recorded agreed shop settlement transfer.' };
  await assert.rejects(call(db, 'ops', 'POST', `/refund-requests/${refund.id}/supplier-payout`, { ...body, amountMinor: 20001 }), errorCode('refund_supplier_payout_amount_mismatch'));
  await db.transaction(async () => { const s = await loadStore(db); s.claims.push({ id: 'hold', orderId: 'order', status: 'payout_held', createdAt: AT, updatedAt: AT }); await saveStore(db, s); });
  await assert.rejects(call(db, 'ops', 'POST', `/refund-requests/${refund.id}/supplier-payout`, body), errorCode('payout_held'));
  await db.transaction(async () => { const s = await loadStore(db); s.claims[0].status = 'released'; await saveStore(db, s); });
  refund = (await call(db, 'ops', 'POST', `/refund-requests/${refund.id}/supplier-payout`, body)).body.refund;
  store = await loadStore(db);
  assert.equal(store.refundSupplierPayouts[0].status, 'released');
  assert.equal(publicOrderFor(store.orders[0], actor(store, 'supplier'), store).supplierSettlement.supplierOutstandingMinor, 0);
  assert.equal(store.orders[0].payoutMilestones[1].status, 'superseded');
  await assert.rejects(db.transaction(() => db.query("UPDATE payout_milestones SET status='released' WHERE order_id='order' AND code='delivered'")), (e) => e.constraint === 'refund_milestone_closed');
  await assert.rejects(db.transaction(() => db.query("UPDATE order_payments SET status='not_submitted' WHERE order_id='order' AND code='initial'")), (e) => e.constraint === 'refund_available_funds_check');
  await assert.rejects(db.query('UPDATE refund_settlements SET principal_minor=principal_minor+1'), /immutable/);
  await assert.rejects(db.query('UPDATE refund_supplier_payouts SET amount_minor=20001'), /immutable/);
  refund = await pay(db, await reserve(db, refund));
  assert.equal(refund.status, 'paid');
});

test('rounding remainder, old upfront-fee allocation and Pilot Credits boundary', () => {
  const order = orderFixture({ principal: 3, fee: 1, delivery: 0, state: 'production' });
  const first = calculateRefundSettlement(order, { beforeProduction: false, shopEntitlementMinor: 0, riderEntitlementMinor: 0, principalMinor: 1 });
  const second = calculateRefundSettlement(order, { beforeProduction: false, shopEntitlementMinor: 0, riderEntitlementMinor: 0, principalMinor: 1, earlier: first });
  const last = calculateRefundSettlement(order, { beforeProduction: false, shopEntitlementMinor: 0, riderEntitlementMinor: 0, principalMinor: 1,
    earlier: { principalMinor: 2, feeMinor: first.feeMinor + second.feeMinor, deliveryMinor: 0 } });
  assert.equal(first.feeMinor + second.feeMinor + last.feeMinor, 1);
  const old = orderFixture({ state: 'production', paidPercent: 75 });
  old.payments.initial.amountMinor = 35000;
  old.paymentAllocations = [{ paymentCode: 'initial', component: 'supplier_principal', amountMinor: 25000 }, { paymentCode: 'initial', component: 'service_fee', amountMinor: 10000 }];
  assert.equal(calculateRefundSettlement(old, { beforeProduction: false, shopEntitlementMinor: 0, riderEntitlementMinor: 0 }).feeMinor, 2500);
  old.payments.initial.method = 'pilot_credits';
  assert.throws(() => collectedRefundComponents(old), errorCode('refund_collection_reconciliation_required'));
});

const ISSUER = 'https://refund-tests.clerk.accounts.dev';
const PARTY = 'http://localhost:19006';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function token(key, extra = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'refund-test' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, sub: `clerk_${key}`, sid: `session_${key}`, azp: PARTY,
    iat: seconds - 5, nbf: seconds - 5, exp: seconds + 300, ...extra })).toString('base64url');
  const input = `${head}.${payload}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function apiForTest(t) {
  const storage = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': '100', 'Content-Type': 'image/png', ETag: 'test' }); res.end(); }
    else if (req.method === 'DELETE') { res.writeHead(204); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => storage.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => storage.close(resolve)));
  const storageUrl = `http://127.0.0.1:${storage.address().port}`;
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATABASE_URL,
    CLERK_SECRET_KEY: 'test-only', CLERK_ISSUER: ISSUER, CLERK_AUTHORIZED_PARTIES: PARTY,
    CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    HOST: '127.0.0.1', PORT: String(port), MINIO_ENDPOINT: storageUrl, MINIO_PUBLIC_URL: storageUrl,
    MINIO_ACCESS_KEY: 'refund-test', MINIO_SECRET_KEY: 'refund-test-secret', MINIO_BUCKET: 'refund-test',
    GRIDGO_LIFECYCLE_INTERVAL_MS: '3600000', GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } });
  const origin = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${origin}/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(healthy, output);
  return async (key, method, path, body, opts = {}) => {
    const res = await fetch(`${origin}${path}`, { method,
      headers: { ...(key ? { Authorization: `Bearer ${token(key, opts.claims)}` } : {}),
        'Content-Type': 'application/json', 'Idempotency-Key': opts.key || id('httpkey'), ...opts.headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
}

test('live HTTP refund authorization, signed QR privacy, production race and durable inbox', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db);
  const api = await apiForTest(t);
  const body = { kind: 'cancellation', reason: 'Please cancel', evidenceFileIds: [], destination: qr };
  assert.equal((await api(null, 'POST', '/orders/order/refund-requests', body)).status, 401);
  for (const key of ['other', 'supplier', 'rider']) assert.equal((await api(key, 'POST', '/orders/order/refund-requests', body)).status, 403);
  // A client's spoofed JWT role cannot grant Operations membership.
  assert.equal((await api('client', 'POST', '/refund-requests/missing/review', {}, { claims: { role: 'super_admin' } })).status, 404);
  const created = await api('client', 'POST', '/orders/order/refund-requests', body, { key: 'http-create' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let refund = created.body.refund;
  const replay = await api('client', 'POST', '/orders/order/refund-requests', body, { key: 'http-create' });
  assert.equal(replay.body.refund.id, refund.id);
  assert.equal((await api('supplier', 'POST', '/orders/order/transition', { state: 'production' })).body.error, 'refund_fulfillment_stopped');
  for (const key of ['other', 'supplier', 'rider']) {
    assert.equal((await api(key, 'GET', `/refund-requests/${refund.id}`)).status, 403);
    assert.equal((await api(key, 'GET', '/files/qr')).status, 403);
    assert.equal((await api(key, 'GET', '/files/qr/download-url')).status, 403);
  }
  for (const key of ['client', 'ops', 'super']) {
    const metadata = await api(key, 'GET', '/files/qr');
    assert.equal(metadata.status, 200); assert.match(metadata.headers.get('cache-control'), /no-store/);
    assert.equal(metadata.body.file.objectKey, undefined);
    const signed = await api(key, 'GET', '/files/qr/download-url');
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.match(signed.headers.get('cache-control'), /no-store/);
    const target = new URL(signed.body.url);
    assert.equal(target.searchParams.get('response-cache-control'), 'private, no-store, max-age=0');
    assert.equal(target.searchParams.get('X-Amz-Expires'), String(signed.body.expiresInSeconds));
  }
  for (const action of ['review', 'settle', 'reject', 'payment-attempts', 'reconcile', 'payments', 'supplier-payout']) {
    for (const key of ['client', 'supplier', 'rider', 'other']) {
      const result = await api(key, 'POST', `/refund-requests/${refund.id}/${action}`, { expectedVersion: refund.version, reason: 'test' });
      assert.equal(result.status, 403, `${key} ${action}: ${JSON.stringify(result.body)}`);
    }
  }
  let response = await api('ops', 'POST', `/refund-requests/${refund.id}/review`, { expectedVersion: refund.version, reason: 'Reviewed', destinationVerified: true });
  assert.equal(response.status, 200, JSON.stringify(response.body)); refund = response.body.refund;
  response = await api('ops', 'POST', `/refund-requests/${refund.id}/settle`, { expectedVersion: refund.version, reason: 'No work incurred',
    shopAgreement: 'Shop confirms no work', deliveryEvidence: 'Trip never started', workStopped: true,
    shopEntitlementMinor: 0, riderEntitlementMinor: 0, totalMinor: 115000 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  for (const key of ['ops', 'super', 'supplier', 'client']) {
    const inbox = await api(key, 'GET', '/notifications');
    assert.equal(inbox.status, 200);
    assert.ok(inbox.body.notifications.some((row) => row.type === 'refund_settled'), `${key} received refund settlement notice`);
  }
  // Put a fresh order back, then start production concurrently with request intake.
  await fixture(db);
  const raced = await Promise.all([api('client', 'POST', '/orders/order/refund-requests', body),
    api('supplier', 'POST', '/orders/order/transition', { state: 'production' })]);
  assert.equal(raced[0].status, 201, JSON.stringify(raced));
  const saved = await loadStore(db);
  if (raced[1].status === 200) assert.equal(saved.refundRequests[0].beforeProduction, false);
  else { assert.equal(raced[1].status, 409); assert.equal(saved.refundRequests[0].beforeProduction, true); }
});

test('repeated partial refunds use earlier ledgers and leave the exact final fee centavo', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { state: 'production', principal: 3, fee: 1, delivery: 0 });
  await db.transaction(async () => { const s = await loadStore(db); s.files.push(readyFile('qr3'), readyFile('receipt3', 'refund_receipt', 'ops')); await saveStore(db, s); });
  const totals = [1, 2, 1];
  for (let index = 0; index < 3; index++) {
    let refund = await request(db, { body: { evidenceFileIds: [], destination: { ...qr, qrFileId: ['qr', 'qr2', 'qr3'][index] } } });
    refund = await settle(db, await review(db, refund), { total: totals[index], principal: 1 });
    refund = await reserve(db, refund);
    refund = await pay(db, refund, { receipt: ['receipt', 'receipt2', 'receipt3'][index], reference: `PARTIAL-${index}` });
    assert.equal(refund.status, 'paid');
  }
  const store = await loadStore(db);
  assert.equal(store.refundSettlements.reduce((sum, row) => sum + row.principalMinor, 0), 3);
  assert.equal(store.refundSettlements.reduce((sum, row) => sum + row.feeMinor, 0), 1);
  assert.equal(store.refundPayments.reduce((sum, row) => sum + row.amountMinor, 0), 4);
  assert.deepEqual(store.refundSettlements.map((row) => row.sequence).sort(), [1, 2, 3]);
});

test('deadline boundary, repeat-transfer detection, evidence reuse, rejection and failed attempt retry', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { state: 'issue_window_open', releases: 2, deadline: AT });
  await assert.rejects(request(db), errorCode('refund_window_closed'));
  await fixture(db, { state: 'production', releases: 1 });
  let refund = await request(db);
  const duplicate = await Promise.allSettled([request(db), request(db)]);
  assert.ok(duplicate.every((row) => row.status === 'rejected' && row.reason.code === 'refund_already_open'));
  refund = await review(db, refund);
  await assert.rejects(settle(db, refund, { shop: 40000, total: 71001 }), errorCode('refund_exceeds_available_funds'));
  refund = await settle(db, refund, { shop: 40000, total: 27000, principal: 20000 }); // 200 + 20 + 50
  refund = await reserve(db, refund);
  await assert.rejects(call(db, 'ops2', 'POST', `/refund-requests/${refund.id}/reconcile`, {
    expectedVersion: refund.version, outcome: 'failed', noTransferConfirmed: true, reason: 'Not mine',
  }), errorCode('refund_payer_required'));
  refund = (await call(db, 'ops', 'POST', `/refund-requests/${refund.id}/reconcile`, {
    expectedVersion: refund.version, outcome: 'failed', noTransferConfirmed: true, reason: 'Wallet confirms no debit.',
  })).body.refund;
  refund = await pay(db, await reserve(db, refund));
  let second = await request(db, { body: { evidenceFileIds: [], destination: { ...qr, qrFileId: 'qr2' } } });
  second = await settle(db, await review(db, second), { shop: 40000, total: 44000 });
  second = await reserve(db, second);
  await assert.rejects(pay(db, second, { receipt: 'receipt2' }), errorCode('refund_duplicate_transfer'));
  await assert.rejects(pay(db, second, { reference: 'NEW-REF' }), errorCode('file_already_attached'));
  second = await pay(db, second, { reference: 'NEW-REF', receipt: 'receipt2' });
  assert.equal(second.status, 'paid');
  assert.equal((await loadStore(db)).refundPayments.length, 2);
  await fixture(db);
  let rejected = await request(db);
  rejected = (await call(db, 'ops', 'POST', `/refund-requests/${rejected.id}/reject`, {
    expectedVersion: rejected.version, reason: 'The client chose to retain the order.',
  })).body.refund;
  assert.equal(rejected.status, 'rejected');
  const client = (await call(db, 'client', 'GET', `/refund-requests/${rejected.id}`)).body.refund;
  assert.equal(client.history.at(-1).reason, 'The client chose to retain the order.');
  const store = await loadStore(db);
  assert.doesNotThrow(() => assertRefundWorkAllowed(store, store.orders[0]));
});

test('preview is read-only; concurrent supplier release cannot spend reserved refund funds', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { state: 'production' });
  await db.transaction(async () => { const s = await loadStore(db); s.orders[0].payoutMilestones[0].pofFileIds = ['pof'];
    s.files.push(readyFile('pof', 'fulfilment_proof', 'supplier')); await saveStore(db, s); });
  const raced = await Promise.allSettled([
    request(db),
    db.transaction(async () => { const s = await loadStore(db); releaseMilestone(s.orders[0], 'production_started', actor(s, 'ops'), AT, s); await saveStore(db, s); }),
  ]);
  assert.equal(raced[0].status, 'fulfilled');
  if (raced[1].status === 'rejected') assert.equal(raced[1].reason.code, 'payout_held');
  const state = await loadStore(db);
  const released = state.orders[0].payoutMilestones[0].status === 'released' ? 40000 : 0;
  let refund = raced[0].value;
  const preview = await call(db, 'ops', 'POST', `/refund-requests/${refund.id}/settlement-preview`, {
    expectedVersion: refund.version, shopEntitlementMinor: released, riderEntitlementMinor: 0,
  });
  assert.equal(preview.body.amounts.principalMinor, 100000 - released);
  assert.equal(preview.body.availableTotalMinor, released ? 71000 : 115000);
  assert.equal((await loadStore(db)).refundEvents.length, 1);
  assert.equal((await loadStore(db)).refundSettlements.length, 0);
  refund = await review(db, refund);
  refund = await settle(db, refund, { shop: released, total: preview.body.amounts.totalMinor });
  assert.equal(refund.settlement.snapshot.releasedMinor, released);
});

test('live API reconciles a pending final payment during a hold without resuming work', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { paidPercent: 75, state: 'production', releases: 1 });
  await db.transaction(async () => { const s = await loadStore(db); s.orders[0].payments.final_online.status = 'pending_confirmation'; await saveStore(db, s); });
  const api = await apiForTest(t);
  let refund = await review(db, await request(db));
  await assert.rejects(settle(db, refund, { shop: 40000, total: 42250 }), errorCode('refund_collection_reconciliation_required'));
  const response = await api('ops', 'POST', '/orders/order/payments/final_online/confirm', {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await api('supplier', 'POST', '/orders/order/transition', { state: 'ready_for_dispatch' })).body.error, 'refund_fulfillment_stopped');
  assert.equal((await api('client', 'POST', `/refund-requests/${refund.id}/review`, { expectedVersion: refund.version, reason: 'spoof' }, { claims: { role: 'super_admin' } })).status, 403);
  refund = await settle(db, refund, { shop: 40000, total: 71000 });
  assert.equal(refund.settlement.snapshot.collected.principalMinor, 100000);
  assert.equal((await api('ops', 'POST', '/orders/order/payments/final_online/confirm', {})).body.error, 'refund_fulfillment_stopped');
});

test('live HTTP retention report, early-delete roles, reason audit, and open-case protection', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { state: 'completed' });
  await db.transaction(async () => {
    const store = await loadStore(db);
    const file = readyFile('artwork', 'artwork');
    file.references = [{ type: 'order', id: 'order', field: 'artwork' }];
    store.files.push(file);
    await saveStore(db, store);
  });
  const api = await apiForTest(t);
  assert.equal((await api(null, 'GET', '/admin/files/retention')).status, 401);
  for (const key of ['client', 'other', 'ops', 'supplier', 'rider']) {
    assert.equal((await api(key, 'GET', '/admin/files/retention')).status, 403);
  }
  const before = (await loadStore(db)).files;
  const report = await api('super', 'GET', '/admin/files/retention');
  assert.equal(report.status, 200); assert.equal(report.body.dryRun, true);
  assert.equal(report.body.deletionEnabled, false);
  assert.ok(report.body.byPurpose.refund_qr >= 1);
  assert.deepEqual((await loadStore(db)).files, before);
  for (const key of ['ops', 'supplier', 'rider', 'other']) {
    assert.equal((await api(key, 'DELETE', '/files/artwork', { reason: 'Request removal' })).status, 403);
  }
  assert.equal((await api('super', 'DELETE', '/files/artwork')).body.error, 'reason_required');
  assert.equal((await api('super', 'DELETE', '/files/artwork', { reason: '  ' })).body.error, 'reason_required');
  assert.equal((await api('client', 'DELETE', '/files/receipt')).status, 403);
  await db.transaction(async () => {
    const store = await loadStore(db); store.orders[0].payoutHold = true; await saveStore(db, store);
  });
  for (const key of ['super', 'client']) assert.equal((await api(key, 'DELETE', '/files/artwork', { reason: 'Request removal' })).body.error, 'file_retention_hold');
  await db.transaction(async () => {
    const store = await loadStore(db); store.orders[0].payoutHold = false; await saveStore(db, store);
  });
  const deleted = await api('client', 'DELETE', '/files/artwork');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body)); assert.equal(deleted.body.file.state, 'deleted');
  assert.equal(deleted.body.file.objectKey, undefined);
  const receipt = await api('super', 'DELETE', '/files/receipt', { reason: '  Duplicate transfer evidence  ' });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body)); assert.equal(receipt.body.file.state, 'deleted');
  const store = await loadStore(db);
  assert.ok(store.auditLog.some((row) => row.entityId === 'artwork' && row.action === 'file.early_delete' && row.actorRole === 'client'));
  assert.ok(store.auditLog.some((row) => row.entityId === 'receipt' && row.actorId === 'super' && row.reason === 'Duplicate transfer evidence'));
});

test('retention intent and audit survive storage failure in PostgreSQL and retry idempotently', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { state: 'completed' });
  let unavailable = true;
  const objects = new Set((await loadStore(db)).files.map((file) => file.objectKey));
  const worker = createFileRetention({ database: db, load: () => loadStore(db), save: (store) => saveStore(db, store),
    storage: { deleteObject: async (key) => { if (unavailable) throw new Error('unavailable'); objects.delete(key); } },
    enabled: true, now: () => '2032-10-04T00:00:00Z', id });
  const failed = await worker.run({ dryRun: false });
  assert.ok(failed.failed > 0); assert.equal(failed.deleted, 0);
  let store = await loadStore(db);
  assert.ok(store.files.some((file) => file.state === 'delete_pending' && file.deletionSource === 'retention'));
  const auditCount = store.auditLog.filter((entry) => entry.action === 'file.retention_delete').length;
  assert.equal(auditCount, failed.failed);
  unavailable = false;
  const retried = await worker.run({ dryRun: false });
  assert.equal(retried.deleted, failed.failed); assert.equal(retried.failed, 0);
  store = await loadStore(db);
  assert.equal(store.auditLog.filter((entry) => entry.action === 'file.retention_delete').length, auditCount);
  assert.ok(store.files.filter((file) => file.deletionSource === 'retention').every((file) => file.state === 'deleted' && file.objectKey === null));
  assert.equal((await worker.run({ dryRun: false })).deleted, 0);
});

test('replacing the platform receiving QR leaves old bytes for gated retention cleanup', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.files.push(readyFile('platform_old', 'payment_qr', 'ops'), readyFile('platform_new', 'payment_qr', 'ops'));
    store.settings.paymentQrFileId = 'platform_old';
    await saveStore(db, store);
  });
  const api = await apiForTest(t);
  const replaced = await api('super', 'POST', '/settings/payment-qr', { fileId: 'platform_new', reason: 'Replace receiving image' });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const store = await loadStore(db);
  assert.equal(store.settings.paymentQrFileId, 'platform_new');
  assert.equal(store.files.find((file) => file.fileId === 'platform_old').state, 'ready');
  assert.equal(store.files.find((file) => file.fileId === 'platform_old').deleteRequestedAt, undefined);
});

test('shop recovery full-refund choice persists, rejects partial settlement and pays through reserved transfer', { skip: !DATABASE_URL }, async (t) => {
  const { recordShopFailure } = await import('../src/shop-recovery.js');
  const { routeShopRecovery } = await import('../src/shop-recovery-routes.js');
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await fixture(db, { state: 'supplier_self_qc' });
  await db.transaction(async () => {
    const store = await loadStore(db), order = store.orders[0];
    recordShopFailure(store, order, { kind: 'cancelled', reason: 'Cannot complete the run', at: AT, createId: id, actorId: 'supplier' });
    const result = await routeShopRecovery({ req: { method: 'POST', headers: { 'idempotency-key': id('key') } },
      url: new URL('http://test/orders/order/shop-recovery/refund'), store, user: actor(store, 'client'),
      readBody: async () => ({ recoveryId: order.shopRecovery.id, destination: qr }), now: () => AT, id, audit });
    assert.equal(result.status, 200);
    await saveStore(db, store);
  });
  let store = await loadStore(db);
  assert.equal(store.orders[0].shopFailureEvents[0].stage, 'supplier_self_qc');
  const requestId = store.orders[0].shopRecovery.refundRequestId;
  let refund = (await call(db, 'client', 'GET', `/refund-requests/${requestId}`)).body.refund;
  refund = await review(db, refund);
  await assert.rejects(settle(db, refund, { shop: 10000, total: 104000 }), errorCode('shop_recovery_full_refund_required'));
  await assert.rejects(settle(db, refund, { principal: 50000, total: 60000 }), errorCode('shop_recovery_full_refund_required'));
  refund = await settle(db, refund);
  assert.equal(refund.settlement.totalMinor, 115000);
  refund = await pay(db, await reserve(db, refund));
  assert.equal(refund.status, 'paid');
  store = await loadStore(db);
  assert.equal(store.orders[0].state, 'cancelled');
  assert.equal(store.refundPayments[0].amountMinor, 115000);
});
