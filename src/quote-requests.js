/**
 * Request a quote: custom signage and 3D printing (gridgo-api#226).
 * Contract: docs/QUOTE_REQUESTS_API.md.
 *
 * The client sends a brief with its reference files. Operations gathers prices
 * from suitable shops by hand and records each reply here, then publishes up to
 * three as anonymous options A/B/C. Publishing creates one private whole-job
 * listing per option at the shop's own price (src/quote-listings.js). Accepting
 * an option opens a cart with that listing, so the order is placed, priced and
 * paid through the ordinary cart checkout and continues as any other order.
 */
import { identityHasMembership } from './authorization-context.js';
import { feeSchedule, feeSettings } from './service-fee.js';
import { approvedOrganization, organizationFeeMoney } from './organization-money.js';
import { productionTimeFields } from './production-time.js';
import { shopProductionDayMinutes } from './production-days.js';
import { catalogItemBlockers } from './supplier-catalog.js';
import { supplierMatchBlockersFor } from './supplier-eligibility.js';
import { distanceMetersBetween, distanceZoneForDistance } from './operational-model.js';
import { MATCH_FACTORS, validatePreferenceRanking, projectShopFinish, projectListingGroup, rankQuoteChoices } from './order-match.js';
import { publicShopRating } from './shop-rating.js';
import { grantQuoteListings } from './quote-listings.js';
import { specialInstructions } from './special-instructions.js';
import { openQuoteCart, quoteRequestFulfillment } from './order-match-routes.js';
import { privilegedAdminMemberships } from './notifications.js';
import { writeDraft } from './client-order-notifications.js';

/** Product types this flow quotes (taxonomy subcategory codes). */
export const QUOTE_PRODUCT_TYPES = Object.freeze(['business_store_signages', 'three_d_printing_scale_models']);
export const DEFAULT_QUOTE_VALIDITY_DAYS = 7;
export const MAX_QUOTE_OPTIONS = 3;
const LABELS = ['A', 'B', 'C'];
const OPEN = new Set(['requested', 'quoting', 'published', 'accepted']);
const LISTED = new Set(['published', 'accepted']);
/** An event closer than this, with nothing quoted that makes it, is flagged for Operations. */
const EVENT_DATE_SOON_DAYS = 3;
const DAY_MS = 86_400_000;

function fail(status, code, message, details = {}) {
  throw Object.assign(new Error(message), { status, code, details });
}

function record(value, field = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', `${field} must be a JSON object.`, { field });
  return value;
}

function text(value, field, max, { required = true } = {}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.trim().length > max) {
    fail(400, 'invalid_quote_request', `${field} must be ${required ? 'a nonblank string' : 'text'} of at most ${max} characters.`, { field });
  }
  return value.trim();
}

// Notes become the order line's special instructions, so they must fit that rule now, not at accept.
function quoteNotes(value) {
  const notes = text(value, 'notes', 300, { required: false });
  if (notes) specialInstructions(notes);
  return notes;
}

function minorAmount(value, field, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail(400, 'invalid_quote_request', `${field} must be a ${positive ? 'positive' : 'non-negative'} whole number of centavos.`, { field });
  }
  return value;
}

function expectVersion(body, row) {
  if (body.expectedVersion == null) return;
  if (body.expectedVersion !== row.version) fail(409, 'quote_request_version_conflict', 'This quote changed. Refresh it and try again.', { version: row.version });
}

/** Manila calendar day; quotes, events and deadlines are local. */
function manilaDay(at) {
  return new Date(Date.parse(at) + 8 * 3_600_000).toISOString().slice(0, 10);
}
const endOfManilaDay = (day) => Date.parse(`${day}T23:59:59.999+08:00`);

function eventDate(value, at) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail(400, 'invalid_event_date', 'eventDate must be a calendar date (YYYY-MM-DD).', { field: 'eventDate' });
  }
  if (value < manilaDay(at)) fail(400, 'invalid_event_date', 'The event date has already passed.', { field: 'eventDate' });
  return value;
}

export function quoteValidityDays(settings) {
  const days = settings?.quoteValidityDays;
  return Number.isSafeInteger(days) && days >= 1 && days <= 90 ? days : DEFAULT_QUOTE_VALIDITY_DAYS;
}

/** The status a reader sees: a lapsed validity is expired before the sweep records it. */
function effectiveStatus(request, at) {
  return LISTED.has(request.status) && request.validUntil && Date.parse(request.validUntil) <= Date.parse(at) ? 'expired' : request.status;
}

const isOps = (user) => ['ops_admin', 'super_admin'].includes(user?.role);
const isClient = (user) => user?.role === 'client' && identityHasMembership(user, 'client');

function clientPriceMinor(store, request, priceMinor, at) {
  const fee = organizationFeeMoney(priceMinor, feeSettings(store.settings, feeSchedule(store.settings, at)), approvedOrganization(store, request.clientId));
  return priceMinor + fee.serviceFeeMinor;
}

function eventFit(request, promiseBy) {
  if (!request.eventDate || !promiseBy) return null;
  return Date.parse(promiseBy) <= endOfManilaDay(request.eventDate) ? 'before' : 'after';
}

/**
 * Operations' warning that the event date looks unrealistic. Never blocks; the
 * client already said the date is for information only.
 */
export function eventDateWarning(request, replies, at) {
  if (!request.eventDate) return null;
  const today = manilaDay(at);
  if (request.eventDate < today) return { code: 'event_date_passed', message: 'The event date has already passed.' };
  const active = replies.filter(reply => reply.status === 'active' && reply.readyBy);
  if (active.length && active.every(reply => eventFit(request, reply.readyBy) === 'after')) {
    return { code: 'no_option_before_event', message: 'No shop reply can be ready before the event date.' };
  }
  if (!active.length && endOfManilaDay(request.eventDate) - Date.parse(at) < EVENT_DATE_SOON_DAYS * DAY_MS) {
    return { code: 'event_date_soon', message: `The event is less than ${EVENT_DATE_SOON_DAYS} days away; custom work may not make it.` };
  }
  return null;
}

/* ---------- projections ---------- */

function publicOption(request, option, at) {
  return {
    label: option.label,
    clientPriceMinor: option.clientPriceMinor,
    productionTime: structuredClone(option.productionTime),
    readyBy: option.readyBy,
    eventDateFit: option.eventDateFit,
    recommendedOptions: option.recommendedOptions,
    distanceZone: option.distanceZone ?? null,
    ...(option.rating ? { rating: option.rating } : {}),
    rank: option.rank,
    acceptable: effectiveStatus(request, at) === 'published',
  };
}

/** The client's view: never a shop, a supplier id, the shop's own price or a listing id. */
export function clientQuoteRequest(request, at) {
  const status = effectiveStatus(request, at);
  const shown = ['published', 'accepted', 'ordered', 'expired'].includes(status);
  return {
    id: request.id, status, version: request.version,
    productType: request.subcategoryCode, productTypeName: request.productTypeName,
    use: request.use, placement: request.placement, size: request.size, quantity: request.quantity,
    notes: request.notes || '', budgetMinor: request.budgetMinor ?? null, eventDate: request.eventDate ?? null,
    referenceFiles: (request.referenceFiles || []).map(file => ({ fileId: file.fileId, originalFilename: file.originalFilename ?? null })),
    requestFulfillment: structuredClone(request.requestFulfillment),
    ranking: [...(request.ranking || MATCH_FACTORS)],
    options: shown ? (request.options || []).map(option => publicOption(request, option, at)) : [],
    matchReason: shown ? request.matchReason ?? null : null,
    publishedAt: request.publishedAt ?? null, validUntil: request.validUntil ?? null,
    acceptedOption: request.acceptedOption ?? null, acceptedAt: request.acceptedAt ?? null,
    cartId: request.cartId ?? null, orderId: request.orderId ?? null,
    cancelledAt: request.cancelledAt ?? null, cancelledBy: request.cancelledByRole ?? null, cancelReason: request.cancelReason ?? null,
    expiredAt: request.expiredAt ?? (status === 'expired' ? request.validUntil : null),
    createdAt: request.createdAt, updatedAt: request.updatedAt,
  };
}

function shopName(store, supplierId) {
  return (store.supplierProfiles || []).find(row => row.userId === supplierId)?.shopName ?? null;
}

function opsReply(store, request, reply) {
  return {
    id: reply.id, status: reply.status, version: reply.version, supplierId: reply.supplierId, shopName: shopName(store, reply.supplierId),
    supplierServiceId: reply.supplierServiceId, priceMinor: reply.priceMinor, clientPriceMinor: reply.clientPriceMinor ?? null,
    productionTime: structuredClone(reply.productionTime), readyBy: reply.readyBy ?? null, eventDateFit: eventFit(request, reply.readyBy),
    recommendedOptions: reply.recommendedOptions || '', note: reply.note || '',
    publishedLabel: (request.options || []).find(option => option.replyId === reply.id)?.label ?? null,
    enteredBy: reply.enteredBy ?? null, createdAt: reply.createdAt, updatedAt: reply.updatedAt,
  };
}

export function opsQuoteRequest(store, request, at) {
  const client = (store.users || []).find(row => row.id === request.clientId);
  const replies = (store.quoteReplies || []).filter(reply => reply.quoteRequestId === request.id);
  return {
    ...clientQuoteRequest(request, at),
    client: { id: request.clientId, name: client?.name ?? null, email: client?.email ?? null },
    options: (request.options || []).map(option => ({ ...publicOption(request, option, at), replyId: option.replyId,
      supplierId: option.supplierId, shopName: shopName(store, option.supplierId), priceMinor: option.priceMinor, catalogItemId: option.catalogItemId })),
    replies: replies.map(reply => opsReply(store, request, reply)),
    eventDateWarning: eventDateWarning(request, replies, at),
    cancelledById: request.cancelledBy ?? null,
  };
}

/* ---------- inbox ---------- */

function notifyOps(store, request, { type, title, body, occurrenceKey }, { id, at }) {
  for (const membership of privilegedAdminMemberships(store)) {
    writeDraft(store, { userId: membership.userId, appRole: membership.role, type, title, body, read: false,
      quoteRequestId: request.id, occurrenceKey }, { id: id('ntf'), at });
  }
}

function notifyClient(store, request, { type, title, body, occurrenceKey }, { id, at }) {
  writeDraft(store, { userId: request.clientId, appRole: 'client', type, title, body, read: false,
    quoteRequestId: request.id, occurrenceKey }, { id: id('ntf'), at });
}

/* ---------- quote listings ---------- */

function quoteListingsFor(store, request) {
  return (store.catalogItems || []).filter(item => item.quoteRequestId === request.id);
}

function setListingsActive(store, request, active, at, keepIds = null) {
  for (const item of quoteListingsFor(store, request)) {
    const next = active && (!keepIds || keepIds.has(item.id));
    if ((item.active !== false) === next) continue;
    item.active = next;
    item.version = (item.version || 1) + 1;
    item.updatedAt = at;
  }
}

function resolveService(store, supplierId, subcategoryCode, requested) {
  const live = (store.supplierServices || []).filter(row => row.supplierId === supplierId && row.state === 'live');
  if (requested != null) {
    const service = live.find(row => row.id === requested);
    if (!service) fail(409, 'quote_shop_unavailable', 'Choose a live service line of that shop.', { field: 'supplierServiceId' });
    return service;
  }
  const categoryCode = (store.taxonomy?.subcategories || []).find(row => row.code === subcategoryCode)?.categoryCode;
  const service = live.find(row => row.categoryCode === categoryCode) || live[0];
  if (!service) fail(409, 'quote_shop_unavailable', 'That shop has no live service line to quote under.', { blockers: ['service_not_live'] });
  return service;
}

function assertShop(store, supplierId) {
  const profile = (store.supplierProfiles || []).find(row => row.userId === supplierId);
  if (!(store.users || []).some(row => row.id === supplierId)) fail(404, 'supplier_not_found', 'That shop does not exist.', { field: 'supplierId' });
  const blockers = supplierMatchBlockersFor(store)(supplierId, profile);
  if (blockers.length) fail(409, 'quote_shop_unavailable', 'That shop cannot take GRIDGO work right now.', { blockers });
  return profile;
}

function productionTimeFor(store, supplierId, value) {
  return productionTimeFields(record(value, 'productionTime'), shopProductionDayMinutes(store, supplierId));
}

function replyReadyBy(store, request, supplierId, fields, at) {
  try {
    return projectShopFinish(store, { supplierId, turnaroundHours: fields.turnaroundHours,
      minimumTurnaroundHours: fields.minimumTurnaroundHours, units: request.quantity, now: at }).projection.promiseBy;
  } catch (error) {
    if (error.status) return null; // A closed calendar is shown as unknown, not as a date.
    throw error;
  }
}

function listingName(request) {
  return `Custom quote: ${request.productTypeName || request.subcategoryCode}`.slice(0, 160);
}

function listingDescription(request, reply) {
  return [`${request.placement === 'outdoor' ? 'Outdoor' : 'Indoor'} ${request.use}`, `Size: ${request.size}`,
    reply.recommendedOptions ? `Recommended: ${reply.recommendedOptions}` : null].filter(Boolean).join('\n').slice(0, 2000);
}

function createQuoteListing(store, request, reply, { id, at }) {
  const fields = productionTimeFor(store, reply.supplierId, reply.productionTime);
  const service = resolveService(store, reply.supplierId, request.subcategoryCode, reply.supplierServiceId);
  const item = {
    id: id('sci'), supplierId: reply.supplierId, supplierServiceId: service.id, subcategoryCode: request.subcategoryCode,
    name: listingName(request), description: listingDescription(request, reply),
    basePriceMinor: reply.priceMinor, pricingUnit: 'whole_job', packageQty: null, measureUnit: null,
    minimumOrderQuantity: null, printerMaxWidthFeet: null, printLayouts: [], pricedByColour: false, oneColour: false,
    express: false, productionTimeReviewReasons: [], ...fields,
    fileFormatMode: 'override', active: true, sortOrder: 0, version: 1, createdAt: at, updatedAt: at,
    reviewStatus: 'approved', reviewReason: null, reviewedAt: at, reviewedBy: null, approvedSnapshot: null,
    quoteRequestId: request.id, quoteClientId: request.clientId,
  };
  (store.catalogItems ||= []).push(item);
  // Any format GRIDGO takes: the brief's files were uploaded before a shop was chosen.
  for (const format of (store.acceptedFileFormats || []).filter(row => row.active !== false)) {
    (store.catalogItemFileFormats ||= []).push({ catalogItemId: item.id, formatCode: format.code });
  }
  const view = { ...store };
  grantQuoteListings(view, request.clientId);
  const blockers = catalogItemBlockers(view, item, { publicOnly: true });
  if (blockers.length) fail(409, 'quote_shop_unavailable', 'That shop cannot take this quote right now.', { replyId: reply.id, blockers });
  let promiseBy;
  try {
    promiseBy = projectListingGroup(view, [{ catalogItemId: item.id, quantity: request.quantity, optionIds: [] }], { now: at }).projection.promiseBy;
  } catch (error) {
    if (!error.status) throw error;
    fail(409, 'quote_shop_unavailable', 'That shop has no open production calendar.', { replyId: reply.id, blockers: [error.code] });
  }
  return { item, promiseBy, productionTime: structuredClone(reply.productionTime) };
}

/* ---------- checkout hooks (src/order-match-routes.js) ---------- */

/** Only the accepted, unexpired option of the caller's own quote checks out, from its own cart. */
export function assertQuoteCheckout(store, item, { user, cart, at }) {
  const request = (store.quoteRequests || []).find(row => row.id === item.quoteRequestId);
  if (!request || request.clientId !== user.id) fail(409, 'catalog_item_stale', 'This quote is no longer available.');
  if (effectiveStatus(request, at) === 'expired') {
    fail(409, 'quote_expired', 'This quote has expired. Ask GRIDGO to renew it or request a new quote.', { quoteRequestId: request.id });
  }
  const option = (request.options || []).find(row => row.label === request.acceptedOption);
  if (request.status !== 'accepted' || request.cartId !== cart.id || option?.catalogItemId !== item.id) {
    fail(409, 'quote_not_accepted', 'Accept this quote option before checkout.', { quoteRequestId: request.id });
  }
}

export function markQuoteOrdered(store, item, order, { user, at, createId }) {
  const request = (store.quoteRequests || []).find(row => row.id === item.quoteRequestId);
  if (!request || request.status !== 'accepted') return;
  Object.assign(request, { status: 'ordered', orderId: order.id, orderedAt: at, version: request.version + 1, updatedAt: at });
  (store.auditLog ||= []).push({ id: createId('aud'), at, actorId: user.id, actorRole: 'client', action: 'quote_request.ordered',
    entityType: 'quote_request', entityId: request.id, orderId: order.id, detail: { option: request.acceptedOption, catalogItemId: item.id } });
}

/* ---------- expiry ---------- */

function expire(store, request, { at, id, audit }) {
  const from = request.status;
  Object.assign(request, { status: 'expired', expiredAt: request.validUntil, expiredFrom: from, version: request.version + 1, updatedAt: at });
  setListingsActive(store, request, false, at);
  audit(store, { actor: { role: 'system' }, action: 'quote_request.expire', entityType: 'quote_request', entityId: request.id,
    detail: { from, validUntil: request.validUntil } });
  notifyClient(store, request, { type: 'quote_expired', title: 'Quote options expired',
    body: 'Your quote options are no longer valid. Request a new quote or ask GRIDGO to renew it.', occurrenceKey: request.validUntil }, { id, at });
  notifyOps(store, request, { type: 'ops_quote_expired', title: 'Quote expired',
    body: 'A quote passed its validity without an order.', occurrenceKey: request.validUntil }, { id, at });
}

/** Lifecycle sweep; the caller probes `quote_requests_due_idx` before loading the graph. */
export function expireQuoteRequests(store, { at, id, audit }) {
  let changed = false;
  for (const request of store.quoteRequests || []) {
    if (LISTED.has(request.status) && effectiveStatus(request, at) === 'expired') { expire(store, request, { at, id, audit }); changed = true; }
  }
  return changed;
}

/* ---------- routes ---------- */

const CLIENT_PATH = /^\/me\/quote-requests(?:\/([^/]+)(?:\/(accept|cancel))?)?$/;
const OPS_PATH = /^\/ops\/quote-requests(?:\/([^/]+)(?:\/(replies(?:\/([^/]+))?|publish|validity|cancel))?)?$/;
export const isQuoteRequestPath = (pathname) => CLIENT_PATH.test(pathname) || OPS_PATH.test(pathname);
/** GET paths served from the targeted read graph (src/postgres-store.js). */
export const isQuoteRequestReadPath = (pathname) => /^\/me\/quote-requests(?:\/[^/]+)?$/.test(pathname) || /^\/ops\/quote-requests(?:\/[^/]+)?$/.test(pathname);

function findRequest(store, requestId) {
  const request = (store.quoteRequests || []).find(row => row.id === requestId);
  if (!request) fail(404, 'quote_request_not_found', 'That quote request no longer exists.');
  return request;
}

function bump(request, at) {
  request.version += 1;
  request.updatedAt = at;
}

export async function routeQuoteRequests({ req, url, store, user, readBody, now, id, audit }) {
  const { pathname } = url;
  const client = CLIENT_PATH.exec(pathname);
  const ops = client ? null : OPS_PATH.exec(pathname);
  if (!client && !ops) return null;
  if (!user) fail(401, 'unauthorized', 'Sign in to continue.');
  const at = now();
  if (client) {
    if (!isClient(user)) fail(403, 'membership_required', 'A GRIDGO client membership is required.', { requiredRole: 'client' });
    return routeClient({ req, store, user, readBody, at, id, audit, requestId: client[1] && decodeURIComponent(client[1]), action: client[2] });
  }
  if (!isOps(user)) fail(403, 'forbidden', 'Operations access is required.');
  return routeOps({ req, url, store, user, readBody, at, id, audit, requestId: ops[1] && decodeURIComponent(ops[1]),
    action: ops[2]?.split('/')[0], replyId: ops[3] && decodeURIComponent(ops[3]) });
}

function ownRequest(store, user, requestId) {
  const request = findRequest(store, requestId);
  if (request.clientId !== user.id) fail(403, 'forbidden', 'That quote request belongs to another client.');
  return request;
}

async function routeClient({ req, store, user, readBody, at, id, audit, requestId, action }) {
  if (!requestId) {
    if (req.method === 'GET') {
      const rows = (store.quoteRequests || []).filter(row => row.clientId === user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return { status: 200, body: { quoteRequests: rows.map(row => clientQuoteRequest(row, at)) } };
    }
    if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Use GET or POST.');
    return createRequest({ store, user, body: record(await readBody(req)), at, id, audit });
  }
  const request = ownRequest(store, user, requestId);
  if (!action) {
    if (req.method !== 'GET') fail(405, 'method_not_allowed', 'Use GET.');
    return { status: 200, body: { quoteRequest: clientQuoteRequest(request, at) } };
  }
  if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Use POST.');
  const body = record(await readBody(req) ?? {});
  expectVersion(body, request);
  if (action === 'cancel') return cancelRequest({ store, user, request, body, at, id, audit, byClient: true });
  return acceptOption({ store, user, request, body, at, id, audit });
}

function createRequest({ store, user, body, at, id, audit }) {
  const subcategoryCode = text(body.productType, 'productType', 120);
  const subcategory = (store.taxonomy?.subcategories || []).find(row => row.code === subcategoryCode && row.active !== false);
  if (!QUOTE_PRODUCT_TYPES.includes(subcategoryCode) || !subcategory) {
    fail(400, 'invalid_quote_product_type', 'Choose custom signage or 3D printing.', { field: 'productType', allowed: QUOTE_PRODUCT_TYPES });
  }
  if (!['indoor', 'outdoor'].includes(body.placement)) fail(400, 'invalid_quote_request', 'placement must be indoor or outdoor.', { field: 'placement' });
  if (!Number.isSafeInteger(body.quantity) || body.quantity < 1 || body.quantity > 100_000) {
    fail(400, 'invalid_quote_request', 'quantity must be a whole number from 1 to 100,000.', { field: 'quantity' });
  }
  const fileIds = body.referenceFileIds;
  if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 10 || new Set(fileIds).size !== fileIds.length) {
    fail(400, 'reference_files_required', 'Upload one to ten artwork or reference files first.', { field: 'referenceFileIds' });
  }
  const referenceFiles = fileIds.map(fileId => {
    const file = (store.files || []).find(row => row.fileId === fileId);
    if (!file || file.ownerId !== user.id || file.state !== 'ready' || file.purpose !== 'artwork' || !file.objectKey) {
      fail(409, 'file_not_ready', 'Choose your own ready artwork or reference file.', { field: 'referenceFileIds', fileId });
    }
    return { fileId, originalFilename: file.originalFilename ?? null };
  });
  const ranking = body.ranking == null
    ? [...((store.clientPreferences || []).find(row => row.userId === user.id)?.ranking || MATCH_FACTORS)]
    : validatePreferenceRanking(body.ranking);
  const request = {
    id: id('qreq'), clientId: user.id, status: 'requested', version: 1,
    subcategoryCode, productTypeName: subcategory.name,
    use: text(body.use, 'use', 500), placement: body.placement, size: text(body.size, 'size', 200), quantity: body.quantity,
    notes: quoteNotes(body.notes),
    budgetMinor: body.budgetMinor == null ? null : minorAmount(body.budgetMinor, 'budgetMinor'),
    eventDate: eventDate(body.eventDate, at), referenceFiles,
    requestFulfillment: quoteRequestFulfillment(store, user, body), ranking: ranking.length === 4 ? ranking : [...ranking, ...MATCH_FACTORS.filter(f => !ranking.includes(f))],
    options: [], validUntil: null, createdAt: at, updatedAt: at,
  };
  (store.quoteRequests ||= []).push(request);
  for (const { fileId } of referenceFiles) {
    const file = store.files.find(row => row.fileId === fileId);
    file.references ||= [];
    if (!file.references.some(row => row.type === 'quote_request' && row.id === request.id)) file.references.push({ type: 'quote_request', id: request.id, field: 'reference' });
  }
  audit(store, { actor: user, action: 'quote_request.create', entityType: 'quote_request', entityId: request.id,
    detail: { productType: subcategoryCode, quantity: request.quantity, eventDate: request.eventDate, budgetMinor: request.budgetMinor,
      referenceFileIds: fileIds, fulfillmentMode: request.requestFulfillment.fulfillmentMode } });
  notifyOps(store, request, { type: 'ops_quote_requested', title: 'New quote request',
    body: `A client asked for a ${subcategory.name} quote. Gather shop replies in Quotes.` }, { id, at });
  return { status: 201, body: { quoteRequest: clientQuoteRequest(request, at) }, mutated: true };
}

function cancelRequest({ store, user, request, body, at, id, audit, byClient }) {
  if (!OPEN.has(effectiveStatus(request, at)) && effectiveStatus(request, at) !== 'expired') {
    fail(409, 'quote_request_closed', 'This quote request is already closed.', { status: effectiveStatus(request, at) });
  }
  const reason = byClient ? text(body.reason, 'reason', 500, { required: false }) : text(body.reason, 'reason', 500);
  const from = request.status;
  Object.assign(request, { status: 'cancelled', cancelledAt: at, cancelledBy: user.id, cancelledByRole: byClient ? 'client' : 'operations', cancelReason: reason || null });
  bump(request, at);
  setListingsActive(store, request, false, at);
  audit(store, { actor: user, action: 'quote_request.cancel', entityType: 'quote_request', entityId: request.id, detail: { from, by: byClient ? 'client' : 'operations' }, reason: reason || null });
  notifyOps(store, request, { type: 'ops_quote_cancelled', title: 'Quote request cancelled',
    body: byClient ? 'The client cancelled a quote request.' : 'Operations cancelled a quote request.', occurrenceKey: at }, { id, at });
  if (!byClient) notifyClient(store, request, { type: 'quote_cancelled', title: 'Quote request closed',
    body: reason ? `GRIDGO closed your quote request: ${reason}` : 'GRIDGO closed your quote request.', occurrenceKey: at }, { id, at });
  return { status: 200, body: { quoteRequest: byClient ? clientQuoteRequest(request, at) : opsQuoteRequest(store, request, at) }, mutated: true };
}

function acceptOption({ store, user, request, body, at, id, audit }) {
  if (LISTED.has(request.status) && effectiveStatus(request, at) === 'expired') {
    expire(store, request, { at, id, audit });
    return { status: 410, body: { error: 'quote_expired', message: 'These quote options have expired. Request a new quote or ask GRIDGO to renew it.',
      quoteRequest: clientQuoteRequest(request, at) }, mutated: true };
  }
  if (request.status === 'expired') fail(410, 'quote_expired', 'These quote options have expired.');
  if (request.status !== 'published') {
    fail(409, request.status === 'accepted' || request.status === 'ordered' ? 'quote_already_accepted' : 'quote_not_published',
      'This quote has no options to accept.', { status: request.status });
  }
  const option = (request.options || []).find(row => row.label === body.option);
  if (!option) fail(400, 'invalid_quote_option', 'Choose option A, B or C from this quote.', { field: 'option', allowed: request.options.map(row => row.label) });
  const item = (store.catalogItems || []).find(row => row.id === option.catalogItemId);
  const view = { ...store };
  grantQuoteListings(view, user.id);
  if (!item || catalogItemBlockers(view, item, { publicOnly: true }).length) {
    fail(409, 'quote_option_unavailable', 'That shop can no longer take this job. Choose another option or ask GRIDGO for a new quote.', { option: option.label });
  }
  const cart = openQuoteCart(store, user, {
    item, quantity: request.quantity, requestFulfillment: request.requestFulfillment,
    artworkFileIds: (request.referenceFiles || []).map(file => file.fileId),
    structuredSpec: { quoteRequestId: request.id, quoteOption: option.label, use: request.use, placement: request.placement, size: request.size,
      ...(option.recommendedOptions ? { recommendedOptions: option.recommendedOptions } : {}) },
    // The brief's notes are the line's special instructions, under the cart's own 300-character rule.
    specialInstructions: request.notes || '',
  }, { id, at });
  Object.assign(request, { status: 'accepted', acceptedOption: option.label, acceptedAt: at, cartId: cart.id });
  bump(request, at);
  // The other options stop pricing anywhere once one is chosen.
  setListingsActive(store, request, true, at, new Set([option.catalogItemId]));
  audit(store, { actor: user, action: 'quote_request.accept', entityType: 'quote_request', entityId: request.id,
    detail: { option: option.label, catalogItemId: option.catalogItemId, cartId: cart.id, clientPriceMinor: option.clientPriceMinor, priceMinor: option.priceMinor } });
  notifyOps(store, request, { type: 'ops_quote_accepted', title: 'Quote accepted',
    body: `The client chose option ${option.label}. Checkout continues in their cart.`, occurrenceKey: at }, { id, at });
  return { status: 201, body: { quoteRequest: clientQuoteRequest(request, at), cart }, mutated: true };
}

/* ---------- Operations ---------- */

async function routeOps({ req, url, store, user, readBody, at, id, audit, requestId, action, replyId }) {
  if (!requestId) {
    if (req.method !== 'GET') fail(405, 'method_not_allowed', 'Use GET.');
    const status = url.searchParams.get('status');
    if (status != null && !['open', 'requested', 'quoting', 'published', 'accepted', 'ordered', 'expired', 'cancelled'].includes(status)) {
      fail(400, 'invalid_quote_status', 'Choose a quote status.');
    }
    const rows = (store.quoteRequests || [])
      .filter(row => !status || (status === 'open' ? OPEN.has(effectiveStatus(row, at)) : effectiveStatus(row, at) === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 200);
    return { status: 200, body: { quoteRequests: rows.map(row => opsQuoteRequest(store, row, at)) } };
  }
  const request = findRequest(store, requestId);
  if (!action) {
    if (req.method !== 'GET') fail(405, 'method_not_allowed', 'Use GET.');
    return { status: 200, body: { quoteRequest: opsQuoteRequest(store, request, at) } };
  }
  const allowed = action === 'replies' && replyId ? 'PATCH' : action === 'validity' ? 'PUT' : 'POST';
  if (req.method !== allowed) fail(405, 'method_not_allowed', `Use ${allowed}.`);
  const body = record(await readBody(req) ?? {});
  expectVersion(body, request);
  if (action === 'cancel') return cancelRequest({ store, user, request, body, at, id, audit, byClient: false });
  if (action === 'replies') return replyId ? editReply({ store, user, request, replyId, body, at, audit }) : addReply({ store, user, request, body, at, id, audit });
  if (action === 'publish') return publish({ store, user, request, body, at, id, audit });
  return setValidity({ store, user, request, body, at, id, audit });
}

function assertQuoting(request, at) {
  const status = effectiveStatus(request, at);
  if (!['requested', 'quoting', 'published', 'expired'].includes(status)) {
    fail(409, 'quote_request_closed', 'Replies can only change before the client accepts.', { status });
  }
}

function addReply({ store, user, request, body, at, id, audit }) {
  assertQuoting(request, at);
  const supplierId = text(body.supplierId, 'supplierId', 120);
  assertShop(store, supplierId);
  const service = resolveService(store, supplierId, request.subcategoryCode, body.supplierServiceId ?? null);
  const fields = productionTimeFor(store, supplierId, body.productionTime);
  const priceMinor = minorAmount(body.priceMinor, 'priceMinor', { positive: true });
  const reply = {
    id: id('qrep'), quoteRequestId: request.id, supplierId, supplierServiceId: service.id, status: 'active', version: 1,
    priceMinor, clientPriceMinor: clientPriceMinor(store, request, priceMinor, at), productionTime: structuredClone(body.productionTime),
    readyBy: replyReadyBy(store, request, supplierId, fields, at),
    recommendedOptions: text(body.recommendedOptions, 'recommendedOptions', 1000, { required: false }),
    note: text(body.note, 'note', 1000, { required: false }), enteredBy: user.id, createdAt: at, updatedAt: at,
  };
  (store.quoteReplies ||= []).push(reply);
  if (request.status === 'requested') request.status = 'quoting';
  bump(request, at);
  audit(store, { actor: user, action: 'quote_request.reply', entityType: 'quote_request', entityId: request.id,
    detail: { replyId: reply.id, supplierId, priceMinor, productionTime: reply.productionTime } });
  return { status: 201, body: { quoteRequest: opsQuoteRequest(store, request, at), reply: opsReply(store, request, reply) }, mutated: true };
}

function editReply({ store, user, request, replyId, body, at, audit }) {
  assertQuoting(request, at);
  const reply = (store.quoteReplies || []).find(row => row.id === replyId && row.quoteRequestId === request.id);
  if (!reply) fail(404, 'quote_reply_not_found', 'That shop reply no longer exists.');
  if (body.expectedReplyVersion != null && body.expectedReplyVersion !== reply.version) {
    fail(409, 'quote_reply_version_conflict', 'This reply changed. Refresh it and try again.', { version: reply.version });
  }
  const before = { priceMinor: reply.priceMinor, productionTime: structuredClone(reply.productionTime), status: reply.status };
  if (Object.hasOwn(body, 'priceMinor')) reply.priceMinor = minorAmount(body.priceMinor, 'priceMinor', { positive: true });
  if (Object.hasOwn(body, 'productionTime')) {
    productionTimeFor(store, reply.supplierId, body.productionTime);
    reply.productionTime = structuredClone(body.productionTime);
  }
  if (Object.hasOwn(body, 'recommendedOptions')) reply.recommendedOptions = text(body.recommendedOptions, 'recommendedOptions', 1000, { required: false });
  if (Object.hasOwn(body, 'note')) reply.note = text(body.note, 'note', 1000, { required: false });
  if (Object.hasOwn(body, 'withdrawn')) {
    if (typeof body.withdrawn !== 'boolean') fail(400, 'invalid_quote_request', 'withdrawn must be true or false.', { field: 'withdrawn' });
    reply.status = body.withdrawn ? 'withdrawn' : 'active';
  }
  reply.clientPriceMinor = clientPriceMinor(store, request, reply.priceMinor, at);
  reply.readyBy = replyReadyBy(store, request, reply.supplierId, productionTimeFor(store, reply.supplierId, reply.productionTime), at);
  reply.version += 1;
  reply.updatedAt = at;
  bump(request, at);
  audit(store, { actor: user, action: 'quote_request.reply_update', entityType: 'quote_request', entityId: request.id,
    detail: { replyId, before, after: { priceMinor: reply.priceMinor, productionTime: reply.productionTime, status: reply.status } } });
  // A published option keeps the price the client was shown until Operations publishes again.
  return { status: 200, body: { quoteRequest: opsQuoteRequest(store, request, at), reply: opsReply(store, request, reply) }, mutated: true };
}

function publish({ store, user, request, body, at, id, audit }) {
  const status = effectiveStatus(request, at);
  if (!['quoting', 'published', 'expired'].includes(status)) {
    fail(409, status === 'requested' ? 'quote_replies_required' : 'quote_request_closed', 'Record shop replies before publishing.', { status });
  }
  const replyIds = body.replyIds;
  if (!Array.isArray(replyIds) || !replyIds.length || replyIds.length > MAX_QUOTE_OPTIONS || new Set(replyIds).size !== replyIds.length) {
    fail(400, 'invalid_quote_options', 'Choose one to three different shop replies to publish.', { field: 'replyIds', max: MAX_QUOTE_OPTIONS });
  }
  const replies = replyIds.map(replyId => {
    const reply = (store.quoteReplies || []).find(row => row.id === replyId && row.quoteRequestId === request.id);
    if (!reply || reply.status !== 'active') fail(409, 'quote_reply_not_found', 'Publish only active replies of this request.', { replyId });
    return reply;
  });
  if (new Set(replies.map(reply => reply.supplierId)).size !== replies.length) {
    fail(400, 'invalid_quote_options', 'Publish at most one option per shop.', { field: 'replyIds' });
  }
  assertShopsOpen(store, replies);
  const previous = new Set(quoteListingsFor(store, request).map(item => item.id));
  const built = replies.map(reply => ({ reply, ...createQuoteListing(store, request, reply, { id, at }) }));
  const dropoff = request.requestFulfillment?.dropoff;
  const choices = built.map(({ reply, item, promiseBy, productionTime }) => {
    const shop = (store.supplierProfiles || []).find(row => row.userId === reply.supplierId)?.shop;
    const distance = shop && dropoff ? distanceMetersBetween(shop, dropoff) : null;
    return { id: reply.id, supplierId: reply.supplierId, cost: clientPriceMinor(store, request, reply.priceMinor, at), promiseBy,
      distanceZone: distance == null ? null : distanceZoneForDistance(distance, store.settings), item, reply, productionTime };
  });
  const { rows, matchReason } = rankQuoteChoices(store, choices, request.ranking || MATCH_FACTORS, at);
  request.options = rows.map((row, index) => ({
    label: LABELS[index], rank: index + 1, replyId: row.reply.id, supplierId: row.supplierId, catalogItemId: row.item.id,
    priceMinor: row.reply.priceMinor, clientPriceMinor: row.cost, productionTime: row.productionTime,
    readyBy: row.promiseBy, eventDateFit: eventFit(request, row.promiseBy), recommendedOptions: row.reply.recommendedOptions || '',
    distanceZone: row.distanceZone, rating: publicShopRating(store, row.supplierId),
  }));
  request.matchReason = matchReason;
  for (const item of quoteListingsFor(store, request)) {
    if (!previous.has(item.id)) continue;
    // A republished request's earlier options stop pricing.
    if (item.active !== false) { item.active = false; item.version += 1; item.updatedAt = at; }
  }
  const days = quoteValidityDays(store.settings);
  Object.assign(request, { status: 'published', publishedAt: at, publishedBy: user.id, validUntil: new Date(Date.parse(at) + days * DAY_MS).toISOString(),
    expiredAt: null, expiredFrom: null, acceptedOption: null, acceptedAt: null, cartId: null });
  bump(request, at);
  audit(store, { actor: user, action: 'quote_request.publish', entityType: 'quote_request', entityId: request.id,
    detail: { validUntil: request.validUntil, validityDays: days, ranking: request.ranking, matchReason: matchReason?.key,
      options: request.options.map(option => ({ label: option.label, replyId: option.replyId, supplierId: option.supplierId,
        catalogItemId: option.catalogItemId, priceMinor: option.priceMinor, clientPriceMinor: option.clientPriceMinor })) } });
  notifyClient(store, request, { type: 'quote_options_ready', title: 'Your quote options are ready',
    body: `Compare ${request.options.length === 1 ? 'your option' : `${request.options.length} options`} and accept one before ${manilaDay(request.validUntil)}.`, occurrenceKey: at }, { id, at });
  notifyOps(store, request, { type: 'ops_quote_published', title: 'Quote options published',
    body: `${request.options.length} option${request.options.length === 1 ? '' : 's'} sent to the client.`, occurrenceKey: at }, { id, at });
  return { status: 200, body: { quoteRequest: opsQuoteRequest(store, request, at) }, mutated: true };
}

function assertShopsOpen(store, replies) {
  for (const reply of replies) {
    try { assertShop(store, reply.supplierId); } catch (error) { error.details = { ...error.details, replyId: reply.id }; throw error; }
  }
}

function setValidity({ store, user, request, body, at, id, audit }) {
  const status = effectiveStatus(request, at);
  if (!['published', 'accepted', 'expired'].includes(status) || (status === 'expired' && !request.options?.length)) {
    fail(409, 'quote_request_closed', 'Only published quotes have a validity to change.', { status });
  }
  if (typeof body.validUntil !== 'string' || !Number.isFinite(Date.parse(body.validUntil)) || Date.parse(body.validUntil) <= Date.parse(at)
      || Date.parse(body.validUntil) - Date.parse(at) > 90 * DAY_MS) {
    fail(400, 'invalid_quote_validity', 'validUntil must be a future date-time at most 90 days away.', { field: 'validUntil' });
  }
  const reason = text(body.reason, 'reason', 500);
  if (request.status === 'expired') {
    // Renewal brings back what lapsed: the open options, or the client's accepted cart.
    request.status = request.expiredFrom === 'accepted' ? 'accepted' : 'published';
    const accepted = request.status === 'accepted' ? (request.options || []).find(row => row.label === request.acceptedOption) : null;
    const keep = new Set(accepted ? [accepted.catalogItemId] : (request.options || []).map(row => row.catalogItemId));
    setListingsActive(store, request, true, at, keep);
    request.expiredAt = null;
  }
  const previous = request.validUntil;
  request.validUntil = new Date(body.validUntil).toISOString();
  bump(request, at);
  audit(store, { actor: user, action: 'quote_request.validity_update', entityType: 'quote_request', entityId: request.id,
    detail: { previous, validUntil: request.validUntil, status: request.status }, reason });
  notifyClient(store, request, { type: 'quote_validity_changed', title: 'Quote validity updated',
    body: `Your quote options are now valid until ${manilaDay(request.validUntil)}.`, occurrenceKey: `${at}:${request.validUntil}` }, { id, at });
  return { status: 200, body: { quoteRequest: opsQuoteRequest(store, request, at) }, mutated: true };
}
