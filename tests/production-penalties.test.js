import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProductionLapses, cappedPenaltyMinor, defaultProductionPenalty, latenessTier,
  recentLapseQualityPenalty, validateProductionPenalty, supplierLapses, productionTiming } from '../src/production-penalties.js';
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

test('corrected production deadlines stay warning-only and correction evidence is private for every role', () => {
  const store = fixture(true), order = store.orders[0];
  order.productionTimeCorrection = { report: '39853344', penaltyExempt: true, review: { schedulingBasis: 'private review' } };
  order.readyAt = atHours(25); order.state = 'completed';
  const stages = structuredClone(order.payoutMilestones);
  assess(store, 25); assess(store, 26);
  assert.equal(store.productionLapses[0].policy.deductionsEnabled, false);
  assert.deepEqual(order.payoutMilestones, stages);
  for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin']) {
    assert.equal(publicOrderFor(order, { id: role, role }, store).productionTimeCorrection, undefined);
  }
  for (const stage of order.payoutMilestones) releaseMilestone(order, stage.code, { id: 'ops', role: 'ops_admin' }, atHours(27), store);
});

test('a pre-existing warning cannot enable deductions after reviewed time correction', () => {
  const store = fixture(true), order = store.orders[0];
  const before = structuredClone(order.payoutMilestones);
  assess(store, 2);
  order.productionTimeCorrection = { penaltyExempt: true };
  assess(store, 25); assess(store, 26);
  assert.equal(supplierLapses(store, 'shop')[0].status, 'warning_only');
  assert.match(store.productionLapses[0].warnings.at(-1).message, /warning only/);
  assert.deepEqual(order.payoutMilestones, before);
});

test('on-time finished submission never receives a lapse or deduction for GRIDGO QA delay', () => {
  const store = fixture(), order = store.orders[0];
  order.shopHandoverVersion = 2; order.state = 'supplier_self_qc';
  order.shopHandover = { finished: { at: atHours(-1), supplierId: 'shop' }, review: null };
  const before = structuredClone(order.payoutMilestones);
  assert.equal(assess(store, 25), false);
  assert.equal(assess(store, 26), false);
  assert.deepEqual(store.productionLapses, []);
  order.shopHandover.review = { at: atHours(48), decision: 'approved' };
  order.state = 'ready_for_dispatch'; order.readyAt = atHours(50);
  assert.equal(assess(store, 60), false);
  assert.deepEqual(order.payoutMilestones, before);
  // QA waiting must not add the payout gate either.
  order.payoutMilestones[0].status = 'pof_attached';
  assert.doesNotThrow(() => releaseMilestone(order, 'production_started', { role: 'ops_admin' }, atHours(60), store));
});

test('late submission freezes its tier while QA is pending and deducts only after approval', () => {
  const store = fixture(), order = store.orders[0];
  order.shopHandoverVersion = 2; order.state = 'supplier_self_qc';
  order.shopHandover = { finished: { at: atHours(2), supplierId: 'shop' }, review: null };
  assess(store, 25); assess(store, 50);
  assert.equal(store.productionLapses[0].tier, 'minor');
  assert.equal(store.productionLapses[0].deductionMinor, 0);
  order.shopHandover.review = { at: atHours(51), decision: 'approved' };
  assess(store, 52);
  assert.equal(store.productionLapses[0].tier, 'minor');
  assert.equal(store.productionLapses[0].deductionMinor, 3000);
  const applied = structuredClone(store.productionLapses[0]);
  order.shopHandover.finished.at = atHours(-1);
  assess(store, 100);
  assert.deepEqual(store.productionLapses[0], applied, 'already-applied money stays immutable');
});

test('rejected QA resumes production with review intervals excluded across repeated attempts', () => {
  const store = fixture(), order = store.orders[0];
  order.shopHandoverVersion = 2;
  order.shopHandover = { finished: null, review: { decision: 'rejected' }, attempts: [
    { finished: { at: atHours(-1), supplierId: 'shop' }, review: { at: atHours(25), decision: 'rejected' } },
  ] };
  assert.equal(assess(store, 25.5), false); // 26 review hours; still 30 minutes of shop time left.
  assess(store, 27);
  assert.equal(store.productionLapses[0].tier, 'minor');
  order.shopHandover.attempts.push({ finished: { at: atHours(27), supplierId: 'shop' }, review: { at: atHours(51), decision: 'rejected' } });
  assess(store, 55);
  assert.equal(store.productionLapses[0].tier, 'minor'); // 55 - 26 - 24 = 5 hours
  assess(store, 57);
  assert.equal(store.productionLapses[0].tier, 'moderate');
  assert.equal(store.productionLapses[0].deductionMinor, 0);
});

test('pending severe QA cannot deduct; legacy and replacement shops do not inherit QA timing credits', () => {
  const store = fixture(), order = store.orders[0];
  order.shopHandoverVersion = 2; order.state = 'supplier_self_qc';
  order.shopHandover = { finished: { at: atHours(25), supplierId: 'shop' }, review: null };
  assess(store, 26); assess(store, 27);
  assert.equal(store.productionLapses[0].tier, 'severe');
  assert.equal(store.productionLapses[0].appliedAt, null);
  const legacy = fixture(), legacyOrder = legacy.orders[0];
  legacyOrder.shopHandover = structuredClone(order.shopHandover);
  assess(legacy, 26); assess(legacy, 27);
  assert.ok(legacy.productionLapses[0].appliedAt);
  const replacement = fixture(), replacementOrder = replacement.orders[0];
  replacementOrder.shopHandoverVersion = 2;
  replacementOrder.shopHandover = { finished: { at: atHours(-1), supplierId: 'old_shop' }, review: { decision: 'approved' }, attempts: [
    { finished: { at: atHours(-10), supplierId: 'old_shop' }, review: { at: atHours(20), decision: 'rejected' } },
  ] };
  assess(replacement, 25);
  assert.equal(replacement.productionLapses[0].tier, 'severe');
});


test('rejected review credits use snapshotted operating hours, including closed days and intervals before the deadline', () => {
  const store = fixture(), order = store.orders[0];
  order.shopHandoverVersion = 2;
  order.operatingClock = { version: 1, schedule: { utcOffsetMinutes: 480, closures: [], week: [1, 2, 3, 4, 5]
    .map(weekday => ({ weekday, opensMinute: 480, closesMinute: 1020 })) } };
  order.readyBy = '2026-10-09T09:00:00.000Z'; // Friday 17:00 Manila
  order.shopHandover = { attempts: [{ finished: { at: '2026-10-09T08:00:00.000Z', supplierId: 'shop' },
    review: { at: '2026-10-12T01:00:00.000Z', decision: 'rejected' } }] };
  const monday10 = productionTiming(order, '2026-10-12T02:00:00.000Z');
  assert.equal(monday10.reviewWaitMs, 2 * 3600000); // Friday 16-17 and Monday 8-9 only
  assert.equal(monday10.elapsedMs, 0);
  assert.equal(productionTiming(order, '2026-10-12T03:00:00.000Z').elapsedMs, 3600000);
  assert.equal(productionTiming(order, null).finishedAt, null);
});

test('pilot Tight, same-day and legacy Express lapses warn but never deduct, including pending lapses', () => {
  for (const flags of [{ scheduling: { tightDeadline: true } }, { scheduling: { sameDay: true } }, { express: true }]) {
    const store = fixture(true), order = store.orders[0];
    assess(store, 25); // A pre-release warning must not enable a later deduction.
    Object.assign(order, flags);
    const before = structuredClone(order.payoutMilestones), promised = order.readyBy;
    assess(store, 26);
    assert.deepEqual(order.payoutMilestones, before);
    assert.equal(order.readyBy, promised);
    assert.equal(store.productionLapses[0].deductionMinor, 0);
    assert.equal(supplierLapses(store, 'shop')[0].status, 'warning_only');
  }
});
