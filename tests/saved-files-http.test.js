import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { resetDatabase } from './fixtures/reset-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const at = '2026-09-01T00:00:00.000Z';
async function setup(t) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.settings.hubPickupEnabled = true;
  store.orders[0].state = 'completed'; store.orders[0].completedAt = at;
  store.orderJobs[0].state = 'completed';
  for (const [fileId, purpose] of [['art', 'artwork'], ['second', 'artwork'], ['third', 'artwork'], ['proof', 'payment_proof'], ['mock', 'mockup']]) {
    store.files.push({ fileId, purpose, ownerId: 'client', state: 'ready', size: 100,
      originalFilename: `${fileId}.pdf`, declaredContentType: 'application/pdf', detectedContentType: 'application/pdf',
      objectKey: `private/${fileId}`, createdAt: at, readyAt: at, artworkCheck: { status: 'passed', checkedAt: at },
      references: fileId === 'art' ? [{ type: 'order', id: 'order', field: 'artworkFileIds' }] : [] });
  }
  await db.transaction(() => saveStore(db, store));
  const mutate = action => db.transaction(async () => {
    const latest = await loadStore(db); await action(latest); await saveStore(db, latest);
  });
  return { db, mutate };
}
const choice = (api, fileId, saved = true, user = 'client', opts) => api(user, 'PATCH', `/me/files/${fileId}`, { saved }, opts);

test('HTTP saved library persists opt-ins, signs own previews and rejects other clients, roles and held accounts', { skip: !DATABASE_URL }, async t => {
  const { db, mutate } = await setup(t), api = await apiForTest(t);
  assert.equal((await api(null, 'GET', '/me/files')).status, 401);
  const saved = await choice(api, 'art');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(saved.body.file.savedAt); assert.equal(saved.body.usage.usedBytes, 100);
  const repeat = await choice(api, 'art');
  assert.equal(repeat.body.file.savedAt, saved.body.file.savedAt);
  const list = await api('client', 'GET', '/me/files');
  assert.equal(list.status, 200); assert.equal(list.body.files.length, 1);
  assert.equal(list.body.files[0].originalFilename, 'art.pdf');
  assert.match(list.body.files[0].downloadUrl, /X-Amz-Signature=/);
  assert.match(list.headers.get('cache-control'), /private.*no-store/);
  assert.ok(!('objectKey' in list.body.files[0]));
  assert.ok(!('references' in list.body.files[0]));
  assert.equal((await api('other', 'GET', '/me/files')).body.files.length, 0);
  assert.equal((await choice(api, 'art', true, 'other')).status, 404);
  assert.equal((await api('other', 'DELETE', '/me/files/art')).status, 404);
  for (const user of ['supplier', 'rider', 'ops', 'admin']) {
    assert.equal((await api(user, 'GET', '/me/files')).status, 403);
    assert.equal((await choice(api, 'art', true, user)).status, 403);
    assert.equal((await api(user, 'DELETE', '/me/files/art')).status, 403);
  }
  assert.equal((await choice(api, 'proof')).body.error, 'saved_file_purpose_not_allowed');
  assert.equal((await api('admin', 'DELETE', '/files/art', { reason: 'Do not erase saved art' })).body.error, 'file_retention_hold');
  await mutate(store => { store.userRoleMemberships.push({ userId: 'client', role: 'supplier', createdAt: at }); });
  assert.equal((await choice(api, 'art', true, 'client', { headers: { 'X-GRIDGO-Role': 'supplier' } })).status, 403);
  await mutate(store => { Object.assign(store.users.find(row => row.id === 'client'), {
    accountStatus: 'suspended', accountStatusAt: at, accountStatusReason: 'Task test hold', accountStatusBy: 'admin',
  }); });
  assert.equal((await api('client', 'GET', '/me/files')).status, 403);
  assert.equal((await choice(api, 'art', false)).status, 403);
  await mutate(store => {
    const user = store.users.find(row => row.id === 'client'); user.accountStatus = 'active';
    delete user.accountStatusAt; delete user.accountStatusReason; delete user.accountStatusBy;
  });
  assert.equal((await choice(api, 'art', false)).body.usage.usedBytes, 0);
  assert.equal((await api('client', 'GET', '/me/files')).body.files.length, 0);
  assert.equal((await loadStore(db)).files.find(row => row.fileId === 'art').state, 'ready');
});

test('HTTP quota serializes competing saves and Super Admin limit uses the settings version handshake', { skip: !DATABASE_URL }, async t => {
  const { db } = await setup(t), api = await apiForTest(t);
  const settings = await api('admin', 'GET', '/settings');
  assert.equal(settings.body.settings.savedFilesLimitBytes, 500_000_000);
  const patch = { expectedVersion: settings.body.version, reason: 'Task quota test', savedFilesLimitBytes: 100 };
  assert.equal((await api('ops', 'PATCH', '/settings', patch)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', patch)).status, 200);
  assert.equal((await api('admin', 'PATCH', '/settings', patch)).body.error, 'settings_version_conflict');
  const results = await Promise.all([choice(api, 'art'), choice(api, 'second')]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const refusal = results.find(row => row.status === 409).body;
  assert.equal(refusal.error, 'saved_files_limit_reached');
  assert.equal(refusal.usedBytes, 100); assert.equal(refusal.limitBytes, 100);
  assert.match(refusal.message, /Delete saved files/);
  const winner = results[0].status === 200 ? 'art' : 'second';
  assert.equal((await api('client', 'DELETE', `/me/files/${winner}`)).status, 200);
  assert.equal((await choice(api, 'third')).status, 200);
  const store = await loadStore(db);
  assert.ok(store.auditLog.some(row => row.action === 'file.saved'));
  assert.ok(store.auditLog.some(row => row.action === 'file.early_delete'));
});

test('HTTP upload can save at intake; refused uploads and non-artwork never reserve library space', { skip: !DATABASE_URL }, async t => {
  const { db, mutate } = await setup(t);
  const sizes = new Map();
  const api = await apiForTest(t, {}, { storageHandler: (req, res) => {
    if (req.method === 'PUT') {
      let size = 0; req.on('data', chunk => { size += chunk.length; });
      req.on('end', () => { sizes.set(req.url.split('?')[0], size); res.writeHead(200, { ETag: '"saved-test"' }); res.end(); });
    } else if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': sizes.get(req.url.split('?')[0]) ?? 100, ETag: '"saved-test"' }); res.end(); }
    else if (req.method === 'DELETE') { sizes.delete(req.url.split('?')[0]); res.writeHead(204); res.end(); }
    else { res.writeHead(404); res.end(); }
  } });
  const bytes = await fs.readFile(new URL('./fixtures/artwork-check/pixel.png', import.meta.url));
  const form = (save = 'true', purpose = 'artwork') => {
    const body = new FormData(); body.append('purpose', purpose); body.append('saveToMyFiles', save);
    body.append('file', new Blob([bytes], { type: 'image/png' }), 'saved.png'); return body;
  };
  const upload = await api('client', 'POST', '/files', form());
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  assert.ok(upload.body.file.savedAt);
  const list = await api('client', 'GET', '/me/files');
  assert.equal(list.body.usage.usedBytes, bytes.length);
  assert.match(list.body.files[0].previewUrl, /X-Amz-Signature=/);
  await mutate(store => { store.settings.savedFilesLimitBytes = bytes.length; });
  const refused = await api('client', 'POST', '/files', form());
  assert.equal(refused.body.error, 'saved_files_limit_reached');
  assert.equal(refused.body.limitBytes, bytes.length);
  assert.equal((await api('client', 'POST', '/files', form('true', 'payment_proof'))).body.error, 'saved_file_purpose_not_allowed');
  assert.equal((await api('client', 'POST', '/files', form('yes'))).body.error, 'invalid_saved_file_choice');
  const unsaved = await api('client', 'POST', '/files', form('false'));
  assert.equal(unsaved.status, 201); assert.equal(unsaved.body.file.savedAt, null);
  assert.equal((await loadStore(db)).files.filter(row => row.savedAt).length, 1);
});

test('saved files reuse the same private original on a new cart and order and cannot be deleted during work or a case', { skip: !DATABASE_URL }, async t => {
  const { db, mutate } = await setup(t), api = await apiForTest(t);
  assert.equal((await choice(api, 'art')).status, 200);
  const cart = await api('client', 'POST', '/me/carts', { fulfillmentMode: 'pickup' });
  assert.equal(cart.status, 201, JSON.stringify(cart.body));
  const cartId = cart.body.cart.id;
  const line = await api('client', 'POST', `/me/carts/${cartId}/lines`, {
    catalogItemId: 'item_supplier', quantity: 1, optionIds: [], artworkFileId: 'art', specialInstructions: 'Reuse saved artwork',
  });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  assert.equal((await api('client', 'DELETE', '/me/files/art')).body.error, 'file_in_use');
  const checkout = await api('client', 'POST', `/me/carts/${cartId}/checkout`, {
    payment: { method: 'qr_manual', proofFileId: 'proof', reference: id('payment') },
  });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  const freshOrder = checkout.body.order;
  let saved = (await loadStore(db)).files.find(row => row.fileId === 'art');
  assert.ok(saved.savedAt); assert.equal(saved.objectKey, 'private/art');
  assert.ok(saved.references.some(ref => ref.id === freshOrder.id));
  assert.ok(saved.references.some(ref => ref.id === 'order'));
  assert.equal((await api('client', 'DELETE', '/files/art')).body.error, 'file_in_use');
  await mutate(store => {
    const order = store.orders.find(row => row.id === freshOrder.id); order.state = 'completed'; order.completedAt = at;
    store.issues.push({ id: 'hold', orderId: order.id, clientId: 'client', status: 'open', kind: 'quality',
      description: 'Open case', createdAt: at, updatedAt: at });
  });
  assert.equal((await api('client', 'DELETE', '/me/files/art')).body.error, 'file_retention_hold');
  await mutate(store => { store.issues[0].status = 'resolved'; });
  assert.equal((await api('client', 'DELETE', '/me/files/art')).body.file.state, 'deleted');
  assert.equal((await api('client', 'GET', '/me/files')).body.usage.usedBytes, 0);
});

async function waitDeleted(db, fileId) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const file = (await loadStore(db)).files.find(row => row.fileId === fileId);
    if (file.state === 'deleted') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('closed account saved bytes were not removed');
}
test('account removal removes saved artwork with automatic retention OFF', { skip: !DATABASE_URL }, async t => {
  const { db } = await setup(t), api = await apiForTest(t, { GRIDGO_FILE_RETENTION_DELETE_ENABLED: 'false' });
  await choice(api, 'art');
  assert.equal((await api('admin', 'PATCH', '/users/client/account', { status: 'removed', reason: 'Closed account' })).status, 200);
  await waitDeleted(db, 'art');
  const store = await loadStore(db);
  assert.equal(store.files.find(row => row.fileId === 'proof').state, 'ready');
  assert.ok(store.auditLog.some(row => row.action === 'file.saved_account_closed'));
});
test('completing a verified app account-deletion request removes saved files; requesting alone retains them', { skip: !DATABASE_URL }, async t => {
  const { db } = await setup(t), api = await apiForTest(t, { GRIDGO_FILE_RETENTION_DELETE_ENABLED: 'false' });
  await choice(api, 'second');
  assert.equal((await api('client', 'POST', '/me/account-deletion-request', { confirmed: true })).status, 202);
  assert.ok((await loadStore(db)).files.find(row => row.fileId === 'second').savedAt);
  const requests = await api('admin', 'GET', '/ops/account-deletion-requests');
  const request = requests.body.requests.find(row => row.userId === 'client');
  const done = await api('admin', 'PATCH', `/ops/account-deletion-requests/${request.id}`, { status: 'done', confirmed: true });
  assert.equal(done.status, 200);
  await waitDeleted(db, 'second');
});
