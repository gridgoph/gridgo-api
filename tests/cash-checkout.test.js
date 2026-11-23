import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutFixture, makeCart } from './helpers/promotion-checkout.mjs';
import { publicOrderFor } from '../src/operational-model.js';

test('cash checkout enters file QA without fabricating collection; cash plan and amounts are role scoped', async () => {
  const store = checkoutFixture();
  store.vouchers = [];
  store.settings.cash.enabled = true;
  const { call, path } = await makeCart(store);
  const result = await call('POST', `${path}/checkout`, { payment: { method: 'cash' } });
  const order = store.orders.find(o => o.id === result.body.order.id);
  assert.equal(order.state, 'needs_qa');
  assert.equal(order.payments.initial.status, 'not_submitted');
  assert.equal(order.payments.initial.method, 'cash');
  assert.equal(order.riderCommissionBps, 8000);
  assert.equal(order.payoutPlanVersion, 3);
  assert.equal(order.payoutMilestones[0].code, 'cash_shop');
  assert.equal(order.payoutMilestones[0].amountMinor, order.supplierSubtotalMinor);
  assert.equal(order.cash.noShowWaitSeconds, 600);
  assert.equal(result.body.invoice.paymentPlan.method, 'cash');
  assert.equal(publicOrderFor(order, store.users.find(u => u.id === 'client'), store).cashAmounts, undefined);
  assert.equal(publicOrderFor(order, { id: 'ops', role: 'ops_admin' }, store).cashAmounts.shopMinor, order.supplierSubtotalMinor);
});

test('whole-cart cash limit and debts fail closed; online checkout keeps its current split', async () => {
  for (const mode of ['disabled', 'limit', 'debt', 'online']) {
    const store = checkoutFixture();
    store.vouchers = [];
    store.settings.cash.enabled = mode !== 'disabled';
    if (mode === 'limit') store.settings.cash.limitMinor = 2000;
    if (mode === 'debt') store.orders[0].cashProgress = { noShowApprovedAt: '2026-10-27T00:00:00Z' };
    const { call, path } = await makeCart(store, [1, 1]);
    if (mode === 'online') {
      await call('POST', `${path}/checkout`, { payment: { method: 'qr_manual', reference: 'ONLINE', proofFileId: 'receipt' } });
      assert.equal(store.orders.at(-1).riderCommissionBps, 8000);
    } else await assert.rejects(call('POST', `${path}/checkout`, { payment: { method: 'cash' } }),
      { code: { disabled: 'cash_disabled', limit: 'cash_limit_exceeded', debt: 'cash_client_barred' }[mode] });
  }
});

test('pending shops cannot enter new cash checkout even with cash enabled',async()=>{
  const store=checkoutFixture();store.vouchers=[];store.settings.cash.enabled=true;
  // Create the draft under the verified listing, then recheck current identity at checkout.
  const {call,path}=await makeCart(store);
  store.approvalCases.find(c=>c.userId==='supplier').status='pending';
  await assert.rejects(call('POST',`${path}/checkout`,{payment:{method:'cash'}}),{code:'cash_supplier_verification_required'});
});
