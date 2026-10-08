// Retention operates on domain relationships, never object-key naming conventions.
const DAY = 86_400_000;
const ARTWORK = new Set(['artwork', 'mockup']);
const MONEY = new Set(['supplier_invoice', 'payment_proof', 'payout_receipt', 'refund_receipt', 'refund_qr', 'refund_evidence']);
const PHOTOS = new Set(['packing_photo', 'production_photo', 'fulfilment_proof', 'delivery_photo', 'handoff_signature']);
const CLOSED = new Set(['completed', 'payout_released', 'cancelled']);
const CASE_TERMINALS = {
  issues: ['resolved', 'dismissed'], claims: ['released', 'resolved'],
  refundRequests: ['paid', 'rejected', 'withdrawn'], disputes: ['closed', 'resolved', 'dismissed'],
  escalations: ['resolved', 'dismissed'],
};
function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
function contains(value, fileId) {
  if (value === fileId) return true;
  return value && typeof value === 'object' && Object.values(value).some((item) => contains(item, fileId));
}
function verification(file) { return file.purpose.endsWith('verification_document'); }
function deadline(value, years = 0, days = 0) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  // Calendar years; leap-day anniversaries fall on March 1 in non-leap years.
  if (years) date.setUTCFullYear(date.getUTCFullYear() + years);
  return new Date(date.getTime() + days * DAY).toISOString();
}
function latest(values) {
  const valid = values.filter((value) => value && Number.isFinite(Date.parse(value)));
  return valid.length ? valid.sort((a, b) => Date.parse(b) - Date.parse(a))[0] : null;
}

export function fileRelationships(store, file) {
  const orderIds = new Set();
  let unresolved = false;
  for (const ref of file.references || []) {
    if (ref.type === 'order') orderIds.add(ref.id);
    if (ref.type === 'pickup_chat_message') {
      if (ref.orderId) orderIds.add(ref.orderId); else unresolved = true;
    }
    const caseCollection = { refund_request: 'refundRequests', issue: 'issues', claim: 'claims', dispute: 'disputes', escalation: 'escalations' }[ref.type];
    if (caseCollection) {
      const request = (store[caseCollection] || []).find((row) => row.id === ref.id);
      if (request?.orderId) orderIds.add(request.orderId); else unresolved = true;
    }
  }
  for (const order of store.orders || []) if (contains(order, file.fileId)) orderIds.add(order.id);
  for (const collection of ['orderLineItems', 'orderJobs', 'refundRequests', 'refundPayments', 'refundAttempts', 'refundSupplierPayouts', ...Object.keys(CASE_TERMINALS)]) {
    for (const row of store[collection] || []) if (contains(row, file.fileId)) {
      if (row.orderId) orderIds.add(row.orderId);
      else if (row.refundRequestId) {
        const request = (store.refundRequests || []).find((item) => item.id === row.refundRequestId);
        if (request?.orderId) orderIds.add(request.orderId); else unresolved = true;
      }
    }
  }
  const orders = [...orderIds].map((id) => (store.orders || []).find((order) => order.id === id));
  if (orders.some((order) => !order)) unresolved = true;
  const activeCart = (store.cartLines || []).some((line) => contains(line, file.fileId)
    && (store.carts || []).some((cart) => cart.id === line.cartId && !['checked_out', 'cancelled', 'expired'].includes(cart.state)));
  const held = unresolved || orders.some((order) => order?.payoutHold || order?.disputeStatus === 'open')
    || Object.entries(CASE_TERMINALS).some(([collection, terminal]) => (store[collection] || []).some((row) =>
      !terminal.includes(row.status) && (orderIds.has(row.orderId) || contains(row, file.fileId))));
  // Verification evidence may be material to a case on any of its owner's orders.
  const ownerHold = verification(file) && Object.entries(CASE_TERMINALS).some(([collection, terminal]) =>
    (store[collection] || []).some((row) => !terminal.includes(row.status) && (store.orders || []).some((order) =>
      order.id === row.orderId && [order.clientId, order.supplierId, order.riderId].includes(file.ownerId))));
  return { orders: orders.filter(Boolean), unresolved, held: held || ownerHold, activeCart };
}

function closedAt(order, artwork) {
  if (!CLOSED.has(order.state) || (artwork && order.state === 'cancelled')) return null;
  // updatedAt also changes on payouts and claims, so it is not a closure clock.
  return order.completedAt || order.closedAt || (order.timeline || []).find((event) =>
    artwork ? ['completed', 'payout_released'].includes(event.state) : CLOSED.has(event.state))?.at || null;
}

export function retentionDecision(store, file, at) {
  const keep = (reason) => ({ eligible: false, reason });
  if (!['ready', 'pending_upload', 'delete_pending'].includes(file.state)) return keep('not_live');
  const links = fileRelationships(store, file);
  if (links.held) return keep('open_case');
  if (file.state === 'delete_pending' && file.deletionSource === 'early') {
    return { eligible: true, reason: 'retry' };
  }
  if (links.activeCart) return keep('active_cart');
  if (file.purpose === 'announcement_image' && (store.notifications || []).some((row) => {
    try { return new URL(row.imageUrl).pathname === `/public/announcement-images/${file.fileId}`; }
    catch { return false; }
  })) return keep('in_use');
  let due;
  let reason;
  if (links.orders.length) {
    if (!ARTWORK.has(file.purpose) && !MONEY.has(file.purpose) && !PHOTOS.has(file.purpose)) return keep('unclassified_order_file');
    const closures = links.orders.map((order) => closedAt(order, ARTWORK.has(file.purpose)));
    if (closures.some((value) => !value || !Number.isFinite(Date.parse(value)))) return keep('order_not_closed');
    due = deadline(latest(closures), MONEY.has(file.purpose) ? 5 : PHOTOS.has(file.purpose) ? 1 : 0, ARTWORK.has(file.purpose) ? 30 : 0);
    reason = 'retention_expired';
  } else if (verification(file) && ((file.references || []).length || file.verificationDocumentType
    || (store.riderDocuments || []).some((row) => row.fileId === file.fileId)
    || (store.approvalCases || []).some((row) => contains(row, file.fileId)))) {
    const owner = (store.users || []).find((row) => row.id === file.ownerId);
    const kind = file.purpose.startsWith('rider') ? 'rider' : file.purpose === 'verification_document' ? 'supplier' : 'business_client';
    const approval = (store.approvalCases || []).find((row) => row.userId === file.ownerId && row.kind === kind);
    const endedAt = owner?.accountStatus === 'removed' ? owner.accountStatusAt
      : file.purpose === 'client_verification_document' ? file.clientApplicationRejectedAt
        : approval?.status === 'rejected' ? approval.decidedAt : null;
    if (!endedAt) return keep('account_active');
    due = deadline(endedAt, 1); reason = 'verification_expired';
  } else {
    if ((file.references || []).length) return keep('in_use');
    // Include live metadata that does not populate file_references (e.g. carts).
    const linked = ['catalogItemPhotos', 'supplierShopMedia', 'supplierServices', 'supplierPayoutAccounts', 'approvalCases', 'users']
      .some((key) => (store[key] || []).some((row) => contains(row, file.fileId))) || contains(store.settings, file.fileId);
    if (linked) return keep('in_use');
    // Upload and attach are separate requests: allow a full day to finish intake.
    due = deadline(file.readyAt || file.createdAt, 0, 1); reason = 'unused';
  }
  return { eligible: Boolean(due && Date.parse(due) <= Date.parse(at)), reason, dueAt: due };
}

export function assertEarlyFileDeletion(store, file, user, reason) {
  if (!user) fail(401, 'unauthorized');
  if (!file) fail(404, 'file_not_found');
  if (!['super_admin', 'client'].includes(user.role)) fail(403, 'forbidden');
  if (user.role === 'super_admin') {
    if (typeof reason !== 'string' || !reason.trim()) fail(400, 'reason_required');
    if (reason.trim().length > 2000) fail(400, 'reason_too_long');
  } else if (file.ownerId !== user.id || !ARTWORK.has(file.purpose)) fail(403, 'forbidden');
  const links = fileRelationships(store, file);
  if (links.held) fail(409, 'file_retention_hold');
  if (user.role === 'client' && (!links.orders.length || links.activeCart
    || links.orders.some((order) => order.clientId !== user.id || !['completed', 'payout_released'].includes(order.state)))) fail(409, 'file_in_use');
}
