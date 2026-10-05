/** Option B: cash already collected, with earned obligations protected. */
export class RefundError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export function refundFail(status, code, message, details) {
  throw new RefundError(status, code, message, details);
}

export function refundMinor(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refundFail(400, 'invalid_refund_amount', `${field} must be non-negative integer centavos.`, { field });
  }
  return value;
}

export function sumMinor(values) {
  const sum = values.reduce((total, value) => total + BigInt(refundMinor(value, 'amountMinor')), 0n);
  return refundMinor(Number(sum), 'totalMinor');
}

export const ACTIVE_REFUND_STATUSES = ['requested', 'reviewed', 'approved', 'destination_review', 'payment_in_progress', 'payment_unknown'];
const PRODUCTION_STATES = new Set(['production', 'supplier_self_qc', 'ready_for_dispatch', 'rider_assigned',
  'picked_up', 'out_for_delivery', 'awaiting_collection', 'delivered', 'issue_window_open', 'completed', 'payout_released']);

export function productionStarted(order) {
  return PRODUCTION_STATES.has(order.state)
    || (order.timeline || []).some((event) => PRODUCTION_STATES.has(event.state))
    || (order.payoutMilestones || []).some((stage) => stage.status === 'released');
}

export function handoverCompleted(order) {
  return Boolean(order.issueWindowOpenedAt)
    || ['delivered', 'issue_window_open', 'completed', 'payout_released'].includes(order.state)
    || (order.timeline || []).some((event) => event.state === 'delivered');
}

export function deliveryCompleted(order) {
  return handoverCompleted(order) || order.state === 'awaiting_collection'
    || (order.timeline || []).some((event) => event.state === 'awaiting_collection');
}

export function refundHold(store, order) {
  return (store?.refundRequests || []).some((request) => request.orderId === order.id
    && ACTIVE_REFUND_STATUSES.includes(request.status));
}

export function refundSettlementFor(store, order) {
  return (store?.refundSettlements || []).filter((row) => row.orderId === order.id)
    .sort((a, b) => a.sequence - b.sequence).at(-1) || null;
}

export function supplierRefundPayouts(store, order) {
  return (store?.refundSupplierPayouts || []).filter((row) => row.orderId === order.id).map((row) => ({
    ...row, code: 'refund_settlement', label: 'Agreed refund settlement payout',
    releaseRequires: 'Operations records the exact remaining shop obligation with reference and wallet transfer evidence.',
  }));
}

export function assertRefundWorkAllowed(store, order) {
  if (order.shopRecovery && order.shopRecovery.status !== 'accepted') {
    refundFail(409, 'shop_recovery_pending', 'Resolve the shop replacement or refund before continuing.');
  }
  if (refundHold(store, order) || refundSettlementFor(store, order)) {
    refundFail(409, 'refund_fulfillment_stopped', 'This order is stopped for a refund. Resolve the refund before continuing.');
  }
}

export function collectedRefundComponents(order) {
  if (Object.values(order.payments || {}).some((payment) => payment.status === 'confirmed' && payment.method !== 'qr_manual')) {
    refundFail(409, 'refund_collection_reconciliation_required', 'Only verified cash transfers are refundable. Pilot Credits are never cash.');
  }
  const components = { principalMinor: 0, feeMinor: 0, deliveryMinor: 0 };
  const names = { supplier_principal: 'principalMinor', service_fee: 'feeMinor', delivery_pass_through: 'deliveryMinor' };
  for (const allocation of order.paymentAllocations || []) {
    if (order.payments?.[allocation.paymentCode]?.status !== 'confirmed') continue;
    const field = names[allocation.component];
    if (field) components[field] = sumMinor([components[field], allocation.amountMinor]);
  }
  const verified = sumMinor(Object.values(order.payments || {}).filter((payment) => payment.status === 'confirmed')
    .map((payment) => payment.amountMinor));
  if (sumMinor(Object.values(components)) !== verified) {
    refundFail(409, 'refund_collection_reconciliation_required', 'Operations must reconcile verified payment allocations before settlement.');
  }
  return components;
}

/** Cumulative proportional rounding gives the final refund the exact remainder. */
function proportionalFee(order, principal, collected, earlier) {
  const basis = refundMinor(order.supplierSubtotalMinor, 'supplierSubtotalMinor');
  if (!basis) return 0;
  const cumulativePrincipal = BigInt(sumMinor([earlier.principalMinor, principal]));
  const denominator = BigInt(basis);
  const cumulativeFee = Number((BigInt(refundMinor(order.serviceFeeMinor, 'serviceFeeMinor')) * cumulativePrincipal + denominator / 2n) / denominator);
  return Math.max(0, Math.min(collected.feeMinor - earlier.feeMinor, cumulativeFee - earlier.feeMinor));
}

export function calculateRefundSettlement(order, {
  beforeProduction, shopEntitlementMinor, riderEntitlementMinor, earlier = {}, principalMinor, settlementPaidMinor = 0,
}) {
  const collected = collectedRefundComponents(order);
  const previous = Object.fromEntries(['principalMinor', 'feeMinor', 'deliveryMinor'].map((field) =>
    [field, refundMinor(earlier[field] ?? 0, field)]));
  const releasedMinor = sumMinor([settlementPaidMinor, ...(order.payoutMilestones || []).filter((stage) => stage.status === 'released')
    .map((stage) => stage.amountMinor)]);
  refundMinor(shopEntitlementMinor, 'shopEntitlementMinor');
  refundMinor(riderEntitlementMinor, 'riderEntitlementMinor');
  if (riderEntitlementMinor > collected.deliveryMinor - previous.deliveryMinor) {
    refundFail(409, 'refund_requires_super_admin', 'Verified delivery funds do not cover the rider obligation. Reconcile collection with Super Admin before approving.', { escalateTo: 'super_admin' });
  }
  if (shopEntitlementMinor < releasedMinor) {
    refundFail(409, 'refund_requires_super_admin', 'This settlement would recover a released shop payout. Refer it to Super Admin.', { escalateTo: 'super_admin' });
  }
  const remainingShopMinor = shopEntitlementMinor - releasedMinor;
  if (shopEntitlementMinor > collected.principalMinor - previous.principalMinor
      || previous.feeMinor > collected.feeMinor || previous.deliveryMinor > collected.deliveryMinor) {
    refundFail(409, 'refund_exceeds_available_funds', 'Verified funds do not cover the agreed obligations. Refer this to Super Admin.', { escalateTo: 'super_admin' });
  }
  if (beforeProduction && (releasedMinor || shopEntitlementMinor || riderEntitlementMinor)) {
    refundFail(409, 'refund_requires_super_admin', 'A full pre-production refund conflicts with recorded obligations. Refer it to Super Admin.', { escalateTo: 'super_admin' });
  }
  const availablePrincipalMinor = Math.max(0, collected.principalMinor - previous.principalMinor - releasedMinor - remainingShopMinor);
  const principal = principalMinor ?? availablePrincipalMinor;
  refundMinor(principal, 'principalMinor');
  if (principal > availablePrincipalMinor || (beforeProduction && principal !== availablePrincipalMinor)) {
    refundFail(409, 'refund_exceeds_available_funds', 'The refund exceeds available funds. Refer the requested remedy to Super Admin.', {
      availablePrincipalMinor, escalateTo: 'super_admin',
    });
  }
  const feeMinor = beforeProduction ? collected.feeMinor - previous.feeMinor : proportionalFee(order, principal, collected, previous);
  const deliveryMinor = deliveryCompleted(order) ? 0
    : Math.max(0, collected.deliveryMinor - previous.deliveryMinor - riderEntitlementMinor);
  const amounts = { principalMinor: principal, feeMinor, deliveryMinor };
  return { ...amounts, totalMinor: sumMinor(Object.values(amounts)), collected, previous, releasedMinor,
    remainingShopMinor, shopEntitlementMinor, riderEntitlementMinor, availablePrincipalMinor };
}
