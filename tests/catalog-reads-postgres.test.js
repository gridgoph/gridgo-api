import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, saveStore, isHotReadPath } from '../src/postgres-store.js';
import { setupOrders, instrument } from './fixtures/order-reads.js';
import { listingSnapshot } from '../src/catalog-review-state.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { AT } from './fixtures/reschedule.js';

const skip = !process.env.DATABASE_URL;
const roles = [null, 'client', 'supplier', 'replacement', 'rider', 'ops', 'admin', 'staff', 'test_ops', 'review_client', 'dual', 'suspended'];
import { readParityEnv } from './fixtures/read-parity.js';

async function setup(database) {
  const store = await setupOrders(database);
  const item = store.catalogItems.find(row => row.id === 'item_supplier');
  // A private draft has a different price and photograph from its approved view.
  item.approvedSnapshot = listingSnapshot(store, item);
  item.reviewStatus = 'pending';
  item.basePriceMinor = 99999;
  store.catalogItemPhotos = store.catalogItemPhotos.filter(row => row.catalogItemId !== item.id);
  store.files.find(row => row.fileId === 'photo_supplier').references = [{ type: 'supplier_catalog_item', id: item.id, field: 'photos' }];
  const profile = store.supplierProfiles.find(row => row.userId === 'supplier');
  store.supplierProfiles.push({ ...structuredClone(profile), userId: 'review_supplier', shopName: 'Review shop' });
  store.supplierServices.push({ ...structuredClone(store.supplierServices[0]), id: 'review_service', supplierId: 'review_supplier' });
  store.supplierServiceFileFormats.push({ supplierServiceId: 'review_service', formatCode: 'pdf' });
  store.catalogItems.push({ ...structuredClone(store.catalogItems.find(row => row.id === 'item_replacement')), id: 'review_item', supplierId: 'review_supplier', supplierServiceId: 'review_service' });
  store.files.push({ ...structuredClone(store.files.find(row => row.fileId === 'photo_supplier')), fileId: 'shop_image', objectKey: 'private/shop_image', purpose: 'supplier_shop_image', references: [] });
  store.supplierShopMedia.push({ supplierId: 'supplier', slot: 'cover', fileId: 'shop_image', updatedAt: AT });
  await database.transaction(() => saveStore(database, store));
  for (let i = 0; i < 5; i++) await database.query(`INSERT INTO shop_reviews (id,order_id,supplier_id,client_id,quality_stars,speed_stars,value_stars,created_at)
    VALUES ($1,$2,'supplier','client',5,4,5,$3)`, [`extra_review_${i}`, ['order','a_active','m_offer','held_offer','review'][i], AT]);
}

test('catalogue HTTP bodies and signed photo fields equal the full-store route for every role', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  const at = Date.now() + 120000;
  const baseline = await apiForTest(t, readParityEnv(true, at));
  const targeted = await apiForTest(t, readParityEnv(false, at));
  const paths = ['/accepted-file-formats?q=pdf', '/catalog/shops', '/catalog/shops?categoryCode=bad',
    '/catalog/shops/supplier', '/catalog/shops/review_supplier', '/catalog/shops/missing',
    '/catalog/items/item_supplier', '/catalog/items/review_item', '/catalog/items/missing',
    '/catalog/media/photo_supplier', '/catalog/media/shop_image', '/catalog/media/missing',
    '/ops/catalog/shops', '/ops/catalog/shops/supplier', '/ops/catalog/items/item_supplier', '/me/catalog-preview'];
  for (const who of roles) for (const path of paths) for (const suffix of ['', path.includes('?') ? '&includeReviewData=1' : '?includeReviewData=1']) {
    const old = await baseline(who, 'GET', path + suffix, null, { raw: true });
    const current = await targeted(who, 'GET', path + suffix, null, { raw: true });
    assert.equal(current.status, old.status, `${who} ${path}`);
    assert.deepEqual(JSON.parse(current.body), JSON.parse(old.body), `${who} ${path}`);
    assert.equal(current.body, old.body, `${who} ${path}: byte-for-byte body`);
  }
});

test('catalogue graphs avoid unrelated history and use a fixed query budget', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  assert.ok(isHotReadPath('/catalog/items/item_supplier'));
  assert.equal(isHotReadPath('/catalog/items/item_supplier/something'), false);
  const sample = async () => {
    const { db, queries } = instrument(database);
    const store = await loadHotReadStore(db, 'clerk_client', '/catalog/items/item_supplier');
    assert.equal(store.catalogItems.length, 1);
    assert.ok(queries.length <= 32, `queries=${queries.length}`);
    assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox|order_payments)\b/.test(q.sql)));
    await assert.rejects(database.transaction(() => saveStore(database, store)), /read-only/);
    return queries;
  };
  const before = await sample();
  await database.query(`INSERT INTO orders (id,client_id,state,created_at,updated_at,position)
    SELECT 'growth_'||i,'other','draft',$1,$1,1000+i FROM generate_series(1,1000) i`, [AT]);
  assert.deepEqual(await sample(), before);
});
