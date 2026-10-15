// Pure policy shared by projections, refunds and the change-request route.
export const changesFor = (store, order) => (store?.orderChanges || []).filter(row => row.orderId === order.id);
export const changePaymentsFor = (store, order) => (store?.orderChangePayments || []).filter(row => row.orderId === order.id);
export const changePayoutsFor = (store, order) => (store?.orderChangePayouts || []).filter(row => row.orderId === order.id);
export const changePaymentPending = (store, order) => changesFor(store, order).some(row => row.status === 'pending_confirmation');
export const changeWindowOpen = order => ['supplier_assigned', 'supplier_accepted', 'payment_authorized', 'production', 'supplier_self_qc'].includes(order.state)
  && !(order.timeline || []).some(row => ['ready_for_dispatch', 'rider_assigned', 'picked_up', 'delivered', 'completed'].includes(row.state));
export function supplementTotals(store, order) {
  const rows = changePaymentsFor(store, order);
  return { principalMinor: rows.reduce((sum, row) => sum + row.principalMinor, 0),
    feeMinor: rows.reduce((sum, row) => sum + row.feeMinor, 0),
    totalMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0) };
}
export function publicChange(store, row, role) {
  const { data, ...base } = row;
  const result = { ...base, ...structuredClone(data) };
  if (!['ops_admin', 'super_admin'].includes(role)) {
    delete result.feeSchedule; delete result.originalPrincipalMinor; delete result.feeMinor;
    delete result.originalReadyBy; delete result.originalPromiseBy; delete result.priorLapse;
  }
  if (role === 'client') { delete result.extraPrincipalMinor; delete result.supplierId; delete result.proposedReadyBy; }
  if (role === 'supplier') { delete result.payment; delete result.paymentHistory; delete result.totalMinor; }
  if (['supplier', 'ops_admin', 'super_admin'].includes(role) && row.status === 'applied' && row.extraPrincipalMinor > 0) {
    const payout = (store.orderChangePayouts || []).find(p => p.changeId === row.id);
    const settled = (store.refundSettlements || []).some(s => s.orderId === row.orderId && s.disposition !== 'delivery_adjustment');
    result.payout = payout ? { ...payout, status: 'released' } : { status: settled ? 'superseded' : 'pending', amountMinor: row.extraPrincipalMinor, releaseRequires: 'final_payout_stage' };
  }
  return result;
}

// A supplement cannot be counted again through an older installment/basket/pin route.
export function assertSupplementCollectionsUnique(store) {
  for (const extra of store.orderChangePayments || []) {
    const duplicate = (store.orders || []).some(order => Object.values(order.payments || {}).some(payment => payment.status === 'confirmed'
      && (payment.reference?.trim().toUpperCase() === extra.reference || payment.proofFileId === extra.proofFileId)))
      || (store.deliveryPinPayments || []).some(payment => payment.reference.trim().toUpperCase() === extra.reference || payment.proofFileId === extra.proofFileId);
    if (duplicate) throw Object.assign(new Error('This transfer is already recorded as a supplement.'), { status: 409, code: 'change_payment_reference_used' });
  }
}
