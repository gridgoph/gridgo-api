import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { listingSnapshot } from '../src/catalog-review-state.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;

for (const status of ['removed', 'suspended']) {
  test(`PostgreSQL catalogue hides an approved supplier after account ${status}`, { skip: !DATABASE_URL }, async t => {
    const db = createDatabase({ DATABASE_URL });
    t.after(() => db.close());
    await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
    const initial = fixture();
    for (const item of initial.catalogItems) {
      item.reviewStatus = 'approved';
      item.approvedSnapshot = listingSnapshot(initial, item);
    }
    initial.files.push({ ...initial.files[0], fileId: 'logo_supplier', purpose: 'supplier_shop_image', objectKey: 'private/logo_supplier' });
    initial.supplierShopMedia.push({ supplierId: 'supplier', slot: 'logo', fileId: 'logo_supplier', updatedAt: AT });
    await db.transaction(() => saveStore(db, initial));
    const api = await apiForTest(t);
    const routes = [
      ['/catalog/shops/supplier', 'catalog_shop_not_found'],
      ['/catalog/items/item_supplier', 'catalog_item_not_found'],
      ['/catalog/media/photo_supplier', 'catalog_media_not_found'],
      ['/catalog/media/logo_supplier', 'catalog_media_not_found'],
    ];
    const index = await api(null, 'GET', '/catalog/shops');
    assert.equal(index.status, 200);
    assert.ok(index.body.shops.some(row => row.supplierId === 'supplier'));
    for (const [path] of routes) {
      assert.equal((await api(null, 'GET', path)).status, 200, path);
    }

    const held = await api('admin', 'PATCH', '/users/supplier/account', { status, reason: 'Test account standing' });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.equal(held.body.user.accountStatus, status);
    const saved = await loadStore(db);
    assert.equal(saved.users.find(row => row.id === 'supplier').accountStatus, status);
    assert.equal(saved.catalogItems.find(row => row.id === 'item_supplier').reviewStatus, 'approved');
    assert.equal(saved.catalogItems.find(row => row.id === 'item_supplier').active, true);
    assert.equal(saved.supplierServices.find(row => row.id === 'service_supplier').state, 'live');
    assert.equal(saved.approvalCases.find(row => row.userId === 'supplier').status, 'approved');

    const hidden = await api(null, 'GET', '/catalog/shops');
    assert.equal(hidden.status, 200);
    assert.ok(!hidden.body.shops.some(row => row.supplierId === 'supplier'));
    assert.ok(hidden.body.shops.some(row => row.supplierId === 'replacement'));
    for (const [path, error] of routes) {
      const response = await api(null, 'GET', path);
      assert.equal(response.status, 404, path);
      assert.deepEqual(response.body, { error }, path);
    }
    assert.equal((await api(null, 'GET', '/catalog/items/item_replacement')).status, 200);
    assert.equal((await api(null, 'GET', '/catalog/media/photo_replacement')).status, 200);
  });
}
