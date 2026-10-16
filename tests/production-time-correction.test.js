import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planProductionTimeCorrection, applyProductionTimeCorrection } from '../src/production-time-correction.js';

const deployedAt = '2026-10-07T05:00:00.000Z';
const at = '2026-10-14T05:00:00.000Z';
const oldAt = '2026-10-06T00:00:00.000Z';
function fixture() {
  return { supplierProfiles: [{ userId: 'shop', shopName: 'Shop' }],
    users: [{ id: 'client', accountType: 'individual' }], supplierServices: [], catalogSpeedTiers: [], listingStarters: [],
    catalogItems: [{ id: 'item', supplierId: 'shop', turnaroundMode: 'override', turnaroundDays: 1,
      turnaroundMinutes: 600, turnaroundHours: 10, createdAt: oldAt, updatedAt: oldAt, version: 1 }],
    orderLineItems: [
      { id: 'old', sourceCatalogItemId: 'item', turnaroundHoursSnapshot: 1, createdAt: oldAt },
      { id: 'line', orderId: 'order', jobId: 'job', sourceCatalogItemId: 'item', turnaroundDaysSnapshot: 1,
        productionDayMinutesSnapshot: 600, turnaroundHoursSnapshot: 10, createdAt: '2026-10-08T00:00:00.000Z' }],
    orders: [{ id: 'order', reference: 'GG-123', clientId: 'client', supplierId: 'shop', state: 'initial_payment_review',
      readyBy: '2026-10-09T01:00:00.000Z', promiseBy: '2026-10-09T02:00:00.000Z',
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' }],
    orderJobs: [{ id: 'job', orderId: 'order', supplierId: 'shop', state: 'needs_qa', estimatedHours: 10, estimatedProductionMinutes: 600 }],
    auditLog: [] };
}
function manifestFor(plan) {
  return [{ orderId: 'order', expectedBasisHash: plan.orders[0].basisHash,
    readyBy: '2026-10-08T02:00:00.000Z', promiseBy: '2026-10-08T03:00:00.000Z',
    schedulingBasis: 'Shop reviewed calendar, queue, capacity and platform allowance; 01:00 start plus 60 minutes.',
    reviewedBy: 'operator', reviewedAt: at, noScheduledOrStartedConflict: true }];
}

test('latest pre-deploy evidence produces a dry plan; reviewed correction preserves snapshots and is idempotent', () => {
  const store = fixture(), before = structuredClone(store);
  const preview = planProductionTimeCorrection(store, { deployedAt });
  assert.deepEqual(store, before);
  assert.equal(preview.durations[0].correctedMinutes, 60);
  assert.equal(preview.orders[0].status, 'needs_manifest');
  const plan = planProductionTimeCorrection(store, { deployedAt, manifest: manifestFor(preview) });
  assert.equal(plan.orders[0].status, 'ready');
  applyProductionTimeCorrection(store, plan, { at });
  assert.equal(store.catalogItems[0].turnaroundHours, 1);
  assert.equal(store.orderJobs[0].estimatedProductionMinutes, 60);
  assert.equal(store.orders[0].readyBy, '2026-10-08T02:00:00.000Z');
  assert.deepEqual(store.orderLineItems, before.orderLineItems);
  assert.equal(store.auditLog.length, 2);
  const again = planProductionTimeCorrection(store, { deployedAt });
  applyProductionTimeCorrection(store, again, { at });
  assert.equal(store.auditLog.length, 2);
});

test('backup evidence takes precedence, and missing evidence never guesses', () => {
  const store = fixture();
  const backup = { capturedAt: oldAt, sources: [{ kind: 'catalogItems', id: 'item', prefix: 'turnaround', hours: 2 }] };
  assert.equal(planProductionTimeCorrection(store, { deployedAt, backup }).durations[0].correctedMinutes, 120);
  store.orderLineItems.shift();
  const missing = planProductionTimeCorrection(store, { deployedAt });
  assert.equal(missing.durations[0].status, 'missing_evidence');
  assert.equal(missing.orders[0].status, 'missing_evidence');
  applyProductionTimeCorrection(store, missing, { at });
  assert.equal(store.auditLog.length, 0);
});

test('started, scheduled, finished and stale-reviewed orders are never silently rewritten', () => {
  for (const kind of ['started', 'scheduled', 'finished', 'stale']) {
    const store = fixture();
    const preview = planProductionTimeCorrection(store, { deployedAt });
    const manifest = manifestFor(preview);
    if (kind === 'started') store.orders[0].state = 'production';
    if (kind === 'scheduled') store.orderJobs[0].scheduledFor = at;
    if (kind === 'finished') store.orders[0].readyAt = at;
    if (kind === 'stale') store.orders[0].updatedAt = at;
    const plan = planProductionTimeCorrection(store, { deployedAt, manifest });
    assert.notEqual(plan.orders[0].status, 'ready', kind);
    const before = structuredClone(store.orders[0]);
    applyProductionTimeCorrection(store, plan, { at });
    assert.deepEqual(store.orders[0], before);
  }
});

import { createDatabase } from '../src/database.js';
import { emptyStore, loadStore, saveStore } from '../src/postgres-store.js';
import { runProductionTimeCorrection, readProductionTimeBackup } from '../src/production-time-correction-runner.js';

test('PostgreSQL correction dry-run, audited apply, reload and rerun preserve immutable order lines', { skip: !process.env.DATABASE_URL }, async t => {
  const database = createDatabase();
  t.after(() => database.close());
  // A rollback-only transaction isolates this fixture from other focused cases.
  await database.transaction(async () => {
    await resetDatabase(database, 'TRUNCATE users, platform_settings, taxonomy_categories, listing_starters CASCADE');
    const sample = fixture();
    const store = { ...emptyStore(), ...sample };
    store.users = [
      { id: 'client', role: 'client', accountType: 'individual', clerkUserId: 'clerk_client214', email: 'client214@example.test', name: 'Client', createdAt: oldAt },
      { id: 'shop', role: 'supplier', verificationStatus: 'approved', clerkUserId: 'clerk_shop214', email: 'shop214@example.test', name: 'Shop', createdAt: oldAt },
      { id: 'ops', role: 'ops_admin', clerkUserId: 'clerk_ops214', email: 'ops214@example.test', name: 'Ops', createdAt: oldAt },
      { id: 'admin', role: 'super_admin', clerkUserId: 'clerk_admin214', email: 'admin214@example.test', name: 'Admin', createdAt: oldAt },
    ];
    store.userRoleMemberships = store.users.map(user => ({ userId: user.id, role: user.role, createdAt: oldAt }));
    store.taxonomy = { categories: [{ id: 'cat', code: 'marketing', name: 'Marketing', active: true, sortOrder: 1 }],
      subcategories: [{ id: 'sub', code: 'banner', name: 'Banner', categoryCode: 'marketing', active: true, sortOrder: 1 }],
      categoryAliases: [], materials: [], finishes: [] };
    store.supplierServices = [{ id: 'service', supplierId: 'shop', categoryCode: 'marketing', state: 'live',
      turnaroundHours: 10, turnaroundDays: 1, turnaroundMinutes: 600, referenceRateMinor: 1000, version: 1, createdAt: oldAt, updatedAt: oldAt }];
    Object.assign(store.supplierProfiles[0], { contactName: 'Shop', shop: { lat: 7, lng: 125, label: 'Shop' }, version: 1, updatedAt: oldAt });
    Object.assign(store.catalogItems[0], { supplierServiceId: 'service', subcategoryCode: 'banner', name: 'Banner',
      basePriceMinor: 1000, sortOrder: 0, active: true });
    const orderMoney = { subtotalMinor: 1000, supplierSubtotalMinor: 1000, totalMinor: 1100,
      serviceFeeMinor: 100, serviceFeeRateBps: 1000, deliveryFeeMinor: 0, moneyModelVersion: 2, fulfillmentMode: 'delivery',
      payments: {}, payoutMilestones: [], paymentAllocations: [] };
    Object.assign(store.orders[0], orderMoney);
    store.orders.push({ ...store.orders[0], id: 'historic_order', state: 'completed', createdAt: oldAt, updatedAt: oldAt });
    Object.assign(store.orderJobs[0], { pickup: { lat: 7, lng: 125, label: 'Shop' }, dropoff: { lat: 7.1, lng: 125.1, label: 'Client' }, fulfillmentMode: 'delivery', supplierSubtotalMinor: 1000,
      deliveryFeeMinor: 0, deliveryDistanceMeters: 0, createdAt: store.orders[0].createdAt, updatedAt: store.orders[0].updatedAt });
    Object.assign(store.orderLineItems[0], { orderId: 'historic_order' });
    for (const line of store.orderLineItems) Object.assign(line, { sourceSupplierServiceId: 'service', itemNameSnapshot: 'Banner',
      pricingBasisSnapshot: 'per_unit', baseUnitPriceMinor: 1000, effectiveUnitPriceMinor: 1000, quantity: 1,
      lineSubtotalMinor: 1000, acceptedFormatCodesSnapshot: ['pdf'], sortOrder: 0, snapshotFinalized: true });
    await saveStore(database, store);
    const snapshots = (await database.query('SELECT * FROM order_line_items ORDER BY id')).rows;
    const baseline = (await database.query('SELECT data FROM orders WHERE id=$1', ['order'])).rows;
    const preview = await runProductionTimeCorrection(database, { deployedAt });
    assert.equal(preview.dryRun, true);
    assert.deepEqual((await database.query('SELECT data FROM orders WHERE id=$1', ['order'])).rows, baseline);
    assert.equal((await database.query('SELECT count(*)::integer AS n FROM audit_log')).rows[0].n, 0);
    const backup = await readProductionTimeBackup(database, oldAt);
    assert.equal(backup.sources.find(row => row.kind === 'catalogItems' && row.prefix === 'turnaround').hours, 10);
    const manifest = manifestFor(preview);
    const applied = await runProductionTimeCorrection(database, { deployedAt, manifest, apply: true, at });
    assert.equal(applied.orders.find(row => row.orderId === 'order').status, 'ready');
    const reloaded = await loadStore(database);
    assert.equal(reloaded.catalogItems[0].turnaroundMinutes, 60);
    assert.equal(reloaded.orderJobs[0].estimatedProductionMinutes, 60);
    assert.equal(reloaded.orders.find(row => row.id === 'order').productionTimeCorrection.penaltyExempt, true);
    assert.deepEqual((await database.query('SELECT * FROM order_line_items ORDER BY id')).rows, snapshots);
    assert.equal(reloaded.auditLog.length, 2);
    assert.equal(reloaded.notifications.length, 4, 'each correction reaches Operations and Super Admin');
    await runProductionTimeCorrection(database, { deployedAt, manifest, apply: true, at });
    assert.equal((await database.query('SELECT count(*)::integer AS n FROM audit_log')).rows[0].n, 2);
    database.markRollback();
  });
});

test('backup recovery handles service defaults, rush, speed tiers, starters and approved snapshots independently', () => {
  const store = fixture();
  store.supplierServices.push({ id: 'service', supplierId: 'shop', turnaroundDays: 3, turnaroundHours: 30,
    standardTurnaroundDays: 3, standardTurnaroundHours: 30, rushTurnaroundDays: 1, rushTurnaroundHours: 10, updatedAt: oldAt });
  store.catalogSpeedTiers.push({ id: 'speed', catalogItemId: 'item', turnaroundDays: 1, turnaroundHours: 10, priceMinor: 999 });
  store.listingStarters.push({ id: 'starter', defaultTurnaroundDays: 1, defaultTurnaroundHours: 10 });
  store.catalogItems[0].approvedSnapshot = { item: { ...store.catalogItems[0] },
    catalogSpeedTiers: [{ id: 'approved_speed', turnaroundDays: 1, turnaroundHours: 10, priceMinor: 123 }] };
  const backup = { capturedAt: oldAt, sources: [
    ...['turnaround', 'standardTurnaround'].map(prefix => ({ kind: 'supplierServices', id: 'service', prefix, hours: 24 })),
    { kind: 'supplierServices', id: 'service', prefix: 'rushTurnaround', hours: 2 },
    { kind: 'catalogSpeedTiers', id: 'speed', prefix: 'turnaround', hours: 0.75 },
    { kind: 'listingStarters', id: 'starter', prefix: 'defaultTurnaround', hours: 2 },
    { kind: 'approvedCatalogItems', id: 'item', prefix: 'turnaround', hours: 1 },
    { kind: 'approvedSpeedTiers', id: 'approved_speed', prefix: 'turnaround', hours: 0.5 },
  ] };
  const plan = planProductionTimeCorrection(store, { deployedAt, backup });
  applyProductionTimeCorrection(store, plan, { at });
  assert.equal(store.supplierServices[0].turnaroundMinutes, 1440);
  assert.equal(store.supplierServices[0].standardTurnaroundMinutes, 1440);
  assert.equal(store.supplierServices[0].rushTurnaroundMinutes, 120);
  assert.equal(store.catalogSpeedTiers[0].turnaroundMinutes, 45);
  assert.equal(store.catalogSpeedTiers[0].priceMinor, 999);
  assert.equal(store.listingStarters[0].defaultTurnaroundMinutes, 120);
  assert.equal(store.catalogItems[0].approvedSnapshot.item.turnaroundMinutes, 60);
  assert.equal(store.catalogItems[0].approvedSnapshot.catalogSpeedTiers[0].turnaroundMinutes, 30);
  assert.equal(store.catalogItems[0].approvedSnapshot.catalogSpeedTiers[0].priceMinor, 123);
});

test('minimum conflicts, later edits and nonmatching order day snapshots require a decision', () => {
  const store = fixture();
  store.catalogItems[0].minimumTurnaroundDays = 1;
  store.catalogItems[0].minimumTurnaroundHours = 10;
  let plan = planProductionTimeCorrection(store, { deployedAt });
  assert.equal(plan.durations.find(row => row.prefix === 'turnaround').status, 'unresolved_minimum');
  store.catalogItems[0].updatedAt = at;
  plan = planProductionTimeCorrection(store, { deployedAt });
  assert.equal(plan.durations.find(row => row.prefix === 'turnaround').status, 'changed_since_deploy');
  store.orderLineItems[1].turnaroundDaysSnapshot = 2;
  assert.equal(planProductionTimeCorrection(store, { deployedAt }).orders[0].status, 'conversion_mismatch');
});

test('a manifest needs a boolean conflict attestation and a deployment instant with timezone', () => {
  const store = fixture();
  assert.throws(() => planProductionTimeCorrection(store, { deployedAt: '2026-10-07' }), /deployment instant/);
  const preview = planProductionTimeCorrection(store, { deployedAt });
  const manifest = manifestFor(preview);
  manifest[0].noScheduledOrStartedConflict = 'false';
  assert.equal(planProductionTimeCorrection(store, { deployedAt, manifest }).orders[0].status, 'invalid_manifest');
});
