import { identityHasMembership } from './authorization-context.js';
import { appendAudit } from './audit.js';

export const isReviewData = row => row?.reviewData === true;
export const sameReviewData = (a, b) => isReviewData(a) === isReviewData(b);
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
export const includeReviewData = (user, params) => params?.get('includeReviewData') === '1'
  && ['ops_admin', 'super_admin'].some(role => identityHasMembership(user, role));

export function setReviewData(store, actor, userId, { reviewData, expectedVersion, reason }) {
  if (actor?.role !== 'system' && !identityHasMembership(actor, 'super_admin')) fail('forbidden', 403);
  const user = store.users.find(row => row.id === userId);
  if (!user) fail('user_not_found', 404);
  if (typeof reviewData !== 'boolean') fail('invalid_review_data', 400);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 2000) fail('reason_required', 400);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== (user.version || 1)) fail('user_version_conflict');
  const before = { reviewData: isReviewData(user), version: user.version || 1 };
  user.reviewData = reviewData;
  user.version = before.version + 1;
  appendAudit(store, { actor, action: 'user.review_data_change', entityType: 'user', entityId: user.id,
    reason: reason.trim(), before, after: { reviewData, version: user.version } });
  return user;
}

// This view is never persisted. Filter before projecting photos, direct item URLs,
// selection tokens, queue sizes or aggregate money.
export const REVIEW_CATALOG_TABLES = ['catalogItems', 'supplierProfiles', 'supplierServices', 'supplierShopMedia', 'catalogItemPhotos'];
export function reviewCatalogView(store, viewer, all = false) {
  if (all) return store;
  const marked = new Set((store.users || []).filter(isReviewData).map(row => row.id));
  const allowed = supplierId => marked.has(supplierId) === isReviewData(viewer);
  const items = (store.catalogItems || []).filter(row => allowed(row.supplierId));
  const itemIds = new Set(items.map(row => row.id));
  return { ...store, catalogItems: items,
    supplierProfiles: (store.supplierProfiles || []).filter(row => allowed(row.userId)),
    supplierServices: (store.supplierServices || []).filter(row => allowed(row.supplierId)),
    supplierShopMedia: (store.supplierShopMedia || []).filter(row => allowed(row.supplierId)),
    catalogItemPhotos: (store.catalogItemPhotos || []).filter(row => itemIds.has(row.catalogItemId)) };
}

export function reviewReportView(store, include = false) {
  if (include) return { ...store, reviewDataReportsIncluded: true, reviewDataReadOnly: true };
  const hidden = new Set((store.orders || []).filter(isReviewData).map(row => row.id));
  const markedClients = new Set((store.users || []).filter(isReviewData).map(row => row.id));
  const requests = new Set((store.refundRequests || []).filter(row => hidden.has(row.orderId)).map(row => row.id));
  const view = { ...store, reviewDataReadOnly: true };
  // Child records must follow their immutable order, even after an account is unmarked.
  for (const [key, rows] of Object.entries(store)) {
    if (!Array.isArray(rows) || key === 'notifications') continue;
    view[key] = rows.filter(row => !(
      (['checkoutVisits', 'checkoutExitPrompts'].includes(key) && markedClients.has(row.clientId))
      || (key === 'orders' ? hidden.has(row.id)
      : hidden.has(row.orderId) || requests.has(row.requestId) || (row.orderIds || row.data?.orderIds)?.some(id => hidden.has(id)))));
  }
  return view;
}

export function assertReviewMoneyAllowed(order) {
  if (isReviewData(order)) fail('review_data_money_forbidden');
}

// Called by every graph writer, including CLI writers. A route cannot opt out.
export function enforceReviewData(store, previous) {
  if (store.reviewDataReadOnly) throw new Error('Review reporting views are read-only');
  const prior = new Map((previous?.orders || []).map(row => [row.id, row]));
  const users = new Map((store.users || []).map(row => [row.id, row]));
  for (const order of store.orders || []) {
    const old = prior.get(order.id);
    if (old && isReviewData(old) !== isReviewData(order)) fail('review_data_snapshot_immutable');
    if (!old) order.reviewData = isReviewData(users.get(order.clientId));
    for (const key of ['supplierId', 'riderId']) {
      if (order[key] && old?.[key] !== order[key] && !sameReviewData(order, users.get(order[key]))) fail('review_data_assignment_mismatch');
    }
    if (!isReviewData(order)) continue;
    if (order.deliveryPin?.change?.status === 'pending_confirmation'
      && JSON.stringify(order.deliveryPin.change) !== JSON.stringify(old?.deliveryPin?.change)) assertReviewMoneyAllowed(order);
    if (order.state === 'payout_released' && old?.state !== order.state) assertReviewMoneyAllowed(order);
    for (const [code, payment] of Object.entries(order.payments || {})) {
      if (['confirmed', 'pending_confirmation'].includes(payment.status)
        && JSON.stringify(payment) !== JSON.stringify(old?.payments?.[code])) assertReviewMoneyAllowed(order);
    }
    for (const stage of order.payoutMilestones || []) {
      if (stage.status === 'released' && JSON.stringify(stage) !== JSON.stringify(old?.payoutMilestones?.find(row => row.code === stage.code))) assertReviewMoneyAllowed(order);
    }
  }
  const orders = new Map((store.orders || []).map(row => [row.id, row]));
  for (const job of store.orderJobs || []) {
    const old = previous?.orderJobs?.find(row => row.id === job.id), order = orders.get(job.orderId);
    for (const key of ['supplierId', 'riderId']) if (job[key] && job[key] !== old?.[key] && !sameReviewData(order, users.get(job[key]))) fail('review_data_assignment_mismatch');
  }
  const financial = ['orderChangePayments', 'orderChangePayouts', 'deliveryPinPayments', 'refundAttempts', 'refundPayments', 'refundSettlements', 'orderChanges'];
  for (const key of [...financial, 'refundSupplierPayouts']) {
    const old = new Map((previous?.[key] || []).map(row => [row.id, row]));
    for (const row of store[key] || []) {
      if (JSON.stringify(row) === JSON.stringify(old.get(row.id))) continue;
      if (key === 'orderChanges' && row.status !== 'pending_confirmation') continue;
      if (key === 'refundSupplierPayouts' && row.status !== 'released') continue;
      const request = store.refundRequests?.find(r => r.id === row.requestId);
      assertReviewMoneyAllowed(orders.get(row.orderId || request?.orderId));
    }
  }
  for (const key of ['vouchers', 'voucherReservations', 'voucherRedemptions', 'voucherLedger']) {
    const old = new Map((previous?.[key] || []).map(row => [row.id, row]));
    for (const row of store[key] || []) {
      if (JSON.stringify(row) === JSON.stringify(old.get(row.id))) continue;
      if (isReviewData(users.get(row.clientId)) || row.data?.orderIds?.some(orderId => isReviewData(orders.get(orderId)))) fail('review_data_money_forbidden');
    }
  }
  for (const [userId, credit] of Object.entries(store.credits || {})) {
    if (isReviewData(users.get(userId)) && JSON.stringify(credit) !== JSON.stringify(previous?.credits?.[userId])
      && (credit.balanceMinor || credit.ledger?.length)) fail('review_data_money_forbidden');
  }
}

export function labelReviewNotifications(store, previous) {
  const old = new Set((previous?.notifications || []).map(row => row.id));
  const review = new Set((store.orders || []).filter(isReviewData).map(row => row.id));
  for (const notice of store.notifications || []) {
    if (old.has(notice.id) || !review.has(notice.orderId)) continue;
    notice.reviewData = true;
    if (!notice.title?.startsWith('[Review data]')) notice.title = `[Review data] ${notice.title || 'Order update'}`;
  }
}

export function reportOrderAllowed(store, orderId) {
  return store?.reviewDataReportsIncluded === true || !isReviewData(store?.orders?.find(order => order.id === orderId));
}
