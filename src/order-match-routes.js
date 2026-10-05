import { officerSnapshot } from "./client-applications.js";
import { approvedCatalogView, CATALOG_REVIEW_TABLES } from "./catalog-review-state.js";
import { clientInvoice } from "./invoice-projection.js";
import { basketForOrder, publicBasket, shopLabel, splitBasketFee } from "./baskets.js";
import { fileCheckProjection } from "./artwork-gates.js";
import { publicHubPickup } from "./hub-pickup.js";
import { createHash, randomBytes } from "node:crypto";
import { publicShopRating } from "./shop-rating.js";
import { validateArtworkLinks, hasShortArtworkLinks, resolveArtworkLinks, checkArtworkLinkForUser } from "./artwork-links.js";
import { gridgoOfficePoint } from "./gridgo-office.js";
import { measurementKindFor } from "./pricing.js";
import {
  identityHasMembership } from "./authorization-context.js";
import {
  catalogItemBlockers,
  clientMoneyMinor,
  createOrderLineSnapshot,
  itemTurnaroundHours,
  listingFitsPrinterCap,
  minimumCatalogPrice,
  projectedPrinterMaxWidthFeet,
  publicCatalogItem,
  publicSupplierShop,
  priceCatalogSelection,
  selectedCatalogPrice,
} from "./supplier-catalog.js";
import {
  snapshotPayoutPlan,
  deliveryFeeForDistance,
  deliverySplit,
  distanceMetersBetween,
  distanceZoneForDistance,
  downpaymentPercentSetting,
  orderDownpaymentPercent,
  roundBps,
} from "./operational-model.js";
import { AvailabilityError, fitsDeadline } from "./availability.js";
import {
  MatchError,
  deadlineDays,
  matchShop,
  multiplyMinor,
  projectShopFinish,
  validatePreferenceRanking,
} from "./order-match.js";
import {
  notifyClientReceiptReady,
  notifyOpsJobNeedsQa,
  notifyOpsPaymentSubmitted,
} from "./client-order-notifications.js";
import { queueOrderInvalidate } from "./notifications.js";

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

/**
 * The measurement a listing needs, read from what the client sent.
 *
 * Which numbers are required is the listing's decision, not the request's: a
 * tarpaulin priced by the square foot needs a width and a height, a banner
 * priced by the running foot needs a length, and a document priced by the page
 * needs a page count. Anything else needs none, and sending one is a mistake
 * worth naming rather than ignoring -- a client whose measurement is silently
 * dropped is billed for something other than what they filled in.
 *
 * Stored in thousandths of the listing's own `measureUnit`, so 3.5 feet is
 * 3500 and nothing fractional reaches a price.
 */
function measurementFor(item, body, { required = true } = {}) {
  const kind = measurementKindFor(item.pricingUnit || "per_unit");
  const sent = body.measurement == null ? null : record(body.measurement, "measurement");

  if (kind === "none") {
    if (sent && Object.keys(sent).length) {
      fail(400, "measurement_not_accepted", "This listing is not priced by size, so it takes no measurement.", {
        field: "measurement",
      });
    }
    return null;
  }

  if (!sent) {
    if (!required) return undefined;
    fail(400, "measurement_required", MEASUREMENT_PROMPTS[kind], { field: "measurement", measurementKind: kind });
  }

  if (kind === "pages") return { pages: positiveInteger(sent.pages, "measurement.pages") };
  if (kind === "length") return { length: positiveInteger(sent.length, "measurement.length") };
  return {
    width: positiveInteger(sent.width, "measurement.width"),
    height: positiveInteger(sent.height, "measurement.height"),
  };
}

/** What to ask for, in the client's terms, when a measurement is missing. */
const MEASUREMENT_PROMPTS = Object.freeze({
  pages: "Tell us how many pages this document has.",
  area: "Tell us how wide and how tall this needs to be.",
  length: "Tell us how long this needs to be.",
});

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

function selectionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function samePoint(left, right) {
  return left?.lat === right?.lat && left?.lng === right?.lng;
}

function assertRequestFulfillment(cart, body) {
  const choice = cart.requestFulfillment;
  if (!choice) return;
  if ((Object.hasOwn(body, "fulfillmentMode") && body.fulfillmentMode !== choice.fulfillmentMode)
      || ["defaultDropoff", "dropoff"].some((field) => Object.hasOwn(body, field)
        && !samePoint(body[field], choice.dropoff))) {
    fail(409, "request_fulfillment_locked", "Start a new match and cart to change the chosen fulfillment.");
  }
}

function adoptRequestFulfillment(store, cart, choice) {
  if (!choice) return;
  if (cart.requestFulfillment) {
    assertRequestFulfillment(cart, { fulfillmentMode: choice.fulfillmentMode, dropoff: choice.dropoff });
    return;
  }
  if ((store.cartLines || []).some((line) => line.cartId === cart.id)) {
    fail(409, "request_fulfillment_requires_empty_cart", "Use a new cart for the fulfillment selected before matching.");
  }
  cart.requestFulfillment = structuredClone(choice);
  cart.fulfillmentMode = choice.fulfillmentMode;
  cart.defaultDropoff = choice.fulfillmentMode === "delivery" ? { ...choice.dropoff } : null;
}

function resolveMatchSelection(store, user, cart, body, at) {
  if (!Object.hasOwn(body, "selectToken")) return null;
  if (typeof body.selectToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.selectToken)) {
    fail(400, "invalid_select_token", "Send a selection token from a match response.");
  }
  const saved = (store.matchSelections || []).find((row) => row.tokenHash === selectionHash(body.selectToken));
  if (!saved) fail(400, "invalid_select_token", "This selection is unknown; match again.");
  if (saved.clientId !== user.id) fail(403, "foreign_select_token", "This selection belongs to another client.");
  if (saved.requestId !== body.matchRequestId) fail(409, "select_token_request_mismatch", "Use the request id returned with this selection.");
  if (Date.parse(saved.expiresAt) <= Date.parse(at)) fail(410, "select_token_expired", "This selection expired; match again.");
  const selection = saved.selection;
  if (selection.cartId && selection.cartId !== cart.id) fail(409, "select_token_cart_mismatch", "Use the cart supplied when matching.");
  if (body.catalogItemId != null && body.catalogItemId !== selection.catalogItemId) {
    fail(409, "select_token_listing_mismatch", "This token selects a different listing.");
  }
  if (selection.dropoff && body.dropoff != null) {
    const sent = point(body.dropoff, "dropoff", { requireLabel: false });
    if (sent.lat !== selection.dropoff.lat || sent.lng !== selection.dropoff.lng) {
      fail(409, "select_token_dropoff_mismatch", "Match again to change the delivery location.");
    }
  }
  adoptRequestFulfillment(store, cart, selection.requestFulfillment);
  body.catalogItemId = selection.catalogItemId;
  if (selection.dropoff) body.dropoff = selection.dropoff;
  return selection;
}

function assertMatchDeadline(store, item, line, at) {
  if (!line.matchDeadline) return;
  const { projection } = projectShopFinish(store, { supplierId: item.supplierId,
    turnaroundHours: itemTurnaroundHours(item, (store.supplierServices || []).find((row) => row.id === item.supplierServiceId)),
    units: line.quantity, now: at });
  if (!fitsDeadline(projection, line.matchDeadline)) fail(409, "deadline_not_met", "This listing can no longer make the requested deadline.");
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

/**
 * What a basket line costs right now, priced the way checkout will price it.
 *
 * Null when the listing has gone: a line whose listing was withdrawn has no
 * price, and showing the last one it had is showing a price nobody will honour.
 */
function cartLineSubtotal(store, line) {
  const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
  if (!item) return null;
  try {
    const { selectedOptions } = selectedCatalogPrice(store, item, line.optionIds || []);
    return priceCatalogSelection(store, item, {
      selectedOptions,
      quantity: line.quantity,
      measurement: line.measurement || null,
    }).lineSubtotalMinor;
  } catch {
    // A line the pricer refuses -- a measurement the listing stopped taking,
    // an option that was retired -- has no honest price to show. Checkout says
    // so properly; a basket must not invent one to fill the column.
    return null;
  }
}

/**
 * Refuse a line the pricing engine would refuse, with the engine's own reason.
 *
 * `cartLineSubtotal` swallows a refusal into null because a basket being read
 * must not throw over one line. A basket being written to is different: a
 * quantity under the shop's minimum, or a measurement the listing does not
 * take, is the client's to fix now, and letting it in is what produced a line
 * priced at "—" and a total that was delivery alone. So the write path prices
 * the line and lets `below_minimum_quantity` and its siblings through.
 */
function assertCartLinePriceable(store, item, line) {
  const { selectedOptions } = selectedCatalogPrice(store, item, line.optionIds || []);
  priceCatalogSelection(store, item, {
    selectedOptions,
    quantity: line.quantity,
    measurement: line.measurement || null,
  });
}

function publicCartListingStub(store, item, optionIds) {
  const selected = selectedCatalogPrice(store, item, optionIds);
  const fromPriceMinor = minimumCatalogPrice(store, item);
  return {
    id: item.id,
    name: item.name,
    supplierId: item.supplierId,
    fromPriceMinor,
    effectivePriceMinor: selected.effectiveUnitPriceMinor,
    clientFromPriceMinor: clientMoneyMinor(store, fromPriceMinor),
    clientEffectivePriceMinor: clientMoneyMinor(store, selected.effectiveUnitPriceMinor),
    printerMaxWidthFeet: projectedPrinterMaxWidthFeet(item),
    selectedOptions: selected.selectedOptions.map((option) => ({ id: option.id, label: option.label })),
  };
}

function assertPrinterCap(store, item, request) {
  if (listingFitsPrinterCap(item, request, store)) return;
  fail(409, "printer_cap_exceeded", "This shop's printer cannot print that width.", {
    field: "printerMaxWidthFeet",
    printerMaxWidthFeet: item.printerMaxWidthFeet,
  });
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

function cartLinePromiseBy(store, line, item, at) {
  const profile = (store.supplierProfiles || []).find((row) => row.userId === line.supplierId);
  if (!item || item.supplierId !== line.supplierId || !profile?.shop || profile.isClosed
      || catalogItemBlockers(store, item, { publicOnly: true }).length) return null;
  const service = (store.supplierServices || []).find((row) => row.id === item.supplierServiceId);
  try {
    return projectShopFinish(store, {
      supplierId: line.supplierId,
      turnaroundHours: itemTurnaroundHours(item, service),
      units: line.quantity,
      now: at,
    }).projection.promiseBy;
  } catch (error) {
    // An unavailable calendar must not prevent the client from repairing a cart.
    if (error instanceof AvailabilityError) return null;
    throw error;
  }
}

function publicCartForLineMutation(store, cart, at) {
  return publicCart(store, cart, at, { compactListings: true });
}

// Shared by estimates and checkout: one delivery per shop, to its farthest drop.
function cartDelivery(store, cart, supplierId, lines) {
  if (cart.fulfillmentMode === "pickup") return { dropoff: null, distance: 0, feeMinor: 0 };
  const shop = (store.supplierProfiles || []).find((row) => row.userId === supplierId)?.shop;
  if (!shop) return { error: "shop_unavailable" };
  const dropoffs = lines.map((line) => line.dropoff || cart.defaultDropoff);
  if (dropoffs.some((dropoff) => !dropoff)) return { error: "dropoff_required" };
  const farthest = dropoffs.map((dropoff) => ({ dropoff, distance: distanceMetersBetween(shop, dropoff) }))
    .sort((left, right) => right.distance - left.distance)[0];
  return { ...farthest, feeMinor: deliveryFeeForDistance(farthest.distance, store.settings) };
}

function clientCartQuote(store, cart, lines) {
  const reasons = [];
  if (!lines.length) reasons.push({ code: "cart_empty" });
  const subtotals = lines.map((line) => {
    const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
    const profile = (store.supplierProfiles || []).find((row) => row.userId === line.supplierId);
    const unavailable = !item || item.supplierId !== line.supplierId || !profile?.shop || profile.isClosed
      || catalogItemBlockers(store, item, { publicOnly: true }).length;
    const amount = unavailable ? null : cartLineSubtotal(store, line);
    if (amount == null) reasons.push({ lineId: line.id, code: unavailable ? "catalog_item_stale" : "line_unpriced" });
    return amount;
  });

  const grouped = new Map();
  for (const line of lines) {
    if (!grouped.has(line.supplierId)) grouped.set(line.supplierId, []);
    grouped.get(line.supplierId).push(line);
  }
  const clientItemSubtotalMinor = subtotals.some((amount) => amount == null) ? null
    : addMinor([...grouped.values()].map((entries) => clientMoneyMinor(store,
      addMinor(entries.map((line) => subtotals[lines.indexOf(line)]), "quote.groupItems"))), "quote.items");
  const deliveryLines = cart.fulfillmentMode === "pickup" ? [] : [...grouped.entries()].map(([supplierId, entries]) => {
    const delivery = cartDelivery(store, cart, supplierId, entries);
    const lineIds = entries.map((line) => line.id);
    if (delivery.error) reasons.push({ lineIds, code: delivery.error });
    const distanceZone = delivery.error ? null : distanceZoneForDistance(delivery.distance, store.settings);
    return {
      lineIds, distanceZone, deliveryFeeMinor: delivery.feeMinor ?? null,
      ...(distanceZone?.key === "out_of_zone" ? { distanceKm: Number((delivery.distance / 1000).toFixed(1)) } : {}),
    };
  });
  const hubPickup = cart.requestFulfillment?.fulfillmentMode === "pickup" ? publicHubPickup(store.settings) : null;
  const deliveryFeeMinor = deliveryLines.some((line) => line.deliveryFeeMinor == null) ? null
    : addMinor([...deliveryLines.map((line) => line.deliveryFeeMinor), hubPickup?.feeMinor ?? 0], "quote.delivery");
  const totalMinor = reasons.length || clientItemSubtotalMinor == null || deliveryFeeMinor == null ? null
    : addMinor([clientItemSubtotalMinor, deliveryFeeMinor], "quote.total");
  const downpaymentPercent = grouped.size > 1 ? 100 : downpaymentPercentSetting(store.settings);
  const downpaymentMinor = totalMinor == null ? null : roundBps(totalMinor, downpaymentPercent * 100);
  return {
    status: totalMinor == null ? "incomplete" : "priced", reasons,
    clientItemSubtotalMinor, deliveryLines, deliveryFeeMinor, totalMinor,
    ...(hubPickup ? { pickupFeeMinor: hubPickup.feeMinor } : {}),
    downpaymentPercent, downpaymentMinor, balanceMinor: totalMinor == null ? null : totalMinor - downpaymentMinor,
  };
}

function publicCart(store, cart, at, { compactListings = false } = {}) {
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
    if (listing) {
      const shop = (store.supplierProfiles || []).find((row) => row.userId === item.supplierId)?.shop;
      const dropoff = cart.requestFulfillment?.dropoff ?? line.dropoff ?? cart.defaultDropoff;
      const distance = shop && dropoff ? distanceMetersBetween(shop, dropoff) : null;
      listing.distanceZone = distance == null ? null : distanceZoneForDistance(distance, store.settings);
      if (listing.distanceZone?.key === "out_of_zone") listing.distanceKm = Number((distance / 1000).toFixed(1));
      const rating = publicShopRating(store, item.supplierId);
      if (rating) listing.rating = rating;
    }
    // Through the pricing engine, not a multiplication: the basket and the
    // invoice have to agree, and a measured or tiered line does not fit in a
    // unit price times a quantity. `lineSubtotalMinor` stays the shop figure;
    // the client reads `clientLineSubtotalMinor`.
    const lineSubtotalMinor = cartLineSubtotal(store, line);
    return {
      id: line.id,
      supplierId: line.supplierId,
      catalogItemId: line.catalogItemId,
      quantity: line.quantity,
      optionIds: [...(line.optionIds || [])],
      measurement: line.measurement ? { ...line.measurement } : null,
      structuredSpec: structuredClone(line.structuredSpec || {}),
      artworkFileId: line.artworkFileId ?? null,
      artworkLinks: structuredClone(line.artworkLinks || []),
      mockupFileId: line.mockupFileId ?? null,
      dropoff: line.dropoff ? { ...line.dropoff } : null,
      sortOrder: line.sortOrder,
      listing,
      promiseBy: cartLinePromiseBy(store, line, item, at),
      lineSubtotalMinor,
      clientLineSubtotalMinor: clientMoneyMinor(store, lineSubtotalMinor),
    };
  });
  const supplierIds = [...new Set(lines.map((line) => line.supplierId))];
  const pickupShares = splitBasketFee(cart.requestFulfillment?.fulfillmentMode === "pickup" ? publicHubPickup(store.settings).feeMinor : 0, supplierIds.length);
  const groups = supplierIds.map((supplierId, index) => {
    const groupLines = lines.filter((line) => line.supplierId === supplierId);
    const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
    const dropoffs = groupLines.map((line) => line.dropoff || cart.defaultDropoff);
    const deliveryFeeMinor = cart.fulfillmentMode === "pickup" ? pickupShares[index]
      : profile?.shop && dropoffs.every(Boolean)
        ? deliveryFeeForDistance(Math.max(...dropoffs.map((dropoff) => distanceMetersBetween(profile.shop, dropoff))), store.settings) : null;
    const amounts = groupLines.map((line) => cartLineSubtotal(store, line));
    const itemSubtotalMinor = amounts.some((amount) => amount == null) ? null : addMinor(amounts, "group.itemSubtotalMinor");
    const serviceFeeMinor = itemSubtotalMinor == null ? null : roundBps(itemSubtotalMinor, store.settings.serviceFeeRateBps);
    return { id: groupLines[0].id, label: shopLabel(index), lineIds: groupLines.map((line) => line.id),
      ...(cart.requestFulfillment?.fulfillmentMode === "pickup" ? { pickupFeeMinor: pickupShares[index] } : {}),
      clientItemSubtotalMinor: itemSubtotalMinor == null ? null : addMinor([itemSubtotalMinor, serviceFeeMinor], "group.clientItems"), deliveryFeeMinor,
      totalMinor: deliveryFeeMinor == null || itemSubtotalMinor == null ? null : addMinor([itemSubtotalMinor, serviceFeeMinor, deliveryFeeMinor], "group.totalMinor") };
  });
  if (groups.length > 1) {
    for (const line of publicLines) {
      line.groupId = groups.find((group) => group.lineIds.includes(line.id)).id;
      delete line.supplierId;
      if (line.listing) {
        delete line.listing.supplierId;
        delete line.listing.supplierServiceId;
        delete line.listing.shop;
      }
    }
  }
  return {
    id: cart.id,
    state: cart.state,
    version: cart.version,
    serviceLevel: cart.serviceLevel,
    scheduledFor: cart.scheduledFor ?? null,
    deadline: cart.deadline ?? null,
    fulfillmentMode: cart.fulfillmentMode,
    requestFulfillment: cart.requestFulfillment ? structuredClone(cart.requestFulfillment) : null,
    ...(cart.requestFulfillment?.fulfillmentMode === "pickup" ? { hubPickup: publicHubPickup(store.settings) } : {}),
    defaultDropoff: cart.defaultDropoff ? { ...cart.defaultDropoff } : null,
    lines: publicLines,
    shops: groups.length > 1 ? groups.map(({ id, label }) => ({ id, label })) : cartShops(store, lines),
    groups,
    ...(cart.checkedOutOrderId && basketForOrder(store, cart.checkedOutOrderId) ? { basketId: basketForOrder(store, cart.checkedOutOrderId).id } : {}),
    clientQuote: cart.state === "draft" ? clientCartQuote(store, cart, lines) : null,
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
  assertRequestFulfillment(current, body);
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
  let deadline = current.deadline ?? null;
  if (Object.hasOwn(body, "deadline")) {
    if (typeof body.deadline !== "string" || !Number.isFinite(Date.parse(body.deadline))) fail(400, "invalid_deadline", "deadline must be an ISO date-time.");
    deadline = new Date(body.deadline).toISOString();
  }
  return { fulfillmentMode, serviceLevel, scheduledFor, defaultDropoff, deadline };
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
      shop: order.basketId ? { label: order.groupLabel } : publicSupplierShop(store, job.supplierId),
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
    ...(order.basketId ? { basketId: order.basketId, groupLabel: order.groupLabel } : {}),
    state: order.state,
    ...(order.basketId ? { clientItemSubtotalMinor: order.supplierSubtotalMinor + order.serviceFeeMinor } : {
      itemSubtotalMinor: order.supplierSubtotalMinor,
      serviceFeeRateBps: order.serviceFeeRateBps,
      serviceFeeMinor: order.serviceFeeMinor,
    }),
    deliveryFeeMinor: order.deliveryFeeMinor,
    totalMinor: order.totalMinor,
    fulfillmentMode: order.fulfillmentMode,
    ...(order.requestFulfillment ? { requestFulfillment: structuredClone(order.requestFulfillment) } : {}),
    ...(order.hubPickup ? { hubPickup: structuredClone(order.hubPickup), pickupFeeMinor: order.pickupFeeMinor } : {}),
    serviceLevel: order.serviceLevel,
    scheduledFor: order.scheduledFor ?? null,
    // The promised date, never the shop's own. A client who can see both can
    // see the allowance.
    readyBy: order.promiseBy ?? null,
    downpaymentPercent: orderDownpaymentPercent(order),
    paymentPlan: {
      method: "qr_manual",
      downpaymentPercent: orderDownpaymentPercent(order),
      downpaymentMinor: order.payments.initial.amountMinor,
      balanceMinor: order.payments.final_online.amountMinor,
      downpaymentStatus: order.payments.initial.status,
      balanceStatus: order.payments.final_online.status,
    },
    jobs,
    invoiceNumber: order.invoiceNumber,
    organizationOfficer: structuredClone(order.organizationOfficer || null),
    fileCheck: { status: order.fileCheck.status, requestedAt: order.fileCheck.requestedAt, waitingSeconds: fileCheckProjection(order).waitingSeconds },
    createdAt: order.createdAt,
  };
}

function invoiceNumber(orderId, at) {
  const stamp = String(at).slice(0, 10).replaceAll("-", "");
  return `GG-${stamp}-${orderId.replace(/^ord_/, "").toUpperCase()}`;
}

function checkout(store, user, cart, body, createId, at, req, { groupLines = null, basketId = null, groupLabel = null, pickupFeeMinor = null } = {}) {
  assertRequestFulfillment(cart, body);
  const payment = record(body.payment, "payment");
  if (payment.method !== "qr_manual") {
    fail(400, "payment_method_not_allowed", "Checkout accepts QR Ph manual payment only.", { allowed: ["qr_manual"] });
  }
  const reference = text(payment.reference, "payment.reference", 100);
  const proof = fileFor(store, user, text(payment.proofFileId, "payment.proofFileId", 120), "payment_proof", "payment.proofFileId");
  const cartLines = (groupLines || store.cartLines || [])
    .filter((line) => line.cartId === cart.id)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  if (cartLines.length === 0) fail(409, "cart_empty", "Add at least one listing before checkout.");
  const orderId = createId("ord");
  // Snapshotted here, like the rider delivery split: the setting moving later
  // never changes what this client owes.
  const downpaymentPercent = basketId ? 100 : downpaymentPercentSetting(store.settings);
  const order = {
    id: orderId,
    clientId: user.id,
    organizationOfficer: officerSnapshot(store, user.id),
    ...(basketId ? { basketId, groupLabel, basketDeadline: cart.deadline } : {}),
    // One shop per order, known since the match. It was null here, with the
    // shop recorded per job instead -- which is why no supplier surface ever
    // showed a checkout order: every one of them reads order.supplierId.
    supplierId: null,
    riderId: null,
    // Money first. Operations confirms the transfer, then checks the artwork,
    // and only then does the shop see the job.
    state: "initial_payment_review",
    fileCheck: { status: "pending", requestedAt: at, reviewedAt: null, reviewedBy: null, reason: null },
    supplierSubtotalMinor: 0,
    subtotalMinor: 0,
    serviceFeeRateBps: store.settings.serviceFeeRateBps,
    serviceFeeMinor: 0,
    deliveryFeeMinor: 0,
    totalMinor: 0,
    fulfillmentMode: cart.fulfillmentMode,
    ...(cart.requestFulfillment ? { requestFulfillment: structuredClone(cart.requestFulfillment) } : {}),
    ...(cart.requestFulfillment?.fulfillmentMode === "pickup"
      ? { hubPickup: { ...publicHubPickup(store.settings), feeMinor: pickupFeeMinor ?? publicHubPickup(store.settings).feeMinor },
        pickupFeeMinor: pickupFeeMinor ?? publicHubPickup(store.settings).feeMinor } : {}),
    // The order-match QR plan. The name predates 100 percent checkout; the
    // split this order was placed under is `downpaymentPercent`.
    paymentPlan: "order_match_qr_75_25",
    downpaymentPercent,
    quoteVersion: 1,
    // The share of the shop's own price the first payment carries. Payout
    // stages are capped against supplier principal the client has actually
    // paid, so the platform never releases its own money.
    supplierDownpaymentRateBps: downpaymentPercent * 100,
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
    assertPrinterCap(store, item, { line, optionIds: line.optionIds, measurement: line.measurement, structuredSpec: line.structuredSpec });
    validateArtworkLinks(line.artworkLinks || [], listing.acceptedFormats);
    if (!line.artworkFileId && !(line.artworkLinks || []).length) {
      fail(409, "artwork_required", "Upload artwork or add a publicly viewable design link before checkout.", { lineId: line.id, field: "artwork" });
    }
    if (line.artworkFileId) {
      const file = fileFor(store, user, line.artworkFileId, "artwork", "artworkFileId");
      if (file.artworkCheck?.status !== "passed") fail(409, "artwork_file_check_failed",
        file.artworkCheck?.message || "This artwork has not passed its file check. Upload the original file again and replace the cart artwork.",
        { lineId: line.id, fileId: file.fileId, field: "artwork", reason: file.artworkCheck?.reason || "file_check_required" });
    }
    const links = line.artworkLinks || [];
    if (links.length && req[checkoutChecks]?.get(line.id) !== artworkFingerprint(line)) {
      fail(409, "artwork_check_required", "The cart artwork changed while being checked. Retry checkout to check the current links.", { lineId: line.id, field: "artwork" });
    }
    if (line.mockupFileId) fileFor(store, user, line.mockupFileId, "mockup", "mockupFileId");
    if (!grouped.has(line.supplierId)) grouped.set(line.supplierId, []);
    grouped.get(line.supplierId).push({ line, item, listing });
  }

  const jobs = [];
  const snapshots = [];
  for (const [supplierId, entries] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
    if (!profile?.shop || profile.isClosed) fail(409, "shop_unavailable", "A shop in this cart is no longer available.", basketId ? { groupLabel } : { supplierId });
    const delivery = cartDelivery(store, cart, supplierId, entries.map(({ line }) => line));
    if (delivery.error) fail(409, delivery.error, "Set a delivery drop-off for every cart line.");
    const { dropoff: jobDropoff, distance, feeMinor: deliveryFeeMinor } = delivery;
    const jobId = createId("job");
    const jobSnapshots = entries.map(({ line, item, listing }) => {
      const snapshot = createOrderLineSnapshot(store, {
        orderId,
        lineItemId: line.id,
        catalogItemId: item.id,
        expectedVersion: item.version,
        expectedServiceVersion: listing.serviceVersion,
        optionIds: line.optionIds || [],
        measurement: line.measurement || null,
        quantity: line.quantity,
        structuredSpec: line.structuredSpec || {},
        createdAt: at,
        sortOrder: line.sortOrder,
      }, createId);
      snapshot.lineItem.jobId = jobId;
      snapshot.lineItem.artworkLinks = structuredClone(line.artworkLinks || []);
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
      ...deliverySplit(deliveryFeeMinor, order.hubPickup ? 0 : (store.settings.riderCommissionBps ?? 8_500)),
      estimatedHours, ...(cart.scheduledFor ? { scheduledFor: cart.scheduledFor } : {}),
      createdAt: at, updatedAt: at,
    };
    jobs.push(job);
    snapshots.push(...jobSnapshots);
  }

  // Snapshot the same queue/calendar projection used by matching and the cart,
  // before adding this order's own jobs to the committed queue.
  const [job] = jobs;
  const orderedUnits = snapshots.reduce((total, row) => total + Number(row.lineItem.quantity || 0), 0);
  const { projection } = projectShopFinish(store, {
    supplierId: job.supplierId,
    turnaroundHours: job.estimatedHours,
    now: at,
    units: orderedUnits,
  });
  for (const line of cartLines) {
    if ((cart.deadline || line.matchDeadline) && !fitsDeadline(projection, cart.deadline || line.matchDeadline)) {
      fail(409, "deadline_not_met", "This cart can no longer make the requested deadline; match again.");
    }
  }
  order.supplierId = job.supplierId;
  order.pickup = { ...job.pickup };
  // The shop's own date, which it is held to. Never shown to the client.
  order.readyBy = projection.readyBy;
  // The padded date the client was promised. Never shown to the shop.
  order.promiseBy = projection.promiseBy;

  const itemSubtotalMinor = addMinor(jobs.map((job) => job.supplierSubtotalMinor), "order.itemSubtotalMinor");
  // Pickup is a per-order platform charge. The internal trip to the hub keeps
  // the existing zero-charge job contract and never earns a share of this fee.
  const deliveryTotalMinor = addMinor([...jobs.map((job) => job.deliveryFeeMinor), order.pickupFeeMinor ?? 0], "order.deliveryFeeMinor");
  const serviceFeeMinor = roundBps(itemSubtotalMinor, store.settings.serviceFeeRateBps);
  const totalMinor = addMinor([itemSubtotalMinor, serviceFeeMinor, deliveryTotalMinor], "order.totalMinor");
  const downpaymentRateBps = downpaymentPercent * 100;
  const downpaymentMinor = roundBps(totalMinor, downpaymentRateBps);
  const balanceMinor = totalMinor - downpaymentMinor;
  const upfront = balanceMinor === 0;
  Object.assign(order, {
    supplierSubtotalMinor: itemSubtotalMinor,
    subtotalMinor: itemSubtotalMinor,
    serviceFeeMinor,
    deliveryFeeMinor: deliveryTotalMinor,
    ...deliverySplit(deliveryTotalMinor, order.hubPickup ? 0 : (store.settings.riderCommissionBps ?? 8_500)),
    totalMinor,
    onlineDueMinor: totalMinor,
    supplierPlatformPayoutMinor: itemSubtotalMinor,
    payments: {
      initial: {
        amountMinor: downpaymentMinor, method: "qr_manual", status: "pending_confirmation",
        label: upfront ? "Full payment" : `${downpaymentPercent}% downpayment`,
        reference, proofFileId: proof.fileId, submittedAt: at,
      },
      // Kept on a paid-up-front order so the installment list has one shape;
      // `not_required` settles every gate that waits on the balance.
      final_online: {
        amountMinor: balanceMinor, method: "qr_manual", status: upfront ? "not_required" : "not_submitted",
        label: upfront ? "No balance" : `${100 - downpaymentPercent}% balance`,
        reference: null, proofFileId: null, submittedAt: null,
      },
    },
  });

  /*
   Splitting the two payments across what they are actually paying for.

   Each instalment settles the same proportion of every component, rather than
   clearing the fee and delivery out of the downpayment first. Both are honest
   allocations, but only this one leaves the downpayment covering its share of
   the shop's own price -- settling the fee first leaves it short, and the first
   payout stage is then refused as uncollected on every single order.

   The principal takes the rounding remainder because it is the figure payout
   releases are capped against; giving it the odd centavo can only ever be in
   the shop's favour.
  */
  const initialFeeMinor = roundBps(serviceFeeMinor, downpaymentRateBps);
  const initialDeliveryMinor = roundBps(deliveryTotalMinor, downpaymentRateBps);
  const initialPrincipalMinor = downpaymentMinor - initialFeeMinor - initialDeliveryMinor;
  order.paymentAllocations = [
    { paymentCode: "initial", component: "supplier_principal", amountMinor: initialPrincipalMinor },
    { paymentCode: "initial", component: "service_fee", amountMinor: initialFeeMinor },
    { paymentCode: "initial", component: "delivery_pass_through", amountMinor: initialDeliveryMinor },
    { paymentCode: "final_online", component: "supplier_principal", amountMinor: itemSubtotalMinor - initialPrincipalMinor },
    { paymentCode: "final_online", component: "service_fee", amountMinor: serviceFeeMinor - initialFeeMinor },
    { paymentCode: "final_online", component: "delivery_pass_through", amountMinor: deliveryTotalMinor - initialDeliveryMinor },
  ].filter((allocation) => allocation.amountMinor > 0);

  // The shop's escrow stages, from its own price and never the client's total.
  snapshotPayoutPlan(order, { supplierPlatformPayoutMinor: itemSubtotalMinor });

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
    organizationOfficer: structuredClone(order.organizationOfficer),
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
      artworkLinks: structuredClone(lineItem.artworkLinks || []),
      mockupFileId: cartLine.mockupFileId ?? null,
      dropoff: cartLine.dropoff ? { ...cartLine.dropoff } : null,
    })),
    itemSubtotalMinor,
    serviceFeeRateBps: store.settings.serviceFeeRateBps,
    serviceFeeMinor,
    deliveryLines: jobs.map((job) => ({ jobId: job.id, shopName: publicSupplierShop(store, job.supplierId)?.shopName || "Shop", amountMinor: job.deliveryFeeMinor })),
    deliveryFeeMinor: deliveryTotalMinor,
    ...(order.hubPickup ? { hubPickup: structuredClone(order.hubPickup), pickupFeeMinor: order.pickupFeeMinor } : {}),
    ...(order.requestFulfillment ? { requestFulfillment: structuredClone(order.requestFulfillment) } : {}),
    totalMinor,
    paymentPlan: { method: "qr_manual", downpaymentPercent, downpaymentMinor, balanceMinor },
  };
  if (!basketId) store.orderInvoices.push({ orderId, invoiceNumber: order.invoiceNumber, issuedAt: at, snapshot: invoice });
  if (!basketId) {
    cart.state = "checked_out";
    cart.checkedOutOrderId = orderId;
    cart.checkedOutAt = at;
    updateCart(cart, at);
  }
  store.auditLog ||= [];
  store.auditLog.push({
    id: createId("aud"), at, actorId: user.id, actorRole: "client", action: "order_match.checkout",
    entityType: "order", entityId: orderId, orderId,
    detail: { jobCount: jobs.length, itemSubtotalMinor, serviceFeeMinor, deliveryFeeMinor: deliveryTotalMinor, totalMinor },
  });
  notifyOpsJobNeedsQa(store, order, { createId, at });
  if (!basketId) {
    notifyOpsPaymentSubmitted(store, order, { createId, at });
    notifyClientReceiptReady(store, order, { createId, at });
  }
  queueOrderInvalidate(store, order, ["orders"]);
  return { order: publicMatchedOrder(store, order), invoice: clientInvoice(invoice) };
}

function checkoutBasket(store, user, cart, body, createId, at, req) {
  const lines = (store.cartLines || []).filter((line) => line.cartId === cart.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const suppliers = [...new Set(lines.map((line) => line.supplierId))];
  if (suppliers.length < 2) return checkout(store, user, cart, body, createId, at, req);
  if (!cart.deadline) fail(400, "basket_deadline_required", "Set one deadline for the basket before checkout.");
  const basketId = createId("bsk");
  const hubPickup = cart.requestFulfillment?.fulfillmentMode === "pickup" ? publicHubPickup(store.settings) : null;
  const pickupShares = splitBasketFee(hubPickup?.feeMinor ?? 0, suppliers.length);
  const results = suppliers.map((supplierId, index) => checkout(store, user, cart, body, createId, at, req, {
    groupLines: lines.filter((line) => line.supplierId === supplierId), basketId, groupLabel: shopLabel(index), pickupFeeMinor: hubPickup ? pickupShares[index] : null,
  }));
  const orders = results.map((result) => store.orders.find((order) => order.id === result.order.id));
  const first = orders[0];
  const basket = { id: basketId, clientId: user.id, receiptOrderId: first.id,
    orderIds: orders.map((order) => order.id), totalMinor: addMinor(orders.map((order) => order.totalMinor), "basket.totalMinor"),
    deadline: cart.deadline, fulfillmentMode: cart.fulfillmentMode,
    ...(hubPickup ? { pickupFeeMinor: hubPickup.feeMinor } : {}),
    payment: { ...first.payments.initial }, createdAt: at, updatedAt: at };
  delete basket.payment.amountMinor;
  store.baskets ||= [];
  store.baskets.push(basket);
  const invoice = { organizationOfficer: structuredClone(first.organizationOfficer), invoiceNumber: first.invoiceNumber, orderId: first.id, basketId, issuedAt: at, currency: "PHP",
    ...(hubPickup ? { hubPickup, pickupFeeMinor: hubPickup.feeMinor } : {}),
    ...(cart.requestFulfillment ? { requestFulfillment: structuredClone(cart.requestFulfillment) } : {}),
    lines: results.flatMap((result) => result.invoice.lines),
    groups: results.map((result, index) => ({ orderId: result.order.id, label: shopLabel(index),
      lines: result.invoice.lines, itemSubtotalMinor: result.invoice.itemSubtotalMinor,
      serviceFeeMinor: result.invoice.serviceFeeMinor, deliveryFeeMinor: result.invoice.deliveryFeeMinor, totalMinor: result.invoice.totalMinor,
      ...(hubPickup ? { pickupFeeMinor: pickupShares[index] } : {}) })),
    itemSubtotalMinor: addMinor(orders.map((order) => order.supplierSubtotalMinor), "basket.itemSubtotalMinor"),
    serviceFeeRateBps: first.serviceFeeRateBps,
    serviceFeeMinor: addMinor(orders.map((order) => order.serviceFeeMinor), "basket.serviceFeeMinor"),
    deliveryLines: results.flatMap((result, index) => result.invoice.deliveryLines.map((line) => ({ jobId: line.jobId, shopName: shopLabel(index), amountMinor: line.amountMinor }))),
    deliveryFeeMinor: addMinor(orders.map((order) => order.deliveryFeeMinor), "basket.deliveryFeeMinor"),
    totalMinor: basket.totalMinor,
    paymentPlan: { method: "qr_manual", downpaymentPercent: 100, downpaymentMinor: basket.totalMinor, balanceMinor: 0 },
  };
  for (const order of orders) order.invoiceNumber = first.invoiceNumber;
  store.orderInvoices.push({ orderId: first.id, invoiceNumber: first.invoiceNumber, issuedAt: at, snapshot: invoice });
  cart.state = "checked_out";
  cart.checkedOutOrderId = first.id;
  cart.checkedOutAt = at;
  updateCart(cart, at);
  store.auditLog.push({ id: createId("aud"), at, actorId: user.id, actorRole: "client",
    action: "basket.checkout", entityType: "basket", entityId: basket.id,
    detail: { orderIds: basket.orderIds, totalMinor: basket.totalMinor } });
  notifyOpsPaymentSubmitted(store, first, { createId, at });
  notifyClientReceiptReady(store, first, { createId, at });
  return { order: results[0].order, basket: publicBasket(store, basket, user), invoice: clientInvoice(invoice, { hideSupplierAmounts: true }) };
}

export function isOrderMatchRoute(method, pathname) {
  if (["/me/preferences", "/me/addresses", "/me/matches", "/me/matches/next", "/me/carts", "/me/deadline-days", "/me/catalog-quotes"].includes(pathname)) return true;
  if (/^\/me\/carts\/[^/]+(?:\/.*)?$/.test(pathname)) return true;
  if (method === "GET" && /^\/orders\/[^/]+\/invoice$/.test(pathname)) return true;
  return false;
}

export function isCartArtworkWrite(method, pathname) {
  return method === "POST" && /^\/me\/carts\/[^/]+\/lines$/.test(pathname)
    || method === "PATCH" && /^\/me\/carts\/[^/]+\/lines\/[^/]+$/.test(pathname);
}

// Server calls this before opening the mutation transaction. The actual route
// repeats authorization and format validation against its locked store snapshot.
export async function prepareCartArtworkLinks({ req, pathname, store, user, body, checker }) {
  if (!isCartArtworkWrite(req.method, pathname) || !hasShortArtworkLinks(body?.artworkLinks)) return;
  requireClient(user);
  const parts = pathname.split("/");
  const cart = ownCart(store, user, decodeURIComponent(parts[3]), { draft: true });
  let itemId = body.catalogItemId;
  if (req.method === "PATCH") {
    const line = (store.cartLines || []).find((row) => row.cartId === cart.id && row.id === decodeURIComponent(parts[5]));
    if (!line) fail(404, "cart_line_not_found", "That cart line no longer exists.");
    itemId = line.catalogItemId;
  }
  const item = (store.catalogItems || []).find((row) => row.id === itemId);
  body.artworkLinks = await resolveArtworkLinks(body.artworkLinks, item ? publicCatalogItem(store, item)?.acceptedFormats : [],
    checker || ((link) => checkArtworkLinkForUser(user.id, link)));
}

const checkoutChecks = Symbol("artworkCheckoutChecks");
const artworkFingerprint = line => JSON.stringify([line.artworkFileId || null, line.artworkLinks || []]);
export function isArtworkCheckout(method, pathname) {
  return method === "POST" && /^\/me\/carts\/[^/]+\/checkout$/.test(pathname);
}

// Probe fresh links for every checkout, including released clients that skip
// link-check. Bind results to this request and revalidate under the domain lock.
export async function prepareArtworkCheckout({ req, pathname, store, user, checker }) {
  if (!isArtworkCheckout(req.method, pathname)) return;
  requireClient(user);
  const cart = ownCart(store, user, decodeURIComponent(pathname.split("/")[3]), { draft: true });
  req[checkoutChecks] = new Map();
  for (const line of (store.cartLines || []).filter(row => row.cartId === cart.id)) {
    const item = (store.catalogItems || []).find(row => row.id === line.catalogItemId);
    const listing = item && publicCatalogItem(store, item);
    if (!listing) continue; // Locked checkout reports stale listings.
    const links = validateArtworkLinks(line.artworkLinks || [], listing.acceptedFormats);
    for (const link of links) {
      const check = await (checker || (link => checkArtworkLinkForUser(user.id, link)))(link);
      if (!check.ok) fail(409, "artwork_link_check_failed",
        `${check.message} Make the link viewable by anyone with the link, then retry checkout; or remove the link and upload the file instead.`,
        { lineId: line.id, field: "artwork", url: link.url, access: check.access });
    }
    req[checkoutChecks].set(line.id, artworkFingerprint(line));
  }
}

export async function routeOrderMatch(args) {
  if (!isOrderMatchRoute(args.req.method, args.url.pathname)) return null;
  const { store } = args;
  const view = approvedCatalogView(store);
  if (view === store) return routeOrderMatchApproved(args);
  const original = Object.fromEntries(CATALOG_REVIEW_TABLES.map(key => [key, store[key]]));
  try {
    for (const key of CATALOG_REVIEW_TABLES) store[key] = view[key];
    return await routeOrderMatchApproved(args);
  } finally {
    Object.assign(store, original);
  }
}

async function routeOrderMatchApproved({ req, url, store, user, readBody, id, now }) {
  const { pathname } = url;
  if (!isOrderMatchRoute(req.method, pathname)) return null;

  if (req.method === "GET" && /^\/orders\/[^/]+\/invoice$/.test(pathname)) {
    if (!user) fail(401, "unauthorized", "Sign in to view this invoice.");
    const orderId = pathname.split("/")[2];
    const order = (store.orders || []).find((row) => row.id === orderId);
    if (!order) fail(404, "order_not_found", "That order no longer exists.");
    const privileged = identityHasMembership(user, "ops_admin") || identityHasMembership(user, "super_admin");
    if (order.clientId !== user.id && !privileged) fail(403, "forbidden", "That invoice belongs to another client.");
    const receiptOrderId = basketForOrder(store, orderId)?.receiptOrderId || orderId;
    const invoice = (store.orderInvoices || []).find((row) => row.orderId === receiptOrderId);
    if (!invoice) fail(404, "invoice_not_found", "This order does not have an invoice.");
    const snapshot = clientInvoice(invoice.snapshot, { hideSupplierAmounts: Boolean(basketForOrder(store, orderId)) && !privileged });
    // Invoices issued before the snapshot carried the split were all 75/25.
    if (snapshot.paymentPlan && snapshot.paymentPlan.downpaymentPercent == null) {
      snapshot.paymentPlan.downpaymentPercent = orderDownpaymentPercent(order);
    }
    return { status: 200, body: { invoice: snapshot }, mutated: false };
  }

  requireClient(user);
  if (req.method === "POST" && pathname === "/me/catalog-quotes") {
    const body = record(await readBody(req));
    const item = (store.catalogItems || []).find((row) => row.id === body.catalogItemId);
    if (!item || catalogItemBlockers(store, item, { publicOnly: true }).length) {
      fail(404, "catalog_item_not_found", "That listing is no longer available.");
    }
    // Speed selection is not part of the current cart/checkout contract.
    if (body.speedTier != null || body.speedTierId != null) fail(400, "invalid_service_level", "Speed selection is not supported by checkout.");
    const optionIds = body.optionIds ?? [];
    if (!Array.isArray(optionIds)) fail(400, "invalid_catalog_options", "optionIds must be an array.");
    const quantity = positiveInteger(body.quantity, "quantity");
    const measurement = measurementFor(item, body);
    const structuredSpec = body.structuredSpec == null ? {} : record(body.structuredSpec, "structuredSpec");
    assertPrinterCap(store, item, { optionIds, measurement, structuredSpec });
    const { selectedOptions } = selectedCatalogPrice(store, item, optionIds);
    const priced = priceCatalogSelection(store, item, { selectedOptions, quantity, measurement });
    const service = store.supplierServices.find((row) => row.id === item.supplierServiceId);
    return { status: 200, body: { quote: {
      catalogItemId: item.id, version: item.version, serviceVersion: service.version || 1, quantity: priced.quantity,
      clientUnitRateMinor: clientMoneyMinor(store, priced.unitRateMinor),
      clientLineSubtotalMinor: clientMoneyMinor(store, priced.lineSubtotalMinor),
      billableMilliUnits: priced.billableMilliUnits, minimumMeasurementApplied: priced.minimumMeasurementApplied,
    } }, mutated: false };
  }
  const quoteMatch = /^\/me\/carts\/([^/]+)\/quote$/.exec(pathname);
  if (quoteMatch && ["GET", "POST"].includes(req.method)) {
    const cart = ownCart(store, user, decodeURIComponent(quoteMatch[1]), { draft: true });
    const body = req.method === "POST" ? record(await readBody(req)) : {};
    const preview = { ...cart, ...fulfillmentInput(body, cart) };
    const lines = (store.cartLines || []).filter((line) => line.cartId === cart.id).map((line) => ({ ...line }));
    if (body.lines != null) {
      if (!Array.isArray(body.lines)) fail(400, "invalid_request", "lines must be an array.");
      for (const input of body.lines) {
        record(input, "line");
        const line = lines.find((row) => row.id === input.lineId);
        if (!line) fail(404, "cart_line_not_found", "A cart line no longer exists.");
        assertRequestFulfillment(cart, input);
        line.dropoff = point(input.dropoff, "dropoff", { required: false });
      }
    }
    return { status: 200, body: { quote: clientCartQuote(store, preview, lines) }, mutated: false };
  }
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

  if (req.method === "GET" && pathname === "/me/deadline-days") {
    // Which days GRIDGO could make, for one kind of work. Read-only, and it
    // returns dates rather than shops: the queues and capacities behind the
    // answer are the shops' own, and a client is never told how many print
    // something.
    const subcategoryCode = text(url.searchParams.get("subcategoryCode"), "subcategoryCode", 120);
    // Four months. A print deadline is regularly further out than a fortnight
    // -- a graduation, a launch, a fiesta -- and a window that stops at six
    // weeks reads to a client as "GRIDGO does not go that far", which is a
    // limit of the calendar rather than of the shops.
    const days = Math.min(126, Math.max(7, Number(url.searchParams.get("days")) || 120));
    return {
      status: 200,
      body: deadlineDays(store, { subcategoryCode, now: now(), days }),
    };
  }
  if (req.method === "POST" && ["/me/matches", "/me/matches/next"].includes(pathname)) {
    const body = record(await readBody(req));
    if (pathname.endsWith("/next") && (!Array.isArray(body.excludedSupplierIds) || body.excludedSupplierIds.length === 0)) {
      fail(400, "excluded_shops_required", "Send at least one already-seen shop id.", { field: "excludedSupplierIds" });
    }
    if (body.excludedSupplierIds != null && !Array.isArray(body.excludedSupplierIds)) {
      fail(400, "invalid_excluded_shops", "excludedSupplierIds must be an array.");
    }
    const cartId = body.cartId == null ? null : String(body.cartId);
    const cartLines = cartId
      ? (store.cartLines || []).filter((row) => row.cartId === cartId)
      : [];
    const matchCart = cartId ? ownCart(store, user, cartId, { draft: true }) : null;
    if (matchCart?.deadline && body.deadline && Date.parse(matchCart.deadline) !== Date.parse(body.deadline)) {
      fail(409, "basket_deadline_mismatch", "Use the basket deadline when matching.");
    }
    const at = now();
    let requestFulfillment = matchCart?.requestFulfillment ?? null;
    if (Object.hasOwn(body, "fulfillmentMode")) {
      if (!["delivery", "pickup"].includes(body.fulfillmentMode)) {
        fail(400, "invalid_fulfillment_mode", "Choose delivery or pickup before matching.");
      }
      if (matchCart) assertRequestFulfillment(matchCart, body);
      const dropoff = body.fulfillmentMode === "pickup" ? gridgoOfficePoint() : addressPoint(store, user.id, body) ?? matchCart?.defaultDropoff;
      if (!dropoff) fail(400, "dropoff_required", "Choose a delivery drop-off before matching.");
      requestFulfillment = { fulfillmentMode: body.fulfillmentMode, dropoff };
    }
    const groupLine = body.groupId == null ? null : cartLines.find((line) => line.id === body.groupId);
    if (body.groupId != null && !groupLine) fail(404, "cart_group_not_found", "That group does not belong to this cart.");
    const groupExclusions = groupLine ? (store.supplierProfiles || []).filter((profile) => profile.userId !== groupLine.supplierId).map((profile) => profile.userId) : [];
    const input = {
      subcategoryCode: body.subcategoryCode,
      ranking: body.ranking ?? publicPreference(store, user.id).ranking,
      dropoff: requestFulfillment?.dropoff ?? addressPoint(store, user.id, body) ?? matchCart?.defaultDropoff ?? null,
      excludedSupplierIds: [...(body.excludedSupplierIds || []), ...groupExclusions],
      deadline: matchCart?.deadline ?? body.deadline ?? null,
      units: body.units == null ? undefined : positiveInteger(body.units, "units"),
      now: at, measurement: body.measurement, structuredSpec: body.structuredSpec,
      optionIds: body.optionIds, widthFeet: body.widthFeet, cartLines,
    };
    const match = clientFacingMatch(matchShop(store, input));
    if (requestFulfillment) {
      match.requestFulfillment = structuredClone(requestFulfillment);
      if (requestFulfillment.fulfillmentMode === "pickup") match.hubPickup = publicHubPickup(store.settings);
      for (const listing of [...match.listings, ...match.otherListings]) {
        const item = store.catalogItems.find((row) => row.id === listing.id);
        const shop = store.supplierProfiles.find((row) => row.userId === item.supplierId).shop;
        listing.deliveryFeeMinor = requestFulfillment.fulfillmentMode === "pickup"
          ? match.hubPickup.feeMinor : deliveryFeeForDistance(distanceMetersBetween(shop, input.dropoff), store.settings);
        if (match.hubPickup) listing.pickupFeeMinor = match.hubPickup.feeMinor;
      }
    }
    const requestId = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.parse(at) + 15 * 60_000).toISOString();
    // Keep expired records for a day so ordinary expiry has a distinct error.
    store.matchSelections = (store.matchSelections || []).filter((row) => Date.parse(row.expiresAt) > Date.parse(at) - 86_400_000);
    for (const listing of [...match.listings, ...match.otherListings]) {
      const token = randomBytes(32).toString("base64url");
      store.matchSelections.push({ tokenHash: selectionHash(token), clientId: user.id, requestId, expiresAt,
        selection: { catalogItemId: listing.id, supplierId: store.catalogItems.find((row) => row.id === listing.id).supplierId,
          cartId, deadline: input.deadline, dropoff: input.dropoff,
          ...(requestFulfillment ? { requestFulfillment } : {}),
          subcategoryCode: input.subcategoryCode, ranking: input.ranking } });
      listing.selectToken = token;
    }
    if (new Set(cartLines.map((line) => line.supplierId)).size > 1 || groupLine) {
      const suppliers = [...new Set(cartLines.map((line) => line.supplierId))];
      const selectedSupplier = match.shop?.supplierId;
      const index = suppliers.indexOf(selectedSupplier);
      match.shop = { label: shopLabel(index < 0 ? suppliers.length : index) };
      for (const listing of [...match.listings, ...match.otherListings]) {
        delete listing.supplierId;
        delete listing.supplierServiceId;
        delete listing.shop;
      }
    }
    return { status: 200, body: { ...match, matchRequestId: requestId, selectTokenExpiresAt: expiresAt }, mutated: true };
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
    return { status: 201, body: { cart: publicCart(store, cart, now()) }, mutated: true };
  }

  const cartMatch = /^\/me\/carts\/([^/]+)$/.exec(pathname);
  if (cartMatch && req.method === "GET") {
    const cart = ownCart(store, user, decodeURIComponent(cartMatch[1]));
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: false };
  }
  if (cartMatch && req.method === "PATCH") {
    const cart = ownCart(store, user, decodeURIComponent(cartMatch[1]), { draft: true });
    Object.assign(cart, fulfillmentInput(record(await readBody(req)), cart));
    updateCart(cart, now());
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: true };
  }

  const specialCartMatch = /^\/me\/carts\/([^/]+)\/(fulfillment|dropoffs|checkout)$/.exec(pathname);
  if (specialCartMatch && specialCartMatch[2] === "checkout" && req.method === "POST") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    const result = checkoutBasket(store, user, cart, record(await readBody(req)), id, now(), req);
    return { status: 201, body: result, mutated: true };
  }
  if (specialCartMatch && specialCartMatch[2] === "fulfillment" && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    Object.assign(cart, fulfillmentInput(record(await readBody(req)), cart));
    updateCart(cart, now());
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: true };
  }
  if (specialCartMatch && specialCartMatch[2] === "dropoffs" && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    const body = record(await readBody(req));
    assertRequestFulfillment(cart, body);
    if (Object.hasOwn(body, "defaultDropoff")) cart.defaultDropoff = point(body.defaultDropoff, "defaultDropoff", { required: false });
    if (body.lines != null) {
      if (!Array.isArray(body.lines)) fail(400, "invalid_request", "lines must be an array.", { field: "lines" });
      for (const input of body.lines) {
        const line = (store.cartLines || []).find((row) => row.id === input.lineId && row.cartId === cart.id);
        if (!line) fail(404, "cart_line_not_found", "A cart line no longer exists.", { lineId: input.lineId });
        assertRequestFulfillment(cart, input);
        line.dropoff = point(input.dropoff, "dropoff", { required: false });
        line.updatedAt = now();
      }
    }
    updateCart(cart, now());
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: true };
  }

  const linesMatch = /^\/me\/carts\/([^/]+)\/lines$/.exec(pathname);
  if (linesMatch && req.method === "POST") {
    const cart = ownCart(store, user, decodeURIComponent(linesMatch[1]), { draft: true });
    const body = { ...record(await readBody(req)) };
    const selection = resolveMatchSelection(store, user, cart, body, now());
    assertRequestFulfillment(cart, body);
    const item = (store.catalogItems || []).find((row) => row.id === text(body.catalogItemId, "catalogItemId", 120));
    if (!item || catalogItemBlockers(store, item, { publicOnly: true }).length) {
      fail(409, "catalog_item_stale", "That listing changed or is no longer public.");
    }
    if (!Array.isArray(body.optionIds)) fail(400, "invalid_catalog_options", "optionIds must be an array.", { field: "optionIds" });
    selectedCatalogPrice(store, item, body.optionIds);
    const at = now();
    const lines = (store.cartLines || []).filter((row) => row.cartId === cart.id);
    if (selection && (item.supplierId !== selection.supplierId || item.subcategoryCode !== selection.subcategoryCode)) {
      fail(409, "catalog_item_stale", "That listing changed since matching; match again.");
    }
    if (selection && (store.supplierProfiles || []).find((row) => row.userId === item.supplierId)?.isClosed) {
      fail(409, "catalog_item_stale", "That shop is no longer accepting work; match again.");
    }
    if (selection?.deadline && cart.deadline && Date.parse(selection.deadline) !== Date.parse(cart.deadline)) {
      fail(409, "basket_deadline_mismatch", "Match again using this basket's deadline.");
    }
    if (!cart.deadline && selection?.deadline) cart.deadline = selection.deadline;
    const measurement = measurementFor(item, body);
    const structuredSpec = body.structuredSpec == null ? {} : structuredClone(record(body.structuredSpec, "structuredSpec"));
    assertPrinterCap(store, item, { measurement, structuredSpec, optionIds: body.optionIds });
    const line = {
      id: id("cline"), cartId: cart.id, supplierId: item.supplierId, catalogItemId: item.id,
      optionIds: [...body.optionIds], quantity: positiveInteger(body.quantity, "quantity"),
      measurement,
      ...((cart.deadline || selection?.deadline) ? { matchDeadline: cart.deadline || selection.deadline } : {}),
      structuredSpec,
      sortOrder: lines.reduce((maximum, row) => Math.max(maximum, row.sortOrder), -1) + 1,
      createdAt: at, updatedAt: at,
    };
    assertCartLinePriceable(store, item, line);
    assertMatchDeadline(store, item, line, at);
    if (Object.hasOwn(body, "artworkLinks")) line.artworkLinks = validateArtworkLinks(body.artworkLinks, publicCatalogItem(store, item)?.acceptedFormats);
    if (body.artworkFileId != null) line.artworkFileId = fileFor(store, user, text(body.artworkFileId, "artworkFileId", 120), "artwork", "artworkFileId").fileId;
    if (body.dropoff != null) line.dropoff = point(body.dropoff, "dropoff");
    store.cartLines ||= [];
    store.cartLines.push(line);
    updateCart(cart, at);
    return { status: 201, body: { cart: publicCartForLineMutation(store, cart, at) }, mutated: true };
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
      return { status: 200, body: { cart: publicCartForLineMutation(store, cart, at) }, mutated: true };
    }
    const body = record(await readBody(req));
    const before = { quantity: line.quantity, optionIds: line.optionIds, measurement: line.measurement };
    assertRequestFulfillment(cart, body);
    if (Object.hasOwn(body, "quantity")) line.quantity = positiveInteger(body.quantity, "quantity");
    if (Object.hasOwn(body, "optionIds")) {
      if (!Array.isArray(body.optionIds)) fail(400, "invalid_catalog_options", "optionIds must be an array.", { field: "optionIds" });
      const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
      selectedCatalogPrice(store, item, body.optionIds);
      line.optionIds = [...body.optionIds];
    }
    if (Object.hasOwn(body, "measurement")) {
      const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
      // A measurement already on the line stands if this request does not
      // replace it, so `undefined` here means "leave it alone" and null means
      // the listing takes none at all.
      const measured = measurementFor(item, body, { required: false });
      if (measured !== undefined) line.measurement = measured;
    }
    if (Object.hasOwn(body, "structuredSpec")) line.structuredSpec = structuredClone(record(body.structuredSpec, "structuredSpec"));
    if (Object.hasOwn(body, "artworkFileId")) line.artworkFileId = body.artworkFileId == null ? null : fileFor(store, user, text(body.artworkFileId, "artworkFileId", 120), "artwork", "artworkFileId").fileId;
    if (Object.hasOwn(body, "dropoff")) line.dropoff = point(body.dropoff, "dropoff", { required: false });
    const patchedItem = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
    if (Object.hasOwn(body, "artworkLinks")) line.artworkLinks = validateArtworkLinks(body.artworkLinks, patchedItem ? publicCatalogItem(store, patchedItem)?.acceptedFormats : []);
    if (patchedItem) assertPrinterCap(store, patchedItem, { line, optionIds: line.optionIds, measurement: line.measurement, structuredSpec: line.structuredSpec });
    // Only a change to what the line is priced on is held to the shop's
    // minimum. Attaching artwork to a line the shop has since put out of reach
    // is still allowed; the quantity is fixed through the sheet, not here.
    const repriced = ["quantity", "optionIds", "measurement"].some((field) => Object.hasOwn(body, field));
    if (repriced && patchedItem) {
      try {
        assertCartLinePriceable(store, patchedItem, line);
      } catch (error) {
        Object.assign(line, before);
        throw error;
      }
    }
    line.updatedAt = at;
    updateCart(cart, at);
    return { status: 200, body: { cart: publicCartForLineMutation(store, cart, at) }, mutated: true };
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
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: true };
  }

  return null;
}
