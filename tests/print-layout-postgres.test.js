import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { AT, fixture } from './fixtures/reschedule.js';

const DATABASE_URL = process.env.DATABASE_URL;
const snapshot = { version: 1, code: 'actual_size_centered', check: {
  supportedLayouts: ['fit_to_paper', 'actual_size_centered'], layout: 'actual_size_centered',
  paper: { optionId: 'opt_a4', label: 'A4', widthMilli: 210000, heightMilli: 297000, pageSize: 'A4' },
  files: [], exceedsPaper: true, cutOff: true, scaleChanges: false,
  suggestedPaper: { optionId: 'opt_a3', label: 'A3', widthMilli: 297000, heightMilli: 420000, pageSize: 'A3' }, unknown: [],
} };

test('listing layouts, the cart choice and the order snapshot persist, and the snapshot is immutable', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  const item = store.catalogItems.find(row => row.id === 'item_supplier');
  item.printLayouts = ['fit_to_paper', 'actual_size_centered'];
  store.orderLineItems[0].printLayout = snapshot;
  store.carts.push({ id: 'cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard', fulfillmentMode: 'delivery',
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' }, createdAt: AT, updatedAt: AT });
  store.cartLines.push({ id: 'cline', cartId: 'cart', supplierId: 'supplier', catalogItemId: 'item_supplier', optionIds: [], quantity: 1,
    structuredSpec: {}, sortOrder: 0, createdAt: AT, updatedAt: AT, printLayout: 'fit_to_paper' });
  await db.transaction(() => saveStore(db, store));

  const loaded = await db.transaction(() => loadStore(db));
  assert.deepEqual(loaded.catalogItems.find(row => row.id === 'item_supplier').printLayouts, ['fit_to_paper', 'actual_size_centered']);
  assert.deepEqual(loaded.catalogItems.find(row => row.id !== 'item_supplier')?.printLayouts ?? [], []);
  assert.equal(loaded.cartLines[0].printLayout, 'fit_to_paper');
  assert.deepEqual(loaded.orderLineItems[0].printLayout, snapshot);

  // A cart line can clear its choice; the round trip leaves no field behind.
  loaded.cartLines[0].printLayout = null;
  await db.transaction(() => saveStore(db, loaded));
  assert.equal(Object.hasOwn((await db.transaction(() => loadStore(db))).cartLines[0], 'printLayout'), false);

  await assert.rejects(db.query("UPDATE order_line_items SET print_layout = jsonb_set(print_layout, '{code}', '\"fit_to_paper\"') WHERE id = $1",
    [loaded.orderLineItems[0].id]), /order print layout snapshots are immutable/);
  await assert.rejects(db.query("UPDATE supplier_catalog_items SET print_layouts = '{shrink_to_fit}' WHERE id = 'item_supplier'"), /check constraint/);
  await assert.rejects(db.query("UPDATE client_cart_lines SET print_layout = 'centred' WHERE id = 'cline'"), /check constraint/);
});
