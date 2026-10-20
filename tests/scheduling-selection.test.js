import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller } from './fixtures/scheduling.js';

const offeredAt = '2026-10-19T05:29:00.000Z'; // 13:29 Manila; 1h + review + margin finishes 15:59
async function selectedCart() {
  const { store, client } = fixture();
  store.catalogItems.splice(1);
  Object.assign(store.catalogItems[0], { turnaroundMode: 'override', turnaroundHours: 2, minimumTurnaroundHours: 1 });
  const call = caller(store, client, offeredAt);
  const match = (await call('POST', '/me/matches', { subcategoryCode: 'flyers', fulfillmentMode: 'pickup', deadline: '2026-10-19T10:00:00Z', units: 1 })).body;
  const cartId = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart.id;
  return { store, client, match, cartId, call };
}
async function add(ctx, at = offeredAt) {
  return caller(ctx.store, ctx.client, at)('POST', `/me/carts/${ctx.cartId}/lines`, {
    selectToken: ctx.match.listings[0].selectToken, matchRequestId: ctx.match.matchRequestId,
    quantity: 1, optionIds: [], artworkFileId: 'file_art',
  });
}
const pay = { payment: { method: 'qr_manual', proofFileId: 'file_qr', reference: 'TOKEN-HONOUR' } };
for (const addAt of [offeredAt, '2026-10-19T05:31:00.000Z']) test(`offered Tight promise survives cutoff drift, including cart add at ${addAt}`, async () => {
  const ctx = await selectedCart(); await add(ctx, addAt);
  const checkout = await caller(ctx.store, ctx.client, '2026-10-19T05:43:59.999Z')('POST', `/me/carts/${ctx.cartId}/checkout`, pay);
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.order.readyBy, ctx.match.listings[0].readyBy);
  assert.deepEqual(checkout.body.order.scheduling, ctx.match.listings[0].scheduling);
  assert.equal(ctx.store.orders[0].readyBy, '2026-10-19T06:59:00.000Z');
});
test('at token expiry checkout rechecks and refuses the now-impossible deadline', async () => {
  const ctx = await selectedCart(); await add(ctx);
  await assert.rejects(caller(ctx.store, ctx.client, '2026-10-19T05:44:00.000Z')('POST', `/me/carts/${ctx.cartId}/checkout`, pay), { code: 'deadline_not_met' });
});
test('changing selected quantity does not extend an offered timing guarantee to changed work', async () => {
  const ctx = await selectedCart(); await add(ctx);
  ctx.store.cartLines[0].quantity = 100;
  await assert.rejects(caller(ctx.store, ctx.client, '2026-10-19T05:31:00.000Z')('POST', `/me/carts/${ctx.cartId}/checkout`, pay), { code: 'deadline_not_met' });
});

test('server-derived page measurements keep the selected offer after artwork is attached', async () => {
  const ctx = await selectedCart();
  ctx.store.catalogItems[0].pricingUnit = 'per_page';
  ctx.store.files.find(file => file.fileId === 'file_art').detected = { pageCount: 2 };
  await add(ctx);
  assert.deepEqual(ctx.store.cartLines[0].measurement, { pages: 2 });
  const read = await caller(ctx.store, ctx.client, '2026-10-19T05:31:00.000Z')('GET', `/me/carts/${ctx.cartId}`);
  assert.equal(read.body.cart.lines[0].promiseBy, ctx.match.listings[0].readyBy);
});


test('JSONB key reordering does not change an unchanged selection guarantee', async () => {
  const ctx = await selectedCart();
  await ctx.call('POST', `/me/carts/${ctx.cartId}/lines`, {
    selectToken: ctx.match.listings[0].selectToken, matchRequestId: ctx.match.matchRequestId,
    quantity: 1, optionIds: [], artworkFileId: 'file_art', structuredSpec: { zebra: 'value', a: { zz: 1, b: 2 } },
  });
  // PostgreSQL JSONB returns a canonical key order rather than insertion order.
  ctx.store.cartLines[0].structuredSpec = { a: { b: 2, zz: 1 }, zebra: 'value' };
  const checkout = await caller(ctx.store, ctx.client, '2026-10-19T05:31:00.000Z')('POST', `/me/carts/${ctx.cartId}/checkout`, pay);
  assert.equal(checkout.body.order.readyBy, ctx.match.listings[0].readyBy);
});
