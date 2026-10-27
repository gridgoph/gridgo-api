import { refundFail as fail, sumMinor, productionStarted, deliveryCompleted, calculateRefundSettlement, refundHold, noCashVoucherRemedy } from './refund-policy.js';
import { approvalSnapshotSha256 } from './approval-proof.js';
import { rescheduleHold } from './order-reschedule-policy.js';
import { changePaymentPending } from './order-change-policy.js';
import { deliveryPinPaymentPending } from './delivery-pin-policy.js';

/** The opt-in cancellation quote uses the existing available-funds arithmetic. */
export function cancellationQuote(store, order) {
  if (order.state === 'cancelled' || refundHold(store, order)
    || (store.refundSettlements || []).some(row => row.orderId === order.id && row.disposition !== 'delivery_adjustment')) {
    fail(409, 'refund_state_conflict', 'Resolve the existing cancellation or refund first.');
  }
  if (deliveryCompleted(order)) fail(409, 'cancellation_after_delivery', 'Report a problem with a delivered order.');
  if (['picked_up', 'out_for_delivery', 'rider_assigned'].includes(order.state)) fail(409, 'cancellation_delivery_review_required', 'Operations must reconcile the rider obligation through the existing refund workflow.');
  if (Object.values(order.payments || {}).some(row => row.status === 'pending_confirmation') || order.directStoreDueMinor > 0
    || changePaymentPending(store, order) || deliveryPinPaymentPending(order)) {
    fail(409, 'refund_collection_reconciliation_required', 'Reconcile pending or direct collection first.');
  }
  if (rescheduleHold(order) || (order.shopRecovery && order.shopRecovery.status !== 'accepted')) {
    fail(409, 'cancellation_manual_review_required', 'Resolve the existing recovery or deadline request with Operations.');
  }
  // Additional paid work and applied deductions need an agreed manual entitlement.
  if ((store.orderChangePayments || []).some(row => row.orderId === order.id)
    || (order.payoutMilestones || []).some(row => row.productionDeductionMinor > 0)) {
    fail(409, 'cancellation_manual_review_required', 'Operations must review the adjusted work entitlement.');
  }
  const beforeProduction = !productionStarted(order);
  const start = (order.payoutMilestones || []).find(row => row.code === 'production_started');
  if (!beforeProduction && (order.payoutPlanVersion !== 2 || !start)) {
    fail(409, 'cancellation_legacy_review_required', 'Operations must review the historical payout plan.');
  }
  const earlier = Object.fromEntries(['principalMinor', 'feeMinor', 'deliveryMinor'].map(field => [field,
    sumMinor((store.refundSettlements || []).filter(row => row.orderId === order.id).map(row => row[field]))]));
  const amounts = calculateRefundSettlement(order, { store, beforeProduction,
    shopEntitlementMinor: beforeProduction ? 0 : start.amountMinor, riderEntitlementMinor: 0, earlier });
  if (!amounts.totalMinor && !noCashVoucherRemedy(order, store)) fail(409, 'refund_no_available_funds', 'No verified cash remains to refund.');
  const quoteToken = approvalSnapshotSha256({ orderId: order.id, state: order.state, updatedAt: order.updatedAt,
    payments: order.payments, allocations: order.paymentAllocations, stages: order.payoutMilestones,
    quoteVersion: order.quoteVersion, beforeProduction, amounts });
  return { policyVersion: 'cancellation_quote_v1', quoteToken, beforeProduction, amounts };
}

/** Client-safe quote: no supplier stage, collection, or entitlement internals. */
export function publicCancellationQuote(quote) {
  const { principalMinor, feeMinor, deliveryMinor, totalMinor } = quote.amounts;
  return { policyVersion: quote.policyVersion, quoteToken: quote.quoteToken, beforeProduction: quote.beforeProduction,
    refund: { principalMinor, feeMinor, deliveryMinor, totalMinor } };
}

// Existing append-only refund events own the accepted quote; no new ledger.
export function acceptedCancellationQuote(store, request) {
  return (store.refundEvents || []).find(row => row.requestId === request.id && row.kind === 'requested')?.data?.cancellationQuote ?? null;
}
