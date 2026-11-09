import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createDatabase } from '../src/database.js';
import { isHotReadPath, loadHotReadStore, loadStore, saveStore } from '../src/postgres-store.js';
import { setupReadParity, parityApiForTest } from './fixtures/read-parity.js';
import { instrument } from './fixtures/order-reads.js';
import { listingSnapshot } from '../src/catalog-review-state.js';
import { seedLegalDocuments } from '../src/legal.js';
import { projectSeasonWindows } from '../src/season-windows.js';

const skip = !process.env.DATABASE_URL;
const AT = '2026-11-09T08:00:00.000Z';
const paths = ['/me/legal/pending', '/featured-prints', '/support-chat/me', '/api/support-chat/me', '/season-windows', '/devices'];

function fixtureDatabase(t) {
  const database = createDatabase(process.env);
  t.after(async () => {
    await database.query("DELETE FROM notifications WHERE id LIKE 'startup_history_%'");
    await database.query("DELETE FROM season_windows WHERE id = ANY($1::text[])", [['past', 'today', 'future']]);
    await database.close();
  });
  return database;
}

async function setup(database) {
  await database.query("DELETE FROM season_windows WHERE id = ANY($1::text[])", [['past', 'today', 'future']]);
  const store = await setupReadParity(database);
  await database.query('TRUNCATE legal_documents CASCADE');
  await seedLegalDocuments(database);
  store.settings.featuredPrints = { version: 1, catalogItemIds: ['item_replacement', 'item_supplier', 'missing'] };
  const item = store.catalogItems.find(row => row.id === 'item_supplier');
  item.approvedSnapshot = listingSnapshot(store, item);
  item.reviewStatus = 'pending';
  item.name = 'Live display name';
  item.basePriceMinor = 99999;
  store.catalogItemPhotos = store.catalogItemPhotos.filter(row => row.catalogItemId !== item.id);
  const profile = store.supplierProfiles.find(row => row.userId === 'supplier');
  store.supplierProfiles.push({ ...structuredClone(profile), userId: 'review_supplier', shopName: 'Review shop' });
  store.supplierServices.push({ ...structuredClone(store.supplierServices[0]), id: 'service_review', supplierId: 'review_supplier' });
  store.supplierServiceFileFormats.push({ supplierServiceId: 'service_review', formatCode: 'pdf' });
  store.supplierServices.push({ ...structuredClone(store.supplierServices[0]), id: 'uncurated_service' });
  store.catalogItems.push({ ...structuredClone(item), id: 'item_review', supplierId: 'review_supplier', supplierServiceId: 'service_review',
    approvedSnapshot: null, reviewStatus: 'approved', name: 'Review listing', basePriceMinor: 1000 });
  const photo = { ...structuredClone(store.files.find(row => row.fileId === 'photo_supplier')), fileId: 'photo_review', ownerId: 'review_supplier',
    objectKey: 'private/review', references: [{ type: 'supplier_catalog_item', id: 'item_review', field: 'photos' }] };
  store.files.push(photo);
  store.catalogItemPhotos.push({ catalogItemId: 'item_review', fileId: photo.fileId, sortOrder: 0, createdAt: AT });
  store.settings.featuredPrints.catalogItemIds.push('item_review');
  store.deviceTokens.push(
    { id: 'owned_z', userId: 'client', token: 'owned_token_z', platform: 'android', appRole: 'client', createdAt: AT, updatedAt: AT },
    { id: 'owned_a', userId: 'client', token: 'owned_token_a', platform: 'ios', appRole: 'client', tokenProvider: 'apns', createdAt: AT, updatedAt: AT },
    { id: 'other_device', userId: 'other', token: 'other_token', platform: 'android', createdAt: AT, updatedAt: AT },
  );
  store.seasonWindows.push(
    { id: 'past', name: 'Past', startDate: '2025-01-01', endDate: '2025-01-02', demandLevel: 'Normal', message: 'Past', version: 1, createdAt: AT, updatedAt: AT },
    { id: 'today', name: 'Current', startDate: '2026-11-01', endDate: '2026-11-09', demandLevel: 'Busy', message: 'Current', version: 1, createdAt: AT, updatedAt: AT },
    { id: 'future', name: 'Future', startDate: '2026-12-10', endDate: '2026-12-12', demandLevel: 'Peak', message: 'Soon', version: 1, createdAt: AT, updatedAt: AT },
  );
  await database.transaction(() => saveStore(database, store));
}

test('startup reads are targeted paths', () => {
  for (const path of paths) assert.equal(isHotReadPath(path), true, path);
});

test('startup HTTP reads match full-store bytes across identities, roles and fresh legal acceptances', { skip }, async t => {
  const database = fixtureDatabase(t);
  await setup(database);
  const baseline = await parityApiForTest(t, true, Date.parse(AT), { stableFixture: true });
  const targeted = await parityApiForTest(t, false, Date.parse(AT), { stableFixture: true });
  for (const who of [null, 'missing', 'client', 'supplier', 'rider', 'ops', 'admin', 'test_ops', 'review_client', 'dual', 'staff', 'suspended']) {
    for (const path of paths) {
      const old = await baseline(who, 'GET', path, null, { raw: true });
      const current = await targeted(who, 'GET', path, null, { raw: true });
      assert.equal(current.status, old.status, `${who} ${path} status`);
      assert.equal(current.body, old.body, `${who} ${path} bytes`);
    }
  }
  const featured = await targeted('client', 'GET', '/featured-prints');
  assert.ok(featured.body.items.length > 0);
  assert.equal(featured.body.items.find(row => row.id === 'item_supplier').clientFromPriceMinor, 1100);
  assert.equal(featured.body.items.find(row => row.id === 'item_supplier').photos[0].fileId, 'photo_supplier');
  assert.ok(featured.body.items.every(row => row.id !== 'item_review'));
  assert.deepEqual((await targeted('review_client', 'GET', '/featured-prints')).body.items.map(row => row.id), ['item_review']);
  for (const role of ['client', 'supplier', 'ops_admin', 'invalid']) for (const path of paths) {
    const opts = { raw: true, headers: { 'X-GRIDGO-Role': role } };
    const old = await baseline('dual', 'GET', path, null, opts);
    const current = await targeted('dual', 'GET', path, null, opts);
    assert.equal(current.status, old.status, `${role} ${path}`);
    assert.equal(current.body, old.body, `${role} ${path}`);
  }
  for (const path of paths) {
    const opts = { raw: true, headers: { Authorization: 'Bearer invalid-token' } };
    const old = await baseline(null, 'GET', path, null, opts);
    const current = await targeted(null, 'GET', path, null, opts);
    assert.equal(current.status, old.status, path);
    assert.equal(current.body, old.body, path);
  }
  assert.equal((await targeted('client', 'GET', '/me/legal/pending')).body.blocking, true);
  const versions = await database.query(`SELECT DISTINCT ON (document_id) id FROM legal_versions
    WHERE effective_at <= $1 ORDER BY document_id, effective_at DESC, version DESC`, [AT]);
  assert.ok(versions.rows.length > 0);
  // Acceptance is read on every request rather than stored in a shared cache.
  for (const row of versions.rows) await database.query(`INSERT INTO legal_acceptances(id,user_id,version_id,purpose,accepted_at,method,app,device)
    VALUES($1,'client',$2,'document',$3,'blocking_screen','client','test') ON CONFLICT DO NOTHING`, [`startup_${row.id}`, row.id, AT]);
  const old = await baseline('client', 'GET', '/me/legal/pending', null, { raw: true });
  const current = await targeted('client', 'GET', '/me/legal/pending', null, { raw: true });
  assert.equal(current.body, old.body);
  assert.equal(JSON.parse(current.body).blocking, false);
  assert.equal((await targeted('other', 'GET', '/me/legal/pending')).body.blocking, true);
  await database.query("DELETE FROM user_role_memberships WHERE user_id='client'");
  for (const path of paths) {
    const old = await baseline('client', 'GET', path, null, { raw: true });
    const current = await targeted('client', 'GET', path, null, { raw: true });
    assert.equal(current.status, old.status, `revoked membership ${path}`);
    assert.equal(current.body, old.body, `revoked membership ${path}`);
  }
  assert.equal((await targeted('client', 'GET', '/support-chat/me')).status, 403);
});

test('season graph uses the same inclusive Manila day at midnight', { skip }, async t => {
  const database = fixtureDatabase(t);
  await setup(database);
  const full = await loadStore(database);
  for (const [at, ids] of [['2026-11-09T15:59:59.999Z', ['future', 'today']], ['2026-11-09T16:00:00.000Z', ['future']]]) {
    const scoped = await loadHotReadStore(database, null, '/season-windows', { at });
    assert.deepEqual(projectSeasonWindows(scoped.seasonWindows, at), projectSeasonWindows(full.seasonWindows, at));
    assert.deepEqual(scoped.seasonWindows.filter(row => ['past', 'today', 'future'].includes(row.id)).map(row => row.id).sort(), ids);
  }
});

test('2k/20k unrelated notifications leave startup read graphs and row counts unchanged', { skip }, async t => {
  const database = fixtureDatabase(t);
  await setup(database);
  async function sample() {
    const rows = [];
    for (const path of paths) {
      const traced = instrument(database); const start = performance.now();
      const store = await loadHotReadStore(traced.db, 'clerk_client', path, { at: AT });
      if (path === '/featured-prints') assert.deepEqual(store.supplierServices.map(row => row.id).sort(),
        ['service_replacement', 'service_review', 'service_supplier']);
      assert.ok(!traced.queries.some(q => /FROM (notifications|audit_log|location_pings|notification_push_outbox)\b/.test(q.sql)), path);
      await assert.rejects(database.transaction(() => saveStore(database, store)), /read-only/);
      rows.push({ path, store, counts: traced.queries.map(q => q.rows), ms: performance.now() - start });
    }
    return rows;
  }
  let previous;
  for (const size of [2000, 20000]) {
    await database.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data)
      SELECT 'startup_history_'||i,'other','announcement',$1,i,jsonb_build_object('body',repeat('x',512))
      FROM generate_series($2::int,$3::int) i`, [AT, size === 2000 ? 1 : 2001, size]);
    const current = await sample();
    if (previous) for (let i = 0; i < current.length; i++) {
      assert.deepEqual(current[i].store, previous[i].store, current[i].path);
      assert.deepEqual(current[i].counts, previous[i].counts, current[i].path);
    }
    t.diagnostic(JSON.stringify(current.map(({ path, counts, ms }) => ({ size, path, rows: counts.reduce((a, b) => a + b, 0), ms: Math.round(ms) }))));
    previous = current;
  }
});
