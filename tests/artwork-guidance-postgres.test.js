import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { AT, fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const record = { version: 1, evaluatedAt: AT, subcategoryCode: 'flyers', minimumDpi: 300, acceptsRgb: false, expectedColorMode: 'cmyk',
  orderedSize: { widthMilli: 148000, heightMilli: 210000 }, openWarningCount: 0,
  files: [{ fileId: 'art', colorMode: 'rgb', pixelWidth: 874, pixelHeight: 1240, effectiveDpi: 150,
    warnings: [{ code: 'low_resolution', effectiveDpi: 150, minimumDpi: 300, acceptedAt: AT }] }] };

test('acceptances and the order record persist, and the order record is immutable', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orderLineItems[0].artworkGuidance = record;
  store.carts.push({ id: 'cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard', fulfillmentMode: 'delivery',
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' }, createdAt: AT, updatedAt: AT });
  store.cartLines.push({ id: 'cline', cartId: 'cart', supplierId: 'supplier', catalogItemId: 'item_supplier', optionIds: [], quantity: 1,
    structuredSpec: {}, sortOrder: 0, createdAt: AT, updatedAt: AT,
    artworkWarningAcceptances: [{ fileId: 'art', code: 'color_mode', colorMode: 'rgb', expectedColorMode: 'cmyk', acceptedAt: AT }] });
  await db.transaction(() => saveStore(db, store));

  const loaded = await db.transaction(() => loadStore(db));
  assert.deepEqual(loaded.orderLineItems[0].artworkGuidance, record);
  assert.deepEqual(loaded.cartLines[0].artworkWarningAcceptances, store.cartLines[0].artworkWarningAcceptances);

  await assert.rejects(db.query("UPDATE order_line_items SET artwork_guidance = jsonb_set(artwork_guidance, '{minimumDpi}', '100') WHERE id = $1",
    [loaded.orderLineItems[0].id]), /order artwork guidance records are immutable/);
  await assert.rejects(db.query("UPDATE order_line_items SET artwork_guidance = '{\"version\":2,\"files\":[]}' WHERE id = $1",
    [loaded.orderLineItems[0].id]), /check constraint|immutable/);
  await assert.rejects(db.query("UPDATE client_cart_lines SET artwork_warning_acceptances = '{}' WHERE id = 'cline'"), /check constraint/);
});

test('Super Admin edits the targets through the settings version handshake', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  await db.transaction(() => saveStore(db, fixture()));
  const api = await apiForTest(t);

  const read = await api('client', 'GET', '/settings');
  assert.equal(read.status, 200);
  assert.equal(read.body.settings.artworkGuidance.subcategories.custom_apparel.acceptsRgb, true);
  assert.equal(read.body.settings.artworkGuidance.subcategories.tarpaulins_outdoor_banners.minimumDpi, 100);

  // The fixture taxonomy only has flyers.
  const next = { version: 1, default: { minimumDpi: 250, acceptsRgb: false }, subcategories: { flyers: { minimumDpi: 240, acceptsRgb: false } } };
  const body = { expectedVersion: read.body.version, reason: 'Paper stock change', artworkGuidance: next };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, expectedVersion: read.body.version - 1 })).body.error, 'settings_version_conflict');
  const unknown = await api('admin', 'PATCH', '/settings', { ...body, artworkGuidance: { ...next, subcategories: { posters_standees: { minimumDpi: 180, acceptsRgb: false } } } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'unknown_artwork_guidance_subcategory');
  const invalid = await api('admin', 'PATCH', '/settings', { ...body, artworkGuidance: { ...next, default: { minimumDpi: 2000, acceptsRgb: false } } });
  assert.equal(invalid.body.error, 'invalid_artwork_guidance');

  const saved = await api('admin', 'PATCH', '/settings', body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, read.body.version + 1);
  assert.deepEqual(saved.body.settings.artworkGuidance, next);
  // An unrelated settings write keeps the targets.
  const other = await api('admin', 'PATCH', '/settings', { expectedVersion: saved.body.version, reason: 'Unrelated', issueWindowHours: 48 });
  assert.deepEqual(other.body.settings.artworkGuidance, next);
  const audit = await db.query("SELECT data FROM audit_log WHERE action = 'settings.operational_update' ORDER BY position LIMIT 1");
  assert.deepEqual(audit.rows[0].data.detail.current.artworkGuidance, next);
});
