/** GRIDGO funding follows a settled installment, including a zero balance after initial confirmation. */
export function collectedVoucherFundingMinor(order, component) {
  return (order.paymentAllocations || []).filter(a => a.component === component
    && (order.payments?.[a.paymentCode]?.status === 'confirmed'
      || order.payments?.[a.paymentCode]?.status === 'not_required' && order.payments?.initial?.status === 'confirmed'))
    .reduce((total, a) => total + (a.gridgoFundedMinor || 0), 0);
}
