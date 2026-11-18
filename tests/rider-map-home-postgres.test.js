import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
const DATABASE_URL = process.env.DATABASE_URL;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
async function setup(t, mutate = () => {}, env = {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  for (const key of ['rider2', 'rider3']) {
    store.users.push({ ...store.users.find(u => u.id === 'rider'), id: key, clerkUserId: `clerk_${key}`, email: `${key}@example.invalid` });
    store.userRoleMemberships.push({ userId: key, role: 'rider', createdAt: AT });
  }
  store.orders[0].state = 'ready_for_dispatch';
  mutate(store);
  await db.transaction(() => saveStore(db, store));
  const edit = fn => db.transaction(async () => { const s = await loadStore(db); fn(s); await saveStore(db, s); });
  return { db, api: await apiForTest(t, env), edit };
}
test('Operations countdown-only settings handshake, validation and immutable per-offer timeout', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t);
  const initial = ok(await api('ops', 'GET', '/settings'));
  const first = ok(await api('rider', 'GET', '/dispatch/offers')).offers[0];
  assert.equal(first.dispatchOffer.timeoutSeconds, 30);
  const updated = ok(await api('ops', 'PATCH', '/settings', { expectedVersion: initial.version, reason: 'Longer offer window', riderOfferTimeoutSeconds: 60 }));
  assert.equal(updated.settings.riderOfferTimeoutSeconds, 60);
  assert.equal(updated.version, initial.version + 1);
  assert.equal((await api('ops', 'PATCH', '/settings', { expectedVersion: initial.version, reason: 'Stale', riderOfferTimeoutSeconds: 40 })).status, 409);
  for (const value of [null, 9, 121, 30.5, '30']) assert.equal((await api('ops', 'PATCH', '/settings', { expectedVersion: updated.version, reason: 'Invalid', riderOfferTimeoutSeconds: value })).status, 400);
  assert.equal((await api('ops', 'PATCH', '/settings', { expectedVersion: updated.version, reason: 'Overreach', riderOfferTimeoutSeconds: 40, riderCommissionBps: 8000 })).status, 403);
  assert.equal((await api('client', 'PATCH', '/settings', { expectedVersion: updated.version, reason: 'No', riderOfferTimeoutSeconds: 40 })).status, 403);
  const unchanged = ok(await api('rider', 'GET', '/dispatch/offers')).offers[0];
  assert.deepEqual(unchanged.dispatchOffer, first.dispatchOffer);
});
test('exclusive offers scope reads; decline and expiry cascade, stale accept fails, final rider accepts atomically', { skip: !DATABASE_URL }, async t => {
  const { db, api, edit } = await setup(t);
  const first = ok(await api('rider', 'GET', '/dispatch/offers')).offers[0];
  assert.equal(first.riderPayoutMinor, 850);
  assert.equal(first.cargoSummary.totalQuantity, 10);
  assert.equal(first.travelEstimate.durationSeconds, null);
  assert.equal(first.dispatchOffer.timeoutSeconds, 30);
  assert.deepEqual(ok(await api('rider2', 'GET', '/dispatch/offers')).offers, []);
  assert.equal((await api('rider2', 'GET', '/orders/order')).status, 403);
  assert.equal((await api('rider2', 'POST', '/dispatch/order/accept', {})).status, 409);
  const body = { offerId: first.dispatchOffer.id };
  ok(await api('rider', 'POST', '/dispatch/order/decline', body));
  ok(await api('rider', 'POST', '/dispatch/order/decline', body));
  const second = ok(await api('rider2', 'GET', '/dispatch/offers')).offers[0];
  assert.equal(second.dispatchOffer.riderId, 'rider2');
  assert.equal((await api('rider', 'POST', '/dispatch/order/accept', body)).status, 409);
  await edit(s => { s.orders[0].dispatchOffer.expiresAt = new Date(Date.now() - 1000).toISOString(); });
  const third = ok(await api('rider3', 'GET', '/dispatch/offers')).offers[0];
  assert.equal(third.dispatchOffer.riderId, 'rider3');
  const accepted = ok(await api('rider3', 'POST', '/dispatch/order/accept', { offerId: third.dispatchOffer.id })).order;
  assert.equal(accepted.state, 'rider_assigned');
  const saved = (await loadStore(db)).orders[0];
  assert.equal(saved.riderId, 'rider3');
  assert.deepEqual(saved.dispatchOfferAttempts.map(a => a.status), ['declined', 'expired', 'accepted']);
  assert.equal(saved.riderCommissionBps, 8500);
  assert.equal(saved.totalMinor, 12000);
});
test('all riders decline: one durable exhaustion alert per staff membership and no automatic restart', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  for (const key of ['rider', 'rider2', 'rider3']) {
    const offer = ok(await api(key, 'GET', '/dispatch/offers')).offers[0];
    ok(await api(key, 'POST', '/dispatch/order/decline', { offerId: offer.dispatchOffer.id }));
  }
  for (const key of ['rider', 'rider2', 'rider3']) assert.deepEqual(ok(await api(key, 'GET', '/dispatch/offers')).offers, []);
  const store = await loadStore(db);
  assert.deepEqual(store.notifications.filter(n => n.type === 'dispatch_offer_exhausted').map(n => n.appRole).sort(), ['ops_admin', 'super_admin']);
  assert.equal(store.orders[0].dispatchOffer.status, 'exhausted');
});
test('digital receipt signature commits with delivery, is immutable, notifies client and both staff roles, and keeps file private', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, store => {
    Object.assign(store.orders[0], { state: 'out_for_delivery', riderId: 'rider', riderAssignedAt: AT,
      riderProgress: { riderId: 'rider', assignedAt: AT, events: { arrived: AT } } });
    for (const [fileId, purpose, refs] of [['drop', 'delivery_photo', true], ['ar-sign', 'acknowledgement_signature', false], ['foreign', 'acknowledgement_signature', false]]) {
      store.files.push({ fileId, ownerId: fileId === 'foreign' ? 'rider2' : 'rider', purpose, state: 'ready', objectKey: `private/${fileId}`,
        originalFilename: 'sign.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT,
        references: refs ? [{ type: 'order', id: 'order', field: 'deliveryPhotoFileIds' }] : [] });
    }
  });
  const path = '/orders/order/acknowledgement-receipt';
  const issued = ok(await api('rider', 'POST', path, {}), 201).receipt;
  let attached;
  for (let n = 0; n < 100; n++) {
    attached = await api('rider', 'POST', '/files/ar-sign/attach', { orderId: 'order' });
    if (attached.body.error !== 'storage_initializing') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  ok(attached);
  const delivery = { evidenceType: 'photo', evidenceFileId: 'drop', acknowledgementSignature: { fileId: 'ar-sign', signerName: 'Client Recipient', arNumber: issued.arNumber } };
  const rejected = await api('rider', 'POST', '/dispatch/order/delivery', { ...delivery, acknowledgementSignature: { ...delivery.acknowledgementSignature, fileId: 'foreign' } });
  assert.equal(rejected.status, 400);
  assert.equal((await loadStore(db)).orders[0].state, 'out_for_delivery');
  const completed = ok(await api('rider', 'POST', '/dispatch/order/delivery', delivery));
  assert.equal(completed.order.acknowledgementSignature, undefined);
  const client = ok(await api('client', 'GET', '/orders/order')).order;
  const ops = ok(await api('ops', 'GET', '/orders/order')).order;
  assert.equal(client.acknowledgementSignature.fileId, 'ar-sign');
  assert.deepEqual(ops.acknowledgementSignature, client.acknowledgementSignature);
  const read = ok(await api('client', 'GET', path));
  assert.deepEqual(read.receipt, issued);
  assert.deepEqual(read.signature, client.acknowledgementSignature);
  assert.match(read.invoiceNote, /official invoice.*GRIDGO/i);
  assert.equal((await api('client', 'GET', '/files/ar-sign')).status, 200);
  assert.equal((await api('ops', 'GET', '/files/ar-sign')).status, 200);
  for (const key of ['supplier', 'other', 'rider2']) assert.equal((await api(key, 'GET', '/files/ar-sign')).status, 403, key);
  const s = await loadStore(db);
  assert.deepEqual(s.notifications.filter(n => n.type === 'acknowledgement_receipt_signed').map(n => n.appRole).sort(), ['client', 'ops_admin', 'super_admin']);
  const snapshot = (await db.query('SELECT snapshot FROM acknowledgement_receipts WHERE order_id=$1', ['order'])).rows[0].snapshot;
  assert.deepEqual(snapshot, issued);
  await assert.rejects(db.query("UPDATE orders SET data = data - 'acknowledgementSignature' WHERE id='order'"), /immutable/i);
});

test('expiry advances without app polling; independent API replicas preserve the reservation and serialize accept', { skip: !DATABASE_URL }, async t => {
  const { db, api, edit } = await setup(t);
  const first = ok(await api('rider', 'GET', '/dispatch/offers')).offers[0];
  const replica = await apiForTest(t);
  assert.deepEqual(ok(await replica('rider', 'GET', '/dispatch/offers')).offers[0].dispatchOffer, first.dispatchOffer);
  await edit(s => { s.orders[0].dispatchOffer.expiresAt = new Date(Date.now() - 1000).toISOString(); });
  let saved;
  for (let n = 0; n < 60; n++) {
    saved = (await loadStore(db)).orders[0];
    if (saved.dispatchOffer.riderId === 'rider2') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(saved.dispatchOffer.riderId, 'rider2');
  const body = { offerId: saved.dispatchOffer.id };
  const attempts = await Promise.all([api('rider2', 'POST', '/dispatch/order/accept', body), replica('rider2', 'POST', '/dispatch/order/accept', body)]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
  assert.equal((await loadStore(db)).orders[0].dispatchOfferAttempts.filter(a => a.status === 'accepted').length, 1);
});

test('PostgreSQL prevents duplicate outstanding offers across orders at commit', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  ok(await api('rider', 'GET', '/dispatch/offers'));
  await assert.rejects(db.transaction(async () => {
    const store = await loadStore(db);
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'duplicate_order' });
    await saveStore(db, store);
  }), /exclusive dispatch offer/i);
  assert.equal((await loadStore(db)).orders.length, 1);
});

test('required digital signature failure rolls back automatic receipt issuance and all handover effects', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t, store => {
    Object.assign(store.orders[0], { state: 'out_for_delivery', riderId: 'rider', riderAssignedAt: AT });
    store.files.push({ fileId: 'drop', ownerId: 'rider', purpose: 'delivery_photo', state: 'ready', objectKey: 'private/drop',
      originalFilename: 'drop.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT,
      references: [{ type: 'order', id: 'order', field: 'deliveryPhotoFileIds' }] });
  });
  const before = (await db.query('SELECT last_number FROM acknowledgement_receipt_counter')).rows[0].last_number;
  const rejected = await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'drop', receiptMode: 'digital' });
  assert.equal(rejected.body.error, 'acknowledgement_signature_required');
  assert.equal(rejected.status, 400);
  assert.equal((await db.query('SELECT last_number FROM acknowledgement_receipt_counter')).rows[0].last_number, before);
  assert.equal((await db.query("SELECT 1 FROM acknowledgement_receipts WHERE order_id='order'")).rowCount, 0);
  const store = await loadStore(db);
  assert.equal(store.orders[0].state, 'out_for_delivery');
  assert.equal(store.orders[0].deliveryEvidence, undefined);
  assert.ok(!store.notifications.some(n => n.type.startsWith('acknowledgement_receipt_')));
});

test('a removed order releases its reservation without rewriting retained order evidence', { skip: !DATABASE_URL }, async t => {
  const { db, api } = await setup(t);
  const first = ok(await api('rider', 'GET', '/dispatch/offers')).offers[0];
  await db.query('INSERT INTO order_removals(order_id,removed_at,removed_by,reason) VALUES($1,$2,$3,$4)', ['order', new Date().toISOString(), 'admin', 'Remove test order']);
  await db.transaction(async () => {
    const store = await loadStore(db);
    const replacement = fixture().orders[0];
    Object.assign(replacement, { id: 'replacement_order', state: 'ready_for_dispatch', dispatchOffer: first.dispatchOffer });
    store.orders.push(replacement);
    await saveStore(db, store);
  });
  const active = await loadStore(db);
  assert.deepEqual(active.orders.map(o => o.id), ['replacement_order']);
  assert.equal((await db.query("SELECT data#>>'{dispatchOffer,id}' AS id FROM orders WHERE id='order'")).rows[0].id, first.dispatchOffer.id);
});


test('first offer read refreshes when the scheduler commits between its scoped snapshot and deadline probe', { skip: !DATABASE_URL }, async t => {
  const hook = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      let source = String(result.source);
      if (url.endsWith('/src/server.js')) source = source.replace('void runLifecycleWork();', '')
        .replace('setInterval(sweepDispatchOffers, 1000)', 'setInterval(() => {}, 3600000)')
        .replace('setInterval(sweepSaveUpkeep, 1000)', 'setInterval(() => {}, 3600000)');
      if (url.endsWith('/src/postgres-store.js')) {
        source = source.replace('export async function loadHotReadStore(', 'async function beforeOfferRaceRead(');
        source += ` + "`" + `
          let raceInjected = false, raceId = 0;
          export async function loadHotReadStore(...args) {
            const snapshot = await beforeOfferRaceRead(...args);
            if (!raceInjected && args[2] === '/dispatch/offers' && args[1] === 'clerk_rider') {
              raceInjected = true;
              const { reconcileDispatchOffers } = await import('./dispatch-offers.js');
              const { appendAudit } = await import('./audit.js');
              await args[0].transaction(async () => {
                const store = await loadStore(args[0]);
                const ctx = { at: new Date().toISOString(), id: prefix => 'race_' + prefix + '_' + (++raceId) };
                reconcileDispatchOffers(store, { ...ctx, audit: (target, entry) => appendAudit(target, entry, ctx) });
                await saveStore(args[0], store);
              });
            }
            return snapshot;
          }
        ` + "`" + `;
      }
      return { ...result, source };
    } });`;
  const { api } = await setup(t, () => {}, { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook)}` });
  const first = ok(await api('rider', 'GET', '/dispatch/offers'));
  assert.equal(first.offers.length, 1);
  assert.equal(first.offers[0].dispatchOffer.riderId, 'rider');
});
