/**
 * Substitute-shop price rule (gridgoph/gridgo-api#225).
 *
 * When an order moves shop because the shop failed (timeout, decline,
 * cancellation, lateness) or because of GRIDGO, the client never pays for a
 * problem they did not cause:
 * - cheaper substitute: the difference is returned through the manual refund flow;
 * - dearer substitute: GRIDGO covers the difference from its service fee, up to
 *   `shopMoveCoverBps` of the original service fee and never more than the fee it
 *   actually collected on the order;
 * - above that cover the client chooses: pay the rest, another offered shop, or a
 *   full refund.
 * The substitute shop is paid on its own price. A client-caused move keeps the
 * legacy rule: only same-or-cheaper lines, paid at the original committed price.
 *
 * Every figure is snapshotted on the recovery offer and on `order.shopMoves`, so
 * projections need no settings or ledger read. Contract: docs/SHOP_RECOVERY_API.md.
 */
import { supplementTotals } from './order-change-policy.js';
import { isReviewData } from './review-data.js';

export const DEFAULT_SHOP_MOVE_COVER_BPS = 5_000;
export const SHOP_FAULT_KINDS = Object.freeze(['timed_out', 'declined', 'cancelled', 'late']);
export const OPERATIONS_RECOVERY_CAUSES = Object.freeze(['late', 'gridgo', 'client']);

export const recoveryFault = (kind) => (kind === 'gridgo' ? 'gridgo' : kind === 'client' ? 'client' : 'shop');

export function shopMoveCoverBps(settings) {
  return Number.isInteger(settings?.shopMoveCoverBps) ? settings.shopMoveCoverBps : DEFAULT_SHOP_MOVE_COVER_BPS;
}

export function validateShopMoveCoverBps(value, fail) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 10_000)) {
    fail(400, 'invalid_shop_move_cover', 'Set the substitute-shop cover to a whole number from 0 to 10,000 basis points of the original service fee.', { field: 'shopMoveCoverBps' });
  }
}

const safe = (value) => {
  if (!Number.isSafeInteger(value)) throw Object.assign(new Error('shop_move_money_out_of_range'), { status: 409, code: 'shop_move_money_out_of_range' });
  return value;
};
const halfUpBps = (amountMinor, bps) => Number((BigInt(amountMinor) * BigInt(bps) + 5_000n) / 10_000n);
const sum = (rows, field) => safe(rows.reduce((total, row) => total + (row?.[field] || 0), 0));

/** Covers already applied on this order consume the same collected fee. */
export const appliedShopMoves = (order) => (order.shopMoves || []).filter((move) => ['applied', 'awaiting_payment'].includes(move.status));

/** Service fee cash GRIDGO actually holds for this order, net of refunds and earlier covers. */
export function collectedServiceFeeMinor(store, order) {
  if (isReviewData(order)) return 0;
  const collected = (order.paymentAllocations || [])
    .filter((row) => row.component === 'service_fee' && order.payments?.[row.paymentCode]?.status === 'confirmed')
    .reduce((total, row) => total + row.amountMinor, 0) + supplementTotals(store, order).feeMinor;
  const refunded = sum((store?.refundSettlements || []).filter((row) => row.orderId === order.id), 'feeMinor');
  return Math.max(0, safe(collected - refunded - sum(appliedShopMoves(order), 'gridgoCoverMinor')));
}

/** Price a substitute against the order's committed item price. */
export function priceShopMove(store, order, substitutePriceMinor, fault) {
  const originalPriceMinor = safe(order.supplierSubtotalMinor || 0);
  if (fault === 'client') {
    return { ruleApplies: false, fault, rule: 'not_applicable', originalPriceMinor, newPriceMinor: originalPriceMinor,
      listedPriceMinor: safe(substitutePriceMinor), differenceMinor: 0, gridgoCoverMinor: 0, clientPaysMinor: 0, refundMinor: 0 };
  }
  const capBps = shopMoveCoverBps(store?.settings);
  const serviceFeeMinor = safe(order.serviceFeeMinor || 0);
  const capByRateMinor = halfUpBps(serviceFeeMinor, capBps);
  const serviceFeeCollectedMinor = collectedServiceFeeMinor(store, order);
  const capMinor = Math.min(capByRateMinor, serviceFeeCollectedMinor);
  const differenceMinor = safe(substitutePriceMinor - originalPriceMinor);
  const gridgoCoverMinor = differenceMinor > 0 ? Math.min(differenceMinor, capMinor) : 0;
  return { ruleApplies: true, fault, rule: differenceMinor < 0 ? 'cheaper' : differenceMinor === 0 ? 'same'
    : differenceMinor <= capMinor ? 'covered' : 'above_cap',
  originalPriceMinor, newPriceMinor: safe(substitutePriceMinor), listedPriceMinor: safe(substitutePriceMinor), differenceMinor,
  capBps, serviceFeeMinor, capByRateMinor, serviceFeeCollectedMinor, capMinor, capLimitedByCollection: capByRateMinor > serviceFeeCollectedMinor,
  gridgoCoverMinor, clientPaysMinor: differenceMinor > 0 ? differenceMinor - gridgoCoverMinor : 0,
  refundMinor: differenceMinor < 0 ? -differenceMinor : 0 };
}

export const samePricing = (a, b) => ['ruleApplies', 'newPriceMinor', 'gridgoCoverMinor', 'clientPaysMinor', 'refundMinor']
  .every((key) => a?.[key] === b?.[key]);

/** What the client may see: prices and GRIDGO's cover, never the cap policy or collections. */
export function clientPricing(pricing) {
  if (!pricing) return null;
  const { ruleApplies, rule, originalPriceMinor, newPriceMinor, differenceMinor, gridgoCoverMinor, clientPaysMinor, refundMinor } = pricing;
  return { ruleApplies, rule, originalPriceMinor, newPriceMinor, differenceMinor, gridgoCoverMinor, clientPaysMinor, refundMinor };
}

/**
 * Pay the substitute on its own price without touching the immutable committed
 * order money: each unpaid stage carries a signed `priceAdjustmentMinor` and its
 * net `amountMinor`. Shares stay gross, exactly like production deductions.
 */
export function applyStagePriceAdjustment(order, deltaMinor) {
  const stages = order.payoutMilestones || [];
  if (!deltaMinor || !stages.length) return;
  if (stages.some((stage) => ['released', 'superseded'].includes(stage.status) || stage.priceAdjustmentMinor)) {
    throw Object.assign(new Error('shop_recovery_requires_operations'), { status: 409, code: 'shop_recovery_requires_operations' });
  }
  const sign = Math.sign(deltaMinor), magnitude = Math.abs(deltaMinor);
  let allocated = 0;
  stages.forEach((stage, index) => {
    const share = index === stages.length - 1 ? magnitude - allocated : halfUpBps(magnitude, Math.round(stage.sharePercent * 100));
    allocated += share;
    stage.priceAdjustmentMinor = sign * share;
    stage.amountMinor = safe(stage.amountMinor + sign * share);
    if (stage.amountMinor < 0) throw Object.assign(new Error('shop_recovery_requires_operations'), { status: 409, code: 'shop_recovery_requires_operations' });
  });
}

export const stagePriceAdjustmentMinor = (order) => sum(order.payoutMilestones || [], 'priceAdjustmentMinor');

/** Totals for the money panel and reporting. */
export function shopMoveTotals(order) {
  const moves = appliedShopMoves(order);
  return { priceAdjustmentMinor: stagePriceAdjustmentMinor(order), gridgoCoverMinor: sum(moves, 'gridgoCoverMinor'),
    clientRefundMinor: sum(moves, 'refundMinor'), clientTopUpMinor: sum(moves, 'clientPaysMinor') };
}

/** Ops: complete audit trail. Owning client: prices, cover and their own choices. Others: nothing. */
export function publicShopMoves(order, user) {
  if (!order.shopMoves?.length) return undefined;
  if (['ops_admin', 'super_admin'].includes(user?.role)) return structuredClone(order.shopMoves);
  if (user?.role === 'client' && user.id === order.clientId) {
    return order.shopMoves.map((move) => ({ recoveryId: move.recoveryId, at: move.at, fault: move.fault, choice: move.choice,
      status: move.status, ...clientPricing(move.pricing), refundRequestId: move.refundRequestId || null,
      refundStatus: move.refundStatus || null, topUpChangeRequestId: move.topUpChangeRequestId || null }));
  }
  return undefined;
}

/** The unpaid "pay the rest" supplement that holds a moved order until Operations confirms it. */
export function awaitedTopUp(order, row, statuses = ['awaiting_payment']) {
  const recovery = order?.shopRecovery;
  return Boolean(row?.data?.shopMoveTopUp && recovery?.topUp?.changeRequestId === row.id
    && statuses.includes(recovery.status) && row.supplierId === order.supplierId);
}

const currentMove = (order) => (order.shopMoves || []).find((move) => move.recoveryId === order.shopRecovery?.id);

/** Full-refund choice from an open recovery, including after choosing to pay the rest. */
export function recordRecoveryRefundChoice(order, refundRequestId) {
  const recovery = order.shopRecovery;
  if (!recovery || !['awaiting_client', 'ops_review', 'awaiting_payment'].includes(recovery.status)) return false;
  const move = currentMove(order);
  if (recovery.status === 'awaiting_payment' && move) move.status = 'refund_requested';
  recovery.refundRequestId = refundRequestId;
  recovery.status = 'refund_requested';
  return true;
}

/** A withdrawn refund returns the client to the choice they left. */
export function restoreRecoveryAfterWithdraw(order) {
  const recovery = order.shopRecovery, move = currentMove(order);
  if (recovery.topUp && move?.status === 'refund_requested') { move.status = 'awaiting_payment'; recovery.status = 'awaiting_payment'; }
  else recovery.status = 'awaiting_client';
  recovery.refundRequestId = null;
}
