import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { defaultShopSchedule } from '../src/availability.js';
import { snapshotShopClock } from '../src/shop-hours.js';
import { up } from '../migrations/1794146000000_shop_weekday_hours.js';

const DATABASE_URL = process.env.DATABASE_URL;
const override = { weekday: 6, opensMinute: 480, closesMinute: 900 };
const schedule = () => ({ ...defaultShopSchedule(), weekdayOverrides: [override] });
const incompatibleSchedule = () => ({ ...defaultShopSchedule(),
  week: [{ weekday: 6, opensMinute: 480, closesMinute: 1080 }],
  weekdayOverrides: [{ weekday: 6, opensMinute: 1080, closesMinute: 1200 }] });

test('forward migration leaves legacy schedules and orders byte-for-byte unchanged; SQL rejects invalid overrides', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await db.transaction(async () => {
    await db.query('CREATE SCHEMA weekday_hours_migration_test');
    await db.query('SET LOCAL search_path = weekday_hours_migration_test, public');
    await db.query(`CREATE TABLE supplier_profiles (schedule jsonb);
      CREATE TABLE orders (data jsonb);
      INSERT INTO supplier_profiles VALUES (NULL), ('{"week":[]}'::jsonb);
      INSERT INTO orders VALUES ('{"readyBy":"2026-10-17T08:00:00Z","shopClock":{"version":1}}'::jsonb)`);
    await db.query('INSERT INTO supplier_profiles VALUES ($1)', [defaultShopSchedule()]);
    const before = await db.query('SELECT schedule::text FROM supplier_profiles ORDER BY schedule::text NULLS FIRST');
    const orderBefore = await db.query('SELECT data::text FROM orders');
    const statements = []; await up({ sql: sql => statements.push(sql) });
    for (const sql of statements) await db.query(sql);
    assert.deepEqual((await db.query('SELECT schedule::text FROM supplier_profiles ORDER BY schedule::text NULLS FIRST')).rows, before.rows);
    assert.deepEqual((await db.query('SELECT data::text FROM orders')).rows, orderBefore.rows);
    await db.query('INSERT INTO supplier_profiles VALUES ($1)', [schedule()]);
    for (const invalid of [null, {}, [override, override], [{ ...override, weekday: 0 }],
      [{ ...override, opensMinute: 900 }], [{ ...override, closesMinute: 1441 }],
      [{ ...override, closesMinute: 1.5 }], [{ ...override, opensMinute: '480' }],
      [{ ...override, extra: true }]]) {
      await db.query('SAVEPOINT invalid_override');
      await assert.rejects(db.query('INSERT INTO supplier_profiles VALUES ($1)', [{ ...defaultShopSchedule(), weekdayOverrides: invalid }]), /supplier_weekday_overrides_check/);
      await db.query('ROLLBACK TO SAVEPOINT invalid_override');
    }
    assert.equal((await db.query('SELECT production_day_minutes($1) AS minutes', [schedule()])).rows[0].minutes, 600);
    await db.query('DROP SCHEMA weekday_hours_migration_test CASCADE');
  });
});

test('HTTP saves weekday hours, revalidates matches/calendar and gates both dispatch assignments without rewriting commitments', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture();
  initial.catalogItems.find(row => row.supplierId === 'replacement').active = false;
  initial.settings.operatingHours.sameDayPromiseAllowanceMinutes = 0;
  const order = initial.orders[0];
  order.state = 'ready_for_dispatch'; order.shopClockVersion = 1;
  order.readyBy = '2099-01-01T00:00:00.000Z'; order.promiseBy = '2099-01-01T01:00:00.000Z';
  snapshotShopClock(initial, order);
  initial.orderJobs[0].state = 'ready_for_dispatch';
  // This new work was accepted with the shorter Saturday; the earlier order
  // above keeps its own full-day calendar and existing commitment.
  initial.orders.push({ ...structuredClone(order), id: 'new_order',
    estimatedHours: 1 / 60,
    shopClock: { ...structuredClone(order.shopClock), schedule: schedule() } });
  await db.transaction(() => saveStore(db, initial));
  const before = (await loadStore(db)).orders.find(row => row.id === 'order');
  const scratch = await mkdtemp(join(tmpdir(), 'gridgo-weekday-http-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const timePath = join(scratch, 'time'), preload = join(scratch, 'clock.mjs');
  await writeFile(timePath, '2026-10-17T05:00:00.000Z'); // Saturday 13:00 Manila
  // Freeze domain new Date() calls only. Date.now remains real for JWT expiry,
  // networking and process timers. No test clock is added to the application.
  await writeFile(preload, `import { readFileSync } from 'node:fs';
    const OriginalDate = Date;
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [readFileSync(${JSON.stringify(timePath)}, 'utf8')])); }
    };`);
  const api = await apiForTest(t, { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload)}`,
    ...(process.env.GRIDGO_WEEKDAY_E2E_MINIO ? { MINIO_ENDPOINT: process.env.GRIDGO_WEEKDAY_E2E_MINIO,
      MINIO_PUBLIC_URL: process.env.GRIDGO_WEEKDAY_E2E_MINIO, MINIO_ACCESS_KEY: 'weekday-test',
      MINIO_SECRET_KEY: 'weekday-test-secret', MINIO_BUCKET: 'weekday-test' } : {}) });
  const matchBody = { subcategoryCode: 'flyers', fulfillmentMode: 'pickup', deadline: '2026-10-17T08:00:00.000Z' };
  // Remove unrelated queue pressure to exercise the 2-hour listing boundary.
  await db.query('UPDATE order_jobs SET estimated_production_minutes=1 WHERE id=$1', ['job']);
  const baseline = await api('client', 'POST', '/me/matches', matchBody);
  assert.equal(baseline.status, 200, JSON.stringify(baseline.body));
  const saved = await api('supplier', 'PATCH', '/me/shop-hours', { expectedVersion: 1, schedule: schedule() });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = await api('supplier', 'GET', '/me/shop-hours');
  assert.deepEqual(read.body.hours.schedule.weekdayOverrides, [override]);
  assert.equal((await api('supplier', 'PATCH', '/me/shop-hours', { expectedVersion: 1, schedule: schedule() })).status, 409);
  assert.equal((await api('ops', 'PATCH', '/ops/shops/supplier/hours', { expectedVersion: 2, schedule: schedule(), reason: 'No' })).status, 403);
  const missed = await api('client', 'POST', '/me/matches', matchBody);
  assert.equal(missed.status, 409, JSON.stringify(missed.body));
  assert.equal(missed.body.error, 'deadline_not_met');
  const calendar = await api('client', 'GET', '/me/deadline-days?subcategoryCode=flyers&days=3');
  assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
  assert.equal(calendar.body.days[0].status, 'not_possible');
  assert.equal(calendar.body.days[2].status, 'secured');
  await writeFile(timePath, '2026-10-17T07:00:00.000Z'); // Saturday close
  const offers = await api('rider', 'GET', '/dispatch/offers');
  assert.equal(offers.status, 200, JSON.stringify(offers.body));
  assert.ok(offers.body.offers.some(row => row.id === 'order'), 'prior full-day commitment stays offerable');
  assert.ok(!offers.body.offers.some(row => row.id === 'new_order'));
  const accept = await api('rider', 'POST', '/dispatch/new_order/accept', {});
  assert.equal(accept.status, 409, JSON.stringify(accept.body));
  assert.equal(accept.body.error, 'outside_shop_hours');
  assert.equal(accept.body.nextDispatchAt, '2026-10-19T00:00:00.000Z');
  const assign = await api('ops', 'POST', '/orders/new_order/transition', { state: 'rider_assigned', riderId: 'rider' });
  assert.equal(assign.status, 409, JSON.stringify(assign.body));
  assert.equal(assign.body.error, 'outside_shop_hours');
  const after = await loadStore(db);
  const { performanceClock, ...afterOrder } = after.orders.find(row => row.id === 'order');
  const { performanceClock: oldPerformanceClock, ...beforeOrder } = before;
  assert.deepEqual(afterOrder, beforeOrder);
  assert.deepEqual(performanceClock, oldPerformanceClock);
  assert.equal(after.auditLog.filter(row => row.action === 'supplier_hours.update').length, 1);
  for (const userId of ['supplier', 'ops', 'admin']) assert.equal(after.notifications.filter(row => row.type === 'supplier_hours_updated' && row.userId === userId).length, 1);
  await writeFile(timePath, '2026-10-19T00:00:00.000Z');
  const opened = await api('rider', 'POST', '/dispatch/new_order/accept', {});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.order.state, 'rider_assigned');
});

for (const allIncompatible of [false, true]) test(`HTTP isolates ${allIncompatible ? 'all incompatible shops with the usual empty result' : 'an incompatible shop from its healthy alternative'}`, { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture();
  initial.orders[0].readyBy = '2099-01-01T00:00:00.000Z';
  initial.orders[0].promiseBy = '2099-01-01T01:00:00.000Z';
  initial.catalogSpeedTiers = ['supplier', 'replacement'].map(supplierId => ({ id: `fast_${supplierId}`,
    catalogItemId: `item_${supplierId}`, label: 'Fast', turnaroundMinutes: 60, turnaroundHours: 1,
    priceMinor: 1500, surchargeMinor: null, sortOrder: 0, createdAt: initial.orders[0].createdAt,
    updatedAt: initial.orders[0].createdAt }));
  await db.transaction(() => saveStore(db, initial));
  const api = await apiForTest(t, process.env.GRIDGO_WEEKDAY_E2E_MINIO ? {
    MINIO_ENDPOINT: process.env.GRIDGO_WEEKDAY_E2E_MINIO, MINIO_PUBLIC_URL: process.env.GRIDGO_WEEKDAY_E2E_MINIO,
    MINIO_ACCESS_KEY: 'weekday-test', MINIO_SECRET_KEY: 'weekday-test-secret', MINIO_BUCKET: 'weekday-test',
  } : {});
  for (const supplierId of allIncompatible ? ['supplier', 'replacement'] : ['supplier']) {
    const saved = await api(supplierId, 'PATCH', '/me/shop-hours', { expectedVersion: 1, schedule: incompatibleSchedule() });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const matched = await api('client', 'POST', '/me/matches', { subcategoryCode: 'flyers', fulfillmentMode: 'pickup',
    deadline: new Date(Date.now() + 30 * 86400000).toISOString() });
  if (allIncompatible) {
    assert.equal(matched.status, 404, JSON.stringify(matched.body));
    assert.equal(matched.body.error, 'match_not_found');
  } else {
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(matched.body.shop.supplierId, 'replacement');
    assert.ok(matched.body.listings.every(row => row.supplierId === 'replacement'));
    assert.equal(matched.body.alternativesCount, 0);
  }
  const calendar = await api('client', 'GET', '/me/deadline-days?subcategoryCode=flyers&days=14');
  assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
  if (allIncompatible) {
    assert.equal(calendar.body.earliest, null);
    assert.ok(calendar.body.days.every(row => row.status === 'not_possible'));
    assert.ok(calendar.body.days.some(row => row.reason === 'no_eligible_listing'));
  } else {
    assert.equal(calendar.body.days.find(row => row.status === 'secured')?.readyBy, matched.body.listings[0].readyBy);
    assert.ok(Date.parse(calendar.body.earliest) <= Date.parse(matched.body.listings[0].readyBy));
  }
});
