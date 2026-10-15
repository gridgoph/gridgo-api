/** Original checkout money is immutable; these helpers apply only the saved delivery adjustment. */
export function appliedPinChange(order) {
  return order?.deliveryPin?.change?.status === 'applied' ? order.deliveryPin.change : null;
}
export function deliveryPinCollectedMinor(order) {
  return appliedPinChange(order)?.payment?.amountMinor || 0;
}
export function effectiveDeliveryFeeMinor(order) {
  return (order.deliveryFeeMinor || 0) + (appliedPinChange(order)?.feeDifferenceMinor || 0);
}
export function adjustedDeliverySplit(order, split) {
  const change = appliedPinChange(order);
  return { ...split, riderPayoutMinor: split.riderPayoutMinor + (change?.riderDifferenceMinor || 0),
    platformDeliveryShareMinor: split.platformDeliveryShareMinor + (change?.platformDifferenceMinor || 0) };
}
export function deliveryPinPaymentPending(order) {
  return order?.deliveryPin?.change?.status === 'pending_confirmation';
}
export function deliveryPinLocked(order) {
  return Boolean(order.riderId || order.riderAssignedAt || order.deliveryPin?.dispatchedAt
    || !['production', 'supplier_self_qc', 'ready_for_dispatch'].includes(order.state)
    || (order.timeline || []).some(entry => ['rider_assigned', 'picked_up', 'out_for_delivery'].includes(entry.state)));
}

export function deliveryPinConfirmable(order) {
  return Boolean(order?.deliveryPin && order.fulfillmentMode === 'delivery'
    && ['production', 'supplier_self_qc', 'ready_for_dispatch', 'rider_assigned', 'picked_up', 'out_for_delivery'].includes(order.state));
}
