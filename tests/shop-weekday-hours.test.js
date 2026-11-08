import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultShopSchedule, addWorkingMinutes, addWorkingDays, addOpeningMilliseconds,
  openingMillisecondsBetween, workingMinutesBetween, isOpenAt, projectFinish, validateShopSchedule, AvailabilityError } from '../src/availability.js';
import { productionDayMinutes } from '../src/production-days.js';
import { routeSupplierCatalog } from '../src/catalog-routes.js';
import { snapshotShopClock, shopHoursStatus } from '../src/shop-hours.js';
import { startShopAcceptance } from '../src/shop-recovery.js';
import { nextNudgeDueAt } from '../src/production-inactivity.js';
import { productionTiming } from '../src/production-penalties.js';
import { defaultOperatingHours } from '../src/operating-hours.js';
import { validateOperatingHours } from '../src/operating-hours.js';
import { validateHubPickup } from '../src/hub-pickup.js';
import { availableDispatch } from '../src/dispatch-policy.js';
import { nextShopDispatchAt, requireShopDispatchHours } from '../src/shop-dispatch-hours.js';
import { projectShopFinish, matchShop, deadlineDays, projectMatchCandidate } from '../src/order-match.js';
import { fixture } from './fixtures/scheduling.js';

const saturday = { weekday: 6, opensMinute: 480, closesMinute: 900 }; // 08:00–15:00 Manila
const shortWeek = () => ({ ...defaultShopSchedule(), weekdayOverrides: [{ ...saturday }] });
const fri = '2026-10-16T09:30:15.123Z'; // Friday 17:30:15.123 Manila
const sat = '2026-10-17T06:30:15.123Z'; // Saturday 14:30:15.123 Manila
const mon = '2026-10-19T00:30:15.123Z'; // Monday 08:30:15.123 Manila
const nudgePolicy = { enabled: true, afterMs: 3600000, everyMs: 3600000, maxCount: 3 };

function shopStore() {
  return { settings: { operatingHours: defaultOperatingHours() },
    supplierProfiles: [{ userId: 'shop', version: 1, schedule: defaultShopSchedule() }],
    userRoleMemberships: [{ userId: 'ops', role: 'ops_admin' }], notifications: [], auditLog: [] };
}
const patch = (store, body, at = sat) => routeSupplierCatalog({ store, user: { id: 'shop', role: 'supplier' },
  req: { method: 'PATCH', headers: {} }, url: new URL('http://test/me/shop-hours'), readBody: async () => body,
  now: () => at, id: prefix => `${prefix}_${Math.random()}`, audit: (s, event) => s.auditLog.push(event) });

test('a shorter Saturday carries exact service time across Sunday, without changing a production day', () => {
  const schedule = shortWeek();
  assert.equal(productionDayMinutes(schedule), 600);
  assert.equal(addOpeningMilliseconds(schedule, sat, 3600000), mon);
  assert.equal(addOpeningMilliseconds(schedule, fri, 8 * 3600000), mon);
  assert.equal(openingMillisecondsBetween(schedule, sat, mon), 3600000);
  assert.equal(workingMinutesBetween(schedule, '2026-10-17T06:30:00Z', '2026-10-19T00:30:00Z'), 60);
  assert.equal(addWorkingDays(schedule, fri, 1), '2026-10-17T07:00:00.000Z');
  assert.equal(isOpenAt(schedule, '2026-10-17T06:59:59.999Z'), true);
  assert.equal(isOpenAt(schedule, '2026-10-17T07:00:00.000Z'), false);
  assert.equal(isOpenAt(schedule, '2026-10-18T02:00:00.000Z'), false);
  const order = { supplierId: 'shop', shopClockVersion: 1, readyBy: sat };
  const store = shopStore(); store.supplierProfiles[0].schedule = schedule;
  startShopAcceptance(store, order, sat);
  assert.equal(order.shopAcceptance.deadlineAt, mon);
  assert.equal(nextNudgeDueAt(sat, null, 0, nudgePolicy, order.shopClock), mon);
  assert.equal(productionTiming(order, mon).elapsedMs, 3600000);
});

test('weekday override PATCH preserves old editors, supports reset and uses the effective close for extensions', async () => {
  const store = shopStore();
  let result = await patch(store, { expectedVersion: 1, schedule: shortWeek() });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.hours.schedule.weekdayOverrides, [saturday]);
  assert.equal(result.body.hours.features.weekdayOverrides, true);
  assert.equal(result.body.hours.isOpenNow, true);
  result = await patch(store, { expectedVersion: 2, schedule: defaultShopSchedule() });
  assert.deepEqual(result.body.hours.schedule.weekdayOverrides, [saturday], 'old editors cannot erase new fields');
  result = await patch(store, { expectedVersion: 3, extension: { closesMinute: 960 } });
  assert.equal(result.body.hours.todayExtension.opensMinute, 900);
  assert.equal(isOpenAt(store.supplierProfiles[0].schedule, '2026-10-17T07:30:00Z'), true);
  result = await patch(store, { expectedVersion: 4, schedule: { ...defaultShopSchedule(), weekdayOverrides: [] } });
  assert.deepEqual(result.body.hours.schedule.weekdayOverrides, []);
  assert.equal(result.body.hours.todayExtension, null);
  assert.equal(store.auditLog.length, 4);
  assert.equal(store.notifications.length, 8);
});

test('overrides validate unique open weekdays, Manila time and increasing bounded integer windows atomically', async () => {
  const store = shopStore();
  for (const weekdayOverrides of [null, {}, [saturday, saturday], [{ ...saturday, weekday: 0 }],
    [{ ...saturday, weekday: 7 }], [{ ...saturday, weekday: '6' }], [{ ...saturday, opensMinute: -1 }],
    [{ ...saturday, opensMinute: 900 }], [{ ...saturday, closesMinute: 400 }], [{ ...saturday, closesMinute: 1441 }],
    [{ ...saturday, closesMinute: 900.5 }], [{ ...saturday, unexpected: true }]]) {
    await assert.rejects(patch(store, { expectedVersion: 1, schedule: { ...defaultShopSchedule(), weekdayOverrides } }), { code: 'invalid_shop_hours' });
  }
  await assert.rejects(patch(store, { expectedVersion: 1, schedule: { ...shortWeek(), utcOffsetMinutes: 0 } }), { code: 'invalid_shop_hours' });
  assert.equal(store.supplierProfiles[0].version, 1);
  assert.equal(store.auditLog.length, 0);
  assert.equal(store.notifications.length, 0);
  const closed = shortWeek(); closed.closures = [{ startDay: '2026-10-17', endDay: '2026-10-17' }];
  assert.equal(isOpenAt(closed, sat), false);
  assert.equal(addOpeningMilliseconds(closed, sat, 3600000), '2026-10-19T01:00:00.000Z');
  assert.throws(() => validateShopSchedule({ ...shortWeek(), week: defaultShopSchedule().week.slice(0, 5) }), { code: 'invalid_schedule' });
  assert.throws(() => validateOperatingHours({ ...defaultOperatingHours(), schedule: shortWeek() }), { code: 'invalid_operating_hours' });
  assert.throws(() => validateHubPickup({ schedule: shortWeek(), feeMinor: 0 }, (status, code) => {
    throw Object.assign(new Error(code), { status, code });
  }), { code: 'invalid_hub_pickup_schedule' });
});

test('ready-by, matching and the availability calendar all roll unfinished Saturday work to Monday', () => {
  const { store } = fixture(); store.catalogItems.splice(1);
  store.settings.operatingHours.sameDayPromiseAllowanceMinutes = 0;
  Object.assign(store.catalogItems[0], { turnaroundMode: 'override', turnaroundHours: 2, minimumTurnaroundHours: 2 });
  const now = '2026-10-17T05:00:00.000Z'; // 13:00: 30m review then 2h production
  const query = { subcategoryCode: 'flyers', now, days: 3 };
  const input = { ...query, ranking: ['speed', 'quality', 'cost', 'distance'], deadline: '2026-10-17T08:00:00.000Z' };
  assert.equal(matchShop(store, input).listings.length, 1);
  assert.equal(deadlineDays(store, query).days[0].status, 'secured');
  store.supplierProfiles[0].schedule = shortWeek();
  const projection = projectShopFinish(store, { supplierId: 'shop_a', turnaroundHours: 2, now }).projection;
  assert.equal(projection.readyBy, '2026-10-19T00:30:00.000Z');
  assert.equal(projection.promiseBy, '2026-10-19T00:30:00.000Z');
  assert.throws(() => matchShop(store, input), { code: 'deadline_not_met' });
  const calendar = deadlineDays(store, query);
  assert.equal(calendar.days[0].status, 'not_possible');
  assert.equal(calendar.days[1].reason, 'gridgo_closed_sunday');
  assert.equal(calendar.days[2].status, 'secured');
  assert.equal(calendar.days[2].readyBy, projection.promiseBy);
  assert.equal(matchShop(store, { ...input, deadline: '2026-10-19T08:00:00Z' }).listings[0].readyBy, projection.promiseBy);
});

test('dispatch waits for overlapping openings at early close; historical offers keep their behavior', () => {
  const schedule = shortWeek(), settings = { operatingHours: defaultOperatingHours(), promiseAllowanceMinutes: 0 };
  const clock = { version: 1, schedule };
  const order = { state: 'ready_for_dispatch', fulfillmentMode: 'delivery', shopClock: clock,
    operatingClock: { version: 1, schedule: settings.operatingHours.schedule } };
  const close = '2026-10-17T07:00:00.000Z';
  assert.equal(availableDispatch(order, { settings }, sat), true);
  assert.equal(availableDispatch(order, { settings }, close), false);
  assert.equal(nextShopDispatchAt(settings, schedule, close), '2026-10-19T00:00:00.000Z');
  assert.throws(() => requireShopDispatchHours(order, settings, close), error => error.code === 'outside_shop_hours'
    && error.details.nextDispatchAt === '2026-10-19T00:00:00.000Z');
  assert.equal(availableDispatch({ ...order, shopClock: { ...clock, schedule: defaultShopSchedule() } }, { settings }, close), true);
  assert.equal(availableDispatch({ ...order, shopClock: undefined }, { settings }, close), true);
  const store = { settings, supplierProfiles: [{ userId: 'shop', schedule }] };
  // Production finishes exactly at 15:00. The next pickup is Monday, even
  // though GRIDGO's Saturday window remains open.
  assert.equal(projectShopFinish(store, { supplierId: 'shop', turnaroundHours: 2, now: '2026-10-17T04:30:00Z' }).projection.promiseBy,
    '2026-10-19T02:00:00.000Z');
  const disjoint = { ...schedule, weekdayOverrides: [{ ...saturday, opensMinute: 1080, closesMinute: 1200 }] };
  assert.equal(nextShopDispatchAt(settings, disjoint, '2026-10-17T08:00:00Z'), '2026-10-19T00:00:00.000Z');
});

test('later hours edits leave existing deadlines, acceptance, inactivity and service clocks intact', async () => {
  const store = shopStore();
  const order = { supplierId: 'shop', shopClockVersion: 1, readyBy: sat, promiseBy: '2026-10-17T08:00:00.000Z' };
  startShopAcceptance(store, order, sat);
  const before = structuredClone(order);
  const oldTiming = productionTiming(order, mon);
  await patch(store, { expectedVersion: 1, schedule: shortWeek() });
  snapshotShopClock(store, order);
  assert.deepEqual(order, before);
  assert.deepEqual(productionTiming(order, mon), oldTiming);
  assert.equal(nextNudgeDueAt(sat, null, 0, nudgePolicy, order.shopClock), '2026-10-17T07:30:15.123Z');
  const newOrder = { supplierId: 'shop', shopClockVersion: 1 };
  startShopAcceptance(store, newOrder, sat);
  assert.equal(newOrder.shopAcceptance.deadlineAt, mon);
});

test('no overrides (or an empty list) reproduce the previous calendar, estimates, calendar availability and dispatch', () => {
  const base = defaultShopSchedule();
  // Golden results checked against the pre-override calendar implementation.
  const previous = ['2026-10-19T01:30:15.123Z', '2026-10-19T08:30:15.123Z',
    '2026-10-20T02:00:00.000Z', '2026-10-20T02:00:00.000Z'];
  let index = 0;
  for (const now of [fri, sat, '2026-10-18T00:00:00Z', '2026-10-19T00:00:00Z']) {
    const next = { ...base, weekdayOverrides: [] };
    assert.equal(addOpeningMilliseconds(base, now, 12 * 3600000), previous[index++]);
    assert.equal(addOpeningMilliseconds(next, now, 12 * 3600000), addOpeningMilliseconds(base, now, 12 * 3600000));
    assert.equal(addWorkingMinutes(next, now, 720), addWorkingMinutes(base, now, 720));
    assert.deepEqual(projectFinish({ schedule: next, now, turnaroundMinutes: 120 }), projectFinish({ schedule: base, now, turnaroundMinutes: 120 }));
    const { store } = fixture(); store.supplierProfiles[0].schedule = base;
    const input = { supplierId: 'shop_a', turnaroundDays: 2, now };
    const old = projectShopFinish(store, input);
    const calendar = deadlineDays(store, { subcategoryCode: 'flyers', now, days: 5 });
    const status = shopHoursStatus(store.supplierProfiles[0], store.settings, now);
    const order = { state: 'ready_for_dispatch', fulfillmentMode: 'delivery', shopClock: { version: 1, schedule: base } };
    const dispatch = availableDispatch(order, store, now);
    store.supplierProfiles[0].schedule = next;
    assert.deepEqual(projectShopFinish(store, input), old);
    assert.deepEqual(deadlineDays(store, { subcategoryCode: 'flyers', now, days: 5 }), calendar);
    assert.equal(shopHoursStatus(store.supplierProfiles[0], store.settings, now).isOpenNow, status.isOpenNow);
    assert.equal(availableDispatch({ ...order, shopClock: { version: 1, schedule: next } }, store, now), dispatch);
  }
});

test('a dispatch-incompatible candidate cannot hide healthy matching or calendar choices, including listed rush tiers', () => {
  const { store } = fixture();
  const schedule = { ...defaultShopSchedule(), week: [{ weekday: 6, opensMinute: 480, closesMinute: 1080 }],
    weekdayOverrides: [{ weekday: 6, opensMinute: 1080, closesMinute: 1200 }] };
  store.supplierProfiles[0].schedule = schedule;
  store.catalogSpeedTiers = [{ id: 'fast', catalogItemId: 'item_shop_a', label: 'Fast', turnaroundHours: 1, priceMinor: 15000 }];
  const input = { subcategoryCode: 'flyers', now: '2026-10-17T05:00:00.000Z',
    deadline: '2026-11-30T08:00:00.000Z', ranking: ['speed', 'quality', 'cost', 'distance'] };
  assert.equal(matchShop(store, input).shop.supplierId, 'shop_b');
  assert.ok(deadlineDays(store, { ...input, days: 14 }).days.some(row => row.status === 'secured'));
  store.supplierProfiles[1].schedule = schedule;
  assert.throws(() => matchShop(store, input), { code: 'match_not_found', status: 404 });
  const calendar = deadlineDays(store, { ...input, days: 14 });
  assert.equal(calendar.earliest, null);
  assert.ok(calendar.days.every(row => row.status === 'not_possible'));
  assert.ok(calendar.days.some(row => row.reason === 'no_eligible_listing'));
});

test('ordinary and rush candidate projections skip only typed dispatch-unavailable failures', () => {
  const unavailable = new AvailabilityError(409, 'dispatch_unavailable', 'No overlap');
  assert.equal(projectMatchCandidate(() => { throw unavailable; }), null);
  const valid = { promiseBy: '2026-10-19T00:00:00.000Z' };
  assert.equal(projectMatchCandidate(() => valid), valid);
  for (const error of [new AvailabilityError(400, 'invalid_schedule', 'Invalid'),
    new AvailabilityError(409, 'shop_never_open', 'Beyond horizon'),
    new AvailabilityError(400, 'dispatch_unavailable', 'Wrong status'),
    Object.assign(new Error('Unexpected'), { status: 409, code: 'dispatch_unavailable' }), new TypeError('Unexpected')]) {
    assert.throws(() => projectMatchCandidate(() => { throw error; }), caught => caught === error);
  }
});
