import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultShopSchedule, addOpeningMilliseconds, isOpenAt } from '../src/availability.js';
import { routeSupplierCatalog } from '../src/catalog-routes.js';
import { defaultOperatingHours } from '../src/operating-hours.js';
import { startShopAcceptance } from '../src/shop-recovery.js';
import { productionTiming, assessProductionLapses } from '../src/production-penalties.js';
import { projectShopFinish } from '../src/order-match.js';
import { productionDayMinutes } from '../src/production-days.js';

const at = '2026-10-15T09:00:00.000Z'; // Thursday 17:00 Manila
const fixture = () => ({ settings: { operatingHours: defaultOperatingHours(), promiseAllowanceMinutes: 60 },
  supplierProfiles: [{ userId: 'shop', shopName: 'Shop', version: 1, schedule: defaultShopSchedule() }],
  users: [], notifications: [], auditLog: [], supplierServices: [], orderJobs: [],
  userRoleMemberships: [{ userId: 'ops', role: 'ops_admin' }, { userId: 'super', role: 'super_admin' }] });
async function route(store, body, { role = 'supplier', path = '/me/shop-hours', method = 'PATCH', now = at } = {}) {
  return routeSupplierCatalog({ store, user: { id: role === 'supplier' ? 'shop' : role, role },
    req: { method, headers: {} }, url: new URL(path, 'http://test'), readBody: async () => body,
    now: () => now, id: prefix => `${prefix}_${Math.random()}`, audit: (s, entry) => s.auditLog.push(entry) });
}

test('same-day extension adds production time without changing the base working-day divisor', () => {
  const schedule = { ...defaultShopSchedule(), extension: { day: '2026-10-15', opensMinute: 1080, closesMinute: 1200 } };
  assert.equal(isOpenAt(schedule, '2026-10-15T11:00:00.000Z'), true);
  assert.equal(addOpeningMilliseconds(schedule, at, 3 * 3600000), '2026-10-15T12:00:00.000Z');
  assert.equal(isOpenAt(schedule, '2026-10-16T11:00:00.000Z'), false);
  assert.equal(productionDayMinutes(schedule), 600);
});

test('shop hours writes validate notice, dates, equal base days, and version before publishing audited changes', async () => {
  const store = fixture();
  const result = await route(store, { expectedVersion: 1, extension: { closesMinute: 1200 } });
  assert.equal(result?.status, 200);
  assert.equal(result.body.hours.todayExtension.closesMinute, 1200);
  assert.equal(result.body.hours.dispatchNotice, 'review_and_dispatch_in_next_working_window');
  assert.equal(store.auditLog.length, 1);
  assert.equal(store.notifications.length, 3);
  await assert.rejects(route(store, { expectedVersion: 1, temporarilyClosed: true }), { code: 'supplier_profile_stale' });
  for (const extension of [{ closesMinute: 1090 }, { closesMinute: 1440 }, { day: '2026-10-16', closesMinute: 1200 }]) {
    await assert.rejects(route(store, { expectedVersion: 2, extension }, { now: '2026-10-15T10:50:00.000Z' }), { code: 'invalid_shop_extension' });
  }
  const schedule = defaultShopSchedule(); schedule.week[5].closesMinute = 720;
  await assert.rejects(route(store, { expectedVersion: 2, schedule }), { code: 'production_day_length_unavailable' });
  schedule.week[5].closesMinute = 1080; schedule.closures = [{ startDay: '2026-02-30', endDay: '2026-03-01' }];
  await assert.rejects(route(store, { expectedVersion: 2, schedule }), { code: 'invalid_shop_hours' });
  assert.equal(store.supplierProfiles[0].version, 2);
});

test('staff can read hours and audit temporary closure; other roles cannot write them', async () => {
  const store = fixture();
  const closed = await route(store, { expectedVersion: 1, temporarilyClosed: true, reason: 'Flooding' }, { role: 'ops_admin', path: '/ops/shops/shop/hours' });
  assert.equal(closed?.body.hours.temporarilyClosed, true);
  assert.equal(closed.body.hours.isOpenNow, false);
  assert.equal(closed.body.hours.nextOpeningAt, null);
  assert.equal(store.supplierProfiles[0].isClosed, true);
  assert.equal(store.auditLog[0].reason, 'Flooding');
  await assert.rejects(route(store, { expectedVersion: 2, temporarilyClosed: false }, { role: 'client' }), { code: 'forbidden' });
  await assert.rejects(route(store, { expectedVersion: 2, schedule: defaultShopSchedule(), reason: 'Change' }, { role: 'ops_admin', path: '/ops/shops/shop/hours' }), { code: 'forbidden' });
});

test('prospective acceptance and lateness use shop hours, while older platform clocks and applied penalties stay unchanged', () => {
  const store = fixture();
  const clock = { version: 1, schedule: defaultOperatingHours().schedule };
  const order = { supplierId: 'shop', shopClockVersion: 1, operatingClock: clock, readyBy: at };
  startShopAcceptance(store, order, at);
  assert.equal(order.shopAcceptance.deadlineAt, '2026-10-15T10:00:00.000Z');
  assert.equal(productionTiming(order, '2026-10-16T00:00:00.000Z').elapsedMs, 3600000);
  store.supplierProfiles[0].schedule.week[3].closesMinute = 1020;
  assert.equal(productionTiming(order, '2026-10-16T00:00:00.000Z').elapsedMs, 3600000);
  const old = { supplierId: 'shop', operatingClock: clock };
  startShopAcceptance(store, old, at);
  assert.equal(old.shopAcceptance.deadlineAt, '2026-10-16T01:00:00.000Z');
  order.id = 'order'; order.commercialCommittedAt = at; order.state = 'production';
  store.orders = [order]; store.productionLapses = [{ orderId: 'order', supplierId: 'shop', appliedAt: at, deductionMinor: 500 }];
  const before = structuredClone(store);
  assert.equal(assessProductionLapses(store, { at: '2026-10-20T00:00:00.000Z', createId: () => 'unused' }), false);
  assert.deepEqual(store, before);
});

test('one formula consumes review, extended shop hours, then next platform delivery window', () => {
  const store = fixture();
  store.supplierProfiles[0].schedule.extension = { day: '2026-10-15', opensMinute: 1080, closesMinute: 1200 };
  const { projection } = projectShopFinish(store, { supplierId: 'shop', turnaroundHours: 3, now: '2026-10-15T07:00:00.000Z' });
  assert.equal(projection.readyBy, '2026-10-15T10:30:00.000Z');
  assert.equal(projection.promiseBy, '2026-10-16T01:00:00.000Z');
});

import { fixture as catalogFixture } from './fixtures/reschedule.js';
import { publicSupplierShop, publicSupplierShops } from '../src/supplier-catalog.js';
import { publicOrderFor } from '../src/operational-model.js';
import { nextNudgeDueAt } from '../src/production-inactivity.js';

test('closed shops remain in the catalog with hours while ready-early reveals no internal deadline or clock', () => {
  const store = catalogFixture();
  store.supplierProfiles[0].isClosed = true;
  const shop = publicSupplierShop(store, 'supplier');
  assert.equal(shop?.hours?.temporarilyClosed, true);
  assert.equal(shop.hours.nextOpeningAt, null);
  assert.ok(publicSupplierShops(store).shops.some(row => row.supplierId === 'supplier' && row.hours.temporarilyClosed));
  const order = store.orders[0];
  order.shopClockVersion = 1; order.shopClock = { version: 1, schedule: defaultShopSchedule() };
  order.readyAt = '2026-10-09T00:00:00.000Z'; order.state = 'ready_for_dispatch';
  const client = publicOrderFor(order, { id: 'client', role: 'client' }, store);
  assert.equal(client.readyEarly, true);
  assert.equal(client.readyLabel, 'Ready early');
  assert.equal(client.shopClock, undefined);
  assert.equal(client.shopClockVersion, undefined);
  assert.notEqual(client.readyBy, order.readyBy);
});

test('extensions respect dated closures, exact 30-minute notice, and a declaration after closing never credits the gap', async () => {
  const store = fixture();
  const result = await route(store, { expectedVersion: 1, extension: { closesMinute: 1170 } }, { now: '2026-10-15T11:00:00.000Z' });
  assert.equal(result.status, 200);
  const schedule = store.supplierProfiles[0].schedule;
  assert.equal(isOpenAt(schedule, '2026-10-15T10:30:00.000Z'), false);
  assert.equal(addOpeningMilliseconds(schedule, '2026-10-15T09:30:00.000Z', 3600000), '2026-10-15T11:30:00.000Z');
  const policy = { enabled: true, afterMs: 3600000, everyMs: 3600000, maxCount: 3 };
  const clock = { version: 1, schedule };
  assert.equal(nextNudgeDueAt('2026-10-15T09:30:00.000Z', null, 0, policy, clock), '2026-10-15T11:30:00.000Z');
  schedule.closures = [{ startDay: '2026-10-15', endDay: '2026-10-16' }];
  assert.equal(isOpenAt(schedule, '2026-10-15T11:15:00.000Z'), false);
  assert.equal(addOpeningMilliseconds(schedule, at, 3600000), '2026-10-17T01:00:00.000Z');
  await assert.rejects(route(store, { expectedVersion: 2, extension: { closesMinute: 1200 } }), { code: 'invalid_shop_extension' });
});

test('extensions expire by date and cannot be declared on a closed weekday; split and overnight base windows stay disabled', async () => {
  const store = fixture();
  for (const week of [[{ weekday: 1, opensMinute: 480, closesMinute: 720 }, { weekday: 1, opensMinute: 780, closesMinute: 1140 }],
    [{ weekday: 1, opensMinute: 1200, closesMinute: 120 }]]) {
    await assert.rejects(route(store, { expectedVersion: 1, schedule: { utcOffsetMinutes: 480, week, closures: [] } }), { code: 'invalid_shop_hours' });
  }
  await assert.rejects(route(store, { expectedVersion: 1, extension: { closesMinute: 1200 } }, { now: '2026-10-18T09:00:00.000Z' }), { code: 'invalid_shop_extension' });
  await route(store, { expectedVersion: 1, extension: { closesMinute: 1200 } });
  const tomorrow = await route(store, null, { method: 'GET', now: '2026-10-16T11:00:00.000Z' });
  assert.equal(tomorrow.body.hours.todayExtension, null);
  assert.equal(tomorrow.body.hours.isOpenNow, false);
  assert.equal(tomorrow.body.hours.nextOpeningAt, '2026-10-17T00:00:00.000Z');
});

import { validateShopSchedule } from '../src/availability.js';
import { validateOperatingHours } from '../src/operating-hours.js';
import { onTimeRate } from '../src/order-match.js';

test('extensions cannot corrupt calendar walks or alter the separate GRIDGO calendar', () => {
  for (const extension of [{ day: '2026-02-30', opensMinute: 1080, closesMinute: 1200 },
    { day: '2026-10-15', opensMinute: 1080, closesMinute: 999999 },
    { day: '2026-10-15', opensMinute: 1200, closesMinute: 1080 }]) {
    assert.throws(() => validateShopSchedule({ ...defaultShopSchedule(), extension }), { code: 'invalid_schedule' });
  }
  const policy = defaultOperatingHours();
  policy.schedule.extension = { day: '2026-10-15', opensMinute: 1020, closesMinute: 1200 };
  assert.throws(() => validateOperatingHours(policy), { code: 'invalid_operating_hours' });
});

test('on-time quality uses the prospective shop clock for out-of-hours completion', () => {
  const order = { supplierId: 'shop', readyBy: '2026-10-17T10:00:00.000Z', readyAt: '2026-10-18T02:00:00.000Z',
    shopClock: { version: 1, schedule: defaultShopSchedule() } };
  assert.equal(onTimeRate({ orders: [order] }, 'shop').rate, 1);
  delete order.shopClock;
  assert.equal(onTimeRate({ orders: [order] }, 'shop').rate, 0, 'legacy quality remains unchanged');
});

import { resolveAuthorizationContext } from '../src/authorization-context.js';
test('shop-hours authorization follows memberships, not the legacy role column', async () => {
  const store = fixture();
  store.userRoleMemberships.push({ userId: 'shop', role: 'supplier' });
  const actor = { id: 'shop', role: 'client' };
  resolveAuthorizationContext(store, actor);
  const args = { store, user: actor, req: { method: 'PATCH', headers: {} }, url: new URL('http://test/me/shop-hours'),
    readBody: async () => ({ expectedVersion: 1, temporarilyClosed: true }), now: () => at,
    id: prefix => `${prefix}_${Math.random()}`, audit: (s, entry) => s.auditLog.push(entry) };
  assert.equal((await routeSupplierCatalog(args)).status, 200);
  assert.equal(store.auditLog[0].actor.role, 'supplier');
  store.userRoleMemberships = [];
  actor.role = 'supplier';
  resolveAuthorizationContext(store, actor);
  await assert.rejects(routeSupplierCatalog(args), { code: 'forbidden' });
});
