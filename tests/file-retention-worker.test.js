import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileRetention } from '../src/file-retention.js';

function fixture({ enabled = false, failDelete = false } = {}) {
  let saved = { files: ['artwork', 'payment_proof', 'catalog_item_photo'].map((purpose) => ({
    fileId: purpose, purpose, ownerId: 'client', state: 'ready', objectKey: `private/${purpose}`,
    createdAt: '2020-01-01T00:00:00Z', references: purpose === 'catalog_item_photo' ? [] : [{ type: 'order', id: 'order' }],
  })), orders: [{ id: 'order', clientId: 'client', state: 'completed', completedAt: '2020-01-01T00:00:00Z' }], auditLog: [] };
  const objects = new Set(saved.files.map((file) => file.objectKey));
  let commits = 0;
  const database = { transaction: async (fn) => { const before = structuredClone(saved); try { return await fn(); } catch (error) { saved = before; throw error; } } };
  const worker = createFileRetention({ database, load: async () => structuredClone(saved),
    save: async (store) => { saved = structuredClone(store); commits++; },
    storage: { deleteObject: async (key) => { if (failDelete) throw new Error('unavailable'); objects.delete(key); } },
    enabled, now: () => '2026-10-04T00:00:00Z', id: () => `audit-${commits}` });
  return { worker, objects, get store() { return saved; }, get commits() { return commits; },
    hold: () => { saved.issues = [{ orderId: 'order', status: 'open' }]; } };
}
test('dry run counts each purpose without storage or metadata writes even when enabled', async () => {
  const f = fixture({ enabled: true }); const before = structuredClone(f.store);
  const report = await f.worker.run({ dryRun: true });
  assert.equal(report.total, 3); assert.deepEqual(report.byPurpose, { artwork: 1, payment_proof: 1, catalog_item_photo: 1 });
  assert.deepEqual(f.store, before); assert.equal(f.commits, 0); assert.equal(f.objects.size, 3);
});
test('real cleanup is OFF by default, including an explicit execution request', async () => {
  const f = fixture(); const report = await f.worker.run({ dryRun: false });
  assert.equal(report.dryRun, true); assert.equal(report.deletionEnabled, false);
  assert.equal(f.commits, 0); assert.equal(f.objects.size, 3);
});
test('enabled cleanup removes bytes, tombstones rows, and records audit', async () => {
  const f = fixture({ enabled: true }); const report = await f.worker.run({ dryRun: false });
  assert.equal(report.deleted, 3); assert.equal(f.objects.size, 0);
  assert.ok(f.store.files.every((file) => file.state === 'deleted' && !file.objectKey));
  assert.equal(f.store.auditLog.filter((row) => row.action === 'file.retention_delete').length, 3);
});
test('Super Admin early deletion persists reason before storage failure; retry checks newly opened cases', async () => {
  const f = fixture({ failDelete: true });
  await assert.rejects(f.worker.deleteEarly('artwork', { id: 'admin', role: 'super_admin' }, '  Duplicate evidence  '));
  assert.equal(f.store.files[0].state, 'delete_pending');
  const audit = f.store.auditLog.find((row) => row.action === 'file.early_delete');
  assert.equal(audit.reason, 'Duplicate evidence'); assert.equal(audit.actorId, 'admin');
  f.hold(); assert.equal(await f.worker.finishPending('artwork'), false);
  assert.equal(f.objects.size, 3);
});
test('client early deletion is audited and open-case protection covers pending retries', async () => {
  const f = fixture(); await f.worker.deleteEarly('artwork', { id: 'client', role: 'client' });
  assert.equal(f.store.files[0].state, 'deleted');
  assert.equal(f.store.auditLog.find((row) => row.action === 'file.early_delete').actorRole, 'client');
  await assert.rejects(f.worker.deleteEarly('payment_proof', { id: 'client', role: 'client' }), { code: 'forbidden' });
});

test('disabled automatic deletion also protects queued retention work during boot reconciliation', async () => {
  const f = fixture();
  Object.assign(f.store.files[0], { state: 'delete_pending', deletionSource: 'retention' });
  await f.worker.reconcile();
  assert.equal(f.store.files[0].state, 'delete_pending'); assert.equal(f.objects.size, 3);
  assert.equal(f.commits, 0);
});
test('pending uploads remain untouched while cleanup is disabled', async () => {
  const f = fixture(); f.store.files[0].state = 'pending_upload';
  await f.worker.reconcile(); await f.worker.run({ dryRun: false });
  assert.equal(f.store.files[0].state, 'pending_upload'); assert.equal(f.objects.size, 3);
});
test('open cases are excluded from dry-run counts and enabled storage cleanup', async () => {
  const f = fixture({ enabled: true }); f.hold();
  const report = await f.worker.run({ dryRun: false });
  assert.deepEqual(report.byPurpose, { catalog_item_photo: 1 }); assert.equal(report.deleted, 1);
  assert.equal(f.store.files[0].state, 'ready'); assert.equal(f.store.files[1].state, 'ready');
  assert.equal(f.objects.size, 2);
});

test('optional client reason never turns a valid deletion into a server error', async () => {
  const f = fixture();
  await f.worker.deleteEarly('artwork', { id: 'client', role: 'client' }, 42);
  assert.equal(f.store.files[0].state, 'deleted');
});
