import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, saveStore, isHotReadPath } from '../src/postgres-store.js';
import { setupOrders, instrument } from './fixtures/order-reads.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { readParityEnv } from './fixtures/read-parity.js';
import { AT } from './fixtures/reschedule.js';

const skip = !process.env.DATABASE_URL;
async function setup(database) {
  const store = await setupOrders(database);
  store.clientPreferences.push({ userId: 'client', ranking: ['speed', 'cost', 'quality', 'distance'], version: 2, updatedAt: AT });
  store.clientAddresses.push({ id: 'address', clientId: 'client', label: 'Home', addressLine: 'Davao', point: { lat: 7.07, lng: 125.61 }, isDefault: true, version: 1, createdAt: AT, updatedAt: AT });
  store.clientAddresses.push({ ...store.clientAddresses[0], id: 'deleted_address', isDefault: false, deletedAt: AT });
  const deadline = new Date(Date.now() + 20 * 86400000).toISOString();
  for (const [id, state, clientId] of [['cart','draft','client'], ['single','draft','client'], ['done','checked_out','client'], ['foreign','draft','other'], ['dual_cart','draft','dual']]) {
    store.carts.push({ id, clientId, state, version: 2, serviceLevel: 'standard', fulfillmentMode: 'delivery', defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' },
      ...(state === 'checked_out' ? { checkedOutOrderId: 'order', checkedOutAt: AT } : {}), deadline, createdAt: AT, updatedAt: AT });
    for (const [index, supplierId] of (id === 'cart' ? ['supplier','replacement','supplier'] : ['supplier']).entries()) {
      store.cartLines.push({ id: `${id}_line_${index}`, cartId: id, supplierId, catalogItemId: `item_${supplierId}`, optionIds: [],
        quantity: 10, structuredSpec: {}, artworkFileId: 'art_a_active', specialInstructions: 'Keep these edges',
        deadline: index === 2 ? new Date(Date.parse(deadline) + 86400000).toISOString() : deadline,
        sortOrder: index, createdAt: AT, updatedAt: AT });
    }
  }
  const expiresAt = new Date(Date.now() + 40 * 86400000).toISOString();
  store.voucherCampaigns.push({ id: 'campaign', name: 'Fixture credit', code: 'FIXTURE', purpose: 'manual', mode: 'assigned', status: 'active', valueMinor: 500, totalLimit: 100, perAccountLimit: 1, validityDays: 30, createdAt: AT, updatedAt: AT });
  store.voucherCampaigns.push({ ...store.voucherCampaigns[0], id: 'campaign_reserved', code: 'RESERVED' });
  for (const [id, valueMinor] of [['available',500], ['reserved',1000]]) store.vouchers.push({ id, campaignId: id === 'reserved' ? 'campaign_reserved' : 'campaign', clientId: 'client', status: 'available', valueMinor, issuedAt: AT, expiresAt, emailAllowed: false, data: {} });
  store.voucherReservations.push({ id: 'reservation', voucherId: 'reserved', clientId: 'client', cartId: 'single', status: 'reserved', expiresAt, createdAt: AT, data: {} });
  store.voucherCartChoices.push({ id: 'single', voucherId: 'reserved', removed: false });
  store.baskets.push({ id: 'basket', clientId: 'client', receiptOrderId: 'order', orderIds: ['order','a_active'], totalMinor: 24000, fulfillmentMode: 'delivery', payment: { method: 'qr_manual', status: 'confirmed' }, createdAt: AT, updatedAt: AT });
  await database.transaction(() => saveStore(database, store));
}

test('cart reads preserve HTTP bytes, multi-shop anonymity, quotes, voucher reservations and checked-out baskets', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  const at = Date.now() + 120000;
  const baseline = await apiForTest(t, readParityEnv(true, at));
  const targeted = await apiForTest(t, readParityEnv(false, at));
  const paths = ['/me/preferences','/me/addresses', '/me/carts/cart', '/me/carts/single', '/me/carts/done', '/me/carts/foreign', '/me/carts/missing',
    '/me/carts/dual_cart', '/me/carts/cart/quote', '/me/carts/cart/voucher', '/me/carts/single/voucher',
    '/me/carts/done/quote', '/me/carts/cart/groups/cart_line_0/listings', '/me/carts/cart/groups/missing/listings'];
  for (const who of [null,'client','other','supplier','rider','ops','admin','test_ops','dual','suspended']) for (const path of paths) {
    for (const headers of [{}, { 'x-gridgo-role': 'client' }]) {
      const old = await baseline(who, 'GET', path, null, { raw: true, headers });
      const current = await targeted(who, 'GET', path, null, { raw: true, headers });
      assert.equal(current.status, old.status, `${who} ${path}`);
      assert.deepEqual(JSON.parse(current.body), JSON.parse(old.body), `${who} ${path}`);
      assert.equal(current.body, old.body, `${who} ${path}: serialized body`);
    }
  }
  const multi = await targeted('client','GET','/me/carts/cart');
  assert.equal(multi.status, 200);
  assert.equal(multi.body.cart.groups.length, 3);
  assert.ok(multi.body.cart.lines.every(line => !('supplierId' in line)));
  assert.equal((await targeted('client','GET','/me/carts/done')).body.cart.basketId, 'basket');
  assert.equal((await targeted('client','GET','/me/carts/single')).body.cart.clientQuote.voucher.id, 'reserved');
  assert.equal(multi.body.cart.clientQuote.voucher.id, 'available');
});

test('cart graph query count and rows ignore other clients and unrelated operational history', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setup(database);
  assert.ok(isHotReadPath('/me/carts/cart'));
  assert.equal(isHotReadPath('/me/carts/cart/checkout'), false);
  const sample = async () => {
    const { db, queries } = instrument(database);
    const store = await loadHotReadStore(db,'clerk_client','/me/carts/cart');
    assert.equal(store.carts.length, 1);
    assert.equal(store.cartLines.length, 3);
    assert.ok(queries.length <= 50, `queries=${queries.length}`);
    assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox|order_payments)\b/.test(q.sql)));
    await assert.rejects(database.transaction(() => saveStore(database,store)), /read-only/);
    return queries;
  };
  const before = await sample();
  await database.query(`INSERT INTO client_carts(id,client_id,state,version,service_level,fulfillment_mode,created_at,updated_at)
    SELECT 'growth_'||i,'other','draft',1,'standard','delivery',$1,$1 FROM generate_series(1,1000) i`,[AT]);
  await database.query(`INSERT INTO orders(id,client_id,state,created_at,updated_at,position)
    SELECT 'growth_'||i,'other','draft',$1,$1,1000+i FROM generate_series(1,1000) i`,[AT]);
  assert.deepEqual(await sample(), before);
});
