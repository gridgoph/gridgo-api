import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { syncSupplierPerformance } from '../src/supplier-performance.js';
import { assessProductionLapses } from '../src/production-penalties.js';
const DATABASE_URL = process.env.DATABASE_URL;

test('Performance HTTP roles, durable warnings, no-fault, replay, money safety and transaction rollback', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture(), order = initial.orders[0];
  const at = new Date().toISOString();
  order.readyBy = new Date(Date.parse(at) - 2 * 3600000).toISOString();
  order.readyAt = at; order.state = 'ready_for_dispatch';
  order.shopClock = { version: 1, supplierId: 'supplier', schedule: { utcOffsetMinutes: 480, closures: [],
    week: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opensMinute: 0, closesMinute: 1440 })) } };
  initial.settings.productionPenalty.deductionsEnabled = true;
  const stages = structuredClone(order.payoutMilestones);
  await db.transaction(() => saveStore(db, initial));
  const collect = async (rollback = false) => db.transaction(async () => {
    const store = await loadStore(db);
    syncSupplierPerformance(store, { at, id });
    assessProductionLapses(store, { at, createId: id });
    await saveStore(db, store);
    if (rollback) throw new Error('Rollback performance');
  });
  await assert.rejects(collect(true), /Rollback performance/);
  assert.equal((await loadStore(db)).supplierPerformanceEvents.length, 0);
  assert.equal((await loadStore(db)).notifications.length, 0);
  await Promise.all([collect(), collect()]);
  let saved = await loadStore(db);
  assert.equal(saved.supplierPerformanceEvents.length, 1);
  const event = saved.supplierPerformanceEvents[0];
  assert.equal(event.kind, 'late_finish');
  for (const userId of ['supplier', 'ops', 'admin']) assert.equal(saved.notifications.filter(row => row.userId === userId && row.type === 'supplier_performance_notice').length, 1);
  assert.equal(saved.auditLog.filter(row => row.action === 'supplier_performance.late_finish').length, 1);
  assert.deepEqual(saved.orders[0].payoutMilestones, stages);
  await assert.rejects(db.query('UPDATE supplier_performance_events SET data=$1 WHERE id=$2', [{}, event.id]), /append-only/);
  await assert.rejects(db.query('DELETE FROM supplier_performance_events WHERE id=$1', [event.id]), /append-only/);
  const api = await apiForTest(t);
  assert.equal((await api(null, 'GET', '/me/performance')).status, 401);
  for (const actor of ['client', 'rider', 'ops']) assert.equal((await api(actor, 'GET', '/me/performance')).status, 403);
  for (const actor of ['client', 'rider', 'supplier']) assert.equal((await api(actor, 'GET', '/ops/shops/supplier/performance')).status, 403);
  assert.equal((await api('ops', 'GET', '/ops/shops/missing/performance')).status, 404);
  const own = await api('supplier', 'GET', '/me/performance');
  assert.equal(own.status, 200);
  assert.equal(own.body.performance.notices[0].hoursLate, 2);
  assert.equal(own.body.performance.counts.lateFinishes, 1);
  assert.match(own.headers.get('cache-control'), /no-store/);
  for (const actor of ['ops', 'admin']) {
    const staff = await api(actor, 'GET', '/ops/shops/supplier/performance');
    assert.deepEqual(staff.body.performance.notices, own.body.performance.notices);
    assert.equal((await api(actor, 'GET', '/ops/shops/performance')).body.shops.length, 2);
  }
  assert.equal((await api('replacement', 'GET', '/me/performance')).body.performance.events.length, 0);
  assert.equal((await api('ops', 'POST', '/orders/order/performance-no-fault', { reason: 'Weather' })).status, 403);
  const noFault = await api('admin', 'POST', '/orders/order/performance-no-fault', { reason: 'Weather' });
  assert.equal(noFault.status, 200, JSON.stringify(noFault.body));
  assert.equal(noFault.body.performance.counts.lateFinishes, 0);
  assert.equal(noFault.body.performance.notices[0].exempt, true);
  assert.equal((await api('admin', 'POST', '/orders/order/performance-no-fault', { reason: 'Other' })).status, 200);
  saved = await loadStore(db);
  assert.equal(saved.supplierPerformanceEvents.filter(row => row.kind === 'no_fault').length, 1);
  assert.equal(saved.supplierPerformanceEvents.find(row => row.kind === 'no_fault').reason, 'Weather');
  assert.deepEqual(saved.orders[0].payoutMilestones, stages);
  assert.equal(saved.productionLapses[0].deductionMinor, 0);
  assert.equal(saved.settings.productionPenalty.deductionsEnabled, true, 'no setting mutation');
  for (const actor of ['client', 'supplier', 'ops', 'admin']) {
    const response = await api(actor, 'GET', '/orders/order');
    assert.equal(response.status, 200);
    assert.equal(response.body.order.performanceClock, undefined);
  }
});
