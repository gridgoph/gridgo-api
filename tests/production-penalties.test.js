import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProductionLapses, cappedPenaltyMinor, defaultProductionPenalty, latenessTier,
  recentLapseQualityPenalty, validateProductionPenalty, supplierLapses } from '../src/production-penalties.js';
import { createPayoutMilestones, releaseMilestone, moneyReportingForOrder, publicOrderFor } from '../src/operational-model.js';

const DEADLINE = '2026-10-01T00:00:00.000Z';
const atHours = (hours) => new Date(Date.parse(DEADLINE) + hours * 3600000).toISOString();
let sequence = 0;
const createId = (prefix) => `${prefix}_${++sequence}`;
function fixture(enabled = true, version = 2) {
  const order = { id: 'order', supplierId: 'shop', clientId: 'client', state: 'production', readyBy: DEADLINE,
    commercialCommittedAt: DEADLINE, supplierSubtotalMinor: 100000, supplierPlatformPayoutMinor: 100000,
    payoutPlanVersion: version, fulfillmentMode: 'delivery', paymentPlan: 'delivery_online',
    payments: { initial: { status: 'confirmed', amountMinor: 100000 } },
    paymentAllocations: [{ paymentCode: 'initial', component: 'supplier_principal', amountMinor: 100000 }],
    payoutMilestones: createPayoutMilestones({ supplierPlatformPayoutMinor: 100000 }, { version }) };
  order.payoutMilestones.forEach((stage) => { stage.pofFileIds = ['proof']; stage.status = 'pof_attached'; });
  order.payoutMilestones[0].status = 'released';
  return { version: 4, settings: { productionPenalty: { ...defaultProductionPenalty(), deductionsEnabled: enabled } },
    orders: [order], users: [], userRoleMemberships: [{ userId: 'ops', role: 'ops_admin' }, { userId: 'admin', role: 'super_admin' }],
    productionLapses: [], claims: [], notifications: [], auditLog: [] };
}
const assess = (store, hours) => assessProductionLapses(store, { at: atHours(hours), createId });

test('tier boundaries are exact and no communication escalates only a missed deadline', () => {
  for (const [hours, tier] of [[0, null], [0.001, 'minor'], [6, 'minor'], [6.001, 'moderate'], [24, 'moderate'], [24.001, 'severe']]) {
    assert.equal(latenessTier(DEADLINE, atHours(hours)), tier);
  }
  assert.equal(latenessTier(DEADLINE, atHours(1), true), 'severe');
  assert.equal(latenessTier(DEADLINE, DEADLINE, true), null);
  assert.equal(latenessTier(null, atHours(1)), null);
});

test('integer rounding, cap and safe integer boundaries', () => {
  assert.equal(cappedPenaltyMinor(101, 500), 5);
  assert.equal(cappedPenaltyMinor(10, 500), 1);
  assert.equal(cappedPenaltyMinor(1, 30000), 1);
  assert.equal(cappedPenaltyMinor(0, 10000), 0);
  assert.equal(cappedPenaltyMinor(Number.MAX_SAFE_INTEGER, 10000), Number.MAX_SAFE_INTEGER);
  assert.throws(() => cappedPenaltyMinor(1.5, 500));
});

for (const [tier, hours, bps] of [['minor', 2, 500], ['moderate', 12, 1500], ['severe', 25, 3000]]) {
  for (const version of [1, 2]) test(`${tier} plan ${version}: warning commits first, net stages preserve gross shares, payouts reconcile`, () => {
    const store = fixture(true, version), order = store.orders[0];
    order.readyAt = atHours(hours);
    order.state = 'completed';
    const before = structuredClone(order.payoutMilestones);
    const remaining = before.slice(1).reduce((sum, stage) => sum + stage.amountMinor, 0);
    assert.equal(assess(store, hours), true);
    assert.equal(store.productionLapses[0].deductionMinor, 0);
    assert.deepEqual(order.payoutMilestones, before);
    assert.equal(store.notifications.length, 3, 'shop, Operations and Super Admin receive warning');
    assert.equal(store.productionLapses[0].warnings[0].formal, tier !== 'minor');
    assert.equal(assess(store, hours), false, 'same timestamp cannot deduct');
    assert.equal(assess(store, hours + 0.01), true);
    const deducted = cappedPenaltyMinor(remaining, bps);
    assert.equal(store.productionLapses[0].deductionMinor, deducted);
    assert.equal(store.productionLapses[0].remainingBalanceMinor, remaining);
    assert.deepEqual(order.payoutMilestones[0], before[0], 'released stage is immutable');
    for (let i = 0; i < before.length; i++) assert.equal(order.payoutMilestones[i].amountMinor + (order.payoutMilestones[i].productionDeductionMinor || 0), before[i].amountMinor);
    for (const stage of order.payoutMilestones) releaseMilestone(order, stage.code, { id: 'ops', role: 'ops_admin' }, atHours(hours + 1), store);
    const report = moneyReportingForOrder(order, store).supplierSettlement;
    assert.equal(report.gridgoDeductionsMinor, deducted);
    assert.equal(report.supplierReleasedMinor, 100000 - deducted);
    assert.equal(report.totalSupplierEarningsMinor, 100000 - deducted);
    assert.equal(report.supplierOutstandingMinor, 0);
    assert.equal(report.protectedPaymentMinor, 0);
    assert.equal(publicOrderFor(order, { id: "shop", role: "supplier" }, store).supplierEarningsMinor, 100000 - deducted);
    assert.equal(assess(store, hours + 50), false, 'no duplicate deduction');
    assert.equal(Boolean(order.productionReassignmentEligible), tier === 'severe');
  });
}

test('warning-only lapses stay warning-only after enabling; disabling stops pending deductions', () => {
  const store = fixture(false), order = store.orders[0];
  order.readyAt = atHours(2); order.state = 'completed';
  assess(store, 2);
  assert.match(store.productionLapses[0].warnings[0].message, /Deductions are off/);
  store.settings.productionPenalty.deductionsEnabled = true;
  assert.equal(assess(store, 3), false);
  for (const stage of order.payoutMilestones) releaseMilestone(order, stage.code, { role: 'ops_admin' }, atHours(3), store);
  assert.equal(moneyReportingForOrder(order, store).supplierSettlement.supplierReleasedMinor, 100000);
  const pending = fixture(true);
  assess(pending, 25);
  pending.settings.productionPenalty.deductionsEnabled = false;
  assert.equal(assess(pending, 26), false);
  assert.equal(pending.productionLapses[0].deductionMinor, 0);
});

test('tiers escalate once each, settings snapshot stays fixed and the last warning precedes deduction', () => {
  const store = fixture();
  assess(store, 1);
  store.settings.productionPenalty.severeBps = 9000;
  assess(store, 7);
  assess(store, 25);
  const lapse = store.productionLapses[0];
  assert.deepEqual(lapse.warnings.map((warning) => warning.tier), ['minor', 'moderate', 'severe']);
  assert.equal(lapse.rateBps, 3000);
  assert.equal(lapse.deductionMinor, 0);
  assess(store, 26);
  assert.equal(lapse.deductionMinor, 18000);
});

test('pending assessment blocks release and collection gates still apply afterwards', () => {
  const store = fixture(), order = store.orders[0];
  order.state = 'completed'; order.readyAt = atHours(25);
  assert.throws(() => releaseMilestone(order, 'delivered', { role: 'ops_admin' }, atHours(26), store), { code: 'production_penalty_pending' });
  assess(store, 26); assess(store, 27);
  order.payments.initial.status = 'pending';
  assert.throws(() => releaseMilestone(order, 'delivered', { role: 'ops_admin' }, atHours(28), store), { code: 'supplier_principal_not_collected' });
});

test('claims/refunds hold deductions, settlements close them, uncommitted and on-time work has no lapse', () => {
  for (const held of ['claim', 'refund']) {
    const store = fixture(); assess(store, 25);
    if (held === 'claim') store.claims.push({ orderId: 'order', status: 'open' });
    else store.refundRequests = [{ orderId: 'order', status: 'approved' }];
    assert.equal(assess(store, 26), false);
    assert.equal(store.productionLapses[0].deductionMinor, 0);
  }
  const store = fixture(); assess(store, 25);
  store.refundSettlements = [{ orderId: 'order', sequence: 1 }]; assess(store, 26);
  assert.equal(supplierLapses(store, 'shop')[0].status, 'closed');
  const uncommitted = fixture(); uncommitted.orders[0].commercialCommittedAt = null;
  assert.equal(assess(uncommitted, 25), false);
  const onTime = fixture(); onTime.orders[0].readyAt = DEADLINE;
  assert.equal(assess(onTime, 25), false);
});

test('100 percent penalty consumes only remaining stages and handles a fully paid order', () => {
  const store = fixture(); store.settings.productionPenalty.severeBps = 10000;
  assess(store, 25); assess(store, 26);
  assert.equal(store.productionLapses[0].deductionMinor, 60000);
  assert.deepEqual(store.orders[0].payoutMilestones.map((stage) => stage.amountMinor), [40000, 0, 0]);
  const paid = fixture(); paid.orders[0].payoutMilestones.forEach((stage) => stage.status = 'released');
  assess(paid, 25); assess(paid, 26);
  assert.equal(paid.productionLapses[0].deductionMinor, 0);
});

test('policy validation rejects strings, null, fractions, missing and out-of-order rates', () => {
  validateProductionPenalty(defaultProductionPenalty());
  for (const policy of [null, {}, { ...defaultProductionPenalty(), deductionsEnabled: 'true' },
    ...[-1, 10001, 1.2, '500', null].map((minorBps) => ({ ...defaultProductionPenalty(), minorBps })),
    { ...defaultProductionPenalty(), minorBps: 2000 }]) assert.throws(() => validateProductionPenalty(policy), { code: 'invalid_production_penalty' });
});

test('recent lapse quality adjustment is bounded and excludes old or future records', () => {
  const store = fixture();
  store.productionLapses = Array.from({ length: 10 }, (_, i) => ({ supplierId: 'shop', deadlineAt: atHours(-i), detectedAt: atHours(-i) }));
  assert.equal(recentLapseQualityPenalty(store, 'shop', DEADLINE), 10);
  assert.equal(recentLapseQualityPenalty(store, 'other', DEADLINE), 0);
  assert.equal(recentLapseQualityPenalty(store, 'shop', atHours(24 * 31)), 0);
});

test('clients and riders never see stage deductions or private reassignment evidence', () => {
  const store = fixture(); assess(store, 25); assess(store, 26);
  const order = store.orders[0]; order.productionNoCommunication = { reason: 'private' };
  for (const user of [{ id: 'client', role: 'client' }, { id: 'rider', role: 'rider' }]) {
    const result = publicOrderFor(order, user, store);
    assert.equal(result.productionNoCommunication, undefined);
    assert.equal(result.productionReassignmentEligible, undefined);
    assert.ok((result.payoutMilestones || []).every((stage) => stage.amountMinor === undefined && stage.productionDeductionMinor === undefined));
  }
});

test('real supplier terms require consent before money deduction; warning and immutable gross payout stay intact', () => {
  const store = fixture(true), order = store.orders[0];
  order.readyAt = atHours(2); order.state = 'completed';
  store.legalPenaltyGate = { versionId: 'supplier-agreement-real', acceptedSupplierIds: [] };
  assert.equal(assess(store, 2), true);
  assert.equal(assess(store, 3), false);
  assert.equal(store.productionLapses[0].deductionMinor, 0);
  store.legalPenaltyGate.acceptedSupplierIds.push('shop');
  assert.equal(assess(store, 4), true);
  assert.ok(store.productionLapses[0].deductionMinor > 0);
  assert.equal(store.productionLapses[0].supplierAgreementVersionId, 'supplier-agreement-real');
});

test('unaccepted real penalty terms never create an unresolvable penalty payout hold', () => {
  const store = fixture(true), order = store.orders[0];
  order.readyAt = atHours(2); order.state = 'completed';
  store.legalPenaltyGate = { versionId: 'real-no-consent', acceptedSupplierIds: [] };
  assess(store,2);
  const stage = order.payoutMilestones.find(stage => stage.status !== 'released');
  assert.doesNotThrow(() => releaseMilestone(order, stage.code, {id:'ops',role:'ops_admin'}, atHours(3), store));
  assert.equal(stage.status,'released');
});
