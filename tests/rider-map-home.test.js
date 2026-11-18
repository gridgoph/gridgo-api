import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, AT, id, audit } from './fixtures/reschedule.js';
import { recordAcknowledgementSignature } from '../src/acknowledgement-receipts.js';
import { defaultOperationalSettings, validateOperationalSettings, publicOrderFor } from '../src/operational-model.js';
import * as policy from '../src/dispatch-offers.js';
const LATER = '2026-10-05T00:00:30.000Z';
function pool() {
  const store = fixture();
  store.orders[0].state = 'ready_for_dispatch';
  for (const key of ['rider2', 'rider3']) {
    store.users.push({ ...store.users.find(u => u.id === 'rider'), id: key, clerkUserId: `clerk_${key}` });
    store.userRoleMemberships.push({ userId: key, role: 'rider', createdAt: AT });
  }
  return store;
}
function sweep(store, at = AT) {
  assert.equal(typeof policy.reconcileDispatchOffers, 'function', 'durable offer reconciler exists');
  return policy.reconcileDispatchOffers(store, { at, id, audit });
}
test('offer countdown defaults to 30 seconds and accepts only JSON integers 10–120', () => {
  assert.equal(defaultOperationalSettings().riderOfferTimeoutSeconds, 30);
  for (const value of [null, '30', 9, 121, 10.5]) assert.throws(() => validateOperationalSettings({ ...defaultOperationalSettings(), riderOfferTimeoutSeconds: value }), /rider.*offer|countdown/i);
  for (const value of [10, 30, 120]) validateOperationalSettings({ ...defaultOperationalSettings(), riderOfferTimeoutSeconds: value });
});
test('least-recently-offered fair rotation; exclusive offer, snapshotted deadline and exhaustion alert once', () => {
  const store = pool();
  store.users.find(u => u.id === 'rider').lastDispatchOfferAt = AT;
  sweep(store);
  const order = store.orders[0];
  assert.equal(order.dispatchOffer.riderId, 'rider2');
  assert.equal(order.dispatchOffer.timeoutSeconds, 30);
  assert.equal(order.dispatchOffer.expiresAt, LATER);
  store.settings.riderOfferTimeoutSeconds = 120;
  sweep(store, '2026-10-05T00:00:29.000Z');
  assert.equal(order.dispatchOffer.expiresAt, LATER);
  sweep(store, LATER);
  assert.equal(order.dispatchOffer.riderId, 'rider3');
  assert.equal(order.dispatchOffer.timeoutSeconds, 120);
  assert.equal(order.dispatchOfferAttempts[0].status, 'expired');
  assert.equal(typeof policy.declineDispatchOffer, 'function');
  policy.declineDispatchOffer(store, order, 'rider3', order.dispatchOffer.id, { at: LATER, id, audit });
  assert.equal(order.dispatchOffer.riderId, 'rider');
  policy.declineDispatchOffer(store, order, 'rider', order.dispatchOffer.id, { at: LATER, id, audit });
  assert.equal(order.dispatchOffer.status, 'exhausted');
  const notices = store.notifications.filter(n => n.type === 'dispatch_offer_exhausted');
  assert.deepEqual(notices.map(n => n.appRole).sort(), ['ops_admin', 'super_admin']);
  sweep(store, '2026-10-05T00:30:00.000Z');
  assert.equal(store.notifications.filter(n => n.type === 'dispatch_offer_exhausted').length, notices.length);
  assert.equal(order.state, 'ready_for_dispatch');
  assert.equal(order.riderId, undefined);
});
test('rotation preserves review pool and work holds; offers serialize per rider without active-job filters', () => {
  const store = pool();
  store.users.find(u => u.id === 'rider2').reviewData = true;
  store.users.find(u => u.id === 'rider3').accountStatus = 'suspended';
  store.orders.push({ ...structuredClone(store.orders[0]), id: 'order2' });
  store.orders.push({ ...structuredClone(store.orders[0]), id: 'active', state: 'picked_up', riderId: 'rider' });
  sweep(store);
  assert.equal(store.orders[0].dispatchOffer.riderId, 'rider');
  assert.equal(store.orders[1].dispatchOffer?.status, 'waiting');
  store.orders[0].shopRecovery = { status: 'pending' };
  sweep(store);
  assert.notEqual(store.orders[0].dispatchOffer.status, 'offered');
  assert.equal(store.orders[1].dispatchOffer.riderId, 'rider');
  assert.equal(store.orders[0].dispatchOfferAttempts[0].status, 'withdrawn');
});
test('offer metadata is role scoped and rider money remains its immutable share', () => {
  const store = pool(); sweep(store);
  const order = store.orders[0];
  for (const role of ['client', 'supplier']) {
    const view = publicOrderFor(order, { id: role, role }, store);
    assert.equal(view.dispatchOffer, undefined);
    assert.equal(view.dispatchOfferAttempts, undefined);
  }
  const view = publicOrderFor(order, { id: 'rider', role: 'rider' }, store);
  assert.equal(view.dispatchOffer.expiresAt, LATER);
  assert.equal(view.dispatchOfferAttempts, undefined);
  assert.equal(view.riderPayoutMinor, 850);
  assert.equal(view.riderCommissionBps, 8500);
});


test('receipt signature rejects another assignment, mismatched receipt, name and unready image; no partial evidence', () => {
  const store = fixture(), order = store.orders[0];
  Object.assign(order, { riderId: 'rider', riderAssignedAt: AT });
  const file = { fileId: 'signature', purpose: 'acknowledgement_signature', ownerId: 'rider', state: 'ready', detectedContentType: 'image/png',
    references: [{ type: 'order', id: order.id, riderId: 'rider', assignedAt: AT }] };
  store.files.push(file);
  const signature = { fileId: file.fileId, signerName: 'Recipient', arNumber: 'AR-1' };
  const call = (patch = {}) => recordAcknowledgementSignature({ store, order, user: { id: 'rider', role: 'rider' },
    receipt: { arNumber: 'AR-1' }, signature: { ...signature, ...patch }, at: AT, id, audit });
  for (const patch of [{ arNumber: 'AR-2' }, { signerName: '' }, { fileId: 'foreign' }]) assert.throws(() => call(patch));
  file.references[0].assignedAt = '2026-10-04T00:00:00.000Z';
  assert.throws(() => call(), /invalid_acknowledgement_signature/);
  file.references[0].assignedAt = AT; file.state = 'pending_upload';
  assert.throws(() => call(), /invalid_acknowledgement_signature/);
  assert.equal(order.acknowledgementSignature, undefined);
  file.state = 'ready'; call();
  assert.equal(order.acknowledgementSignature.arNumber, 'AR-1');
  assert.throws(() => call(), /immutable/);
});

test('offer projection has stable bytes before and after PostgreSQL JSONB reorders metadata keys', () => {
  const store = pool(); sweep(store);
  const order = store.orders[0];
  const actor = { id: 'rider', role: 'rider' };
  const fresh = publicOrderFor(order, actor, store).dispatchOffer;
  order.dispatchOffer = Object.fromEntries(Object.entries(order.dispatchOffer).sort(([a], [b]) => a.localeCompare(b)));
  const reloaded = publicOrderFor(order, actor, store).dispatchOffer;
  assert.equal(JSON.stringify(fresh), JSON.stringify(reloaded));
});
