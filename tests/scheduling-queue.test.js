import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/scheduling.js';
import { projectShopFinish } from '../src/order-match.js';

for (const state of ['completed', 'cancelled', 'delivered', 'issue_window_open']) {
  test(`${state} basket work with a stale active job does not delay the shop queue`, () => {
    const { store } = fixture();
    const input = { supplierId: 'shop_a', turnaroundHours: 1, now: '2026-10-19T01:00:00Z' };
    const empty = projectShopFinish(store, input);
    store.orders.push({ id: 'finished', supplierId: 'shop_a', basketId: 'basket', state });
    store.orderJobs.push({ id: 'stale', orderId: 'finished', supplierId: 'shop_a', state: 'rider_assigned', estimatedHours: 80 });
    assert.deepEqual(projectShopFinish(store, input), empty);
  });
}
test('active orders count once and synthetic draft jobs still consume queue capacity', () => {
  const { store } = fixture();
  store.orders.push({ id: 'active', supplierId: 'shop_a', state: 'production', estimatedHours: 4 });
  store.orderJobs.push({ id: 'job', orderId: 'active', supplierId: 'shop_a', state: 'production', estimatedHours: 4 },
    { supplierId: 'shop_a', state: 'needs_qa', estimatedHours: 2 });
  assert.deepEqual(projectShopFinish(store, { supplierId: 'shop_a', turnaroundHours: 1, now: '2026-10-19T01:00:00Z' }).queue,
    { jobsAhead: 2, minutes: 360 });
});

test('a queued basket job still counts while its parent is awaiting payment or QA authorization', () => {
  for (const state of ['initial_payment_review', 'payment_authorized', 'payout_released']) {
    const { store } = fixture();
    store.orders.push({ id: state, supplierId: 'shop_a', state });
    store.orderJobs.push({ id: 'job', orderId: state, supplierId: 'shop_a', state: 'needs_qa', estimatedHours: 4 });
    const queue = projectShopFinish(store, { supplierId: 'shop_a', turnaroundHours: 1, now: '2026-10-19T01:00:00Z' }).queue;
    assert.equal(queue.jobsAhead, state === 'payout_released' ? 0 : 1);
  }
});

import { fixture as recoveryFixture, AT, id, actors, audit } from './fixtures/reschedule.js';
import { recordShopFailure } from '../src/shop-recovery.js';
import { routeShopRecovery } from '../src/shop-recovery-routes.js';

for (const state of ['picked_up', 'out_for_delivery']) for (const withJob of [false, true]) {
  test(`${state} work leaves the production queue (${withJob ? 'stale job' : 'direct order'})`, () => {
    const store = recoveryFixture(), order = store.orders[0]; order.state = state;
    if (!withJob) store.orderJobs = [];
    assert.equal(projectShopFinish(store, { supplierId: 'supplier', turnaroundHours: 1, now: AT }).queue.jobsAhead, 0);
  });
}
for (const kind of ['cancelled', 'declined', 'timed_out']) for (const withJob of [false, true]) {
  test(`${kind} shop work stays out of the queue through refund or accepted replacement (${withJob ? 'job' : 'direct'})`, async () => {
    const store = recoveryFixture(), order = store.orders[0];
    if (!withJob) store.orderJobs = [];
    const original = structuredClone({ promiseBy: order.promiseBy, readyBy: order.readyBy, totalMinor: order.totalMinor, serviceFeeMinor: order.serviceFeeMinor });
    recordShopFailure(store, order, { kind, reason: 'Cannot fulfil', at: AT, createId: id, actorId: 'supplier' });
    const queue = supplierId => projectShopFinish(store, { supplierId, turnaroundHours: 1, now: AT }).queue;
    assert.equal(queue('supplier').jobsAhead, 0);
    assert.deepEqual({ promiseBy: order.promiseBy, readyBy: order.readyBy, totalMinor: order.totalMinor, serviceFeeMinor: order.serviceFeeMinor }, original);
    const held = structuredClone(store);
    const call = (target, action) => routeShopRecovery({ req: { method: 'POST', headers: { 'idempotency-key': id('key') } }, url: new URL(`http://test/orders/order/shop-recovery/${action}`),
      store: target, user: actors.client, readBody: async () => ({ recoveryId: target.orders[0].shopRecovery.id }), now: () => AT, id, audit });
    await call(held, 'refund');
    assert.equal(held.orders[0].shopRecovery.status, 'refund_requested');
    assert.equal(projectShopFinish(held, { supplierId: 'supplier', turnaroundHours: 1, now: AT }).queue.jobsAhead, 0);
    // Accepted replacement work counts at its new shop; the original stays empty.
    await call(store, 'accept');
    assert.equal(order.shopRecovery.status, 'accepted');
    assert.equal(queue('supplier').jobsAhead, 0);
    assert.equal(queue('replacement').jobsAhead, 1);
  });
}
test('a closed compatibility job cannot be reinserted through the direct-order fallback', () => {
  const store = recoveryFixture(); store.orderJobs[0].state = 'cancelled';
  assert.equal(projectShopFinish(store, { supplierId: 'supplier', turnaroundHours: 1, now: AT }).queue.jobsAhead, 0);
});
