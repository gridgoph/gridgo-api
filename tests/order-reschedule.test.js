import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, answer, call, AT, ORIGINAL, PROPOSED, actors, id } from './fixtures/reschedule.js';
import { expireRescheduleRequests } from '../src/order-reschedule.js';
import { findRescheduleReplacement } from '../src/order-reschedule-match.js';
import { publicOrderFor, releaseMilestone, activePayoutHold, issueWindowExpiresAt } from '../src/operational-model.js';
import { assertRefundWorkAllowed } from '../src/refund-policy.js';
import { assessProductionLapses } from '../src/production-penalties.js';

const code = (expected) => (error) => error.code === expected;
test('acceptance changes effective dates, preserves money and starts the issue window at actual handover', async () => {
  const store = fixture(), order = store.orders[0];
  const payments = structuredClone(order.payments);
  const created = await request(store);
  assert.equal(created.status, 201);
  assert.equal(order.readyBy, ORIGINAL);
  assert.equal(created.body.request.proposedPromiseBy, undefined, 'supplier cannot see padded date');
  await answer(store, 'accept');
  assert.equal(order.readyBy, PROPOSED);
  assert.equal(order.promiseBy, '2026-10-12T01:00:00.000Z');
  assert.equal(publicOrderFor(order, actors.client, store).promisedDate, '2026-10-12T01:00:00.000Z');
  assert.deepEqual(order.payments, payments);
  assert.equal(order.issueWindowExpiresAt, undefined);
  assert.equal(issueWindowExpiresAt('2026-10-13T01:00:00.000Z', 24), '2026-10-14T01:00:00.000Z');
  assert.equal(assessProductionLapses(store, { at: '2026-10-11T00:00:00.000Z', createId: id }), false);
  assessProductionLapses(store, { at: '2026-10-12T02:00:00.000Z', createId: id });
  assert.equal(store.productionLapses[0].deadlineAt, PROPOSED);
  assert.equal(store.productionLapses[0].tier, 'minor');
});

test('one request persists after acceptance, decline or expiry and counts on supplier record', async () => {
  for (const outcome of ['accept', 'decline', 'expire']) {
    const store = fixture(); await request(store);
    if (outcome === 'expire') expireRescheduleRequests(store, { at: '2026-10-06T00:00:00.000Z', id });
    else await answer(store, outcome);
    await assert.rejects(request(store), code('reschedule_already_requested'));
    const queue = await call(store, 'supplier', '', {}, { method: 'GET', path: '/me/reschedule-requests' });
    assert.equal(queue.body.totalRequests, 1);
    assert.equal(queue.body.requests.length, 1);
  }
});

test('decline offers a real same-spec match without assigning until client consent; original lines and price remain', async () => {
  const store = fixture(), order = store.orders[0];
  const lines = structuredClone(store.orderLineItems);
  await request(store);
  const declined = await answer(store, 'decline');
  assert.equal(declined.body.request.resolution, 'rematch_offered');
  assert.equal(order.supplierId, 'supplier');
  assert.equal(activePayoutHold(store, order), true);
  assert.throws(() => assertRefundWorkAllowed(store, order), code('reschedule_fulfillment_stopped'));
  assert.equal(declined.body.request.rematch.supplierId, undefined);
  const requestId = order.rescheduleRequest.id, offerId = order.rescheduleRequest.offer.id;
  await call(store, 'client', 'rematch', { requestId, offerId, action: 'accept' });
  assert.equal(order.supplierId, 'replacement');
  assert.equal(store.orderJobs[0].supplierId, 'replacement');
  assert.equal(order.state, 'supplier_assigned');
  assert.deepEqual(store.orderLineItems, lines);
  assert.equal(order.totalMinor, 12000);
  assert.equal(order.supplierSubtotalMinor, 10000);
  assert.equal(activePayoutHold(store, order), false);
  assert.equal(publicOrderFor(order, actors.replacement, store).productionItems.length, 1);
  await assert.rejects(call(store, 'client', 'rematch', { requestId, offerId, action: 'accept' }), code('reschedule_rematch_unavailable'));
});

test('changed specs, unavailable shop, missed date and excessive price cannot become a replacement', () => {
  for (const change of [s => s.catalogItems[1].name = 'Different product', s => s.catalogItems[1].description = 'Double-sided',
    s => s.catalogItems[1].basePriceMinor = 2000, s => s.supplierProfiles[1].isClosed = true,
    s => s.supplierServices[1].state = 'suspended', s => s.orders[0].promiseBy = AT]) {
    const store = fixture(); change(store);
    assert.equal(findRescheduleReplacement(store, store.orders[0], AT), null);
  }
});

test('a released share routes decline to Operations and never creates or accepts a rematch', async () => {
  const store = fixture(), order = store.orders[0];
  order.payoutMilestones[0].status = 'released';
  await request(store);
  const result = await answer(store, 'decline');
  assert.equal(result.body.request.resolution, 'operations_required');
  assert.equal(result.body.request.canRequestRefund, true);
  assert.equal(order.supplierId, 'supplier');
  await assert.rejects(call(store, 'client', 'rematch', { requestId: order.rescheduleRequest.id, action: 'refresh' }), code('reschedule_rematch_unavailable'));
});

test('applied deduction goes to Operations at request or answer; no dates, money or ledger facts are rewritten', async () => {
  for (const during of [false, true]) {
    const store = fixture(), order = store.orders[0];
    if (during) await request(store);
    store.productionLapses.push({ id: 'applied', orderId: 'order', supplierId: 'supplier', appliedAt: AT, deductionMinor: 500 });
    const before = structuredClone(store.productionLapses);
    if (!during) await request(store);
    else await answer(store, 'accept');
    assert.equal(order.rescheduleRequest.resolution, 'operations_required');
    assert.equal(order.readyBy, ORIGINAL);
    assert.deepEqual(store.productionLapses, before);
    const queue = await call(store, 'ops', '', {}, { method: 'GET', path: '/ops/reschedule-requests' });
    assert.equal(queue.body.requests[0].appliedDeductionMinor, 500);
    assert.equal(activePayoutHold(store, order), true);
  }
});

test('accepted extension resets an unapplied warning while retaining its historical record and renewed tier', async () => {
  const store = fixture(), order = store.orders[0];
  order.readyBy = '2026-10-04T00:00:00.000Z'; order.promiseBy = '2026-10-04T01:00:00.000Z';
  assessProductionLapses(store, { at: AT, createId: id });
  await request(store); await answer(store, 'accept');
  assert.equal(assessProductionLapses(store, { at: '2026-10-11T00:00:00.000Z', createId: id }), false);
  assessProductionLapses(store, { at: '2026-10-12T01:00:00.000Z', createId: id });
  const lapse = store.productionLapses.find(row => !row.closedAt);
  assert.equal(lapse.deadlineAt, PROPOSED);
  assert.equal(lapse.tier, 'minor');
});

test('24-hour boundary expires once, keeps original dates and writes inbox rows for both administrator roles', async () => {
  const store = fixture(); await request(store);
  const result = await answer(store, 'accept', { at: '2026-10-06T00:00:00.000Z' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'reschedule_expired');
  assert.equal(store.orders[0].readyBy, ORIGINAL);
  assert.equal(expireRescheduleRequests(store, { at: '2026-10-07T00:00:00.000Z', id }), false);
  for (const userId of ['ops', 'admin']) assert.equal(store.notifications.filter(n => n.userId === userId && n.type === 'order_reschedule_expired').length, 1);
});

test('no match and declined replacement both allow a full refund request, with independent holds until settlement', async () => {
  for (const noMatch of [false, true]) {
    const store = fixture(), order = store.orders[0];
    if (noMatch) store.catalogItems[1].active = false;
    await request(store); await answer(store, 'decline');
    assert.equal(order.rescheduleRequest.resolution, noMatch ? 'no_match' : 'rematch_offered');
    const result = await call(store, 'client', 'refund', { requestId: order.rescheduleRequest.id });
    assert.equal(result.body.request.resolution, 'refund_requested');
    assert.equal(store.refundRequests.length, 1);
    assert.equal(store.refundRequests[0].status, 'requested');
    assert.equal(order.rescheduleRequest.requestedRefund, 'full');
    assert.equal(activePayoutHold(store, order), true);
    await call(store, 'client', 'refund', { requestId: order.rescheduleRequest.id });
    assert.equal(store.refundRequests.length, 1);
  }
});

test('authorization, date validation, stale responses and post-QC requests fail closed', async () => {
  const store = fixture();
  for (const actor of ['client', 'other', 'replacement', 'rider', 'ops']) await assert.rejects(call(store, actor, '', { reason: 'Repair', proposedReadyBy: PROPOSED }), code('forbidden'));
  for (const proposedReadyBy of [null, 'tomorrow', AT, ORIGINAL]) await assert.rejects(call(store, 'supplier', '', { reason: 'Repair', proposedReadyBy }), code('invalid_reschedule_date'));
  await request(store);
  await assert.rejects(call(store, 'other', 'answer', { answer: 'accept' }), code('forbidden'));
  await assert.rejects(call(store, 'client', 'answer', { requestId: 'wrong', answer: 'accept' }), code('reschedule_stale'));
  await assert.rejects(call(store, 'rider', '', {}, { method: 'GET' }), code('forbidden'));
  for (const actor of ['client', 'rider']) assert.equal(publicOrderFor(store.orders[0], actors[actor], store).rescheduleRequest?.previousProduction, undefined);
  const finished = fixture(); finished.orders[0].state = 'ready_for_dispatch';
  await assert.rejects(request(finished), code('reschedule_not_available'));
});

test('rematch refresh/accept ignores neither expiry nor listing revisions and only Operations can release its hold', async () => {
  const store = fixture(), order = store.orders[0]; await request(store); await answer(store, 'decline');
  const requestId = order.rescheduleRequest.id, offerId = order.rescheduleRequest.offer.id;
  await assert.rejects(call(store, 'client', 'rematch', { requestId, offerId, action: 'accept' }, { at: '2026-10-05T00:15:00.000Z' }), code('reschedule_offer_expired'));
  store.catalogItems[1].version++;
  await assert.rejects(call(store, 'client', 'rematch', { requestId, offerId, action: 'accept' }), code('reschedule_offer_stale'));
  await call(store, 'client', 'rematch', { requestId, action: 'refresh' });
  assert.notEqual(order.rescheduleRequest.offer.id, offerId);
  assert.ok(store.auditLog.some(row => row.action === 'order.reschedule_rematch_refreshed'));
  await assert.rejects(call(store, 'client', 'resolve', { requestId, reason: 'Resume' }), code('forbidden'));
  await call(store, 'ops', 'resolve', { requestId, reason: 'Client and shop agreed to continue under the original deadline.' });
  assert.equal(activePayoutHold(store, order), false);
  assert.equal(order.readyBy, ORIGINAL);
  assert.equal(store.auditLog.at(-1).reason, 'Client and shop agreed to continue under the original deadline.');
});

test('claims and reschedule holds independently block release; resolving a request never clears a claim', async () => {
  const store = fixture(), order = store.orders[0];
  await request(store); await answer(store, 'decline');
  order.payoutMilestones[0].status = 'pof_attached'; order.payoutMilestones[0].pofFileIds = ['proof'];
  assert.throws(() => releaseMilestone(order, 'production_started', actors.ops, AT, store), code('payout_held'));
  store.claims.push({ id: 'claim', orderId: 'order', status: 'open' });
  await call(store, 'ops', 'resolve', { requestId: order.rescheduleRequest.id, reason: 'Work can continue under the original deadline.' });
  assert.equal(activePayoutHold(store, order), true);
  assert.equal(store.claims[0].status, 'open');
});

test('date and deduction internals never escape through order or queue projections', async () => {
  const store = fixture(), order = store.orders[0]; await request(store); await answer(store, 'accept');
  const shop = publicOrderFor(order, actors.supplier, store);
  assert.equal(shop.promiseBy, undefined);
  assert.notEqual(shop.promisedDate, '2026-10-12T01:00:00.000Z');
  order.rescheduleRequest.priorLapse = { deductionMinor: 999, warnings: ['private'] };
  order.rescheduleRequest.previousProduction = { payoutMilestones: [{ amountMinor: 999 }] };
  for (const actor of [actors.client, actors.rider]) {
    const projected = publicOrderFor(order, actor, store);
    assert.equal(projected.rescheduleRequest?.priorLapse, undefined);
    assert.equal(projected.rescheduleRequest?.proposedReadyBy, undefined);
    assert.equal(projected.rescheduleRequest?.previousProduction, undefined);
    assert.equal(projected.rescheduleRequest?.appliedDeductionMinor, undefined);
  }
});

test('matching maps required options to equivalent labels and rejects unsupported artwork link formats', () => {
  const store = fixture(), line = store.orderLineItems[0];
  store.catalogOptionGroups.push({ id: 'group', catalogItemId: 'item_replacement', name: 'Paper', kind: 'spec', required: true, selectionMode: 'single' });
  store.catalogOptions.push({ id: 'option', optionGroupId: 'group', label: 'Matte', priceModifierMinor: 0, active: true });
  store.orderLineItemOptions.push({ id: 'selected', orderLineItemId: line.id, groupNameSnapshot: 'Paper', groupKindSnapshot: 'spec', optionLabelSnapshot: 'Gloss' });
  assert.equal(findRescheduleReplacement(store, store.orders[0], AT), null);
  store.catalogOptions[0].label = 'Gloss';
  line.artworkLinks = [];
  assert.ok(findRescheduleReplacement(store, store.orders[0], AT));
  line.artworkLinks = [{ formatCode: 'other_link', url: 'https://example.invalid/artwork' }];
  assert.equal(findRescheduleReplacement(store, store.orders[0], AT), null);
});

test('original supplier retains deadline outcome notifications after replacement without retaining order access', async () => {
  const { notificationVisible, canAccessOrder } = await import('../src/notifications.js');
  const store = fixture(); await request(store); await answer(store, 'decline');
  const requestId = store.orders[0].rescheduleRequest.id, offerId = store.orders[0].rescheduleRequest.offer.id;
  await call(store, 'client', 'rematch', { requestId, offerId, action: 'accept' });
  const notification = store.notifications.find(row => row.userId === 'supplier' && row.type === 'order_reschedule_rematched');
  assert.ok(notificationVisible(store, notification, 'supplier', 'supplier'));
  assert.equal(canAccessOrder(store, 'supplier', store.orders[0], { role: 'supplier' }), false);
});

test('free-form production specs require equivalent governed option bindings before automatic rematch', () => {
  const store = fixture(); store.orderLineItems[0].structuredSpecSnapshot = { material: 'coated' };
  assert.equal(findRescheduleReplacement(store, store.orders[0], AT), null);
  store.catalogOptionGroups.push({ id: 'group', catalogItemId: 'item_replacement', name: 'Paper', kind: 'spec', required: true, selectionMode: 'single' });
  store.catalogOptions.push({ id: 'option', optionGroupId: 'group', label: 'Coated', priceModifierMinor: 0, active: true,
    specBinding: { fieldCode: 'material', valueCode: 'coated' } });
  store.orderLineItemOptions.push({ id: 'selected', orderLineItemId: 'line', groupNameSnapshot: 'Paper', groupKindSnapshot: 'spec', optionLabelSnapshot: 'Coated' });
  assert.ok(findRescheduleReplacement(store, store.orders[0], AT));
  store.catalogOptions[0].specBinding.valueCode = 'uncoated';
  assert.equal(findRescheduleReplacement(store, store.orders[0], AT), null);
});

test('basket group deadline changes and replacements leave siblings and the combined receipt unchanged', async () => {
  const { publicBasket } = await import('../src/baskets.js');
  for (const outcome of ['accept', 'decline']) {
    const store = fixture(), order = store.orders[0];
    order.basketId = 'basket'; order.basketDeadline = order.promiseBy;
    const sibling = { ...structuredClone(order), id: 'sibling', supplierId: 'replacement' };
    store.orders.push(sibling);
    const siblingJob = { ...structuredClone(store.orderJobs[0]), id: 'sibling_job', orderId: sibling.id, supplierId: 'replacement' };
    store.orderJobs.push(siblingJob);
    const basket = { id: 'basket', clientId: 'client', orderIds: ['order', 'sibling'], receiptOrderId: 'order',
      deadline: order.promiseBy, totalMinor: 24000, payment: { status: 'confirmed' } };
    store.baskets.push(basket);
    const before = structuredClone({ sibling, siblingJob, basket });
    await request(store); await answer(store, outcome);
    if (outcome === 'decline') await call(store, 'client', 'rematch', { requestId: order.rescheduleRequest.id,
      offerId: order.rescheduleRequest.offer.id, action: 'accept' });
    assert.deepEqual({ sibling, siblingJob, basket }, before);
    const projection = publicBasket(store, basket, actors.client);
    assert.equal(projection.groups[0].order.rescheduleRequest.status, outcome === 'accept' ? 'accepted' : 'declined');
    assert.equal(projection.groups[0].order.supplierId, undefined);
    assert.equal(projection.groups[1].order.rescheduleRequest, undefined);
  }
});

test('shop recovery and reschedule holds cannot bypass one another', async () => {
  const { recordShopFailure } = await import('../src/shop-recovery.js');
  const store = fixture(), order = store.orders[0];
  await request(store);
  order.shopRecovery = { status: 'awaiting_client' };
  await assert.rejects(answer(store, 'accept'), code('shop_recovery_pending'));
  assert.equal(order.readyBy, ORIGINAL);
  delete order.shopRecovery;
  await answer(store, 'decline');
  assert.throws(() => recordShopFailure(store, order, { kind: 'cancelled', reason: 'Cannot continue', at: AT, createId: id }), code('reschedule_fulfillment_stopped'));
  order.shopRecovery = { id: 'recovery', status: 'awaiting_client', proposal: {} };
  await assert.rejects(call(store, 'client', 'rematch', { requestId: order.rescheduleRequest.id, action: 'refresh' }), code('shop_recovery_pending'));
  const { routeShopRecovery } = await import('../src/shop-recovery-routes.js');
  await assert.rejects(routeShopRecovery({ req: { method: 'POST' },
    url: new URL('http://api.test/orders/order/shop-recovery/accept'), store, user: actors.client,
    readBody: async () => ({ recoveryId: 'recovery' }), now: () => AT, id }), code('reschedule_fulfillment_stopped'));
});

test('replacement starts its own acceptance window and retains earlier shop lapse history', async () => {
  const store = fixture(), order = store.orders[0];
  const historical = { id: 'historical', orderId: order.id, supplierId: 'other_shop', closedAt: AT };
  store.productionLapses.push(historical);
  await request(store); await answer(store, 'decline');
  await call(store, 'client', 'rematch', { requestId: order.rescheduleRequest.id, offerId: order.rescheduleRequest.offer.id, action: 'accept' });
  assert.ok(store.productionLapses.includes(historical));
  assert.equal(order.shopAcceptance.supplierId, 'replacement');
  assert.equal(order.shopAcceptance.status, 'pending');
  assert.ok(Date.parse(order.shopAcceptance.deadlineAt) > Date.parse(AT));
});
