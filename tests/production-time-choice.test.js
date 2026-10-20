import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/scheduling.js';
import { routeSupplierCatalog } from '../src/catalog-routes.js';
import { privateCatalogItem, publicCatalogItem } from '../src/supplier-catalog.js';
import { deadlineDays } from '../src/order-match.js';
import { approvedCatalogView, listingSnapshot } from '../src/catalog-review-state.js';

const AT = '2026-10-19T01:00:00.000Z';
const supplier = { id: 'shop_a', role: 'supplier' };
function setup() {
  const { store } = fixture();
  const call = (method, path, body, user = supplier) => routeSupplierCatalog({
    req: { method, headers: {} }, url: new URL(path, 'http://gridgo.test'), store, user,
    readBody: async () => body, now: () => AT, id: prefix => `${prefix}_new`,
    audit: (graph, entry) => graph.auditLog.push(entry),
  });
  return { store, item: store.catalogItems[0], call };
}
const choice = { mode: 'days', minDays: 1, maxDays: 3 };

test('one choice resolves inheritance, saves exact hours or working-day range and clears only timing reminders', async () => {
  const { store, item, call } = setup();
  assert.deepEqual(privateCatalogItem(store, item).productionTime, { mode: 'same_day', hours: 30 });
  item.productionTimeReviewReasons = ['legacy_one_working_day'];
  await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, name: 'Updated name' });
  assert.equal(privateCatalogItem(store, item).productionTimeReview.required, true);
  const saved = await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 2, productionTime: choice });
  assert.deepEqual(saved.body.item.productionTime, choice);
  assert.deepEqual(saved.body.item.productionTimeReview, { required: false, reasons: [], message: null });
  assert.equal(item.turnaroundDays, 3);
  assert.equal(item.minimumTurnaroundDays, 1);
  assert.equal(item.turnaroundHours, 30);
  assert.equal(item.reviewStatus ?? 'approved', 'approved');
  await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 3, productionTime: { mode: 'same_day', hours: 1.5 } });
  assert.equal(item.turnaroundDays, null);
  assert.equal(item.minimumTurnaroundMinutes, 90);
  assert.equal(item.turnaroundMinutes, 90);
  assert.equal(publicCatalogItem(store, item).turnaroundHours, 1.5);
});

test('create accepts the production-time choice independently of starter and inherited defaults', async () => {
  const { call } = setup();
  const result = await call('POST', '/me/catalog-items', { supplierServiceId: 'service_shop_a', subcategoryCode: 'flyers', name: 'New flyers', productionTime: choice });
  assert.deepEqual(result.body.item.productionTime, choice);
  assert.equal(result.body.item.turnaroundMode, 'override');
});

test('invalid and ambiguous choices fail before changing a listing', async () => {
  for (const productionTime of [null, [], {}, { mode: 'days', minDays: 4, maxDays: 2 }, { mode: 'days', minDays: 1.5, maxDays: 2 },
    { mode: 'same_day', hours: 0 }, { mode: 'same_day', hours: 1.001 }, { mode: 'same_day', hours: '2' },
    { mode: 'same_day', hours: 2, minDays: 1 }, { mode: 'days', minDays: 1, maxDays: 2, hours: 1 }]) {
    const { item, call } = setup(), before = structuredClone(item);
    await assert.rejects(call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, productionTime }), e => e.status === 400 && e.code === 'invalid_production_time');
    assert.deepEqual(item, before);
  }
  for (const extra of [{ turnaroundHours: 3 }, { turnaroundMode: 'inherit' }, { express: true }]) {
    const { item, call } = setup();
    await assert.rejects(call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, productionTime: choice, ...extra }), e => e.code === 'invalid_production_time');
  }
});

test('legacy duration edits clear the reminder but visibility and listed speed prices remain unchanged', async () => {
  const { store, item, call } = setup();
  Object.assign(item, { turnaroundMode: 'override', turnaroundDays: 1, turnaroundHours: 10, productionTimeReviewReasons: ['legacy_one_working_day'], suspendReason: 'Staff hold', active: false });
  item.approvedSnapshot = { item: structuredClone(item) };
  store.catalogSpeedTiers = [{ id: 'tier', catalogItemId: item.id, turnaroundHours: 1, priceMinor: 1234 }];
  const tiers = structuredClone(store.catalogSpeedTiers);
  await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, turnaroundHours: 2 });
  assert.equal(privateCatalogItem(store, item).productionTimeReview.required, false);
  assert.equal(approvedCatalogView(store).catalogItems[0].turnaroundHours, 2);
  assert.equal(item.suspendReason, 'Staff hold');
  assert.equal(item.active, false);
  assert.deepEqual(store.catalogSpeedTiers, tiers);
});

test('bulk apply is shop scoped, audited per listing and refuses the entire stale set', async () => {
  const { store, item, call } = setup();
  store.catalogItems.push({ ...structuredClone(item), id: 'second', active: false, reviewStatus: 'pending', version: 4 });
  const other = structuredClone(store.catalogItems[1]);
  store.orders.push({ id: 'live', readyBy: AT, promiseBy: AT, state: 'production', scheduling: { readyBy: AT } });
  const orders = structuredClone(store.orders);
  const versions = { [item.id]: 1, second: 4 };
  await assert.rejects(call('POST', '/me/catalog-items/production-time', { productionTime: choice, expectedVersions: { ...versions, second: 3 } }), e => e.code === 'catalog_items_stale');
  assert.equal(item.version, 1);
  await assert.rejects(call('POST', '/me/catalog-items/production-time', { productionTime: choice, expectedVersions: { ...versions, item_shop_b: 1 } }), e => e.code === 'catalog_items_stale');
  const applied = await call('POST', '/me/catalog-items/production-time', { productionTime: choice, expectedVersions: versions });
  assert.equal(applied.body.total, 2);
  assert.deepEqual(applied.body.items.map(row => row.productionTime), [choice, choice]);
  assert.deepEqual(store.catalogItems[1], other);
  assert.deepEqual(store.orders, orders);
  assert.equal(store.auditLog.length, 2);
  assert.ok(store.auditLog.every(row => row.action === 'catalog_item.update' && row.detail.bulk === true && row.detail.previous && row.detail.current));
  assert.equal(store.catalogItems[2].active, false);
  assert.equal(store.catalogItems[2].reviewStatus, 'pending');
});

test('preview uses the client calendar including faster tiers, closed dates and same-day clock times, without mutation', async () => {
  for (const productionTime of [{ mode: 'same_day', hours: 2 }, choice]) {
    const { store, item, call } = setup();
    store.catalogItems.splice(1);
    store.catalogSpeedTiers = [{ id: 'fast', catalogItemId: item.id, turnaroundHours: 1, priceMinor: 12000 }];
    const before = structuredClone(store);
    const params = new URLSearchParams({ ...productionTime, days: '14' });
    const preview = await call('GET', `/me/catalog-items/${item.id}/production-time-preview?${params}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(store, before);
    await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, productionTime });
    const calendar = deadlineDays(store, { subcategoryCode: 'flyers', now: AT, days: 14 });
    assert.deepEqual(preview.body.calendar, calendar);
    assert.ok(preview.body.calendar.days.some(row => row.reason === 'gridgo_closed_sunday'));
    assert.equal(preview.body.scheduling.securedReadyBy, calendar.days.find(row => row.status === 'secured').readyBy);
    item.active = false; item.reviewStatus = 'pending';
    const draft = await call('GET', `/me/catalog-items/${item.id}/production-time-preview?${params}`);
    assert.deepEqual(draft.body.calendar, calendar);
  }
});

test('preview and bulk require supplier ownership and valid inputs; ops flag read uses existing listing projection', async () => {
  const { store, item, call } = setup();
  item.productionTimeReviewReasons = ['legacy_one_working_day'];
  const ops = { id: 'ops', role: 'ops_admin' };
  const result = await call('GET', '/ops/catalog-items?productionTimeReview=required', null, ops);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.items[0].shop.supplierId, supplier.id);
  assert.equal(result.body.items[0].item.productionTimeReview.message, 'Check your production time');
  await assert.rejects(call('GET', '/ops/catalog-items?productionTimeReview=required'), e => e.status === 403);
  await assert.rejects(call('GET', '/ops/catalog-items?productionTimeReview=bad', null, ops), e => e.status === 400);
  await assert.rejects(call('GET', '/me/catalog-items/item_shop_b/production-time-preview?mode=same_day&hours=2'), e => e.status === 403);
  await assert.rejects(call('POST', '/me/catalog-items/production-time', { productionTime: choice, expectedVersions: {} }, ops), e => e.status === 403);
  for (const suffix of ['mode=same_day&hours=2&days=121', 'mode=days&minDays=3&maxDays=1'])
    await assert.rejects(call('GET', `/me/catalog-items/${item.id}/production-time-preview?${suffix}`), e => e.status === 400);
  store.catalogItems[1].express = true;
  store.supplierServices[1].turnaroundHours = store.supplierServices[1].standardTurnaroundHours = null;
  const missing = privateCatalogItem(store, store.catalogItems[1]);
  assert.deepEqual(missing.productionTimeReview.reasons, ['express_missing_hours']);
});

import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, listOwnCatalogItems } from '../src/postgres-store.js';
import { fixture as persistedFixture } from './fixtures/reschedule.js';
import { resetDatabase } from './fixtures/reset-database.js';

test('PostgreSQL forward conversion preserves every order/job/line, flags historical and missing-hour rows, and persists clearing on own-list reads', { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDatabase(); t.after(() => db.close());
  await db.transaction(async () => {
    await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
    const store = persistedFixture(), original = store.catalogItems[0];
    Object.assign(original, { express: true, turnaroundMode: 'override', turnaroundDays: null, turnaroundMinutes: 90, turnaroundHours: 1.5, minimumTurnaroundMinutes: 60, minimumTurnaroundHours: 1 });
    // A second Express listing inherits its effective hours from the service.
    store.catalogItems.push({ ...original, id: 'inherited', turnaroundMode: 'inherit', turnaroundHours: null, turnaroundMinutes: null });
    store.catalogItems.push({ ...original, id: 'rounded', express: false, turnaroundDays: 1, turnaroundMinutes: 600, turnaroundHours: 10 });
    store.catalogItems.push({ ...original, id: 'express_day', turnaroundDays: 1, turnaroundMinutes: 600, turnaroundHours: 10 });
    store.catalogItems.push({ ...original, id: 'new_one_day', express: false, createdAt: '2099-01-01T00:00:00Z', turnaroundDays: 1, turnaroundMinutes: 600, turnaroundHours: 10 });
    store.supplierServices.push({ ...store.supplierServices[0], id: 'service_legacy', turnaroundDays: 1, turnaroundMinutes: 600, turnaroundHours: 10,
      standardTurnaroundDays: 1, standardTurnaroundMinutes: 600, standardTurnaroundHours: 10 });
    store.catalogItems.push({ ...original, id: 'inherited_rounded', express: false, supplierServiceId: 'service_legacy', turnaroundMode: 'inherit',
      turnaroundHours: null, turnaroundMinutes: null, minimumTurnaroundHours: null, minimumTurnaroundMinutes: null });
    store.catalogItems.push({ ...original, id: 'corrected', express: false, turnaroundMinutes: 120, turnaroundHours: 2 });
    store.auditLog.push({ id: 'historic_correction', at: AT, actorId: null, actorRole: 'system', action: 'production_time.correct_39853344', entityType: 'catalogItems', entityId: 'corrected',
      detail: { duration: { oldMinutes: 600, correctedMinutes: 120 } } });
    store.catalogSpeedTiers = [{ id: 'listed_fast', catalogItemId: original.id, label: 'Fast', turnaroundHours: 1, turnaroundMinutes: 60, priceMinor: 12500, sortOrder: 0, createdAt: AT, updatedAt: AT }];
    const other = store.catalogItems.find(row => row.id === 'item_replacement');
    Object.assign(other, { express: true, turnaroundMode: 'override', turnaroundHours: null });
    // SQL CHECK permits a historical NULL override, which has no usable listing duration.
    await saveStore(db, store);
    const before = {};
    for (const table of ['orders', 'order_jobs', 'order_line_items', 'supplier_catalog_speed_tiers', 'supplier_services']) before[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query('ALTER TABLE supplier_catalog_items DROP COLUMN IF EXISTS production_time_review_reasons');
    const { up } = await import('../migrations/1792501000000_production_time_choice.js');
    const statements = []; await up({ sql: sql => statements.push(sql) });
    for (const sql of statements) await db.query(sql);
    const { up: repair } = await import('../migrations/1792501100000_production_time_review_evidence.js');
    const repairs = []; await repair({ sql: sql => repairs.push(sql) });
    for (const sql of repairs) await db.query(sql);
    for (const table of Object.keys(before)) assert.deepEqual((await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows, before[table], table);
    const loaded = await loadStore(db);
    const converted = loaded.catalogItems.find(row => row.id === original.id);
    assert.equal(converted.express, false);
    assert.equal(converted.minimumTurnaroundMinutes, 60);
    const expressDay = loaded.catalogItems.find(row => row.id === 'express_day');
    assert.deepEqual(privateCatalogItem(loaded, expressDay).productionTime, { mode: 'same_day', hours: 10 });
    await routeSupplierCatalog({ req: { method: 'PATCH', headers: {} }, url: new URL('http://gridgo.test/me/catalog-items/express_day'),
      store: loaded, user: { id: original.supplierId, role: 'supplier' },
      readBody: async () => ({ expectedVersion: expressDay.version, productionTime: privateCatalogItem(loaded, expressDay).productionTime }), now: () => AT });
    assert.equal(expressDay.turnaroundMinutes, 600);
    assert.equal(expressDay.minimumTurnaroundMinutes, 600);
    assert.deepEqual(privateCatalogItem(loaded, converted).productionTime, { mode: 'same_day', hours: 1.5 });
    assert.equal(privateCatalogItem(loaded, loaded.catalogItems.find(row => row.id === 'inherited')).productionTime.hours, 2);
    assert.equal(loaded.catalogItems.find(row => row.id === other.id).express, true);
    assert.deepEqual(privateCatalogItem(loaded, loaded.catalogItems.find(row => row.id === other.id)).productionTimeReview.reasons, ['express_missing_hours']);
    assert.deepEqual(privateCatalogItem(loaded, loaded.catalogItems.find(row => row.id === 'rounded')).productionTimeReview.reasons, ['legacy_one_working_day']);
    assert.equal(privateCatalogItem(loaded, loaded.catalogItems.find(row => row.id === 'new_one_day')).productionTimeReview.required, false);
    for (const id of ['inherited_rounded', 'corrected']) assert.deepEqual(privateCatalogItem(loaded, loaded.catalogItems.find(row => row.id === id)).productionTimeReview.reasons, ['legacy_one_working_day']);
    const page = await listOwnCatalogItems(db, { supplierId: original.supplierId, sort: 'board', limit: 20 });
    assert.deepEqual(privateCatalogItem(loaded, page.items.find(row => row.id === 'rounded')).productionTimeReview.reasons, ['legacy_one_working_day']);
    await routeSupplierCatalog({ req: { method: 'PATCH', headers: {} }, url: new URL(`http://gridgo.test/me/catalog-items/rounded`),
      store: loaded, user: { id: original.supplierId, role: 'supplier' }, readBody: async () => ({ expectedVersion: loaded.catalogItems.find(row => row.id === 'rounded').version, productionTime: { mode: 'same_day', hours: 0.5 } }), now: () => AT });
    await saveStore(db, loaded);
    assert.equal(privateCatalogItem(await loadStore(db), (await loadStore(db)).catalogItems.find(row => row.id === 'rounded')).productionTimeReview.required, false);
    db.markRollback();
  });
});

test('exact legacy hour windows project the longest same-day choice while their existing minimum stays unchanged', () => {
  const { store, item } = setup();
  Object.assign(item, { turnaroundMode: 'override', turnaroundMinutes: 180, turnaroundHours: 3, minimumTurnaroundMinutes: 60, minimumTurnaroundHours: 1 });
  assert.deepEqual(privateCatalogItem(store, item).productionTime, { mode: 'same_day', hours: 3 });
  assert.equal(publicCatalogItem(store, item).minimumTurnaroundHours, 1);
});

test('bulk rejects mixed legacy fields and preserves single-edit audit duration evidence', async () => {
  const { store, item, call } = setup();
  await assert.rejects(call('POST', '/me/catalog-items/production-time', { productionTime: choice, turnaroundHours: 2, expectedVersions: { [item.id]: 1 } }), e => e.code === 'invalid_production_time');
  await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, productionTime: choice });
  const audit = store.auditLog.at(-1);
  assert.equal(audit.detail.previous.turnaroundMode, 'inherit');
  assert.equal(audit.detail.current.turnaroundDays, 3);
});

test('preview matches client scheduling for quantity capacity, queue, closures, and approved tiers during a price revision', async () => {
  const { store, item, call } = setup();
  store.catalogItems.splice(1);
  item.minimumOrderQuantity = 20;
  store.supplierServices[0].capacityDaily = 5;
  store.supplierProfiles[0].schedule = { utcOffsetMinutes: 480, week: [1,2,3,4,5,6].map(weekday => ({ weekday, opensMinute: 480, closesMinute: 1080 })), closures: [{ startDay: '2026-10-20', endDay: '2026-10-20' }] };
  store.orderJobs.push({ id: 'queued', supplierId: 'shop_a', orderId: 'existing', state: 'production', estimatedHours: 4 });
  const proposed = { mode: 'same_day', hours: 2 };
  await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, productionTime: proposed });
  item.approvedSnapshot = { ...listingSnapshot(store, item), catalogSpeedTiers: [{ id: 'fast', catalogItemId: item.id, label: 'Fast', turnaroundHours: 1, priceMinor: 1234 }] };
  item.reviewStatus = 'pending';
  store.catalogSpeedTiers = [{ id: 'fast', catalogItemId: item.id, label: 'Draft price', turnaroundHours: 1, priceMinor: 9999 }];
  const preview = await call('GET', `/me/catalog-items/${item.id}/production-time-preview?mode=same_day&hours=2&days=14`);
  assert.deepEqual(preview.body.calendar, deadlineDays(store, { subcategoryCode: 'flyers', now: AT, days: 14 }));
});

for (const [hours, minutes] of [[31 / 60, 31], [2, 120], [10, 600], [30, 1800]]) test(`exact ${minutes}-minute choice has create/edit/preview/bulk parity and round trips`, async () => {
  const productionTime = { mode: 'same_day', hours };
  const { store, item, call } = setup();
  Object.assign(item, { turnaroundMode: 'override', turnaroundHours: hours, turnaroundMinutes: minutes });
  const returned = privateCatalogItem(store, item).productionTime;
  assert.deepEqual(returned, productionTime);
  const preview = await call('GET', `/me/catalog-items/${item.id}/production-time-preview?mode=same_day&hours=${hours}`);
  assert.deepEqual(preview.body.productionTime, productionTime);
  const edited = await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, productionTime: returned });
  assert.deepEqual(edited.body.item.productionTime, productionTime);
  const created = await call('POST', '/me/catalog-items', { supplierServiceId: item.supplierServiceId,
    subcategoryCode: 'flyers', name: 'Exact hours', productionTime });
  assert.deepEqual(created.body.item.productionTime, productionTime);
  const expectedVersions = Object.fromEntries(store.catalogItems.filter(row => row.supplierId === supplier.id).map(row => [row.id, row.version]));
  const bulk = await call('POST', '/me/catalog-items/production-time', { productionTime, expectedVersions });
  assert.ok(bulk.body.items.every(row => row.turnaroundMinutes === minutes && row.minimumTurnaroundMinutes === minutes && row.turnaroundDays === null));
  assert.deepEqual(bulk.body.items.map(row => row.productionTime), [productionTime, productionTime]);
  assert.deepEqual((await call('GET', `/me/catalog-items/${item.id}/production-time-preview?mode=same_day&hours=${hours}`)).body.calendar, preview.body.calendar);
});

test('all four choice paths reject invalid durations with the published error, without mutation', async () => {
  for (const productionTime of [{ mode: 'same_day', hours: 0 }, { mode: 'same_day', hours: 1.001 },
    { mode: 'same_day', hours: 40_000_000 }, { mode: 'days', minDays: 3, maxDays: 2 }, { mode: 'days', minDays: 1, maxDays: 4_000_000 }]) {
    for (const path of ['create', 'edit', 'preview', 'bulk']) {
      const { store, item, call } = setup(), before = structuredClone(store);
      const url = path === 'create' ? '/me/catalog-items' : path === 'edit' ? `/me/catalog-items/${item.id}`
        : path === 'bulk' ? '/me/catalog-items/production-time' : `/me/catalog-items/${item.id}/production-time-preview?${new URLSearchParams(productionTime)}`;
      await assert.rejects(call(path === 'edit' ? 'PATCH' : path === 'preview' ? 'GET' : 'POST', url,
        { productionTime, expectedVersion: 1, expectedVersions: { [item.id]: 1 }, supplierServiceId: item.supplierServiceId, name: 'Invalid' }),
      error => error.status === 400 && error.code === 'invalid_production_time', path);
      assert.deepEqual(store, before);
    }
  }
});

test('legacy minute-picker validation remains narrower than legacy exact-hour writes', async () => {
  const { item, call } = setup();
  await assert.rejects(call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, turnaroundMode: 'override', turnaroundMinutes: 600 }), e => e.code === 'invalid_catalog_item');
  const result = await call('PATCH', `/me/catalog-items/${item.id}`, { expectedVersion: 1, turnaroundMode: 'override', turnaroundHours: 30 });
  assert.deepEqual(result.body.item.productionTime, { mode: 'same_day', hours: 30 });
});
