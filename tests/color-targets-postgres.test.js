import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { parseColorTargets, colorTargetsSnapshot } from '../src/color-targets.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { AT, fixture } from './fixtures/reschedule.js';

const DATABASE_URL = process.env.DATABASE_URL;
const targets = parseColorTargets([
  { label: 'School maroon', pantone: '201 C', approximateHex: '#9D2235' },
  { label: 'Brand red', cmyk: { c: 0, m: 100, y: 65, k: 34 } },
  { label: 'Logo blue', hex: '#1a5fb4' },
]);

test('cart colour targets and the order snapshot persist, and the snapshot is immutable', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orderLineItems[0].colorTargets = colorTargetsSnapshot({ colorTargets: targets });
  store.carts.push({ id: 'cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard', fulfillmentMode: 'delivery',
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' }, createdAt: AT, updatedAt: AT });
  store.cartLines.push({ id: 'cline', cartId: 'cart', supplierId: 'supplier', catalogItemId: 'item_supplier', optionIds: [], quantity: 1,
    structuredSpec: {}, sortOrder: 0, createdAt: AT, updatedAt: AT, colorTargets: targets });
  await db.transaction(() => saveStore(db, store));

  const loaded = await db.transaction(() => loadStore(db));
  assert.deepEqual(loaded.cartLines[0].colorTargets, targets);
  assert.deepEqual(loaded.orderLineItems[0].colorTargets, { version: 1, targets });

  // Clearing a cart line's colours leaves no field behind.
  loaded.cartLines[0].colorTargets = null;
  await db.transaction(() => saveStore(db, loaded));
  assert.equal(Object.hasOwn((await db.transaction(() => loadStore(db))).cartLines[0], 'colorTargets'), false);

  await assert.rejects(db.query("UPDATE order_line_items SET color_targets = jsonb_set(color_targets, '{targets,0,value}', '\"PANTONE 202 C\"') WHERE id = $1",
    [loaded.orderLineItems[0].id]), /order colour targets are immutable/);
  await assert.rejects(db.query("UPDATE order_line_items SET color_targets = NULL WHERE id = $1", [loaded.orderLineItems[0].id]),
    /order colour targets are immutable/);
  // The shape is held by the database too: a known format, a label, at most eight.
  for (const bad of [
    '[{"label":"Red","format":"rgb","value":"255 0 0"}]',
    '[{"format":"hex","value":"#FF0000"}]',
    '[]',
    JSON.stringify(Array.from({ length: 9 }, () => ({ label: 'x', format: 'hex', value: '#000000' }))),
    '{"label":"Red","format":"hex","value":"#FF0000"}',
  ]) {
    await assert.rejects(db.query("UPDATE client_cart_lines SET color_targets = $1::jsonb WHERE id = 'cline'", [bad]), /check constraint/, bad);
  }
});
