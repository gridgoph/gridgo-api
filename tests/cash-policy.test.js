import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultOperationalSettings, validateOperationalSettings } from '../src/operational-model.js';
import { cashSettings, cashAmounts, requireCashCheckout, cashCovered } from '../src/cash-policy.js';

test('cash is opt-in; individual-only strict whole-cart limit excludes fare', () => {
  const user = { id: 'client', role: 'client', accountType: 'individual' };
  assert.equal(cashSettings(defaultOperationalSettings()).enabled, false);
  assert.throws(() => requireCashCheckout({}, user, 100), { code: 'cash_disabled' });
  const settings = { cash: { enabled: true, limitMinor: 150000, noShowWaitSeconds: 600 } };
  requireCashCheckout(settings, user, 149999);
  assert.throws(() => requireCashCheckout(settings, user, 150000), { code: 'cash_limit_exceeded' });
  for (const accountType of ['business', 'organization', undefined]) {
    assert.throws(() => requireCashCheckout(settings, { ...user, accountType }, 100), { code: 'cash_individual_only' });
  }
  for (const cash of [null, { enabled: 'true' }, { enabled: true, limitMinor: 1.2 }, { enabled: false, limitMinor: 0 }, { enabled: false, noShowWaitSeconds: -1 }]) {
    assert.throws(() => validateOperationalSettings({ ...defaultOperationalSettings(), cash }));
  }
});

test('cash uses immutable amounts and the shared split, coverage subtracts reservations', () => {
  const order = { cash: { version: 1 }, supplierSubtotalMinor: 40000, serviceFeeMinor: 18000,
    deliveryFeeMinor: 8900, riderCommissionBps: 8000, totalMinor: 66900 };
  assert.deepEqual(cashAmounts(order), { shopMinor: 40000, collectMinor: 66900, gridgoMinor: 19780, riderMinor: 7120 });
  const store = { cashWallets: { rider: { balanceMinor: 20000, reservedMinor: 221 } } };
  assert.equal(cashCovered(store, order, 'rider'), false);
  store.cashWallets.rider.reservedMinor = 220;
  assert.equal(cashCovered(store, order, 'rider'), true);
  assert.equal(cashCovered({}, { totalMinor: 999999 }, 'rider'), true);
  order.riderCommissionBps = 8500;
  assert.equal(cashAmounts(order).gridgoMinor, 19335);
});

test('cash custodies an already-approved production deduction without repricing the client or gifting it to the rider',()=>{
  const order={cash:{version:1},supplierSubtotalMinor:10000,serviceFeeMinor:1000,deliveryFeeMinor:1000,riderCommissionBps:8000,totalMinor:12000,
    payoutMilestones:[{code:'cash_shop',amountMinor:9500,productionDeductionMinor:500}]};
  assert.deepEqual(cashAmounts(order),{shopMinor:9500,collectMinor:12000,gridgoMinor:1700,riderMinor:800,
    productionDeductionMinor:500,gridgoFeeShareMinor:1200});
  assert.equal(cashCovered({cashWallets:{rider:{balanceMinor:1200,reservedMinor:0}}},order,'rider'),false);
  assert.equal(cashCovered({cashWallets:{rider:{balanceMinor:1700,reservedMinor:0}}},order,'rider'),true);
  assert.equal(order.totalMinor,12000);
});
