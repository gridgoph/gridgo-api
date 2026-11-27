import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, actors, id, AT } from './fixtures/reschedule.js';
import { defaultTaxonomy } from '../src/taxonomy.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { routeExpressOrders } from '../src/express-routes.js';
import { serviceFeeMoney, DEFAULT_SERVICE_FEE_SCHEDULE } from '../src/service-fee.js';

const EXPRESS_FEE = { version: 3, rule: 'express_minimum_or_rate', minimumMinor: 500, rateBps: 2000, roundTotalUpToMinor: 50 };

test('the database Express fee rule matches the application to the centavo; brackets are unchanged', { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
  for (let principal = 0; principal <= 6000; principal += 7) {
    const sql = await db.query('SELECT gridgo_service_fee($1,$2)::bigint AS fee', [principal, EXPRESS_FEE]);
    assert.equal(Number(sql.rows[0].fee), serviceFeeMoney(principal, EXPRESS_FEE).grossServiceFeeMinor, `principal ${principal}`);
  }
  for (const principal of [50000, 199900, 2000000]) {
    const sql = await db.query('SELECT gridgo_service_fee($1,$2)::bigint AS fee', [principal, DEFAULT_SERVICE_FEE_SCHEDULE]);
    assert.equal(Number(sql.rows[0].fee), serviceFeeMoney(principal, DEFAULT_SERVICE_FEE_SCHEDULE).grossServiceFeeMinor);
  }
  await assert.rejects(db.query('SELECT gridgo_service_fee(100,$1)', [{ ...EXPRESS_FEE, roundTotalUpToMinor: 100 }]), /invalid express fee rule/);
  await assert.rejects(db.query('SELECT gridgo_service_fee(100,$1)', [{ ...EXPRESS_FEE, rateBps: 10001 }]), /invalid express fee rule/);
});

test('accept-first send, automatic reroute, acceptance and QR payment survive PostgreSQL round trips', { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  Object.assign(store, { orders: [], orderJobs: [], orderLineItems: [], orderLineItemOptions: [], orderInvoices: [], taxonomy: defaultTaxonomy() });
  for (const service of store.supplierServices) service.categoryCode = 'document_publication';
  for (const item of store.catalogItems) Object.assign(item, { subcategoryCode: 'document_printing', express: true, pricingUnit: 'per_page', printLayouts: ['fit_to_paper'], basePriceMinor: 300 });
  store.supplierProfiles.find(p => p.userId === 'replacement').shop = { lat: 7.062, lng: 125.601, label: 'Second counter' };
  store.files.push({ fileId: 'af_art', ownerId: 'client', purpose: 'artwork', state: 'ready', objectKey: 'client/af.pdf', declaredContentType: 'application/pdf', detectedContentType: 'application/pdf',
    originalFilename: 'af.pdf', size: 100, createdAt: AT, detected: { pageCount: 12 }, artworkCheck: { status: 'passed' }, references: [] },
  { fileId: 'af_qr', ownerId: 'client', purpose: 'payment_proof', state: 'ready', objectKey: 'client/af-qr.jpg', declaredContentType: 'image/jpeg', detectedContentType: 'image/jpeg',
    originalFilename: 'qr.jpg', size: 100, createdAt: AT, references: [] });
  const call = (path, body) => routeOrderMatch({ req: { method: 'POST' }, url: new URL(`http://test${path}`), store, user: actors.client, readBody: async () => body, id, now: () => AT });
  const draft = await call('/express/drafts', { acceptFirst: true, supplierId: 'supplier', location: { lat: 7.06, lng: 125.6 }, fulfillmentMode: 'pickup',
    files: [{ fileId: 'af_art', copies: 1, colour: 'bw', paper: 'a4', sides: 'one', layout: 'fit_to_paper', acceptedWarnings: [] }] });
  const placed = await call(`/me/carts/${draft.body.cartId}/checkout`, { looksRight: true, expressConfirmation: draft.body.confirmation });
  await db.transaction(() => saveStore(db, store));
  let loaded = await db.transaction(() => loadStore(db));
  const first = loaded.orders.find(o => o.id === placed.body.order.id);
  assert.equal(first.state, 'supplier_assigned');
  assert.equal(first.serviceFeeSchedule.version, 3);
  assert.equal(first.grossServiceFeeMinor, 750);
  assert.equal(first.totalMinor, 4350);
  await assert.rejects(db.query(`UPDATE orders SET data=jsonb_set(data,'{grossServiceFeeMinor}','800') WHERE id=$1`, [first.id]), /express fee snapshot|immutable/);

  const express = (action, user, orderId, body, at = AT) => routeExpressOrders({ req: { method: 'POST' }, url: new URL(`http://test/orders/${orderId}/express/${action}`),
    store: loaded, user, readBody: async () => body, id, now: () => at });
  await express('decline', actors.supplier, first.id, { reason: 'Out of toner' });
  await db.transaction(() => saveStore(db, loaded));
  loaded = await db.transaction(() => loadStore(db));
  const old = loaded.orders.find(o => o.id === first.id);
  assert.equal(old.state, 'cancelled');
  assert.equal(old.expressOrder.reroute.status, 'moved');
  const next = loaded.orders.find(o => o.id === old.expressOrder.reroute.nextOrderId);
  assert.equal(next.supplierId, 'replacement');
  assert.equal(next.totalMinor, 4350);
  assert.equal(next.expressOrder.requestId, first.id);
  assert.equal(next.state, 'supplier_assigned');

  await express('accept', actors.replacement, next.id, {}, '2026-10-05T00:00:30.000Z');
  await express('pay', actors.client, next.id, { method: 'qr_ph', reference: 'AF-PG-1', proofFileId: 'af_qr' }, '2026-10-05T00:01:00.000Z');
  await db.transaction(() => saveStore(db, loaded));
  loaded = await db.transaction(() => loadStore(db));
  const paid = loaded.orders.find(o => o.id === next.id);
  assert.equal(paid.state, 'payment_authorized');
  assert.equal(paid.payments.initial.status, 'pending_confirmation');
  assert.equal(paid.expressOrder.paymentRelease.kind, 'receipt_under_limit');
});

test('only Super Admin changes the Express checkout rules; other roles never read them', { skip: !process.env.DATABASE_URL }, async t => {
  const { parityApiForTest } = await import('./fixtures/read-parity.js');
  const database = createDatabase(process.env); t.after(() => database.close());
  await resetDatabase(database, 'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(); store.taxonomy = defaultTaxonomy();
  await database.transaction(() => saveStore(database, store));
  const api = await parityApiForTest(t, false, Date.parse(AT));
  let settings = await api('admin', 'GET', '/settings');
  assert.deepEqual(settings.body.settings.expressCheckout, { feeMinimumMinor: 500, feeRateBps: 2000, paymentConfirmation: 'manual',
    manualQrInstantMaxMinor: 30000, manualQrReviewMinutes: 3, manualQrReviewOpens: '08:00', manualQrReviewCloses: '17:00' });
  const version = settings.body.version;
  const ops = await api('ops', 'PATCH', '/settings', { expectedVersion: version, reason: 'Try the fee', expressCheckout: { feeMinimumMinor: 600 } });
  assert.equal(ops.status, 403);
  const gateway = await api('admin', 'PATCH', '/settings', { expectedVersion: version, reason: 'Switch confirmation', expressCheckout: { paymentConfirmation: 'gateway' } });
  assert.equal(gateway.status, 409); assert.equal(gateway.body.error, 'payment_gateway_not_configured');
  const invalid = await api('admin', 'PATCH', '/settings', { expectedVersion: version, reason: 'Bad rate', expressCheckout: { feeRateBps: 20000 } });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'invalid_express_checkout_settings');
  const changed = await api('admin', 'PATCH', '/settings', { expectedVersion: version, reason: 'Raise the Express minimum', expressCheckout: { feeMinimumMinor: 600, manualQrInstantMaxMinor: 25000 } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const loaded = await database.transaction(() => loadStore(database));
  assert.deepEqual(loaded.settings.expressCheckout, { feeMinimumMinor: 600, feeRateBps: 2000, paymentConfirmation: 'manual',
    manualQrInstantMaxMinor: 25000, manualQrReviewMinutes: 3, manualQrReviewOpens: '08:00', manualQrReviewCloses: '17:00' });
  const client = await api('client', 'GET', '/settings');
  assert.equal(JSON.stringify(client.body).includes('expressCheckout'), false);
});
