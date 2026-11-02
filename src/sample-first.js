/**
 * Sample First (gridgo-api#222). Contract: docs/SAMPLE_FIRST_API.md.
 *
 * A sample is an ordinary order of one piece at the shop's sample price, paid,
 * checked, delivered, escrowed and refunded like any other. At its checkout the
 * client's intended batch is kept as a draft with a private copy of the
 * listing's batch pricing rules as they stood then. The batch can be ordered at
 * those rules (bulk tiers included, decided 18 Oct 2026 option A) for
 * `sampleBatchHoldDays` after the sample reaches the client, once the client
 * has approved the sample. Changed specs are a new sample, never the held price.
 */
import { MatchError } from "./order-match.js";
import { approvedCatalogView } from "./catalog-review-state.js";
import { catalogGroupsForItem, catalogItemBlockers, clientMoneyMinor, publicSampleOffer, selectedCatalogPrice } from "./supplier-catalog.js";
export { publicSampleOffer };
import { identityHasMembership } from "./authorization-context.js";
import { priceLine } from "./pricing.js";
import { notifyAdmins } from "./domain-events.js";
import { writeDraft } from "./client-order-notifications.js";
import { queueOrderInvalidate } from "./notifications.js";

export const DEFAULT_SAMPLE_BATCH_HOLD_DAYS = 14;
export const SAMPLE_BATCH_STATUSES = Object.freeze(["awaiting_sample", "approved", "rejected", "cancelled", "ordered"]);
const DELIVERED_STATES = new Set(["delivered", "issue_window_open", "completed", "payout_released"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(status, code, message, details = {}) {
  throw new MatchError(status, code, message, details);
}

export function sampleBatchHoldDays(settings) {
  return Number.isInteger(settings?.sampleBatchHoldDays) ? settings.sampleBatchHoldDays : DEFAULT_SAMPLE_BATCH_HOLD_DAYS;
}

export function validateSampleBatchHoldDays(value, failWith) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 90) {
    failWith(400, "invalid_sample_batch_hold_days", "Hold a sampled batch price for a whole number of days from 1 to 90.", { field: "sampleBatchHoldDays" });
  }
}

/** Shop listing fields. A sample price stays stored while the offer is off. */
export function parseSampleListing(body, item, failWith) {
  const next = {
    sampleAvailable: item.sampleAvailable === true,
    samplePriceMinor: item.samplePriceMinor ?? null,
  };
  if (Object.hasOwn(body, "sampleAvailable")) {
    if (typeof body.sampleAvailable !== "boolean") failWith(400, "invalid_catalog_item", "sampleAvailable must be a boolean.", { field: "sampleAvailable" });
    next.sampleAvailable = body.sampleAvailable;
  }
  if (Object.hasOwn(body, "samplePriceMinor")) {
    const price = body.samplePriceMinor;
    if (price !== null && (!Number.isSafeInteger(price) || price < 1)) {
      failWith(400, "invalid_catalog_item", "samplePriceMinor must be a positive whole number of centavos, or null.", { field: "samplePriceMinor" });
    }
    next.samplePriceMinor = price;
  }
  if (next.sampleAvailable && next.samplePriceMinor == null) {
    failWith(400, "sample_price_required", "Set a sample price before offering a sample.", { field: "samplePriceMinor" });
  }
  // A colour-priced document is priced from its artwork's pages; its held batch
  // cannot be reproduced from a price list, so it offers no sample.
  if (next.sampleAvailable && item.pricedByColour) {
    failWith(409, "sample_not_supported", "Colour-priced listings cannot offer a sample.", { field: "sampleAvailable" });
  }
  return next;
}

/** The approved (client-visible) listing, or null when it is not public now. */
export function approvedListing(store, itemId) {
  const view = approvedCatalogView(store);
  const item = (view.catalogItems || []).find(row => row.id === itemId);
  if (!item || catalogItemBlockers(view, item, { publicOnly: true }).length) return null;
  return item;
}

/** Live sample price of an approved listing, or null when it offers none. */
export function sampleLinePriceMinor(store, line) {
  const item = approvedListing(store, line.catalogItemId);
  if (!item || item.supplierId !== line.supplierId) return null;
  const offer = publicSampleOffer(store, item);
  return offer.sampleAvailable ? offer.samplePriceMinor : null;
}

/**
 * The private immutable copy of the listing's batch pricing rules.
 *
 * Every input the pricing engine reads for this specification, taken from the
 * approved listing at sample checkout: base rate, the chosen options' price
 * effects, every volume (bulk) tier, the minimums and the chosen speed. The
 * specification is locked to the sample, so options the client did not choose
 * are not part of what was promised.
 */
export function heldPricingSnapshot(store, itemId, line, { at, speedTier = null }) {
  const view = approvedCatalogView(store);
  const item = (view.catalogItems || []).find(row => row.id === itemId);
  const service = (view.supplierServices || []).find(row => row.id === item.supplierServiceId);
  const { selectedOptions } = selectedCatalogPrice(view, item, line.optionIds || []);
  const groups = new Map(catalogGroupsForItem(view, item.id).map(group => [group.id, group]));
  return {
    version: 1,
    capturedAt: at,
    catalogItemId: item.id,
    catalogItemVersion: item.version,
    serviceVersion: service?.version || 1,
    pricingUnit: item.pricingUnit || "per_unit",
    packageQty: item.packageQty ?? null,
    basePriceMinor: item.basePriceMinor,
    minimumOrderQuantity: item.minimumOrderQuantity ?? null,
    minimumMeasurement: {
      width: item.minimumWidthMilli ?? null,
      height: item.minimumHeightMilli ?? null,
      length: item.minimumLengthMilli ?? null,
    },
    options: selectedOptions.map(option => ({
      optionId: option.id,
      optionGroupId: option.optionGroupId,
      groupName: groups.get(option.optionGroupId)?.name ?? null,
      label: option.label,
      priceModifierMinor: option.priceModifierMinor,
      priceMultiplierBps: option.priceMultiplierBps ?? null,
    })),
    volumeTiers: (view.catalogPriceTiers || []).filter(row => row.catalogItemId === item.id)
      .sort((left, right) => left.minQuantity - right.minQuantity)
      .map(row => ({ minQuantity: row.minQuantity, unitPriceMinor: row.unitPriceMinor })),
    speedTier: speedTier ? structuredClone(speedTier) : null,
  };
}

/** Price a batch quantity with the held rules, through the ordinary engine. */
export function heldBatchPrice(heldPricing, { quantity, measurement = null }) {
  return priceLine({
    basePriceMinor: heldPricing.basePriceMinor,
    unit: heldPricing.pricingUnit,
    packageQty: heldPricing.packageQty,
    options: heldPricing.options.map(option => ({
      priceModifierMinor: option.priceModifierMinor,
      priceMultiplierBps: option.priceMultiplierBps ?? null,
    })),
    volumeTiers: heldPricing.volumeTiers,
    minimumOrderQuantity: heldPricing.minimumOrderQuantity,
    minimumMeasurement: heldPricing.minimumMeasurement,
    speedTier: heldPricing.speedTier,
    quantity,
    measurement,
  });
}

/** When the sample reached the client: the issue window opening, else the delivered step. */
export function sampleDeliveredAt(order) {
  if (!order || !DELIVERED_STATES.has(order.state)) return null;
  const at = order.issueWindowOpenedAt
    || (order.timeline || []).find(entry => DELIVERED_STATES.has(entry?.state) && entry.at)?.at
    || order.deliveryEvidence?.recordedAt
    || order.updatedAt;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The hold clock: persisted once the client decides, otherwise read from the sample order. */
export function draftHold(store, draft, at) {
  let deliveredAt = draft.sampleDeliveredAt ?? null;
  let heldUntil = draft.heldUntil ?? null;
  if (!heldUntil) {
    const order = (store.orders || []).find(row => row.id === draft.sampleOrderId);
    deliveredAt = sampleDeliveredAt(order);
    heldUntil = deliveredAt ? new Date(Date.parse(deliveredAt) + draft.holdDays * DAY_MS).toISOString() : null;
  }
  const active = Boolean(heldUntil) && Date.parse(at) < Date.parse(heldUntil);
  return { sampleDeliveredAt: deliveredAt, heldUntil, holdActive: active, holdExpired: Boolean(heldUntil) && !active };
}

/** Why the held price cannot be used now, or null. */
export function heldPriceBlocker(store, draft, at) {
  if (draft.status === "ordered") return { status: 409, code: "sample_batch_ordered", message: "This batch has already been ordered.", details: { batchOrderId: draft.batchOrderId } };
  if (draft.status !== "approved") return { status: 409, code: "sample_batch_not_approved", message: "Approve the sample before ordering its batch.", details: { status: draft.status } };
  const hold = draftHold(store, draft, at);
  if (!hold.holdActive) return { status: 409, code: "sample_hold_expired", message: "The held batch price has expired. Order the batch at the current price instead.", details: { heldUntil: hold.heldUntil } };
  const sample = (store.orders || []).find(row => row.id === draft.sampleOrderId);
  if (sample?.supplierId && sample.supplierId !== draft.supplierId) {
    return { status: 409, code: "sample_shop_changed", message: "Another shop made this sample, so its batch price was not held. Order at the current price.", details: {} };
  }
  return null;
}

export function assertHeldPriceUsable(store, draft, at) {
  const blocker = heldPriceBlocker(store, draft, at);
  if (blocker) fail(blocker.status, blocker.code, blocker.message, blocker.details);
}

function isStaff(user) {
  return identityHasMembership(user, "ops_admin") || identityHasMembership(user, "super_admin");
}

function requireClient(user) {
  if (!user || !identityHasMembership(user, "client")) {
    fail(403, "membership_required", "A GRIDGO client membership is required.", { requiredRole: "client" });
  }
}

export function ownSampleBatch(store, user, draftId) {
  requireClient(user);
  const draft = (store.sampleBatchDrafts || []).find(row => row.id === draftId);
  if (!draft) fail(404, "sample_batch_not_found", "That sample batch no longer exists.");
  if (draft.clientId !== user.id) fail(403, "forbidden", "That sample batch belongs to another client.");
  return draft;
}

function optionalQuantity(url) {
  if (!url.searchParams.has("quantity")) return null;
  const value = Number(url.searchParams.get("quantity"));
  if (!Number.isSafeInteger(value) || value < 1) fail(400, "invalid_request", "quantity must be a positive integer.", { field: "quantity" });
  return value;
}

function priceOrNull(fn) {
  try { return fn(); } catch { return null; }
}

/**
 * Role-aware draft projection. Clients get client-side money only; the held
 * pricing rules themselves are private to Operations and Super Admin.
 */
export function publicSampleBatch(store, draft, user, at, { quantity = null } = {}) {
  const staff = isStaff(user);
  const hold = draftHold(store, draft, at);
  const sample = (store.orders || []).find(row => row.id === draft.sampleOrderId);
  const batchQuantity = quantity ?? draft.batch.quantity;
  const measurement = draft.batch.measurement ?? null;
  const held = priceOrNull(() => heldBatchPrice(draft.heldPricing, { quantity: batchQuantity, measurement }));
  const listing = approvedListing(store, draft.catalogItemId);
  const current = listing && listing.supplierId === draft.supplierId ? priceOrNull(() => {
    const view = approvedCatalogView(store);
    const { selectedOptions } = selectedCatalogPrice(view, listing, draft.batch.optionIds || []);
    return priceLine({
      basePriceMinor: listing.basePriceMinor, unit: listing.pricingUnit || "per_unit", packageQty: listing.packageQty ?? null,
      options: selectedOptions.map(option => ({ priceModifierMinor: option.priceModifierMinor, priceMultiplierBps: option.priceMultiplierBps ?? null })),
      volumeTiers: (view.catalogPriceTiers || []).filter(row => row.catalogItemId === listing.id)
        .sort((left, right) => left.minQuantity - right.minQuantity).map(row => ({ minQuantity: row.minQuantity, unitPriceMinor: row.unitPriceMinor })),
      minimumOrderQuantity: listing.minimumOrderQuantity ?? null,
      minimumMeasurement: { width: listing.minimumWidthMilli ?? null, height: listing.minimumHeightMilli ?? null, length: listing.minimumLengthMilli ?? null },
      speedTier: draft.heldPricing.speedTier, quantity: batchQuantity, measurement,
    });
  }) : null;
  const blocker = heldPriceBlocker(store, draft, at);
  const replacedBy = (store.sampleBatchDrafts || []).find(row => row.previousDraftId === draft.id)?.id ?? null;
  const money = (priced) => priced ? {
    quantity: batchQuantity,
    clientItemMinor: clientMoneyMinor(store, priced.lineSubtotalMinor),
    ...(staff ? { lineSubtotalMinor: priced.lineSubtotalMinor, unitRateMinor: priced.unitRateMinor, volumeTierApplied: priced.volumeTierApplied } : {}),
  } : null;
  return {
    id: draft.id,
    status: draft.status,
    tags: ["sample_batch"],
    catalogItemId: draft.catalogItemId,
    itemName: listing?.name ?? draft.batch.itemName ?? null,
    sampleOrderId: draft.sampleOrderId,
    sampleOrderState: sample?.state ?? null,
    batchOrderId: draft.batchOrderId ?? null,
    previousDraftId: draft.previousDraftId ?? null,
    replacedByDraftId: replacedBy,
    batch: publicBatch(draft.batch),
    holdDays: draft.holdDays,
    ...hold,
    heldPrice: money(held),
    currentPrice: money(current),
    canOrderAtHeldPrice: !blocker,
    heldPriceBlocker: blocker ? blocker.code : null,
    canOrderAtCurrentPrice: draft.status === "approved" && Boolean(current),
    approval: draft.approval ? structuredClone(draft.approval) : null,
    rejection: draft.rejection ? structuredClone(draft.rejection) : null,
    ...(staff ? { clientId: draft.clientId, supplierId: draft.supplierId, heldPricing: structuredClone(draft.heldPricing) } : {}),
    version: draft.version,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function publicBatch(batch) {
  const copy = structuredClone(batch);
  delete copy.itemName;
  return copy;
}

/** Summary copied onto the sample and batch orders: the batch standard in disputes. */
export function sampleDecisionSummary(draft) {
  if (draft.approval) {
    return { draftId: draft.id, decision: "approved", method: draft.approval.method, at: draft.approval.at,
      samplePhotoFileId: draft.approval.samplePhotoFileId, note: draft.approval.note ?? "" };
  }
  if (draft.rejection) {
    return { draftId: draft.id, decision: "rejected", at: draft.rejection.at, reason: draft.rejection.reason, next: draft.rejection.next };
  }
  return null;
}

function bodyRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_request", "body must be a JSON object.", { field: "body" });
  return value;
}

function boundedText(value, field, { required = false, max = 2000 } = {}) {
  if (value == null && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()) || value.trim().length > max) {
    fail(400, required ? `${field}_required` : "invalid_request", `${field} must be ${required ? "a nonblank" : "a"} string of at most ${max} characters.`, { field });
  }
  return value.trim();
}

function assertDecidable(store, draft) {
  if (draft.status !== "awaiting_sample") {
    fail(409, "sample_batch_decided", "This sample has already been decided.", { status: draft.status });
  }
  const sample = (store.orders || []).find(row => row.id === draft.sampleOrderId);
  if (!sampleDeliveredAt(sample)) {
    fail(409, "sample_not_delivered", "Decide on the sample once it has been delivered to you.", { sampleOrderState: sample?.state ?? null });
  }
  return sample;
}

function decisionEffects(store, draft, sample, { user, at, id, action, type, title, detail }) {
  sample.sampleDecision = sampleDecisionSummary(draft);
  sample.updatedAt = at;
  store.auditLog ||= [];
  store.auditLog.push({ id: id("aud"), at, actorId: user.id, actorRole: "client", action,
    entityType: "sample_batch", entityId: draft.id, orderId: sample.id, detail });
  if (sample.supplierId) {
    // Party and staff inbox types stay distinct: a staff type never reaches a party app.
    writeDraft(store, { userId: sample.supplierId, appRole: "supplier", type: `shop_${type}`, title,
      body: "Open GRIDGO to see the client's decision on the sample.", read: false,
      orderId: sample.id, occurrenceKey: `shop_${type}:${draft.id}` }, { id: id("ntf"), at });
  }
  notifyAdmins(store, type, title, sample, `${type}:${draft.id}`, { createId: id, at });
  queueOrderInvalidate(store, sample, ["orders", "jobs"]);
}

function bump(draft, at) {
  draft.version = (draft.version || 1) + 1;
  draft.updatedAt = at;
}

export function isSampleFirstRoute(pathname) {
  return /^\/me\/sample-batches(?:\/[^/]+(?:\/(?:approve|reject|cancel))?)?$/.test(pathname)
    || /^\/ops\/sample-batches(?:\/[^/]+)?$/.test(pathname);
}

/** Reads and decisions. Ordering the batch is a cart route in order-match-routes.js. */
export async function routeSampleFirst({ req, url, store, user, readBody, id, now }) {
  const { pathname } = url;
  if (!isSampleFirstRoute(pathname)) return null;
  if (!user) fail(401, "unauthorized", "Sign in to continue.");
  const at = now();

  if (pathname.startsWith("/ops/")) {
    if (req.method !== "GET") return null;
    if (!isStaff(user)) fail(403, "forbidden", "Operations or Super Admin access is required.");
    const draftId = pathname.split("/")[3];
    if (draftId) {
      const draft = (store.sampleBatchDrafts || []).find(row => row.id === decodeURIComponent(draftId));
      if (!draft) fail(404, "sample_batch_not_found", "That sample batch no longer exists.");
      return { status: 200, mutated: false, body: { sampleBatch: publicSampleBatch(store, draft, user, at, { quantity: optionalQuantity(url) }) } };
    }
    const status = url.searchParams.get("status");
    if (status && !SAMPLE_BATCH_STATUSES.includes(status)) fail(400, "invalid_request", "Unknown sample batch status.", { field: "status", allowed: SAMPLE_BATCH_STATUSES });
    const rows = (store.sampleBatchDrafts || [])
      .filter(row => (!status || row.status === status)
        && (!url.searchParams.get("supplierId") || row.supplierId === url.searchParams.get("supplierId"))
        && (!url.searchParams.get("clientId") || row.clientId === url.searchParams.get("clientId")))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || left.id.localeCompare(right.id))
      .slice(0, 200);
    return { status: 200, mutated: false, body: { sampleBatches: rows.map(row => publicSampleBatch(store, row, user, at)) } };
  }

  if (pathname === "/me/sample-batches") {
    if (req.method !== "GET") return null;
    requireClient(user);
    const rows = (store.sampleBatchDrafts || []).filter(row => row.clientId === user.id)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || left.id.localeCompare(right.id));
    return { status: 200, mutated: false, body: { sampleBatches: rows.map(row => publicSampleBatch(store, row, user, at)) } };
  }

  const [, , , rawId, action] = pathname.split("/");
  const draft = ownSampleBatch(store, user, decodeURIComponent(rawId));
  if (!action) {
    if (req.method !== "GET") return null;
    return { status: 200, mutated: false, body: { sampleBatch: publicSampleBatch(store, draft, user, at, { quantity: optionalQuantity(url) }) } };
  }
  if (req.method !== "POST") return null;
  const body = bodyRecord(await readBody(req));

  if (action === "approve") {
    const sample = assertDecidable(store, draft);
    // Lean version: a tick and a photo. The signed approval proof will arrive as
    // another `method` with its own evidence, on this same record shape.
    if (body.accepted !== true || (body.method ?? "tick") !== "tick") {
      fail(400, "invalid_sample_approval", "Approve with accepted: true and method \"tick\".", { field: "accepted" });
    }
    const photoId = typeof body.samplePhotoFileId === "string" ? body.samplePhotoFileId.trim() : "";
    const photo = (store.files || []).find(row => row.fileId === photoId);
    if (!photo || photo.ownerId !== user.id || photo.purpose !== "approval_sample_photo"
      || (photo.references || []).some(ref => !(ref.type === "order" && ref.id === draft.sampleOrderId))) {
      fail(400, "invalid_approval_file", "Upload your own photo of the sample (purpose approval_sample_photo).", { field: "samplePhotoFileId" });
    }
    if (photo.state !== "ready" || !photo.objectKey) fail(409, "file_not_ready", "The sample photo has not finished uploading.", { field: "samplePhotoFileId" });
    const note = boundedText(body.note, "note");
    const hold = draftHold(store, draft, at);
    draft.approval = { version: 1, method: "tick", accepted: true, samplePhotoFileId: photo.fileId, note, at, by: user.id };
    draft.status = "approved";
    draft.sampleDeliveredAt = hold.sampleDeliveredAt;
    draft.heldUntil = hold.heldUntil;
    bump(draft, at);
    photo.references ||= [];
    if (!photo.references.some(ref => ref.type === "order" && ref.id === sample.id && ref.field === "sample:approval")) {
      photo.references.push({ type: "order", id: sample.id, field: "sample:approval" });
    }
    decisionEffects(store, draft, sample, { user, at, id, action: "sample_batch.approve", type: "sample_approved", title: "Sample approved",
      detail: { samplePhotoFileId: photo.fileId, heldUntil: draft.heldUntil, sampleDeliveredAt: draft.sampleDeliveredAt } });
    return { status: 200, mutated: true, body: { sampleBatch: publicSampleBatch(store, draft, user, at) } };
  }

  if (action === "reject") {
    const sample = assertDecidable(store, draft);
    const reason = boundedText(body.reason, "reason", { required: true });
    if (!["resample", "cancel"].includes(body.next)) {
      fail(400, "invalid_sample_rejection", "Choose next: \"resample\" to order another sample with changed specs, or \"cancel\".", { field: "next" });
    }
    const hold = draftHold(store, draft, at);
    draft.rejection = { version: 1, reason, next: body.next, at, by: user.id };
    draft.status = body.next === "cancel" ? "cancelled" : "rejected";
    draft.sampleDeliveredAt = hold.sampleDeliveredAt;
    draft.heldUntil = hold.heldUntil;
    bump(draft, at);
    decisionEffects(store, draft, sample, { user, at, id, action: "sample_batch.reject", type: "sample_rejected", title: "Sample rejected",
      detail: { reason, next: body.next } });
    return { status: 200, mutated: true, body: { sampleBatch: publicSampleBatch(store, draft, user, at) } };
  }

  if (action === "cancel") {
    if (!["awaiting_sample", "approved", "rejected"].includes(draft.status)) {
      fail(409, "sample_batch_decided", "This batch draft can no longer be cancelled.", { status: draft.status });
    }
    const reason = boundedText(body.reason, "reason");
    const previous = draft.status;
    draft.status = "cancelled";
    bump(draft, at);
    store.auditLog ||= [];
    store.auditLog.push({ id: id("aud"), at, actorId: user.id, actorRole: "client", action: "sample_batch.cancel",
      entityType: "sample_batch", entityId: draft.id, orderId: draft.sampleOrderId, detail: { previousStatus: previous, reason } });
    notifyAdmins(store, "sample_batch_cancelled", "Sample batch draft cancelled",
      (store.orders || []).find(row => row.id === draft.sampleOrderId) || null, `sample_batch_cancelled:${draft.id}`, { createId: id, at });
    return { status: 200, mutated: true, body: { sampleBatch: publicSampleBatch(store, draft, user, at) } };
  }
  return null;
}
