import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { pushMessageFor } from '../src/push.js';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { publicFile } from '../src/attachments.js';
import { retentionDecision, assertEarlyFileDeletion } from '../src/file-retention-policy.js';
const DATABASE_URL = process.env.DATABASE_URL;
const PATH = '/orders/order/client-shop-chat';
async function setup(t, patch = {}, files = [], env = {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  Object.assign(store.orders[0], { shopAcceptance: { supplierId: 'supplier', status: 'accepted', acceptedAt: AT }, ...patch });
  store.files.push(...files);
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t, env) };
}
async function patchOrder(db, patch) {
  await db.transaction(async () => { const store = await loadStore(db); Object.assign(store.orders[0], patch); await saveStore(db, store); });
}
const file = (id, patch = {}) => ({ fileId: id, ownerId: 'client', purpose: 'client_shop_chat_attachment', originalFilename: 'image.png',
  declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, state: 'ready', objectKey: `chat/${id}`, createdAt: AT,
  metadataSanitizedAt: AT, readyAt: AT, references: [], ...patch });

test('HTTP: role labels, masked parties, staff-only evidence, inbox coverage and safe pushes', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  assert.equal((await api(null, 'GET', PATH)).status, 401);
  for (const actor of ['other', 'replacement', 'rider']) assert.equal((await api(actor, 'GET', PATH)).status, 403);
  await db.transaction(async () => {
    const store = await loadStore(db);
    for (const [userId, appRole] of [['supplier', 'supplier'], ['client', 'client'], ['ops', 'ops_admin'], ['admin', 'super_admin']]) {
      store.deviceTokens.push({ id: `chat_device_${userId}`, userId, appRole, token: `${userId}:` + 'x'.repeat(120), platform: 'android', tokenProvider: 'fcm', createdAt: AT, updatedAt: AT });
    }
    await saveStore(db, store);
  });
  const original = 'Call 0917.123.4567 or hello at example dot com';
  const sent = await api('client', 'POST', `${PATH}/messages`, { body: original });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.message.body, 'Call [contact hidden] or [contact hidden]');
  assert.equal(sent.body.message.senderLabel, 'Client');
  assert.deepEqual(sent.body.chat.participants, ['Client', 'Print shop', 'GRIDGO']);
  assert.equal(sent.body.message.originalBody, undefined);
  assert.equal(sent.body.chat.contactAttempts, 1, 'multiple contacts in one message are one attempt');
  assert.equal((await db.query("SELECT user_id FROM notification_push_outbox WHERE device_id='chat_device_supplier'")).rows[0].user_id, 'supplier');
  const supplier = await api('supplier', 'GET', PATH);
  assert.equal(supplier.status, 200);
  assert.equal(supplier.body.chat.unread, 1);
  assert.equal(supplier.body.messages[0].mine, false);
  assert.equal(JSON.stringify(supplier.body).includes('senderUserId'), false);
  assert.equal(JSON.stringify(supplier.body).includes('0917'), false);
  assert.equal((await api('supplier', 'POST', `${PATH}/messages`, { body: 'Please use 100 copies, 8.5 x 11.' })).body.message.senderLabel, 'Print shop');
  const staff = await api('ops', 'GET', PATH);
  assert.equal(staff.body.messages[0].originalBody, original);
  assert.equal(staff.body.messages[0].senderLabel, 'Client');
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.userRoleMemberships.push({ userId: 'client', role: 'ops_admin', createdAt: AT });
    await saveStore(db, store);
  });
  const selectedClient = await api('client', 'GET', PATH, undefined, { headers: { 'X-GRIDGO-Role': 'client' } });
  assert.equal(selectedClient.body.messages[0].originalBody, undefined, 'staff membership does not leak evidence into the client projection');
  const intervention = await api('ops', 'POST', `${PATH}/messages`, { body: 'Use a formal change request.' });
  assert.equal(intervention.status, 201);
  assert.equal(intervention.body.message.senderLabel, 'GRIDGO');
  assert.equal((await api('admin', 'GET', '/ops/client-shop-chats')).status, 200);
  assert.equal((await api('supplier', 'GET', '/ops/client-shop-chats')).status, 403);
  const rows = (await loadStore(db)).notifications;
  for (const role of ['ops_admin', 'super_admin']) assert.ok(rows.some(n => n.type === 'client_shop_chat_activity' && n.appRole === role));
  for (const notice of rows.filter(n => n.type.startsWith('client_shop_chat'))) {
    assert.equal(JSON.stringify(pushMessageFor(notice)).includes('0917'), false);
    assert.equal(JSON.stringify(pushMessageFor(notice)).includes('hello'), false);
  }
  assert.equal((await db.query('SELECT original_body FROM client_shop_chat_messages ORDER BY created_at LIMIT 1')).rows[0].original_body, original);
});

test('HTTP: attempts are per sender/thread; third attempt warns, flags and reports are idempotent', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  let sent;
  for (let n = 1; n <= 3; n++) {
    sent = await api('client', 'POST', `${PATH}/messages`, { body: 'Reach @myshop' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.chat.contactAttempts, n);
    assert.equal(Boolean(sent.body.warning), n === 3);
  }
  const supplier = await api('supplier', 'POST', `${PATH}/messages`, { body: 'Reach 09171234567' });
  assert.equal(supplier.body.chat.contactAttempts, 1);
  assert.equal(supplier.body.warning, undefined);
  const flagged = await api('ops', 'GET', '/ops/client-shop-chats?flagged=1');
  assert.equal(flagged.body.threads.length, 1);
  assert.ok(flagged.body.threads[0].flaggedAt);
  assert.equal(flagged.body.threads[0].contactAttempts, 4);
  const reportPath = `${PATH}/messages/${sent.body.message.id}/reports`;
  for (let n = 0; n < 2; n++) assert.equal((await api('supplier', 'POST', reportPath, { reason: 'contact_sharing' })).status, 200);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM client_shop_chat_reports')).rows[0].n, 1);
  const staff = await api('ops', 'GET', PATH);
  assert.equal(staff.body.reports[0].reporterLabel, 'Print shop');
  assert.equal(staff.body.reports[0].reason, 'contact_sharing');
  assert.equal((await api('client', 'GET', PATH)).body.reports, undefined);
  const notices = (await loadStore(db)).notifications.filter(n => n.type === 'client_shop_chat_flagged');
  assert.equal(notices.length, 2, 'one notice per staff membership at threshold crossing');
  const stored = await loadStore(db);
  const before = stored.orders[0];
  assert.equal(before.shopAcceptance.status, 'accepted', 'chat never changes order terms');
  const forbidden = await api('ops', 'PATCH', '/settings', { expectedVersion: stored.version, reason: 'chat policy', clientShopChatContactThreshold: 2 });
  assert.equal(forbidden.status, 403);
  const changed = await api('admin', 'PATCH', '/settings', { expectedVersion: stored.version, reason: 'chat policy', clientShopChatContactThreshold: 2 });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.settings.clientShopChatContactThreshold, 2);
  assert.ok((await api('supplier', 'POST', `${PATH}/messages`, { body: 'Email shop@example.com' })).body.warning);
  const bad = await api('admin', 'PATCH', '/settings', { expectedVersion: changed.body.version, reason: 'invalid', clientShopChatContactThreshold: 0 });
  assert.equal(bad.status, 400);
});

test('HTTP: acceptance gate, issue expiry, report after close, retained history and pagination', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, { shopAcceptance: { supplierId: 'supplier', status: 'pending' } });
  assert.equal((await api('client', 'POST', `${PATH}/messages`, { body: 'too early' })).status, 409);
  await patchOrder(db, { shopAcceptance: { supplierId: 'supplier', status: 'accepted' } });
  const first = await api('client', 'POST', `${PATH}/messages`, { body: 'first' });
  const second = await api('supplier', 'POST', `${PATH}/messages`, { body: 'second' });
  const page = await api('client', 'GET', `${PATH}?limit=1`);
  assert.equal(page.body.messages.length, 1);
  assert.equal(page.body.nextAfter, first.body.message.id);
  const next = await api('client', 'GET', `${PATH}?after=${page.body.nextAfter}&limit=1`);
  assert.equal(next.body.messages[0].id, second.body.message.id);
  await patchOrder(db, { state: 'issue_window_open', issueWindowExpiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await api('supplier', 'POST', `${PATH}/messages`, { body: 'late' })).body.error, 'client_shop_chat_read_only');
  const history = await api('client', 'GET', PATH);
  assert.equal(history.body.chat.status, 'read_only');
  assert.equal(history.body.messages.length, 2);
  assert.equal((await api('client', 'POST', `${PATH}/messages/${second.body.message.id}/reports`, { reason: 'other' })).status, 200);
  assert.equal((await api('ops', 'POST', `${PATH}/messages`, { body: 'also late' })).status, 409);
});

test('HTTP: lowering the threshold waits for the next attempt before claiming a review flag', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  for (let n = 0; n < 2; n++) assert.equal((await api('client', 'POST', `${PATH}/messages`, { body: 'Reach @myshop' })).status, 201);
  const store = await loadStore(db);
  const changed = await api('admin', 'PATCH', '/settings', { expectedVersion: store.version, reason: 'chat policy', clientShopChatContactThreshold: 2 });
  assert.equal(changed.status, 200);
  const before = await api('client', 'GET', PATH);
  assert.equal(before.body.chat.contactAttempts, 2);
  assert.equal(before.body.chat.warning, undefined, 'a settings edit must not claim an unrecorded review flag');
  assert.deepEqual((await api('ops', 'GET', '/ops/client-shop-chats?flagged=1')).body.threads, []);
  const next = await api('client', 'POST', `${PATH}/messages`, { body: 'Reach @myshop' });
  assert.equal(next.status, 201);
  assert.ok(next.body.warning);
  const flagged = await api('ops', 'GET', '/ops/client-shop-chats?flagged=1');
  assert.equal(flagged.body.threads.length, 1);
  assert.ok(flagged.body.threads[0].flaggedAt);
  assert.equal((await loadStore(db)).notifications.filter(row => row.type === 'client_shop_chat_flagged').length, 2);
});

test('HTTP: attachment scope, neutral metadata, evidence retention and replacement shop isolation', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, {}, [file('chat_photo'), file('unsafe', { metadataSanitizedAt: null }), file('pdf', { detectedContentType: 'application/pdf', originalFilename: 'document.pdf' })]);
  assert.equal((await api('client', 'POST', `${PATH}/messages`, { attachmentFileIds: ['unsafe'] })).status, 400);
  const sent = await api('client', 'POST', `${PATH}/messages`, { attachmentFileIds: ['chat_photo', 'pdf'] });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.message.attachments.length, 2);
  assert.equal((await api('client', 'POST', `${PATH}/messages`, { attachmentFileIds: ['chat_photo'] })).status, 409);
  const metadata = await api('supplier', 'GET', '/files/chat_photo');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.file.ownerId, undefined);
  assert.equal(metadata.body.file.references, undefined);
  assert.equal((await api('rider', 'GET', '/files/chat_photo')).status, 403);
  const store = await loadStore(db); const attached = store.files.find(row => row.fileId === 'chat_photo');
  assert.equal(retentionDecision(store, attached, '2040-01-01T00:00:00Z').eligible, false);
  assert.throws(() => assertEarlyFileDeletion(store, attached, { id: 'admin', role: 'super_admin' }, 'remove'), { code: 'file_retention_hold' });
  assert.equal(publicFile(attached).ownerId, undefined);
  await patchOrder(db, { supplierId: 'replacement', shopAcceptance: { supplierId: 'replacement', status: 'accepted' } });
  const replacement = await api('replacement', 'GET', PATH);
  assert.equal(replacement.status, 200);
  assert.deepEqual(replacement.body.messages, []);
  assert.equal((await api('replacement', 'GET', '/files/chat_photo')).status, 403);
  assert.equal((await api('replacement', 'POST', `${PATH}/messages/${sent.body.message.id}/reports`, { reason: 'other' })).status, 404);
  assert.equal((await api('client', 'GET', PATH)).body.messages.length, 1);
  assert.equal((await api('ops', 'GET', PATH)).body.messages.length, 1);
});

test('HTTP: failing staff notice commit rolls messages and reads back', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  await db.query("CREATE FUNCTION gg246_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'client_shop_chat_activity' THEN RAISE EXCEPTION 'test notice failure'; END IF; RETURN NEW; END $$");
  await db.query('CREATE TRIGGER gg246_notice_failure BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION gg246_fail_notice()');
  try {
  assert.equal((await api('client', 'POST', `${PATH}/messages`, { body: 'atomic message' })).status, 500);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM client_shop_chat_messages')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM client_shop_chat_threads')).rows[0].n, 0);
  } finally { await db.query('DROP TRIGGER IF EXISTS gg246_notice_failure ON notifications'); await db.query('DROP FUNCTION IF EXISTS gg246_fail_notice()'); }
});


test('HTTP: upload stores only sanitized pixels in MinIO and attachment URLs remain scoped', { skip: !DATABASE_URL }, async t => {
  const objects = new Map();
  const storage = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': String(objects.get(req.url)?.length ?? 100), ETag: '"test"' }); return res.end(); }
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      objects.set(req.url, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"test"' }); return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => storage.close(resolve)));
  const origin = `http://127.0.0.1:${storage.address().port}`;
  const { db, api } = await setup(t, {}, [], { MINIO_ENDPOINT: origin, MINIO_PUBLIC_URL: origin });
  const bytes = execFileSync('convert', ['-size', '20x10', 'xc:blue', '-set', 'comment', 'SecretDevice GPSLatitude=7.123', 'png:-']);
  assert.ok(bytes.includes(Buffer.from('SecretDevice')));
  const form = new FormData(); form.set('purpose', 'client_shop_chat_attachment');
  form.set('file', new Blob([bytes], { type: 'image/png' }), 'client-private-name-09171234567.png');
  const uploaded = await api('client', 'POST', '/files', form);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.file.originalFilename, 'image.png');
  assert.equal(uploaded.body.file.ownerId, undefined);
  const persisted = (await loadStore(db)).files.find(file => file.fileId === uploaded.body.file.fileId);
  assert.ok(persisted.metadataSanitizedAt);
  const storedBytes = objects.get(`/reschedule-test/${persisted.objectKey}`);
  assert.ok(storedBytes, 'sanitized image reached the object storage boundary');
  assert.equal(storedBytes.includes(Buffer.from('SecretDevice')), false);
  assert.equal(storedBytes.includes(Buffer.from('GPSLatitude')), false);
  assert.equal((await api('supplier', 'GET', `/files/${persisted.fileId}/download-url`)).status, 403);
  assert.equal((await api('client', 'POST', `${PATH}/messages`, { attachmentFileIds: [persisted.fileId] })).status, 201);
  assert.equal((await api('supplier', 'GET', `/files/${persisted.fileId}/download-url`)).status, 200);
  assert.equal((await api('ops', 'GET', `/files/${persisted.fileId}/download-url`)).status, 200);
  assert.equal((await api('rider', 'GET', `/files/${persisted.fileId}/download-url`)).status, 403);
  const invalid = new FormData(); invalid.set('purpose', 'client_shop_chat_attachment');
  invalid.set('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'image.svg');
  assert.equal((await api('client', 'POST', '/files', invalid)).status, 415);
});
