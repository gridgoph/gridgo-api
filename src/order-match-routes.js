import {
  identityHasMembership } from "./authorization-context.js";
import { gridgoOfficePoint } from "./gridgo-office.js";
import {
  catalogItemBlockers,
  createOrderLineSnapshot,
  minimumCatalogPrice,
  publicCatalogItem,
  publicSupplierShop,
  selectedCatalogPrice,
} from "./supplier-catalog.js";
import {
  deliveryFeeForDistance,
  distanceMetersBetween,
  roundBps,
} from "./operational-model.js";
import { defaultShopSchedule, projectFinish } from "./availability.js";
import {
  MatchError,
  matchShop,
  multiplyMinor,
  validatePreferenceRanking,
} from "./order-match.js";

const DEFAULT_RANKING = Object.freeze(["quality", "speed", "cost", "distance"]);

/**
 * A ranking saved before cost existed is three factors long and can no longer
 * be matched on. Carry the order the client chose and append whatever is
 * missing, rather than throwing away a choice they made deliberately.
 */
function completeRanking(stored) {
  const kept = Array.isArray(stored) ? stored.filter((factor) => DEFAULT_RANKING.includes(factor)) : [];
  const ordered = [...new Set(kept)];
  for (const factor of DEFAULT_RANKING) {
    if (!ordered.includes(factor)) ordered.push(factor);
  }
  return ordered;
}
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function fail(status, code, message, details = {}) {
  throw new MatchError(status, code, message, details);
}

function requireClient(user) {
  if (!user || !identityHasMembership(user, "client")) {
    fail(403, "membership_required", "A GRIDGO client membership is required.", { requiredRole: "client" });
  }
}

function record(value, field = "body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "invalid_request", `${field} must be a JSON object.`, { field });
  }
  return value;
}

function text(value, field, maxLength = 240) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail(400, "invalid_request", `${field} must be a nonblank string of at most ${maxLength} characters.`, { field });
  }
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(400, "invalid_request", `${field} must be a positive integer.`, { field });
  }
  return value;
}

function point(value, field, { required = true, requireLabel = true } = {}) {
  if (value == null && !required) return null;
  record(value, field);
  if (typeof value.lat !== "number" || !Number.isFinite(value.lat) || value.lat < -90 || value.lat > 90
      || typeof value.lng !== "number" || !Number.isFinite(value.lng) || value.lng < -180 || value.lng > 180) {
    fail(400, "invalid_location", `${field} must include valid numeric lat and lng.`, { field });
  }
  const resolved = { lat: value.lat, lng: value.lng };
  if (requireLabel) resolved.label = text(value.label, `${field}.label`);
  else if (typeof value.label === "string" && value.label.trim()) resolved.label = value.label.trim();
  return resolved;
}

function addMinor(values, field) {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) fail(400, "invalid_money", `${field} contains invalid minor-unit money.`, { field });
    total += BigInt(value);
    if (total > MAX_SAFE_MINOR) fail(400, "invalid_money", `${field} exceeds the supported safe-integer range.`, { field });
  }
  return Number(total);
}

function preferenceFor(store, userId) {
  return (store.clientPreferences || []).find((row) => row.userId === userId) || null;
}

/**
 * What the client is allowed to see of a match.
 *
 * The shop's own date never crosses this line. A client who can see both dates
 * can see the allowance, and an allowance that is visible is an allowance that
 * gets argued about -- so the padded promise is the only date they are given.
 */
function clientFacingMatch(match) {
  const { shopReadyBy: _shopReadyBy, ...clientFacing } = match;
  return clientFacing;
}

function publicPreference(store, userId) {
  const stored = preferenceFor(store, userId);
  return {
    ranking: completeRanking(stored?.ranking),
    version: stored?.version || 0,
    updatedAt: stored?.updatedAt || null,
  };
}

function publicAddress(address) {
  return {
    id: address.id,
    label: address.label,
    addressLine: address.addressLine,
    point: { ...address.point },
    isDefault: Boolean(address.isDefault),
    version: address.version,
    createdAt: address.createdAt,
    updatedAt: address.updatedAt,
  };
}

function ownCart(store, user, cartId, { draft = false } = {}) {
  const cart = (store.carts || []).find((row) => row.id === cartId);
  if (!cart) fail(404, "cart_not_found", "That cart no longer exists.");
  if (cart.clientId !== user.id) fail(403, "forbidden", "That cart belongs to another client.");
  if (draft && cart.state !== "draft") fail(409, "cart_checked_out", "That cart has already been checked out.");
  return cart;
}

function fileFor(store, user, fileId, purpose, field) {
  const file = (store.files || []).find((row) => row.fileId === fileId);
  if (!file || file.ownerId !== user.id || file.state !== "ready" || file.purpose !== purpose || !file.objectKey) {
    fail(409, "file_not_ready", `Choose your own ready ${purpose} file.`, { field });
  }
  return file;
}

function publicCartListingStub(store, item, optionIds) {
  const selected = selectedCatalogPrice(store, item, optionIds);
  return {
    id: item.id,
    name: item.name,
    supplierId: item.supplierId,
    fromPriceMinor: minimumCatalogPrice(store, item),
    effectivePriceMinor: selected.effectiveUnitPriceMinor,
    selectedOptions: selected.selectedOptions.map((option) => ({ id: option.id, label: option.label })),
  };
}

function cartShops(store, lines) {
  const supplierIds = [...new Set(lines.map((line) => line.supplierId))];
  return supplierIds.flatMap((supplierId) => {
    const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
    if (!profile?.shop) return [];
    return [{
      supplierId,
      shopName: profile.shopName,
      shop: { ...profile.shop },
    }];
  });
}

function publicCartForLineMutation(store, cart) {
  return publicCart(store, cart, { compactListings: true });
}

function publicCart(store, cart, { compactListings = false } = {}) {
  const lines = (store.cartLines || [])
    .filter((line) => line.cartId === cart.id)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const publicLines = lines.map((line) => {
    const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
    const listing = item
      ? (compactListings
        ? publicCartListingStub(store, item, line.optionIds || [])
        : publicCatalogItem(store, item, { selectedOptionIds: line.optionIds || [] }))
      : null;
    return {
      id: line.id,
      supplierId: line.supplierId,
      catalogItemId: line.catalogItemId,
      quantity: line.quantity,
      optionIds: [...(line.optionIds || [])],
      structuredSpec: structuredClone(line.structuredSpec || {}),
      artworkFileId: line.artworkFileId ?? null,
      mockupFileId: line.mockupFileId ?? null,
      dropoff: line.dropoff ? { ...line.dropoff } : null,
      sortOrder: line.sortOrder,
      listing,
      lineSubtotalMinor: listing ? multiplyMinor(listing.effectivePriceMinor, line.quantity, "lineSubtotalMinor") : null,
    };
  });
  return {
    id: cart.id,
    state: cart.state,
    version: cart.version,
    serviceLevel: cart.serviceLevel,
    scheduledFor: cart.scheduledFor ?? null,
    fulfillmentMode: cart.fulfillmentMode,
    defaultDropoff: cart.defaultDropoff ? { ...cart.defaultDropoff } : null,
    lines: publicLines,
    shops: cartShops(store, lines),
    checkedOutOrderId: cart.checkedOutOrderId ?? null,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
  };
}

function updateCart(cart, at) {
  cart.version = (cart.version || 1) + 1;
  cart.updatedAt = at;
}

function fulfillmentInput(body, current) {
  const fulfillmentMode = body.fulfillmentMode == null ? current.fulfillmentMode : String(body.fulfillmentMode);
  if (!["delivery", "pickup"].includes(fulfillmentMode)) {
    fail(400, "invalid_fulfillment_mode", "fulfillmentMode must be delivery or pickup.", { field: "fulfillmentMode" });
  }
  const serviceLevel = body.serviceLevel == null ? current.serviceLevel : String(body.serviceLevel);
  if (!["standard", "scheduled"].includes(serviceLevel)) {
    fail(400, "invalid_service_level", "serviceLevel must be standard or scheduled.", { field: "serviceLevel" });
  }
  let scheduledFor = current.scheduledFor ?? null;
  if (serviceLevel === "standard") scheduledFor = null;
  else if (Object.hasOwn(body, "scheduledFor")) {
    const parsed = new Date(body.scheduledFor);
    if (Number.isNaN(parsed.getTime())) fail(400, "invalid_schedule", "scheduledFor must be an ISO date-time.", { field: "scheduledFor" });
    scheduledFor = parsed.toISOString();
  }
  if (serviceLevel === "scheduled" && !scheduledFor) {
    fail(400, "invalid_schedule", "scheduledFor is required for Scheduled service.", { field: "scheduledFor" });
  }
  let defaultDropoff = current.defaultDropoff ?? null;
  if (Object.hasOwn(body, "defaultDropoff")) defaultDropoff = point(body.defaultDropoff, "defaultDropoff", { required: false });
  if (fulfillmentMode === "pickup") defaultDropoff = null;
  return { fulfillmentMode, serviceLevel, scheduledFor, defaultDropoff };
}

function addressPoint(store, userId, body) {
  if (body.addressId != null) {
    const address = (store.clientAddresses || []).find((row) => row.id === String(body.addressId));
    if (!address) fail(404, "address_not_found", "That saved address no longer exists.");
    if (address.clientId !== userId) fail(403, "forbidden", "That saved address belongs to another client.");
    return { ...address.point, label: address.addressLine };
  }
  return body.dropoff == null ? null : point(body.dropoff, "dropoff");
}

function preferredSupplierForCart(store, user, cartId) {
  if (cartId == null) return null;
  const cart = ownCart(store, user, String(cartId));
  return (store.cartLines || [])
    .filter((line) => line.cartId === cart.id)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))[0]?.supplierId || null;
}

function attachOrderFile(file, orderId, field) {
  file.references ||= [];
  if (!file.references.some((row) => row.type === "order" && row.id === orderId && row.field === field)) {
    file.references.push({ type: "order", id: orderId, field });
  }
}

function publicMatchedOrder(store, order) {
  const jobs = (store.orderJobs || [])
    .filter((job) => job.orderId === order.id)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((job) => ({
      id: job.id,
      shop: publicSupplierShop(store, job.supplierId),
      state: job.state,
      fulfillmentMode: job.fulfillmentMode,
      // Client-facing: a collected job is collected at GRIDGO's own counter,
      // never at the shop that ran it, and a delivered one gives the client no
      // origin at all. The stored `job.pickup` is unchanged — that is where the
      // rider really goes. See src/gridgo-office.js.
      ...(job.fulfillmentMode === "pickup" ? { pickup: gridgoOfficePoint() } : { pickup: null }),
      dropoff: job.dropoff ? { ...job.dropoff } : null,
      deliveryDistanceMeters: job.deliveryDistanceMeters,
      deliveryFeeMinor: job.deliveryFeeMinor,
      estimatedHours: job.estimatedHours,
      scheduledFor: job.scheduledFor ?? null,
    }));
  return {
    id: order.id,
    state: order.state,
    itemSubtotalMinor: order.supplierSubtotalMinor,
    serviceFeeRateBps: order.serviceFeeRateBps,
    serviceFeeMinor: order.serviceFeeMinor,
    deliveryFeeMinor: order.deliveryFeeMinor,
    totalMinor: order.totalMinor,
    fulfillmentMode: order.fulfillmentMode,
    serviceLevel: order.serviceLevel,
    scheduledFor: order.scheduledFor ?? null,
    // The promised date, never the shop's own. A client who can see both can
    // see the allowance.
    readyBy: order.promiseBy ?? null,
    paymentPlan: {
      method: "qr_manual",
      downpaymentMinor: order.payments.initial.amountMinor,
      balanceMinor: order.payments.final_online.amountMinor,
      downpaymentStatus: order.payments.initial.status,
    },
    jobs,
    invoiceNumber: order.invoiceNumber,
    createdAt: order.createdAt,
  };
}

function invoiceNumber(orderId, at) {
  const stamp = String(at).slice(0, 10).replaceAll("-", "");
  return `GG-${stamp}-${orderId.replace(/^ord_/, "").toUpperCase()}`;
}

function checkout(store, user, cart, body, createId, at) {
  const payment = record(body.payment, "payment");
  if (payment.method !== "qr_manual") {
    fail(400, "payment_method_not_allowed", "Checkout accepts QR Ph manual payment only.", { allowed: ["qr_manual"] });
  }
  const reference = text(payment.reference, "payment.reference", 100);
  const proof = fileFor(store, user, text(payment.proofFileId, "payment.proofFileId", 120), "payment_proof", "payment.proofFileId");
  const cartLines = (store.cartLines || [])
    .filter((line) => line.cartId === cart.id)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  if (cartLines.length === 0) fail(409, "cart_empty", "Add at least one listing before checkout.");
  const orderId = createId("ord");
  const order = {
    id: orderId,
    clientId: user.id,
    // One shop per order, known since the match. It was null here, with the
    // shop recorded per job instead -- which is why no supplier surface ever
    // showed a checkout order: every one of them reads order.supplierId.
    supplierId: null,
    riderId: null,
    // Money first. Operations confirms the transfer, then checks the artwork,
    // and only then does the shop see the job.
    state: "initial_payment_review",
    supplierSubtotalMinor: 0,
    subtotalMinor: 0,
    serviceFeeRateBps: store.settings.serviceFeeRateBps,
    serviceFeeMinor: 0,
    deliveryFeeMinor: 0,
    totalMinor: 0,
    fulfillmentMode: cart.fulfillmentMode,
    paymentPlan: "order_match_qr_75_25",
    quoteVersion: 1,
    supplierDownpaymentRateBps: 7500,
    onlineDueMinor: 0,
    directStoreDueMinor: 0,
    supplierPlatformPayoutMinor: 0,
    commercialCommittedAt: at,
    moneyModelVersion: 3,
    payoutHold: false,
    pickup: null,
    dropoff: cart.defaultDropoff ? { ...cart.defaultDropoff } : null,
    payments: {},
    paymentAllocations: [],
    revenueAdjustments: [],
    payoutMilestones: [],
    serviceLevel: cart.serviceLevel,
    scheduledFor: cart.scheduledFor ?? null,
    timeline: [{ at, state: "initial_payment_review", by: user.id, note: "Placed; payment sent for confirmation" }],
    createdAt: at,
    updatedAt: at,
  };
  store.orders ||= [];
  store.orders.push(order);

  const grouped = new Map();
  for (const line of cartLines) {
    const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
    const listing = item && publicCatalogItem(store, item, { selectedOptionIds: line.optionIds || [] });
    if (!listing || listing.supplierId !== line.supplierId) {
      fail(409, "catalog_item_stale", "A cart listing changed or is no longer public. Refresh the cart before checkout.", { lineId: line.id });
    }
    if (line.artworkFileId) fileFor(store, user, line.artworkFileId, "artwork", "artworkFileId");
    if (line.mockupFileId) fileFor(store, user, line.mockupFileId, "mockup", "mockupFileId");
    if (!grouped.has(line.supplierId)) grouped.set(line.supplierId, []);
    grouped.get(line.supplierId).push({ line, item, listing });
  }

  const jobs = [];
  const snapshots = [];
  for (const [supplierId, entries] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
    if (!profile?.shop || profile.isClosed) fail(409, "shop_unavailable", "A shop in this cart is no longer available.", { supplierId });
    let jobDropoff = null;
    let distance = 0;
    let deliveryFeeMinor = 0;
    if (cart.fulfillmentMode === "delivery") {
      const dropoffs = entries.map(({ line }) => line.dropoff || cart.defaultDropoff);
      if (dropoffs.some((dropoff) => !dropoff)) fail(409, "dropoff_required", "Set a delivery drop-off for every cart line.");
      const distances = dropoffs.map((dropoff) => ({ dropoff, distance: distanceMetersBetween(profile.shop, dropoff) }));
      const farthest = distances.sort((left, right) => right.distance - left.distance)[0];
      jobDropoff = { ...farthest.dropoff };
      distance = farthest.distance;
      deliveryFeeMinor = deliveryFeeForDistance(distance, store.settings);
    }
    const jobId = createId("job");
    const jobSnapshots = entries.map(({ line, item, listing }) => {
      const snapshot = createOrderLineSnapshot(store, {
        orderId,
        lineItemId: line.id,
        catalogItemId: item.id,
        expectedVersion: item.version,
        expectedServiceVersion: listing.serviceVersion,
        optionIds: line.optionIds || [],
        quantity: line.quantity,
        structuredSpec: line.structuredSpec || {},
        createdAt: at,
        sortOrder: line.sortOrder,
      }, createId);
      snapshot.lineItem.jobId = jobId;
      if (line.artworkFileId) snapshot.lineItem.artworkFileId = line.artworkFileId;
      if (line.mockupFileId) snapshot.lineItem.mockupFileId = line.mockupFileId;
      if (line.dropoff) snapshot.lineItem.dropoff = { ...line.dropoff };
      return { cartLine: line, ...snapshot };
    });
    const supplierSubtotalMinor = addMinor(jobSnapshots.map((row) => row.lineItem.lineSubtotalMinor), "job.supplierSubtotalMinor");
    const estimatedHours = Math.max(...jobSnapshots.map((row) => row.lineItem.turnaroundHoursSnapshot || 24));
    const job = {
      id: jobId, orderId, supplierId, riderId: null, state: "needs_qa",
      fulfillmentMode: cart.fulfillmentMode, pickup: { ...profile.shop },
      ...(jobDropoff ? { dropoff: jobDropoff } : {}),
      supplierSubtotalMinor, deliveryDistanceMeters: distance, deliveryFeeMinor,
      estimatedHours, ...(cart.scheduledFor ? { scheduledFor: cart.scheduledFor } : {}),
      createdAt: at, updatedAt: at,
    };
    jobs.push(job);
    snapshots.push(...jobSnapshots);
  }

  // The shop, and the two dates. Both are fixed here rather than at the match:
  // the match was priced on a listing nobody had configured yet, and the real
  // quantity is only known now.
  const [job] = jobs;
  const shopProfile = (store.supplierProfiles || []).find((row) => row.userId === job.supplierId);
  const orderedUnits = snapshots.reduce((total, row) => total + Number(row.lineItem.quantity || 0), 0);
  const capacityDaily = (store.supplierServices || [])
    .filter((row) => row.supplierId === job.supplierId && row.state === "live")
    .reduce((best, row) => (Number.isSafeInteger(row.capacityDaily) ? Math.max(best, row.capacityDaily) : best), 0);
  const projection = projectFinish({
    schedule: shopProfile?.schedule || defaultShopSchedule(),
    now: at,
    turnaroundMinutes: Math.max(1, job.estimatedHours) * 60,
    units: orderedUnits > 0 ? orderedUnits : null,
    capacityDaily: capacityDaily > 0 ? capacityDaily : null,
    allowanceMinutes: Number.isSafeInteger(store.settings?.promiseAllowanceMinutes)
      ? store.settings.promiseAllowanceMinutes
      : 600,
  });
  order.supplierId = job.supplierId;
  order.pickup = { ...job.pickup };
  // The shop's own date, which it is held to. Never shown to the client.
  order.readyBy = projection.readyBy;
  // The padded date the client was promised. Never shown to the shop.
  order.promiseBy = projection.promiseBy;

  const itemSubtotalMinor = addMinor(jobs.map((job) => job.supplierSubtotalMinor), "order.itemSubtotalMinor");
  const deliveryTotalMinor = addMinor(jobs.map((job) => job.deliveryFeeMinor), "order.deliveryFeeMinor");
  const serviceFeeMinor = roundBps(itemSubtotalMinor, store.settings.serviceFeeRateBps);
  const totalMinor = addMinor([itemSubtotalMinor, serviceFeeMinor, deliveryTotalMinor], "order.totalMinor");
  const downpaymentMinor = roundBps(totalMinor, 7500);
  const balanceMinor = totalMinor - downpaymentMinor;
  Object.assign(order, {
    supplierSubtotalMinor: itemSubtotalMinor,
    subtotalMinor: itemSubtotalMinor,
    serviceFeeMinor,
    deliveryFeeMinor: deliveryTotalMinor,
    totalMinor,
    onlineDueMinor: totalMinor,
    supplierPlatformPayoutMinor: itemSubtotalMinor,
    payments: {
      initial: {
        amountMinor: downpaymentMinor, method: "qr_manual", status: "pending_confirmation",
        label: "75% downpayment", reference, proofFileId: proof.fileId, submittedAt: at,
      },
      final_online: {
        amountMinor: balanceMinor, method: "qr_manual", status: "not_submitted",
        label: "25% balance", reference: null, proofFileId: null, submittedAt: null,
      },
    },
  });
  order.invoiceNumber = invoiceNumber(orderId, at);

  store.orderJobs ||= [];
  store.orderLineItems ||= [];
  store.orderLineItemOptions ||= [];
  store.orderInvoices ||= [];
  store.orderJobs.push(...jobs);
  for (const snapshot of snapshots) {
    store.orderLineItems.push(snapshot.lineItem);
    store.orderLineItemOptions.push(...snapshot.options);
    if (snapshot.lineItem.artworkFileId) attachOrderFile(fileFor(store, user, snapshot.lineItem.artworkFileId, "artwork", "artworkFileId"), orderId, `line:${snapshot.lineItem.id}:artwork`);
    if (snapshot.lineItem.mockupFileId) attachOrderFile(fileFor(store, user, snapshot.lineItem.mockupFileId, "mockup", "mockupFileId"), orderId, `line:${snapshot.lineItem.id}:mockup`);
  }
  attachOrderFile(proof, orderId, "payment:initial:proof");

  const invoice = {
    invoiceNumber: order.invoiceNumber,
    orderId,
    issuedAt: at,
    currency: "PHP",
    lines: snapshots.map(({ cartLine, lineItem }) => ({
      id: lineItem.id,
      jobId: lineItem.jobId,
      itemName: lineItem.itemNameSnapshot,
      quantity: lineItem.quantity,
      unitPriceMinor: lineItem.effectiveUnitPriceMinor,
      amountMinor: lineItem.lineSubtotalMinor,
      artworkFileId: cartLine.artworkFileId ?? null,
      mockupFileId: cartLine.mockupFileId ?? null,
      dropoff: cartLine.dropoff ? { ...cartLine.dropoff } : null,
    })),
    itemSubtotalMinor,
    serviceFeeRateBps: store.settings.serviceFeeRateBps,
    serviceFeeMinor,
    deliveryLines: jobs.map((job) => ({ jobId: job.id, shopName: publicSupplierShop(store, job.supplierId)?.shopName || "Shop", amountMinor: job.deliveryFeeMinor })),
    deliveryFeeMinor: deliveryTotalMinor,
    totalMinor,
    paymentPlan: { method: "qr_manual", downpaymentMinor, balanceMinor },
  };
  store.orderInvoices.push({ orderId, invoiceNumber: order.invoiceNumber, issuedAt: at, snapshot: invoice });
  cart.state = "checked_out";
  cart.checkedOutOrderId = orderId;
  cart.checkedOutAt = at;
  updateCart(cart, at);
  store.auditLog ||= [];
  store.auditLog.push({
    id: createId("aud"), at, actorId: user.id, actorRole: "client", action: "order_match.checkout",
    entityType: "order", entityId: orderId, orderId,
    detail: { jobCount: jobs.length, itemSubtotalMinor, serviceFeeMinor, deliveryFeeMinor: deliveryTotalMinor, totalMinor },
  });
  return { order: publicMatchedOrder(store, order), invoice };
}

export function isOrderMatchRoute(method, pathname) {
  if (["/me/preferences", "/me/addresses", "/me/matches", "/me/matches/next", "/me/carts"].includes(pathname)) return true;
  if (/^\/me\/carts\/[^/]+(?:\/.*)?$/.test(pathname)) return true;
  if (method === "GET" && /^\/orders\/[^/]+\/invoice$/.test(pathname)) return true;
  return false;
}

export async function routeOrderMatch({ req, url, store, user, readBody, id, now }) {
  const { pathname } = url;
  if (!isOrderMatchRoute(req.method, pathname)) return null;

  if (req.method === "GET" && /^\/orders\/[^/]+\/invoice$/.test(pathname)) {
    if (!user) fail(401, "unauthorized", "Sign in to view this invoice.");
    const orderId = pathname.split("/")[2];
    const order = (store.orders || []).find((row) => row.id === orderId);
    if (!order) fail(404, "order_not_found", "That order no longer exists.");
    const privileged = identityHasMembership(user, "ops_admin") || identityHasMembership(user, "super_admin");
    if (order.clientId !== user.id && !privileged) fail(403, "forbidden", "That invoice belongs to another client.");
    const invoice = (store.orderInvoices || []).find((row) => row.orderId === orderId);
    if (!invoice) fail(404, "invoice_not_found", "This order does not have an invoice.");
    return { status: 200, body: { invoice: structuredClone(invoice.snapshot) }, mutated: false };
  }

  requireClient(user);
  if (req.method === "GET" && pathname === "/me/preferences") {
    return { status: 200, body: { preferences: publicPreference(store, user.id) }, mutated: false };
  }
  if (req.method === "PUT" && pathname === "/me/preferences") {
    const ranking = validatePreferenceRanking((await readBody(req)).ranking);
    const at = now();
    const existing = preferenceFor(store, user.id);
    if (existing) {
      existing.ranking = ranking;
      existing.version += 1;
      existing.updatedAt = at;
    } else {
      store.clientPreferences ||= [];
      store.clientPreferences.push({ userId: user.id, ranking, version: 1, updatedAt: at });
    }
    return { status: 200, body: { preferences: publicPreference(store, user.id) }, mutated: true };
  }
  if (req.method === "GET" && pathname === "/me/addresses") {
    const addresses = (store.clientAddresses || []).filter((row) => row.clientId === user.id).map(publicAddress);
    return { status: 200, body: { addresses }, mutated: false };
  }
  if (req.method === "POST" && pathname === "/me/addresses") {
    const body = record(await readBody(req));
    const at = now();
    const address = {
      id: id("addr"), clientId: user.id, label: text(body.label, "label", 80),
      addressLine: text(body.addressLine, "addressLine"), point: point(body.point, "point", { requireLabel: false }),
      isDefault: Boolean(body.isDefault), version: 1, createdAt: at, updatedAt: at,
    };
    store.clientAddresses ||= [];
    if (address.isDefault) for (const row of store.clientAddresses) if (row.clientId === user.id) row.isDefault = false;
    store.clientAddresses.push(address);
    return { status: 201, body: { address: publicAddress(address) }, mutated: true };
  }
  if (req.method === "POST" && ["/me/matches", "/me/matches/next"].includes(pathname)) {
    const body = record(await readBody(req));
    if (pathname.endsWith("/next") && (!Array.isArray(body.excludedSupplierIds) || body.excludedSupplierIds.length === 0)) {
      fail(400, "excluded_shops_required", "Send at least one already-seen shop id.", { field: "excludedSupplierIds" });
    }
    return {
      status: 200,
      body: clientFacingMatch(matchShop(store, {
        subcategoryCode: body.subcategoryCode,
        ranking: body.ranking || publicPreference(store, user.id).ranking,
        dropoff: addressPoint(store, user.id, body),
        excludedSupplierIds: body.excludedSupplierIds || [],
        preferredSupplierId: preferredSupplierForCart(store, user, body.cartId),
        // The date the client gave before any shop was chosen. Without it the
        // match cannot filter, and a shop that misses it is only found at
        // checkout.
        deadline: body.deadline ?? null,
        now: now(),
      })),
      mutated: false,
    };
  }
  if (req.method === "POST" && pathname === "/me/carts") {
    const body = record(await readBody(req));
    const at = now();
    const cart = {
      id: id("cart"), clientId: user.id, state: "draft", version: 1,
      serviceLevel: "standard", fulfillmentMode: "delivery", createdAt: at, updatedAt: at,
    };
    Object.assign(cart, fulfillmentInput(body, cart));
    store.carts ||= [];
    store.carts.push(cart);
    return { status: 201, body: { cart: publicCart(store, cart) }, mutated: true };
  }

  const cartMatch = /^\/me\/carts\/([^/]+)$/.exec(pathname);
  if (cartMatch && req.method === "GET") {
    const cart = ownCart(store, user, decodeURIComponent(cartMatch[1]));
    return { status: 200, body: { cart: publicCart(store, cart) }, mutated: false };
  }
  if (cartMatch && req.method === "PATCH") {
    const cart = ownCart(store, user, decodeURIComponent(cartMatch[1]), { draft: true });
    Object.assign(cart, fulfillmentInput(record(await readBody(req)), cart));
    updateCart(cart, now());
    return { status: 200, body: { cart: publicCart(store, cart) }, mutated: true };
  }

  const specialCartMatch = /^\/me\/carts\/([^/]+)\/(fulfillment|dropoffs|checkout)$/.exec(pathname);
  if (specialCartMatch && specialCartMatch[2] === "checkout" && req.method === "POST") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    const result = checkout(store, user, cart, record(await readBody(req)), id, now());
    return { status: 201, body: result, mutated: true };
  }
  if (specialCartMatch && specialCartMatch[2] === "fulfillment" && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    Object.assign(cart, fulfillmentInput(record(await readBody(req)), cart));
    updateCart(cart, now());
    return { status: 200, body: { cart: publicCart(store, cart) }, mutated: true };
  }
  if (specialCartMatch && specialCartMatch[2] === "dropoffs" && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    const body = record(await readBody(req));
    if (Object.hasOwn(body, "defaultDropoff")) cart.defaultDropoff = point(body.defaultDropoff, "defaultDropoff", { required: false });
    if (body.lines != null) {
      if (!Array.isArray(body.lines)) fail(400, "invalid_request", "lines must be an array.", { field: "lines" });
      for (const input of body.lines) {
        const line = (store.cartLines || []).find((row) => row.id === input.lineId && row.cartId === cart.id);
        if (!line) fail(404, "cart_line_not_found", "A cart line no longer exists.", { lineId: input.lineId });
        line.dropoff = point(input.dropoff, "dropoff", { required: false });
        line.updatedAt = now();
      }
    }
    updateCart(cart, now());
    return { status: 200, body: { cart: publicCart(store, cart) }, mutated: true };
  }

  const linesMatch = /^\/me\/carts\/([^/]+)\/lines$/.exec(pathname);
  if (linesMatch && req.method === "POST") {
    const cart = ownCart(store, user, decodeURIComponent(linesMatch[1]), { draft: true });
    const body = record(await readBody(req));
    const item = (store.catalogItems || []).find((row) => row.id === text(body.catalogItemId, "catalogItemId", 120));
    if (!item || catalogItemBlockers(store, item, { publicOnly: true }).length) {
      fail(409, "catalog_item_stale", "That listing changed or is no longer public.");
    }
    if (!Array.isArray(body.optionIds)) fail(400, "invalid_catalog_options", "optionIds must be an array.", { field: "optionIds" });
    selectedCatalogPrice(store, item, body.optionIds);
    const at = now();
    const lines = (store.cartLines || []).filter((row) => row.cartId === cart.id);
    // One shop per order. A basket spanning two shops needs two of everything
    // downstream -- two quality checks, two accept decisions, two pickups, two
    // payouts -- and none of that was ever wired, so the second shop's half
    // simply stopped. Wanting a second shop starts a second order.
    const otherShop = lines.find((row) => row.supplierId !== item.supplierId);
    if (otherShop) {
      fail(409, "cart_belongs_to_another_shop", "This basket is already with another shop. Check it out, or start a new order for this.", {
        field: "catalogItemId",
      });
    }
    const line = {
      id: id("cline"), cartId: cart.id, supplierId: item.supplierId, catalogItemId: item.id,
      optionIds: [...body.optionIds], quantity: positiveInteger(body.quantity, "quantity"),
      structuredSpec: body.structuredSpec == null ? {} : structuredClone(record(body.structuredSpec, "structuredSpec")),
      sortOrder: lines.reduce((maximum, row) => Math.max(maximum, row.sortOrder), -1) + 1,
      createdAt: at, updatedAt: at,
    };
    if (body.artworkFileId != null) line.artworkFileId = fileFor(store, user, text(body.artworkFileId, "artworkFileId", 120), "artwork", "artworkFileId").fileId;
    if (body.dropoff != null) line.dropoff = point(body.dropoff, "dropoff");
    store.cartLines ||= [];
    store.cartLines.push(line);
    updateCart(cart, at);
    return { status: 201, body: { cart: publicCartForLineMutation(store, cart) }, mutated: true };
  }

  const lineMatch = /^\/me\/carts\/([^/]+)\/lines\/([^/]+)$/.exec(pathname);
  if (lineMatch && ["PATCH", "DELETE"].includes(req.method)) {
    const cart = ownCart(store, user, decodeURIComponent(lineMatch[1]), { draft: true });
    const lineId = decodeURIComponent(lineMatch[2]);
    const line = (store.cartLines || []).find((row) => row.id === lineId && row.cartId === cart.id);
    if (!line) fail(404, "cart_line_not_found", "That cart line no longer exists.");
    const at = now();
    if (req.method === "DELETE") {
      store.cartLines = store.cartLines.filter((row) => row !== line);
      updateCart(cart, at);
      return { status: 200, body: { cart: publicCartForLineMutation(store, cart) }, mutated: true };
    }
    const body = record(await readBody(req));
    if (Object.hasOwn(body, "quantity")) line.quantity = positiveInteger(body.quantity, "quantity");
    if (Object.hasOwn(body, "optionIds")) {
      if (!Array.isArray(body.optionIds)) fail(400, "invalid_catalog_options", "optionIds must be an array.", { field: "optionIds" });
      const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
      selectedCatalogPrice(store, item, body.optionIds);
      line.optionIds = [...body.optionIds];
    }
    if (Object.hasOwn(body, "structuredSpec")) line.structuredSpec = structuredClone(record(body.structuredSpec, "structuredSpec"));
    if (Object.hasOwn(body, "artworkFileId")) line.artworkFileId = body.artworkFileId == null ? null : fileFor(store, user, text(body.artworkFileId, "artworkFileId", 120), "artwork", "artworkFileId").fileId;
    if (Object.hasOwn(body, "dropoff")) line.dropoff = point(body.dropoff, "dropoff", { required: false });
    line.updatedAt = at;
    updateCart(cart, at);
    return { status: 200, body: { cart: publicCartForLineMutation(store, cart) }, mutated: true };
  }

  const mockupMatch = /^\/me\/carts\/([^/]+)\/lines\/([^/]+)\/mockup$/.exec(pathname);
  if (mockupMatch && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(mockupMatch[1]), { draft: true });
    const line = (store.cartLines || []).find((row) => row.id === decodeURIComponent(mockupMatch[2]) && row.cartId === cart.id);
    if (!line) fail(404, "cart_line_not_found", "That cart line no longer exists.");
    const body = record(await readBody(req));
    line.mockupFileId = fileFor(store, user, text(body.fileId, "fileId", 120), "mockup", "fileId").fileId;
    line.updatedAt = now();
    updateCart(cart, line.updatedAt);
    return { status: 200, body: { cart: publicCart(store, cart) }, mutated: true };
  }

  return null;
}
