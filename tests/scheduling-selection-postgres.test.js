import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { caller } from './fixtures/scheduling.js';

for (const expired of [false, true]) test(`selection guarantee survives SQL reload and ${expired ? 'expires' : 'honours offered timing'}`, { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const initial = fixture(); initial.orders = []; initial.orderJobs = []; initial.orderLineItems = [];
  initial.settings.hubPickupEnabled = true;
  initial.catalogItems[1].active = false;
  Object.assign(initial.catalogItems[0], { turnaroundMode: 'override', turnaroundHours: 2, minimumTurnaroundHours: 1 });
  for (const [fileId, purpose, type] of [['art', 'artwork', 'application/pdf'], ['qr', 'payment_proof', 'image/png']]) initial.files.push({
    fileId, ownerId: 'client', purpose, state: 'ready', objectKey: `private/${fileId}`, originalFilename: fileId,
    declaredContentType: type, detectedContentType: type, size: 100, createdAt: AT,
    ...(purpose === 'artwork' ? { artworkCheck: { status: 'passed', checkedAt: AT } } : {}) });
  await db.transaction(() => saveStore(db, initial));
  const at = '2026-10-19T05:29:00.000Z';
  let match, cartId;
  await db.transaction(async () => {
    const store = await loadStore(db), call = caller(store, store.users.find(u => u.id === 'client'), at);
    match = (await call('POST', '/me/matches', { subcategoryCode: 'flyers', fulfillmentMode: 'pickup', deadline: '2026-10-19T10:00:00Z', units: 1 })).body;
    cartId = (await call('POST', '/me/carts', { fulfillmentMode: 'pickup' })).body.cart.id;
    await saveStore(db, store);
  });
  await db.transaction(async () => {
    const store = await loadStore(db), call = caller(store, store.users.find(u => u.id === 'client'), '2026-10-19T05:31:00.000Z');
    await call('POST', `/me/carts/${cartId}/lines`, { selectToken: match.listings[0].selectToken,
      matchRequestId: match.matchRequestId, quantity: 1, optionIds: [], artworkFileId: 'art',
      structuredSpec: { zebra: 'value', a: { zz: 1, b: 2 } } });
    await saveStore(db, store);
  });
  const checkout = () => db.transaction(async () => {
    const store = await loadStore(db), call = caller(store, store.users.find(u => u.id === 'client'), expired ? '2026-10-19T05:44:00Z' : '2026-10-19T05:43:59.999Z');
    const cart = (await call('GET', `/me/carts/${cartId}`)).body.cart;
    if (!expired) {
      assert.equal(cart.groups[0].readyBy, match.listings[0].readyBy);
      assert.equal(cart.lines[0].promiseBy, match.listings[0].readyBy);
    }
    const result = await call('POST', `/me/carts/${cartId}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'qr', reference: 'PERSISTED' } });
    assert.equal(result.body.order.readyBy, match.listings[0].readyBy);
    await saveStore(db, store);
  });
  if (expired) await assert.rejects(checkout(), { code: 'deadline_not_met' });
  else await checkout();
});
