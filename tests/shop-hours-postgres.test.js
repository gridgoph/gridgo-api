import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { defaultShopSchedule } from '../src/availability.js';
import { snapshotShopClock } from '../src/shop-hours.js';

const DATABASE_URL = process.env.DATABASE_URL;

test('PostgreSQL HTTP shop-hours writes persist atomically with audit and inbox; stale edits and wrong roles do not mutate', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture();
  initial.orders[0].readyBy = '2099-01-01T00:00:00.000Z';
  initial.orders[0].promiseBy = '2099-01-01T01:00:00.000Z';
  await db.transaction(() => saveStore(db, initial));
  const api = await apiForTest(t);
  const before = (await loadStore(db)).orders[0];
  assert.equal((await api(null, 'GET', '/me/shop-hours')).status, 401);
  assert.equal((await api('client', 'GET', '/ops/shops/hours')).status, 403);
  assert.equal((await api('replacement', 'PATCH', '/ops/shops/supplier/hours', { expectedVersion: 1, temporarilyClosed: true, reason: 'No' })).status, 403);
  const schedule = defaultShopSchedule();
  schedule.closures = [{ startDay: '2026-12-24', endDay: '2026-12-26' }];
  const result = await api('supplier', 'PATCH', '/me/shop-hours', { expectedVersion: 1, schedule });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((await api('supplier', 'GET', '/me/shop-hours')).body.hours.schedule, schedule);
  const edits = await Promise.all(['ops', 'admin'].map(actor => api(actor, 'PATCH', '/ops/shops/supplier/hours', {
    expectedVersion: 2, temporarilyClosed: true, reason: 'Weather closure',
  })));
  assert.deepEqual(edits.map(row => row.status).sort(), [200, 409]);
  assert.equal((await api('ops', 'PATCH', '/ops/shops/supplier/hours', { expectedVersion: 3, schedule, reason: 'No' })).status, 403);
  const after = await loadStore(db);
  assert.equal(after.supplierProfiles.find(row => row.userId === 'supplier').isClosed, true);
  const { performanceClock, ...afterOrder } = after.orders[0];
  const { performanceClock: priorPerformanceClock, ...beforeOrder } = before;
  assert.deepEqual(afterOrder, beforeOrder, 'hours changes must not rewrite existing order snapshots or money');
  assert.deepEqual(performanceClock, priorPerformanceClock || {
    version: 1, supplierId: 'supplier', schedule: defaultShopSchedule(),
  }, 'first adoption retains the calendar before this hours edit');
  const audits = after.auditLog.filter(row => row.action === 'supplier_hours.update');
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[0].after.schedule, schedule);
  assert.equal(audits[1].after.isClosed, true);
  assert.equal(audits[1].reason, 'Weather closure');
  for (const actor of ['supplier', 'ops', 'admin']) assert.equal(after.notifications.filter(row => row.type === 'supplier_hours_updated' && row.userId === actor).length, 2);
  await assert.rejects(db.query('DELETE FROM audit_log WHERE id=$1', [audits[0].id]), /append.only|immutable/i);
  const listed = await api('client', 'GET', '/catalog/shops');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.shops.some(row => row.supplierId === 'supplier' && row.hours.temporarilyClosed));
  const eligible = await api('ops', 'GET', '/orders/order/eligible-suppliers');
  assert.equal(eligible.body.candidates.find(row => row.supplier.id === 'supplier').eligible, false);
  const dashboard = await api('ops', 'GET', '/ops/shops/hours');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.shops.find(row => row.supplierId === 'supplier').hours.temporarilyClosed, true);
});

test('PostgreSQL preserves declared extensions and prospective order clocks across profile edits', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture();
  initial.supplierProfiles[0].schedule = { ...defaultShopSchedule(), extension: { day: '2026-10-15', opensMinute: 1080, closesMinute: 1200 } };
  initial.orders[0].shopClockVersion = 1;
  snapshotShopClock(initial, initial.orders[0]);
  await db.transaction(() => saveStore(db, initial));
  const saved = await loadStore(db);
  assert.equal(saved.supplierProfiles.find(row => row.userId === 'supplier').schedule.extension.closesMinute, 1200);
  const clock = structuredClone(saved.orders[0].shopClock);
  delete saved.supplierProfiles.find(row => row.userId === 'supplier').schedule.extension;
  await db.transaction(() => saveStore(db, saved));
  assert.deepEqual((await loadStore(db)).orders[0].shopClock, clock);
});
