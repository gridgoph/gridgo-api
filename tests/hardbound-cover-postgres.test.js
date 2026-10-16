import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { AT, fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const spine = { institutionCode: 'ABC-CS', title: 'Flood Risk Mapping', author: 'Sample Author', month: 10, year: 2026 };
const form = { cover: 'separate_file', coverFileId: 'cover_page', spine };

test('the cart form and the order snapshot persist, and the snapshot is immutable', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orderLineItems[0].coverSpine = { version: 1, status: 'given', ...form };
  store.carts.push({ id: 'cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard', fulfillmentMode: 'delivery',
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' }, createdAt: AT, updatedAt: AT });
  store.cartLines.push({ id: 'cline', cartId: 'cart', supplierId: 'supplier', catalogItemId: 'item_supplier', optionIds: [], quantity: 1,
    structuredSpec: {}, sortOrder: 0, createdAt: AT, updatedAt: AT, coverSpine: { ...form, cover: 'text_only', coverFileId: null } });
  await db.transaction(() => saveStore(db, store));

  const loaded = await db.transaction(() => loadStore(db));
  assert.deepEqual(loaded.cartLines[0].coverSpine, { ...form, cover: 'text_only', coverFileId: null });
  assert.deepEqual(loaded.orderLineItems[0].coverSpine, { version: 1, status: 'given', ...form });

  // A cart line can clear its form; the round trip leaves no field behind.
  loaded.cartLines[0].coverSpine = null;
  await db.transaction(() => saveStore(db, loaded));
  assert.equal(Object.hasOwn((await db.transaction(() => loadStore(db))).cartLines[0], 'coverSpine'), false);

  const lineId = loaded.orderLineItems[0].id;
  await assert.rejects(db.query("UPDATE order_line_items SET cover_spine = jsonb_set(cover_spine, '{spine,title}', '\"Changed\"') WHERE id = $1", [lineId]),
    /order cover and spine snapshots are immutable/);
  await assert.rejects(db.query('UPDATE order_line_items SET cover_spine = NULL WHERE id = $1', [lineId]), /immutable/);

  // The database holds the same shape the API writes.
  const bad = [
    { ...form, cover: 'front' },
    { ...form, coverFileId: null },
    { ...form, cover: 'first_page' },
    { ...form, spine: { ...spine, title: '' } },
    { ...form, spine: { ...spine, title: 'T'.repeat(201) } },
    { ...form, spine: { ...spine, month: 13 } },
    { ...form, spine: { ...spine, month: '10' } },
    { ...form, spine: { ...spine, year: 2026.5 } },
    { ...form, spine: { ...spine, institutionCode: 'I'.repeat(25) } },
  ];
  for (const value of bad) {
    await assert.rejects(db.query('UPDATE client_cart_lines SET cover_spine = $1 WHERE id = $2', [JSON.stringify(value), 'cline']),
      /check constraint/, JSON.stringify(value));
  }
  await db.query('UPDATE client_cart_lines SET cover_spine = $1 WHERE id = $2', [JSON.stringify({ ...form, spine: { ...spine, institutionCode: null } }), 'cline']);
});

test('order line snapshot shapes are checked at insert', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  for (const [snapshot, accepted] of [
    [{ version: 1, status: 'not_given' }, true],
    [{ version: 1, status: 'given', ...form }, true],
    [{ version: 1, status: 'not_given', cover: 'first_page' }, false],
    [{ version: 1, status: 'given' }, false],
    [{ version: 2, status: 'not_given' }, false],
    [{ version: 1, status: 'skipped' }, false],
  ]) {
    const store = fixture();
    store.orderLineItems[0].coverSpine = snapshot;
    const saved = db.transaction(() => saveStore(db, store));
    if (accepted) {
      await saved;
      assert.deepEqual((await db.transaction(() => loadStore(db))).orderLineItems[0].coverSpine, snapshot);
      await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
    } else {
      await assert.rejects(saved, /check constraint/, JSON.stringify(snapshot));
    }
  }
});

test('Super Admin turns the checkout requirement on through the settings version handshake', { skip: !DATABASE_URL }, async (t) => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  await db.transaction(() => saveStore(db, fixture()));
  const api = await apiForTest(t);

  const read = await api('client', 'GET', '/settings');
  assert.equal(read.status, 200);
  assert.equal(read.body.settings.coverSpineRequired, false);

  const body = { expectedVersion: read.body.version, reason: 'Client release with the spine form reached coverage', coverSpineRequired: true };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, expectedVersion: read.body.version - 1 })).body.error, 'settings_version_conflict');
  const invalid = await api('admin', 'PATCH', '/settings', { ...body, coverSpineRequired: 'yes' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_cover_spine_required');

  const saved = await api('admin', 'PATCH', '/settings', body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, read.body.version + 1);
  assert.equal(saved.body.settings.coverSpineRequired, true);
  // An unrelated settings write keeps the switch.
  const other = await api('admin', 'PATCH', '/settings', { expectedVersion: saved.body.version, reason: 'Unrelated', issueWindowHours: 48 });
  assert.equal(other.body.settings.coverSpineRequired, true);
  assert.equal((await api('client', 'GET', '/settings')).body.settings.coverSpineRequired, true);
  const audit = await db.query("SELECT data FROM audit_log WHERE action = 'settings.operational_update' ORDER BY position LIMIT 1");
  assert.equal(audit.rows[0].data.detail.previous.coverSpineRequired ?? false, false);
  assert.equal(audit.rows[0].data.detail.current.coverSpineRequired, true);
});
