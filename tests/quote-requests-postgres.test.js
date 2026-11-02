import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadHotReadStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { alwaysOpenOperatingHours } from './helpers/operating-hours.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
const reset = db => resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
const DROPOFF = { lat: 7.07, lng: 125.61, label: 'Event hall' };
const SHOP_KEYS = ['supplierId', 'shopName', 'priceMinor', 'catalogItemId', 'replyId', 'replies', 'client', 'supplierServiceId'];

function setup() {
  const store = fixture();
  store.settings.operatingHours = alwaysOpenOperatingHours();
  store.taxonomy.subcategories.push({ id: 'signage', code: 'business_store_signages', categoryCode: 'marketing_collateral', name: 'Business & store signages', active: true });
  for (const [fileId, purpose, ownerId] of [['ref', 'artwork', 'client'], ['ref2', 'artwork', 'client'], ['receipt', 'payment_proof', 'client'], ['others', 'artwork', 'other']]) {
    store.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, originalFilename: `${fileId}.pdf`, size: 100,
      detectedContentType: 'application/pdf', declaredContentType: 'application/pdf', artworkCheck: { status: 'passed', checkedAt: AT }, createdAt: AT, references: [] });
  }
  return store;
}

const brief = (overrides = {}) => ({ productType: 'business_store_signages', use: 'Shop front sign', placement: 'outdoor', size: '2 x 6 ft',
  quantity: 2, notes: 'Weatherproof please', budgetMinor: 500_000, referenceFileIds: ['ref'], fulfillmentMode: 'delivery', dropoff: DROPOFF, ...overrides });
const days = (minDays, maxDays = minDays) => ({ mode: 'days', minDays, maxDays });

/** Every key in a JSON value, recursively. */
function keys(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach(item => keys(item, found));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { found.add(key); keys(item, found); }
  return found;
}
function assertAnonymous(body) {
  for (const key of SHOP_KEYS) assert.ok(!keys(body).has(key), `client read leaks ${key}`);
  const json = JSON.stringify(body);
  for (const value of ['Fixture shop', '"supplier"', '"replacement"', 'service_supplier', 'Printer']) assert.ok(!json.includes(value), `client read leaks ${value}`);
}

async function published(api, request = brief()) {
  const created = await api('client', 'POST', '/me/quote-requests', request);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/ops/quote-requests/${created.body.quoteRequest.id}`;
  const first = await api('ops', 'POST', `${path}/replies`, { supplierId: 'supplier', priceMinor: 120_000, productionTime: days(3, 4), recommendedOptions: 'Acrylic with LED backlight' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await api('ops', 'POST', `${path}/replies`, { supplierId: 'replacement', priceMinor: 90_000, productionTime: days(1), recommendedOptions: 'Aluminium composite panel' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const publish = await api('ops', 'POST', `${path}/publish`, { replyIds: [first.body.reply.id, second.body.reply.id] });
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
  return { id: created.body.quoteRequest.id, path, ops: publish.body.quoteRequest };
}

test('quote requests: brief, Operations replies, anonymous A/B options, accept into a normal paid order', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  await db.transaction(() => saveStore(db, setup()));
  const api = await apiForTest(t, {}, { onOutput: process.env.QDEBUG ? (line) => process.stderr.write(line) : undefined });

  // Intake: the client alone files a brief, with its own ready files.
  assert.equal((await api(null, 'POST', '/me/quote-requests', brief())).status, 401);
  assert.equal((await api('supplier', 'POST', '/me/quote-requests', brief())).body.error, 'membership_required');
  assert.equal((await api('client', 'POST', '/me/quote-requests', brief({ referenceFileIds: [] }))).body.error, 'reference_files_required');
  assert.equal((await api('client', 'POST', '/me/quote-requests', brief({ referenceFileIds: ['others'] }))).body.error, 'file_not_ready');
  assert.equal((await api('client', 'POST', '/me/quote-requests', brief({ productType: 'flyers' }))).body.error, 'invalid_quote_product_type');
  assert.equal((await api('client', 'POST', '/me/quote-requests', brief({ placement: 'roof' }))).status, 400);
  assert.equal((await api('client', 'POST', '/me/quote-requests', brief({ eventDate: '2020-01-01' }))).body.error, 'invalid_event_date');
  assert.equal((await api('client', 'POST', '/me/quote-requests', brief({ dropoff: null }))).body.error, 'dropoff_required');
  assert.equal((await api('client', 'POST', '/me/quote-requests', brief({ fulfillmentMode: 'pickup' }))).body.error, 'hub_pickup_disabled');
  const eventDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const created = await api('client', 'POST', '/me/quote-requests', brief({ eventDate, referenceFileIds: ['ref', 'ref2'] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const requestId = created.body.quoteRequest.id;
  assert.equal(created.body.quoteRequest.status, 'requested');
  assert.deepEqual(created.body.quoteRequest.options, []);
  assert.deepEqual(created.body.quoteRequest.ranking, ['quality', 'speed', 'cost', 'distance']);

  let store = await db.transaction(() => loadStore(db));
  assert.ok(store.auditLog.some(row => row.action === 'quote_request.create' && row.entityId === requestId));
  assert.deepEqual(store.notifications.filter(row => row.type === 'ops_quote_requested').map(row => row.userId).sort(), ['admin', 'ops']);
  assert.deepEqual(store.files.find(file => file.fileId === 'ref').references, [{ type: 'quote_request', id: requestId, field: 'reference' }]);
  const inbox = await api('ops', 'GET', '/notifications');
  assert.equal(inbox.body.notifications.find(row => row.type === 'ops_quote_requested').quoteRequestId, requestId);

  // Reads are scoped: the owner, never another client, and the queue is staff only.
  assert.equal((await api('other', 'GET', `/me/quote-requests/${requestId}`)).body.error, 'forbidden');
  assert.deepEqual((await api('other', 'GET', '/me/quote-requests')).body.quoteRequests, []);
  assert.equal((await api('client', 'GET', '/ops/quote-requests')).status, 403);
  assert.equal((await api('supplier', 'GET', `/ops/quote-requests/${requestId}`)).status, 403);
  const queue = await api('ops', 'GET', '/ops/quote-requests?status=open');
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.deepEqual(queue.body.quoteRequests.map(row => row.id), [requestId]);
  assert.equal(queue.body.quoteRequests[0].client.email, 'client@example.invalid');

  // Operations enters what each shop replied.
  const path = `/ops/quote-requests/${requestId}`;
  assert.equal((await api('client', 'POST', `${path}/replies`, { supplierId: 'supplier', priceMinor: 1, productionTime: days(1) })).status, 403);
  assert.equal((await api('ops', 'POST', `${path}/replies`, { supplierId: 'client', priceMinor: 100, productionTime: days(1) })).body.error, 'quote_shop_unavailable');
  assert.equal((await api('ops', 'POST', `${path}/replies`, { supplierId: 'supplier', priceMinor: 0, productionTime: days(1) })).status, 400);
  assert.equal((await api('ops', 'POST', `${path}/publish`, { replyIds: ['nope'] })).body.error, 'quote_replies_required');
  const slow = await api('ops', 'POST', `${path}/replies`, { supplierId: 'supplier', priceMinor: 150_000, productionTime: days(3, 4), recommendedOptions: 'Acrylic with LED backlight' });
  assert.equal(slow.status, 201, JSON.stringify(slow.body));
  assert.equal(slow.body.quoteRequest.status, 'quoting');
  assert.ok(slow.body.reply.readyBy);
  assert.equal(slow.body.reply.eventDateFit, 'before');
  assert.equal(slow.body.quoteRequest.eventDateWarning, null);
  const fast = await api('ops', 'POST', `${path}/replies`, { supplierId: 'replacement', priceMinor: 90_000, productionTime: { mode: 'same_day', hours: 6 }, recommendedOptions: 'Aluminium composite panel' });
  assert.equal(fast.status, 201, JSON.stringify(fast.body));
  const edited = await api('ops', 'PATCH', `${path}/replies/${slow.body.reply.id}`, { priceMinor: 120_000, expectedReplyVersion: 1 });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.reply.priceMinor, 120_000);
  assert.equal((await api('ops', 'PATCH', `${path}/replies/${slow.body.reply.id}`, { priceMinor: 1, expectedReplyVersion: 1 })).body.error, 'quote_reply_version_conflict');

  // Nothing is shown to the client before publication.
  const early = await api('client', 'GET', `/me/quote-requests/${requestId}`);
  assert.deepEqual(early.body.quoteRequest.options, []);
  assertAnonymous(early.body);
  assert.equal((await api('client', 'POST', `/me/quote-requests/${requestId}/accept`, { option: 'A' })).body.error, 'quote_not_published');

  // Publish: ranked by the client's priority, labelled A/B, valid for the default 7 days.
  assert.equal((await api('ops', 'POST', `${path}/publish`, { replyIds: [slow.body.reply.id, fast.body.reply.id, slow.body.reply.id] })).status, 400);
  const publish = await api('ops', 'POST', `${path}/publish`, { replyIds: [slow.body.reply.id, fast.body.reply.id] });
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
  const opsView = publish.body.quoteRequest;
  assert.equal(opsView.status, 'published');
  assert.deepEqual(opsView.options.map(option => [option.label, option.supplierId]), [['A', 'replacement'], ['B', 'supplier']]);
  assert.deepEqual(opsView.matchReason, { key: 'speed', label: 'Matched for Fastest Turnaround' });
  assert.equal(Date.parse(opsView.validUntil) - Date.parse(opsView.publishedAt), 7 * 86_400_000);
  for (const option of opsView.options) assert.ok(option.clientPriceMinor > option.priceMinor, 'all-in price includes the service fee');

  const read = await api('client', 'GET', `/me/quote-requests/${requestId}`);
  assert.equal(read.status, 200);
  assertAnonymous(read.body);
  const options = read.body.quoteRequest.options;
  assert.deepEqual(options.map(option => option.label), ['A', 'B']);
  assert.deepEqual(options.map(option => option.clientPriceMinor), opsView.options.map(option => option.clientPriceMinor));
  assert.deepEqual(options.map(option => option.eventDateFit), ['before', 'before']);
  assert.equal(options[0].recommendedOptions, 'Aluminium composite panel');
  assert.ok(options.every(option => option.acceptable && option.readyBy && option.distanceZone.key === 'nearby'));
  assertAnonymous((await api('client', 'GET', '/me/quote-requests')).body);
  store = await db.transaction(() => loadStore(db));
  assert.equal(store.notifications.filter(row => row.type === 'quote_options_ready' && row.userId === 'client').length, 1);
  assert.ok(store.auditLog.some(row => row.action === 'quote_request.publish' && row.entityId === requestId));
  assert.equal(store.auditLog.filter(row => ['quote_request.reply', 'quote_request.reply_update'].includes(row.action)).length, 3);

  // The private listings behind the options are nobody's catalogue, board or match.
  for (const option of opsView.options) {
    assert.equal((await api('client', 'GET', `/catalog/items/${option.catalogItemId}`)).status, 404);
    assert.equal((await api('client', 'POST', '/me/catalog-quotes', { catalogItemId: option.catalogItemId, quantity: 1, optionIds: [] })).status, 404);
  }
  const board = await api('supplier', 'GET', '/me/catalog-items');
  assert.ok(!JSON.stringify(board.body).includes(opsView.options[1].catalogItemId));
  assert.equal((await api('supplier', 'PATCH', `/me/catalog-items/${opsView.options[1].catalogItemId}`, { name: 'Changed' })).status, 404);
  const match = await api('client', 'POST', '/me/matches', { subcategoryCode: 'business_store_signages', fulfillmentMode: 'delivery', dropoff: DROPOFF });
  assert.equal(match.body.error, 'match_not_found');

  // Accept B: a fresh cart holding the option at the quoted price.
  assert.equal((await api('ops', 'POST', `/me/quote-requests/${requestId}/accept`, { option: 'B' })).status, 403);
  assert.equal((await api('other', 'POST', `/me/quote-requests/${requestId}/accept`, { option: 'B' })).body.error, 'forbidden');
  assert.equal((await api('client', 'POST', `/me/quote-requests/${requestId}/accept`, { option: 'D' })).body.error, 'invalid_quote_option');
  const accepted = await api('client', 'POST', `/me/quote-requests/${requestId}/accept`, { option: 'B' });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.quoteRequest.status, 'accepted');
  assert.equal(accepted.body.quoteRequest.acceptedOption, 'B');
  assert.equal((await api('client', 'POST', `/me/quote-requests/${requestId}/accept`, { option: 'A' })).body.error, 'quote_already_accepted');
  const cartId = accepted.body.cart.id;
  assert.equal(accepted.body.quoteRequest.cartId, cartId);
  const cart = (await api('client', 'GET', `/me/carts/${cartId}`)).body.cart;
  assert.equal(cart.lines.length, 1);
  const line = cart.lines[0];
  assert.equal(line.quantity, 2);
  assert.deepEqual(line.artworkAttachments.map(entry => entry.fileId), ['ref', 'ref2']);
  assert.equal(line.approvalMethod, 'drawn');
  const quote = await api('client', 'GET', `/me/carts/${cartId}/quote`);
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.quote.clientItemSubtotalMinor, options[1].clientPriceMinor);

  // The accepted spec is fixed; artwork and notes stay editable.
  assert.equal((await api('client', 'PATCH', `/me/carts/${cartId}/lines/${line.id}`, { quantity: 9 })).body.error, 'quote_line_locked');
  assert.equal((await api('client', 'PATCH', `/me/carts/${cartId}/lines/${line.id}`, { specialInstructions: 'Mount on the left wall' })).status, 200);
  const otherCart = (await api('client', 'POST', '/me/carts', { fulfillmentMode: 'delivery', defaultDropoff: DROPOFF })).body.cart;
  const again = await api('client', 'POST', `/me/carts/${otherCart.id}/lines`, { catalogItemId: opsView.options[1].catalogItemId, quantity: 1, optionIds: [] });
  assert.equal(again.body.error, 'quote_line_locked');
  const rejected = await api('client', 'POST', `/me/carts/${otherCart.id}/lines`, { catalogItemId: opsView.options[0].catalogItemId, quantity: 1, optionIds: [] });
  assert.equal(rejected.body.error, 'catalog_item_stale', 'the option not chosen no longer prices');

  // Checkout is the ordinary one: the shop's price is the item subtotal.
  const placed = await api('client', 'POST', `/me/carts/${cartId}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'receipt', reference: 'QUOTE-226' } });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const orderId = placed.body.order.id;
  assert.equal(placed.body.order.state, 'initial_payment_review');
  assert.equal(placed.body.invoice.lines[0].quantity, 2);
  store = await db.transaction(() => loadStore(db));
  const order = store.orders.find(row => row.id === orderId);
  assert.equal(order.supplierId, 'supplier');
  assert.equal(order.supplierSubtotalMinor, 120_000);
  assert.equal(order.supplierSubtotalMinor + order.serviceFeeMinor, options[1].clientPriceMinor);
  assert.equal(order.totalMinor, order.supplierSubtotalMinor + order.serviceFeeMinor + order.deliveryFeeMinor);
  assert.equal(order.approvalPolicy.method, 'drawn');
  const orderLine = store.orderLineItems.find(row => row.orderId === orderId);
  assert.equal(orderLine.lineSubtotalMinor, 120_000);
  assert.equal(orderLine.pricingUnitSnapshot, 'whole_job');
  assert.equal(orderLine.structuredSpecSnapshot.quoteRequestId, requestId);
  const request = store.quoteRequests.find(row => row.id === requestId);
  assert.equal(request.status, 'ordered');
  assert.equal(request.orderId, orderId);
  for (const action of ['quote_request.accept', 'quote_request.ordered', 'order_match.checkout']) assert.ok(store.auditLog.some(row => row.action === action), action);
  assert.equal((await api('client', 'GET', `/me/quote-requests/${requestId}`)).body.quoteRequest.orderId, orderId);

  // From here it is any other order: payment, file check, the shop, production.
  const transition = (state, key, body = {}) => api(key, 'POST', `/orders/${orderId}/transition`, { state, ...body });
  assert.equal((await api('ops', 'POST', `/orders/${orderId}/payments/initial/confirm`, { note: 'QR received' })).status, 200);
  const qaChecklist = { artwork: true, spec: true, quantity: true, address: true };
  const assigned = await transition('supplier_assigned', 'ops', { note: 'Artwork approved', qaChecklist });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const jobs = await api('supplier', 'GET', '/jobs');
  assert.equal(jobs.status, 200, JSON.stringify(jobs.body));
  assert.ok(jobs.body.jobs.some(job => job.id === orderId));
  const authorized = await transition('payment_authorized', 'supplier', { specialInstructionsRead: true });
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  const started = await transition('production', 'supplier');
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.order.state, 'production');
});

test('quote requests: options expire, cannot be accepted, are swept, and Operations can renew or cancel', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  await db.transaction(() => saveStore(db, setup()));
  const api = await apiForTest(t);

  // Validity comes from the Super Admin setting, through the version handshake.
  const settings = await api('admin', 'GET', '/settings');
  assert.equal(settings.body.settings.quoteValidityDays, 7);
  const body = { expectedVersion: settings.body.version, reason: 'Shorter quote validity', quoteValidityDays: 3 };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, quoteValidityDays: 0 })).body.error, 'invalid_quote_validity_days');
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, expectedVersion: body.expectedVersion - 1 })).body.error, 'settings_version_conflict');
  assert.equal((await api('admin', 'PATCH', '/settings', body)).status, 200);

  const { id, path, ops } = await published(api);
  assert.equal(Date.parse(ops.validUntil) - Date.parse(ops.publishedAt), 3 * 86_400_000);
  await db.query("UPDATE quote_requests SET valid_until = now() - interval '1 minute' WHERE id = $1", [id]);

  // Lapsed options read as expired at once and cannot be accepted.
  const read = await api('client', 'GET', `/me/quote-requests/${id}`);
  assert.equal(read.body.quoteRequest.status, 'expired');
  assert.ok(read.body.quoteRequest.options.every(option => option.acceptable === false));
  const refused = await api('client', 'POST', `/me/quote-requests/${id}/accept`, { option: 'A' });
  assert.equal(refused.status, 410);
  assert.equal(refused.body.error, 'quote_expired');
  let store = await db.transaction(() => loadStore(db));
  assert.equal(store.quoteRequests[0].status, 'expired');
  assert.ok(store.auditLog.some(row => row.action === 'quote_request.expire' && row.entityId === id));
  assert.ok(store.catalogItems.filter(item => item.quoteRequestId === id).every(item => item.active === false));
  assert.equal(store.notifications.filter(row => row.type === 'quote_expired').length, 1);

  // Operations renews it with a reason; the options price again.
  assert.equal((await api('ops', 'PUT', `${path}/validity`, { validUntil: new Date(Date.now() + 86_400_000).toISOString() })).status, 400);
  const renewed = await api('ops', 'PUT', `${path}/validity`, { validUntil: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Shop confirmed prices hold' });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(renewed.body.quoteRequest.status, 'published');
  const accepted = await api('client', 'POST', `/me/quote-requests/${id}/accept`, { option: 'A' });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

  // An accepted cart that outlives the validity cannot check out.
  await db.query("UPDATE quote_requests SET valid_until = now() - interval '1 minute' WHERE id = $1", [id]);
  const late = await api('client', 'POST', `/me/carts/${accepted.body.cart.id}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'receipt', reference: 'LATE' } });
  assert.equal(late.body.error, 'quote_expired');

  // The lifecycle sweep records the expiry without anyone reading it.
  const second = await published(api, brief({ size: '3 x 8 ft' }));
  await db.query("UPDATE quote_requests SET valid_until = now() - interval '1 minute' WHERE id = $1", [second.id]);
  await apiForTest(t);
  for (let attempt = 0; attempt < 200; attempt++) {
    store = await db.transaction(() => loadStore(db));
    if (store.quoteRequests.filter(row => row.status === 'expired').length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(store.quoteRequests.map(row => row.status), ['expired', 'expired']);
  assert.equal(store.auditLog.filter(row => row.action === 'quote_request.expire').length, 3);

  // Cancelling: the client closes an open request; Operations must give a reason.
  const third = await api('client', 'POST', '/me/quote-requests', brief({ size: '1 x 1 m' }));
  const thirdPath = `/ops/quote-requests/${third.body.quoteRequest.id}`;
  assert.equal((await api('ops', 'POST', `${thirdPath}/cancel`, {})).status, 400);
  const closed = await api('ops', 'POST', `${thirdPath}/cancel`, { reason: 'No shop can make this size' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.quoteRequest.status, 'cancelled');
  assert.equal((await api('client', 'POST', `/me/quote-requests/${third.body.quoteRequest.id}/cancel`, {})).body.error, 'quote_request_closed');
  const fourth = await api('client', 'POST', '/me/quote-requests', brief({ size: '2 x 2 m' }));
  const cancelled = await api('client', 'POST', `/me/quote-requests/${fourth.body.quoteRequest.id}/cancel`, { reason: 'Changed my mind' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.quoteRequest.status, 'cancelled');
  store = await db.transaction(() => loadStore(db));
  assert.equal(store.auditLog.filter(row => row.action === 'quote_request.cancel').length, 2);
  assert.equal(store.notifications.filter(row => row.type === 'quote_cancelled' && row.userId === 'client').length, 1);
});

test('quote request reads stay targeted: unrelated history does not grow what they read', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close()); await reset(db);
  await db.transaction(() => saveStore(db, setup()));
  const api = await apiForTest(t);
  const { id } = await published(api);
  const first = await api('client', 'GET', `/me/quote-requests/${id}`);
  const queue = await api('ops', 'GET', '/ops/quote-requests');
  // Ten thousand unrelated notifications; the quote reads never touch them.
  await db.query(`INSERT INTO notifications (id, user_id, type, created_at, position, data)
    SELECT 'ntf_noise_' || n, 'other', 'general', now(), n, '{}'::jsonb FROM generate_series(1, 10000) n`);
  assert.deepEqual((await api('client', 'GET', `/me/quote-requests/${id}`)).body, first.body);
  assert.deepEqual((await api('ops', 'GET', '/ops/quote-requests')).body, queue.body);
  const client = await loadHotReadStore(db, 'clerk_client', `/me/quote-requests/${id}`);
  const staff = await loadHotReadStore(db, 'clerk_ops', '/ops/quote-requests', { status: 'published' });
  for (const scoped of [client, staff]) {
    for (const key of ['notifications', 'auditLog', 'orders', 'catalogItems', 'files', 'cartLines']) assert.equal(scoped[key].length, 0, key);
    assert.deepEqual(scoped.quoteRequests.map(row => row.id), [id]);
  }
  assert.equal(client.quoteReplies.length, 0);
  assert.equal(staff.quoteReplies.length, 2);
  assert.deepEqual(staff.users.map(row => row.id).sort(), ['client', 'ops', 'replacement', 'supplier']);
  assert.deepEqual((await loadHotReadStore(db, 'clerk_ops', '/ops/quote-requests', { status: 'cancelled' })).quoteRequests, []);
});
