import { sumMinor } from './refund-policy.js';

const minor = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid voucher minor units');
  return value;
};
// Largest-remainder integer apportionment, stable ties in checkout group order.
export function splitVoucherMinor(total, weights) {
  minor(total); weights.forEach(minor);
  const denominator = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (!weights.length) return [];
  if (!denominator) return splitVoucherMinor(total, weights.map(() => 1));
  const shares = weights.map(weight => Number(BigInt(total) * BigInt(weight) / denominator));
  const ranked = weights.map((weight, index) => ({ index, remainder: BigInt(total) * BigInt(weight) % denominator }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0, left = total - sumMinor(shares); i < left; i++) shares[ranked[i].index]++;
  return shares;
}

/** Client discounts leave gross supplier and rider entitlements intact. */
export function voucherMoney(groups, valueMinor = 0, { coversOrderTotal = false } = {}) {
  const fees = groups.map(g => minor(g.grossServiceFeeMinor ?? g.serviceFeeMinor));
  const deliveries = groups.map(g => !coversOrderTotal && g.serviceFeeSchedule?.version === 2 ? 0 : minor(g.deliveryFeeMinor));
  const principals = groups.map(g => coversOrderTotal ? minor(g.supplierSubtotalMinor) : 0);
  const feeTotal = sumMinor(fees), deliveryTotal = sumMinor(deliveries), principalTotal = sumMinor(principals);
  const organizationDiscountMinor = sumMinor(groups.map(g => minor(g.organizationDiscountMinor ?? 0)));
  const candidate = Math.min(minor(valueMinor), sumMinor([feeTotal, deliveryTotal, principalTotal]));
  // Ties preserve the automatic organization discount and the voucher for later.
  const voucherDiscountMinor = candidate > organizationDiscountMinor ? candidate : 0;
  const feeDiscount = Math.min(voucherDiscountMinor, feeTotal);
  const feeShares = splitVoucherMinor(feeDiscount, fees);
  const deliveryDiscount = Math.min(voucherDiscountMinor - feeDiscount, deliveryTotal);
  const principalShares = splitVoucherMinor(voucherDiscountMinor - feeDiscount - deliveryDiscount, principals);
  // Allocate remaining funding by fee shares, capped by each group's delivery.
  const deliveryShares = groups.map(() => 0);
  let remaining = deliveryDiscount;
  while (remaining) {
    const eligible = deliveries.map((capacity, i) => capacity > deliveryShares[i] ? i : -1).filter(i => i >= 0);
    const shares = splitVoucherMinor(remaining, eligible.map(i => fees[i]));
    let assigned = 0;
    eligible.forEach((index, i) => { const amount = Math.min(shares[i], deliveries[index] - deliveryShares[index]); deliveryShares[index] += amount; assigned += amount; });
    if (!assigned) throw new RangeError('Voucher allocation exhausted');
    remaining -= assigned;
  }
  return { voucherDiscountMinor, organizationDiscountMinor: voucherDiscountMinor ? 0 : organizationDiscountMinor,
    discountKind: voucherDiscountMinor ? 'voucher' : organizationDiscountMinor ? 'organization' : null,
    groups: groups.map((group, index) => {
      const organization = voucherDiscountMinor ? 0 : (group.organizationDiscountMinor ?? 0);
      const discount = feeShares[index] + deliveryShares[index] + principalShares[index];
      return { organizationDiscountMinor: organization, organizationDiscountRateBps: voucherDiscountMinor ? 0 : group.organizationDiscountRateBps ?? 0,
        serviceFeeMinor: fees[index] - organization, voucherDiscountMinor: discount,
        ...(coversOrderTotal ? { voucherSupplierMinor: principalShares[index], clientSupplierSubtotalMinor: group.supplierSubtotalMinor - principalShares[index], coversOrderTotal: true } : {}),
        voucherServiceFeeMinor: feeShares[index], voucherDeliveryMinor: deliveryShares[index],
        clientServiceFeeMinor: fees[index] - organization - feeShares[index],
        clientDeliveryFeeMinor: group.deliveryFeeMinor - deliveryShares[index],
        totalMinor: sumMinor([minor(group.supplierSubtotalMinor) - principalShares[index], fees[index] - organization - feeShares[index], group.deliveryFeeMinor - deliveryShares[index]]) };
    }) };
}

export function applyVoucherMoney(order, allocation, voucher) {
  Object.assign(order, allocation);
  if (!allocation.voucherDiscountMinor) return;
  order.voucher = { id: voucher.id, campaignId: voucher.campaignId, label: 'GRIDGO-funded voucher', fundedBy: 'GRIDGO',
    amountMinor: allocation.voucherDiscountMinor, serviceFeeMinor: allocation.voucherServiceFeeMinor,
    deliveryMinor: allocation.voucherDeliveryMinor,
    ...(allocation.coversOrderTotal ? { coversOrderTotal: true, supplierMinor: allocation.voucherSupplierMinor } : {}) };
  order.onlineDueMinor = order.totalMinor;
  if (allocation.coversOrderTotal) {
    order.gridgoSupplierTopupMinor = allocation.voucherSupplierMinor;
    order.gridgoRiderTopupMinor = Math.max(0, (order.riderPayoutMinor ?? Number((BigInt(order.deliveryFeeMinor) * BigInt(order.riderCommissionBps ?? 10000) + 5000n) / 10000n)) - allocation.clientDeliveryFeeMinor);
    order.voucher.gridgoSupplierTopupMinor = order.gridgoSupplierTopupMinor;
    order.voucher.gridgoRiderTopupMinor = order.gridgoRiderTopupMinor;
  }
  // Cash and GRIDGO funding reconcile separately against each gross component.
  for (const [component, discount] of [['service_fee', allocation.voucherServiceFeeMinor], ['delivery_pass_through', allocation.voucherDeliveryMinor], ['supplier_principal', allocation.voucherSupplierMinor || 0]]) {
    let remaining = discount;
    for (const paymentCode of ['initial', 'final_online']) {
      const row = order.paymentAllocations.find(a => a.component === component && a.paymentCode === paymentCode);
      if (!row) continue;
      const reduction = Math.min(row.amountMinor, remaining);
      row.amountMinor -= reduction;
      if (allocation.coversOrderTotal) row.gridgoFundedMinor = (row.gridgoFundedMinor || 0) + reduction;
      order.payments[paymentCode].amountMinor -= reduction;
      remaining -= reduction;
    }
    if (remaining) throw new RangeError('Voucher exceeds payment allocation');
  }
  order.paymentAllocations = order.paymentAllocations.filter(a => a.amountMinor > 0 || a.gridgoFundedMinor > 0);
  if (!order.payments.final_online.amountMinor) order.payments.final_online.status = 'not_required';
}
