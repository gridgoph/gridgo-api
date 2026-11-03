import { rescheduleHold } from './order-reschedule-policy.js';
import { supplierArtworkReleased } from './artwork-gates.js';
import { publicRecovery } from './shop-recovery-projection.js';
import { approvedRole } from './notifications.js';
import { recordShopFailure, recoveryHeld, paidShopShare, findReplacementShop, rankedReplacements, startShopAcceptance, notifyRecovery, CANCELLABLE_SHOP_STATES } from './shop-recovery.js';
import { routeRefunds, changeDestination } from './refunds.js';
import { refundHold, refundSettlementFor, sumMinor, collectedRefundComponents, productionStarted, ACTIVE_REFUND_STATUSES } from './refund-policy.js';
import { createPayoutMilestones } from './operational-model.js';
import { changesFor, changeWindowOpen, supplementTotals } from './order-change-policy.js';
import { productionLatenessTier } from './production-penalties.js';
import { OPERATIONS_RECOVERY_CAUSES, SHOP_FAULT_KINDS, recoveryFault, samePricing, applyStagePriceAdjustment, recordRecoveryRefundChoice } from './shop-move-pricing.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const LATE_STATES = new Set(['payment_authorized', 'production', 'supplier_self_qc']);
/** The frozen zero-rate schedule keeps "pay the rest" free of a second service fee. */
const NO_FEE_SCHEDULE = Object.freeze({ version: 1, rateBps: 0 });

/**
 * Cheaper substitute: reserve the exact difference as a non-stopping credit in the
 * existing manual refund workflow. Operations verifies the QR and records the
 * transfer; nothing here claims money moved.
 */
function reserveDifferenceRefund(store, order, move, { user, at, id, audit, destination }) {
  const amount = move.refundMinor;
  let available = 0;
  try {
    const collected = collectedRefundComponents(order, store);
    available = collected.principalMinor - sumMinor((store.refundSettlements || []).filter((row) => row.orderId === order.id).map((row) => row.principalMinor));
  } catch (error) { if (!error.status) throw error; }
  if (available < amount || (store.refundRequests || []).some((row) => row.orderId === order.id && ACTIVE_REFUND_STATUSES.includes(row.status))) {
    move.refundStatus = 'reconciliation_required';
    audit(store, { actor: user, action: 'order.shop_move_refund_reconciliation_required', entityType: 'order', entityId: order.id, orderId: order.id,
      detail: { moveId: move.id, recoveryId: move.recoveryId, refundMinor: amount, availablePrincipalMinor: Math.max(0, available) },
      reason: 'The price difference exceeds verified refundable principal or another refund is open; Operations must reconcile it.' });
    return;
  }
  store.refundRequests ||= []; store.refundSettlements ||= []; store.refundEvents ||= [];
  const request = { id: id('refund'), orderId: order.id, clientId: order.clientId, policyVersion: 'available_funds_v1',
    status: 'destination_review', version: 1, kind: 'shop_move', reason: 'Replacement shop costs less; the price difference is returned.',
    beforeProduction: !productionStarted(order), late: false, filingDeadlineAt: null, orderStateAtFiling: order.state,
    evidenceFileIds: [], destination: null, createdAt: at, updatedAt: at };
  if (destination) changeDestination(store, request, user, destination);
  store.refundRequests.push(request);
  store.refundSettlements.push({ id: id('rsettle'), requestId: request.id, orderId: order.id,
    sequence: store.refundSettlements.filter((row) => row.orderId === order.id).length + 1, createdBy: user.id, createdAt: at,
    reason: request.reason, shopAgreement: 'Replacement shop is paid on its own price through the adjusted payout stages.',
    deliveryEvidence: 'No delivery change.', disposition: 'price_adjustment', shopEntitlementMinor: move.pricing.newPriceMinor, riderEntitlementMinor: 0,
    principalMinor: amount, feeMinor: 0, deliveryMinor: 0, platformDeliveryMinor: 0, totalMinor: amount,
    snapshot: { moveId: move.id, recoveryId: move.recoveryId, originalPriceMinor: move.pricing.originalPriceMinor, newPriceMinor: move.pricing.newPriceMinor } });
  store.refundEvents.push({ id: id('revent'), requestId: request.id, requestVersion: 1, actorId: user.id,
    kind: 'shop_move_credit_reserved', reason: request.reason, createdAt: at, data: { moveId: move.id, recoveryId: move.recoveryId } });
  move.refundRequestId = request.id; move.refundStatus = 'reserved';
  audit(store, { actor: user, action: 'refund.shop_move_credit_reserved', entityType: 'refund_request', entityId: request.id,
    orderId: order.id, detail: { moveId: move.id, recoveryId: move.recoveryId, amountMinor: amount } });
}

/** Dearer above the cover: the client pays the rest as a fee-free supplement the shop receives at its final stage. */
function openTopUp(store, order, move, recovery, { at, id }) {
  if (!changeWindowOpen(order)) fail(409, 'change_request_window_closed');
  if (changesFor(store, order).some((row) => ['pending', 'pending_payment', 'pending_confirmation'].includes(row.status) && row.supplierId === order.supplierId)) fail(409, 'change_request_already_open');
  const originalPrincipalMinor = order.supplierSubtotalMinor + supplementTotals(store, order).principalMinor;
  const row = { id: id('change'), orderId: order.id, supplierId: order.supplierId, lineItemId: null, status: 'pending_payment', version: 1,
    extraPrincipalMinor: move.clientPaysMinor, feeMinor: 0, totalMinor: move.clientPaysMinor, createdAt: at,
    data: { reason: 'Replacement shop price above GRIDGO cover; the client chose to pay the rest.', proposedSpec: '', proposedReadyBy: null, proposedPromiseBy: null,
      feeSchedule: { ...NO_FEE_SCHEDULE }, originalPrincipalMinor, originalReadyBy: order.readyBy, originalPromiseBy: order.promiseBy,
      originalInstructions: '', shopMoveTopUp: { recoveryId: recovery.id, moveId: move.id } } };
  (store.orderChanges ||= []).push(row);
  move.topUpChangeRequestId = row.id; move.status = 'awaiting_payment';
  recovery.topUp = { changeRequestId: row.id, amountMinor: row.totalMinor };
  recovery.status = 'awaiting_payment';
}

export async function routeShopRecovery({ req, url, store, user, readBody, now, id, audit }) {
  const events = url.pathname.match(/^\/(me|ops)\/shop-failures$/);
  const match = url.pathname.match(/^\/orders\/([^/]+)\/(decline|shop-cancel|shop-recovery)(?:\/(accept|refund|start))?$/);
  if (!events && !match) return null;
  if (!user) fail(401, 'unauthorized');
  const ops = ['ops_admin', 'super_admin'].includes(user.role);
  if (events) {
    if (events[1] === 'ops' ? !ops : user.role !== 'supplier') fail(403, 'forbidden');
    if (req.method !== 'GET') fail(405, 'method_not_allowed');
    const supplierId = ops ? url.searchParams.get('supplierId') : user.id;
    return { status: 200, body: { events: store.orders.flatMap((order) => (order.shopFailureEvents || [])
      // A shop's own history lists only its own failures, never a GRIDGO or client move.
      .filter((event) => (!supplierId || supplierId === event.supplierId) && (ops || SHOP_FAULT_KINDS.includes(event.kind))).map((event) => ({ ...event, orderId: order.id,
        ...(ops ? { recovery: publicRecovery(order, user) } : {}) }))) } };
  }
  const order = store.orders.find((row) => row.id === match[1]);
  if (!order) fail(404, 'order_not_found');
  const ownClient = user.role === 'client' && order.clientId === user.id;
  const ownSupplier = user.role === 'supplier' && order.supplierId === user.id && approvedRole(store, user.id, 'supplier') && supplierArtworkReleased(order);
  if (!ops && !ownClient && !ownSupplier) fail(403, 'forbidden');
  if (req.method === 'GET' && match[2] === 'shop-recovery' && !match[3]) {
    return { status: 200, body: { recovery: publicRecovery(order, user) } };
  }
  if (req.method !== 'POST') fail(405, 'method_not_allowed');
  const body = await readBody(req), at = now();
  if (['decline', 'shop-cancel'].includes(match[2]) && !match[3]) {
    if (!ownSupplier) fail(403, 'forbidden');
    if (match[2] === 'decline' && order.state !== 'supplier_assigned') fail(409, 'decline_not_available');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 2000) fail(400, 'shop_cancel_reason_required');
    const reasonCode = body.reasonCode ?? null;
    if (reasonCode !== null && (typeof reasonCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode))) fail(400, 'invalid_shop_reason_code');
    recordShopFailure(store, order, { reasonCode, kind: match[2] === 'decline' ? 'declined' : 'cancelled', reason, at, createId: id, actorId: user.id });
  } else if (match[3] === 'start') {
    // Operations opens a recovery for lateness, a GRIDGO-caused move or a client-caused move.
    if (!ops) fail(403, 'forbidden');
    if (!OPERATIONS_RECOVERY_CAUSES.includes(body.cause)) fail(400, 'invalid_shop_recovery_cause');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 2000) fail(400, 'shop_recovery_reason_required');
    if (!order.supplierId) fail(409, 'shop_recovery_not_available');
    if (body.cause === 'late' && !(LATE_STATES.has(order.state) && (order.productionReassignmentEligible === true || productionLatenessTier(order, at, false)))) {
      fail(409, 'shop_late_not_eligible');
    }
    recordShopFailure(store, order, { kind: body.cause, reason, at, createId: id, actorId: user.id, actorRole: user.role });
  } else {
    if (!ownClient) fail(403, 'forbidden');
    const recovery = order.shopRecovery;
    if (!recovery || body.recoveryId !== recovery.id) fail(409, 'shop_recovery_stale');
    if (match[3] === 'refund') {
      if (recovery.status === 'refund_requested') return { status: 200, body: { recovery: publicRecovery(order, user) } };
      if (!['awaiting_client', 'ops_review', 'awaiting_payment'].includes(recovery.status)) fail(409, 'shop_recovery_not_available');
      const collected = sumMinor(Object.values(collectedRefundComponents(order)));
      if (!collected) {
        if (Object.values(order.payments || {}).some((row) => row.status === 'pending_confirmation')) fail(409, 'refund_collection_reconciliation_required');
        order.state = 'cancelled'; order.cancelledAt = at; order.cancelledBy = user.id;
        order.cancellationReason = 'Client declined replacement; no collected funds.';
        for (const job of store.orderJobs || []) if (job.orderId === order.id) { job.state = 'cancelled'; job.updatedAt = at; }
        recordRecoveryRefundChoice(order, null);
      } else {
        const response = await routeRefunds({ req, url: new URL(`/orders/${order.id}/refund-requests`, url), store, user,
          readBody: async () => ({ kind: 'cancellation', reason: 'Original shop could not fulfil the order; client chose a full refund.',
            ...(body.destination ? { destination: body.destination } : {}) }), now, id, audit });
        // Intake already records the choice; keep the id even for an older recovery shape.
        recordRecoveryRefundChoice(order, response.body.refund.id);
        recovery.refundRequestId = response.body.refund.id;
      }
      recovery.status = 'refund_requested';
      notifyRecovery(store, order, 'refund_requested', at, id);
    } else if (match[3] === 'accept') {
      if (['accepted', 'awaiting_payment'].includes(recovery.status)) return { status: 200, body: { recovery: publicRecovery(order, user) } };
      if (recovery.status !== 'awaiting_client' || !recovery.proposal || !recoveryHeld(order)) fail(409, 'shop_recovery_not_available');
      if (rescheduleHold(order)) fail(409, 'reschedule_fulfillment_stopped');
      if (paidShopShare(store, order)) fail(409, 'shop_recovery_requires_operations');
      if (refundHold(store, order) || refundSettlementFor(store, order)) fail(409, 'refund_fulfillment_stopped');
      if (!CANCELLABLE_SHOP_STATES.has(order.state)) fail(409, 'shop_recovery_not_available');
      const proposed = recovery.proposal, fault = recovery.fault || recoveryFault(recovery.kind);
      const options = [proposed, ...(proposed.alternatives || [])];
      const chosen = body.optionId == null ? proposed : options.find((option) => option.optionId === body.optionId);
      if (!chosen) fail(400, 'invalid_shop_recovery_option');
      const [fresh] = rankedReplacements(store, order, at, { reserve: false, limit: 1, fault, onlySupplierId: chosen.supplierId });
      // Never silently swap the shop, date or price the client just consented to.
      if (Date.parse(at) > Date.parse(proposed.expiresAt) || !fresh || Date.parse(fresh.promiseBy) > Date.parse(chosen.promiseBy)
          || !chosen.pricing || !samePricing(fresh.pricing, chosen.pricing)) {
        recovery.proposal = findReplacementShop(store, order, at, true, fault);
        notifyRecovery(store, order, `refreshed:${at}`, at, id);
        return { status: 409, mutated: true, body: { error: 'shop_recovery_offer_changed', recovery: publicRecovery(order, user) } };
      }
      const pricing = fresh.pricing;
      if (pricing.clientPaysMinor > 0 && body.acceptTopUpMinor !== pricing.clientPaysMinor) {
        fail(409, 'shop_move_top_up_consent_required');
      }
      (order.shopRecoveryHistory ||= []).push({ ...structuredClone(recovery), payoutMilestones: structuredClone(order.payoutMilestones || []) });
      order.supplierId = fresh.supplierId; order.pickup = fresh.pickup;
      order.readyBy = chosen.readyBy; order.promiseBy = chosen.promiseBy;
      order.riderId = null; order.state = 'supplier_assigned';
      delete order.readyAt; delete order.pickupChecklist; delete order.pickupCounterCount;
      delete order.productionNoCommunication; delete order.productionReassignmentEligible;
      for (const stage of order.payoutMilestones || []) {
        if (stage.status !== 'released') {
          const clean = createPayoutMilestones(order, { version: order.payoutPlanVersion || 1 }).find((row) => row.code === stage.code);
          if (clean) { for (const key of Object.keys(stage)) delete stage[key]; Object.assign(stage, clean); }
        }
      }
      for (const lapse of store.productionLapses || []) if (lapse.orderId === order.id && !lapse.appliedAt) lapse.closedAt ||= at;
      for (const job of store.orderJobs || []) if (job.orderId === order.id) {
        job.supplierId = fresh.supplierId; job.pickup = structuredClone(fresh.pickup); job.riderId = null;
        job.state = 'approved_for_production'; job.updatedAt = at;
      }
      const move = { id: id('shop_move'), recoveryId: recovery.id, at, kind: recovery.kind || null, fault,
        fromSupplierId: recovery.originalSupplierId, toSupplierId: fresh.supplierId, optionId: chosen.optionId || null,
        choice: chosen === proposed ? 'replacement' : 'alternative', paysDifference: pricing.clientPaysMinor > 0, actorId: user.id,
        status: 'applied', pricing, gridgoCoverMinor: pricing.gridgoCoverMinor, refundMinor: pricing.refundMinor,
        clientPaysMinor: pricing.clientPaysMinor, refundRequestId: null, refundStatus: null, topUpChangeRequestId: null };
      // The substitute is paid on its own price: cheaper reduces the stages, GRIDGO's cover raises them.
      if (pricing.ruleApplies) applyStagePriceAdjustment(order, pricing.differenceMinor < 0 ? pricing.differenceMinor : pricing.gridgoCoverMinor);
      (order.shopMoves ||= []).push(move);
      if (move.refundMinor) reserveDifferenceRefund(store, order, move, { user, at, id, audit, destination: body.destination });
      if (move.clientPaysMinor) openTopUp(store, order, move, recovery, { at, id });
      else { recovery.status = 'accepted'; recovery.acceptedAt = at; startShopAcceptance(store, order, at); }
      (order.timeline ||= []).push({ at, state: order.state, by: user.id, note: move.paysDifference
        ? 'Client chose to pay the price difference for the replacement shop.' : 'Client accepted replacement match.' });
      audit(store, { actor: user, action: 'order.shop_move_applied', entityType: 'order', entityId: order.id, orderId: order.id,
        detail: structuredClone(move), reason: null });
      notifyRecovery(store, order, move.paysDifference ? 'awaiting_payment' : 'accepted', at, id);
    } else fail(404, 'not_found');
    audit(store, { actor: user, action: `order.shop_recovery_${match[3]}`, entityType: 'order', entityId: order.id,
      orderId: order.id, detail: { recoveryId: recovery.id, status: recovery.status, optionId: body.optionId ?? null,
        acceptTopUpMinor: body.acceptTopUpMinor ?? null }, reason: null });
  }
  order.updatedAt = at;
  return { status: 200, mutated: true, body: { order: { id: order.id, state: order.state }, recovery: publicRecovery(order, user) } };
}
