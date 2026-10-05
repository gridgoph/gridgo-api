import { publicRecovery } from './shop-recovery-projection.js';
import { approvedRole } from './notifications.js';
import { recordShopFailure, recoveryHeld, paidShopShare, findReplacementShop, startShopAcceptance, notifyRecovery, CANCELLABLE_SHOP_STATES } from './shop-recovery.js';
import { routeRefunds } from './refunds.js';
import { refundHold, refundSettlementFor, sumMinor, collectedRefundComponents } from './refund-policy.js';
import { createPayoutMilestones } from './operational-model.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export async function routeShopRecovery({ req, url, store, user, readBody, now, id, audit }) {
  const events = url.pathname.match(/^\/(me|ops)\/shop-failures$/);
  const match = url.pathname.match(/^\/orders\/([^/]+)\/(decline|shop-cancel|shop-recovery)(?:\/(accept|refund))?$/);
  if (!events && !match) return null;
  if (!user) fail(401, 'unauthorized');
  const ops = ['ops_admin', 'super_admin'].includes(user.role);
  if (events) {
    if (events[1] === 'ops' ? !ops : user.role !== 'supplier') fail(403, 'forbidden');
    if (req.method !== 'GET') fail(405, 'method_not_allowed');
    const supplierId = ops ? url.searchParams.get('supplierId') : user.id;
    return { status: 200, body: { events: store.orders.flatMap((order) => (order.shopFailureEvents || [])
      .filter((event) => !supplierId || supplierId === event.supplierId).map((event) => ({ ...event, orderId: order.id,
        ...(ops ? { recovery: publicRecovery(order, user) } : {}) }))) } };
  }
  const order = store.orders.find((row) => row.id === match[1]);
  if (!order) fail(404, 'order_not_found');
  const ownClient = user.role === 'client' && order.clientId === user.id;
  const ownSupplier = user.role === 'supplier' && order.supplierId === user.id && approvedRole(store, user.id, 'supplier');
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
    recordShopFailure(store, order, { kind: match[2] === 'decline' ? 'declined' : 'cancelled', reason, at, createId: id, actorId: user.id });
  } else {
    if (!ownClient) fail(403, 'forbidden');
    const recovery = order.shopRecovery;
    if (!recovery || body.recoveryId !== recovery.id) fail(409, 'shop_recovery_stale');
    if (match[3] === 'refund') {
      if (recovery.status === 'refund_requested') return { status: 200, body: { recovery: publicRecovery(order, user) } };
      if (!['awaiting_client', 'ops_review'].includes(recovery.status)) fail(409, 'shop_recovery_not_available');
      const collected = sumMinor(Object.values(collectedRefundComponents(order)));
      if (!collected) {
        if (Object.values(order.payments || {}).some((row) => row.status === 'pending_confirmation')) fail(409, 'refund_collection_reconciliation_required');
        order.state = 'cancelled'; order.cancelledAt = at; order.cancelledBy = user.id;
        order.cancellationReason = 'Client declined replacement; no collected funds.';
        for (const job of store.orderJobs || []) if (job.orderId === order.id) { job.state = 'cancelled'; job.updatedAt = at; }
      } else {
        const response = await routeRefunds({ req, url: new URL(`/orders/${order.id}/refund-requests`, url), store, user,
          readBody: async () => ({ kind: 'cancellation', reason: 'Original shop could not fulfil the order; client chose a full refund.',
            ...(body.destination ? { destination: body.destination } : {}) }), now, id, audit });
        recovery.refundRequestId = response.body.refund.id;
      }
      recovery.status = 'refund_requested';
      notifyRecovery(store, order, 'refund_requested', at, id);
    } else if (match[3] === 'accept') {
      if (recovery.status === 'accepted') return { status: 200, body: { recovery: publicRecovery(order, user) } };
      if (recovery.status !== 'awaiting_client' || !recovery.proposal || !recoveryHeld(order)) fail(409, 'shop_recovery_not_available');
      if (paidShopShare(store, order)) fail(409, 'shop_recovery_requires_operations');
      if (refundHold(store, order) || refundSettlementFor(store, order)) fail(409, 'refund_fulfillment_stopped');
      if (!CANCELLABLE_SHOP_STATES.has(order.state)) fail(409, 'shop_recovery_not_available');
      const fresh = findReplacementShop(store, order, at, false), proposed = recovery.proposal;
      // Never silently swap the shop/date the client just consented to.
      if (Date.parse(at) > Date.parse(proposed.expiresAt) || !fresh || fresh.supplierId !== proposed.supplierId || Date.parse(fresh.promiseBy) > Date.parse(proposed.promiseBy)) {
        recovery.proposal = findReplacementShop(store, order, at);
        notifyRecovery(store, order, `refreshed:${at}`, at, id);
        return { status: 409, mutated: true, body: { error: 'shop_recovery_offer_changed', recovery: publicRecovery(order, user) } };
      }
      (order.shopRecoveryHistory ||= []).push({ ...structuredClone(recovery), payoutMilestones: structuredClone(order.payoutMilestones || []) });
      order.supplierId = fresh.supplierId; order.pickup = fresh.pickup;
      order.readyBy = proposed.readyBy; order.promiseBy = proposed.promiseBy;
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
      recovery.status = 'accepted'; recovery.acceptedAt = at;
      (order.timeline ||= []).push({ at, state: order.state, by: user.id, note: 'Client accepted replacement match.' });
      startShopAcceptance(store, order, at);
      notifyRecovery(store, order, 'accepted', at, id);
    } else fail(404, 'not_found');
    audit(store, { actor: user, action: `order.shop_recovery_${match[3]}`, entityType: 'order', entityId: order.id,
      orderId: order.id, detail: { recoveryId: recovery.id }, reason: null });
  }
  order.updatedAt = at;
  return { status: 200, mutated: true, body: { order: { id: order.id, state: order.state }, recovery: publicRecovery(order, user) } };
}
