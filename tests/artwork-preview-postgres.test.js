import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { createArtworkPreviews } from '../src/artwork-preview.js';
import { authorizeFileRead } from '../src/attachments.js';
import { createFileRetention } from '../src/file-retention.js';

const DATABASE_URL = process.env.DATABASE_URL;
test('deleting artwork during conversion cannot recreate original or derived bytes', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await db.query('TRUNCATE users CASCADE');
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.users.push({ id: 'preview-owner', clerkUserId: 'clerk_preview_owner', role: 'client', accountType: 'individual', email: 'owner@preview.test', name: 'Owner', createdAt: '2026-10-01T00:00:00Z' });
    store.files.push({ fileId: 'preview-file', purpose: 'artwork', ownerId: 'preview-owner', state: 'ready', size: 10, detectedContentType: 'application/pdf', declaredContentType: 'application/pdf', objectKey: 'private/file.pdf', originalFilename: 'file.pdf', createdAt: '2026-10-01T00:00:00Z', references: [] });
    await saveStore(db, store);
  });
  const objects = new Set(['private/file.pdf']);
  let started; const rendering = new Promise(resolve => { started = resolve; });
  let release; const rendered = new Promise(resolve => { release = resolve; });
  const storage = { deleteObject: async key => objects.delete(key), putObject: async ({ key }) => objects.add(key) };
  const load = () => loadStore(db), save = store => saveStore(db, store);
  const previews = createArtworkPreviews({ database: db, load, save, storage, render: async () => { started(); await rendered; return Buffer.from('png'); } });
  const resolving = previews.resolve('preview-file', { sourcePath: '/unused-in-this-render-race-test', authorize: (store, file) => authorizeFileRead({ id: 'preview-owner', role: 'client' }, store, file) });
  // Attach rejection handler immediately; the fixture pauses only the renderer.
  const refused = assert.rejects(resolving, { code: 'file_not_found' });
  await rendering;
  const retention = createFileRetention({ database: db, load, save, storage, id: () => 'preview-audit' });
  await retention.deleteEarly('preview-file', { id: 'preview-owner', role: 'super_admin' }, 'Deletion race test');
  release(); await refused;
  assert.equal(objects.size, 0);
  assert.equal((await load()).files.find(file => file.fileId === 'preview-file').state, 'deleted');
});
