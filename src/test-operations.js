import { isReviewData } from './review-data.js';

// Test operations: an ops_admin identity whose own account is review data. It runs the
// operations desk against review data only. Contract: docs/REVIEW_DATA_API.md#test-operations.
export const TEST_OPERATIONS_FORBIDDEN = { error: 'test_operations_forbidden' };

export function isTestOperationsUser(store, userId) {
  const roles = new Set((store.userRoleMemberships || []).filter(row => row.userId === userId).map(row => row.role));
  return roles.has('ops_admin') && !roles.has('super_admin') && isReviewData((store.users || []).find(row => row.id === userId));
}

const ID = '[^/]+';
const route = (methods, pattern) => ({ methods: methods.split(' '), pattern: new RegExp(`^${pattern}$`) });
// Default deny. Every other route answers 403 test_operations_forbidden before routing:
// finance, payouts, refund money, settings writes, privacy, issue reports, tracker, admin, audit,
// exports, role and review-data changes, vouchers, credits and organization accounts.
export const TEST_OPERATIONS_ROUTES = [
  // Identity, own devices, legal acceptance, reference data, public settings and the viewer-scoped catalogue.
  route('GET', '/auth/me(?:/ops)?'),
  route('POST', '/auth/logout'),
  route('GET', '/me'),
  route('POST', '/devices(?:/unregister)?'),
  route('GET', '/web-push/public-key'),
  route('POST', '/web-push/(?:subscribe|unsubscribe)'),
  route('GET', '/legal/documents'),
  route('GET', `/legal/versions/${ID}(?:/pdf)?`),
  route('GET', '/me/legal/pending'),
  route('POST', '/me/legal/accept'),
  route('GET', '/taxonomy(?:/(?:categories|subcategories|materials|finishes))?'),
  route('GET', '/zones'),
  route('GET', '/settings'),
  route('GET', '/accepted-file-formats'),
  route('GET', '/listing-starters'),
  route('GET', '/season-windows'),
  route('GET', '/featured-prints'),
  route('GET', '/catalog'),
  route('GET', `/catalog/shops(?:/${ID})?`),
  route('GET', `/catalog/(?:items|media)/${ID}`),
  // Inbox and desk stream.
  route('GET', '/notifications(?:/stream)?'),
  route('PATCH', '/notifications/read-all'),
  route('PATCH DELETE', `/notifications/${ID}`),
  // Orders: payment simulation, artwork QA, assignment, production, handover, delivery, issues.
  route('GET', '/orders'),
  route('GET', `/orders/${ID}`),
  route('GET', `/orders/${ID}/(?:eligible-suppliers|issues|invoice|qa-checks|cancellation-quote|refund-requests|dropoff-confirmation|physical-invoice)`),
  route('GET', `/orders/${ID}/(?:handover|approval-proof(?:/download)?|delivery-pin|reschedule-request|change-requests)`),
  route('GET', `/orders/${ID}/(?:client-shop-chat|pickup-chat|delivery-chat)`),
  route('POST', `/orders/${ID}/client-shop-chat/messages`),
  route('POST', `/orders/${ID}/(?:pickup-chat|delivery-chat)/messages`),
  route('POST', `/orders/${ID}/artwork-downloads`),
  route('POST', `/orders/${ID}/payments/(?:initial|final_online|downpayment|balance)/(?:confirm|reject)`),
  route('POST', `/orders/${ID}/(?:transition|qa-actions|qa-checks|production-review|production-no-communication|performance-no-fault|collection|issues)`),
  route('POST', `/orders/${ID}/(?:handover/escalate|hub-redelivery|dropoff-confirmation)`),
  route('POST', `/orders/${ID}/shop-recovery(?:/(?:accept|refund))?`),
  route('POST', `/orders/${ID}/reschedule-request/(?:resolve|rematch)`),
  route('GET', '/jobs'),
  route('GET', `/baskets(?:/${ID}(?:/invoice)?)?`),
  route('POST', `/baskets/${ID}/payment/(?:confirm|reject)`),
  route('GET', `/claims(?:/${ID})?`),
  route('POST', `/claims/${ID}/(?:hold|release)`),
  route('GET', `/issues(?:/${ID})?`),
  route('POST', `/issues/${ID}/(?:resolve|decision)`),
  route('GET', '/escalations'),
  route('POST', `/escalations/${ID}/resolve`),
  route('GET', `/refund-requests(?:/${ID}(?:/settlement-preview)?)?`),
  route('POST', `/refund-requests/${ID}/(?:review|reject)`),
  route('GET', '/dispatch/offers'),
  route('GET', `/dispatch/${ID}/location`),
  // Operations queues, already filtered to the review view.
  route('GET', '/ops/riders/locations'),
  route('GET', `/ops/orders/${ID}/location-diagnostics`),
  route('GET', '/ops/hub(?:/(?:escalations|receipt-scans|unclaimed|handouts))?'),
  route('GET', '/ops/(?:shop-failures|colour-price-checks|special-instructions|reschedule-requests|client-shop-chats)'),
  route('GET', `/ops/shops(?:/${ID})?/(?:hours|performance)`),
  // Shop and rider approval, service lines and listing review.
  route('GET', `/approval-cases(?:/${ID})?`),
  route('POST', `/approval-cases/${ID}/(?:approve|reject|suspend|restore)`),
  route('GET', `/users(?:/${ID}(?:/verification-documents|/production-lapses)?)?`),
  route('GET', `/supplier-services(?:/${ID})?`),
  route('POST', `/supplier-services/${ID}/(?:verify|suspend)`),
  route('GET', `/ops/catalog-items(?:/${ID})?`),
  route('GET', `/ops/catalog/(?:shops(?:/${ID})?|items/${ID})`),
  route('GET', '/ops/catalog-reviews'),
  route('POST', `/ops/catalog-reviews/${ID}/decision`),
  route('GET', '/ops/product-type-requests'),
  route('POST', `/ops/product-type-requests/${ID}/decision`),
  route('POST', `/catalog-items/${ID}/(?:suspend|restore)`),
  // Files: reads stay limited to files visible in the review view.
  route('POST', '/files'),
  route('POST', `/files/${ID}/attach`),
  route('GET', `/files/${ID}(?:/(?:download-url|content|preview-url))?`),
  // Support chat with review accounts only.
  route('GET', '/support-chat/(?:threads|people|stream)'),
  route('POST', '/support-chat/threads'),
  route('GET', `/support-chat/threads/${ID}(?:/messages)?`),
  route('POST', `/support-chat/threads/${ID}/messages`),
  route('PATCH', `/support-chat/threads/${ID}/read`),
];

export function testOperationsRouteAllowed(method, pathname) {
  const verb = method === 'HEAD' ? 'GET' : method;
  return method === 'OPTIONS' || TEST_OPERATIONS_ROUTES.some(row => row.methods.includes(verb) && row.pattern.test(pathname));
}

// Reference tables carry no party data and are shared by every audience.
const REFERENCE = new Set(['catalog', 'seasonWindows', 'zones', 'acceptedFileFormats', 'listingStarters',
  'listingStarterGroups', 'listingStarterOptions', 'staffRoles', 'voucherCampaigns']);
// Party references. A row is visible only when every reference it carries is.
const USER_KEYS = ['userId', 'clientId', 'supplierId', 'riderId', 'ownerId', 'staffId', 'partyUserId', 'originalSupplierId', 'redeemedBy', 'createdBy'];
const PARENT_KEYS = [['orderId', 'orders'], ['requestId', 'refundRequests'], ['approvalCaseId', 'approvalCases'],
  ['catalogItemId', 'catalogItems'], ['supplierServiceId', 'supplierServices'], ['cartId', 'carts'],
  ['orderLineItemId', 'orderLineItems'], ['optionGroupId', 'catalogOptionGroups'], ['claimId', 'claims']];
const FILE_REFERENCES = { order: 'orders', supplier_catalog_item: 'catalogItems', user: 'users', approval_case: 'approvalCases' };
const PRIVILEGED = new Set(['ops_admin', 'super_admin']);
const views = new WeakMap();

/**
 * Review-only domain view for one test operations request. Rows are the stored objects, so
 * in-place edits reach the real store; `save()` merges added and removed rows back.
 * Ops/Super Admin membership rows stay so inbox fan-out reaches every staff account.
 */
export function testOperationsView(store, viewer) {
  const visible = { users: new Set((store.users || []).filter(row => isReviewData(row) || row.id === viewer.id).map(row => row.id)) };
  visible.orders = new Set((store.orders || []).filter(isReviewData).map(row => row.id));
  const view = {};
  const originals = new Map();
  const keep = (key, row) => {
    if (key === 'users') return visible.users.has(row.id);
    if (key === 'orders') return visible.orders.has(row.id);
    if (key === 'userRoleMemberships') return visible.users.has(row.userId) || PRIVILEGED.has(row.role);
    if (key === 'baskets') return (row.orderIds || []).length > 0 && row.orderIds.every(id => visible.orders.has(id));
    if (key === 'notifications' && row.orderId) return visible.orders.has(row.orderId);
    // Staff inbox rows without a review order or case are about unmarked activity.
    if (key === 'notifications' && !row.approvalCaseId && PRIVILEGED.has(row.appRole)) return false;
    if (key === 'files') {
      return visible.users.has(row.ownerId) || (row.references || []).some(ref => visible[FILE_REFERENCES[ref.type]]?.has(ref.id));
    }
    const refs = [];
    for (const [field, parent] of PARENT_KEYS) if (row[field]) refs.push(Boolean(visible[parent]?.has(row[field])));
    const orderIds = row.orderIds || row.data?.orderIds;
    if (Array.isArray(orderIds)) refs.push(orderIds.every(id => visible.orders.has(id)));
    for (const field of USER_KEYS) if (row[field]) refs.push(visible.users.has(row[field]));
    return refs.length > 0 && refs.every(Boolean);
  };
  const filter = key => {
    const rows = (store[key] || []).filter(row => keep(key, row));
    visible[key] ||= new Set(rows.map(row => row.id));
    view[key] = rows;
    originals.set(key, rows.slice());
  };
  // Parents first: child rows test membership in these sets.
  for (const key of ['users', 'orders', 'approvalCases', 'catalogItems', 'supplierServices', 'carts', 'refundRequests',
    'orderLineItems', 'catalogOptionGroups', 'claims']) filter(key);
  for (const [key, value] of Object.entries(store)) {
    if (originals.has(key)) continue;
    if (!Array.isArray(value)) view[key] = key === 'credits'
      ? Object.fromEntries(Object.entries(value || {}).filter(([userId]) => visible.users.has(userId))) : value;
    else if (REFERENCE.has(key)) view[key] = value;
    else filter(key);
  }
  for (const key of ['listOwnCatalogItems']) if (store[key]) Object.defineProperty(view, key, { value: store[key], enumerable: false });
  views.set(view, { store, originals, scalars: Object.fromEntries(Object.entries(view).filter(([key]) => !originals.has(key))) });
  return view;
}

/** Applies a view's row additions, removals and replaced values to its store; returns the store to save. */
export function mergeTestOperationsView(view) {
  const entry = views.get(view);
  if (!entry) return view;
  const { store, originals, scalars } = entry;
  for (const [key, value] of Object.entries(view)) {
    const before = originals.get(key);
    if (!before) {
      if (key === 'credits') Object.assign(store.credits ||= {}, value);
      else if (!(key in scalars) || scalars[key] !== value) store[key] = value;
      continue;
    }
    const now = new Set(value);
    const prior = new Set(before);
    const removed = before.filter(row => !now.has(row));
    const added = value.filter(row => !prior.has(row));
    if (!removed.length && !added.length) continue;
    const gone = new Set(removed);
    store[key] = [...(store[key] || []).filter(row => !gone.has(row)), ...added];
    originals.set(key, value.slice());
  }
  return store;
}

/** A notification or refetch subject a test operations session may receive. */
export function reviewSubject(store, { orderId, approvalCaseId, id, resource } = {}) {
  const user = userId => isReviewData((store.users || []).find(row => row.id === userId));
  const order = orderId => isReviewData((store.orders || []).find(row => row.id === orderId));
  if (orderId) return order(orderId);
  if (approvalCaseId) return user((store.approvalCases || []).find(row => row.id === approvalCaseId)?.userId);
  if (!id) return ['notifications', 'identity'].includes(resource);
  if (order(id) || user(id)) return true;
  for (const key of ['orderJobs', 'claims', 'issues', 'escalations', 'refundRequests']) {
    const row = (store[key] || []).find(candidate => candidate.id === id);
    if (row) return order(row.orderId);
  }
  const basket = (store.baskets || []).find(row => row.id === id);
  if (basket) return (basket.orderIds || []).length > 0 && basket.orderIds.every(order);
  const owned = ['approvalCases', 'catalogItems', 'supplierServices'].map(key => (store[key] || []).find(row => row.id === id)).find(Boolean);
  return Boolean(owned) && user(owned.userId || owned.supplierId);
}
