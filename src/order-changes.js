import crypto from 'node:crypto';
import { serviceFeeMoney } from './service-fee.js';
import { specialInstructions, instructionLines } from './special-instructions.js';
import { changesFor, changePaymentsFor, changePayoutsFor, changeWindowOpen, publicChange, supplementTotals } from './order-change-policy.js';
import { privilegedAdminMemberships, queueOrderInvalidate, approvedRole } from './notifications.js';
import { assertRefundWorkAllowed } from './refund-policy.js';
const staff = user => ['ops_admin', 'super_admin'].includes(user?.role);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, 'invalid_change_request');
  return value.trim();
}
function available(store, order) {
  if (!changeWindowOpen(order)) fail(409, 'change_request_window_closed');
  assertRefundWorkAllowed(store, order);
  if (order.rescheduleRequest?.status === 'pending') fail(409, 'reschedule_request_pending');
}
function event(store, order, row, kind, user, at, id, audit, reason) {
  audit(store, { actor: user, action: `order.change_${kind}`, entityType: 'order', entityId: order.id, orderId: order.id,
    detail: { changeId: row.id, version: row.version, status: row.status, terms: publicChange(store, row, 'ops_admin') }, reason });
  const recipients = [{ userId: order.clientId, role: 'client' }, { userId: row.supplierId, role: 'supplier' }, ...privilegedAdminMemberships(store)];
  for (const { userId, role } of recipients) store.notifications.push({ id: id('ntf'), userId, appRole: role, orderId: order.id,
    type: `order_change_${row.status === 'applied' ? 'applied' : kind}`, title: 'Order change request',
    body: 'An order change request was updated. Open the order to review its terms and status.', read: false, at });
  queueOrderInvalidate(store, order, ['orders', 'jobs', 'notifications']);
}
function apply(store, order, row, at) {
  if (row.data.proposedReadyBy && (Date.parse(row.data.proposedReadyBy) <= Date.parse(at)
      || row.data.originalReadyBy !== order.readyBy || row.data.originalPromiseBy !== order.promiseBy)) fail(409, 'change_deadline_stale');
  if (row.data.proposedReadyBy) {
    const lapse = (store.productionLapses || []).find(l => l.orderId === order.id && l.supplierId === order.supplierId);
    if (lapse?.appliedAt) fail(409, 'change_deadline_operations_required');
    if (lapse) { row.data.priorLapse = structuredClone(lapse); store.productionLapses = store.productionLapses.filter(l => l !== lapse); }
  }
  row.status = 'applied'; row.data.appliedAt = at;
  if (row.data.proposedReadyBy) {
    order.readyBy = row.data.proposedReadyBy;
    order.promiseBy = row.data.proposedPromiseBy;
  }
}
export async function routeOrderChanges({ req, url, store, user, readBody, now, id, audit }) {
  const queue = url.pathname === '/ops/special-instructions';
  const match = url.pathname.match(/^\/orders\/([^/]+)\/change-requests(?:\/([^/]+)(?:\/(answer|payment|payment\/confirm|payment\/reject))?)?$/);
  if (!match && !queue) return null;
  if (!user) fail(401, 'unauthorized');
  if (queue) {
    if (!staff(user)) fail(403, 'forbidden');
    if (req.method !== 'GET') return null;
    const q = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
    if (q.length > 300) fail(400, 'invalid_search');
    const entries = store.orders.map(order => ({ orderId: order.id, specialInstructions: order.specialInstructions || '',
      lines: instructionLines(store, order), acknowledgement: order.specialInstructionsAcknowledgement || null,
      changeRequests: changesFor(store, order).map(row => publicChange(store, row, user.role)) }));
    const selected = entries.filter(row => (row.specialInstructions || row.lines.length || row.changeRequests.length)
      && JSON.stringify([row.specialInstructions, row.lines, row.changeRequests.map(c => [c.proposedSpec, c.reason])]).toLocaleLowerCase().includes(q));
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'invalid_offset');
    return { status: 200, body: { orders: selected.slice(offset, offset + 100), nextOffset: selected.length > offset + 100 ? offset + 100 : null } };
  }
  const order = store.orders.find(o => o.id === match[1]);
  if (!order) fail(404, 'order_not_found');
  const supplier = user.role === 'supplier' && user.id === order.supplierId && approvedRole(store, user.id, 'supplier');
  const client = user.role === 'client' && user.id === order.clientId;
  if (!staff(user) && !supplier && !client) fail(403, 'forbidden');
  const rows = changesFor(store, order);
  const row = match[2] ? rows.find(r => r.id === match[2]) : null;
  const action = match[3] || (match[2] ? null : 'create');
  if (match[2] && !row) fail(404, 'change_request_not_found');
  if (req.method === 'GET' && !match[3]) return { status: 200, body: row
    ? { changeRequest: publicChange(store, row, user.role) } : { changeRequests: rows.map(r => publicChange(store, r, user.role)) } };
  if (req.method !== 'POST' || !action) return null;
  if (action === 'create' ? !supplier : action.startsWith('payment/') ? !staff(user) : !client) fail(403, 'forbidden');
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_change_request');
  const key = text(req.headers['idempotency-key'], 120), route = `${req.method} ${url.pathname}`;
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const replay = store.refundCommands.find(r => r.actorId === user.id && r.requestKey === key);
  if (replay) {
    if (replay.route !== route || replay.bodyHash !== bodyHash) fail(409, 'change_request_idempotency_conflict');
    return structuredClone(replay.response);
  }
  const at = now();
  // Rejecting a submitted proof remains possible during independent holds.
  if (action !== 'payment/reject' && !(action === 'answer' && body.answer === 'decline')) available(store, order);
  let request = row, kind;
  if (action === 'create') {
    if (rows.some(r => ['pending', 'pending_payment', 'pending_confirmation'].includes(r.status))) fail(409, 'change_request_already_open');
    if (rows.length >= 50) fail(409, 'change_request_limit');
    if (!order.commercialCommittedAt) fail(409, 'change_request_requires_committed_order');
    const jobs = (store.orderJobs || []).filter(j => j.orderId === order.id);
    if (jobs.some(j => j.supplierId !== user.id)) fail(409, 'change_request_multi_shop_legacy');
    const line = (store.orderLineItems || []).find(l => l.id === body.lineItemId && l.orderId === order.id);
    if (!line && (body.lineItemId != null || (store.orderLineItems || []).some(l => l.orderId === order.id))) fail(400, 'invalid_change_line');
    const extra = body.extraPrincipalMinor ?? 0;
    if (!Number.isSafeInteger(extra) || extra < 0) fail(400, 'invalid_change_amount');
    const proposedSpec = specialInstructions(body.proposedSpec);
    let proposedReadyBy = null, proposedPromiseBy = null;
    if (body.proposedReadyBy != null) {
      if (typeof body.proposedReadyBy !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(body.proposedReadyBy)
        || !Number.isFinite(Date.parse(body.proposedReadyBy)) || Date.parse(body.proposedReadyBy) <= Date.parse(at)) fail(400, 'invalid_change_deadline');
      const allowance = Date.parse(order.promiseBy) - Date.parse(order.readyBy);
      if (!Number.isFinite(allowance) || allowance < 0 || (store.productionLapses || []).some(l => l.orderId === order.id && l.appliedAt)) fail(409, 'change_deadline_operations_required');
      proposedReadyBy = new Date(body.proposedReadyBy).toISOString();
      proposedPromiseBy = new Date(Date.parse(proposedReadyBy) + allowance).toISOString();
    }
    if (!proposedSpec && !proposedReadyBy) fail(400, 'change_terms_required');
    const feeSchedule = order.serviceFeeSchedule || { version: 1, rateBps: order.serviceFeeRateBps };
    const originalPrincipalMinor = order.supplierSubtotalMinor + supplementTotals(store, order).principalMinor;
    const feeMinor = serviceFeeMoney(originalPrincipalMinor + extra, feeSchedule).grossServiceFeeMinor - serviceFeeMoney(originalPrincipalMinor, feeSchedule).grossServiceFeeMinor;
    if (!Number.isSafeInteger(order.totalMinor + supplementTotals(store, order).totalMinor + extra + feeMinor)) fail(400, 'invalid_change_amount');
    request = { id: id('change'), orderId: order.id, supplierId: user.id, lineItemId: line?.id || null, status: 'pending', version: 1,
      extraPrincipalMinor: extra, feeMinor, totalMinor: extra + feeMinor, createdAt: at,
      data: { reason: text(body.reason, 2000), proposedSpec, proposedReadyBy, proposedPromiseBy, feeSchedule: structuredClone(feeSchedule),
        originalPrincipalMinor, originalReadyBy: order.readyBy, originalPromiseBy: order.promiseBy,
        originalInstructions: line?.specialInstructions || order.specialInstructions || '' } };
    (store.orderChanges ||= []).push(request); kind = 'requested';
  } else {
    if (body.expectedVersion !== row.version) fail(409, 'change_request_stale');
    if (row.supplierId !== order.supplierId && action !== 'payment/reject') fail(409, 'change_request_supplier_changed');
    if (action === 'answer') {
      if (!(row.status === 'pending' || (row.status === 'pending_payment' && body.answer === 'decline')) || !['accept', 'decline'].includes(body.answer)) fail(409, 'change_request_not_pending');
      row.data.answeredAt = at; row.data.answeredBy = user.id;
      if (body.answer === 'decline') { row.status = 'declined'; kind = 'declined'; }
      else if (row.totalMinor > 0) { row.status = 'pending_payment'; kind = 'accepted'; }
      else { apply(store, order, row, at); kind = 'applied'; }
    } else if (action === 'payment') {
      if (row.status !== 'pending_payment') fail(409, 'change_payment_unavailable');
      const file = store.files.find(f => f.fileId === body.proofFileId && f.ownerId === user.id && f.purpose === 'payment_proof'
        && f.state === 'ready' && f.objectKey && !f.deleteRequestedAt && !f.deletedAt && !f.references?.length);
      if (!file) fail(400, 'payment_proof_invalid');
      row.data.payment = { proofFileId: file.fileId, reference: text(body.reference, 120).toUpperCase(), submittedAt: at };
      (file.references ||= []).push({ type: 'order', id: order.id, field: `change:${row.id}:payment` });
      row.status = 'pending_confirmation'; kind = 'payment_submitted';
    } else {
      if (row.status !== 'pending_confirmation') fail(409, 'change_payment_unavailable');
      const reason = text(body.reason, 2000);
      if (action === 'payment/reject') {
        (row.data.paymentHistory ||= []).push({ ...row.data.payment, rejectedAt: at, rejectedBy: user.id, reason });
        delete row.data.payment; row.data.rejectionReason = reason; row.status = 'pending_payment'; kind = 'payment_rejected';
      } else {
        if ((store.orderChangePayments || []).some(p => p.reference === row.data.payment.reference)
          || (store.deliveryPinPayments || []).some(p => p.reference === row.data.payment.reference)
          || store.orders.some(o => Object.values(o.payments || {}).some(p => p.status === 'confirmed' && p.reference?.toUpperCase() === row.data.payment.reference))) fail(409, 'change_payment_reference_used');
        if (body.amountMinor !== row.totalMinor) fail(409, 'change_payment_mismatch');
        (store.orderChangePayments ||= []).push({ id: id('chgpay'), orderId: order.id, changeId: row.id,
          principalMinor: row.extraPrincipalMinor, feeMinor: row.feeMinor, amountMinor: row.totalMinor,
          reference: row.data.payment.reference, proofFileId: row.data.payment.proofFileId, confirmedBy: user.id, createdAt: at });
        row.data.payment.confirmedAt = at; row.data.payment.confirmedBy = user.id;
        apply(store, order, row, at); kind = 'payment_confirmed';
      }
    }
    row.version += 1;
  }
  order.updatedAt = at;
  event(store, order, request, kind, user, at, id, audit, body.reason);
  const response = { status: action === 'create' ? 201 : 200, body: { changeRequest: publicChange(store, request, user.role) } };
  store.refundCommands.push({ id: id('rcmd'), actorId: user.id, requestKey: key, route, bodyHash, response: structuredClone(response), createdAt: at });
  return { ...response, mutated: true };
}
export function releaseChangePayouts(store, order, code, { user, reference, receipt, amountMinor, at, id, audit }) {
  const finalCode = order.payoutPlanVersion === 2 ? 'issue_window' : 'retention';
  if (code !== finalCode) return 0;
  const payments = changePaymentsFor(store, order).filter(p => !changePayoutsFor(store, order).some(r => r.changeId === p.changeId));
  if (!payments.length) return 0;
  if (!reference || !receipt) fail(400, 'supplement_payout_receipt_required');
  const expected = order.payoutMilestones.find(stage => stage.code === code).amountMinor + payments.reduce((sum, p) => sum + p.principalMinor, 0);
  if (amountMinor !== expected) fail(409, 'supplement_payout_amount_mismatch');
  let total = 0;
  for (const payment of payments) {
    const request = changesFor(store, order).find(r => r.id === payment.changeId);
    const row = { id: id('chgpayout'), orderId: order.id, changeId: request.id, supplierId: request.supplierId,
      amountMinor: payment.principalMinor, reference, receiptFileId: receipt.fileId, releasedBy: user.id, createdAt: at };
    (store.orderChangePayouts ||= []).push(row); total += row.amountMinor;
    audit(store, { actor: user, action: 'order.change_payout_released', entityType: 'order', entityId: order.id, orderId: order.id, detail: row });
  }
  return total;
}

// Unpaid proposals never follow an order to a replacement shop or reopen completed work.
export function closeUnavailableChanges(store, order, { at, id, audit }) {
  for (const row of changesFor(store, order)) {
    if (!['pending', 'pending_payment'].includes(row.status)) continue;
    if (changeWindowOpen(order) && row.supplierId === order.supplierId && (!order.shopRecovery || order.shopRecovery.status === 'accepted')) continue;
    row.status = 'closed'; row.version += 1;
    row.data.closedAt = at; row.data.closureReason = 'Production window or shop assignment closed; the original specification remains in effect.';
    event(store, order, row, 'closed', { role: 'system' }, at, id, audit, row.data.closureReason);
  }
}
