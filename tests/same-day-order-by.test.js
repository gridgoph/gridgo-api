import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller } from './fixtures/scheduling.js';
import { deadlineDays, projectShopFinish, schedulingCalendar, shopFinishProjector } from '../src/order-match.js';
import { previewProductionTime } from '../src/production-time-preview.js';

const DAY = '2026-11-05';
const local = time => `${DAY}T${time}+08:00`;
const iso = time => new Date(local(time)).toISOString();
function setup(minutes = 60) {
  const { store, client } = fixture();
  store.catalogItems.splice(1);
  Object.assign(store.catalogItems[0], { turnaroundMode: 'override', turnaroundHours: minutes / 60,
    minimumTurnaroundHours: minutes / 60 });
  // Production report 04A153AD: Mon–Sat 08–17 GRIDGO, default 08–18 shop,
  // 60-minute ordinary review, omitted same-day settings (defaults 30/120).
  delete store.settings.promiseAllowanceMinutes;
  delete store.settings.operatingHours.sameDayReviewMinutes;
  delete store.settings.operatingHours.sameDayPromiseAllowanceMinutes;
  return { store, client };
}
const answer = (store, time, days = 2) => deadlineDays(store, { subcategoryCode: 'flyers', now: local(time), days });
function boundary(store, time) {
  const cutoff = Date.parse(local(time));
  for (const offset of [-1, 0, 1]) {
    const result = deadlineDays(store, { subcategoryCode: 'flyers', now: new Date(cutoff + offset).toISOString(), days: 1 });
    assert.deepEqual(result.sameDayOrderBy, { at: new Date(cutoff).toISOString(), passed: offset >= 0 });
    assert.equal(result.days[0].state !== 'cannot', !result.sameDayOrderBy.passed);
  }
}

test('one-hour report replay preserves dates and exposes the exclusive 12:30 last order time', () => {
  const { store } = setup();
  boundary(store, '12:30:00');
  for (const [time, expected] of [['13:32:00', '2026-11-06T00:02:00.000Z'], ['13:35:00', '2026-11-06T00:05:00.000Z']]) {
    const result = answer(store, time);
    const projection = projectShopFinish(store, { supplierId: 'shop_a', turnaroundHours: 1, minimumTurnaroundHours: 1, units: 1, now: local(time) }).projection;
    assert.equal(projection.promiseBy, expected);
    assert.equal(result.earliest, expected);
    assert.deepEqual(result.sameDayOrderBy, { at: iso('12:30:00'), passed: true });
    assert.deepEqual(result.days.map(({ day, state, status, reason, readyBy }) => ({ day, state, status, reason, readyBy })), [
      { day: DAY, state: 'cannot', status: 'not_possible', reason: 'before_shortest_time', readyBy: null },
      { day: '2026-11-06', state: 'open', status: 'secured', reason: null, readyBy: expected },
    ]);
  }
  assert.equal(answer(store, '12:29:59.999').days[0].readyBy, iso('15:59:59.999'));
  assert.equal(answer(store, '12:30:00').earliest, '2026-11-06T00:00:00.000Z');
});

test('30-minute production has its own exact boundary; ordinary minimum keeps Tight selectable', () => {
  const { store } = setup(30);
  boundary(store, '13:00:00');
  Object.assign(store.catalogItems[0], { turnaroundHours: 2 });
  boundary(store, '13:00:00');
  assert.equal(answer(store, '12:59:59.999').days[0].status, 'tight');
});

test('the current queue moves the boundary for both order and per-shop job records', () => {
  for (const kind of ['orders', 'orderJobs']) {
    const { store } = setup();
    store[kind].push({ id: 'queued', supplierId: 'shop_a', state: 'production', estimatedHours: 0.75 });
    boundary(store, '11:45:00');
  }
});

test('several candidates use the latest available boundary, across shops and same-shop listings', () => {
  const { store: all } = fixture();
  const { store } = setup();
  // The second shop already has approval, capability and files in this fixture.
  store.catalogItems.push({ ...all.catalogItems[1], turnaroundMode: 'override', turnaroundHours: 0.5, minimumTurnaroundHours: 0.5 });
  boundary(store, '13:00:00');
  store.catalogItems[1].supplierId = 'shop_a';
  store.catalogItems[1].supplierServiceId = 'service_shop_a';
  boundary(store, '13:00:00');
});

test('before opening and after closing keep the same cutoff and existing hours refusal', () => {
  const { store } = setup();
  for (const [time, passed, reason] of [['07:00:00', false, 'outside_operating_hours'], ['18:00:00', true, 'after_dispatch_cutoff']]) {
    const result = answer(store, time);
    assert.deepEqual(result.sameDayOrderBy, { at: iso('12:30:00'), passed });
    assert.equal(result.days[0].reason, reason);
    assert.equal(result.days[0].state, 'cannot');
    assert.equal(result.operatingStatus.isOpenNow, false);
  }
  assert.equal(answer(store, '08:00:00').days[0].state, 'open');
});

test('GRIDGO closure, Sunday, shop closure, day production, capacity and no eligible listing return null', () => {
  for (const variant of ['dated_gridgo_closure', 'sunday', 'shop_closure', 'shop_opens_too_late', 'days', 'capacity', 'ineligible', 'empty']) {
    const { store } = setup();
    let now = local('09:00:00');
    if (variant === 'dated_gridgo_closure') store.settings.operatingHours.schedule.closures.push({ startDay: DAY, endDay: DAY });
    if (variant === 'sunday') now = '2026-11-08T09:00:00+08:00';
    if (variant === 'shop_closure') store.supplierProfiles[0].schedule = { utcOffsetMinutes: 480,
      week: [1,2,3,4,5,6].map(weekday => ({ weekday, opensMinute: 480, closesMinute: 1080 })), closures: [{ startDay: DAY, endDay: DAY }] };
    if (variant === 'shop_opens_too_late') store.supplierProfiles[0].schedule = { utcOffsetMinutes: 480,
      week: [1,2,3,4,5,6].map(weekday => ({ weekday, opensMinute: 840, closesMinute: 1080 })), closures: [] };
    if (variant === 'days') Object.assign(store.catalogItems[0], { turnaroundDays: 1, minimumTurnaroundDays: 1, turnaroundHours: 10, minimumTurnaroundHours: 10 });
    if (variant === 'capacity') { store.supplierServices[0].capacityDaily = 1; store.catalogItems[0].minimumOrderQuantity = 2; }
    if (variant === 'ineligible') store.catalogItems[0].active = false;
    if (variant === 'empty') store.catalogItems = [];
    const result = deadlineDays(store, { subcategoryCode: 'flyers', now, days: 1 });
    assert.equal(result.sameDayOrderBy, null, variant);
    assert.equal(result.days[0].state, 'cannot', variant);
  }
});

test('approved rush tier can provide the last opportunity today without changing its price', () => {
  const { store } = setup(1800);
  store.catalogSpeedTiers = [{ id: 'rush', catalogItemId: 'item_shop_a', label: 'Fast', turnaroundHours: 0.5, priceMinor: 12345 }];
  const before = structuredClone(store);
  boundary(store, '13:00:00');
  const result = answer(store, '12:59:59.999');
  assert.equal(result.days[0].status, 'rush');
  assert.equal(result.days[0].rushTier.priceMinor, 12345);
  assert.deepEqual(store, before);
  store.catalogSpeedTiers = [];
  assert.equal(answer(store, '09:00:00').sameDayOrderBy, null);
});

test('shop preview and client route share the additive cutoff without changing other preview fields', async () => {
  const { store, client } = setup();
  const before = structuredClone(store);
  const now = local('13:35:00');
  const preview = previewProductionTime(store, store.catalogItems[0], { mode: 'same_day', hours: 1 }, { now, days: 7 });
  assert.deepEqual(store, before);
  const response = await caller(store, client, now)('GET', '/me/deadline-days?subcategoryCode=flyers&days=7');
  assert.equal(response.status, 200);
  assert.deepEqual(preview.calendar, response.body);
  assert.deepEqual(response.body.sameDayOrderBy, { at: iso('12:30:00'), passed: true });
  assert.equal(response.mutated, undefined);
});

test('cutoff computation is bounded independently of display horizon and reuses prepared queue inputs', () => {
  const { store } = setup();
  const project = shopFinishProjector(store, { supplierId: 'shop_a', turnaroundHours: 1 });
  // The projector has captured queue/capacity/profile inputs. Probes must not
  // scan these collections again or depend on the calendar display horizon.
  for (const key of ['orders', 'orderJobs', 'supplierServices', 'supplierProfiles']) Object.defineProperty(store, key, { get() { throw new Error(`rescanned ${key}`); } });
  for (const days of [0, 1, 120]) {
    let probes = 0;
    const projectAt = now => { probes++; return { projection: project(now).projection, rushChoices: [] }; };
    const choice = { ...projectAt(local('09:00:00')), projectAt, listing: { express: false } };
    probes = 0;
    const result = schedulingCalendar(store, [choice], { now: local('09:00:00'), days });
    assert.deepEqual(result.sameDayOrderBy, { at: iso('12:30:00'), passed: false });
    assert.ok(probes <= 28, `probes=${probes}`);
  }
});
