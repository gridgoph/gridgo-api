import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { apiForTest, domainClockEnv } from './fixtures/reschedule-http.js';
const skip = !process.env.DATABASE_URL;
const path = '/orders/order/client-shop-chat';
const shop = { headers: { 'X-GRIDGO-Role': 'supplier', 'X-GRIDGO-Shop-Id': 'supplier' } };
import { defaultTaxonomy } from '../src/taxonomy.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { actors, id } from './fixtures/reschedule.js';
import { up as positionMigration } from '../migrations/1795802001000_chat_message_positions.js';

test('position migration preserves existing chronological history and read markers', { skip }, async t => {
  const db = createDatabase(process.env); t.after(() => db.close());
  await db.transaction(async () => {
    await db.query(`CREATE TEMP TABLE client_shop_chat_messages(id text PRIMARY KEY,order_id text,supplier_id text,created_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE client_shop_chat_reads(order_id text,user_id text,last_read_at timestamptz) ON COMMIT DROP;
      INSERT INTO client_shop_chat_messages VALUES('later','order','shop','2026-10-05T02:00:00Z'),('earlier','order','shop','2026-10-05T01:00:00Z');
      INSERT INTO client_shop_chat_reads VALUES('order','client','2026-10-05T01:00:00Z')`);
    let sql; await positionMigration({ sql: value => { sql = value; } }); await db.query(sql);
    assert.deepEqual((await db.query('SELECT id,position FROM client_shop_chat_messages ORDER BY position')).rows, [{ id: 'earlier', position: 1 }, { id: 'later', position: 2 }]);
    assert.equal((await db.query('SELECT last_read_position FROM client_shop_chat_reads')).rows[0].last_read_position, 1);
    assert.equal((await db.query("INSERT INTO client_shop_chat_messages(id,order_id,supplier_id,created_at) VALUES('new','order','shop',now()) RETURNING position")).rows[0].position, 3);
  });
});

async function sentOrder(t) {
  const db = createDatabase(process.env); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  Object.assign(store, { orders: [], orderJobs: [], orderLineItems: [], orderLineItemOptions: [], orderInvoices: [], taxonomy: defaultTaxonomy() });
  for (const service of store.supplierServices) service.categoryCode = 'document_publication';
  for (const item of store.catalogItems) Object.assign(item, { subcategoryCode: 'document_printing', express: true,
    pricingUnit: 'per_page', printLayouts: ['fit_to_paper'], basePriceMinor: 300 });
  store.shopMemberships.push({ shopId: 'supplier', userId: 'other', role: 'staff', status: 'active', createdAt: AT, updatedAt: AT });
  store.users.find(u => u.id === 'other').name = 'Mira Quill';
  store.files.push({ fileId: 'chat_art', ownerId: 'client', purpose: 'artwork', state: 'ready', objectKey: 'client/chat.pdf',
    declaredContentType: 'application/pdf', detectedContentType: 'application/pdf', originalFilename: 'draft.pdf', size: 100,
    createdAt: AT, detected: { pageCount: 12 }, artworkCheck: { status: 'passed' }, references: [] });
  const call = (pathname, body) => routeOrderMatch({ req: { method: 'POST' }, url: new URL(pathname, 'http://test'), store,
    user: actors.client, readBody: async () => body, id, now: () => AT });
  const draft = await call('/express/drafts', { acceptFirst: true, supplierId: 'supplier', location: { lat: 7.06, lng: 125.6 }, fulfillmentMode: 'pickup',
    files: [{ fileId: 'chat_art', copies: 3, colour: 'bw', paper: 'a4', sides: 'one', layout: 'fit_to_paper', acceptedWarnings: [] }] });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const placed = await call(`/me/carts/${draft.body.cartId}/checkout`, { looksRight: true, expressConfirmation: draft.body.confirmation });
  await db.transaction(() => saveStore(db, store));
  let output = '';
  return { db, orderId: placed.body.order.id, getOutput: () => output, api: await apiForTest(t, domainClockEnv(AT), { onOutput: chunk => { output += chunk; } }) };
}
async function setup(t) {
  const db = createDatabase(process.env); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.users.find(u => u.id === 'other').name = 'Mira Tester';
  store.shopMemberships.push({ shopId: 'supplier', userId: 'other', role: 'staff', status: 'active', createdAt: AT, updatedAt: AT });
  Object.assign(store.orders[0], { orderType: 'express', state: 'supplier_assigned',
    expressOrder: { version: 1, acceptFlow: 2, originalSupplierId: 'supplier', pickupCode: '123456', events: [{ state: 'sending', at: AT }], printSettings: [] },
    shopAcceptance: { supplierId: 'supplier', status: 'pending', assignedAt: AT, deadlineAt: '2026-10-05T00:01:00Z' } });
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t, domainClockEnv('2026-10-05T00:00:10Z')) };
}
test('shared shop inbox, named replies, read badges, filters and expiring typing are authorized', { skip }, async t => {
  const { db, api } = await setup(t);
  assert.equal((await api('client', 'POST', `${path}/calls`, {})).body.error, 'calling_service_not_configured');
  assert.equal((await api('other', 'POST', `${path}/calls`, {}, shop)).status, 503);
  assert.equal((await api('replacement', 'POST', `${path}/calls`, {})).status, 403);
  assert.equal((await api('other', 'GET', '/me/shop-chats', null, shop)).status, 200);
  assert.equal((await api('client', 'GET', '/me/shop-chats')).status, 403);
  const sent = await api('client', 'POST', `${path}/messages`, { body: 'Can you staple 3 sets?' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  let inbox = await api('other', 'GET', '/me/shop-chats?filter=needs_reply', null, shop);
  assert.equal(inbox.body.threads.length, 1);
  assert.equal(inbox.body.unreadCount, 1);
  assert.equal(inbox.body.threads[0].needsReply, true);
  assert.equal((await api('other', 'POST', `${path}/typing`, { typing: true }, shop)).status, 200);
  let thread = await api('client', 'GET', path);
  assert.equal(thread.body.chat.typing[0].firstName, 'Mira');
  const reply = await api('other', 'POST', `${path}/messages`, { quickMessage: { code: 'printing_now' } }, shop);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.message.senderFirstName, 'Mira');
  assert.equal(reply.body.message.senderShop, 'Fixture shop');
  assert.equal(reply.body.message.senderLabel, 'Mira · Fixture shop');
  thread = await api('client', 'GET', path);
  assert.deepEqual(thread.body.chat.typing, []);
  assert.equal((await api('supplier', 'GET', '/me/shop-chats?filter=needs_reply')).body.threads.length, 0);
  assert.equal((await api('other', 'GET', '/me/shop-chats', null, shop)).body.unreadCount, 0);
  await db.transaction(async () => {
    const store = await loadStore(db); store.shopMemberships.find(m => m.userId === 'other').status = 'removed'; await saveStore(db, store);
  });
  assert.equal((await api('other', 'POST', `${path}/typing`, { typing: true }, shop)).status, 403);
  assert.equal((await api('replacement', 'GET', path)).status, 403);
});
test('Super Admin alone changes pickup chat lifetime; expiry blocks messages and typing', { skip }, async t => {
  const { db, api } = await setup(t);
  let stored = await loadStore(db);
  const body = { expectedVersion: stored.version, reason: 'Shorten conversation window', orderChatCloseAfterPickupHours: 2 };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  const changed = await api('admin', 'PATCH', '/settings', body);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.settings.orderChatCloseAfterPickupHours, 2);
  await db.transaction(async () => {
    stored = await loadStore(db); const o = stored.orders[0];
    o.state = 'completed'; o.expressOrder.pickedUpAt = '2026-10-04T21:00:00Z'; await saveStore(db, stored);
  });
  assert.equal((await api('client', 'POST', `${path}/messages`, { body: 'late' })).status, 409);
  assert.equal((await api('supplier', 'POST', `${path}/typing`, { typing: true })).status, 409);
});

test('Express messages hide contact text and media without exposing attachment download references', { skip }, async t => {
  const { db, api } = await setup(t);
  const file = (fileId, chatSafety) => ({ fileId, ownerId: 'client', purpose: 'client_shop_chat_attachment', state: 'ready',
    objectKey: `private/${fileId}`, originalFilename: 'image.png', declaredContentType: 'image/png', detectedContentType: 'image/png',
    size: 100, createdAt: AT, readyAt: AT, metadataSanitizedAt: AT, references: [], ...(chatSafety ? { chatSafety } : {}) });
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.files.push(file('qr_image', { version: 1, status: 'checked', hasQr: true, hasContacts: false, hasAddress: false }),
      file('ordinary_image', { version: 1, status: 'checked', hasQr: false, hasContacts: false, hasAddress: false }), file('unscanned_image'));
    await saveStore(db, store);
  });
  const posted = await api('client', 'POST', `${path}/messages`, { body: 'Phone 09171234567; 12 pages, 3 sets.', attachmentFileIds: ['qr_image', 'ordinary_image', 'unscanned_image'] });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.message.body, 'Phone [number hidden]; 12 pages, 3 sets.');
  assert.deepEqual(posted.body.message.attachments.map(f => f.fileId), ['ordinary_image']);
  assert.deepEqual(posted.body.message.hiddenAttachments, [{ marker: 'number hidden' }, { marker: 'number hidden' }]);
  for (const fileId of ['qr_image', 'unscanned_image']) {
    assert.equal((await api('supplier', 'GET', `/files/${fileId}/download-url`)).status, 403);
  }
  assert.equal((await api('supplier', 'GET', '/files/ordinary_image/download-url')).status, 200);
  const read = await api('other', 'GET', path, null, shop);
  assert.equal(JSON.stringify(read.body).includes('qr_image'), false);
  assert.equal(JSON.stringify(read.body).includes('0917'), false);
  const notices = (await loadStore(db)).notifications;
  assert.ok(notices.some(n => n.userId === 'other' && n.type === 'client_shop_chat_message'));
  const teamInbox = await api('other', 'GET', '/notifications', null, shop);
  assert.ok(teamInbox.body.notifications.some(n => n.type === 'client_shop_chat_message'));
  await db.query("UPDATE client_shop_chat_typing SET expires_at=$1", ['2026-10-04T00:00:00Z']);
  assert.deepEqual((await api('client', 'GET', path)).body.chat.typing, []);
});

test('agreed extras commit once at acceptance, reprice fees and payment, and assign the accepting worker', { skip }, async t => {
  const { db, api, orderId, getOutput } = await sentOrder(t);
  const thread = `/orders/${orderId}/client-shop-chat`, extraPath = `/orders/${orderId}/express/extras`;
  const original = await loadStore(db);
  const message = await api('client', 'POST', `${thread}/messages`, { body: 'Please staple 3 sets for PHP 1 per set.' });
  assert.equal(message.status, 201, JSON.stringify(message.body));
  const body = { expectedVersion: 0, items: [{ label: 'Staple by set', quantity: 3, unitPriceMinor: 100, agreedMessageId: message.body.message.id }] };
  assert.equal((await api('client', 'PATCH', extraPath, body)).status, 403);
  assert.equal((await api('other', 'PATCH', extraPath, { ...body, items: [{ ...body.items[0], agreedMessageId: '00000000-0000-0000-0000-000000000000' }] }, shop)).body.error, 'express_extra_agreement_required');
  const proposed = await api('other', 'PATCH', extraPath, body, shop);
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body.shopExtras.totalMinor, 13350);
  const notices = (await loadStore(db)).notifications.filter(n => n.type === 'express_extras_updated');
  assert.deepEqual(notices.map(n => n.appRole).sort(), ['ops_admin', 'super_admin']);
  assert.equal((await api('other', 'PATCH', extraPath, body, shop)).body.error, 'express_extras_stale');
  const accepted = await api('other', 'POST', `/orders/${orderId}/express/accept`, {}, shop);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body) + getOutput());
  const loaded = await loadStore(db), order = loaded.orders.find(o => o.id === orderId);
  assert.equal(order.totalMinor, 13350); assert.equal(order.supplierSubtotalMinor, 11100);
  assert.equal(order.serviceFeeMinor, 2250); assert.equal(order.payments.initial.amountMinor, 13350);
  assert.equal(order.payoutMilestones[0].amountMinor, 11100);
  assert.deepEqual(loaded.orderLineItems, original.orderLineItems, 'printing snapshots are unchanged');
  const client = await api('client', 'GET', `/orders/${orderId}`);
  assert.equal(client.body.order.expressOrder.shopExtras.items[0].marker, 'added by shop');
  assert.equal(client.body.order.expressOrder.money.printingMinor, 10800);
  assert.equal(client.body.order.expressOrder.money.extrasMinor, 300);
  const invoice = await api('client', 'GET', `/orders/${orderId}/invoice`);
  assert.equal(invoice.body.invoice.totalMinor, 13350);
  assert.equal(invoice.body.invoice.shopExtras.items[0].amountMinor, 300);
  const mine = await api('other', 'GET', '/me/shop-chats?filter=mine', null, shop);
  assert.equal(mine.body.threads[0].owner.firstName, 'Mira');
  assert.equal((await api('supplier', 'GET', '/me/shop-chats?filter=mine')).body.threads.length, 0);
  const history = await api('client', 'GET', thread);
  assert.ok(history.body.messages.some(m => m.systemEvent === 'accepted' && m.senderFirstName === 'Mira'));
  assert.equal((await api('supplier', 'PATCH', extraPath, { ...body, expectedVersion: 1 })).body.error, 'express_extras_not_pending');
  assert.equal((await api('supplier', 'POST', `/orders/${orderId}/express/accept`, {})).status, 200);
  assert.equal((await db.query("SELECT count(*)::int n FROM client_shop_chat_messages WHERE order_id=$1 AND system_event='accepted'", [orderId])).rows[0].n, 1);
  await assert.rejects(db.query("UPDATE orders SET total_minor=total_minor+1 WHERE id=$1", [orderId]), /immutable|inconsistent/);
  await assert.rejects(db.query("UPDATE orders SET data=jsonb_set(data,'{expressOrder,shopExtras,items}','[]') WHERE id=$1", [orderId]), /immutable/);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.files.push({ fileId: 'chat_payment', ownerId: 'client', purpose: 'payment_proof', state: 'ready', objectKey: 'client/receipt.png',
      declaredContentType: 'image/png', detectedContentType: 'image/png', originalFilename: 'receipt.png', size: 100, createdAt: AT, references: [] });
    await saveStore(db, store);
  });
  const paid = await api('client', 'POST', `/orders/${orderId}/express/pay`, { method: 'qr_ph', reference: 'CHAT-EXTRA-PAYMENT-1', proofFileId: 'chat_payment' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body) + getOutput());
  const ready = await api('supplier', 'POST', `/orders/${orderId}/transition`, { state: 'ready_for_dispatch' });
  assert.equal(ready.status, 200, JSON.stringify(ready.body) + getOutput());
  const readyChat = await api('client', 'GET', thread);
  assert.ok(readyChat.body.messages.some(m => m.systemEvent === 'ready' && m.senderFirstName === 'supplier'));
  const followed = await api('supplier', 'POST', `${thread}/messages`, { body: 'Ready for collection.' });
  assert.equal(followed.status, 201, JSON.stringify(followed.body));
  const followedInbox = await api('other', 'GET', '/me/shop-chats?filter=mine', null, shop);
  assert.deepEqual(followedInbox.body.threads[0].followedUpBy, [{ firstName: 'supplier' }]);
});

test('failed acceptance notice rolls back extras money, ownership and the system line atomically', { skip }, async t => {
  const { db, api, orderId } = await sentOrder(t);
  const thread = `/orders/${orderId}/client-shop-chat`;
  const message = await api('client', 'POST', `${thread}/messages`, { body: 'Please staple 3 sets for PHP 1 per set.' });
  const proposed = await api('supplier', 'PATCH', `/orders/${orderId}/express/extras`, { expectedVersion: 0,
    items: [{ label: 'Staple by set', quantity: 3, unitPriceMinor: 100, agreedMessageId: message.body.message.id }] });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  await db.query(`CREATE FUNCTION chat452_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='express_order' THEN RAISE EXCEPTION 'test acceptance notice failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER chat452_fail_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION chat452_fail_notice()`);
  try {
    assert.equal((await api('supplier', 'POST', `/orders/${orderId}/express/accept`, {})).status, 500);
    const order = (await loadStore(db)).orders.find(o => o.id === orderId);
    assert.equal(order.state, 'supplier_assigned'); assert.equal(order.supplierSubtotalMinor, 10800);
    assert.equal(order.expressOrder.shopExtras.appliedAt, undefined);
    assert.equal((await db.query("SELECT count(*)::int n FROM client_shop_chat_messages WHERE order_id=$1 AND system_event='accepted'", [orderId])).rows[0].n, 0);
    assert.equal((await db.query('SELECT owner_worker_key FROM client_shop_chat_threads WHERE order_id=$1', [orderId])).rows[0].owner_worker_key, null);
  } finally { await db.query('DROP TRIGGER chat452_fail_notice ON notifications; DROP FUNCTION chat452_fail_notice()'); }
});
