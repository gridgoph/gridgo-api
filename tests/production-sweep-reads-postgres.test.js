import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadProductionSweepStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, id as uniqueId } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { syncSupplierPerformance } from '../src/supplier-performance.js';
import { assessProductionLapses } from '../src/production-penalties.js';
import { applyProductionNudges } from '../src/production-inactivity.js';

const DATABASE_URL = process.env.DATABASE_URL;
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const allDay = (supplierId) => ({ version: 1, supplierId, schedule: { utcOffsetMinutes: 480, closures: [],
  week: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opensMinute: 0, closesMinute: 1440 })) } });

function sequence() {
  let n = 0;
  return (prefix) => `${prefix}_${++n}`;
}
function instrument(database) {
  const queries = [];
  return { queries, db: { ...database, query: async (sql, values) => {
    const result = await database.query(sql, values);
    queries.push({ sql, rows: result.rowCount });
    return result;
  } } };
}

/** Orders on every branch of the three sweeps, plus orders they must never touch. */
function sweepFixture(t0) {
  const store = fixture();
  const base = store.orders.pop();
  const line = store.orderLineItems.pop();
  store.orderJobs.length = 0;
  store.settings.productionPenalty.deductionsEnabled = true;
  store.settings.productionNudge = { enabled: true, afterValue: 4, afterUnit: 'hours', repeatValue: 4, repeatUnit: 'hours', maxCount: 3 };
  const add = (id, overrides = {}) => {
    const supplierId = 'supplierId' in overrides ? overrides.supplierId : 'supplier';
    const order = { ...structuredClone(base), id, supplierId, commercialCommittedAt: iso(t0), readyBy: iso(t0 + 72 * HOUR),
      timeline: [{ at: iso(t0), state: overrides.state || 'production', by: supplierId }], createdAt: iso(t0), updatedAt: iso(t0),
      ...(supplierId ? { shopClock: allDay(supplierId) } : {}), ...overrides };
    if (!supplierId) delete order.shopClock;
    store.orders.push(order);
    return order;
  };
  add('o_nudge');
  add('o_sent');
  store.notifications.push({ id: 'sent_1', userId: 'supplier', appRole: 'supplier', type: 'shop_production_inactive',
    occurrenceKey: 'nudge:o_sent:production:1', orderId: 'o_sent', title: 'Update', body: 'Body', read: false, at: iso(t0 + 4 * HOUR) });
  add('o_proof', { supplierId: 'replacement' });
  store.files.push({ fileId: 'proof_file', ownerId: 'replacement', purpose: 'fulfilment_proof', state: 'ready', objectKey: 'private/proof',
    originalFilename: 'proof.jpg', declaredContentType: 'image/jpeg', detectedContentType: 'image/jpeg', size: 100,
    attachedAt: iso(t0 + 3 * HOUR), createdAt: iso(t0 + 3 * HOUR),
    references: [{ type: 'order', id: 'o_proof', field: 'proof', milestoneCode: 'printing' }] });
  add('o_claim');
  store.claims.push({ id: 'claim_open', orderId: 'o_claim', status: 'open', createdAt: iso(t0), updatedAt: iso(t0) });
  add('o_held', { supplierId: 'replacement', payoutHold: true });
  add('o_late', { readyBy: iso(t0 + 2 * HOUR) });
  add('o_finished', { state: 'ready_for_dispatch', readyBy: iso(t0 + 2 * HOUR), readyAt: iso(t0 + HOUR) });
  add('o_late_finished', { state: 'completed', readyBy: iso(t0 + 2 * HOUR), readyAt: iso(t0 + 5 * HOUR) });
  add('o_failure', { supplierId: null, state: 'cancelled', cancelledAt: iso(t0 + HOUR), cancelledBy: 'replacement', cancellationReason: 'Shop declined', shopFailureEvents: [{ id: 'failure_1', supplierId: 'replacement',
    kind: 'declined', stage: 'supplier_assigned', reason: 'Busy', at: iso(t0 + HOUR) }] });
  add('o_packed', { state: 'delivered', readyBy: iso(t0 + 30 * HOUR), readyAt: iso(t0 + HOUR),
    shopHandover: { arrivedPacked: [{ supplierId: 'supplier', at: iso(t0 + HOUR) }] } });
  add('o_applied', { state: 'completed', readyBy: iso(t0 + 2 * HOUR), readyAt: iso(t0 + 9 * HOUR) });
  store.productionLapses.push({ id: 'lapse_applied', orderId: 'o_applied', supplierId: 'supplier', tier: 'minor',
    deadlineAt: iso(t0 + 2 * HOUR), detectedAt: iso(t0 + 4 * HOUR), rateBps: 500, policy: { deductionsEnabled: true, minorBps: 500, moderateBps: 1500, severeBps: 3000 },
    settingsVersion: 1, warnings: [], deductionMinor: 0, remainingBalanceMinor: 0, appliedAt: iso(t0 + 5 * HOUR), closedAt: null });
  add('o_pilot', { readyBy: iso(t0 + 2 * HOUR) });
  store.orderLineItems.push({ ...structuredClone(line), id: 'line_pilot', orderId: 'o_pilot', jobId: null,
    turnaroundDaysSnapshot: null, turnaroundHoursSnapshot: 1, turnaroundMinutesSnapshot: 60, productionDayMinutesSnapshot: 600 });
  // Never candidates: no shop, or not yet committed.
  add('o_unassigned', { supplierId: null, state: 'approved_for_matching', commercialCommittedAt: null });
  add('o_uncommitted', { state: 'supplier_assigned', commercialCommittedAt: null });
  return store;
}

const byKey = (...keys) => (a, b) => keys.map(key => String(a[key] ?? '').localeCompare(String(b[key] ?? ''))).find(Boolean) || 0;

/** Every order/lapse/event fact these sweeps can change, keyed without generated ids. */
function outcome(store, orderIds) {
  const keep = (row) => orderIds.has(row.orderId);
  return {
    lapses: store.productionLapses.filter(keep).map(({ id, warnings, ...rest }) => ({ ...rest,
      warnings: warnings.map(({ tier, at, formal }) => ({ tier, at, formal })) })).sort(byKey('orderId', 'supplierId')),
    events: store.supplierPerformanceEvents.filter(keep).map(({ id, ...rest }) => rest).sort(byKey('orderId', 'supplierId', 'sourceKey')),
    orders: store.orders.filter(order => orderIds.has(order.id)).map(order => ({ id: order.id,
      performanceClock: order.performanceClock ?? null, eligible: order.productionReassignmentEligible ?? null,
      updatedAt: order.updatedAt, payoutMilestones: order.payoutMilestones })).sort(byKey('id')),
  };
}
function penalties(store, at) {
  const createId = sequence();
  const performance = syncSupplierPerformance(store, { at, id: createId });
  const lapses = assessProductionLapses(store, { at, createId });
  return { performance, lapses };
}
function nudges(store, at) {
  return applyProductionNudges(store, { at, createId: sequence(), limit: 100 })
    .map(({ userId, appRole, type, occurrenceKey, orderId, title, body }) => ({ userId, appRole, type, occurrenceKey, orderId, title, body }))
    .sort(byKey('orderId', 'userId', 'occurrenceKey'));
}

test('production sweep probes decide exactly like the complete store and never read history', { skip: !DATABASE_URL }, async t => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await resetDatabase(database, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const launch = Date.parse((await database.query('SELECT launched_at FROM supplier_performance_launch WHERE singleton')).rows[0].launched_at);
  const t0 = launch + 24 * HOUR;
  await database.transaction(() => saveStore(database, sweepFixture(t0)));
  const allIds = new Set((await loadStore(database)).orders.map(order => order.id));

  await t.test('decisions and per-order results match across the production timeline', async () => {
    // Pre-launch (legacy lapses), then performance warnings, nudges and repeats.
    const ticks = [launch - HOUR, t0 + HOUR / 2, t0 + 3.5 * HOUR, t0 + 4.5 * HOUR, t0 + 9 * HOUR, t0 + 30 * HOUR, t0 + 80 * HOUR];
    let changedTicks = 0;
    for (const tick of ticks) {
      const at = iso(tick);
      const full = await loadStore(database);
      const probe = await loadProductionSweepStore(database);
      const probeIds = new Set(probe.orders.map(order => order.id));
      assert.ok(!probeIds.has('o_unassigned') && !probeIds.has('o_uncommitted'), 'non-candidates stay out of the probe');
      const fullDecision = penalties(full, at);
      assert.deepEqual(penalties(probe, at), fullDecision, at);
      assert.deepEqual(outcome(probe, probeIds), outcome(full, probeIds), at);
      // The complete store changes nothing outside the probe's candidates.
      const outside = new Set([...allIds].filter(id => !probeIds.has(id)));
      assert.deepEqual(outcome(full, outside), outcome(await loadStore(database), outside), at);

      const fullNudges = nudges(await loadStore(database), at);
      assert.deepEqual(nudges(await loadProductionSweepStore(database), at), fullNudges, at);

      // Commit the real sweeps, as the lifecycle tick does, so later ticks see
      // saved warnings, events and reminders.
      await database.transaction(async () => {
        const store = await loadStore(database);
        const performance = syncSupplierPerformance(store, { at, id: uniqueId });
        const decided = { performance, lapses: assessProductionLapses(store, { at, createId: uniqueId }) };
        const written = applyProductionNudges(store, { at, createId: uniqueId, limit: 100 });
        if (decided.performance || decided.lapses || written.length) { changedTicks += 1; await saveStore(database, store); }
      });
      // Once committed, the same instant is a no-op: the probe keeps the lock free.
      const again = await loadProductionSweepStore(database);
      assert.deepEqual(penalties(again, at), { performance: false, lapses: false }, at);
      assert.deepEqual(nudges(again, at), [], at);
    }
    assert.ok(changedTicks >= 4, `fixture exercises real work (${changedTicks} changing ticks)`);
    const saved = await loadStore(database);
    for (const orderId of ['o_late', 'o_late_finished', 'o_pilot']) assert.ok(saved.productionLapses.some(row => row.orderId === orderId), orderId);
    for (const sourceKey of ['finish', 'failure:failure_1', 'arrived_packed']) assert.ok(saved.supplierPerformanceEvents.some(row => row.sourceKey === sourceKey), sourceKey);
    assert.ok(saved.notifications.some(row => row.type === 'shop_production_inactive' && row.orderId === 'o_nudge'));
    assert.ok(!saved.notifications.some(row => row.type === 'shop_production_inactive' && ['o_claim', 'o_held'].includes(row.orderId)));
  });

  await t.test('the sweeps read no store collection the probe leaves out', async () => {
    // A new input must be added to loadProductionSweepStore before it can change a decision.
    const loaded = new Set(['settings', 'version', 'orders', 'orderLineItems', 'productionLapses', 'supplierPerformanceEvents',
      'claims', 'refundRequests', 'refundSettlements', 'notifications', 'files', 'supplierProfiles', 'userRoleMemberships',
      'legalPenaltyGate', 'supplierPerformanceLaunchedAt', 'reviewDataReportsIncluded']);
    // Written for the complete path's save, never read for a decision.
    const appendOnly = new Set(['auditLog']);
    for (const tick of [t0 + 3 * HOUR, t0 + 9 * HOUR, t0 + 100 * HOUR]) {
      const seen = new Set();
      const store = new Proxy(await loadStore(database), {
        get(target, key, receiver) { if (typeof key === 'string') seen.add(key); return Reflect.get(target, key, receiver); },
      });
      penalties(store, iso(tick));
      nudges(store, iso(tick));
      const unexpected = [...seen].filter(key => !loaded.has(key) && !appendOnly.has(key));
      assert.deepEqual(unexpected, [], `sweeps read ${unexpected.join(', ')}`);
    }
  });

  await t.test('unrelated history growth leaves probe queries and rows unchanged', async () => {
    const measure = async () => {
      const { queries, db } = instrument(database);
      await loadProductionSweepStore(db);
      assert.ok(!queries.some(q => /FROM (audit_log|location_pings|notification_push_outbox|device_tokens)\b/.test(q.sql)));
      return { count: queries.length, rows: queries.reduce((sum, q) => sum + q.rows, 0) };
    };
    const grow = async (count) => database.transaction(async () => {
      const store = await loadStore(database);
      const start = store.auditLog.length;
      for (let i = 0; i < count; i++) {
        const at = iso(t0 + i * 1000);
        // Same supplier and order, different type: never a reminder input.
        store.notifications.push({ id: `history_${start + i}`, userId: 'supplier', appRole: 'supplier', type: 'general', orderId: 'o_nudge', title: 'Old', body: 'Old', at });
        store.auditLog.push({ id: `audit_history_${start + i}`, at, actorId: null, actorRole: 'system', action: 'history.test', entityType: 'order', entityId: 'o_nudge', orderId: 'o_nudge', detail: {} });
        store.locationPings.push({ id: `ping_history_${start + i}`, orderId: 'o_packed', riderId: 'rider', lat: 7.06, lng: 125.6, at });
      }
      await saveStore(database, store);
    });
    await grow(300);
    const before = await measure();
    await grow(2700);
    assert.deepEqual(await measure(), before, 'tenfold unrelated history');
  });
});

test('the lifecycle tick still writes due reminders, lapses and performance clocks', { skip: !DATABASE_URL }, async t => {
  const database = createDatabase({ DATABASE_URL });
  t.after(() => database.close());
  await resetDatabase(database, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = sweepFixture(Date.now() - 10 * HOUR);
  await database.transaction(() => saveStore(database, store));
  await apiForTest(t);
  let saved;
  for (let n = 0; n < 200; n++) {
    saved = await loadStore(database);
    if (saved.notifications.some(row => row.type === 'shop_production_inactive' && row.orderId === 'o_nudge')
      && saved.productionLapses.some(row => row.orderId === 'o_late')
      && saved.orders.find(row => row.id === 'o_nudge').performanceClock) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(saved.notifications.some(row => row.type === 'shop_production_inactive' && row.orderId === 'o_nudge'), 'reminder written');
  assert.ok(saved.productionLapses.some(row => row.orderId === 'o_late'), 'lapse written');
  // Work finished before the performance launch is never scored; active work adopts its clock.
  assert.equal(saved.orders.find(row => row.id === 'o_nudge').performanceClock?.supplierId, 'supplier', 'performance clock written');
  assert.ok(saved.auditLog.some(row => row.action.startsWith('production_lapse.')), 'lapse audit committed');
});
