import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { parityApiForTest } from './fixtures/read-parity.js';
import { defaultTaxonomy } from '../src/taxonomy.js';

const skip = !process.env.DATABASE_URL;

async function setup(t) {
  const database = createDatabase(process.env);
  t.after(() => database.close());
  await resetDatabase(database, 'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  for (const key of ['orders', 'orderJobs', 'orderLineItems', 'orderLineItemOptions', 'orderInvoices']) store[key] = [];
  store.taxonomy = defaultTaxonomy();
  for (const service of store.supplierServices) service.categoryCode = 'document_publication';
  for (const item of store.catalogItems) Object.assign(item, {
    subcategoryCode: 'document_printing', express: true, pricingUnit: 'per_page', printLayouts: ['fit_to_paper'],
  });
  store.files.push({ fileId: 'express_art', ownerId: 'client', purpose: 'artwork', state: 'ready',
    objectKey: 'client/express.pdf', declaredContentType: 'application/pdf', detectedContentType: 'application/pdf',
    originalFilename: 'express.pdf', size: 100, createdAt: AT, detected: { pageCount: 4 }, artworkCheck: { status: 'passed' }, references: [] },
  { fileId: 'express_qr', ownerId: 'client', purpose: 'payment_proof', state: 'ready', objectKey: 'client/qr.jpg',
    declaredContentType: 'image/jpeg', detectedContentType: 'image/jpeg', originalFilename: 'qr.jpg', size: 100, createdAt: AT, references: [] });
  await database.transaction(() => saveStore(database, store));
  // Monday, 08:00 Manila: independent of the host clock and shop opening hours.
  const api = await parityApiForTest(t, false, Date.parse(AT));
  return { database, api };
}

for (const fulfillmentMode of ['pickup', 'delivery']) {
  test(`Express ${fulfillmentMode} draft survives HTTP reads, quote and checkout`, { skip }, async t => {
    const { database, api } = await setup(t);
    const location = { lat: 7.06, lng: 125.6, label: 'Client location' };
    const pages = fulfillmentMode === 'delivery' ? 3 : 4;
    const range = fulfillmentMode === 'delivery' ? '1-3' : null;
    const principalMinor = pages * 2 * 500;
    const note = fulfillmentMode === 'delivery' ? 'Keep each copy together' : '';
    const drafted = await api('client', 'POST', '/express/drafts', {
      supplierId: 'supplier', location, fulfillmentMode,
      ...(fulfillmentMode === 'delivery' ? { dropoff: { lat: 7.07, lng: 125.61, label: 'House' } } : {}),
      files: [{ fileId: 'express_art', copies: 2, colour: 'colour', paper: 'a4', sides: 'two',
        layout: 'fit_to_paper', pageRange: range, note, acceptedWarnings: ['paper_size_mismatch', 'rgb_colour'] }],
    });
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
    const cartId = drafted.body.cartId;
    const print = { colour: 'colour', paper: 'a4', paperStock: null, sides: 'two', rateMinor: 500,
      acceptedWarnings: ['paper_size_mismatch', 'rgb_colour'] };
    // Both full mutation loads and the lazy CART_READ graph must retain the same facts.
    for (const loaded of [await loadStore(database), await loadHotReadStore(database, 'clerk_client', `/me/carts/${cartId}`)]) {
      const cart = loaded.carts.find(row => row.id === cartId);
      assert.equal(cart.orderType, 'express');
      assert.deepEqual(cart.expressLocation, location);
      assert.deepEqual(loaded.cartLines.find(row => row.cartId === cartId).expressPrint, print);
    }
    const settings = await api('admin', 'GET', '/settings');
    const changedRates = await api('admin', 'PATCH', '/settings', { expectedVersion: settings.body.version,
      reason: 'Verify draft page-rate lock', expressRates: { bwMinor: 400, colourMinor: 600 } });
    assert.equal(changedRates.status, 200, JSON.stringify(changedRates.body));
    const read = await api('client', 'GET', `/me/carts/${cartId}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.cart.clientQuote.totalMinor, drafted.body.quote.totalMinor);
    assert.equal(read.body.cart.lines[0].lineSubtotalMinor, principalMinor); // Printed pages × copies × locked PHP 5.
    const lineId = read.body.cart.lines[0].id;
    const edit = await api('client', 'PATCH', `/me/carts/${cartId}/lines/${lineId}`, { quantity: 99 });
    assert.equal(edit.status, 409);
    assert.equal(edit.body.error, 'express_draft_replace_required');
    const voucher = await api('client', 'DELETE', `/me/carts/${cartId}/voucher`);
    assert.equal(voucher.status, 200, JSON.stringify(voucher.body));
    const quote = await api('client', 'GET', `/me/carts/${cartId}/quote`);
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.quote.totalMinor, drafted.body.quote.totalMinor);
    assert.equal(quote.body.quote.serviceFeeMinor, undefined);
    const checkout = { looksRight: true, expressConfirmation: drafted.body.confirmation,
      payment: { method: 'qr_manual', reference: `EXPRESS-${fulfillmentMode}`, proofFileId: 'express_qr' } };
    for (const invalid of [{ ...checkout, looksRight: false }, { ...checkout, expressConfirmation: 'stale' }]) {
      const refused = await api('client', 'POST', `/me/carts/${cartId}/checkout`, invalid);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, 'express_preview_required');
    }
    const placed = await api('client', 'POST', `/me/carts/${cartId}/checkout`, checkout);
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(placed.body.order.orderType, 'express');
    assert.equal(placed.body.order.totalMinor, drafted.body.quote.totalMinor);
    assert.equal(placed.body.order.expressOrder.pickupCode, undefined);
    let loaded = await loadStore(database);
    const order = loaded.orders.find(row => row.id === placed.body.order.id);
    assert.equal(order.orderType, 'express');
    assert.equal(order.supplierSubtotalMinor, principalMinor);
    assert.equal(order.expressOrder.originalSupplierId, 'supplier');
    assert.deepEqual(order.expressOrder.location, location);
    assert.match(order.expressOrder.pickupCode, /^\d{6}$/);
    assert.deepEqual(order.expressOrder.printSettings, [{ fileId: 'express_art', pages: { total: 4, range, printed: pages },
      copies: 2, colour: 'colour', paper: 'a4', paperStock: null, sides: 'two', layout: 'fit_to_paper', note,
      acceptedWarnings: ['paper_size_mismatch', 'rgb_colour'] }]);
    const line = loaded.orderLineItems.find(row => row.orderId === order.id);
    assert.deepEqual(line.expressPrint, print);
    assert.equal(line.effectiveUnitPriceMinor, 500);
    assert.equal(line.lineSubtotalMinor, principalMinor);
    await assert.rejects(database.query(`UPDATE order_line_items SET express_print = jsonb_set(express_print, '{rateMinor}', '999') WHERE id = $1`, [line.id]), /Express line print snapshot is immutable/);
    // Start acceptance through the real payment and Operations artwork handoff.
    const paid = await api('ops', 'POST', `/orders/${order.id}/payments/downpayment/confirm`, {});
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const assigned = await api('ops', 'POST', `/orders/${order.id}/transition`, { state: 'supplier_assigned' });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    loaded = await loadStore(database);
    const acceptance = loaded.orders.find(row => row.id === order.id).shopAcceptance;
    assert.equal(acceptance.status, 'pending');
    assert.equal(Date.parse(acceptance.deadlineAt) - Date.parse(acceptance.assignedAt), 300000);
    assert.equal((await api('client', 'GET', `/orders/${order.id}`)).body.order.expressOrder.acceptBy, acceptance.deadlineAt);
  });
}

test('ordinary HTTP cart retains custom page pricing after PostgreSQL round trips', { skip }, async t => {
  const { database, api } = await setup(t);
  const created = await api('client', 'POST', '/me/carts', {});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const cartId = created.body.cart.id;
  const match = await api('client', 'POST', '/me/matches', { cartId, subcategoryCode: 'document_printing', units: 2,
    measurement: { pages: 4 }, deadline: '2026-10-24T01:00:00.000Z', fulfillmentMode: 'delivery',
    dropoff: { lat: 7.07, lng: 125.61, label: 'House' } });
  assert.equal(match.status, 200, JSON.stringify(match.body));
  assert.ok(match.body.listings.length);
  const added = await api('client', 'POST', `/me/carts/${cartId}/lines`, { selectToken: match.body.listings[0].selectToken,
    matchRequestId: match.body.matchRequestId, quantity: 2, measurement: { pages: 4 }, artworkFileId: 'express_art', printLayout: 'fit_to_paper', optionIds: [] });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const read = await api('client', 'GET', `/me/carts/${cartId}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.cart.lines[0].lineSubtotalMinor, 8000); // Ordinary listing: PHP 10 per page.
  assert.deepEqual(read.body.cart.clientQuote, added.body.cart.clientQuote);
  const loaded = await loadStore(database);
  assert.equal(Object.hasOwn(loaded.carts.find(row => row.id === cartId), 'orderType'), false);
  assert.equal(Object.hasOwn(loaded.carts.find(row => row.id === cartId), 'expressLocation'), false);
  assert.equal(Object.hasOwn(loaded.cartLines.find(row => row.cartId === cartId), 'expressPrint'), false);
});
