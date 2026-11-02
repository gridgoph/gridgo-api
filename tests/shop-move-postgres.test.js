import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

// Substitute-shop price rule end to end: the database triggers must accept the
// adjusted stages, the price-difference credit and the fee-free top-up.
const DATABASE_URL = process.env.DATABASE_URL;
const file = (fileId, ownerId, purpose) => ({ fileId, ownerId, purpose, state: 'ready', objectKey: `private/${fileId}`,
  originalFilename: 'proof.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT });
async function setup(t, replacementUnitPriceMinor) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(), order = store.orders[0];
  order.readyBy = '2030-10-10T00:00:00.000Z';
  order.promiseBy = '2030-10-10T01:00:00.000Z';
  order.timeline = [{ at: new Date().toISOString(), state: order.state, by: 'supplier' }];
  store.catalogItems.find((item) => item.supplierId === 'replacement').basePriceMinor = replacementUnitPriceMinor;
  store.files.push(file('refundqr', 'client', 'refund_qr'), file('topup_proof', 'client', 'payment_proof'), file('refundreceipt', 'ops', 'refund_receipt'));
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t);
  const cancelled = await api('supplier', 'POST', '/orders/order/shop-cancel', { reason: 'Press broke down' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const recovery = (await api('client', 'GET', '/orders/order/shop-recovery')).body.recovery;
  return { db, api, recovery };
}
const stageNet = (order) => order.payoutMilestones.reduce((sum, stage) => sum + stage.amountMinor, 0);

test('cheaper substitute persists net stages and a non-stopping credit paid through the manual refund flow', { skip: !DATABASE_URL }, async t => {
  const { db, api, recovery } = await setup(t, 800);
  assert.deepEqual(recovery.replacement.pricing, { ruleApplies: true, rule: 'cheaper', originalPriceMinor: 10000, newPriceMinor: 8000,
    differenceMinor: -2000, gridgoCoverMinor: 0, clientPaysMinor: 0, refundMinor: 2000 });
  const accepted = await api('client', 'POST', '/orders/order/shop-recovery/accept', { recoveryId: recovery.id,
    destination: { qrFileId: 'refundqr', provider: 'gcash', accountName: 'Client', ownershipConfirmed: true } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  let stored = await loadStore(db);
  assert.equal(stored.orders[0].supplierId, 'replacement');
  assert.equal(stageNet(stored.orders[0]), 8000);
  assert.equal(stored.orders[0].payoutMilestones.reduce((sum, stage) => sum + stage.priceAdjustmentMinor, 0), -2000);
  const request = stored.refundRequests.find((row) => row.kind === 'shop_move');
  assert.equal(request.status, 'destination_review');
  assert.equal(stored.refundSettlements[0].disposition, 'price_adjustment');
  let refund = (await api('client', 'GET', `/refund-requests/${request.id}`)).body.refund;
  const step = async (actor, action, body) => {
    const result = await api(actor, 'POST', `/refund-requests/${request.id}/${action}`, { expectedVersion: refund.version, ...body });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    refund = result.body.refund;
  };
  await step('ops', 'review', { reason: 'Account verified', destinationVerified: true });
  await step('ops', 'payment-attempts', { reason: 'Sending difference', destinationRevision: 1, destinationVerified: true, provider: 'gcash', sourceWallet: 'ops-wallet' });
  await step('ops', 'payments', { reason: 'Sent', attemptId: refund.attempt.id, amountMinor: 2000, reference: 'DIFF-1', receiptFileId: 'refundreceipt', paidAt: new Date().toISOString() });
  assert.equal(refund.status, 'paid');
  stored = await loadStore(db);
  assert.equal(stored.orders[0].shopRecovery.status, 'accepted', 'paying the difference never touches the recovery');
  const client = (await api('client', 'GET', '/orders/order')).body.order;
  assert.equal(client.refundHold, false);
  assert.deepEqual([client.shopMoves[0].refundMinor, client.shopMoves[0].toSupplierId], [2000, undefined]);
  const ops = (await api('ops', 'GET', '/orders/order')).body.order;
  assert.equal(ops.supplierSettlement.totalSupplierEarningsMinor, 8000);
  assert.equal(ops.shopMoves[0].pricing.capBps, 5000);
  assert.ok(stored.auditLog.some((row) => row.action === 'order.shop_move_applied'));
  // The new shop accepts and works normally under the credit.
  const shopAccept = await api('replacement', 'POST', '/orders/order/transition', { state: 'payment_authorized' });
  assert.equal(shopAccept.status, 200, JSON.stringify(shopAccept.body));
  // A price adjustment can never hang off another kind of refund request.
  await assert.rejects(db.transaction(async () => {
    await db.query(`INSERT INTO refund_requests (id, order_id, client_id, policy_version, status, version, kind, reason, before_production, late,
      order_state_at_filing, evidence_file_ids, created_at, updated_at) VALUES ('forged', 'order', 'client', 'available_funds_v1', 'requested', 1,
      'complaint', 'x', false, false, 'production', '{}', now(), now())`);
    await db.query(`INSERT INTO refund_settlements (id, request_id, order_id, sequence, created_by, created_at, reason, shop_agreement, delivery_evidence,
      disposition, shop_entitlement_minor, rider_entitlement_minor, principal_minor, fee_minor, delivery_minor, platform_delivery_minor, total_minor, snapshot)
      VALUES ('forged_settle', 'forged', 'order', 99, 'ops', now(), 'x', 'x', 'x', 'price_adjustment', 0, 0, 1, 0, 0, 0, 1, '{}')`);
  }), /price adjustment requires its own shop-move request/);
});

test('dearer substitute above the cover: fee-free top-up passes the change-money trigger and releases the hold', { skip: !DATABASE_URL }, async t => {
  const { db, api, recovery } = await setup(t, 1100);
  assert.deepEqual([recovery.replacement.pricing.rule, recovery.replacement.pricing.gridgoCoverMinor, recovery.replacement.pricing.clientPaysMinor, recovery.canAccept],
    ['above_cap', 500, 500, false]);
  const refused = await api('client', 'POST', '/orders/order/shop-recovery/accept', { recoveryId: recovery.id });
  assert.equal(refused.body.error, 'shop_move_top_up_consent_required');
  const accepted = await api('client', 'POST', '/orders/order/shop-recovery/accept', { recoveryId: recovery.id, acceptTopUpMinor: 500 });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.recovery.status, 'awaiting_payment');
  let stored = await loadStore(db);
  assert.equal(stageNet(stored.orders[0]), 10500);
  const changeId = accepted.body.recovery.topUp.changeRequestId;
  const base = `/orders/order/change-requests/${changeId}`;
  const paid = await api('client', 'POST', `${base}/payment`, { expectedVersion: 1, proofFileId: 'topup_proof', reference: 'TOPUP-1' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const confirmed = await api('ops', 'POST', `${base}/payment/confirm`, { expectedVersion: 2, amountMinor: 500, reason: 'Transfer verified' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  stored = await loadStore(db);
  assert.equal(stored.orders[0].shopRecovery.status, 'accepted');
  assert.equal(stored.orderChangePayments[0].principalMinor, 500);
  assert.equal(stored.orderChangePayments[0].feeMinor, 0);
  const ops = (await api('ops', 'GET', '/orders/order')).body.order;
  assert.equal(ops.supplierSettlement.totalSupplierEarningsMinor, 11000);
  assert.deepEqual([ops.platformRevenue.shopMoveCoverMinor, ops.platformRevenue.netServiceFeeMinor], [500, 500]);
});

test('Super Admin edits the cover with the settings version handshake; Operations cannot', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  await db.transaction(() => saveStore(db, fixture()));
  const api = await apiForTest(t);
  const current = (await api('admin', 'GET', '/settings')).body;
  assert.equal(current.settings.shopMoveCoverBps, 5000);
  assert.equal((await api('client', 'GET', '/settings')).body.settings.shopMoveCoverBps, 5000);
  assert.equal((await api('ops', 'PATCH', '/settings', { expectedVersion: current.version, reason: 'Change', shopMoveCoverBps: 4000 })).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { expectedVersion: current.version - 1, reason: 'Change', shopMoveCoverBps: 4000 })).body.error, 'settings_version_conflict');
  assert.equal((await api('admin', 'PATCH', '/settings', { expectedVersion: current.version, reason: 'Change', shopMoveCoverBps: 10001 })).body.error, 'invalid_shop_move_cover');
  const saved = await api('admin', 'PATCH', '/settings', { expectedVersion: current.version, reason: 'Pilot cover', shopMoveCoverBps: 4000 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.shopMoveCoverBps, 4000);
});
