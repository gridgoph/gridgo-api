import { deliverySplit } from './operational-model.js';

export const cashFail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
export const cashSettings = settings => ({ enabled: false, limitMinor: 150000, noShowWaitSeconds: 600, ...settings?.cash });
export function validateCashSettings(settings) {
  if (settings?.cash === undefined) return;
  const cash = cashSettings(settings);
  if (!settings.cash || typeof settings.cash !== 'object' || Array.isArray(settings.cash)
    || Object.keys(settings.cash).some(k => !['enabled', 'limitMinor', 'noShowWaitSeconds'].includes(k))
    || typeof cash.enabled !== 'boolean' || !Number.isSafeInteger(cash.limitMinor) || cash.limitMinor < 1
    || !Number.isInteger(cash.noShowWaitSeconds) || cash.noShowWaitSeconds < 60 || cash.noShowWaitSeconds > 7200) cashFail('invalid_cash_settings', 400);
}
export function requireCashCheckout(settings, user, cartPrintAndFeeMinor) {
  validateCashSettings(settings);
  if (cashSettings(settings).enabled!==true) cashFail('cash_disabled');
  if (user?.role !== 'client' || user.accountType !== 'individual') cashFail('cash_individual_only', 403);
  if (!Number.isSafeInteger(cartPrintAndFeeMinor) || cartPrintAndFeeMinor < 0
    || cartPrintAndFeeMinor >= cashSettings(settings).limitMinor) cashFail('cash_limit_exceeded');
}
export function cashAmounts(order) {
  const split = deliverySplit(order.deliveryFeeMinor, order.riderCommissionBps);
  const stage=order.payoutMilestones?.find(s=>s.code==='cash_shop');
  const productionDeductionMinor=stage?.productionDeductionMinor||0;
  const gridgoFeeShareMinor=order.serviceFeeMinor+split.platformDeliveryShareMinor;
  const amounts = { shopMinor: stage?.amountMinor??order.supplierSubtotalMinor, collectMinor: order.totalMinor,
    gridgoMinor: gridgoFeeShareMinor+productionDeductionMinor, riderMinor: split.riderPayoutMinor };
  if (amounts.shopMinor+productionDeductionMinor!==order.supplierSubtotalMinor) cashFail('cash_snapshot_invalid');
  if (Object.values(amounts).some(v => !Number.isSafeInteger(v) || v < 0)
    || BigInt(amounts.shopMinor) + BigInt(amounts.gridgoMinor) + BigInt(amounts.riderMinor)
      !== BigInt(amounts.collectMinor) + BigInt(order.voucherDiscountMinor || 0)) cashFail('cash_snapshot_invalid');
  return { ...amounts, ...(productionDeductionMinor?{productionDeductionMinor,gridgoFeeShareMinor}:{}),
    ...(order.voucherDiscountMinor ? { voucherMinor: order.voucherDiscountMinor } : {}) };
}
export const cashAmountKey = amounts => ['shopMinor','collectMinor','gridgoMinor','riderMinor','voucherMinor','productionDeductionMinor'].map(k=>amounts?.[k]||0).join(':');
export function cashCovered(store, order, riderId) {
  if (!order.cash || order.cashProgress?.redelivery?.paidAt || cashAmounts(order).gridgoMinor===0) return true;
  const wallet = store.cashWallets?.[riderId];
  return Boolean(wallet && wallet.balanceMinor - wallet.reservedMinor >= cashAmounts(order).gridgoMinor);
}
