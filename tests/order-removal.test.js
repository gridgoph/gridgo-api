import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRemovalBlock } from '../src/order-removal.js';

test('an accepted voucher funding snapshot cannot disappear even without a loaded voucher ledger', () => {
  const store = { users: [{ id: 'client', reviewData: false }] };
  const order = { id: 'unpaid', clientId: 'client', payments: { initial: { status: 'not_submitted' } } };
  assert.equal(orderRemovalBlock(store, order), null);
  order.voucher = { id: 'vch_funding', amountMinor: 500, fundedBy: 'GRIDGO' };
  assert.ok(orderRemovalBlock(store, order));
});
