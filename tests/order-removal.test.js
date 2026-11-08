import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRemovalBlock } from '../src/order-removal.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { fixture } from './fixtures/reschedule.js';

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
