import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, loadStore, saveStore, isHotReadPath } from '../src/postgres-store.js';
import { instrument } from './fixtures/order-reads.js';
import { parityApiForTest, setupReadParity } from './fixtures/read-parity.js';
import { listingSnapshot } from '../src/catalog-review-state.js';
import { AT } from './fixtures/reschedule.js';
const skip = !process.env.DATABASE_URL;

async function setup(database) {
  const store = await setupReadParity(database);
  const item = store.catalogItems.find(row => row.id === 'item_supplier');
  item.approvedSnapshot = listingSnapshot(store, item);
  item.reviewStatus = 'pending';
  store.catalogItemPhotos = store.catalogItemPhotos.filter(row => row.catalogItemId !== item.id);
  const base = store.catalogItems.find(row => row.id === 'item_replacement');
  store.listingStarters.push({ id: 'starter', subcategoryCode: 'flyers', name: 'Flyer starter', defaultPricingUnit: 'per_unit',
    defaultTurnaroundHours: 2, defaultFormatCodes: ['pdf'] });
  store.listingStarterGroups.push({ id: 'starter_group', starterId: 'starter', name: 'Paper', kind: 'spec', required: true, sortOrder: 0 });
  store.listingStarterOptions.push({ id: 'starter_option', starterGroupId: 'starter_group', label: 'Coated', priceModifierMinor: 100, sortOrder: 0 });
  for (let i = 0; i < 55; i++) store.catalogItems.push({ ...structuredClone(base), id: `board_${String(i).padStart(3, '0')}`,
    name: `${i % 2 ? 'Flyers' : 'Cards'} ${i}`, basePriceMinor: 100 + i, sortOrder: 55 - i, active: i % 3 !== 0 });
  store.supplierServicePriceTiers.push({ id: 'tier', supplierServiceId: 'service_supplier', tierCode: 'bulk',
    minQuantity: 1, maxQuantity: 100, unitPriceMinor: 120, sortOrder: 1 });
  store.files.push({ ...structuredClone(store.files.find(row => row.fileId === 'photo_supplier')), fileId: 'identity', objectKey: 'private/identity', purpose: 'supplier_shop_image', references: [] });
  store.supplierShopMedia.push({ supplierId: 'supplier', slot: 'cover', fileId: 'identity', updatedAt: AT });
  await database.transaction(() => saveStore(database, store));
  return loadStore(database);
}

test('supplier management HTTP preserves drafts, readiness, queue projections, board search and role errors', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  const at = Date.now() + 120000;
  const baseline = await parityApiForTest(t, true, at), targeted = await parityApiForTest(t, false, at);
  const paths = ['/listing-starters', '/listing-starters?subcategoryCode=flyers', '/listing-starters?subcategoryCode=missing',
    '/listing-starters?subcategoryCode=%00', '/me/supplier-readiness', '/me/supplier-readiness?units=10&deadline=2030-01-01T00:00:00Z',
    '/me/supplier-readiness?units=0', '/me/supplier-readiness?widthFeet=20', '/me/supplier-readiness?deadline=no',
    '/me/supplier-profile', '/me/shop-hours', '/me/supplier-payment-terms', '/me/supplier-services',
    '/me/supplier-services/service_supplier', '/me/supplier-services/service_replacement/pricing', '/me/supplier-services/missing',
    '/me/supplier-services/%zz', '/me/supplier-services/%00/pricing', '/me/catalog-items', '/me/catalog-items?limit=1',
    '/me/catalog-items?sort=bad', '/me/catalog-items?cursor=bad', '/me/catalog-items?active=bad', '/me/catalog-items?limit=0',
    '/me/catalog-items?q=%00', '/me/catalog-items/item_supplier', '/me/catalog-items/item_replacement', '/me/catalog-items/item_colour',
    '/me/catalog-items/missing', '/me/catalog-items/%zz', '/me/catalog-items/%00', '/me/catalog-items/item_supplier/prep-steps',
    '/me/catalog-items/item_replacement/production-time-preview?mode=same_day&hours=2&days=2',
    '/me/catalog-items/item_replacement/production-time-preview?mode=days&minDays=1&maxDays=3',
    '/me/catalog-items/item_supplier/production-time-preview?days=bad'];
  async function compare(who, path, opts = {}) {
    const old = await baseline(who, 'GET', path, null, { raw: true, ...opts });
    const current = await targeted(who, 'GET', path, null, { raw: true, ...opts });
    assert.equal(current.status, old.status, `${who} ${path}`);
    assert.equal(current.body, old.body, `${who} ${path}`);
    return JSON.parse(current.body);
  }
  for (const who of [null, 'client', 'supplier', 'replacement', 'rider', 'ops', 'admin', 'staff', 'test_ops', 'dual', 'suspended']) {
    for (const path of paths) await compare(who, path);
  }
  for (const role of ['client', 'supplier', 'ops_admin', 'bad']) for (const path of paths) {
    await compare('dual', path, { headers: { 'X-Gridgo-Role': role } });
  }
  for (const sort of ['board', 'name', 'price_low', 'price_high', 'fastest']) for (const q of ['', 'Flyer', 'Cardz', 'absent']) {
    let cursor = null;
    do {
      const path = `/me/catalog-items?limit=20&sort=${sort}&q=${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await compare('replacement', path); cursor = body.nextCursor;
    } while (cursor);
  }
  for (const path of ['/me/catalog-items?active=false', '/me/catalog-items?subcategoryCode=missing']) await compare('replacement', path);
  assert.equal((await targeted('replacement', 'GET', '/me/catalog-items/item_replacement/production-time-preview?mode=same_day&hours=2&days=2')).status, 200);
  assert.equal((await compare('supplier', '/listing-starters?subcategoryCode=flyers')).starters.length, 1);
  assert.ok((await compare('replacement', '/me/supplier-readiness?units=10')).requestEligibility.listings.some(row => row.evaluated));
  // Committed changes must appear on the next request, without caching drafts or readiness.
  await database.query("UPDATE supplier_profiles SET shop_name='Changed shop' WHERE user_id='supplier'");
  await compare('supplier', '/me/supplier-profile');
  await compare('supplier', '/me/supplier-readiness?units=10');
});

test('supplier management graph bounds board hydration and excludes unrelated history', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  const paths = ['/listing-starters?subcategoryCode=flyers', '/me/supplier-readiness?units=10', '/me/supplier-profile',
    '/me/shop-hours', '/me/supplier-payment-terms', '/me/supplier-services', '/me/supplier-services/service_supplier/pricing',
    '/me/catalog-items?limit=1', '/me/catalog-items/item_supplier', '/me/catalog-items/item_supplier/prep-steps',
    '/me/catalog-items/item_supplier/production-time-preview'];
  const sample = async () => {
    const result = [];
    for (const path of paths) {
      const url = new URL(path, 'http://localhost');
      assert.ok(isHotReadPath(url.pathname), path);
      const { db, queries } = instrument(database);
      const store = await loadHotReadStore(db, 'clerk_supplier', url.pathname, { searchParams: url.searchParams });
      assert.ok(queries.length <= 40, `${path}: ${queries.length}`);
      assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox)\b/.test(q.sql)), path);
      if (url.pathname === '/me/catalog-items') assert.equal(store.catalogItems.length, 1);
      await assert.rejects(database.transaction(() => saveStore(database, store)), /read-only/);
      result.push(queries);
    }
    return result;
  };
  const before = await sample();
  await database.query(`INSERT INTO orders (id,client_id,state,created_at,updated_at,position)
    SELECT 'growth_'||i,'other','draft',$1,$1,1000+i FROM generate_series(1,1000) i`, [AT]);
  await database.query(`INSERT INTO supplier_catalog_items(id,supplier_id,supplier_service_id,subcategory_code,name,base_price_minor,sort_order,created_at,updated_at)
    SELECT 'growth_'||i,supplier_id,supplier_service_id,subcategory_code,'Unrelated listing',100,i,$1,$1
    FROM supplier_catalog_items CROSS JOIN generate_series(1,1000) i WHERE id='item_replacement'`, [AT]);
  assert.deepEqual(await sample(), before);
  for (const [i, queries] of before.entries()) t.diagnostic(`${paths[i]}: ${queries.length} SELECTs, ${queries.reduce((sum,q) => sum + q.rows,0)} rows`);
});

test('board page and child metadata retain one snapshot during a concurrent committed edit', { skip }, async t => {
  const database = createDatabase(process.env), writer = createDatabase(process.env);
  t.after(() => database.close()); t.after(() => writer.close());
  await setup(database);
  let edited = false;
  const db = { ...database, query: async (sql, values) => {
    const result = await database.query(sql, values);
    if (!edited && /SELECT hits\.\*/.test(sql)) {
      edited = true;
      await writer.transaction(() => writer.query("UPDATE supplier_catalog_items SET name='Committed new name' WHERE id='item_supplier'"));
    }
    return result;
  } };
  const store = await loadHotReadStore(db, 'clerk_supplier', '/me/catalog-items');
  assert.ok(edited);
  const page = await store.listOwnCatalogItems();
  assert.notEqual(page.items[0].name, 'Committed new name');
  assert.equal(store.catalogItems[0].name, page.items[0].name);
  const fresh = await loadHotReadStore(database, 'clerk_supplier', '/me/catalog-items');
  assert.equal(fresh.catalogItems[0].name, 'Committed new name');
});
