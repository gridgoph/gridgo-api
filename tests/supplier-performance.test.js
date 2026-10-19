import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id, actors } from './fixtures/reschedule.js';
import { defaultShopSchedule, addOpeningMilliseconds } from '../src/availability.js';
import { syncSupplierPerformance, supplierPerformance, routeSupplierPerformance } from '../src/supplier-performance.js';
import { performanceCounts, performanceTopPick, consequences } from '../src/supplier-performance-policy.js';
import { assessProductionLapses, recentLapseQualityPenalty } from '../src/production-penalties.js';
import { publicOrderFor, releaseMilestone } from '../src/operational-model.js';
import { matchShop } from '../src/order-match.js';

const START = '2026-10-19T00:00:00.000Z';
const DEADLINE = '2026-10-19T01:00:00.000Z';
const later = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
const day = 86400000;
function setup() {
  const store = fixture(), order = store.orders[0];
  for (const line of store.orderLineItems) { line.turnaroundHoursSnapshot = 20; line.turnaroundMinutesSnapshot = 1200; }
  store.supplierPerformanceLaunchedAt = START;
  order.readyBy = DEADLINE;
  order.shopClock = { supplierId: order.supplierId, schedule: defaultShopSchedule() };
  return { store, order };
}
const sync = (store, at) => syncSupplierPerformance(store, { at, id });
const view = (store, at) => supplierPerformance(store, 'supplier', at);
function finish(store, order, hours) {
  order.readyAt = addOpeningMilliseconds(order.shopClock.schedule, order.readyBy, Math.round(hours * 3600000));
  order.state = 'ready_for_dispatch';
  sync(store, order.readyAt);
}
const route = (store, user, path, method = 'GET', body = {}, at = START) => routeSupplierPerformance({
  store, user, url: new URL(path, 'http://test'), req: { method }, readBody: async () => body, now: () => at, id,
});
function incident(store, kind, at, orderId = id('order'), supplierId = 'supplier') {
  store.supplierPerformanceEvents.push({ id: id('event'), orderId, supplierId, kind, at, recordedAt: at, sourceKey: kind });
}

for (const [hours, tier] of [[0, null], [1, null], [1 + 1 / 3600000, 'minor'], [6, 'minor'], [6 + 1 / 3600000, 'moderate'], [24, 'moderate'], [24 + 1 / 3600000, 'severe']]) {
  test(`shop-time grace and exact tier: ${hours} hours -> ${tier}`, () => {
    const { store, order } = setup();
    const money = structuredClone(order.payoutMilestones), settings = structuredClone(store.settings);
    finish(store, order, hours);
    assert.equal(store.supplierPerformanceEvents.length, 1);
    assert.equal(store.supplierPerformanceEvents[0].tier, tier);
    assert.equal(view(store, order.readyAt).notices.length, tier ? 1 : 0);
    assert.equal(view(store, order.readyAt).onTime.rate, tier ? 0 : 1);
    assert.equal(sync(store, later(order.readyAt, day)), false);
    assert.deepEqual(order.payoutMilestones, money);
    assert.deepEqual(store.settings, settings);
    if (tier) {
      assert.equal(store.notifications.filter(row => row.type === 'supplier_performance_notice').length, 3);
      assert.match(store.notifications[0].body, /Order order: finished/);
      assert.match(store.notifications[0].body, /no money is deducted/);
    }
  });
}

test('closed days and declared extensions use the immutable committed calendar', () => {
  const { store, order } = setup();
  order.readyBy = '2026-10-24T09:00:00.000Z'; // Saturday 17:00 Manila
  order.shopClock.schedule = { utcOffsetMinutes: 480, week: [1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opensMinute: 480, closesMinute: 1020 })),
    closures: [], extension: { day: '2026-10-24', opensMinute: 1020, closesMinute: 1140 } };
  order.readyAt = '2026-10-26T00:00:00.000Z';
  store.supplierProfiles[0].schedule = { ...defaultShopSchedule(), closures: [{ startDay: '2026-10-26', endDay: '2026-10-26' }] };
  sync(store, order.readyAt);
  assert.equal(view(store, order.readyAt).notices[0].hoursLate, 2);
  assert.equal(order.readyBy, '2026-10-24T09:00:00.000Z');
});

test('QA freezes at submission, excludes rejected review waits, and records once only on approval', () => {
  const { store, order } = setup();
  order.shopHandoverVersion = 2;
  order.state = 'supplier_self_qc';
  order.shopHandover = { finished: { supplierId: 'supplier', at: later(DEADLINE, 2 * 3600000) }, review: null };
  sync(store, later(DEADLINE, 8 * 3600000));
  assert.equal(store.supplierPerformanceEvents.length, 0);
  order.shopHandover.review = { decision: 'approved', at: later(DEADLINE, 8 * 3600000) };
  sync(store, later(DEADLINE, 8 * 3600000));
  assert.equal(view(store, later(DEADLINE, 8 * 3600000)).notices[0].hoursLate, 2);
  assert.equal(sync(store, later(DEADLINE, 24 * 3600000)), false);
  const second = setup();
  second.order.shopHandoverVersion = 2;
  second.order.shopHandover = { attempts: [{ finished: { supplierId: 'supplier', at: DEADLINE },
    review: { decision: 'rejected', at: later(DEADLINE, 4 * 3600000) } }] };
  finish(second.store, second.order, 5);
  assert.equal(second.store.supplierPerformanceEvents[0].kind, 'on_time_finish');
});

test('accepted pre-deadline reschedule uses renewed deadline; pending/declined do not rebase it', () => {
  for (const status of ['accepted', 'pending', 'declined']) {
    const { store, order } = setup();
    const renewed = later(DEADLINE, 4 * 3600000);
    order.rescheduleRequest = { supplierId: 'supplier', status, originalReadyBy: DEADLINE, proposedReadyBy: renewed,
      requestedAt: START, answeredAt: DEADLINE };
    if (status === 'accepted') order.readyBy = renewed;
    order.readyAt = renewed;
    sync(store, renewed);
    assert.equal(view(store, renewed).counts.lateFinishes, status === 'accepted' ? 0 : 1);
    if (status === 'accepted') {
      // Acceptance exempts the original miss, not a subsequent miss of the renewed commitment.
      const fresh = setup(); fresh.order.readyBy = renewed; fresh.order.rescheduleRequest = order.rescheduleRequest;
      finish(fresh.store, fresh.order, 2);
      assert.equal(view(fresh.store, fresh.order.readyAt).counts.lateFinishes, 1);
    }
  }
});

test('Super Admin no-fault is immutable, removes consequences and keeps written history', async () => {
  const { store, order } = setup();
  finish(store, order, 2);
  const at = later(order.readyAt, 1000), path = '/orders/order/performance-no-fault';
  for (const actor of [actors.supplier, actors.ops, actors.client]) await assert.rejects(route(store, actor, path, 'POST', { reason: 'Storm' }, at), { code: 'forbidden' });
  await assert.rejects(route(store, actors.admin, path, 'POST', {}, at), { code: 'reason_required' });
  assert.equal((await route(store, actors.admin, path, 'POST', { reason: 'Storm' }, at)).mutated, true);
  assert.equal((await route(store, actors.admin, path, 'POST', { reason: 'Different' }, at)).mutated, false);
  const result = view(store, at);
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].exemptionReason, 'Storm');
  assert.equal(result.counts.lateFinishes, 0);
  assert.equal(result.onTime.rate, null);
  assert.equal(store.auditLog.filter(row => row.action === 'supplier_performance.no_fault').length, 1);
});

test('reason-coded declines count warnings, cancellation before acceptance is a decline, retries count once', () => {
  const { store, order } = setup();
  order.shopFailureEvents = [1, 2, 3].map(n => ({ id: `failure${n}`, supplierId: 'supplier', kind: n === 3 ? 'cancelled' : 'declined', stage: 'supplier_assigned', reason: 'Capacity', reasonCode: 'capacity', at: later(START, n) }));
  sync(store, later(START, 4)); sync(store, later(START, 5));
  const result = view(store, later(START, 5));
  assert.equal(result.counts.declines, 3);
  assert.equal(result.counts.cancellations, 0);
  assert.deepEqual(result.warnings.map(row => row.warningCodes), [['repeated_declines']]);
  assert.equal(result.events[0].reasonCode, 'capacity');
  assert.equal(result.topPick.hidden, false);
});

for (const [kind, threshold, warning, roster] of [['timed_out', 3, 'repeated_timeouts', false], ['late_finish', 2, 'late_finish', false], ['cancelled', 2, 'accepted_order_cancelled', true], ['arrived_packed', 2, 'repeated_arrived_packed', false]]) {
  test(`${kind}: rolling thresholds, warnings, roster and demotion expiry`, () => {
    const { store } = setup();
    for (let n = 1; n <= threshold; n++) {
      const order = structuredClone(store.orders[0]); order.id = `order${n}`;
      const at = later(DEADLINE, n * 3600000);
      if (kind === 'late_finish') order.readyAt = later(at, 2 * 3600000);
      else if (kind === 'arrived_packed') order.shopHandover = { arrivedPacked: [{ supplierId: 'supplier', riderId: 'rider', at }] };
      else order.shopFailureEvents = [{ id: `failure${n}`, supplierId: 'supplier', kind, stage: 'production', reason: 'Reason', at }];
      store.orders.push(order);
    }
    const at = later(DEADLINE, 6 * 3600000);
    sync(store, at);
    const result = view(store, at);
    assert.ok(result.warnings.some(row => row.warningCodes.includes(warning)));
    assert.equal(result.rosterReview, roster);
    const hidden = ['late_finish', 'timed_out'].includes(kind);
    assert.equal(result.topPick.hidden, hidden);
    if (hidden) {
      const expiry = result.topPick.hiddenUntil;
      assert.equal(performanceTopPick(store, 'supplier', later(expiry, -1)).hidden, true);
      assert.equal(performanceTopPick(store, 'supplier', expiry).hidden, false);
      sync(store, later(expiry, 1));
      assert.equal(performanceTopPick(store, 'supplier', later(expiry, 1)).hidden, false);
    }
    assert.deepEqual(performanceCounts(store, 'supplier', later(at, 30 * day)), { declines: 0, timeouts: 0, lateFinishes: 0, cancellations: 0, arrivedPacked: 0 });
  });
}

test('third late finish flags roster review; a no-fault correction removes the threshold', () => {
  const { store } = setup();
  for (let n = 0; n < 3; n++) incident(store, 'late_finish', later(START, n), `order${n}`);
  assert.equal(view(store, later(START, 5)).rosterReview, true);
  incident(store, 'no_fault', later(START, 4), 'order2');
  assert.equal(view(store, later(START, 5)).rosterReview, false);
  incident(store, 'no_fault', later(START, 5), 'order1');
  assert.equal(performanceTopPick(store, 'supplier', later(START, 5)).hidden, false);
});

test('demotion selects an unhidden shop; all-hidden fallback preserves ranked winner and alternatives', () => {
  const { store } = setup();
  const input = { subcategoryCode: 'flyers', ranking: ['quality', 'speed', 'cost', 'distance'], now: later(START, 10) };
  const original = matchShop(store, input);
  const winner = original.shop.supplierId;
  for (let n = 0; n < 2; n++) incident(store, 'late_finish', later(START, n), `late${n}`, winner);
  const demoted = matchShop(store, input);
  assert.notEqual(demoted.shop.supplierId, winner);
  assert.equal(demoted.otherListings.length, original.otherListings.length);
  for (let n = 0; n < 2; n++) incident(store, 'late_finish', later(START, n), `other${n}`, demoted.shop.supplierId);
  assert.equal(matchShop(store, input).shop.supplierId, winner);
  assert.deepEqual(matchShop(store, input).matchReason, original.matchReason);
  assert.equal(matchShop(store, { ...input, now: later(START, 7 * day + 10) }).shop.supplierId, winner);
});

test('launch never deducts even with enabled settings, signed terms or an old pending lapse', () => {
  const { store, order } = setup();
  store.settings.productionPenalty.deductionsEnabled = true;
  store.legalPenaltyGate = { versionId: 'terms', acceptedSupplierIds: ['supplier'] };
  const originalMoney = structuredClone(order.payoutMilestones);
  finish(store, order, 25);
  const at = later(order.readyAt, 1);
  assessProductionLapses(store, { at, createId: id });
  const lapse = store.productionLapses[0];
  lapse.policy.deductionsEnabled = true; // emulate a pending pre-launch warning
  assessProductionLapses(store, { at: later(at, day), createId: id });
  assert.equal(lapse.appliedAt, null);
  assert.deepEqual(order.payoutMilestones, originalMoney);
  order.payoutMilestones[0].status = 'pof_attached'; order.payoutMilestones[0].pofFileIds = ['proof'];
  assert.doesNotThrow(() => releaseMilestone(order, order.payoutMilestones[0].code, actors.ops, at, store));
  assert.equal(order.payoutMilestones[0].amountMinor, originalMoney[0].amountMinor);
  assert.equal(store.settings.productionPenalty.deductionsEnabled, true, 'the stored switch is untouched');
});

test('rollout does not backfill completed historical orders or leak its adoption clock', () => {
  const { store, order } = setup();
  order.readyAt = later(START, -1);
  assert.equal(sync(store, START), false);
  assert.equal(store.supplierPerformanceEvents.length, 0);
  delete order.readyAt; delete order.shopClock;
  sync(store, START);
  const clock = structuredClone(order.performanceClock);
  store.supplierProfiles[0].schedule = { ...defaultShopSchedule(), closures: [{ startDay: '2026-10-19', endDay: '2026-10-19' }] };
  sync(store, later(START, 1));
  assert.deepEqual(order.performanceClock, clock);
  for (const user of Object.values(actors)) assert.equal(publicOrderFor(order, user, store).performanceClock, undefined);
});

test('a reschedule requested at/after the deadline cannot erase Performance lateness', () => {
  for (const requestedAt of [DEADLINE, later(DEADLINE, 1)]) {
    const { store, order } = setup();
    const renewed = later(DEADLINE, 4 * 3600000);
    order.rescheduleRequest = { supplierId: 'supplier', status: 'accepted', originalReadyBy: DEADLINE,
      proposedReadyBy: renewed, requestedAt };
    order.readyBy = renewed; order.readyAt = renewed;
    sync(store, renewed);
    assert.equal(view(store, renewed).notices[0].deadlineAt, DEADLINE);
    assert.equal(view(store, renewed).notices[0].hoursLate, 4);
    assert.equal(order.readyBy, renewed, 'the accepted operational date stays unchanged');
  }
});

test('no-fault before finish suppresses warnings, quality impact and demotion; incident window is exact', async () => {
  const { store, order } = setup();
  await route(store, actors.admin, '/orders/order/performance-no-fault', 'POST', { reason: 'Verified event' });
  finish(store, order, 2);
  assert.equal(view(store, order.readyAt).notices[0].exempt, true);
  assert.equal(view(store, order.readyAt).warnings.length, 0);
  assert.equal(view(store, order.readyAt).counts.lateFinishes, 0);
  assert.equal(recentLapseQualityPenalty(store, 'supplier', order.readyAt), 0);
  incident(store, 'declined', START, 'other');
  assert.equal(performanceCounts(store, 'supplier', later(START, 30 * day - 1)).declines, 1);
  assert.equal(performanceCounts(store, 'supplier', later(START, 30 * day)).declines, 0);
});


test('legacy adoption takes pre-edit hours when the first save is an hours change', () => {
  const { store, order } = setup();
  delete order.shopClock;
  store.supplierProfiles[0].schedule = defaultShopSchedule();
  const clockStore = structuredClone(store);
  store.supplierProfiles[0].schedule.closures = [{ startDay: '2026-10-19', endDay: '2026-10-19' }];
  syncSupplierPerformance(store, { at: START, id, clockStore });
  assert.deepEqual(order.performanceClock.schedule, clockStore.supplierProfiles[0].schedule);
});

test('on-time rate counts completed outcomes once and excludes no-fault and old incidents', () => {
  const { store } = setup();
  incident(store, 'on_time_finish', START, 'ontime');
  incident(store, 'late_finish', later(START, 1), 'late1');
  incident(store, 'late_finish', later(START, 2), 'late2');
  incident(store, 'on_time_finish', later(START, -31 * day), 'old');
  assert.deepEqual(view(store, later(START, 3)).onTime, { completed: 3, onTime: 1, late: 2, rate: 0.3333 });
  incident(store, 'no_fault', later(START, 3), 'late1');
  assert.deepEqual(view(store, later(START, 4)).onTime, { completed: 2, onTime: 1, late: 1, rate: 0.5 });
});


test('each count threshold starts exactly at the required incident', () => {
  for (const [kind, key, count, warning, hidden, review] of [
    ['declined', 'declines', 2, false, false, false], ['declined', 'declines', 3, true, false, false],
    ['timed_out', 'timeouts', 1, false, false, false], ['timed_out', 'timeouts', 2, true, false, false], ['timed_out', 'timeouts', 3, true, true, false],
    ['late_finish', 'lateFinishes', 1, true, false, false], ['late_finish', 'lateFinishes', 2, true, true, false], ['late_finish', 'lateFinishes', 3, true, true, true],
    ['cancelled', 'cancellations', 1, true, false, false], ['cancelled', 'cancellations', 2, true, false, true],
    ['arrived_packed', 'arrivedPacked', 1, false, false, false], ['arrived_packed', 'arrivedPacked', 2, true, false, false],
  ]) {
    const effect = consequences(kind, { declines: 0, timeouts: 0, lateFinishes: 0, cancellations: 0, arrivedPacked: 0, [key]: count });
    assert.equal(Boolean(effect.warnings.length), warning, `${kind} ${count} warning`);
    assert.equal(effect.hideTopPick, hidden, `${kind} ${count} Top Pick`);
    assert.equal(effect.rosterReview, review, `${kind} ${count} review`);
  }
});

test('repeated arrived-packed reports for one order count once', () => {
  const { store, order } = setup();
  order.shopHandover = { arrivedPacked: [1, 2].map(n => ({ supplierId: 'supplier', riderId: `rider${n}`, at: later(START, n) })) };
  sync(store, later(START, 3));
  assert.equal(view(store, later(START, 3)).counts.arrivedPacked, 1);
  assert.equal(view(store, later(START, 3)).warnings.length, 0);
});

test('Tight reasoned declines and pilot late finishes keep notices without performance penalties', () => {
  const {store,order}=setup();
  order.scheduling={tightDeadline:true};
  order.shopFailureEvents=[{id:'decline',supplierId:'supplier',kind:'declined',stage:'supplier_assigned',reason:'Cannot meet the short date',at:START}];
  finish(store,order,25);
  assert.equal(view(store,order.readyAt).counts.declines,0);
  assert.equal(view(store,order.readyAt).counts.lateFinishes,0);
  assert.equal(view(store,order.readyAt).topPick.hidden,false);
  assert.equal(view(store,order.readyAt).notices.length,1);
  assert.equal(view(store,order.readyAt).notices[0].exempt,true);
});
