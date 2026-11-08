import test from 'node:test';
import assert from 'node:assert/strict';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { publicBasket } from '../src/baskets.js';
import { fixture } from './fixtures/reschedule.js';
import { orderRemovalBlock } from '../src/order-removal.js';
import { publicOrderFor, defaultOperationalSettings } from '../src/operational-model.js';
import { resolveAuthorizationContext } from '../src/authorization-context.js';

const orderId = 'removal-order';
const related = { orderId };
const baseOrder = { id: orderId, clientId: 'client', payments: {}, payoutMilestones: [], pickup: { lat: 7.06, lng: 125.6 }, dropoff: { lat: 7.07, lng: 125.61 } };
const baseStore = { users: [{ id: 'client', reviewData: true }], orderJobs: [] };
const scenarios = [
  ['unpaid unassigned', {}, {}, null],
  ['simulated assigned and paid', { reviewData: true, supplierId: 'shop', payments: { initial: { status: 'confirmed', simulated: true } } }, {}, null],
  ['released milestone', { payoutMilestones: [{ status: 'released' }] }, {}, 'payout_released'],
  ['released state', { state: 'payout_released' }, {}, 'payout_released'],
  ['released refund remainder', {}, { refundSupplierPayouts: [{ ...related, status: 'released' }] }, 'payout_released'],
  ...['requested', 'paid'].map(status => [`refund ${status}`, {}, { refundRequests: [{ ...related, status }] }, 'refund_activity']),
  ...['rejected', 'withdrawn'].map(status => [`refund ${status}`, {}, { refundRequests: [{ ...related, status }] }, null]),
  ...['confirmed', 'pending_confirmation', 'submitted'].map(status => [`payment ${status}`, { payments: { initial: { status } } }, {}, 'payment_submitted']),
  ['basket payment', {}, { baskets: [{ orderIds: [orderId], payment: { status: 'confirmed' } }] }, 'payment_submitted'],
  ['simulated order with real payment', { reviewData: true, payments: { initial: { status: 'confirmed' } } }, {}, 'payment_submitted'],
  ['client no longer simulated', { reviewData: true, payments: { initial: { status: 'confirmed', simulated: true } } }, { users: [{ id: 'client', reviewData: false }] }, 'payment_submitted'],
  ...['orderChangePayments', 'orderChangePayouts', 'deliveryPinPayments', 'refundSettlements', 'refundSupplierPayouts', 'voucherReservations', 'voucherRedemptions', 'voucherLedger'].map(key => [key, {}, { [key]: [{ data: { orderIds: [orderId] } }] }, 'financial_activity']),
  ['credit', {}, { credits: { client: { ledger: [related] } } }, 'financial_activity'],
  ['revenue adjustment', { revenueAdjustments: [{}] }, {}, 'financial_activity'],
  ['voucher redemption', { voucherRedemptionId: 'voucher' }, {}, 'financial_activity'],
  ['voucher discount', { voucherDiscountMinor: 1 }, {}, 'financial_activity'],
  ['voucher amount', { voucher: { amountMinor: 1 } }, {}, 'financial_activity'],
  ['pending change', {}, { orderChanges: [{ ...related, status: 'pending_confirmation', data: {} }] }, 'financial_activity'],
  ['pending pin change', { deliveryPin: { pricing: defaultOperationalSettings(), original: { lat: 7.07, lng: 125.61 }, change: { status: 'pending_confirmation' } } }, {}, 'financial_activity'],
  ['assigned shop', { supplierId: 'shop' }, {}, 'shop_assigned'],
  ['assigned job', {}, { orderJobs: [{ ...related, supplierId: 'shop' }] }, 'shop_assigned'],
  ['simulated job', { reviewData: true }, { orderJobs: [{ ...related, supplierId: 'shop' }] }, null],
  ['unrelated finance', {}, { credits: { client: { ledger: [{ orderId: 'other' }] } }, refundRequests: [{ orderId: 'other', status: 'paid' }] }, null],
  ['precedence with all blocks', { supplierId: 'shop', state: 'payout_released', payments: { initial: { status: 'confirmed' } } }, { refundRequests: [{ ...related, status: 'paid' }] }, 'payout_released'],
];

for (const [name, patch, extra, blockedReason] of scenarios) test(`removal projection and guard: ${name}`, () => {
  const order = { ...baseOrder, ...patch };
  const store = { ...baseStore, ...extra };
  assert.equal(orderRemovalBlock(store, order), blockedReason);
  assert.deepEqual(publicOrderFor(order, { role: 'super_admin' }, store).removal,
    { allowed: blockedReason === null, blockedReason });
});

test('removal eligibility is recomputed and historical removal data never leaks to another role', () => {
  const order = { ...baseOrder, removal: { allowed: false, blockedReason: 'stale' } };
  assert.deepEqual(publicOrderFor(order, { role: 'super_admin' }, baseStore).removal, { allowed: true, blockedReason: null });
  for (const role of ['ops_admin', 'client', 'supplier', 'rider', 'staff', undefined]) {
    assert.equal(Object.hasOwn(publicOrderFor(order, { id: 'client', role }, baseStore), 'removal'), false, role);
  }
  for (const store of [null, {}]) {
    assert.equal(Object.hasOwn(publicOrderFor(order, { role: 'super_admin' }, store), 'removal'), false, 'no eligibility without domain facts');
  }
  const staleAdmin = { id: 'ops', role: 'super_admin' };
  resolveAuthorizationContext({ userRoleMemberships: [{ userId: 'ops', role: 'ops_admin' }] }, staleAdmin);
  assert.equal(Object.hasOwn(publicOrderFor(order, staleAdmin, baseStore), 'removal'), false, 'database memberships override stale roles');
});

test('an accepted voucher funding snapshot cannot disappear even without a loaded voucher ledger', () => {
  const store = { users: [{ id: 'client', reviewData: false }] };
  const order = { id: 'unpaid', clientId: 'client', payments: { initial: { status: 'not_submitted' } } };
  assert.equal(orderRemovalBlock(store, order), null);
  order.voucher = { id: 'vch_funding', amountMinor: 500, fundedBy: 'GRIDGO' };
  assert.ok(orderRemovalBlock(store, order));
});

test('a combined legacy receipt keeps client pricing private without a loaded public basket', async () => {
  const store = fixture();
  store.baskets = [];
  store.orderInvoices.push({ orderId: 'order', snapshot: {
    basketId: 'legacy_basket', itemSubtotalMinor: 20000, serviceFeeMinor: 2000, serviceFeeRateBps: 1000,
    totalMinor: 24000, groups: [{ orderId: 'order', itemSubtotalMinor: 10000, serviceFeeMinor: 1000,
      lines: [{ quantity: 10, unitPriceMinor: 1000, amountMinor: 10000 }] }],
  } });
  const response = await routeOrderMatch({ req: { method: 'GET' }, url: new URL('http://test/orders/order/invoice'),
    store, user: { id: 'client', role: 'client' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.invoice.itemSubtotalMinor, undefined);
  assert.equal(response.body.invoice.serviceFeeMinor, undefined);
  assert.equal(response.body.invoice.groups[0].lines[0].unitPriceMinor, undefined);
  assert.equal(response.body.invoice.groups[0].lines[0].amountMinor, undefined);
  assert.equal(response.body.invoice.groups[0].clientItemSubtotalMinor, 11000);
});

test('basket group order projections retain Super Admin eligibility without exposing it to other readers', () => {
  const store = fixture();
  const basket = { orderIds: ['order'], payment: { status: 'confirmed' } };
  for (const role of ['super_admin', 'ops_admin', 'client']) {
    const order = publicBasket(store, basket, { id: role === 'client' ? 'client' : role, role }).groups[0].order;
    if (role === 'super_admin') assert.deepEqual(order.removal, { allowed: false, blockedReason: 'payment_submitted' });
    else assert.equal(Object.hasOwn(order, 'removal'), false, role);
  }
});
