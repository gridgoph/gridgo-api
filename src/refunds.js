import crypto from 'node:crypto';
import { refundFail as fail, refundMinor, sumMinor, productionStarted, deliveryCompleted, handoverCompleted, refundHold, refundSettlementFor,
  supplierRefundPayouts, calculateRefundSettlement, collectedRefundComponents } from './refund-policy.js';
import { deliverySplit } from './operational-model.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';
import { resolvePayoutReceipt, bindPayoutReceipt, paymentReferenceValue } from './payout-receipt.js';
import { opsPayoutAccountProjection } from './payout-account.js';

const privileged = (user) => ['ops_admin', 'super_admin'].includes(user?.role);
const activeAttempt = (store, request) => (store.refundAttempts || []).find((row) => row.requestId === request.id && row.status !== 'failed');
const settlementFor = (store, request) => (store.refundSettlements || []).find((row) => row.requestId === request.id);
const text = (value, field, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_refund_request', `${field} is required (maximum ${max} characters).`, { field });
  return value.trim();
};
function requireOps(user) {
  if (!privileged(user)) fail(403, 'forbidden', 'Operations or Super Admin is required.');
}
function readyFile(store, fileId, purpose, ownerId) {
  const file = (store.files || []).find((file) => file.fileId === fileId);
  if (!file || file.ownerId !== ownerId || file.purpose !== purpose || file.state !== 'ready'
    || !file.objectKey || file.deletedAt || file.deleteRequestedAt) {
    fail(400, 'invalid_refund_file', `Upload your own ready ${purpose} file first.`, { purpose });
  }
  if (file.references?.length) fail(409, 'file_already_attached', 'Upload a new file; that file is already bound.');
  return file;
}
function bind(file, request, field) {
  file.references ||= [];
  file.references.push({ type: 'refund_request', id: request.id, field });
}
function changeDestination(store, request, user, body) {
  if (user.role !== 'client' || user.id !== request.clientId) fail(403, 'forbidden', 'Only the owning client may supply their receiving QR.');
  if (body.ownershipConfirmed !== true) fail(400, 'refund_qr_ownership_required', 'Confirm this is your own receiving account.');
  const provider = text(body.provider, 'provider', 40).toLowerCase();
  if (!['gcash', 'maya', 'bank', 'other'].includes(provider)) fail(400, 'invalid_refund_provider', 'Choose gcash, maya, bank or other.');
  const accountName = text(body.accountName, 'accountName', 120);
  const file = readyFile(store, body.qrFileId, 'refund_qr', user.id);
  request.destination = { provider, accountName, qrFileId: file.fileId, ownershipConfirmed: true,
    revision: (request.destination?.revision || 0) + 1 };
  // Old plates stay pinned as historical evidence; do not copy supplier QR retirement.
  bind(file, request, `destination:${request.destination.revision}`);
}

export function publicRefund(store, request, user) {
  const ops = privileged(user);
  const settlement = settlementFor(store, request);
  const payment = (store.refundPayments || []).find((row) => row.requestId === request.id);
  const attempt = activeAttempt(store, request);
  const events = (store.refundEvents || []).filter((row) => row.requestId === request.id).sort((a, b) => a.requestVersion - b.requestVersion);
  const result = { id: request.id, orderId: request.orderId, status: request.status, version: request.version,
    policyVersion: request.policyVersion, kind: request.kind, reason: request.reason, evidenceFileIds: request.evidenceFileIds,
    destination: request.destination, beforeProduction: request.beforeProduction, late: request.late,
    createdAt: request.createdAt, updatedAt: request.updatedAt, filingDeadlineAt: request.filingDeadlineAt,
    history: events.filter((row) => ops || row.kind !== 'supplier_paid').map(({ kind, reason, createdAt }) => ({ kind, reason, at: createdAt })),
    settlement: settlement ? { id: settlement.id, principalMinor: settlement.principalMinor, feeMinor: settlement.feeMinor,
      deliveryMinor: settlement.deliveryMinor, totalMinor: settlement.totalMinor, disposition: settlement.disposition,
      reason: settlement.reason, approvedAt: settlement.createdAt } : null,
    payment: payment ? { id: payment.id, reference: payment.reference, receiptFileId: payment.receiptFileId,
      amountMinor: payment.amountMinor, paidAt: payment.paidAt, evidenceLabel: 'Wallet transfer evidence' } : null };
  if (ops) {
    result.clientId = request.clientId;
    result.settlement = settlement || null;
    result.attempt = attempt || null;
    result.payment = payment ? { ...payment, evidenceLabel: 'Wallet transfer evidence' } : null;
    const order = store.orders.find((row) => row.id === request.orderId);
    result.collections = collectedRefundComponents(order);
    result.releasedShopMinor = sumMinor([...(order.payoutMilestones || []), ...(store.refundSupplierPayouts || []).filter((row) => row.orderId === order.id)]
      .filter((row) => row.status === 'released').map((row) => row.amountMinor));
    result.previousRefunds = (store.refundSettlements || []).filter((row) => row.orderId === order.id && row.requestId !== request.id);
    result.supplierSettlementPayouts = supplierRefundPayouts(store, order);
    result.supplierPayoutAccount = opsPayoutAccountProjection(store, order.supplierId);
  }
  return result;
}

function notify(store, request, order, kind, createId, at) {
  const recipients = [...(kind === 'supplier_paid' ? [] : [{ userId: request.clientId, role: 'client' }]),
    ...(order.supplierId ? [{ userId: order.supplierId, role: 'supplier' }] : []), ...privilegedAdminMemberships(store)];
  const copy = { requested: 'A refund was requested. Work and payouts are paused.', reviewed: 'Operations reviewed the refund request.',
    settled: 'A refund settlement was approved. No client transfer has been recorded yet.', paid: 'The client refund transfer was recorded.',
    rejected: 'The refund request was rejected. Open the request for the reason.', withdrawn: 'The refund request was withdrawn.',
    destination: 'The receiving QR changed and requires review.', attempt: 'A manual refund payment is reserved.',
    unknown: 'The refund payment needs reconciliation. Do not send another transfer.', failed: 'Operations confirmed that no refund transfer occurred.',
    supplier_paid: 'The agreed shop settlement payout was recorded.' };
  store.notifications ||= [];
  const seen = new Set();
  for (const { userId, role } of recipients) {
    const key = `${userId}:${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    store.notifications.push({ id: createId('notif'), userId, appRole: role, orderId: order.id,
      type: `refund_${kind}`, title: 'Client refund',
      body: role === 'supplier' && kind === 'rejected'
        ? 'The refund request was rejected. Open the order for its work and payout status.' : copy[kind], read: false, at });
  }
  queueOrderInvalidate(store, order, ['orders', 'payouts', 'claims']);
}

function earlierAmounts(store, order) {
  const rows = (store.refundSettlements || []).filter((row) => row.orderId === order.id);
  return Object.fromEntries(['principalMinor', 'feeMinor', 'deliveryMinor'].map((field) => [field, sumMinor(rows.map((row) => row[field]))]));
}
function lateFiling(store, order, at) {
  if (!handoverCompleted(order)) return false;
  return (['completed', 'payout_released'].includes(order.state) && !refundSettlementFor(store, order))
    || !order.issueWindowExpiresAt || new Date(at).getTime() >= new Date(order.issueWindowExpiresAt).getTime();
}

function settlementCalculation(store, order, request, body) {
  if (Object.values(order.payments || {}).some((payment) => payment.status === 'pending_confirmation')) {
    fail(409, 'refund_collection_reconciliation_required', 'Reconcile all submitted payment proofs before settling the refund.');
  }
  if (order.directStoreDueMinor > 0 && body.directStoreCollectedMinor !== 0) {
    fail(409, 'refund_collection_reconciliation_required', 'For a historical direct-store plan, confirm zero direct shop collection. Any paid or unknown direct amount needs Super Admin reconciliation.', { escalateTo: 'super_admin' });
  }
  const previous = store.refundSettlements.filter((row) => row.orderId === order.id);
  const priorRiderEntitlementMinor = previous.reduce((maximum, row) => Math.max(maximum, row.riderEntitlementMinor), 0);
  if (body.riderEntitlementMinor < priorRiderEntitlementMinor) {
    fail(409, 'refund_requires_super_admin', 'Previously recorded rider earnings cannot be recovered. Refer this remedy to Super Admin.', { escalateTo: 'super_admin' });
  }
  const input = { beforeProduction: request.beforeProduction,
    shopEntitlementMinor: body.shopEntitlementMinor, riderEntitlementMinor: body.riderEntitlementMinor,
    earlier: earlierAmounts(store, order), settlementPaidMinor: sumMinor(store.refundSupplierPayouts
      .filter((row) => row.orderId === order.id && row.status === 'released').map((row) => row.amountMinor)) };
  const maximum = calculateRefundSettlement(order, input);
  const amounts = calculateRefundSettlement(order, { ...input, principalMinor: body.principalMinor });
  const split = deliverySplit(order.deliveryFeeMinor ?? 0, order.riderCommissionBps ?? 10000);
  if (deliveryCompleted(order) && amounts.riderEntitlementMinor < split.riderPayoutMinor) {
    fail(409, 'refund_requires_super_admin', 'Earned rider pay must be protected. Refer exceptions to Super Admin.', { escalateTo: 'super_admin' });
  }
  return { amounts, maximum };
}

export async function routeRefunds({ req, url, store, user, readBody, now, id, audit }) {
  const orderMatch = url.pathname.match(/^\/orders\/([^/]+)\/refund-requests$/);
  const match = url.pathname.match(/^\/refund-requests(?:\/([^/]+)(?:\/(destination|review|settlement-preview|settle|reject|withdraw|payment-attempts|reconcile|payments|supplier-payout))?)?$/);
  if (!orderMatch && !match) return null;
  if (!user) fail(401, 'unauthorized', 'Sign in to manage refunds.');
  if (!privileged(user) && user.role !== 'client') fail(403, 'forbidden', 'Only the client and Operations may read refunds.');
  for (const name of ['refundRequests', 'refundSettlements', 'refundSupplierPayouts', 'refundAttempts', 'refundPayments', 'refundEvents', 'refundCommands']) store[name] ||= [];
  let request = match?.[1] ? store.refundRequests.find((row) => row.id === match[1]) : null;
  if (match?.[1] && !request) fail(404, 'refund_not_found', 'Refund request not found.');
  const order = (orderMatch || request) ? store.orders.find((row) => row.id === (orderMatch?.[1] || request.orderId)) : null;
  if ((orderMatch || request) && !order) fail(404, 'order_not_found', 'Order not found.');
  if (order && !privileged(user) && order.clientId !== user.id) fail(403, 'forbidden', 'This is another client’s order.');
  if (req.method === 'GET' && !match?.[2]) {
    const records = store.refundRequests.filter((row) => (!order || row.orderId === order.id)
      && (privileged(user) || row.clientId === user.id));
    if (request) return { status: 200, body: { refund: publicRefund(store, request, user) } };
    const status = url.searchParams.get('status');
    return { status: 200, body: { refunds: records.filter((row) => !status || row.status === status).map((row) => publicRefund(store, row, user)) } };
  }
  const action = orderMatch ? 'request' : match?.[2];
  if ((action === 'destination' ? req.method !== 'PATCH' : req.method !== 'POST') || !action) return null;
  if (!['request', 'destination', 'withdraw'].includes(action)) requireOps(user);
  const body = await readBody(req);
  if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'invalid_refund_request', 'Send a JSON object.');
  if (action === 'settlement-preview') {
    if (!['requested', 'reviewed'].includes(request.status)) fail(409, 'refund_state_conflict', 'Preview a refund that has not been settled.');
    if (body.expectedVersion !== request.version) fail(409, 'refund_stale', 'Reload this refund before previewing it.', { currentVersion: request.version });
    const { amounts, maximum } = settlementCalculation(store, order, request, body);
    return { status: 200, body: { amounts, availableTotalMinor: maximum.totalMinor, canSettle: amounts.totalMinor > 0 } };
  }
  const key = text(req.headers?.['idempotency-key'], 'Idempotency-Key', 120);
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const route = `${req.method} ${url.pathname}`;
  const replay = store.refundCommands.find((row) => row.actorId === user.id && row.requestKey === key);
  if (replay) {
    if (replay.route !== route || replay.bodyHash !== bodyHash) fail(409, 'refund_idempotency_conflict', 'That idempotency key was used for another request.');
    return structuredClone(replay.response);
  }
  if (request && body.expectedVersion !== request.version) fail(409, 'refund_stale', 'Reload this refund before changing it.', { currentVersion: request.version });
  const at = now();
  let eventKind = action;
  let eventReason = action === 'destination' ? 'Client replaced receiving QR.' : text(body.reason, 'reason');
  let eventData = {};
  if (action === 'request') {
    if (refundHold(store, order)) fail(409, 'refund_already_open', 'This order already has an active refund request.');
    const late = lateFiling(store, order, at);
    if (late && user.role !== 'super_admin') fail(409, 'refund_window_closed', 'The filing window is closed. Contact Super Admin.', { escalateTo: 'super_admin' });
    if (!['cancellation', 'complaint'].includes(body.kind)) fail(400, 'invalid_refund_kind', 'Choose cancellation or complaint.');
    if (!sumMinor(Object.values(collectedRefundComponents(order)))) fail(409, 'refund_payment_not_verified', 'Operations must verify the payment before a refund can be requested.');
    const evidenceIds = body.evidenceFileIds ?? [];
    if (!Array.isArray(evidenceIds) || evidenceIds.length > 10 || new Set(evidenceIds).size !== evidenceIds.length) fail(400, 'invalid_refund_evidence', 'Attach up to ten distinct evidence files.');
    const evidence = evidenceIds.map((fileId) => readyFile(store, fileId, 'refund_evidence', user.id));
    request = { id: id('refund'), orderId: order.id, clientId: order.clientId, policyVersion: 'available_funds_v1', status: 'requested', version: 1,
      kind: body.kind, reason: eventReason, beforeProduction: !productionStarted(order), late,
      filingDeadlineAt: order.issueWindowExpiresAt || null, orderStateAtFiling: order.state,
      evidenceFileIds: evidenceIds, destination: null, createdAt: at, updatedAt: at };
    if (body.destination) changeDestination(store, request, user, body.destination);
    for (const file of evidence) bind(file, request, 'evidence');
    store.refundRequests.push(request);
    eventKind = 'requested';
  } else if (action === 'destination') {
    if (!['requested', 'reviewed', 'approved', 'destination_review'].includes(request.status) || activeAttempt(store, request)) fail(409, 'refund_destination_locked', 'Reconcile the active payment before changing its destination.');
    changeDestination(store, request, user, body);
    if (settlementFor(store, request)) request.status = 'destination_review';
    else request.status = 'requested';
    eventData = { revision: request.destination.revision, qrFileId: request.destination.qrFileId };
  } else if (action === 'review') {
    if (!['requested', 'reviewed', 'destination_review'].includes(request.status)) fail(409, 'refund_state_conflict', 'This refund cannot be reviewed now.');
    if (request.late && user.role !== 'super_admin') fail(403, 'refund_super_admin_required', 'Super Admin must review a late case.');
    if (body.destinationVerified !== true || !request.destination) fail(400, 'refund_destination_verification_required', 'Verify the client’s receiving QR and account name.');
    if (request.kind === 'complaint' && body.substantiated !== true) fail(400, 'refund_complaint_not_substantiated', 'Record a substantiated complaint or reject it with a reason.');
    request.status = settlementFor(store, request) ? 'approved' : 'reviewed';
    eventKind = 'reviewed';
    eventData = { destinationRevision: request.destination.revision, substantiated: body.substantiated === true };
  } else if (action === 'settle') {
    if (request.status !== 'reviewed' || settlementFor(store, request)) fail(409, 'refund_state_conflict', 'Review the refund before settling it.');
    if (request.late && user.role !== 'super_admin') fail(403, 'refund_super_admin_required', 'Super Admin must settle a late case.');
    if (body.workStopped !== true) fail(400, 'refund_work_stop_required', 'Confirm production and fulfilment have stopped.');
    const shopAgreement = text(body.shopAgreement, 'shopAgreement');
    const deliveryEvidence = text(body.deliveryEvidence, 'deliveryEvidence');
    const { amounts, maximum } = settlementCalculation(store, order, request, body);
    if (!amounts.totalMinor) fail(409, 'refund_no_available_funds', 'No available refund remains. Refer the remedy to Super Admin.', { escalateTo: 'super_admin' });
    refundMinor(body.totalMinor, 'totalMinor');
    if (body.totalMinor > maximum.totalMinor) fail(409, 'refund_exceeds_available_funds', 'The requested total exceeds available funds. Refer the remedy to Super Admin.', {
      availableTotalMinor: maximum.totalMinor, escalateTo: 'super_admin',
    });
    if (body.totalMinor !== amounts.totalMinor) fail(409, 'refund_amount_mismatch', 'Review the calculated component amounts before approving.', { amounts });
    // Returned delivery is unused service. Attribute only the collected platform share to revenue.
    const collectedSplit = deliverySplit(amounts.collected.deliveryMinor, order.riderCommissionBps ?? 10000);
    const previousPlatform = sumMinor(store.refundSettlements.filter((row) => row.orderId === order.id).map((row) => row.platformDeliveryMinor));
    const platformDeliveryMinor = Math.min(amounts.deliveryMinor, Math.max(0, collectedSplit.platformDeliveryShareMinor - previousPlatform));
    const settlement = { id: id('rsettle'), requestId: request.id, orderId: order.id, createdBy: user.id, createdAt: at,
      sequence: store.refundSettlements.filter((row) => row.orderId === order.id).length + 1,
      reason: eventReason, shopAgreement, deliveryEvidence,
      disposition: handoverCompleted(order) ? 'fulfilled_with_refund' : 'cancelled',
      shopEntitlementMinor: amounts.shopEntitlementMinor, riderEntitlementMinor: amounts.riderEntitlementMinor,
      principalMinor: amounts.principalMinor, feeMinor: amounts.feeMinor, deliveryMinor: amounts.deliveryMinor,
      platformDeliveryMinor, totalMinor: amounts.totalMinor, snapshot: { ...amounts,
        ...(order.directStoreDueMinor > 0 ? { directStoreDueMinor: order.directStoreDueMinor, directStoreCollectedMinor: 0 } : {}) } };
    store.refundSettlements.push(settlement);
    const supersededStages = [];
    for (const stage of order.payoutMilestones || []) {
      if (stage.status === 'released' || stage.status === 'superseded') continue;
      stage.status = 'superseded'; stage.supersededBySettlementId = settlement.id; stage.supersededAt = at;
      supersededStages.push(stage.code);
    }
    const supersededPayoutIds = [];
    for (const payout of store.refundSupplierPayouts) {
      if (payout.orderId === order.id && payout.status === 'pending') {
        payout.status = 'superseded'; supersededPayoutIds.push(payout.id);
      }
    }
    if (amounts.remainingShopMinor) {
      if (!order.supplierId) fail(409, 'refund_supplier_reconciliation_required', 'Identify the shop owed this settlement before approval.');
      store.refundSupplierPayouts.push({ id: id('rspay'), settlementId: settlement.id, orderId: order.id,
        supplierId: order.supplierId, amountMinor: amounts.remainingShopMinor, status: 'pending',
        reference: null, receiptFileId: null, releasedAt: null, releasedBy: null, createdAt: at });
    }
    request.status = 'approved';
    if (settlement.disposition === 'cancelled') {
      order.state = 'cancelled';
      order.cancelledAt = at; order.cancelledBy = user.id; order.cancellationReason = eventReason;
      for (const job of store.orderJobs || []) if (job.orderId === order.id) { job.state = 'cancelled'; job.updatedAt = at; }
    } else {
      order.state = 'completed';
      for (const job of store.orderJobs || []) if (job.orderId === order.id) { job.state = 'completed'; job.updatedAt = at; }
    }
    order.updatedAt = at;
    order.timeline ||= [];
    order.timeline.push({ at, by: user.id, state: order.state, note: 'Refund settlement approved; no client transfer recorded yet.' });
    eventKind = 'settled'; eventData = { settlementId: settlement.id, supersededStages, supersededPayoutIds };
  } else if (action === 'reject' || action === 'withdraw') {
    if (action === 'reject' && request.late && user.role !== 'super_admin') fail(403, 'refund_super_admin_required', 'Super Admin must decide a late case.');
    if (settlementFor(store, request) || !['requested', 'reviewed'].includes(request.status)) fail(409, 'refund_state_conflict', 'A settled refund cannot be withdrawn or rejected. Reconcile its payment.');
    if (action === 'withdraw' && (user.role !== 'client' || user.id !== request.clientId)) fail(403, 'forbidden', 'Only the owning client may withdraw.');
    request.status = action === 'reject' ? 'rejected' : 'withdrawn';
    eventKind = request.status;
  } else if (action === 'payment-attempts') {
    if (request.status !== 'approved' || activeAttempt(store, request)) fail(409, 'refund_payment_reserved', 'A payer already reserved this refund, or approval is required. Do not send another transfer.');
    if (body.destinationRevision !== request.destination?.revision || body.destinationVerified !== true) fail(409, 'refund_destination_stale', 'Verify the approved destination before sending.');
    const settlement = settlementFor(store, request);
    const attempt = { id: id('rattempt'), requestId: request.id, settlementId: settlement.id, payerId: user.id,
      status: 'in_progress', destination: structuredClone(request.destination), amountMinor: settlement.totalMinor,
      provider: text(body.provider, 'provider', 40).toLowerCase(), sourceWallet: text(body.sourceWallet, 'sourceWallet', 120).toLowerCase(),
      createdAt: at, updatedAt: at };
    store.refundAttempts.push(attempt);
    request.status = 'payment_in_progress'; eventKind = 'attempt'; eventData = { attemptId: attempt.id };
  } else if (action === 'reconcile') {
    const attempt = activeAttempt(store, request);
    if (!attempt || !['in_progress', 'unknown'].includes(attempt.status)) fail(409, 'refund_state_conflict', 'No payment needs reconciliation.');
    if (attempt.payerId !== user.id && user.role !== 'super_admin') fail(403, 'refund_payer_required', 'Only the reserved payer or Super Admin may reconcile this transfer.');
    if (!['unknown', 'failed'].includes(body.outcome)) fail(400, 'invalid_refund_outcome', 'Use unknown or failed; record a sent transfer through payments.');
    if (body.outcome === 'failed' && body.noTransferConfirmed !== true) fail(400, 'refund_no_transfer_confirmation_required', 'Confirm no money moved before permitting another attempt.');
    attempt.status = body.outcome; attempt.updatedAt = at;
    request.status = body.outcome === 'unknown' ? 'payment_unknown' : 'approved';
    eventKind = body.outcome; eventData = { attemptId: attempt.id };
  } else if (action === 'supplier-payout') {
    const settlement = settlementFor(store, request);
    const payout = store.refundSupplierPayouts.find((row) => row.settlementId === settlement?.id && row.status === 'pending');
    if (!payout) fail(409, 'refund_supplier_payout_not_pending', 'No remaining shop settlement payout is pending.');
    if (order.payoutHold || (store.claims || []).some((claim) => claim.orderId === order.id && ['open', 'payout_held'].includes(claim.status))
      || (store.issues || []).some((issue) => issue.orderId === order.id && !['resolved', 'dismissed'].includes(issue.status))
      || store.refundRequests.some((row) => row.orderId === order.id && ['requested', 'reviewed'].includes(row.status))) {
      fail(409, 'payout_held', 'Resolve the independent claims, issues and pending refund reviews before paying the shop.');
    }
    if (body.amountMinor !== payout.amountMinor) fail(409, 'refund_supplier_payout_amount_mismatch', 'Pay exactly the agreed remaining shop obligation.', { amountMinor: payout.amountMinor });
    const account = opsPayoutAccountProjection(store, payout.supplierId);
    if (!account?.qr || body.payoutAccountVersion !== account.version || body.destinationVerified !== true) {
      fail(409, 'refund_supplier_destination_verification_required', 'Open and verify the shop’s current receiving QR before recording payment.');
    }
    const reference = paymentReferenceValue(body.reference);
    if (!reference || !body.receiptFileId) fail(400, 'refund_supplier_transfer_evidence_required', 'Record the wallet reference and receipt screenshot.');
    const receipt = resolvePayoutReceipt(store, body.receiptFileId, user);
    bindPayoutReceipt(order, { code: 'refund_settlement' }, receipt);
    payout.receiptFileId = receipt.fileId;
    payout.status = 'released'; payout.reference = reference; payout.releasedAt = at; payout.releasedBy = user.id;
    eventKind = 'supplier_paid'; eventData = { payoutId: payout.id, receiptFileId: receipt.fileId, amountMinor: payout.amountMinor,
      payoutAccountVersion: account.version, payoutQrFileId: account.qr.fileId };
  } else if (action === 'payments') {
    const attempt = activeAttempt(store, request);
    if (!attempt || !['in_progress', 'unknown'].includes(attempt.status)) fail(409, 'refund_payment_attempt_required', 'Reserve a payment first. If money was already sent, reconcile that transfer; do not send again.');
    if (attempt.payerId !== user.id && user.role !== 'super_admin') fail(403, 'refund_payer_required', 'Only the reserved payer or Super Admin may record this transfer.');
    if (body.attemptId !== attempt.id || body.amountMinor !== attempt.amountMinor) fail(409, 'refund_payment_mismatch', 'Record the exact reserved transfer and amount.');
    const reference = text(body.reference, 'reference', 120).toUpperCase();
    if (store.refundPayments.some((row) => row.provider === attempt.provider && row.sourceWallet === attempt.sourceWallet && row.reference === reference)) fail(409, 'refund_duplicate_transfer', 'That wallet transfer is already recorded. Reconcile it with Operations.');
    const receipt = readyFile(store, body.receiptFileId, 'refund_receipt', user.id);
    if (typeof body.paidAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.paidAt)
      || !Number.isFinite(Date.parse(body.paidAt)) || Date.parse(body.paidAt) > Date.parse(at)) fail(400, 'invalid_refund_paid_at', 'Enter the wallet transfer time as an ISO timestamp, no later than now.');
    const payment = { id: id('rpay'), requestId: request.id, attemptId: attempt.id, provider: attempt.provider,
      sourceWallet: attempt.sourceWallet, reference, receiptFileId: receipt.fileId, amountMinor: attempt.amountMinor,
      paidAt: new Date(body.paidAt).toISOString(), recordedBy: user.id, createdAt: at };
    bind(receipt, request, 'transfer_evidence');
    store.refundPayments.push(payment); attempt.status = 'paid'; attempt.updatedAt = at; request.status = 'paid';
    const settlement = settlementFor(store, request);
    order.revenueAdjustments ||= [];
    const returnedPlatform = sumMinor([settlement.feeMinor, settlement.platformDeliveryMinor]);
    if (returnedPlatform) order.revenueAdjustments.push({ id: id('rev'), kind: 'refund', amountMinor: -returnedPlatform,
      reason: `Client refund ${request.id}`, createdBy: user.id, createdAt: at });
    eventKind = 'paid'; eventData = { paymentId: payment.id, receiptFileId: receipt.fileId };
  }
  if (action !== 'request') request.version += 1;
  request.updatedAt = at;
  store.refundEvents.push({ id: id('revent'), requestId: request.id, requestVersion: request.version, actorId: user.id, kind: eventKind,
    reason: eventReason, createdAt: at, data: eventData });
  audit(store, { actor: user, action: `refund.${eventKind}`, entityType: 'refund_request', entityId: request.id,
    orderId: order.id, detail: { version: request.version, ...eventData } });
  notify(store, request, order, eventKind, id, at);
  const response = { status: action === 'request' ? 201 : 200, body: { refund: publicRefund(store, request, user) } };
  store.refundCommands.push({ id: id('rcmd'), actorId: user.id, requestKey: key, route, bodyHash,
    response: structuredClone(response), createdAt: at });
  return { ...response, mutated: true };
}
