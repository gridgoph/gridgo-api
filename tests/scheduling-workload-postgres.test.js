import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { routeOrderMatch, prepareArtworkCheckout } from '../src/order-match-routes.js';

for (const scenario of ['reverse_add', 'edit_earlier', 'edit_before_add', 'delete_earlier', 'unchanged', 'external_queue']) {
  test(`selection workload binding across SQL reloads: ${scenario}`, { skip: !process.env.DATABASE_URL }, async t => {
    const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL }); t.after(() => db.close());
    await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
    const initial = fixture(); initial.orders = []; initial.orderJobs = []; initial.orderLineItems = [];
    initial.settings.hubPickupEnabled = true; initial.catalogItems[1].active = false;
    Object.assign(initial.catalogItems[0], { turnaroundMode: 'override', turnaroundHours: scenario === 'reverse_add' ? 2 : 1, minimumTurnaroundHours: 1 });
    for (const [fileId, purpose, type] of [['art','artwork','application/pdf'],['qr','payment_proof','image/png']]) initial.files.push({
      fileId, ownerId: 'client', purpose, state: 'ready', objectKey: `private/${fileId}`, originalFilename: fileId,
      declaredContentType: type, detectedContentType: type, size: 100, createdAt: AT,
      ...(purpose === 'artwork' ? { artworkCheck: { status: 'passed', checkedAt: AT } } : {}) });
    await db.transaction(() => saveStore(db, initial));
    const at = scenario === 'reverse_add' ? '2026-10-19T05:29:00Z' : '2026-10-19T04:29:00Z';
    let sequence = 0;
    const request = (method, pathname, body = {}, clock = at) => db.transaction(async () => {
      const store = await loadStore(db), user = store.users.find(row => row.id === 'client'), req = { method };
      await prepareArtworkCheckout({ req, pathname, store, user, checker: async () => ({ ok: true }) });
      const response = await routeOrderMatch({ req, url: new URL(pathname, 'http://test'), store, user, readBody: async () => body,
        id: prefix => `${prefix}_${++sequence}`, now: () => clock });
      await saveStore(db, store); return response.body;
    });
    const cartId = (await request('POST', '/me/carts', { fulfillmentMode: 'pickup' })).cart.id;
    const offer = deadline => request('POST', '/me/matches', { cartId, subcategoryCode: 'flyers', fulfillmentMode: 'pickup', units: 1, deadline });
    const add = match => request('POST', `/me/carts/${cartId}/lines`, { selectToken: match.listings[0].selectToken,
      matchRequestId: match.matchRequestId, quantity: 1, optionIds: [], artworkFileId: 'art' });
    let early, later;
    if (scenario === 'reverse_add') {
      later = await offer('2026-10-19T10:00:00Z'); await add(later);
      early = await offer('2026-10-19T09:00:00Z'); await add(early);
    } else {
      early = await offer('2026-10-19T09:00:00Z'); await add(early);
      later = await offer('2026-10-19T10:00:00Z');
      if (scenario !== 'edit_before_add') await add(later);
      if (scenario.startsWith('edit') || scenario === 'delete_earlier') {
        const store = await loadStore(db), line = store.cartLines.find(row => row.deadline === '2026-10-19T09:00:00.000Z');
        await request(scenario === 'delete_earlier' ? 'DELETE' : 'PATCH', `/me/carts/${cartId}/lines/${line.id}`, { quantity: 2 });
      }
      if (scenario === 'edit_before_add') await add(later);
    }
    if (scenario === 'external_queue') await db.transaction(async () => {
      const store = await loadStore(db), template = fixture();
      store.orders.push({ ...template.orders[0], id: 'external', readyBy: '2099-01-01T00:00:00Z' });
      store.orderJobs.push({ ...template.orderJobs[0], id: 'external_job', orderId: 'external', estimatedHours: 80, estimatedProductionMinutes: 4800 });
      await saveStore(db, store);
    });
    const before = (await db.query('SELECT * FROM orders ORDER BY id')).rows;
    const checkout = () => request('POST', `/me/carts/${cartId}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'qr', reference: 'WORKLOAD' } },
      scenario === 'reverse_add' ? at : '2026-10-19T04:31:00Z');
    if (['reverse_add', 'edit_earlier', 'edit_before_add'].includes(scenario)) {
      await assert.rejects(checkout(), { code: 'deadline_not_met' });
      assert.deepEqual((await db.query('SELECT * FROM orders ORDER BY id')).rows, before, 'failed basket checkout rolls back every new order');
    } else {
      await checkout();
      const orders = (await loadStore(db)).orders.filter(row => row.id !== 'external');
      const late = orders.find(row => row.deadline === '2026-10-19T10:00:00.000Z');
      assert.equal(late.promiseBy, scenario === 'delete_earlier' ? '2026-10-19T07:01:00.000Z' : later.listings[0].readyBy);
      if (scenario !== 'delete_earlier') assert.equal(orders.find(row => row !== late).promiseBy, early.listings[0].readyBy);
    }
  });
}
