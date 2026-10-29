import test from 'node:test';
import assert from 'node:assert/strict';
import * as library from '../src/saved-files.js';
import { defaultOperationalSettings, validateOperationalSettings } from '../src/operational-model.js';
import { retentionDecision } from '../src/file-retention-policy.js';
import { markFileReady, authorizeFileAttach, authorizeFileRead } from '../src/attachments.js';
import { fixture as orderFixture, id } from './fixtures/reschedule.js';
import { routeOrderMatch } from '../src/order-match-routes.js';

const at = '2026-10-29T00:00:00.000Z';
const client = { id: 'client', role: 'client' };
function fixture() {
  return { settings: { savedFilesLimitBytes: 200 }, files: [100, 100, 1].map((size, i) => ({ fileId: `f${i}`,
    ownerId: client.id, purpose: 'artwork', state: 'ready', size, objectKey: `private/f${i}`,
    originalFilename: `design-${i}.png`, detectedContentType: 'image/png' })) };
}
test('saving is opt-in and idempotent; unmarking restores quota without deleting bytes', () => {
  assert.equal(typeof library.setFileSaved, 'function');
  const store = fixture();
  assert.equal(library.savedFilesUsage(store, client).usedBytes, 0);
  library.setFileSaved(store, client, 'f0', true, at);
  library.setFileSaved(store, client, 'f0', true, '2026-10-30T00:00:00Z');
  assert.equal(store.files[0].savedAt, at);
  library.setFileSaved(store, client, 'f1', true, at);
  assert.deepEqual(library.savedFilesUsage(store, client), { usedBytes: 200, limitBytes: 200 });
  assert.throws(() => library.setFileSaved(store, client, 'f2', true, at), error => {
    assert.equal(error.code, 'saved_files_limit_reached');
    assert.equal(error.details.usedBytes, 200); assert.equal(error.details.limitBytes, 200);
    return true;
  });
  library.setFileSaved(store, client, 'f0', false, at);
  assert.equal(store.files[0].savedAt, null);
  assert.equal(store.files[0].state, 'ready');
  library.setFileSaved(store, client, 'f2', true, at);
  assert.equal(library.savedFilesUsage(store, client).usedBytes, 101);
});
test('library ownership, selected client role and account gates apply before any metadata read or change', () => {
  assert.equal(typeof library.setFileSaved, 'function');
  const store = fixture();
  for (const role of ['supplier', 'rider', 'ops_admin', 'super_admin', 'staff']) {
    assert.throws(() => library.setFileSaved(store, { ...client, role }, 'f0', true, at), { code: 'forbidden' });
  }
  assert.throws(() => library.setFileSaved(store, { id: 'other', role: 'client' }, 'f0', true, at), { code: 'file_not_found' });
  for (const accountStatus of ['removed', 'suspended']) assert.throws(() =>
    library.setFileSaved(store, { ...client, accountStatus }, 'f0', true, at), { status: 403 });
  for (const purpose of ['payment_proof', 'supplier_invoice', 'delivery_photo', 'approval_signature', 'client_verification_document']) {
    store.files[0].purpose = purpose;
    assert.throws(() => library.setFileSaved(store, client, 'f0', true, at), { code: 'saved_file_purpose_not_allowed' });
  }
});
test('pending uploads reserve space and deleting releases it only when the bytes are deleted', () => {
  assert.equal(typeof library.setFileSaved, 'function');
  const store = fixture();
  Object.assign(store.files[0], { savedAt: at, state: 'pending_upload' });
  Object.assign(store.files[1], { savedAt: at, state: 'delete_pending' });
  assert.equal(library.savedFilesUsage(store, client).usedBytes, 200);
  assert.throws(() => library.setFileSaved(store, client, 'f2', true, at), { code: 'saved_files_limit_reached' });
  store.files[1].state = 'deleted';
  library.setFileSaved(store, client, 'f2', true, at);
  assert.equal(library.savedFilesUsage(store, client).usedBytes, 101);
});
test('an opted-in upload reserves quota but only keeps files indefinitely after ready commit', () => {
  const store = fixture();
  Object.assign(store.files[0], { state: 'pending_upload', createdAt: at });
  library.setFileSaved(store, client, 'f0', true, at, { pendingUpload: true });
  assert.equal(library.savedFilesUsage(store, client).usedBytes, 100);
  assert.equal(retentionDecision(store, store.files[0], '2026-11-01T00:00:00Z').eligible, true);
  markFileReady(store.files[0], at);
  assert.equal(store.files[0].savedAt, at);
  assert.equal(library.savedFilesUsage(store, client).usedBytes, 100);
  assert.equal(retentionDecision(store, store.files[0], '2026-11-01T00:00:00Z').reason, 'saved_file');
});
test('library list signs only the owner’s ready saved files and strips private metadata', async () => {
  assert.equal(typeof library.listSavedFiles, 'function');
  const store = fixture();
  Object.assign(store.files[0], { savedAt: at, references: [{ type: 'order', id: 'secret' }] });
  Object.assign(store.files[1], { savedAt: at, ownerId: 'other' });
  const result = await library.listSavedFiles({ store, user: client, offset: 0, storage: {
    statObject: async () => ({ size: 100 }), presignGet: async key => ({ url: `signed:${key}`, expiresAt: at }),
  } });
  assert.equal(result.files.length, 1);
  const file = result.files[0];
  assert.equal(file.fileId, 'f0'); assert.equal(file.savedAt, at);
  assert.equal(file.size, 100); assert.equal(file.originalFilename, 'design-0.png');
  assert.equal(file.previewUrl, 'signed:private/f0');
  assert.ok(!('objectKey' in file)); assert.ok(!('references' in file));
  assert.equal(result.nextOffset, null);
});
test('closure ends only artwork opt-ins and records durable deletion intents', () => {
  assert.equal(typeof library.requestAccountSavedFileDeletion, 'function');
  const store = fixture();
  Object.assign(store.files[0], { savedAt: at });
  Object.assign(store.files[1], { savedAt: at, purpose: 'payment_proof' });
  const events = [];
  assert.equal(library.requestAccountSavedFileDeletion(store, client.id, { at, audit: (_store, event) => events.push(event) }), 1);
  assert.equal(store.files[0].savedAt, null);
  assert.equal(store.files[0].savedFileDeletionRequestedAt, at);
  assert.equal(store.files[1].savedAt, at);
  assert.equal(events.length, 1);
  assert.equal(library.requestAccountSavedFileDeletion(store, client.id, { at, audit: () => {} }), 0);
});
test('saved-file limit has a safe integer default and rejects invalid settings', () => {
  const settings = defaultOperationalSettings();
  assert.equal(settings.savedFilesLimitBytes, 500_000_000);
  for (const value of [-1, 0.5, null, '500', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateOperationalSettings({ ...settings, savedFilesLimitBytes: value }), { code: 'invalid_saved_files_limit' });
  }
  validateOperationalSettings({ ...settings, savedFilesLimitBytes: 0 });
});
test('account-closure artwork remains readable by existing work but cannot acquire new cart references', async () => {
  const store = orderFixture(); store.settings.hubPickupEnabled = true;
  store.files.push({ fileId: 'closing', ownerId: 'client', purpose: 'artwork', state: 'ready', size: 100,
    objectKey: 'private/closing', detectedContentType: 'application/pdf', savedFileDeletionRequestedAt: at,
    references: [{ type: 'order', id: 'order', field: 'artworkFileIds' }] });
  store.orders[0].artworkFileIds = ['closing'];
  assert.doesNotThrow(() => authorizeFileRead(client, store, store.files.at(-1)));
  assert.throws(() => authorizeFileAttach(client, store.files.at(-1), { type: 'order', record: store.orders[0] }, store),
    { code: 'file_not_ready' });
  const call = (path, body) => routeOrderMatch({ req: { method: 'POST' }, url: new URL(path, 'http://test'),
    store, user: client, readBody: async () => body, id, now: () => at });
  const cart = (await call('/me/carts', { fulfillmentMode: 'pickup' })).body.cart;
  await assert.rejects(call(`/me/carts/${cart.id}/lines`, { catalogItemId: 'item_supplier', optionIds: [],
    quantity: 1, artworkFileId: 'closing', specialInstructions: 'New order', deadline: '2099-01-01T00:00:00Z' }),
  { code: 'file_not_ready' });
});
