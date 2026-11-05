import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, saveStore, isHotReadPath } from '../src/postgres-store.js';
import { instrument } from './fixtures/order-reads.js';
import { parityApiForTest, setupReadParity } from './fixtures/read-parity.js';
import { AT } from './fixtures/reschedule.js';
const skip = !process.env.DATABASE_URL;
async function setup(database) {
  const store = await setupReadParity(database);
  const base = store.files.find(row => row.fileId === 'art_a_active');
  for (const fileId of [...Array.from({ length: 112 }, (_, i) => `library_${i}`), 'library_a', 'library_A', 'library_é', 'library_z', 'library_0-']) {
    store.files.push({ ...structuredClone(base), fileId, objectKey: `private/${fileId}`, references: [], ownerId: 'client', savedAt: AT,
      detectedContentType: fileId.endsWith('0') ? 'image/png' : 'application/pdf',
      preview: { status: 'ready', size: 100, width: 20, height: 20, createdAt: AT } });
  }
  for (const [fileId, fields] of Object.entries({
    pending: { state: 'pending_upload', savedAt: null, saveToMyFilesRequestedAt: AT },
    deleting: { state: 'delete_pending', savedAt: AT },
    deleted: { state: 'deleted', objectKey: null, savedAt: AT },
    reserved_ready: { saveToMyFilesRequestedAt: AT },
    other: { ownerId: 'other', savedAt: AT },
    proof: { purpose: 'payment_proof', savedAt: AT },
    mockup: { purpose: 'mockup', savedAt: AT },
    newer: { savedAt: '2026-11-01T00:00:00.000Z' },
    false_flag: { savedAt: false, saveToMyFilesRequestedAt: '' },
    zero_flag: { savedAt: 0 },
    missing_object: { savedAt: AT, objectKey: 'private/missing' },
    wrong_size: { savedAt: AT, size: 101 },
  })) store.files.push({ ...structuredClone(base), fileId, objectKey: `private/${fileId}`, references: [], ownerId: 'client', ...fields });
  store.settings.savedFilesLimitBytes = 123456;
  await database.transaction(() => saveStore(database, store));
}

test('saved-file SQL pages preserve exact HTTP bytes, locale ties, quota reservations and unavailable previews', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  const at = Date.now() + 120000;
  const storageHandler = (req,res) => { res.writeHead(req.url.includes('/missing') ? 404 : 200,
    { 'Content-Length': '100', 'Content-Type': 'image/png', ETag: 'test' }); res.end(); };
  const old = await parityApiForTest(t, true, at, { storageHandler });
  const current = await parityApiForTest(t, false, at, { storageHandler });
  async function compare(who, path, opts = {}) {
    const a = await old(who, 'GET', path, null, { raw: true, ...opts });
    const b = await current(who, 'GET', path, null, { raw: true, ...opts });
    assert.equal(b.status, a.status, `${who} ${path}`);
    assert.equal(b.body, a.body, `${who} ${path}`);
    return JSON.parse(b.body);
  }
  for (const who of [null, 'client', 'other', 'supplier', 'rider', 'ops', 'admin', 'staff', 'test_ops', 'dual', 'suspended']) {
    for (const offset of ['', '0', '1', '49', '50', '100', '150', '-1', '1.5', 'bad', '9007199254740992']) {
      await compare(who, `/me/files?offset=${offset}`);
    }
  }
  for (const role of ['client', 'supplier', 'ops_admin', 'bad']) await compare('dual', '/me/files', { headers: { 'X-Gridgo-Role': role } });
  const first = await compare('client', '/me/files');
  assert.equal(first.files.length, 50); assert.equal(first.nextOffset, 50);
  assert.equal(first.usage.limitBytes, 123456);
  await database.query("UPDATE files SET data = data || '{\"savedAt\":null}' WHERE file_id='newer'");
  await database.query("UPDATE platform_settings SET settings = settings || '{\"savedFilesLimitBytes\":999999}'");
  const refreshed = await compare('client', '/me/files');
  assert.equal(refreshed.usage.usedBytes, first.usage.usedBytes - 100);
  assert.equal(refreshed.usage.limitBytes, 999999);
});

test('library quota and page share a snapshot during a concurrent save change', { skip }, async t => {
  const database = createDatabase(process.env), writer = createDatabase(process.env);
  t.after(() => database.close()); t.after(() => writer.close());
  await setup(database);
  let changed = false;
  const db = { ...database, query: async (sql, values) => {
    const result = await database.query(sql, values);
    if (!changed && sql.includes('sum(size_bytes)')) {
      changed = true;
      await writer.transaction(() => writer.query("UPDATE files SET data=data || '{\"savedAt\":null}' WHERE file_id='newer'"));
    }
    return result;
  } };
  const before = await loadHotReadStore(db, 'clerk_client', '/me/files');
  assert.ok(changed);
  assert.ok(before.files.some(row => row.fileId === 'newer'));
  const after = await loadHotReadStore(database, 'clerk_client', '/me/files');
  assert.ok(!after.files.some(row => row.fileId === 'newer'));
  assert.equal(after.savedFilesPage.usedBytes, before.savedFilesPage.usedBytes - 100);
});

test('saved-file graph transfers only one page and a quota aggregate under unrelated file growth', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  assert.ok(isHotReadPath('/me/files'));
  assert.equal(isHotReadPath('/files/file/preview-url'), false);
  const sample = async () => {
    const { db, queries } = instrument(database);
    const store = await loadHotReadStore(db, 'clerk_client', '/me/files');
    assert.equal(store.files.length, 50); assert.equal(store.savedFilesPage.nextOffset, 50);
    assert.equal(queries.length, 7);
    assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox|file_references|orders)\b/.test(q.sql)));
    await assert.rejects(database.transaction(() => saveStore(database, store)), /read-only/);
    return queries;
  };
  const before = await sample();
  await database.query(`INSERT INTO files(file_id,owner_id,purpose,original_filename,declared_content_type,detected_content_type,
    size_bytes,state,object_key,created_at,position,data)
    SELECT 'growth_'||i,'other','artwork','growth.pdf','application/pdf','application/pdf',100,'ready','private/growth_'||i,$1::text::timestamptz,1000+i,
      jsonb_build_object('savedAt',$1::text) FROM generate_series(1,1000) i`, [AT]);
  assert.deepEqual(await sample(), before);
  t.diagnostic(`/me/files: ${before.length} SELECTs, ${before.reduce((sum,q) => sum + q.rows,0)} rows`);
});
