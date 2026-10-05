import { recoveryHeld, startShopAcceptance } from './shop-recovery.js';
import { approvedRole, hasRole, privilegedAdminMemberships, queueOrderInvalidate, queueInvalidate } from './notifications.js';
import { writeDraft } from './client-order-notifications.js';
import { refundHold, refundSettlementFor, assertRefundWorkAllowed } from './refund-policy.js';
import { routeRefunds } from './refunds.js';
import { publicReschedule, rescheduleHold } from './order-reschedule-policy.js';
import { findRescheduleReplacement, sameReplacementSelection } from './order-reschedule-match.js';

const ops = (user) => ['ops_admin', 'super_admin'].includes(user?.role);
const active = (order) => ['production', 'supplier_self_qc'].includes(order.state) && !order.readyAt;
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const reasonText = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail(400, 'invalid_reschedule_reason', 'Send a reason of 1–2000 characters.');
  return value.trim();
};
const appliedLapse = (store, order) => (store.productionLapses || []).find((row) => row.orderId === order.id && row.appliedAt);
function requireOperations(store, order) {
  const lapse = appliedLapse(store, order);
  if (!lapse) return false;
  order.rescheduleRequest.resolution = 'operations_required';
  order.rescheduleRequest.appliedDeductionMinor = lapse.deductionMinor;
  return true;
}
function archiveWarning(store, order) {
  const lapse = (store.productionLapses || []).find((row) => row.orderId === order.id && row.supplierId === order.supplierId && !row.appliedAt);
  if (!lapse) return;
  order.rescheduleRequest.priorLapse = structuredClone(lapse);
  store.productionLapses = store.productionLapses.filter((row) => row.id !== lapse.id);
}
const hasReleasedShare = (store, order) => (order.payoutMilestones || []).some((stage) => stage.status === 'released')
  || (store.refundSupplierPayouts || []).some((row) => row.orderId === order.id && row.status === 'released');

function event(store, order, kind, actor, at, id) {
  const request = order.rescheduleRequest;
  store.auditLog ||= [];
  store.auditLog.push({ id: id('aud'), at, actorId: actor?.id || null, actorRole: actor?.role || 'system',
    action: `order.reschedule_${kind}`, entityType: 'order', entityId: order.id, orderId: order.id,
    detail: { requestId: request.id, status: request.status, resolution: request.resolution || null }, reason: kind === 'resolved' ? request.resolutionReason : request.reason });
  const copy = {
    requested: 'A new production deadline needs the client’s answer within 24 hours.',
    operations_required: 'An applied production deduction requires Operations to resolve this deadline request. Dates and deductions remain unchanged.',
    accepted: 'The client accepted the revised deadline. Open the order for the updated date.',
    declined: 'The client declined the revised deadline. Work and payouts are paused while the next step is resolved.',
    expired: 'The client did not answer within 24 hours. The original deadline still applies; Operations must follow up.',
    rematch_refreshed: 'Replacement availability was checked again. Open the deadline request for the current offer.',
    rematched: 'The client accepted a replacement for the same product and specifications.',
    refund_requested: 'The client requested a full refund after declining the revised deadline. Operations must review the settlement.',
    resolved: 'Operations recorded the resolution of the declined deadline request.',
  };
  const recipients = [{ userId: order.clientId, role: 'client' }, { userId: request.supplierId, role: 'supplier' },
    ...(kind === 'rematched' ? [{ userId: order.supplierId, role: 'supplier' }] : []), ...privilegedAdminMemberships(store)];
  for (const { userId, role } of recipients) writeDraft(store, { userId, appRole: role, type: `order_reschedule_${kind}`,
    occurrenceKey: `${request.id}:${kind}:${kind === 'rematch_refreshed' ? request.offer?.id || at : ''}`, orderId: order.id, title: 'Order deadline request', body: copy[kind], read: false },
  { id: id('ntf'), at });
  order.updatedAt = at;
  queueOrderInvalidate(store, order, ['orders', 'jobs', 'payouts']);
  if (kind === 'rematched') queueInvalidate(store, { resource: 'jobs', id: order.id, userIds: [request.supplierId] });
}

export function expireRescheduleRequests(store, { at, id }) {
  let changed = false;
  for (const order of store.orders || []) {
    const request = order.rescheduleRequest;
    if (request?.status !== 'pending' || Date.parse(request.expiresAt) > Date.parse(at)) continue;
    request.status = 'expired'; request.answeredAt = null; request.expiredAt = at;
    event(store, order, 'expired', null, at, id); changed = true;
  }
  return changed;
}

export async function routeOrderReschedule({ req, url, store, user, readBody, now, id, audit }) {
  const match = url.pathname.match(/^\/orders\/([^/]+)\/reschedule-request(?:\/(answer|rematch|refund|resolve))?$/);
  const queue = ['/ops/reschedule-requests', '/me/reschedule-requests'].includes(url.pathname);
  if (!match && !queue) return null;
  if (!user) fail(401, 'unauthorized', 'Sign in to manage deadline requests.');
  if (!hasRole(store, user.id, user.role)) fail(403, 'forbidden', 'A current membership is required.');
  if (queue) {
    if (req.method !== 'GET') return null;
    if (url.pathname.startsWith('/ops/') ? !ops(user) : user.role !== 'supplier') fail(403, 'forbidden', 'This queue is not available to this role.');
    const rows = store.orders.filter((order) => order.rescheduleRequest && (ops(user) || order.rescheduleRequest.supplierId === user.id));
    const supplierId = ops(user) ? url.searchParams.get('supplierId') : user.id;
    const status = url.searchParams.get('status');
    const selected = rows.filter((order) => !supplierId || order.rescheduleRequest.supplierId === supplierId);
    return { status: 200, body: { totalRequests: selected.length,
      requests: selected.filter((order) => !status || order.rescheduleRequest.status === status)
        .sort((a, b) => b.rescheduleRequest.requestedAt.localeCompare(a.rescheduleRequest.requestedAt))
        .map((order) => publicReschedule(order, user)) } };
  }
  const order = store.orders.find((row) => row.id === match[1]);
  if (!order) fail(404, 'order_not_found', 'Order not found.');
  const client = user.role === 'client' && user.id === order.clientId;
  const supplier = user.role === 'supplier' && user.id === order.supplierId && approvedRole(store, user.id, 'supplier');
  const historicalSupplier = user.role === 'supplier' && user.id === order.rescheduleRequest?.supplierId;
  if (!ops(user) && !client && !supplier && !(req.method === 'GET' && historicalSupplier)) fail(403, 'forbidden', 'This is another party’s order.');
  const action = match[2];
  if (req.method === 'GET' && !action) return { status: 200, body: { request: publicReschedule(order, user) } };
  if (req.method !== 'POST') return null;
  if (!action ? !supplier : action === 'resolve' ? !ops(user) : !client) fail(403, 'forbidden', 'This action is not available to this role.');
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_reschedule_request', 'Send a JSON object.');
  const at = now();
  let request = order.rescheduleRequest;
  if (!action) {
    if (request) fail(409, 'reschedule_already_requested', 'Only one deadline request is allowed for this order.');
    assertRefundWorkAllowed(store, order);
    if (!active(order)) fail(409, 'reschedule_not_available', 'Request a new deadline during production, before quality sign-off.');
    const originalReadyBy = order.readyBy || order.promisedDate || order.deadline;
    const originalPromiseBy = order.promiseBy || order.promisedDate || order.deadline;
    if (![originalReadyBy, originalPromiseBy].every((value) => Number.isFinite(Date.parse(value)))) fail(409, 'reschedule_dates_missing', 'Operations must reconcile the original dates first.');
    if (typeof body.proposedReadyBy !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.proposedReadyBy)
        || !Number.isFinite(Date.parse(body.proposedReadyBy)) || Date.parse(body.proposedReadyBy) <= Math.max(Date.parse(at), Date.parse(originalReadyBy))) {
      fail(400, 'invalid_reschedule_date', 'Send a future ISO timestamp later than the current production deadline.');
    }
    const proposedReadyBy = new Date(body.proposedReadyBy).toISOString();
    const delta = Date.parse(proposedReadyBy) - Date.parse(originalReadyBy);
    request = { id: id('resched'), supplierId: user.id, reason: reasonText(body.reason), status: 'pending',
      requestedAt: at, expiresAt: new Date(Date.parse(at) + 86400000).toISOString(),
      originalReadyBy, originalPromiseBy, proposedReadyBy,
      proposedPromiseBy: new Date(Date.parse(originalPromiseBy) + delta).toISOString() };
    order.rescheduleRequest = request;
    requireOperations(store, order);
    event(store, order, 'requested', user, at, id);
    return { status: 201, mutated: true, body: { request: publicReschedule(order, user) } };
  }
  if (!request) fail(404, 'reschedule_not_found', 'No deadline request exists for this order.');
  if (body.requestId !== request.id) fail(409, 'reschedule_stale', 'Reload the deadline request before answering.');
  if (['answer', 'rematch'].includes(action) && recoveryHeld(order)) fail(409, 'shop_recovery_pending', 'Resolve the shop recovery before changing the production deadline or assignment.');
  if (action === 'answer') {
    if (request.status !== 'pending') fail(409, 'reschedule_already_answered', 'This deadline request is no longer awaiting an answer.');
    if (Date.parse(at) >= Date.parse(request.expiresAt)) {
      request.status = 'expired'; request.expiredAt = at;
      event(store, order, 'expired', null, at, id);
      return { status: 409, mutated: true, body: { error: 'reschedule_expired', request: publicReschedule(order, user) } };
    }
    if (refundHold(store, order) || refundSettlementFor(store, order)) fail(409, 'refund_fulfillment_stopped', 'Resolve the refund first.');
    if (!active(order) || order.supplierId !== request.supplierId) fail(409, 'reschedule_not_available', 'The order is no longer awaiting a production deadline change.');
    if (!['accept', 'decline'].includes(body.answer)) fail(400, 'invalid_reschedule_answer', 'Choose accept or decline.');
    request.answeredAt = at; request.answeredBy = user.id;
    request.status = body.answer === 'accept' ? 'accepted' : 'declined';
    if (requireOperations(store, order)) {
      if (body.answer === 'accept') request.status = 'operations_required';
      request.clientAnswer = body.answer;
      event(store, order, 'operations_required', user, at, id);
    } else if (body.answer === 'accept') {
      archiveWarning(store, order);
      order.readyBy = request.proposedReadyBy; order.promiseBy = request.proposedPromiseBy;
      // Keep the immutable quote promise as history; public projections expose the effective promise.
      order.productionNoCommunication = null;
      order.productionReassignmentEligible = false;
      event(store, order, 'accepted', user, at, id);
    } else {
      if (hasReleasedShare(store, order)) request.resolution = 'operations_required';
      else {
        const replacement = findRescheduleReplacement(store, order, at);
        request.offer = replacement ? { ...replacement, id: id('rematch'), expiresAt: new Date(Date.parse(at) + 15 * 60000).toISOString() } : null;
        request.resolution = replacement ? 'rematch_offered' : 'no_match';
      }
      event(store, order, 'declined', user, at, id);
    }
  } else if (action === 'rematch') {
    if (request.status !== 'declined' || !['rematch_offered', 'no_match'].includes(request.resolution)) fail(409, 'reschedule_rematch_unavailable', 'No automatic replacement can be accepted.');
    if (hasReleasedShare(store, order)) fail(409, 'reschedule_operations_required', 'A shop payout was released. Operations must resolve the order.');
    if (requireOperations(store, order)) {
      event(store, order, 'operations_required', user, at, id);
      return { status: 409, mutated: true, body: { error: 'reschedule_operations_required', request: publicReschedule(order, user) } };
    }
    if (refundHold(store, order) || refundSettlementFor(store, order)) fail(409, 'refund_fulfillment_stopped', 'Resolve the refund first.');
    if (order.payoutHold || (store.claims || []).some((row) => row.orderId === order.id && ['open', 'payout_held'].includes(row.status))) fail(409, 'payout_held', 'Resolve the independent claim before replacing the shop.');
    if (body.action === 'refresh') {
      const replacement = findRescheduleReplacement(store, order, at);
      request.offer = replacement ? { ...replacement, id: id('rematch'), expiresAt: new Date(Date.parse(at) + 15 * 60000).toISOString() } : null;
      request.resolution = replacement ? 'rematch_offered' : 'no_match';
      event(store, order, 'rematch_refreshed', user, at, id);
    } else {
      if (body.action !== 'accept') fail(400, 'invalid_rematch_action', 'Choose refresh or accept.');
      const offer = request.offer;
      if (!offer || body.offerId !== offer.id || Date.parse(at) >= Date.parse(offer.expiresAt)) fail(409, 'reschedule_offer_expired', 'Refresh the replacement offer.');
      const replacement = findRescheduleReplacement(store, order, at, offer.supplierId);
      if (!replacement || !sameReplacementSelection(offer, replacement)
          || Date.parse(replacement.promiseBy) > Date.parse(offer.promiseBy)) fail(409, 'reschedule_offer_stale', 'The replacement changed. Refresh before accepting.');
      archiveWarning(store, order);
      request.resolution = 'rematched'; request.rematchedAt = at;
      request.previousProduction = { payoutMilestones: structuredClone(order.payoutMilestones), readyBy: order.readyBy,
        fulfilmentProofFileIds: order.fulfilmentProofFileIds || [] };
      order.declinedBy = [...new Set([...(order.declinedBy || []), order.supplierId])];
      order.supplierId = replacement.supplierId; order.pickup = replacement.pickup;
      order.readyBy = replacement.readyBy; order.promiseBy = offer.promiseBy;
      order.state = 'supplier_assigned'; order.readyAt = null; order.riderId = null;
      order.productionNoCommunication = null; order.productionReassignmentEligible = false;
      order.fulfilmentProofFileIds = []; order.proofFileIds = [];
      for (const stage of order.payoutMilestones || []) {
        const { code, sharePercent, amountMinor, productionDeductionMinor } = stage;
        for (const key of Object.keys(stage)) delete stage[key];
        Object.assign(stage, { code, sharePercent, amountMinor, productionDeductionMinor: productionDeductionMinor || 0, status: 'pending_pof', pofFileIds: [] });
      }
      for (const job of store.orderJobs || []) if (job.orderId === order.id) {
        Object.assign(job, { supplierId: replacement.supplierId, pickup: replacement.pickup, riderId: null,
          state: order.state, updatedAt: at, estimatedHours: Math.max(...replacement.selections.map((row) => row.turnaroundHours)) });
      }
      order.timeline ||= [];
      order.timeline.push({ at, state: order.state, by: user.id, note: 'Client accepted a replacement for the original product and specifications.' });
      startShopAcceptance(store, order, at);
      event(store, order, 'rematched', user, at, id);
    }
  } else if (action === 'refund') {
    if (request.status !== 'declined' || ['rematched', 'resolved'].includes(request.resolution)) fail(409, 'reschedule_refund_unavailable', 'Decline the deadline or replacement before requesting a refund.');
    if (request.refundRequestId) return { status: 200, body: { request: publicReschedule(order, user) } };
    const refund = await routeRefunds({ req, url: new URL(`/orders/${order.id}/refund-requests`, url), store, user,
      readBody: async () => ({ kind: 'cancellation', reason: 'Full refund requested after declining a production deadline change.',
        ...(body.destination ? { destination: body.destination } : {}) }), now, id, audit });
    request.refundRequestId = refund.body.refund.id; request.resolution = 'refund_requested';
    request.requestedRefund = 'full';
    event(store, order, 'refund_requested', user, at, id);
  } else if (action === 'resolve') {
    if (!rescheduleHold(order)) fail(409, 'reschedule_resolution_unavailable', 'No declined deadline is awaiting resolution.');
    if (refundHold(store, order) || refundSettlementFor(store, order)) fail(409, 'refund_fulfillment_stopped', 'Resolve the refund through the refund workflow.');
    request.resolutionReason = reasonText(body.reason);
    if (request.status === 'pending') request.status = 'operations_required';
    request.resolution = 'resolved'; request.resolvedAt = at; request.resolvedBy = user.id;
    event(store, order, 'resolved', user, at, id);
  }
  return { status: 200, mutated: true, body: { request: publicReschedule(order, user) } };
}
