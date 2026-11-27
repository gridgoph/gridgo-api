import { homeProfile, snapshotHomePrinter, homePrinterResponse } from './home-printers.js';
import { assertVerifiedCashShop } from "./supplier-verification.js";
import { shopPaused } from './shop-availability.js';
import { assertDocumentRequest } from './document-capabilities.js';
import { pingPrinterDemand } from './printer-demand.js';
import { isDeepStrictEqual } from 'node:util';
import { wantsPickupPin } from './pickup-pin.js';
import { expressCardPrice, expressPaymentMethods } from './express-shop-facts.js';
import { expressRates, expressLinePrice, expressPoint, expressShopList, assertExpressNightJob, expressGuide, updateExpressGuide, createExpressSnapshot, publicExpress, expressClientProjection, expressCatalogOptions } from './express-orders.js';
import { expressCheckoutFeeSchedule, homePrinterLimitMinor } from './express-checkout-rules.js';
import { beginAcceptFirst, assertAcceptFirstPayable } from './express-accept-first.js';
import { expressPrinterChoices, fastestPermittedPrinter } from './express-printers.js';
import { isReviewData, markReviewPayment, reviewCatalogView, REVIEW_CATALOG_TABLES } from './review-data.js';
import { approvalPolicy, recordApprovalProof } from './approval-proof.js';
import { publicColourQuote, publicColourListing } from './colour-projection.js';
import { parseQuantityMode } from './colour-pricing.js';
import { colourQuoteFor, queueLineColour } from './colour-analysis.js';
import { artworkAttachmentsFor, artworkFileIdsFor, artworkPreviewFileId, assertArtworkAttachmentLimit, validateArtworkAttachments, writeArtworkAttachments } from './artwork-attachments.js';
import { specialInstructions } from './special-instructions.js';
import { snapshotShopClock } from './shop-hours.js';
import { feeSchedule, feeSettings, groupLevelFee, serviceFeeMoney } from './service-fee.js';
import { voucherMoney, applyVoucherMoney, splitVoucherMinor } from './voucher-money.js';
import { clientVoucher } from './voucher-projection.js';
import { selectMemberPerk, withMemberPerk, publicPerkChoice, perkSnapshot, reserveMemberPerk } from './member-perks.js';
import { publicMemberPerk } from './member-perk-projection.js';
import { selectVoucher, settleVoucherInitial, reserveVoucher, releaseVoucherReservations, availableVouchers, addVoucherCode, publicVoucher, confirmVoucher } from './vouchers.js';
import { cashSettings, requireCashCheckout, cashFail } from './cash-policy.js';
import { createPayoutMilestones as cashPayoutStages } from './operational-model.js';
import { operatingClockSnapshot, reviewTiming, orderReviewTiming } from './operating-hours.js';
import { listingAcceptsArtwork } from "./file-formats.js";
import { DOCX_CONTENT_TYPE } from "./docx.js";
import { documentPagesFor } from "./document-pages.js";
import { assertCheckoutPrintLayout, listingPrintLayouts, parseCartPrintLayout, printLayoutCheck } from "./print-layout.js";
import { listingExpress } from "./express.js";
import { assertCheckoutCoverSpine, assertCoverFileAttached, coverSpineApplies, coverSpineRequiredSetting, coverSpineSnapshot, parseCoverSpine, publicCartCoverSpine, publicOrderCoverSpine } from "./hardbound-cover.js";
import { artworkColorsFor, colorTargetsFor, colorTargetsSnapshot, parseColorTargets } from "./color-targets.js";
import { cartGroups, lineDeadline, lineDeliveryKey, sameDelivery, groupDeadline, earliestDate, sharedDeadline, groupSummary } from "./cart-groups.js";
import { officerSnapshot } from "./client-applications.js";
import { approvedOrganization, organizationFeeMoney, publicOrganizationDiscount } from "./organization-money.js";
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
import { acceptArtworkWarnings, artworkGuidanceSnapshot, evaluateLineArtwork } from "./artwork-guidance.js";
import {
  identityHasMembership } from "./authorization-context.js";
import {
  catalogItemBlockers,
  catalogGroupsForItem,
  clientMoneyMinor,
  createOrderLineSnapshot,
  effectiveAcceptedFormats,
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
  cartGroupListings,
  deadlineDays,
  matchShop,
  multiplyMinor,
  projectListingGroup, listingTiming,
  validatePreferenceRanking,
} from "./order-match.js";
import {
  notifyClientReceiptReady,
  notifyOrderParties,
  notifyOpsJobNeedsQa,
  notifyOpsPaymentSubmitted,
} from "./client-order-notifications.js";
import { queueOrderInvalidate } from "./notifications.js";
import { grantQuoteListings, isQuoteListing } from "./quote-listings.js";
import { assertQuoteCheckout, markQuoteOrdered } from "./quote-requests.js";
import { notifyAdmins } from "./domain-events.js";
import {
  assertHeldPriceUsable, heldBatchPrice, heldPricingSnapshot, ownSampleBatch, publicSampleOffer,
  sampleBatchHoldDays, sampleDecisionSummary, sampleLinePriceMinor,
} from "./sample-first.js";

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
  if (kind === "pages") return null;
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

  if (kind === "length") return { length: positiveInteger(sent.length, "measurement.length") };
  return {
    width: positiveInteger(sent.width, "measurement.width"),
    height: positiveInteger(sent.height, "measurement.height"),
  };
}

/** What to ask for, in the client's terms, when a measurement is missing. */
const MEASUREMENT_PROMPTS = Object.freeze({
  pages: "Upload the document to read its page count.",
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

// The selection JSON owns this short-lived guarantee; no caller-supplied timing
// is trusted and no token secret needs to be stored on a cart line.
function schedulingWork(cart, lines) {
  return JSON.stringify(lines.map(line => ({ id: line.id, catalogItemId: line.catalogItemId,
    supplierId: line.supplierId, quantity: line.quantity, speedTierId: line.speedTierId ?? null,
    deadline: lineDeadline(cart, line), deliveryKey: lineDeliveryKey(line), optionIds: [...(line.optionIds || [])].sort(),
    measurement: line.measurement ?? null, structuredSpec: line.structuredSpec ?? {},
  })).sort((a, b) => a.id.localeCompare(b.id)), (_key, value) =>
    // JSONB normalizes object key order; compare values, never insertion order.
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

// An offer depends on its own delivery and on the shop's deliveries due no later
// than it; later deliveries never invalidate it. A new delivery has no lines yet.
const NEW_DELIVERY = Symbol("newDelivery");
function relevantSchedulingWork(cart, lines, supplierId, deliveryKey, deadline) {
  const shopLines = lines.filter(line => line.supplierId === supplierId);
  if (deadline == null) return shopLines;
  const included = new Set(cartGroups(cart, shopLines).filter(group => group.deliveryKey === deliveryKey
    || (group.deadline != null && Date.parse(group.deadline) <= Date.parse(deadline))).flatMap(group => group.lines));
  return shopLines.filter(line => included.has(line));
}
// The delivery an offer joins and the date that delivery would then work to.
function offerTarget(cart, lines, supplierId, { deliveryKey = null, separate = false, deadline = null }) {
  if (separate) return { deliveryKey: NEW_DELIVERY, deadline };
  const group = cartGroups(cart, lines.filter(line => line.supplierId === supplierId)).find(row => row.deliveryKey === deliveryKey);
  return { deliveryKey, deadline: earliestDate([deadline, group?.deadline]) };
}

function offeredGroupProjection(store, cart, lines, at) {
  const fingerprint = schedulingWork(cart, lines);
  const workload = schedulingWork(cart, relevantSchedulingWork(cart, (store.cartLines || []).filter(line => line.cartId === cart.id),
    lines[0].supplierId, lineDeliveryKey(lines[0]), groupDeadline(cart, lines)));
  const saved = (store.matchSelections || []).find(row => row.clientId === cart.clientId
    && Date.parse(row.expiresAt) > Date.parse(at) && row.selection.cartId === cart.id
    && row.selection.groupFingerprint === fingerprint && row.selection.workloadFingerprint === workload
    && row.selection.offeredProjection);
  return saved ? structuredClone(saved.selection.offeredProjection) : null;
}

function cartGroupProjection(store, cart, lines, at) {
  return offeredGroupProjection(store, cart, lines, at)
    ?? projectListingGroup(store, lines, { now: at, deadline: groupDeadline(cart, lines) }).projection;
}

function bindOfferedGroup(store, cart, line, selection) {
  if (!selection?.offeredProjection || line.quantity !== selection.units) return false;
  const existing = (store.cartLines || []).filter(row => row.cartId === cart.id);
  const group = existing.filter(row => sameDelivery(row, line));
  const workload = relevantSchedulingWork(cart, existing, line.supplierId,
    group.length ? lineDeliveryKey(line) : NEW_DELIVERY, groupDeadline(cart, [...group, line]));
  if (schedulingWork(cart, workload) !== selection.draftFingerprint) return false;
  selection.cartId = cart.id;
  selection.groupFingerprint = schedulingWork(cart, [...group, line]);
  selection.workloadFingerprint = schedulingWork(cart, [...workload, line]);
  return true;
}

// The product is checked inside its delivery, which works to the earliest date
// among its lines; other lines of the same delivery are passed as `siblings`.
function assertMatchDeadline(store, item, line, at, { cart = null, siblings = [] } = {}) {
  const lines = [...siblings.filter(row => row.id !== line.id), { ...line, catalogItemId: item.id }];
  const deadline = groupDeadline(cart, lines);
  if (!deadline) return;
  const { projection } = projectListingGroup(store, lines, { now: at, deadline });
  if (!fitsDeadline(projection, deadline)) {
    fail(409, "deadline_not_met", siblings.length
      ? "This delivery can no longer make its earliest deadline; choose a later date or deliver this product separately."
      : "This listing can no longer make the requested deadline.");
  }
}

// A client's "deliver separately" choice for one shop: every line of that shop
// in exactly one non-empty delivery. `split` is a shorthand for common choices.
function deliveryPartition(cart, shopLines, body) {
  const invalid = (message) => fail(400, "invalid_delivery_split", message, { field: "deliveries" });
  if (body.split != null) {
    if (body.deliveries != null) invalid("Send either split or deliveries, not both.");
    if (body.split === "none") return [shopLines];
    if (body.split !== "by_deadline") fail(400, "invalid_delivery_split", "split must be by_deadline or none.", { field: "split" });
    const byDate = new Map();
    for (const line of shopLines) {
      const date = lineDeadline(cart, line);
      if (!date) fail(400, "basket_deadline_required", "Set a deadline for every product before delivering by date.");
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(line);
    }
    return [...byDate.entries()].sort(([left], [right]) => Date.parse(left) - Date.parse(right)).map(([, part]) => part);
  }
  if (!Array.isArray(body.deliveries) || !body.deliveries.length || body.deliveries.length > shopLines.length) {
    invalid("Send deliveries as a list of line-ID lists, one per delivery.");
  }
  const seen = new Set();
  const parts = body.deliveries.map((part) => {
    if (!Array.isArray(part) || !part.length) invalid("Every delivery needs at least one product.");
    return part.map((lineId) => {
      const line = shopLines.find(row => row.id === lineId);
      if (!line || seen.has(lineId)) invalid("Each of this shop's products must be in exactly one delivery.");
      seen.add(lineId);
      return line;
    });
  });
  if (seen.size !== shopLines.length) invalid("Each of this shop's products must be in exactly one delivery.");
  // Stable cart order inside each delivery and between deliveries.
  const position = new Map(shopLines.map((line, index) => [line.id, index]));
  return parts.map(part => part.sort((left, right) => position.get(left.id) - position.get(right.id)))
    .sort((left, right) => position.get(left[0].id) - position.get(right[0].id));
}

function assertDeliveryDeadline(store, cart, lines, at) {
  const deadline = groupDeadline(cart, lines);
  if (!deadline) return;
  let projection;
  try {
    projection = projectListingGroup(store, lines, { now: at, deadline }).projection;
  } catch (error) {
    // A stale listing or closed calendar is reported on the cart and at checkout.
    if (error instanceof AvailabilityError || error instanceof MatchError || error.code === "speed_tier_unavailable") return;
    throw error;
  }
  if (!fitsDeadline(projection, deadline)) {
    fail(409, "deadline_not_met", "These products cannot all be ready by the earliest date in one delivery.",
      { lineIds: lines.map(line => line.id), deadline });
  }
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
  // The owner's accepted quote listings price in their own carts only.
  grantQuoteListings(store, user.id);
  return cart;
}

function fileFor(store, user, fileId, purpose, field) {
  const file = (store.files || []).find((row) => row.fileId === fileId);
  if (!file || file.ownerId !== user.id || file.state !== "ready" || file.purpose !== purpose || !file.objectKey
    || (['artwork', 'mockup'].includes(purpose) && file.savedFileDeletionRequestedAt)) {
    fail(409, "file_not_ready", `Choose your own ready ${purpose} file.`, { field });
  }
  return file;
}

function groupFileFor(store,user,cart,fileId) {
  const group=(store.expressGroups||[]).find(g=>g.cartId===cart.id&&g.hostId===user.id&&g.state==='checkout_open');
  const member=group&&(store.expressGroupMembers||[]).find(m=>m.groupId===group.id&&m.active&&m.files.some(f=>f.fileId===fileId));
  return fileFor(store,member?{id:member.userId}:user,fileId,'artwork','artworkFileId');
}

function assertListingArtwork(store, item, line) {
  for (const fileId of artworkFileIdsFor(line)) {
    const file = (store.files || []).find(row => row.fileId === fileId);
    if (!listingAcceptsArtwork(publicCatalogItem(store, item)?.acceptedFormats, file?.detectedContentType)) {
      fail(409, "artwork_file_format_not_accepted", "Choose an artwork file type accepted by this listing.",
        { lineId: line.id, fileId, field: "artwork" });
    }
  }
}

function syncDocumentPages(store, item, line, body, { required = false, previousFileId = line.artworkFileId } = {}) {
  if(line.expressPrint?.productType==='plans')item={...item,pricingUnit:'per_page'};
  const range = Object.hasOwn(body, "pageRange") ? body.pageRange
    : previousFileId !== line.artworkFileId ? null : line.documentPages?.range ?? null;
  const file = (store.files || []).find(row => row.fileId === line.artworkFileId && row.state === "ready" && row.purpose === "artwork");
  if (item.pricingUnit === "per_page" && file?.detectedContentType === DOCX_CONTENT_TYPE
      && !(Number.isSafeInteger(file.detected?.pageCount) && file.detected.pageCount > 0)) {
    if (previousFileId !== line.artworkFileId || Object.hasOwn(body, "measurement")) {
      line.documentPages = null;
      line.measurement = null;
    }
    if (body.measurement?.pages != null) {
      line.measurement = { pages: positiveInteger(body.measurement.pages, "measurement.pages") };
    }
  }
  const pages = documentPagesFor(store, item, line, range, { required });
  if (item.pricingUnit === "per_page") {
    line.documentPages = pages;
    line.measurement = pages ? { pages: pages.printed } : null;
  }
}

/**
 * What a basket line costs right now, priced the way checkout will price it.
 *
 * Null when the listing has gone: a line whose listing was withdrawn has no
 * price, and showing the last one it had is showing a price nobody will honour.
 */
function cartLineSubtotal(store, line) {
  if (line.expressPrint) return expressLinePrice(line).lineSubtotalMinor;
  // A sample costs the shop's sample price, whatever the intended batch is.
  if (line.sample) return sampleLinePriceMinor(store, line);
  const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
  if (!item) return null;
  try {
    if (heldBatchLine(line)) return heldLinePrice(store, item, line).lineSubtotalMinor;
    const { selectedOptions } = selectedCatalogPrice(store, item, line.optionIds || []);
    const documentPages = documentPagesFor(store, item, line);
    return priceCatalogSelection(store, item, {
      selectedOptions,
      quantity: line.quantity,
      artworkSelection: line,
      speedTier: listingTiming(store, item, line).tier,
      measurement: item.pricingUnit === "per_page" ? (documentPages ? { pages: documentPages.printed } : null) : line.measurement || null,
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
  if (line.sample) {
    if (sampleLinePriceMinor(store, line) == null) fail(409, "sample_unavailable", "This listing no longer offers a sample.", { lineId: line.id });
    // The batch the sample stands for must itself be orderable at its quantity.
    const { sample: _sample, ...batch } = line;
    return assertCartLinePriceable(store, item, { ...batch, quantity: line.sample.batchQuantity, speedTierId: line.sample.speedTierId ?? null });
  }
  if (heldBatchLine(line)) {
    heldLinePrice(store, item, line);
    return;
  }
  const { selectedOptions } = selectedCatalogPrice(store, item, line.optionIds || []);
  if (item.pricedByColour) {
    if (item.minimumOrderQuantity != null && line.quantity < item.minimumOrderQuantity) fail(409, "below_minimum_quantity", "This shop does not run an order that small.");
    return;
  }
  priceCatalogSelection(store, item, {
    selectedOptions,
    quantity: line.quantity,
    speedTier: listingTiming(store, item, line).tier,
    measurement: item.pricingUnit === "per_page" && !line.measurement ? { pages: 1 } : line.measurement || null,
  });
}

/** A rejected sample the client is re-sampling with changed specs. */
function replaceableDraft(store, user, draftId) {
  if (typeof draftId !== "string" || !draftId.trim()) fail(400, "invalid_sample", "replacesSampleBatchId must be a sample batch id.", { field: "replacesSampleBatchId" });
  const draft = ownSampleBatch(store, user, draftId.trim());
  if (draft.status !== "rejected" || draft.rejection?.next !== "resample") {
    fail(409, "sample_batch_not_resampleable", "Only a sample rejected for another sample can be replaced.", { status: draft.status });
  }
  if ((store.sampleBatchDrafts || []).some(row => row.previousDraftId === draft.id)) {
    fail(409, "sample_batch_already_resampled", "Another sample already replaces this one.");
  }
  return draft;
}

/** A batch line priced from its sample draft's held rules (not `current`). */
function heldBatchLine(line) {
  return Boolean(line.sampleBatchDraftId) && line.sampleBatchPricing !== "current";
}

function lineMeasurement(store, item, line, { fallbackPages = false } = {}) {
  if (item.pricingUnit !== "per_page") return line.measurement || null;
  const documentPages = documentPagesFor(store, item, line);
  return documentPages ? { pages: documentPages.printed } : fallbackPages ? { pages: 1 } : line.measurement || null;
}

function heldLinePrice(store, item, line) {
  const draft = (store.sampleBatchDrafts || []).find(row => row.id === line.sampleBatchDraftId);
  if (!draft) fail(409, "sample_batch_not_found", "That sample batch no longer exists.", { lineId: line.id });
  return heldBatchPrice(draft.heldPricing, { quantity: line.quantity, measurement: lineMeasurement(store, item, line, { fallbackPages: true }) });
}

/** Sample and held-batch lines arrive priced; everything else uses the listing engine. */
function sampleFirstPricedLine(store, item, line) {
  if (line.expressPrint) return expressLinePrice(line);
  if (line.sample) {
    const price = sampleLinePriceMinor(store, line);
    return { unit: "sample", quantity: 1, billableMilliUnits: 1000, unitRateMinor: price, lineSubtotalMinor: price };
  }
  if (heldBatchLine(line)) return heldLinePrice(store, item, line);
  return undefined;
}

function sampleFirstCartKind(lines) {
  return lines.some(line => line.sample || line.sampleBatchDraftId);
}

function publicCartListingStub(store, item, optionIds) {
  const selected = selectedCatalogPrice(store, item, optionIds);
  const fromPriceMinor = minimumCatalogPrice(store, item);
  return {
    id: item.id,
    name: item.name,
    supplierId: item.supplierId,
    subcategoryCode: item.subcategoryCode,
    pricingUnit: item.pricingUnit || "per_unit",
    measureUnit: item.measureUnit ?? null,
    fromPriceMinor: item.pricedByColour ? clientMoneyMinor(store,fromPriceMinor) : fromPriceMinor,
    effectivePriceMinor: selected.effectiveUnitPriceMinor,
    clientFromPriceMinor: clientMoneyMinor(store, fromPriceMinor),
    clientEffectivePriceMinor: clientMoneyMinor(store, selected.effectiveUnitPriceMinor),
    printerMaxWidthFeet: projectedPrinterMaxWidthFeet(item),
    printLayouts: listingPrintLayouts(item),
    ...(item.pricedByColour || item.oneColour || item.colourPricing ? {pricedByColour: item.pricedByColour === true, oneColour: item.oneColour === true, colourPricing: publicColourListing(item.colourPricing)} : {}),
    express: listingExpress(item),
    ...publicSampleOffer(store, item),
    coverSpineForm: coverSpineApplies(item),
    // Artwork opens from this response even when the client's listing cache is empty.
    acceptedFormats: effectiveAcceptedFormats(store, item),
    ...(item.pricingUnit === "per_page" ? { prepareFile: { recommendedDpi: { min: 300, max: 600 }, resolutionAffectsPrice: false } } : {}),
    optionGroups: catalogGroupsForItem(store, item.id, { includeInactiveOptions: false }).map((group) => ({
      id: group.id,
      name: group.name,
      kind: group.kind,
      required: group.required,
      sortOrder: group.sortOrder,
      options: group.options.map((option) => ({
        id: option.id,
        label: option.label,
        specBinding: option.specBinding ?? null,
        sortOrder: option.sortOrder,
      })),
    })),
    selectedOptions: selected.selectedOptions.map((option) => ({ id: option.id, label: option.label })),
  };
}

function assertPrinterCap(store, item, request) {
  assertDocumentRequest(store,item,request.line||request);
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

function cartLinePromiseBy(store, cart, line, item, at) {
  const profile = (store.supplierProfiles || []).find((row) => row.userId === line.supplierId);
  if (!item || item.supplierId !== line.supplierId || !profile?.shop || profile.isClosed || shopPaused(profile, at)
      || catalogItemBlockers(store, item, { publicOnly: true }).length) return null;
  try {
    const group = (store.cartLines || []).filter(row => row.cartId === cart.id && sameDelivery(row, line));
    return cartGroupProjection(store, cart, group.length ? group : [line], at).promiseBy;
  } catch (error) {
    // An unavailable calendar must not prevent the client from repairing a cart.
    if (error instanceof AvailabilityError || error.code === 'speed_tier_unavailable') return null;
    throw error;
  }
}

/**
 * The fulfillment a quote request was made for, resolved exactly as a match
 * resolves it: pickup is the GRIDGO hub point, delivery an owned address or pin.
 */
export function quoteRequestFulfillment(store, user, body) {
  const fulfillmentMode = body.fulfillmentMode ?? "delivery";
  if (!["delivery", "pickup"].includes(fulfillmentMode)) {
    fail(400, "invalid_fulfillment_mode", "Choose delivery or pickup.", { field: "fulfillmentMode" });
  }
  if (fulfillmentMode === "pickup" && store.settings?.hubPickupEnabled !== true) {
    fail(409, "hub_pickup_disabled", "Hub pickup is currently unavailable. Choose delivery.");
  }
  const dropoff = fulfillmentMode === "pickup" ? gridgoOfficePoint() : addressPoint(store, user.id, body);
  if (!dropoff) fail(400, "dropoff_required", "Choose a delivery drop-off for this quote.", { field: "dropoff" });
  return { fulfillmentMode, dropoff };
}

/**
 * Accepting a quote option: a fresh draft cart holding the option's private
 * whole-job listing, locked to the request's fulfillment like a matched cart.
 * Everything after this is the ordinary cart and checkout.
 */
export function openQuoteCart(store, user, { item, quantity, requestFulfillment, artworkFileIds = [], structuredSpec = {}, specialInstructions: notes = "" }, { id, at }) {
  const cart = {
    id: id("cart"), clientId: user.id, state: "draft", version: 1, serviceLevel: "standard", scheduledFor: null,
    fulfillmentMode: requestFulfillment.fulfillmentMode, deadline: null,
    defaultDropoff: requestFulfillment.fulfillmentMode === "delivery" ? { ...requestFulfillment.dropoff } : null,
    requestFulfillment: structuredClone(requestFulfillment), createdAt: at, updatedAt: at,
  };
  const line = {
    id: id("cline"), cartId: cart.id, supplierId: item.supplierId, catalogItemId: item.id, optionIds: [], quantity,
    measurement: null, structuredSpec: structuredClone(structuredSpec), speedTierId: null, sortOrder: 0, createdAt: at, updatedAt: at,
  };
  grantQuoteListings(store, user.id);
  const formats = publicCatalogItem(store, item)?.acceptedFormats;
  if (notes) line.specialInstructions = specialInstructions(notes);
  // The brief's own files start as the artwork; the client may replace them in the cart.
  const usable = artworkFileIds.filter(fileId => {
    const file = (store.files || []).find(row => row.fileId === fileId);
    return file?.ownerId === user.id && file.state === "ready" && file.purpose === "artwork"
      && listingAcceptsArtwork(formats, file.detectedContentType);
  });
  if (usable.length) writeArtworkAttachments(line, { artworkAttachments: usable.map(fileId => ({ kind: "file", fileId })) }, formats);
  for (const fileId of artworkFileIdsFor(line)) fileFor(store, user, fileId, "artwork", "artworkFileId");
  assertCartLinePriceable(store, item, line);
  store.carts ||= [];
  store.carts.push(cart);
  store.cartLines ||= [];
  store.cartLines.push(line);
  lockCartFeeSchedules(store, cart, at);
  updateCart(cart, at);
  return publicCart(store, cart, at);
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

// Snapshot the schedule on every priced line, bound to its shop delivery group.
// Removing the final line removes the lock; moving a line does not carry it to a new group.
// Snapshots taken while groups were shop + date keep their lock on the same line.
function groupFeeSettings(store, cart, lines, at) {
  const key = JSON.stringify([lines[0]?.supplierId, lineDeliveryKey(lines[0] || {})]);
  const saved = (lines.find(line => JSON.stringify(line.serviceFeeSnapshot?.groupKey) === key)
    ?? lines.find(line => legacyFeeKey(cart, line)))?.serviceFeeSnapshot;
  // Accept-first Express drafts use the Express fee rule; every other cart keeps the brackets.
  return feeSettings(store.settings, saved?.schedule || (lines.some(line => line.expressPrint?.routing)
    ? expressCheckoutFeeSchedule(store.settings) : feeSchedule(store.settings, at)));
}
function legacyFeeKey(cart, line) {
  const [supplierId, date] = line.serviceFeeSnapshot?.groupKey || [];
  return supplierId === line.supplierId && typeof date === "string" && !date.startsWith("dlv_")
    && date === lineDeadline(cart, line);
}
export function lockCartFeeSchedules(store, cart, at) {
  for (const group of cartGroups(cart, store.cartLines.filter(line => line.cartId === cart.id))) {
    if (group.lines.some(line => cartLineSubtotal(store, line) == null)) continue;
    const schedule = groupFeeSettings(store, cart, group.lines, at).serviceFeeSchedule;
    const groupKey = [group.supplierId, group.deliveryKey];
    for (const line of group.lines) line.serviceFeeSnapshot = { groupKey, schedule: structuredClone(schedule) };
  }
}

export function cartVoucherPlan(store, cart, lines, at) {
  const grouped = cartGroups(cart, lines);
  const pickupShares = splitBasketFee(cart.requestFulfillment?.fulfillmentMode === "pickup" ? publicHubPickup(store.settings).feeMinor : 0, grouped.length);
  const money = grouped.map((group, index) => {
    const amounts = group.lines.map(line => cartLineSubtotal(store, line));
    const supplierSubtotalMinor = amounts.some(amount => amount == null) ? null : addMinor(amounts, "voucher.items");
    const deliveryFeeMinor = cart.fulfillmentMode === "pickup" ? pickupShares[index] : cartDelivery(store, cart, group.supplierId, group.lines).feeMinor;
    if (supplierSubtotalMinor == null || deliveryFeeMinor == null) return null;
    return { supplierSubtotalMinor, deliveryFeeMinor, ...organizationFeeMoney(supplierSubtotalMinor, groupFeeSettings(store, cart, group.lines, at), approvedOrganization(store, cart.clientId)) };
  });
  if (money.some(group => !group)) return null;
  const voucherPlan = groupMoney => {
    const voucher = selectVoucher(store, cart, groupMoney, at);
    return { voucher, money: groupMoney, memberPerk: null, ...voucherMoney(groupMoney, voucher?.valueMinor || 0, voucher?.data) };
  };
  const plan = voucherPlan(money);
  const perk = selectMemberPerk(store, cart.clientId, money, at);
  if (!perk) return plan;
  // The larger of the organization discount and one member perk applies (a tie
  // keeps the discount and the perk use). A voucher still stacks on a perk, and
  // where a voucher already replaced the discount the perk is free to apply.
  const organizationMinor = addMinor(money.map(group => group.organizationDiscountMinor), 'perk.organizationDiscount');
  if (perk.amountMinor <= organizationMinor && !plan.voucherDiscountMinor) return plan;
  const withPerk = voucherPlan(withMemberPerk(money, perk));
  const totalOf = candidate => addMinor(candidate.groups.map(group => group.totalMinor), 'perk.total');
  // Never spend a use that changes nothing, such as under a voucher that covers everything.
  return totalOf(withPerk) < totalOf(plan)
    ? { ...withPerk, memberPerk: perk, discountKind: withPerk.discountKind ?? 'member_perk' } : plan;
}

function clientCartLineAmounts(store,cart,lines,at) {
  const amounts = new Map();
  for (const group of cartGroups(cart,lines)) {
    const subtotals = group.lines.map(line => cartLineSubtotal(store,line));
    if (subtotals.some(amount => amount == null)) {for (const line of group.lines) amounts.set(line.id,null);continue;}
    const settings = groupFeeSettings(store,cart,group.lines,at);
    if (groupLevelFee(settings.serviceFeeSchedule)) {
      const principal = addMinor(subtotals,'colour.groupPrincipal');
      const shares = splitVoucherMinor(clientMoneyMinor({settings},principal)-principal,subtotals);
      group.lines.forEach((line,index) => amounts.set(line.id,subtotals[index]+shares[index]));
    } else group.lines.forEach((line,index) => amounts.set(line.id,clientMoneyMinor({settings},subtotals[index])));
  }
  return amounts;
}

export function clientCartQuote(store, cart, lines, at) {
  const colourAmounts = clientCartLineAmounts(store,cart,lines,at);
  const reasons = [];
  if (!lines.length) reasons.push({ code: "cart_empty" });
  const subtotals = lines.map((line) => {
    const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
    const profile = (store.supplierProfiles || []).find((row) => row.userId === line.supplierId);
    const unavailable = !item || item.supplierId !== line.supplierId || !profile?.shop || profile.isClosed || shopPaused(profile, at)
      || catalogItemBlockers(store, item, { publicOnly: true }).length;
    const amount = unavailable ? null : cartLineSubtotal(store, line);
    if (amount == null) reasons.push({ lineId: line.id, code: unavailable ? "catalog_item_stale" : "line_unpriced" });
    return amount;
  });

  const grouped = cartGroups(cart, lines);
  const clientItemSubtotalMinor = subtotals.some((amount) => amount == null) ? null
    : addMinor(grouped.map(({ lines: entries }) => clientMoneyMinor({ settings: groupFeeSettings(store, cart, entries, at) },
      addMinor(entries.map((line) => subtotals[lines.indexOf(line)]), "quote.groupItems"))), "quote.items");
  const quoteShops = [...new Set(lines.map((line) => line.supplierId))];
  const deliveryLines = cart.fulfillmentMode === "pickup" ? [] : grouped.map(({ supplierId, deadline, deliveryNumber, shopDeliveryCount, lines: entries }) => {
    const delivery = cartDelivery(store, cart, supplierId, entries);
    const lineIds = entries.map((line) => line.id);
    if (delivery.error) reasons.push({ lineIds, code: delivery.error });
    const distanceZone = delivery.error ? null : distanceZoneForDistance(delivery.distance, store.settings);
    return {
      groupId: entries[0].id, label: shopLabel(quoteShops.indexOf(supplierId)), deliveryNumber, shopDeliveryCount,
      lineIds, deadline, distanceZone, deliveryFeeMinor: delivery.feeMinor ?? null,
      ...(distanceZone?.key === "out_of_zone" ? { distanceKm: Number((delivery.distance / 1000).toFixed(1)) } : {}),
    };
  });
  const hubPickup = cart.requestFulfillment?.fulfillmentMode === "pickup" ? publicHubPickup(store.settings) : null;
  const deliveryFeeMinor = deliveryLines.some((line) => line.deliveryFeeMinor == null) ? null
    : addMinor([...deliveryLines.map((line) => line.deliveryFeeMinor), hubPickup?.feeMinor ?? 0], "quote.delivery");
  let organizationDiscountMinor = subtotals.some((amount) => amount == null) ? null : addMinor(grouped.map(({ lines: entries }) => organizationFeeMoney(
    addMinor(entries.map((line) => subtotals[lines.indexOf(line)]), "quote.groupItems"), groupFeeSettings(store, cart, entries, at), approvedOrganization(store, cart.clientId)).organizationDiscountMinor), "quote.discount");
  let totalMinor = reasons.length || clientItemSubtotalMinor == null || deliveryFeeMinor == null ? null
    : addMinor([clientItemSubtotalMinor - organizationDiscountMinor, deliveryFeeMinor], "quote.total");
  const voucherPlan = totalMinor == null ? null : cartVoucherPlan(store, cart, lines, at);
  if (voucherPlan) {
    organizationDiscountMinor = voucherPlan.organizationDiscountMinor;
    totalMinor = addMinor(voucherPlan.groups.map(group => group.totalMinor), 'voucher.total');
  }
  const downpaymentPercent = grouped.length > 1 ? 100 : downpaymentPercentSetting(store.settings);
  let downpaymentMinor = totalMinor == null ? null : roundBps(totalMinor, downpaymentPercent * 100);
  if (voucherPlan?.voucher) {
    downpaymentMinor = addMinor(voucherPlan.money.map((group, index) => {
      const allocation = voucherPlan.groups[index], rate = downpaymentPercent * 100;
      const feeMinor = group.grossServiceFeeMinor - (group.memberPerkMinor ?? 0);
      return roundBps(addMinor([group.supplierSubtotalMinor, feeMinor, group.deliveryFeeMinor], 'voucher.gross'), rate)
        - Math.min(allocation.voucherServiceFeeMinor, roundBps(feeMinor, rate))
        - Math.min(allocation.voucherDeliveryMinor, roundBps(group.deliveryFeeMinor, rate))
        - Math.min(allocation.voucherSupplierMinor || 0, roundBps(addMinor([group.supplierSubtotalMinor, feeMinor, group.deliveryFeeMinor], 'voucher.gross'), rate) - roundBps(feeMinor, rate) - roundBps(group.deliveryFeeMinor, rate));
    }), 'voucher.downpayment');
  }
  const projected = {
    status: totalMinor == null ? "incomplete" : "priced", reasons,
    colourPricing: lines.flatMap(line => { const item = store.catalogItems.find(row => row.id === line.catalogItemId); const quote = item && colourQuoteFor(store,item,line); return quote ? [{lineId:line.id,...publicColourQuote(quote,"client",colourAmounts.get(line.id))}] : []; }),
    voucher: voucherPlan?.voucher ? publicVoucher(store, voucherPlan.voucher, at) : null,
    voucherDiscountMinor: voucherPlan?.voucherDiscountMinor || 0,
    discountKind: voucherPlan?.discountKind || null,
    memberPerk: publicPerkChoice(store, voucherPlan?.memberPerk ?? null),
    memberPerkMinor: voucherPlan?.memberPerk?.amountMinor ?? 0,
    voucherGroups: voucherPlan?.groups.map((group, index) => {
      const { voucherSupplierMinor: _supplierFunding, clientSupplierSubtotalMinor: _supplierCash, ...visible } = group;
      return { groupId: grouped[index].lines[0].id,
      ...(groupLevelFee(voucherPlan.money[index].serviceFeeSchedule) ? {
        organizationDiscountMinor: group.organizationDiscountMinor, voucherDiscountMinor: group.voucherDiscountMinor,
        ...(group.memberPerkMinor ? { memberPerkMinor: group.memberPerkMinor } : {}), totalMinor: group.totalMinor,
      } : visible) }; }) || [],
    clientItemSubtotalMinor, deliveryLines, deliveryFeeMinor, totalMinor, organizationDiscountMinor, organizationDiscountLabel: "Organization discount",
    ...(hubPickup ? { pickupFeeMinor: hubPickup.feeMinor } : {}),
    upfrontReason: grouped.length > 1 ? "multiple_fulfillment_groups" : "platform_setting",
    downpaymentPercent, downpaymentMinor, balanceMinor: totalMinor == null ? null : totalMinor - downpaymentMinor,
  };
  if (cart.orderType === "express" && lines.length && subtotals.every((amount) => amount != null)) {
    const schedule = groupFeeSettings(store, cart, lines, at).serviceFeeSchedule;
    if (schedule.version === 3) {
      // Accept-first shows the shop's price and the GRIDGO fee separately.
      const printingMinor = addMinor(subtotals, "quote.printing");
      const fee = serviceFeeMoney(printingMinor, schedule);
      Object.assign(projected, { printingMinor, gridgoFeeMinor: fee.grossServiceFeeMinor,
        gridgoFeeRule: { minimumMinor: schedule.minimumMinor, rateBasisPoints: schedule.rateBps, applied: fee.serviceFeeWorking[0].applied, roundTotalUpToMinor: schedule.roundTotalUpToMinor },
        printingLines: lines.map((line, index) => ({ lineId: line.id, pages: line.documentPages?.printed ?? null, copies: line.quantity,
          unitPriceMinor: line.expressPrint?.rateMinor ?? null, amountMinor: subtotals[index] })) });
    }
  }
  return cart.orderType === "express" ? expressClientProjection(projected) : projected;
}

function publicCart(store,cart,at,options={}) {
 return homePrinterResponse(store,cartInternal(store,cart,at,options),{id:cart.clientId,role:'client'});
}
function cartInternal(store, cart, at, { compactListings = false } = {}) {
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
    const documentPages = item ? documentPagesFor(store, item, line) : null;
    const colourPricing = item ? colourQuoteFor(store,item,line) : null;
    return {
      id: line.id,
      deadline: lineDeadline(cart, line),
      supplierId: line.supplierId,
      catalogItemId: line.catalogItemId,
      quantity: line.quantity,
      quantityMode: line.quantityMode ?? null,
      colourPricing,
      totalSheets: item?.pricedByColour ? colourPricing?.totalSheets ?? null : (colourPricing?.totalSheets ?? (item?.pricingUnit === "per_page" && documentPages ? documentPages.printed * line.quantity : null)),
      optionIds: [...(line.optionIds || [])],
      speedTierId: line.speedTierId ?? null,
      measurement: item?.pricingUnit === "per_page" ? (documentPages ? { pages: documentPages.printed } : null) : line.measurement ? { ...line.measurement } : null,
      documentPages,
      structuredSpec: structuredClone(line.structuredSpec || {}),
      artworkFileId: line.artworkFileId ?? null,
      artworkLinks: structuredClone(line.artworkLinks || []),
      artworkAttachments: artworkAttachmentsFor(line),
      artworkPreviewFileId: artworkPreviewFileId(store, line),
      // Null on products whose shop marked no layout; those ask nothing.
      printLayout: line.printLayout ?? null,
      printLayoutCheck: item ? printLayoutCheck(store, item, { optionIds: line.optionIds || [], fileIds: artworkFileIdsFor(line), layout: line.printLayout ?? null }) : null,
      artworkGuidance: item ? evaluateLineArtwork(store, item, line, artworkFileIdsFor(line)) : null,
      // Null until given; only hardbound and binding products ask.
      coverSpine: publicCartCoverSpine(line),
      coverSpineRequired: Boolean(item && coverSpineApplies(item) && coverSpineRequiredSetting(store.settings)),
      approvalMethod: approvalPolicy(store.settings, { categories: [store.supplierServices.find(service => service.id === item?.supplierServiceId)?.categoryCode], quoted: isQuoteListing(item) }).method,
      // The client's exact colours, and what each uploaded file uses beside them.
      colorTargets: colorTargetsFor(line),
      artworkColors: artworkColorsFor(store, artworkFileIdsFor(line)),
      specialInstructions: line.specialInstructions || "",
      mockupFileId: line.mockupFileId ?? null,
      dropoff: line.dropoff ? { ...line.dropoff } : null,
      // Sample First (docs/SAMPLE_FIRST_API.md): a sample of one piece for an intended batch,
      // or a batch made from an approved sample.
      sample: line.sample ? { batchQuantity: line.sample.batchQuantity, replacesSampleBatchId: line.sample.replacesDraftId ?? null } : null,
      sampleBatch: line.sampleBatchDraftId ? publicCartSampleBatch(store, line) : null,
      sortOrder: line.sortOrder,
      listing,
      promiseBy: cartLinePromiseBy(store, cart, line, item, at),
      lineSubtotalMinor,
      clientLineSubtotalMinor: clientMoneyMinor({ settings: groupFeeSettings(store, cart, lines.filter(entry => sameDelivery(entry, line)), at) }, lineSubtotalMinor),
    };
  });
  const supplierIds = [...new Set(lines.map((line) => line.supplierId))];
  const grouped = cartGroups(cart, lines);
  const pickupShares = splitBasketFee(cart.requestFulfillment?.fulfillmentMode === "pickup" ? publicHubPickup(store.settings).feeMinor : 0, grouped.length);
  const groups = grouped.map(({ supplierId, deadline, deliveryNumber, shopDeliveryCount, lines: groupLines }, index) => {
    const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
    const dropoffs = groupLines.map((line) => line.dropoff || cart.defaultDropoff);
    const deliveryFeeMinor = cart.fulfillmentMode === "pickup" ? pickupShares[index]
      : profile?.shop && dropoffs.every(Boolean)
        ? deliveryFeeForDistance(Math.max(...dropoffs.map((dropoff) => distanceMetersBetween(profile.shop, dropoff))), store.settings) : null;
    const amounts = groupLines.map((line) => cartLineSubtotal(store, line));
    const itemSubtotalMinor = amounts.some((amount) => amount == null) ? null : addMinor(amounts, "group.itemSubtotalMinor");
    const fee = itemSubtotalMinor == null ? null : organizationFeeMoney(itemSubtotalMinor, groupFeeSettings(store, cart, groupLines, at), approvedOrganization(store, cart.clientId));
    const serviceFeeMinor = fee?.grossServiceFeeMinor ?? null;
    if (groupLevelFee(fee?.serviceFeeSchedule)) {
      const shares = splitVoucherMinor(serviceFeeMinor, amounts);
      groupLines.forEach((line, index) => {
        publicLines.find(row => row.id === line.id).clientLineSubtotalMinor = amounts[index] + shares[index];
      });
    }
    let readyBy = null;
    let expressPromise = false;
    let scheduling = null;
    try {
      const items = groupLines.map(line => store.catalogItems.find(item => item.id === line.catalogItemId));
      if (items.every(Boolean) && groupLines.every(line => publicLines.find(row => row.id === line.id)?.promiseBy)) {
        const projection = cartGroupProjection(store, cart, groupLines, at);
        scheduling = projection.scheduling;
        readyBy = projection.promiseBy;
        expressPromise = projection.express === true;
      }
    } catch (error) { if (!(error instanceof AvailabilityError) && error.code !== 'speed_tier_unavailable') throw error; }
    return { ...publicOrganizationDiscount(fee || {}), id: groupLines[0].id, label: shopLabel(supplierIds.indexOf(supplierId)), deadline, readyBy, expressPromise, scheduling, lineIds: groupLines.map((line) => line.id),
      deliveryNumber, shopDeliveryCount, separateDelivery: shopDeliveryCount > 1,
      canDeliverSeparately: lines.filter((line) => line.supplierId === supplierId).length > 1,
      ...(cart.requestFulfillment?.fulfillmentMode === "pickup" ? { pickupFeeMinor: pickupShares[index] } : {}),
      clientItemSubtotalMinor: itemSubtotalMinor == null ? null : addMinor([itemSubtotalMinor, serviceFeeMinor], "group.clientItems"), deliveryFeeMinor,
      totalMinor: deliveryFeeMinor == null || itemSubtotalMinor == null ? null : addMinor([itemSubtotalMinor, fee.serviceFeeMinor, deliveryFeeMinor], "group.totalMinor") };
  });
  if (cart.state === 'draft') {
    const plan = cartVoucherPlan(store, cart, lines, at);
    if (plan) groups.forEach((group, index) => Object.assign(group, {
      totalMinor: plan.groups[index].totalMinor, organizationDiscountMinor: plan.groups[index].organizationDiscountMinor,
      voucherDiscountMinor: plan.groups[index].voucherDiscountMinor,
      ...(plan.groups[index].memberPerkMinor ? { memberPerkMinor: plan.groups[index].memberPerkMinor } : {}),
    }));
  }
  const colourAmounts = clientCartLineAmounts(store,cart,lines,at);
  for (const line of publicLines) {
    if (!line.colourPricing) continue;
    line.colourPricing = publicColourQuote(line.colourPricing,'client',colourAmounts.get(line.id));
    if (line.colourPricing.pricedByColour) {
      delete line.lineSubtotalMinor;
      line.clientLineSubtotalMinor = colourAmounts.get(line.id) ?? null;
    }
  }
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
  const operatingStatus = reviewTiming(store.settings, at);
  const readyBy = groups.length && groups.every(group => group.readyBy)
    ? groups.map(group => group.readyBy).sort().at(-1) : null;
  const projected = {
    id: cart.id,
    approvalProofRequired: store.settings.approvalProofRequired === true,
    operatingStatus,
    checkoutNotice: operatingStatus.isOpenNow ? null : { code: 'outside_operating_hours', ...operatingStatus, readyBy },
    state: cart.state,
    version: cart.version,
    serviceLevel: cart.serviceLevel,
    scheduledFor: cart.scheduledFor ?? null,
    deadline: lines.length ? sharedDeadline(grouped) : cart.deadline ?? null,
    ...groupSummary(grouped),
    fulfillmentMode: cart.fulfillmentMode,
    requestFulfillment: cart.requestFulfillment ? structuredClone(cart.requestFulfillment) : null,
    ...(cart.requestFulfillment?.fulfillmentMode === "pickup" ? { hubPickup: publicHubPickup(store.settings) } : {}),
    defaultDropoff: cart.defaultDropoff ? { ...cart.defaultDropoff } : null,
    lines: publicLines.filter(row=>!lines.find(line=>line.id===row.id)?.expressPrint?.groupMemberId||lines.find(line=>line.id===row.id).expressPrint.groupMemberId===cart.clientId),
    shops: groups.length > 1 ? groups.map(({ id, label }) => ({ id, label })) : cartShops(store, lines),
    groups,
    ...(cart.checkedOutOrderId && basketForOrder(store, cart.checkedOutOrderId) ? { basketId: basketForOrder(store, cart.checkedOutOrderId).id } : {}),
    clientQuote: cart.state === "draft" ? clientCartQuote(store, cart, lines, at) : null,
    checkedOutOrderId: cart.checkedOutOrderId ?? null,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
  };
  return cart.orderType === "express" ? expressClientProjection(projected) : projected;
}

function publicCartSampleBatch(store, line) {
  const draft = (store.sampleBatchDrafts || []).find(row => row.id === line.sampleBatchDraftId);
  return {
    draftId: line.sampleBatchDraftId,
    pricing: line.sampleBatchPricing || "held",
    sampleOrderId: draft?.sampleOrderId ?? null,
    heldUntil: draft?.heldUntil ?? null,
  };
}

function updateCart(cart, at) {
  cart.version = (cart.version || 1) + 1;
  cart.updatedAt = at;
}

function parseDeadline(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(400, "invalid_deadline", "deadline must be an ISO date-time.");
  return new Date(value).toISOString();
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
    deadline = parseDeadline(body.deadline);
  }
  return { fulfillmentMode, serviceLevel, scheduledFor, defaultDropoff, deadline };
}

function addressPoint(store, userId, body) {
  if (body.addressId != null) {
    const address = (store.clientAddresses || []).find((row) => row.id === String(body.addressId) && !row.deletedAt);
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

function publicMatchedOrder(store,order) {
 return homePrinterResponse(store,matchedOrderInternal(store,order),{id:order.clientId,role:'client'});
}
function matchedOrderInternal(store, order) {
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
      ...(job.fulfillmentMode === "pickup" ? { pickup: order.orderType === "express" ? structuredClone(job.pickup) : gridgoOfficePoint() } : { pickup: null }),
      dropoff: job.dropoff ? { ...job.dropoff } : null,
      deliveryDistanceMeters: job.deliveryDistanceMeters,
      deliveryFeeMinor: job.deliveryFeeMinor,
      estimatedHours: job.estimatedHours,
      estimatedProductionMinutes: job.estimatedProductionMinutes ?? Math.round(job.estimatedHours * 60),
      estimatedDays: !order.productionTimeCorrection && (store.orderLineItems || []).some(line => line.jobId === job.id)
        && store.orderLineItems.filter(line => line.jobId === job.id).every(line => line.turnaroundDaysSnapshot != null)
        ? Math.max(...store.orderLineItems.filter(line => line.jobId === job.id).map(line => line.turnaroundDaysSnapshot || 0)) : null,
      scheduledFor: job.scheduledFor ?? null,
      deadline: job.deadline ?? order.deadline ?? null,
    }));
  return {
    id: order.id,
    ...(order.orderType === "express" ? {orderType:"express",expressOrder:publicExpress(order,{id:order.clientId,role:"client"})} : {}),
    deadline: order.deadline ?? null,
    ...(order.basketId ? { basketId: order.basketId, groupLabel: order.groupLabel } : {}),
    ...(order.shopDeliveryCount > 1 ? { deliveryNumber: order.deliveryNumber, shopDeliveryCount: order.shopDeliveryCount } : {}),
    state: order.state,
    ...publicOrganizationDiscount(order),
    ...(order.orderType === "express" || order.basketId || order.organizationDiscountRateBps > 0 || groupLevelFee(order.serviceFeeSchedule) ? { clientItemSubtotalMinor: order.supplierSubtotalMinor + (order.grossServiceFeeMinor ?? order.serviceFeeMinor) } : {
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
    express: order.express === true,
    scheduling: order.scheduling ?? null,
    review: orderReviewTiming(order, store.settings),
    downpaymentPercent: orderDownpaymentPercent(order),
    paymentPlan: {
      method: order.orderType === "express" ? order.payments.initial.method : "qr_manual",
      downpaymentPercent: orderDownpaymentPercent(order),
      downpaymentMinor: order.payments.initial.amountMinor,
      balanceMinor: order.payments.final_online.amountMinor,
      downpaymentStatus: order.payments.initial.status,
      downpaymentMethod: order.payments.initial.method,
      downpaymentConfirmationSource: order.payments.initial.confirmationSource ?? null,
      balanceStatus: order.payments.final_online.status,
    },
    jobs,
    ...(order.voucher ? { voucher: clientVoucher(order.voucher), voucherDiscountMinor: order.voucherDiscountMinor } : {}),
    ...publicMemberPerk(order),
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

function checkout(store, user, cart, body, createId, at, req, { groupLines = null, basketId = null, groupLabel = null, delivery = null, pickupFeeMinor = null, voucher = null, voucherAllocation = null, memberPerk = null, offeredProjection = null, zeroCashBoundary = false } = {}) {
  assertRequestFulfillment(cart, body);
  const cartLines = (groupLines || store.cartLines || [])
    .filter((line) => line.cartId === cart.id)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  if (cartLines.length === 0) fail(409, "cart_empty", "Add at least one listing before checkout.");
  const orderId = createId("ord");
  // Snapshotted here, like the rider delivery split: the setting moving later
  // never changes what this client owes.
  const group=(store.expressGroups||[]).find(g=>g.cartId===cart.id&&g.state==='checkout_open'&&g.hostId===user.id);
  const cash = body.payment?.method === 'cash';
  const acceptFirst=cart.orderType==='express'&&cartLines.some(line=>line.expressPrint?.routing);
  const paymentAfterAcceptance=cart.orderType==='express'&&cartLines.some(line=>line.expressPrint?.paper==='a3'||line.expressPrint?.productType==='plans'||line.expressPrint?.routing);
  if(paymentAfterAcceptance&&!zeroCashBoundary&&body.payment!=null)fail(409,'express_payment_after_acceptance','Pay for this Express order after the shop accepts.');
  // Accept-first is paid in one step after acceptance, at the counter or by QR.
  const downpaymentPercent = cash || basketId || acceptFirst ? 100 : downpaymentPercentSetting(store.settings);
  const order = {
    id: orderId,
    ...(cart.orderType === "express" ? {orderType:"express", expressOrder:createExpressSnapshot(cart,cartLines,at,{pickupPin:wantsPickupPin(body,{fulfillmentMode:cart.fulfillmentMode,group})})} : {}),
    ...(group?{groupOrder:{id:group.id,hostId:group.hostId,hostName:user.name,memberCount:(store.expressGroupMembers||[]).filter(m=>m.groupId===group.id&&m.active).length,backupReceiver:structuredClone(group.backupReceiver)}}:{}),
    shopClockVersion: 1,
    operatingClock: operatingClockSnapshot(store.settings, store.version),
    reviewSchedule: reviewTiming(store.settings, at),
    clientId: user.id,
    reviewData: isReviewData(user),
    organizationOfficer: officerSnapshot(store, user.id),
    // A delivery works to the earliest date among its products.
    deadline: groupDeadline(cart, cartLines),
    ...(basketId ? { basketId, groupLabel, basketDeadline: groupDeadline(cart, cartLines) } : {}),
    // Set only when the client chose separate deliveries from this shop.
    ...(delivery?.shopDeliveryCount > 1 ? { deliveryNumber: delivery.deliveryNumber, shopDeliveryCount: delivery.shopDeliveryCount } : {}),
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
    serviceFeeRateBps: groupFeeSettings(store, cart, cartLines, at).serviceFeeSchedule.version === 1
      ? groupFeeSettings(store, cart, cartLines, at).serviceFeeSchedule.rateBps : null,
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
    if (isQuoteListing(item)) assertQuoteCheckout(store, item, { user, cart, line, at });
    assertPrinterCap(store, item, { line, optionIds: line.optionIds, measurement: line.measurement, structuredSpec: line.structuredSpec });
    assertListingArtwork(store, item, line);
    syncDocumentPages(store, item, line, {}, { required: !!line.expressPrint || !item.pricedByColour });
    if (item.pricedByColour && !line.expressPrint) {
      const colour = colourQuoteFor(store,item,line);
      if (colour?.status !== 'priced') fail(409, colour?.status === 'needs_price_check' ? 'colour_price_check_required' : 'colour_analysis_required', 'Finish the artwork colour and price check before checkout.', {lineId:line.id,colourPricing:publicColourQuote(colour,"client")});
      line.measurement = {pages:colour.pages.length};
    }
    assertCheckoutPrintLayout(item, line, fail);
    assertCheckoutCoverSpine(store, item, line, fail);
    assertArtworkAttachmentLimit(artworkAttachmentsFor(line));
    validateArtworkLinks(line.artworkLinks || [], listing.acceptedFormats);
    if (!line.artworkFileId && !(line.artworkLinks || []).length) {
      fail(409, "artwork_required", "Upload artwork or add a publicly viewable design link before checkout.", { lineId: line.id, field: "artwork" });
    }
    for (const fileId of artworkFileIdsFor(line)) {
      const file = groupFileFor(store, user, cart, fileId);
      if (file.artworkCheck?.status !== "passed") fail(409, "artwork_file_check_failed",
        file.artworkCheck?.message || "This artwork has not passed its file check. Upload the original file again and replace the cart artwork.",
        { lineId: line.id, fileId: file.fileId, field: "artwork", reason: file.artworkCheck?.reason || "file_check_required" });
    }
    const links = line.artworkLinks || [];
    if (links.length && req[checkoutChecks]?.get(line.id) !== artworkFingerprint(line)) {
      fail(409, "artwork_check_required", "The cart artwork changed while being checked. Retry checkout to check the current links.", { lineId: line.id, field: "artwork" });
    }
    if (line.mockupFileId) fileFor(store, user, line.mockupFileId, "mockup", "mockupFileId");
    assertSampleFirstCheckout(store, user, item, line, at);
    if (!grouped.has(line.supplierId)) grouped.set(line.supplierId, []);
    grouped.get(line.supplierId).push({ line, item, listing });
  }

  const jobs = [];
  const snapshots = [];
  for (const [supplierId, entries] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
    if (!profile?.shop || profile.isClosed || shopPaused(profile, at)) fail(409, "shop_unavailable", "A shop in this cart is no longer available.", basketId ? { groupLabel } : { supplierId });
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
        speedTier: listingTiming(store, item, line).tier,
        quantityMode: line.quantityMode,
        artworkFileId: line.artworkFileId, artworkAttachments: line.artworkAttachments,
        documentPages: line.documentPages, printLayout: line.printLayout,
        structuredSpec: line.structuredSpec || {},
        pricedLine: sampleFirstPricedLine(store, item, line),
        createdAt: at,
        sortOrder: line.sortOrder,
      }, createId);
      snapshot.lineItem.jobId = jobId;
      if(line.expressPrint) {
        snapshot.lineItem.expressPrint=structuredClone(line.expressPrint);
        snapshot.lineItem.effectiveUnitPriceMinor=line.expressPrint.rateMinor;
        snapshot.lineItem.baseUnitPriceMinor=line.expressPrint.rateMinor;
        // A per-unit plan listing sells sheets. Copies remain on the immutable
        // Express settings; the invoice/counter quantity is the billed sheets.
        if(line.expressPrint.productType==='plans'&&item.pricingUnit==='per_unit') {
          snapshot.lineItem.quantity=expressLinePrice(line).billableMilliUnits/1000;
        }
      }
      applySampleFirstSnapshot(store, line, snapshot);
      snapshot.lineItem.documentPages = structuredClone(line.documentPages ?? null);
      if (line.quantityMode) snapshot.lineItem.quantityMode = line.quantityMode;
      if (!line.expressPrint && !snapshot.lineItem.colourPricing) { const colour = colourQuoteFor(store,item,line); if (colour) snapshot.lineItem.colourPricing = structuredClone(colour); }
      snapshot.lineItem.artworkLinks = structuredClone(line.artworkLinks || []);
      if (line.artworkAttachments) snapshot.lineItem.artworkAttachments = artworkAttachmentsFor(line);
      // The layout is part of the agreed spec, with the fit the client saw.
      if (line.printLayout) {
        snapshot.lineItem.printLayout = {
          version: 1, code: line.printLayout,
          check: printLayoutCheck(store, item, { optionIds: line.optionIds || [], fileIds: artworkFileIdsFor(line), layout: line.printLayout }),
        };
      }
      // The cover and spine are part of the agreed spec; "not given" is kept too,
      // so the shop and the GRIDGO Team know the product asked.
      const coverSpine = coverSpineSnapshot(item, line);
      if (coverSpine) snapshot.lineItem.coverSpine = coverSpine;
      // Exact colours are part of the agreed spec too.
      const colorTargets = colorTargetsSnapshot(line);
      if (colorTargets) snapshot.lineItem.colorTargets = colorTargets;
      snapshot.lineItem.specialInstructions = line.specialInstructions || "";
      if (line.artworkFileId) snapshot.lineItem.artworkFileId = line.artworkFileId;
      // Warnings never block; accepted or not, the figures travel with the order.
      const guidance = artworkGuidanceSnapshot(store, item, line, artworkFileIdsFor(line), at);
      if (guidance) snapshot.lineItem.artworkGuidance = guidance;
      if (line.mockupFileId) snapshot.lineItem.mockupFileId = line.mockupFileId;
      if (line.dropoff) snapshot.lineItem.dropoff = { ...line.dropoff };
      return { cartLine: line, ...snapshot };
    });
    const supplierSubtotalMinor = addMinor(jobSnapshots.map((row) => row.lineItem.lineSubtotalMinor), "job.supplierSubtotalMinor");
    const estimatedHours = Math.max(...jobSnapshots.map((row) => row.lineItem.turnaroundHoursSnapshot || 24));
    const job = {
      id: jobId, orderId, supplierId, riderId: null, state: "needs_qa", deadline: order.deadline,
      fulfillmentMode: cart.fulfillmentMode, pickup: { ...profile.shop },
      ...(jobDropoff ? { dropoff: jobDropoff } : {}),
      supplierSubtotalMinor, deliveryDistanceMeters: distance, deliveryFeeMinor,
      ...deliverySplit(deliveryFeeMinor, order.hubPickup ? 0 : cash ? 8000 : (store.settings.riderCommissionBps ?? 8_000)),
      estimatedProductionMinutes: Math.round(estimatedHours * 60),
      estimatedHours, ...(cart.scheduledFor ? { scheduledFor: cart.scheduledFor } : {}),
      createdAt: at, updatedAt: at,
    };
    jobs.push(job);
    snapshots.push(...jobSnapshots);
  }

  // Snapshot the same queue/calendar projection used by matching and the cart,
  // before adding this order's own jobs to the committed queue.
  const [job] = jobs;
  const projection = offeredProjection && offeredGroupProjection(store, cart, cartLines, at)
    ? offeredProjection : projectListingGroup(store, cartLines, { now: at, deadline: order.deadline }).projection;
  if (order.deadline && !fitsDeadline(projection, order.deadline)) {
    fail(409, "deadline_not_met", "This cart can no longer make the requested deadline; match again.", { lineIds: cartLines.map(line => line.id) });
  }
  order.approvalPolicy = approvalPolicy(store.settings, { categories: [...grouped.values()].flat().map(({ item }) =>
    store.supplierServices.find(service => service.id === item.supplierServiceId)?.categoryCode),
    // An accepted quote is a quoted job: its approval is drawn, as in the request flow.
    quoted: [...grouped.values()].flat().some(({ item }) => isQuoteListing(item)) });
  order.supplierId = job.supplierId;
  snapshotShopClock(store, order);
  order.pickup = { ...job.pickup };
  snapshotHomePrinter(store,order);
  if(order.expressOrder) {
    order.expressOrder.printerZone=distanceZoneForDistance(distanceMetersBetween(order.pickup,
      cart.fulfillmentMode==='delivery'?cart.defaultDropoff:cart.expressLocation),store.settings);
    order.expressOrder.deliveryFeeBands=structuredClone(store.settings.deliveryFeeBands);
  }
  order.distanceZone = job.deliveryDistanceMeters == null ? null
    : distanceZoneForDistance(job.deliveryDistanceMeters, store.settings);
  // The shop's own date, which it is held to. Never shown to the client.
  order.readyBy = projection.readyBy;
  // The padded date the client was promised. Never shown to the shop.
  order.promiseBy = projection.promiseBy;
  // Compatibility tag: new orders never use the retired Express override.
  order.express = projection.express === true;
  order.scheduling = structuredClone(projection.scheduling);
  order.reviewSchedule = structuredClone(projection.review);
  if (order.expressOrder && projection.nightWindow) order.expressOrder.nightWindow = structuredClone(projection.nightWindow);
  if (projection.scheduling.tightDeadline) {
    for (const row of snapshots) {
      const item = store.catalogItems.find(item => item.id === row.cartLine.catalogItemId);
      const hours = listingTiming(store, item, row.cartLine).minimum;
      row.lineItem.turnaroundHoursSnapshot = hours;
      row.lineItem.turnaroundMinutesSnapshot = Math.round(hours * 60);
      delete row.lineItem.turnaroundDaysSnapshot;
    }
    job.estimatedHours = Math.max(...snapshots.map(row => row.lineItem.turnaroundHoursSnapshot));
    job.estimatedProductionMinutes = Math.round(job.estimatedHours * 60);
  }

  const itemSubtotalMinor = addMinor(jobs.map((job) => job.supplierSubtotalMinor), "order.itemSubtotalMinor");
  // Pickup is a per-order platform charge. The internal trip to the hub keeps
  // the existing zero-charge job contract and never earns a share of this fee.
  const deliveryTotalMinor = addMinor([...jobs.map((job) => job.deliveryFeeMinor), order.pickupFeeMinor ?? 0], "order.deliveryFeeMinor");
  const baseFee = organizationFeeMoney(itemSubtotalMinor, groupFeeSettings(store, cart, cartLines, at), !voucher && !memberPerk && approvedOrganization(store, user.id));
  const memberPerkMinor = voucherAllocation?.memberPerkMinor ?? 0;
  const fee = memberPerkMinor ? { ...baseFee, serviceFeeMinor: baseFee.serviceFeeMinor - memberPerkMinor, memberPerkMinor,
    memberPerk: perkSnapshot(store, memberPerk, memberPerk.useId, memberPerkMinor) } : baseFee;
  const { serviceFeeMinor } = fee;
  const totalMinor = addMinor([itemSubtotalMinor, serviceFeeMinor, deliveryTotalMinor], "order.totalMinor");
  const downpaymentRateBps = downpaymentPercent * 100;
  const downpaymentMinor = roundBps(totalMinor, downpaymentRateBps);
  const balanceMinor = totalMinor - downpaymentMinor;
  const upfront = balanceMinor === 0;
  Object.assign(order, {
    ...fee,
    supplierSubtotalMinor: itemSubtotalMinor,
    subtotalMinor: itemSubtotalMinor,
    serviceFeeMinor,
    deliveryFeeMinor: deliveryTotalMinor,
    ...deliverySplit(deliveryTotalMinor, order.hubPickup ? 0 : cash ? 8000 : (store.settings.riderCommissionBps ?? 8_000)),
    totalMinor,
    onlineDueMinor: totalMinor,
    supplierPlatformPayoutMinor: itemSubtotalMinor,
    payments: {
      initial: {
        amountMinor: downpaymentMinor, method: "qr_manual", status: "pending_confirmation",
        label: upfront ? "Full payment" : `${downpaymentPercent}% downpayment`,
        reference: null, proofFileId: null, submittedAt: null,
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

  for (const payment of Object.values(order.payments)) markReviewPayment(order, payment);

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

  if (voucher && voucherAllocation) applyVoucherMoney(order, voucherAllocation, voucher);
  let proof = null;
  if (cash) {
    if (order.totalMinor <= 0) cashFail('cash_payment_not_required');
    order.cash = { version: 1, limitMinor: cashSettings(store.settings).limitMinor,
      noShowWaitSeconds: cashSettings(store.settings).noShowWaitSeconds };
    order.paymentPlan = 'cash_delivery';
    order.onlineDueMinor = 0;
    order.payoutPlanVersion = 3;
    order.payoutMilestones = cashPayoutStages(order, { version: 3 });
    order.payments.initial = { ...order.payments.initial, method: 'cash', status: 'not_submitted' };
    order.state = 'needs_qa';
    order.paymentStatus = 'cash_due';
    order.timeline = [{ at, state: 'needs_qa', by: user.id, note: 'Cash order placed; collection remains due at delivery' }];
  } else if (zeroCashBoundary) {
    if (!voucher || order.payments.initial.amountMinor !== 0) fail(409, 'voucher_zero_cash_boundary_required', 'Refresh the checkout payment amount.');
  } else if(paymentAfterAcceptance) {
    if(body.payment!=null)fail(409,'express_payment_after_acceptance','Pay for A3 Express after the shop accepts.');
    order.expressOrder.paymentTiming='after_acceptance';
    order.payments.initial.status='not_submitted';
    order.state='needs_qa';
    order.timeline=[{at,state:'needs_qa',by:user.id,note:acceptFirst?'Express request placed; the shop accepts before the client pays.':'A3 Express placed; artwork review and shop acceptance precede client payment.'}];
  } else {
    const payment = record(body.payment, 'payment');
    if (payment.method !== 'qr_manual') fail(400, 'payment_method_not_allowed', 'Checkout accepts QR Ph manual payment only.', { allowed: ['qr_manual'] });
    const reference = text(payment.reference, 'payment.reference', 100);
    proof = fileFor(store, user, text(payment.proofFileId, 'payment.proofFileId', 120), 'payment_proof', 'payment.proofFileId');
    Object.assign(order.payments.initial, { reference, proofFileId: proof.fileId, submittedAt: at });
  }
  order.invoiceNumber = invoiceNumber(orderId, at);

  store.orderJobs ||= [];
  store.orderLineItems ||= [];
  store.orderLineItemOptions ||= [];
  store.orderInvoices ||= [];
  store.orderJobs.push(...jobs);
  for (const snapshot of snapshots) {
    store.orderLineItems.push(snapshot.lineItem);
    store.orderLineItemOptions.push(...snapshot.options);
    for (const fileId of artworkFileIdsFor(snapshot.lineItem)) attachOrderFile(groupFileFor(store, user, cart, fileId), orderId, `line:${snapshot.lineItem.id}:artwork`);
    if (snapshot.lineItem.mockupFileId) attachOrderFile(fileFor(store, user, snapshot.lineItem.mockupFileId, "mockup", "mockupFileId"), orderId, `line:${snapshot.lineItem.id}:mockup`);
  }
  if (proof) attachOrderFile(proof, orderId, "payment:initial:proof");
  recordApprovalProof({ store, order, user, approval: body.approval, at, id: createId, req, cartVersion: cart.version });

  const invoice = {
    ...fee,
    ...(order.orderType === "express" ? {orderType:"express"} : {}),
    ...(order.groupOrder?{groupOrderId:order.groupOrder.id}:{}),
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
      artworkAttachments: artworkAttachmentsFor(lineItem),
      artworkPreviewFileId: artworkPreviewFileId(store, lineItem),
      specialInstructions: lineItem.specialInstructions || "",
      documentPages: structuredClone(lineItem.documentPages ?? null),
      quantityMode: lineItem.quantityMode ?? null,
      colourPricing: structuredClone(lineItem.colourPricing ?? null),
      printLayout: lineItem.printLayout?.code ?? null,
      coverSpine: publicOrderCoverSpine(lineItem.coverSpine ?? null),
      mockupFileId: cartLine.mockupFileId ?? null,
      dropoff: cartLine.dropoff ? { ...cartLine.dropoff } : null,
    })),
    itemSubtotalMinor,
    serviceFeeRateBps: groupFeeSettings(store, cart, cartLines, at).serviceFeeSchedule.version === 1
      ? groupFeeSettings(store, cart, cartLines, at).serviceFeeSchedule.rateBps : null,
    serviceFeeMinor,
    deliveryLines: jobs.map((job) => ({ jobId: job.id, shopName: publicSupplierShop(store, job.supplierId)?.shopName || "Shop", amountMinor: job.deliveryFeeMinor })),
    deliveryFeeMinor: deliveryTotalMinor,
    ...(order.hubPickup ? { hubPickup: structuredClone(order.hubPickup), pickupFeeMinor: order.pickupFeeMinor } : {}),
    ...(order.requestFulfillment ? { requestFulfillment: structuredClone(order.requestFulfillment) } : {}),
    totalMinor: order.totalMinor,
    ...(order.voucher ? { voucher: structuredClone(order.voucher), voucherDiscountMinor: order.voucherDiscountMinor,
      voucherServiceFeeMinor: order.voucherServiceFeeMinor, voucherDeliveryMinor: order.voucherDeliveryMinor,
      ...(order.coversOrderTotal ? { voucherSupplierMinor: order.voucherSupplierMinor, gridgoSupplierTopupMinor: order.gridgoSupplierTopupMinor, gridgoRiderTopupMinor: order.gridgoRiderTopupMinor } : {}),
      clientServiceFeeMinor: order.clientServiceFeeMinor, clientDeliveryFeeMinor: order.clientDeliveryFeeMinor } : {}),
    paymentPlan: { method: cash ? 'cash' : "qr_manual", downpaymentPercent, downpaymentMinor: order.payments.initial.amountMinor, balanceMinor: order.payments.final_online.amountMinor },
  };
  if (!basketId) store.orderInvoices.push({ orderId, invoiceNumber: order.invoiceNumber, issuedAt: at, snapshot: invoice });
  if (!basketId) {
    cart.state = "checked_out";
    cart.checkedOutOrderId = orderId;
    cart.checkedOutAt = at;
    lockCartFeeSchedules(store, cart, at);
    updateCart(cart, at);
  }
  linkSampleFirstOrder(store, user, order, cartLines, { at, createId });
  store.auditLog ||= [];
  store.auditLog.push({
    id: createId("aud"), at, actorId: user.id, actorRole: "client", action: "order_match.checkout",
    entityType: "order", entityId: orderId, orderId,
    detail: { jobCount: jobs.length, itemSubtotalMinor, ...fee, deliveryFeeMinor: deliveryTotalMinor, totalMinor },
  });
  for (const { item } of [...grouped.values()].flat()) if (isQuoteListing(item)) markQuoteOrdered(store, item, order, { user, at, createId });
  if (!zeroCashBoundary && !acceptFirst) notifyOpsJobNeedsQa(store, order, { createId, at });
  if (!basketId) {
    if (!zeroCashBoundary && !cash && !paymentAfterAcceptance) notifyOpsPaymentSubmitted(store, order, { createId, at });
    notifyClientReceiptReady(store, order, { createId, at });
  }
  queueOrderInvalidate(store, order, ["orders"]);
  return { order: publicMatchedOrder(store, order), invoice };
}

/** Sample First checkout gates, before anything is materialised. */
function assertSampleFirstCheckout(store, user, item, line, at) {
  if (line.sample) {
    assertCartLinePriceable(store, item, line);
    if (line.sample.replacesDraftId) replaceableDraft(store, user, line.sample.replacesDraftId);
  }
  if (line.sampleBatchDraftId) {
    const draft = ownSampleBatch(store, user, line.sampleBatchDraftId);
    if (draft.supplierId !== line.supplierId || draft.catalogItemId !== line.catalogItemId) {
      fail(409, "catalog_item_stale", "This batch no longer matches its sample.", { lineId: line.id });
    }
    if (heldBatchLine(line)) assertHeldPriceUsable(store, draft, at);
    else if (draft.status === "ordered") fail(409, "sample_batch_ordered", "This batch has already been ordered.", { batchOrderId: draft.batchOrderId });
    else if (draft.status !== "approved") fail(409, "sample_batch_not_approved", "Approve the sample before ordering its batch.", { status: draft.status });
    heldBatchLine(line) ? heldLinePrice(store, item, line) : assertCartLinePriceable(store, item, line);
  }
}

/**
 * The order line agrees with the price it was given. A sample is one piece at
 * the sample price; a held batch records the held base rate, option effects and
 * speed, so the snapshot reproduces exactly what the client was promised.
 */
function applySampleFirstSnapshot(store, line, snapshot) {
  const { lineItem, options } = snapshot;
  if (line.sample) {
    lineItem.baseUnitPriceMinor = lineItem.lineSubtotalMinor;
    lineItem.effectiveUnitPriceMinor = lineItem.lineSubtotalMinor;
    delete lineItem.speedTierSnapshot;
    return;
  }
  if (!heldBatchLine(line)) return;
  const held = (store.sampleBatchDrafts || []).find(row => row.id === line.sampleBatchDraftId).heldPricing;
  const item = (store.catalogItems || []).find(row => row.id === line.catalogItemId);
  lineItem.baseUnitPriceMinor = held.basePriceMinor;
  // The held rate after its bulk tier, speed and options, as the engine billed it.
  lineItem.effectiveUnitPriceMinor = heldLinePrice(store, item, line).unitRateMinor;
  if (held.speedTier) lineItem.speedTierSnapshot = structuredClone(held.speedTier);
  else delete lineItem.speedTierSnapshot;
  for (const option of options) {
    const kept = held.options.find(row => row.optionId === option.sourceOptionId || row.optionId === option.id);
    if (kept) {
      option.priceModifierMinor = kept.priceModifierMinor;
      option.priceMultiplierBps = kept.priceMultiplierBps ?? null;
    }
  }
}

/** Create a sample's batch draft, or link a batch to its sample. Same transaction as checkout. */
function linkSampleFirstOrder(store, user, order, cartLines, { at, createId }) {
  const sampleLine = cartLines.find(line => line.sample);
  if (sampleLine) {
    const view = approvedCatalogView(store);
    const item = view.catalogItems.find(row => row.id === sampleLine.catalogItemId);
    const batchSpeed = sampleLine.sample.speedTierId
      ? listingTiming(store, item, { ...sampleLine, speedTierId: sampleLine.sample.speedTierId }).tier : null;
    const batch = {
      itemName: item.name,
      quantity: sampleLine.sample.batchQuantity,
      optionIds: [...(sampleLine.optionIds || [])],
      measurement: sampleLine.measurement ? structuredClone(sampleLine.measurement) : null,
      structuredSpec: structuredClone(sampleLine.structuredSpec || {}),
      speedTierId: sampleLine.sample.speedTierId ?? null,
      artworkFileId: sampleLine.artworkFileId ?? null,
      artworkLinks: structuredClone(sampleLine.artworkLinks || []),
      artworkAttachments: sampleLine.artworkAttachments ? structuredClone(sampleLine.artworkAttachments) : null,
      documentPages: sampleLine.documentPages ? structuredClone(sampleLine.documentPages) : null,
      printLayout: sampleLine.printLayout ?? null,
      coverSpine: sampleLine.coverSpine ? structuredClone(sampleLine.coverSpine) : null,
      colorTargets: sampleLine.colorTargets ? structuredClone(sampleLine.colorTargets) : null,
      specialInstructions: sampleLine.specialInstructions || "",
    };
    const draft = {
      id: createId("sbd"), clientId: user.id, supplierId: sampleLine.supplierId, catalogItemId: sampleLine.catalogItemId,
      sampleOrderId: order.id, batchOrderId: null, previousDraftId: sampleLine.sample.replacesDraftId ?? null,
      status: "awaiting_sample", holdDays: sampleBatchHoldDays(store.settings), sampleDeliveredAt: null, heldUntil: null,
      batch, heldPricing: heldPricingSnapshot(store, item.id, { ...sampleLine, quantity: batch.quantity }, { at, speedTier: batchSpeed }),
      approval: null, rejection: null, version: 1, createdAt: at, updatedAt: at,
    };
    store.sampleBatchDrafts ||= [];
    store.sampleBatchDrafts.push(draft);
    Object.assign(order, { orderTags: ["sample"], sampleBatchDraftId: draft.id });
    store.auditLog ||= [];
    store.auditLog.push({ id: createId("aud"), at, actorId: user.id, actorRole: "client", action: "sample_batch.create",
      entityType: "sample_batch", entityId: draft.id, orderId: order.id,
      detail: { catalogItemId: draft.catalogItemId, batchQuantity: batch.quantity, holdDays: draft.holdDays,
        previousDraftId: draft.previousDraftId, samplePriceMinor: order.supplierSubtotalMinor } });
    return;
  }
  const batchLine = cartLines.find(line => line.sampleBatchDraftId);
  if (!batchLine) return;
  const draft = store.sampleBatchDrafts.find(row => row.id === batchLine.sampleBatchDraftId);
  const sample = (store.orders || []).find(row => row.id === draft.sampleOrderId);
  const pricing = heldBatchLine(batchLine) ? "held" : "current";
  Object.assign(order, {
    orderTags: ["batch_from_sample"], sampleOrderId: draft.sampleOrderId, sampleBatchDraftId: draft.id,
    sampleBatchPricing: { pricing, heldUntil: draft.heldUntil, heldPricingCapturedAt: draft.heldPricing.capturedAt },
    // The approved sample is the standard this batch is held to in a dispute.
    sampleDecision: sampleDecisionSummary(draft),
  });
  draft.status = "ordered";
  draft.batchOrderId = order.id;
  draft.version = (draft.version || 1) + 1;
  draft.updatedAt = at;
  if (sample) {
    sample.batchOrderId = order.id;
    sample.updatedAt = at;
    queueOrderInvalidate(store, sample, ["orders", "jobs"]);
  }
  store.auditLog ||= [];
  store.auditLog.push({ id: createId("aud"), at, actorId: user.id, actorRole: "client", action: "sample_batch.batch_ordered",
    entityType: "sample_batch", entityId: draft.id, orderId: order.id,
    detail: { sampleOrderId: draft.sampleOrderId, pricing, quantity: batchLine.quantity, heldUntil: draft.heldUntil,
      sampledQuantity: draft.batch.quantity, itemSubtotalMinor: order.supplierSubtotalMinor } });
  notifyAdmins(store, "sample_batch_ordered", "Batch ordered from an approved sample", order, `sample_batch_ordered:${draft.id}`, { createId, at });
}

export function checkoutBasket(store, user, cart, body, createId, at, req) {
  if (cart.orderType === 'express') {
    const lines=store.cartLines.filter(l=>l.cartId===cart.id);
    const productType=lines.some(line=>line.expressPrint?.productType==='plans')?'plans':'documents';
    const shop=expressShopList(store,user,{location:cart.expressLocation,fulfillmentMode:cart.fulfillmentMode,productType},at).find(s=>s.supplierId===lines[0]?.supplierId);
    if(!shop || lines.some(line=>!line.expressPrint || !shop.catalogItemIds.includes(line.catalogItemId) || line.supplierId!==shop.supplierId)) fail(409,'express_shop_unavailable','Choose an open Express shop.');
    const permission=lines[0]?.expressPrint?.selection;
    if(permission) {
      const pickup=store.supplierProfiles.find(profile=>profile.userId===shop.supplierId).shop;
      const distance=distanceMetersBetween(pickup,cart.fulfillmentMode==='delivery'?cart.defaultDropoff:cart.expressLocation);
      fastestPermittedPrinter({shops:[{...shop,zone:{...shop.zone,code:({nearby:'A',away:'B',long_distance:'C'})[distanceZoneForDistance(distance,store.settings).key]||null},
        deliveryFareMinor:deliveryFeeForDistance(distance,store.settings)}]},permission.fareLimit);
    }
    assertExpressNightJob(store,shop.supplierId,lines,cart.fulfillmentMode,at);
    for(const line of lines) {
      const item=store.catalogItems.find(row=>row.id===line.catalogItemId);
      if(!isDeepStrictEqual(documentPagesFor(store,line.expressPrint?.productType==='plans'?{...item,pricingUnit:'per_page'}:item,line,undefined,{required:true}),line.documentPages)) fail(409,'express_preview_required','The detected pages changed. Review a new draft.');
    }
    if(body.looksRight!==true || body.expressConfirmation!==expressConfirmation(cart,lines)) fail(409,'express_preview_required','Review the current print settings and accept the preview.');
  }
  const cash = body.payment?.method === 'cash';
  const group=(store.expressGroups||[]).find(g=>g.cartId===cart.id);
  if(group && (group.state!=='checkout_open'||Date.parse(at)>=Date.parse(group.payBy)))fail(409,'group_locked');
  if(group && cash && clientCartQuote(store,cart,store.cartLines.filter(l=>l.cartId===cart.id),at).totalMinor>=150000)fail(409,'group_cash_limit_exceeded');
  if (cash) {
    requireCashCheckout(store.settings, user, 0);
    if (isReviewData(user)) cashFail('review_data_money_forbidden');
    if (cart.fulfillmentMode !== 'delivery') cashFail('cash_delivery_required');
    if (store.orders.some(o => o.clientId === user.id && o.cashProgress?.noShowApprovedAt && !o.cashProgress.repaymentConfirmedAt)) cashFail('cash_client_barred');
  }
  if (cart.fulfillmentMode === "pickup" && cart.orderType !== "express" && store.settings.hubPickupEnabled !== true) {
    fail(409, "hub_pickup_disabled", "Hub pickup is currently unavailable. Choose delivery for a new order.");
  }
  const lines = (store.cartLines || []).filter((line) => line.cartId === cart.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  if (cash) for (const line of lines) assertVerifiedCashShop(store,line.supplierId);
  const suppliers = [...new Set(lines.map((line) => line.supplierId))];
  const groups = cartGroups(cart, lines);
  // Validate the complete relevant draft before materializing any group orders.
  // Unchanged earlier groups remain in the cart and keep their later offers valid.
  const honouredOffers = groups.map(group => offeredGroupProjection(store, cart, group.lines, at));
  const plan = cartVoucherPlan(store, cart, lines, at);
  const voucher = plan?.voucher;
  const memberPerk = plan?.memberPerk ? { ...plan.memberPerk, useId: createId('mpu') } : null;
  // A perk can end between the quote and this moment; a client that sends what it
  // showed is stopped here instead of being charged a different total.
  const perkMinor = memberPerk?.amountMinor ?? 0;
  if (body.expectedMemberPerkMinor !== undefined && body.expectedMemberPerkMinor !== perkMinor) {
    fail(409, 'member_perk_changed', 'Your member perk changed. Check the new total before you pay.', { memberPerkMinor: perkMinor });
  }
  const zeroCashBoundary = !cash && Boolean(voucher?.data?.coversOrderTotal && clientCartQuote(store, cart, lines, at).downpaymentMinor === 0);
  if (groups.length < 2) {
    const result = checkout(store, user, cart, body, createId, at, req, { voucher, voucherAllocation: plan?.groups[0], memberPerk, offeredProjection: honouredOffers[0], zeroCashBoundary });
    if (cash) { const order = store.orders.find(o => o.id === result.order.id); requireCashCheckout(store.settings, user, order.supplierSubtotalMinor + order.serviceFeeMinor); }
    if (memberPerk) reserveMemberPerk(store, memberPerk, memberPerk.useId, [store.orders.find(o => o.id === result.order.id)], { id: createId, at });
    if (voucher) reserveVoucher(store, voucher, cart, { id: createId, at, orderIds: [result.order.id], amountMinor: plan.voucherDiscountMinor });
    else releaseVoucherReservations(store, { id: createId, at }, r => r.cartId === cart.id);
    if (cash && voucher) confirmVoucher(store,[store.orders.find(o=>o.id===result.order.id)],{id:createId,at,actorId:user.id});
    const placed = store.orders.find(o => o.id === result.order.id);
    if (zeroCashBoundary) {
      settleVoucherInitial(store, [placed], { id: createId, at, actorId: user.id });
      if (!placed.expressOrder?.acceptFlow) {
        notifyOpsJobNeedsQa(store, placed, { createId, at });
        notifyOrderParties(store, placed, { createId, at });
      }
      result.order = publicMatchedOrder(store, placed);
    }
    if (placed.expressOrder?.acceptFlow === 2) {
      assertAcceptFirstPayable(store, placed, user, at);
      beginAcceptFirst(store, placed, { at, createId });
      result.order = publicMatchedOrder(store, placed);
    }
    return result;
  }
  if (lines.some(line => !lineDeadline(cart, line))) fail(400, "basket_deadline_required", "Set a deadline for every product before checkout.");
  const basketId = createId("bsk");
  const hubPickup = cart.requestFulfillment?.fulfillmentMode === "pickup" ? publicHubPickup(store.settings) : null;
  const pickupShares = splitBasketFee(hubPickup?.feeMinor ?? 0, groups.length);
  // Reserve the earliest deadline first, regardless of the client's add order.
  // Keep receipt positions and pickup remainder allocation in cart order.
  const results = new Array(groups.length);
  for (const { group, index } of groups.map((group, index) => ({ group, index }))
    .sort((a, b) => Date.parse(a.group.deadline) - Date.parse(b.group.deadline) || a.index - b.index)) {
    results[index] = checkout(store, user, cart, body, createId, at, req, {
      groupLines: group.lines, basketId, groupLabel: shopLabel(suppliers.indexOf(group.supplierId)), delivery: group,
      pickupFeeMinor: hubPickup ? pickupShares[index] : null, voucher, voucherAllocation: plan?.groups[index], memberPerk,
      offeredProjection: honouredOffers[index], zeroCashBoundary,
    });
  }
  const orders = results.map((result) => store.orders.find((order) => order.id === result.order.id));
  if (cash) requireCashCheckout(store.settings, user, addMinor(orders.map(o => o.supplierSubtotalMinor + o.serviceFeeMinor), 'cash.cartSubtotal'));
  if (memberPerk) reserveMemberPerk(store, memberPerk, memberPerk.useId, orders.filter(order => order.memberPerkMinor > 0), { id: createId, at });
  if (voucher) reserveVoucher(store, voucher, cart, { id: createId, at, orderIds: orders.map(o => o.id), amountMinor: plan.voucherDiscountMinor });
  else releaseVoucherReservations(store, { id: createId, at }, r => r.cartId === cart.id);
  if (cash && voucher) confirmVoucher(store,orders,{id:createId,at,actorId:user.id});
  if (zeroCashBoundary) {
    settleVoucherInitial(store, orders, { id: createId, at, actorId: user.id });
    for (const order of orders) {
      notifyOpsJobNeedsQa(store, order, { createId, at });
      notifyOrderParties(store, order, { createId, at });
    }
    results[0].order = publicMatchedOrder(store, orders[0]);
  }
  const first = orders[0];
  const basket = { id: basketId, clientId: user.id, receiptOrderId: first.id,
    orderIds: orders.map((order) => order.id), totalMinor: addMinor(orders.map((order) => order.totalMinor), "basket.totalMinor"),
    deadline: sharedDeadline(groups), fulfillmentMode: cart.fulfillmentMode,
    ...(hubPickup ? { pickupFeeMinor: hubPickup.feeMinor } : {}),
    payment: { ...first.payments.initial }, createdAt: at, updatedAt: at };
  delete basket.payment.amountMinor;
  store.baskets ||= [];
  store.baskets.push(basket);
  const invoice = { organizationOfficer: structuredClone(first.organizationOfficer), invoiceNumber: first.invoiceNumber, orderId: first.id, basketId, issuedAt: at, currency: "PHP",
    ...(hubPickup ? { hubPickup, pickupFeeMinor: hubPickup.feeMinor } : {}),
    ...(cart.requestFulfillment ? { requestFulfillment: structuredClone(cart.requestFulfillment) } : {}),
    lines: results.flatMap((result) => result.invoice.lines),
    groups: results.map((result, index) => ({ orderId: result.order.id, label: result.order.groupLabel, deadline: groups[index].deadline,
      ...(groups[index].shopDeliveryCount > 1 ? { deliveryNumber: groups[index].deliveryNumber, shopDeliveryCount: groups[index].shopDeliveryCount } : {}),
      lines: result.invoice.lines, itemSubtotalMinor: result.invoice.itemSubtotalMinor,
      ...(result.invoice.voucher ? { voucher: result.invoice.voucher, voucherDiscountMinor: result.invoice.voucherDiscountMinor } : {}),
      serviceFeeSchedule: result.invoice.serviceFeeSchedule, serviceFeeWorking: result.invoice.serviceFeeWorking, serviceFeeRateBps: result.invoice.serviceFeeRateBps,
      grossServiceFeeMinor: result.invoice.grossServiceFeeMinor, organizationDiscountMinor: result.invoice.organizationDiscountMinor,
      ...(result.invoice.memberPerkMinor ? { memberPerkMinor: result.invoice.memberPerkMinor, memberPerk: result.invoice.memberPerk } : {}),
      serviceFeeMinor: result.invoice.serviceFeeMinor, deliveryFeeMinor: result.invoice.deliveryFeeMinor, totalMinor: result.invoice.totalMinor,
      ...(hubPickup ? { pickupFeeMinor: pickupShares[index] } : {}) })),
    itemSubtotalMinor: addMinor(orders.map((order) => order.supplierSubtotalMinor), "basket.itemSubtotalMinor"),
    serviceFeeRateBps: first.serviceFeeRateBps,
    organizationDiscountRateBps: first.organizationDiscountRateBps,
    organizationDiscountMinor: addMinor(orders.map((order) => order.organizationDiscountMinor), "basket.discount"),
    ...(memberPerk ? { memberPerkMinor: memberPerk.amountMinor, memberPerk: perkSnapshot(store, memberPerk, memberPerk.useId, memberPerk.amountMinor) } : {}),
    grossServiceFeeMinor: addMinor(orders.map((order) => order.grossServiceFeeMinor), "basket.grossFee"),
    serviceFeeMinor: addMinor(orders.map((order) => order.serviceFeeMinor), "basket.serviceFeeMinor"),
    deliveryLines: results.flatMap((result, index) => result.invoice.deliveryLines.map((line) => ({ jobId: line.jobId, shopName: result.order.groupLabel, deadline: groups[index].deadline, amountMinor: line.amountMinor }))),
    deliveryFeeMinor: addMinor(orders.map((order) => order.deliveryFeeMinor), "basket.deliveryFeeMinor"),
    totalMinor: basket.totalMinor,
    ...(voucher ? { voucher: { id: voucher.id, campaignId: voucher.campaignId, fundedBy: 'GRIDGO', label: 'GRIDGO-funded voucher', amountMinor: plan.voucherDiscountMinor },
      voucherDiscountMinor: plan.voucherDiscountMinor, voucherServiceFeeMinor: addMinor(orders.map(o => o.voucherServiceFeeMinor || 0), 'voucher.fee'),
      voucherDeliveryMinor: addMinor(orders.map(o => o.voucherDeliveryMinor || 0), 'voucher.delivery'),
      voucherSupplierMinor: addMinor(orders.map(o => o.voucherSupplierMinor || 0), 'voucher.supplier'),
      gridgoSupplierTopupMinor: addMinor(orders.map(o => o.gridgoSupplierTopupMinor || 0), 'voucher.supplierTopup'),
      gridgoRiderTopupMinor: addMinor(orders.map(o => o.gridgoRiderTopupMinor || 0), 'voucher.riderTopup') } : {}),
    paymentPlan: { method: cash ? 'cash' : "qr_manual", downpaymentPercent: 100, downpaymentMinor: basket.totalMinor, balanceMinor: 0 },
  };
  for (const order of orders) order.invoiceNumber = first.invoiceNumber;
  store.orderInvoices.push({ orderId: first.id, invoiceNumber: first.invoiceNumber, issuedAt: at, snapshot: invoice });
  cart.state = "checked_out";
  cart.checkedOutOrderId = first.id;
  cart.checkedOutAt = at;
  lockCartFeeSchedules(store, cart, at);
    updateCart(cart, at);
  store.auditLog.push({ id: createId("aud"), at, actorId: user.id, actorRole: "client",
    action: "basket.checkout", entityType: "basket", entityId: basket.id,
    detail: { orderIds: basket.orderIds, totalMinor: basket.totalMinor } });
  const separate = groups.map((group, index) => ({ group, order: orders[index] })).filter(({ group }) => group.shopDeliveryCount > 1);
  if (separate.length) {
    // The client's "deliver separately" choice, as it was paid for.
    store.auditLog.push({ id: createId("aud"), at, actorId: user.id, actorRole: "client",
      action: "basket.separate_deliveries", entityType: "basket", entityId: basket.id,
      detail: { deliveries: separate.map(({ group, order }) => ({ orderId: order.id, supplierId: group.supplierId,
        label: order.groupLabel, deliveryNumber: group.deliveryNumber, shopDeliveryCount: group.shopDeliveryCount,
        deadline: group.deadline, lineIds: group.lines.map(line => line.id), deliveryFeeMinor: order.deliveryFeeMinor })) } });
  }
  if (!zeroCashBoundary && !cash) notifyOpsPaymentSubmitted(store, first, { createId, at });
  notifyClientReceiptReady(store, first, { createId, at });
  return { order: results[0].order, basket: publicBasket(store, basket, user), invoice };
}

export function isOrderMatchRoute(method, pathname) {
  if (["/express/drafts", "/express/shops", "/express/demand", "/me/express-guide"].includes(pathname)) return true;
  if (["/me/preferences", "/me/addresses", "/me/matches", "/me/matches/next", "/me/carts", "/me/deadline-days", "/me/catalog-quotes", "/me/print-layout-check"].includes(pathname)) return true;
  if (method === "DELETE" && /^\/me\/addresses\/[^/]+$/.test(pathname)) return true;
  if (/^\/me\/carts\/[^/]+(?:\/.*)?$/.test(pathname)) return true;
  if (method === "POST" && /^\/me\/sample-batches\/[^/]+\/cart$/.test(pathname)) return true;
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
  if (!isCartArtworkWrite(req.method, pathname) || !hasShortArtworkLinks(body?.artworkAttachments ?? body?.artworkLinks)) return;
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
  const formats = item ? publicCatalogItem(store, item)?.acceptedFormats : [];
  if (Object.hasOwn(body, "artworkAttachments")) {
    const entries = validateArtworkAttachments(body.artworkAttachments, formats, { allowShortLinks: true });
    const links = await resolveArtworkLinks(entries.filter(entry => entry.kind === "link"), formats,
      checker || ((link) => checkArtworkLinkForUser(user.id, link)));
    let index = 0;
    body.artworkAttachments = entries.map(entry => entry.kind === "link" ? { kind: "link", ...links[index++] } : entry);
  } else body.artworkLinks = await resolveArtworkLinks(body.artworkLinks, formats,
    checker || ((link) => checkArtworkLinkForUser(user.id, link)));
}

const checkoutChecks = Symbol("artworkCheckoutChecks");
const artworkFingerprint = line => JSON.stringify(artworkAttachmentsFor(line));
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

/** Run checkout code against the catalogue a client may order from, outside a route. */
export function withClientCatalog(store, user, fn) {
  const view = reviewCatalogView(approvedCatalogView(store), user);
  if (view === store) return fn();
  const original = Object.fromEntries([...new Set([...CATALOG_REVIEW_TABLES, ...REVIEW_CATALOG_TABLES])].map(key => [key, store[key]]));
  try {
    for (const key of Object.keys(original)) store[key] = view[key];
    return fn();
  } finally {
    Object.assign(store, original);
  }
}

export async function routeOrderMatch(args) {
  if (!isOrderMatchRoute(args.req.method, args.url.pathname)) return null;
  const { store } = args;
  const view = reviewCatalogView(approvedCatalogView(store), args.user);
  if (view === store) return routeOrderMatchApproved(args);
  const original = Object.fromEntries([...new Set([...CATALOG_REVIEW_TABLES, ...REVIEW_CATALOG_TABLES])].map(key => [key, store[key]]));
  try {
    for (const key of Object.keys(original)) store[key] = view[key];
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
    const snapshot = clientInvoice(invoice.snapshot, { hideSupplierAmounts: Boolean(order.orderType === "express" || basketForOrder(store, orderId)
      || invoice.snapshot.basketId || invoice.snapshot.groups?.length > 1
      || invoice.snapshot.organizationDiscountRateBps > 0 || groupLevelFee(invoice.snapshot.serviceFeeSchedule)) && !privileged, exposeWorking: privileged });
    // Invoices issued before the snapshot carried the split were all 75/25.
    if (snapshot.paymentPlan && snapshot.paymentPlan.downpaymentPercent == null) {
      snapshot.paymentPlan.downpaymentPercent = orderDownpaymentPercent(order);
    }
    return { status: 200, body: { invoice: order.orderType === "express" && !privileged ? expressClientProjection(snapshot) : snapshot }, mutated: false };
  }

  requireClient(user);
  const expressCartPath = /^\/me\/carts\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (expressCartPath && req.method !== 'GET') {
    const cart = (store.carts || []).find(row => row.id === decodeURIComponent(expressCartPath[1]) && row.clientId === user.id);
    if (cart?.orderType === 'express' && !['checkout', 'voucher', 'quote'].includes(expressCartPath[2])) {
      fail(409, 'express_draft_replace_required', 'Create a new Express draft after changing the print settings.');
    }
  }
  if (pathname === '/express/demand' && req.method === 'POST') {
    const mutated = pingPrinterDemand(store, user, record(await readBody(req)), { at: now(), id });
    return {status:200,body:{ok:true},mutated};
  }
  if (pathname === '/express/shops' && req.method === 'POST') {
    return {status:200,body:quotedExpressPrinters(store,user,record(await readBody(req)),now()),mutated:false};
  }
  if (pathname === '/express/shops' && req.method === 'GET') {
    if(!url.searchParams.has('lat')||!url.searchParams.has('lng'))fail(400,'invalid_express_location','Send lat and lng.');
    const filters={};
    for(const key of ['shopsOnly','verifiedOnly'])if(url.searchParams.has(key)) {
      if(!['true','false'].includes(url.searchParams.get(key)))fail(400,'invalid_express_filter');
      filters[key]=url.searchParams.get(key)==='true';
    }
    const options={location:{lat:Number(url.searchParams.get('lat')),lng:Number(url.searchParams.get('lng'))},sort:url.searchParams.get('sort')||'nearest',fulfillmentMode:url.searchParams.get('fulfillmentMode')||'pickup',...filters};
    // Released clients do not understand disabled cards or automatic widening.
    // Keep their three legacy sorts open-only; the file-aware POST opts in.
    const body=['nearest','top_rated','fewest_jobs'].includes(options.sort)
      ?{shops:expressShopList(store,user,options,now()).filter(shop=>(!filters.shopsOnly||shop.printerType==='shop')&&(!filters.verifiedOnly||shop.verified))}
      :expressPrinterChoices(store,user,options,now());
    return {status:200,body,mutated:false};
  }
  if(pathname==='/me/express-guide' && ['GET','PATCH'].includes(req.method)) {
    const guide=req.method==='PATCH'?updateExpressGuide(store,user,await readBody(req),now()):expressGuide(store,user,now());
    return {status:200,body:{guide},mutated:req.method==='PATCH'};
  }
  if(pathname==='/express/drafts' && req.method==='POST') return createExpressDraft(store,user,record(await readBody(req)),id,now());
  if (req.method === "POST" && pathname === "/me/catalog-quotes") {
    const body = record(await readBody(req));
    const item = (store.catalogItems || []).find((row) => row.id === body.catalogItemId);
    if (!item || catalogItemBlockers(store, item, { publicOnly: true }).length) {
      fail(404, "catalog_item_not_found", "That listing is no longer available.");
    }
    if (body.speedTier != null) fail(400, 'invalid_service_level', 'Send a listed speedTierId, never a price object.');
    const speedTier = listingTiming(store, item, { speedTierId: body.speedTierId }).tier;
    const optionIds = body.optionIds ?? [];
    if (!Array.isArray(optionIds)) fail(400, "invalid_catalog_options", "optionIds must be an array.");
    const quantity = positiveInteger(body.quantity, "quantity");
    const measurement = item.pricingUnit === "per_page" && body.measurement?.pages != null
      ? { pages: positiveInteger(body.measurement.pages, "measurement.pages") } : measurementFor(item, body);
    const structuredSpec = body.structuredSpec == null ? {} : record(body.structuredSpec, "structuredSpec");
    assertPrinterCap(store, item, { optionIds, measurement, structuredSpec });
    const { selectedOptions } = selectedCatalogPrice(store, item, optionIds);
    let colourPricing = null;
    if (item.pricedByColour || item.oneColour) {
      const line = {quantity,optionIds,printLayout:body.printLayout ?? null,documentPages:body.pageRange ? {range:body.pageRange} : null,
        quantityMode:parseQuantityMode(body.quantityMode)};
      writeArtworkAttachments(line,body,publicCatalogItem(store,item)?.acceptedFormats);
      for (const fileId of artworkFileIdsFor(line)) fileFor(store,user,fileId,'artwork','artworkFileId');
      colourPricing = colourQuoteFor(store,item,line);
      if (item.pricedByColour) {
        const clientLineSubtotalMinor = clientMoneyMinor(store,colourPricing.lineSubtotalMinor);
        return {status:200,body:{quote:{catalogItemId:item.id,quantity,colourPricing:publicColourQuote(colourPricing,'client',clientLineSubtotalMinor),
          clientLineSubtotalMinor}},mutated:false};
      }
    }
    const priced = priceCatalogSelection(store, item, { selectedOptions, quantity, measurement, speedTier });
    const service = store.supplierServices.find((row) => row.id === item.supplierServiceId);
    return { status: 200, body: { quote: {
      catalogItemId: item.id, version: item.version, serviceVersion: service.version || 1, quantity: priced.quantity,
      ...(colourPricing ? {colourPricing:publicColourQuote(colourPricing,"client",clientMoneyMinor(store,priced.lineSubtotalMinor))} : {}),
      clientUnitRateMinor: clientMoneyMinor(store, priced.unitRateMinor),
      clientLineSubtotalMinor: clientMoneyMinor(store, priced.lineSubtotalMinor),
      billableMilliUnits: priced.billableMilliUnits, minimumMeasurementApplied: priced.minimumMeasurementApplied,
    } }, mutated: false };
  }
  const colourMatch = /^\/me\/carts\/([^/]+)\/colour-analysis$/.exec(pathname);
  if (colourMatch && req.method === 'POST') {
    const cart = ownCart(store,user,decodeURIComponent(colourMatch[1]),{draft:true});
    const body = record(await readBody(req));
    const lines = store.cartLines.filter(line => line.cartId === cart.id);
    let queued = false;
    for (const line of lines) {
      const item = store.catalogItems.find(row => row.id === line.catalogItemId);
      for (const fileId of artworkFileIdsFor(line)) fileFor(store,user,fileId,'artwork','artworkFileId');
      if (item) queued = queueLineColour(store,item,line,now(),{retry:body.retry === true}) || queued;
    }
    return {status:202,body:{quote:clientCartQuote(store,cart,lines,now())},mutated:queued};
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
    return { status: 200, body: { quote: clientCartQuote(store, preview, lines, now()) }, mutated: false };
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
    const addresses = (store.clientAddresses || []).filter((row) => row.clientId === user.id && !row.deletedAt).map(publicAddress);
    return { status: 200, body: { addresses }, mutated: false };
  }
  if (req.method === "DELETE" && /^\/me\/addresses\/[^/]+$/.test(pathname)) {
    const addressId = decodeURIComponent(pathname.split("/")[3]);
    const address = (store.clientAddresses || []).find((row) => row.id === addressId
      && row.clientId === user.id && !row.deletedAt);
    if (!address) fail(404, "address_not_found", "That saved address no longer exists.");
    const at = now();
    const defaultCleared = address.isDefault;
    address.isDefault = false;
    address.deletedAt = at;
    address.updatedAt = at;
    address.version += 1;
    store.auditLog.push({ id: id("aud"), at, actorId: user.id, actorRole: "client",
      action: "client_address.delete", entityType: "client_address", entityId: address.id,
      detail: { defaultCleared } });
    return { status: 200, body: { ok: true, defaultCleared }, mutated: true };
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
    if (body.separateDelivery != null && typeof body.separateDelivery !== "boolean") {
      fail(400, "invalid_separate_delivery", "separateDelivery must be true or false.", { field: "separateDelivery" });
    }
    const separateDelivery = body.separateDelivery === true && Boolean(matchCart);
    const groupExclusions = groupLine ? (store.supplierProfiles || []).filter((profile) => profile.userId !== groupLine.supplierId).map((profile) => profile.userId) : [];
    const input = {
      subcategoryCode: body.subcategoryCode,
      ranking: body.ranking ?? publicPreference(store, user.id).ranking,
      dropoff: requestFulfillment?.dropoff ?? addressPoint(store, user.id, body) ?? matchCart?.defaultDropoff ?? null,
      excludedSupplierIds: [...(body.excludedSupplierIds || []), ...groupExclusions],
      deadline: body.deadline != null ? parseDeadline(body.deadline)
        : groupLine ? groupDeadline(matchCart, cartLines.filter(line => sameDelivery(line, groupLine))) : matchCart?.deadline ?? null,
      deliveryKey: groupLine ? lineDeliveryKey(groupLine) : null, separateDelivery,
      units: body.units == null ? undefined : positiveInteger(body.units, "units"),
      now: at, measurement: body.measurement, structuredSpec: body.structuredSpec,
      optionIds: body.optionIds, widthFeet: body.widthFeet, cartLines: cartLines.map(line => ({ ...line, deadline: lineDeadline(matchCart, line) })),
    };
    const offered = new Map();
    const match = clientFacingMatch(matchShop(store, { ...input, onOffer: (id, projection) => offered.set(id, projection) }));
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
          cartId, speedTierId: listing.scheduling?.rushTier?.id ?? null, deadline: input.deadline, dropoff: input.dropoff,
          offeredProjection: structuredClone(offered.get(listing.id)),
          units: input.units ?? listing.minimumOrderQuantity ?? 1,
          draftFingerprint: (() => {
            const supplierId = store.catalogItems.find(row => row.id === listing.id).supplierId;
            const target = offerTarget(matchCart, cartLines, supplierId, { deliveryKey: input.deliveryKey, separate: separateDelivery, deadline: input.deadline });
            return schedulingWork(matchCart, relevantSchedulingWork(matchCart, cartLines, supplierId, target.deliveryKey, target.deadline));
          })(),
          ...(separateDelivery ? { separateDelivery: true } : input.deliveryKey ? { deliveryKey: input.deliveryKey } : {}),
          ...(requestFulfillment ? { requestFulfillment } : {}),
          subcategoryCode: input.subcategoryCode, ranking: input.ranking } });
      listing.selectToken = token;
    }
    if (cartGroups(matchCart, cartLines).length > 1 || groupLine) {
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

  // "Order the batch now": a new cart holding the intended batch from an
  // approved sample, at the held price or the current one (docs/SAMPLE_FIRST_API.md).
  const sampleCartMatch = /^\/me\/sample-batches\/([^/]+)\/cart$/.exec(pathname);
  if (sampleCartMatch && req.method === "POST") {
    requireClient(user);
    const draft = ownSampleBatch(store, user, decodeURIComponent(sampleCartMatch[1]));
    const body = record(await readBody(req));
    const at = now();
    const pricing = body.pricing ?? "held";
    if (!["held", "current"].includes(pricing)) fail(400, "invalid_sample_batch_pricing", "pricing must be held or current.", { field: "pricing" });
    if (pricing === "held") assertHeldPriceUsable(store, draft, at);
    else if (draft.status === "ordered") fail(409, "sample_batch_ordered", "This batch has already been ordered.", { batchOrderId: draft.batchOrderId });
    else if (draft.status !== "approved") fail(409, "sample_batch_not_approved", "Approve the sample before ordering its batch.", { status: draft.status });
    const item = (store.catalogItems || []).find(row => row.id === draft.catalogItemId);
    if (!item || item.supplierId !== draft.supplierId || catalogItemBlockers(store, item, { publicOnly: true }).length) {
      fail(409, "catalog_item_stale", "The sampled listing is no longer available from this shop.");
    }
    const sample = (store.orders || []).find(row => row.id === draft.sampleOrderId);
    const cart = {
      id: id("cart"), clientId: user.id, state: "draft", version: 1,
      serviceLevel: "standard", fulfillmentMode: sample?.fulfillmentMode === "pickup" ? "pickup" : "delivery", createdAt: at, updatedAt: at,
    };
    // Delivered as the sample was, unless the client chooses again here.
    if (["fulfillmentMode", "defaultDropoff"].some(field => Object.hasOwn(body, field))) {
      Object.assign(cart, fulfillmentInput(body, cart));
    } else if (sample?.requestFulfillment) {
      adoptRequestFulfillment(store, cart, sample.requestFulfillment);
    } else if (cart.fulfillmentMode === "delivery") {
      const job = (store.orderJobs || []).find(row => row.orderId === sample?.id);
      const dropoff = job?.dropoff || sample?.dropoff;
      if (dropoff) cart.defaultDropoff = { lat: dropoff.lat, lng: dropoff.lng, label: dropoff.label };
    }
    if (Object.hasOwn(body, "deadline")) cart.deadline = parseDeadline(body.deadline);
    const batch = draft.batch;
    const line = {
      id: id("cline"), cartId: cart.id, supplierId: draft.supplierId, catalogItemId: item.id,
      optionIds: [...(batch.optionIds || [])],
      quantity: body.quantity == null ? batch.quantity : positiveInteger(body.quantity, "quantity"),
      measurement: batch.measurement ? structuredClone(batch.measurement) : null,
      structuredSpec: structuredClone(batch.structuredSpec || {}),
      speedTierId: batch.speedTierId ?? null,
      sampleBatchDraftId: draft.id, sampleBatchPricing: pricing,
      sortOrder: 0, createdAt: at, updatedAt: at,
    };
    for (const field of ["artworkFileId", "artworkAttachments", "documentPages", "printLayout", "coverSpine", "colorTargets"]) {
      if (batch[field] != null) line[field] = structuredClone(batch[field]);
    }
    if (batch.artworkLinks?.length) line.artworkLinks = structuredClone(batch.artworkLinks);
    if (batch.specialInstructions) line.specialInstructions = batch.specialInstructions;
    for (const fileId of artworkFileIdsFor(line)) fileFor(store, user, fileId, "artwork", "artworkFileId");
    listingTiming(store, item, line);
    assertCartLinePriceable(store, item, line);
    if (cart.deadline) assertMatchDeadline(store, item, line, at, { cart, siblings: [] });
    store.carts ||= [];
    store.carts.push(cart);
    store.cartLines ||= [];
    store.cartLines.push(line);
    lockCartFeeSchedules(store, cart, at);
    store.auditLog ||= [];
    store.auditLog.push({ id: id("aud"), at, actorId: user.id, actorRole: "client", action: "sample_batch.cart_created",
      entityType: "sample_batch", entityId: draft.id, orderId: draft.sampleOrderId,
      detail: { cartId: cart.id, pricing, quantity: line.quantity, sampledQuantity: batch.quantity } });
    return { status: 201, body: { cart: publicCart(store, cart, at) }, mutated: true };
  }

  const cartMatch = /^\/me\/carts\/([^/]+)$/.exec(pathname);
  if (cartMatch && req.method === "GET") {
    const cart = ownCart(store, user, decodeURIComponent(cartMatch[1]));
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: false };
  }
  if (cartMatch && req.method === "PATCH") {
    const cart = ownCart(store, user, decodeURIComponent(cartMatch[1]), { draft: true });
    Object.assign(cart, fulfillmentInput(record(await readBody(req)), cart));
    lockCartFeeSchedules(store, cart, now());
    updateCart(cart, now());
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: true };
  }

  if (pathname === "/me/print-layout-check" && req.method === "GET") {
    // The warnings and preview figures for a product before it is in a cart:
    // the same check a cart line carries, for the options and files on screen.
    requireClient(user);
    const item = (store.catalogItems || []).find((row) => row.id === text(url.searchParams.get("catalogItemId"), "catalogItemId", 120));
    if (!item || !publicCatalogItem(store, item)) fail(409, "catalog_item_stale", "That listing changed or is no longer public.");
    const list = (name) => url.searchParams.getAll(name).flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
    const optionIds = list("optionIds");
    const fileIds = [...new Set(list("fileIds"))];
    if (fileIds.length > 10) fail(400, "invalid_request", "Check at most ten files at once.", { field: "fileIds" });
    for (const fileId of fileIds) fileFor(store, user, fileId, "artwork", "fileIds");
    const layout = parseCartPrintLayout(item, url.searchParams.get("layout") || null, fail);
    return { status: 200, mutated: false, body: { check: printLayoutCheck(store, item, { optionIds, fileIds, layout }) } };
  }

  const groupListingsMatch = /^\/me\/carts\/([^/]+)\/groups\/([^/]+)\/listings$/.exec(pathname);
  if (groupListingsMatch && req.method === "GET") {
    const cart = ownCart(store, user, decodeURIComponent(groupListingsMatch[1]), { draft: true });
    const lines = (store.cartLines || []).filter(line => line.cartId === cart.id)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
    const groupId = decodeURIComponent(groupListingsMatch[2]);
    const group = cartGroups(cart, lines).find(row => row.lines[0].id === groupId);
    if (!group) fail(404, "cart_group_not_found", "That group does not belong to this cart.");
    const suppliers = [...new Set(lines.map(line => line.supplierId))];
    return { status: 200, mutated: false, body: {
      groupId, label: shopLabel(suppliers.indexOf(group.supplierId)), deadline: group.deadline,
      ...cartGroupListings(store, { supplierId: group.supplierId, deadline: group.deadline, deliveryKey: group.deliveryKey,
        cartLines: lines.map(line => ({ ...line, deadline: lineDeadline(cart, line) })), now: now() }),
    } };
  }

  const deliveriesMatch = /^\/me\/carts\/([^/]+)\/groups\/([^/]+)\/deliveries$/.exec(pathname);
  if (deliveriesMatch && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(deliveriesMatch[1]), { draft: true });
    const body = record(await readBody(req));
    const at = now();
    const lines = (store.cartLines || []).filter(line => line.cartId === cart.id)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
    const groupId = decodeURIComponent(deliveriesMatch[2]);
    const group = cartGroups(cart, lines).find(row => row.lines[0].id === groupId);
    if (!group) fail(404, "cart_group_not_found", "That group does not belong to this cart.");
    const shopLines = lines.filter(line => line.supplierId === group.supplierId);
    const deliveries = deliveryPartition(cart, shopLines, body);
    const before = cartGroups(cart, shopLines).map(row => row.lines.map(line => line.id));
    const after = deliveries.map(part => part.map(line => line.id));
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { status: 200, body: { cart: publicCart(store, cart, at) }, mutated: false };
    }
    for (const part of deliveries) assertDeliveryDeadline(store, cart, part, at);
    // The first delivery is the shop's main one; later products join it by default.
    // A delivery that already had its own key keeps it, and with it its fee lock.
    const used = new Set();
    const keys = deliveries.map((part, index) => {
      const existing = part[0].deliveryKey;
      if (index === 0) return null;
      const key = existing && part.every(line => line.deliveryKey === existing) && !used.has(existing) ? existing : id("dlv");
      used.add(key);
      return key;
    });
    deliveries.forEach((part, index) => {
      for (const line of part) {
        if ((line.deliveryKey ?? null) === keys[index]) continue;
        if (keys[index]) line.deliveryKey = keys[index];
        else delete line.deliveryKey;
        line.updatedAt = at;
      }
    });
    lockCartFeeSchedules(store, cart, at);
    updateCart(cart, at);
    store.auditLog ||= [];
    store.auditLog.push({ id: id("aud"), at, actorId: user.id, actorRole: "client",
      action: "cart.deliveries_set", entityType: "cart", entityId: cart.id,
      detail: { supplierId: group.supplierId, split: typeof body.split === "string" ? body.split : "custom",
        before, after, deliveryCount: after.length } });
    return { status: 200, body: { cart: publicCart(store, cart, at) }, mutated: true };
  }

  const voucherRoute = /^\/me\/carts\/([^/]+)\/voucher$/.exec(pathname);
  if (voucherRoute && ['GET', 'POST', 'DELETE'].includes(req.method)) {
    const cart = ownCart(store, user, voucherRoute[1], { draft: true });
    const at = now();
    availableVouchers(store, user.id, at, cart.id);
    if (req.method !== 'GET') {
      let voucher = null;
      if (req.method === 'POST') {
        const body = record(await readBody(req));
        if (body.code != null) {
          const added = addVoucherCode(store, user.id, body.code, { id, at });
          if (added.status >= 400) return added;
          body.voucherId = added.body.voucher.id;
        }
        voucher = availableVouchers(store, user.id, at, cart.id).find(v => v.id === body.voucherId);
        if (!voucher) fail(409, 'voucher_unavailable', 'Choose an available voucher.');
      }
      let choice = store.voucherCartChoices.find(c => c.id === cart.id);
      if (!choice) { choice = { id: cart.id }; store.voucherCartChoices.push(choice); }
      Object.assign(choice, { voucherId: voucher?.id || null, removed: req.method === 'DELETE' });
      releaseVoucherReservations(store, { id, at }, r => r.cartId === cart.id);
      if (voucher) {
        const lines = store.cartLines.filter(line => line.cartId === cart.id).sort((a,b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
        const plan = cartVoucherPlan(store, cart, lines, at);
        if (!plan?.voucher) fail(409, 'voucher_not_better_than_organization', 'The organization discount is equal or greater.');
        reserveVoucher(store, voucher, cart, { id, at });
      }
    }
    return { status: 200, body: { cart: publicCart(store, cart, at), serverTime: at }, mutated: req.method !== 'GET' };
  }

  const specialCartMatch = /^\/me\/carts\/([^/]+)\/(fulfillment|dropoffs|checkout)$/.exec(pathname);
  if (specialCartMatch && specialCartMatch[2] === "checkout" && req.method === "POST") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    if((store.cartLines||[]).some(line=>line.cartId===cart.id&&line.expressPrint?.groupMemberId))fail(409,'group_checkout_required');
    const result = checkoutBasket(store, user, cart, record(await readBody(req)), id, now(), req);
    result.invoice = clientInvoice(result.invoice, { hideSupplierAmounts: Boolean(cart.orderType === "express" || result.basket || result.invoice.organizationDiscountRateBps > 0 || groupLevelFee(result.invoice.serviceFeeSchedule)) });
    return { status: 201, body: cart.orderType === "express" ? expressClientProjection(result) : result, mutated: true };
  }
  if (specialCartMatch && specialCartMatch[2] === "fulfillment" && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(specialCartMatch[1]), { draft: true });
    Object.assign(cart, fulfillmentInput(record(await readBody(req)), cart));
    lockCartFeeSchedules(store, cart, now());
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
    lockCartFeeSchedules(store, cart, now());
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
    // Only accepting the quote puts its listing in a cart, once.
    if (isQuoteListing(item)) fail(409, "quote_line_locked", "Accept the quote to add it; it cannot be added again.");
    if (!Array.isArray(body.optionIds)) fail(400, "invalid_catalog_options", "optionIds must be an array.", { field: "optionIds" });
    selectedCatalogPrice(store, item, body.optionIds);
    const at = now();
    const lines = (store.cartLines || []).filter((row) => row.cartId === cart.id);
    // Sample First: a sample, or a batch made from one, is ordered on its own.
    if (body.sample != null && typeof body.sample !== "boolean") fail(400, "invalid_sample", "sample must be true or false.", { field: "sample" });
    const wantsSample = body.sample === true;
    if (sampleFirstCartKind(lines) || (wantsSample && lines.length)) {
      fail(409, "sample_cart_exclusive", "A sample, or a batch made from one, is ordered on its own. Use a new cart.");
    }
    if (wantsSample && !publicSampleOffer(store, approvedCatalogView(store).catalogItems.find(row => row.id === item.id) || item).sampleAvailable) {
      fail(409, "sample_unavailable", "This listing does not offer a sample.");
    }
    if (!wantsSample && body.replacesSampleBatchId != null) fail(400, "invalid_sample", "replacesSampleBatchId needs sample: true.", { field: "replacesSampleBatchId" });
    const replacedDraft = wantsSample && body.replacesSampleBatchId != null ? replaceableDraft(store, user, body.replacesSampleBatchId) : null;
    if (selection && (item.supplierId !== selection.supplierId || item.subcategoryCode !== selection.subcategoryCode)) {
      fail(409, "catalog_item_stale", "That listing changed since matching; match again.");
    }
    if (selection && ((store.supplierProfiles || []).find((row) => row.userId === item.supplierId)?.isClosed || shopPaused((store.supplierProfiles || []).find(row => row.userId === item.supplierId), at))) {
      fail(409, "catalog_item_stale", "That shop is no longer accepting work; match again.");
    }
    const explicitDeadline = Object.hasOwn(body, "deadline") ? parseDeadline(body.deadline) : null;
    if (selection && explicitDeadline && explicitDeadline !== (selection.deadline ? parseDeadline(selection.deadline) : null)) {
      fail(409, "select_token_deadline_mismatch", "Use the date selected by this match, or match again.");
    }
    if (body.separateDelivery != null && typeof body.separateDelivery !== "boolean") {
      fail(400, "invalid_separate_delivery", "separateDelivery must be true or false.", { field: "separateDelivery" });
    }
    if (selection && body.separateDelivery != null && body.separateDelivery !== (selection.separateDelivery === true)) {
      fail(409, "select_token_delivery_mismatch", "Match again to change whether this is delivered separately.");
    }
    const measurement = measurementFor(item, body);
    const structuredSpec = body.structuredSpec == null ? {} : structuredClone(record(body.structuredSpec, "structuredSpec"));
    assertPrinterCap(store, item, { measurement, structuredSpec, optionIds: body.optionIds });
    const line = {
      id: id("cline"), cartId: cart.id, supplierId: item.supplierId, catalogItemId: item.id,
      optionIds: [...body.optionIds], quantity: positiveInteger(body.quantity, "quantity"),
      measurement,
      ...((explicitDeadline || selection?.deadline) ? { deadline: explicitDeadline || parseDeadline(selection.deadline) } : {}),
      ...((selection?.deadline || cart.deadline) ? { matchDeadline: selection?.deadline || cart.deadline } : {}),
      structuredSpec,
      // Joins the shop's main delivery, the matched group's delivery, or a new one.
      ...((selection ? selection.separateDelivery : body.separateDelivery === true) ? { deliveryKey: id("dlv") }
        : selection?.deliveryKey ? { deliveryKey: selection.deliveryKey } : {}),
      speedTierId: selection?.speedTierId ?? body.speedTierId ?? null,
      sortOrder: lines.reduce((maximum, row) => Math.max(maximum, row.sortOrder), -1) + 1,
      createdAt: at, updatedAt: at,
    };
    if (selection && body.speedTierId != null && body.speedTierId !== selection.speedTierId) fail(409, 'select_token_tier_mismatch', 'Use the selected speed tier.');
    listingTiming(store, item, line);
    if (wantsSample) {
      // One sample piece at the shop's standard speed; the quantity and speed
      // sent are the intended batch's, kept for its draft and held price.
      line.sample = { batchQuantity: line.quantity, ...(line.speedTierId ? { speedTierId: line.speedTierId } : {}),
        ...(replacedDraft ? { replacesDraftId: replacedDraft.id } : {}) };
      line.quantity = 1;
      line.speedTierId = null;
    }
    if (Object.hasOwn(body, "specialInstructions")) line.specialInstructions = specialInstructions(body.specialInstructions);
    writeArtworkAttachments(line, body, publicCatalogItem(store, item)?.acceptedFormats);
    for (const fileId of artworkFileIdsFor(line)) fileFor(store, user, fileId, "artwork", "artworkFileId");
    assertListingArtwork(store, item, line);
    syncDocumentPages(store, item, line, body);
    // Optional here so a cart can be filled in steps; checkout requires it.
    if (Object.hasOwn(body, "printLayout")) line.printLayout = parseCartPrintLayout(item, body.printLayout, fail);
    if (Object.hasOwn(body, "colorTargets")) {
      const targets = parseColorTargets(body.colorTargets);
      if (targets.length) line.colorTargets = targets;
    }
    if (Object.hasOwn(body, "coverSpine")) {
      line.coverSpine = parseCoverSpine(item, body.coverSpine, fail);
      assertCoverFileAttached(line, fail);
    }
    if (Object.hasOwn(body,"quantityMode")) line.quantityMode = parseQuantityMode(body.quantityMode);
    queueLineColour(store,item,line,at);
    assertCartLinePriceable(store, item, line);
    if (body.dropoff != null) line.dropoff = point(body.dropoff, "dropoff");
    if (!bindOfferedGroup(store, cart, line, selection)) {
      assertMatchDeadline(store, item, line, at, { cart, siblings: lines.filter(row => sameDelivery(row, line)) });
    }
    store.cartLines ||= [];
    store.cartLines.push(line);
    lockCartFeeSchedules(store, cart, at);
    updateCart(cart, at);
    return { status: 201, body: { cart: publicCartForLineMutation(store, cart, at) }, mutated: true };
  }

  const lineMatch = /^\/me\/carts\/([^/]+)\/lines\/([^/]+)$/.exec(pathname);
  if (lineMatch && ["PATCH", "DELETE"].includes(req.method)) {
    const cart = ownCart(store, user, decodeURIComponent(lineMatch[1]), { draft: true });
    const lineId = decodeURIComponent(lineMatch[2]);
    const storedLine = (store.cartLines || []).find((row) => row.id === lineId && row.cartId === cart.id);
    const line = storedLine ? structuredClone(storedLine) : null;
    if (!line) fail(404, "cart_line_not_found", "That cart line no longer exists.");
    const at = now();
    if (req.method === "DELETE") {
      store.cartLines = store.cartLines.filter((row) => row !== storedLine);
      lockCartFeeSchedules(store, cart, at);
    updateCart(cart, at);
      return { status: 200, body: { cart: publicCartForLineMutation(store, cart, at) }, mutated: true };
    }
    let body = record(await readBody(req));
    // The accepted quote fixed what is made and for how much, including the brief
    // carried in structuredSpec; artwork, notes and the drop-off stay editable.
    if (isQuoteListing((store.catalogItems || []).find(row => row.id === line.catalogItemId))
        && ["quantity", "optionIds", "measurement", "deadline", "speedTierId", "printLayout", "coverSpine", "quantityMode",
          "structuredSpec", "colorTargets"].some(field => Object.hasOwn(body, field))) {
      fail(409, "quote_line_locked", "The accepted quote fixes this product. Cancel it and request a new quote to change it.");
    }
    // A batch made from an approved sample keeps the sample's specs: changed
    // specs are a new sample, never the held price. Only how many and where.
    if (line.sampleBatchDraftId) {
      const locked = Object.keys(body).filter(key => !["quantity", "dropoff", "deadline"].includes(key));
      if (locked.length) fail(409, "sample_batch_specs_locked", "A batch from a sample keeps the sample's specs. Order another sample to change them.", { fields: locked });
    }
    // On a sample line `quantity` is the intended batch; the sample stays one piece.
    let sampleRepriced = false;
    if (line.sample && Object.hasOwn(body, "quantity")) {
      line.sample = { ...line.sample, batchQuantity: positiveInteger(body.quantity, "quantity") };
      body = { ...body };
      delete body.quantity;
      sampleRepriced = true;
    }
    if (line.sample && Object.hasOwn(body, "speedTierId")) fail(409, "sample_speed_fixed", "A sample is made at the shop's standard speed.", { field: "speedTierId" });
    const before = { quantity: line.quantity, optionIds: line.optionIds, measurement: line.measurement };
    if (Object.hasOwn(body, 'speedTierId')) {
      const item = store.catalogItems.find(item => item.id === line.catalogItemId);
      listingTiming(store, item, body);
      line.speedTierId = body.speedTierId;
    }
    if (Object.hasOwn(body, "deadline")) {
      const deadline = parseDeadline(body.deadline);
      const item = (store.catalogItems || []).find(row => row.id === line.catalogItemId);
      if (!item || catalogItemBlockers(store, item, { publicOnly: true }).length) fail(409, "catalog_item_stale", "That listing is no longer available.");
      assertMatchDeadline(store, item, { ...line, deadline, quantity: body.quantity == null ? line.quantity : positiveInteger(body.quantity, "quantity") }, at,
        { cart, siblings: (store.cartLines || []).filter(row => row.cartId === cart.id && sameDelivery(row, line)) });
      line.deadline = deadline;
    }
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
    if (Object.hasOwn(body, "dropoff")) line.dropoff = point(body.dropoff, "dropoff", { required: false });
    const patchedItem = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
    if (Object.hasOwn(body, "specialInstructions")) line.specialInstructions = specialInstructions(body.specialInstructions);
    // Replaced as a whole; [] or null clears them.
    if (Object.hasOwn(body, "colorTargets")) {
      const targets = parseColorTargets(body.colorTargets);
      line.colorTargets = targets.length ? targets : null;
    }
    writeArtworkAttachments(line, body, patchedItem ? publicCatalogItem(store, patchedItem)?.acceptedFormats : []);
    if (["artworkFileId", "artworkAttachments"].some(key => Object.hasOwn(body, key))) {
      for (const fileId of artworkFileIdsFor(line)) fileFor(store, user, fileId, "artwork", "artworkFileId");
      if (patchedItem) assertListingArtwork(store, patchedItem, line);
    }
    if (patchedItem) syncDocumentPages(store, patchedItem, line, body, { previousFileId: storedLine.artworkFileId });
    if (Object.hasOwn(body, "printLayout")) {
      if (!patchedItem) fail(409, "catalog_item_stale", "That listing is no longer available.");
      line.printLayout = parseCartPrintLayout(patchedItem, body.printLayout, fail);
    }
    if (Object.hasOwn(body, "coverSpine")) {
      if (!patchedItem) fail(409, "catalog_item_stale", "That listing is no longer available.");
      line.coverSpine = parseCoverSpine(patchedItem, body.coverSpine, fail);
    }
    // A separate cover page must stay one of the line's files, whichever side changed.
    if (["coverSpine", "artworkFileId", "artworkAttachments"].some(key => Object.hasOwn(body, key))) assertCoverFileAttached(line, fail);
    if (patchedItem) assertPrinterCap(store, patchedItem, { line, optionIds: line.optionIds, measurement: line.measurement, structuredSpec: line.structuredSpec });
    // Only a change to what the line is priced on is held to the shop's
    // minimum. Attaching artwork to a line the shop has since put out of reach
    // is still allowed; the quantity is fixed through the sheet, not here.
    const repriced = sampleRepriced || ["quantity", "optionIds", "measurement"].some((field) => Object.hasOwn(body, field))
      || (patchedItem?.pricingUnit === "per_page" && ["artworkFileId", "artworkAttachments", "pageRange"].some(field => Object.hasOwn(body, field)));
    if (repriced && patchedItem) {
      try {
        assertCartLinePriceable(store, patchedItem, line);
      } catch (error) {
        Object.assign(line, before);
        throw error;
      }
    }
    if (Object.hasOwn(body,"quantityMode")) line.quantityMode = parseQuantityMode(body.quantityMode);
    if (patchedItem) queueLineColour(store,patchedItem,line,at);
    line.updatedAt = at;
    Object.assign(storedLine, line);
    lockCartFeeSchedules(store, cart, at);
    updateCart(cart, at);
    return { status: 200, body: { cart: publicCartForLineMutation(store, cart, at) }, mutated: true };
  }

  const warningsMatch = /^\/me\/carts\/([^/]+)\/lines\/([^/]+)\/artwork-warnings$/.exec(pathname);
  if (warningsMatch && req.method === "PUT") {
    const cart = ownCart(store, user, decodeURIComponent(warningsMatch[1]), { draft: true });
    const line = (store.cartLines || []).find((row) => row.id === decodeURIComponent(warningsMatch[2]) && row.cartId === cart.id);
    if (!line) fail(404, "cart_line_not_found", "That cart line no longer exists.");
    const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
    if (!item) fail(409, "catalog_item_stale", "That listing is no longer available.");
    const at = now();
    acceptArtworkWarnings(store, item, line, artworkFileIdsFor(line), record(await readBody(req)), at, fail);
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
    lockCartFeeSchedules(store, cart, line.updatedAt);
    updateCart(cart, line.updatedAt);
    return { status: 200, body: { cart: publicCart(store, cart, now()) }, mutated: true };
  }

  return null;
}

export function expressConfirmation(cart,lines) {
 return createHash('sha256').update(JSON.stringify({cartId:cart.id,fulfillmentMode:cart.fulfillmentMode,dropoff:cart.defaultDropoff ?? null,
   lines:lines.map(l=>({id:l.id,catalogItemId:l.catalogItemId,optionIds:l.optionIds,dropoff:l.dropoff ?? null,supplierId:l.supplierId,fileId:l.artworkFileId,quantity:l.quantity,documentPages:l.documentPages,print:l.expressPrint,layout:l.printLayout,note:l.specialInstructions || ''}))},
   // JSONB sorts object keys; omitted nullable fields also return as absent.
   // Bind the preview to its values, independent of a PostgreSQL round trip.
   (_key,value)=>value && !Array.isArray(value) && typeof value==='object'
     ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value)).digest('hex');
}
export function createExpressDraft(store,user,body,id,at,selectionPolicy=null,groupOwners=null) {
 const location=expressPoint(body.location);
 const matchingPoint=body.fulfillmentMode==='delivery'&&body.dropoff?expressPoint(body.dropoff):location;
 if(!['pickup','delivery'].includes(body.fulfillmentMode)) fail(400,'invalid_fulfillment_mode','Choose pickup or delivery.');
 const productType=body.productType||'documents';
 if(homeProfile(store,body.supplierId)&&(productType!=='documents'||body.files?.some(f=>!['short','a4','long'].includes(f.paper))))fail(409,'home_documents_only');
 if(!['documents','plans'].includes(productType))fail(400,'invalid_express_product_type');
 if(body.selection!=null&&body.selection!=='just_print_it')fail(400,'invalid_express_selection');
 if(body.acceptFirst!=null&&typeof body.acceptFirst!=='boolean')fail(400,'invalid_express_accept_first');
 // Group orders keep their own flow; accept-first is for one client's request.
 if(body.acceptFirst===true&&groupOwners)fail(409,'express_accept_first_unavailable');
 // Accept-first is opt-in so released apps that pay at checkout keep their flow.
 const acceptFirst=body.acceptFirst===true;
 const routing=acceptFirst?expressRouting(body,productType):null;
 if(body.selection==='just_print_it') {
  if(body.supplierId!=null)fail(400,'invalid_express_selection');
  if(productType==='plans'||body.files?.some(file=>file.paper==='a3'))fail(409,'express_manual_selection_required');
  const choice=fastestPermittedPrinter(quotedExpressPrinters(store,user,{...body,sort:'all_davao'},at),body.fareLimit);
  return createExpressDraft(store,user,{...body,selection:undefined,supplierId:choice.supplierId},id,at,{mode:'just_print_it',fareLimit:body.fareLimit});
 }
 const shop=expressShopList(store,user,{location:matchingPoint,fulfillmentMode:body.fulfillmentMode,productType},at).find(s=>s.supplierId===body.supplierId);
 if(!shop)fail(409,'express_shop_unavailable','Choose an open Express shop.');
 if(!Array.isArray(body.files)||!body.files.length||body.files.length>(groupOwners?300:20))fail(400,'invalid_express_files','Send one to twenty files.');
 const cart={id:id('cart'),clientId:user.id,state:'draft',version:1,orderType:'express',expressLocation:location,
   serviceLevel:'standard',fulfillmentMode:body.fulfillmentMode,defaultDropoff:body.fulfillmentMode==='delivery'?point(body.dropoff,'dropoff',{required:true,requireLabel:true}):null,createdAt:at,updatedAt:at};
 const lines=body.files.map((input,index)=>{
   record(input,'file');
   const item=input.catalogItemId?store.catalogItems.find(i=>i.id===input.catalogItemId):shop.catalogItemIds.map(id=>store.catalogItems.find(i=>i.id===id)).find(i=>{
     try{expressCatalogOptions(store,i,{...input,productType},{ownPrice:acceptFirst});return true;}catch(error){if(error.status)return false;throw error;}
   });
   if(!item||!shop.catalogItemIds.includes(item.id))fail(409,'express_listing_unavailable','Choose an Express document listing.');
   fileFor(store,groupOwners?.get(input.fileId)||user,input.fileId,'artwork','fileId');
   if(!['bw','colour'].includes(input.colour)||!(productType==='plans'?['a4','a3','a2','a1','a0','30x40']:['a4','short','long','a3']).includes(input.paper)||!['one','two'].includes(input.sides)) fail(400,'invalid_express_print','Choose colour, paper and sides.');
   if(!Array.isArray(input.acceptedWarnings)||input.acceptedWarnings.length>20||input.acceptedWarnings.some(w=>!['paper_size_mismatch','rgb_colour'].includes(w))) fail(400,'invalid_express_warnings','Send accepted warning codes.');
   if(input.optionIds != null)fail(400,'express_options_managed','Express selects standard print options from the print settings.');
   const standard=expressCatalogOptions(store,item,{...input,productType},{ownPrice:acceptFirst});
   const line={id:id('line'),cartId:cart.id,supplierId:shop.supplierId,catalogItemId:item.id,quantity:positiveInteger(input.copies,'copies'),
     optionIds:standard.optionIds,artworkFileId:input.fileId,printLayout:parseCartPrintLayout(item,input.layout,fail),sortOrder:index,createdAt:at,updatedAt:at,
     specialInstructions:specialInstructions(input.note),
     expressPrint:{...(selectionPolicy?{selection:structuredClone(selectionPolicy)}:{}),...(routing?{routing:structuredClone(routing)}:{}),...(productType==='plans'?{productType}:{}),colour:input.colour,paper:input.paper,paperStock:standard.paperStock,sides:input.sides,rateMinor:standard.rateMinor,acceptedWarnings:[...new Set(input.acceptedWarnings)]},
     structuredSpec:{size:input.paper,colourMode:input.colour,sides:input.sides}};
   line.documentPages=documentPagesFor(store,productType==='plans'?{...item,pricingUnit:'per_page'}:item,line,input.pageRange??null,{required:true});line.measurement={pages:line.documentPages.printed};
   expressLinePrice(line);assertListingArtwork(store,item,line);
   return line;
 });
 assertExpressNightJob(store,shop.supplierId,lines,cart.fulfillmentMode,at);
 store.carts.push(cart);store.cartLines.push(...lines);
 lockCartFeeSchedules(store,cart,at);
 // The upload proves mission step one; no order or reward is manufactured.
 let tester=(store.foundingTesters||=[]).find(t=>t.clientId===user.id);
 if(!tester){tester={clientId:user.id};store.foundingTesters.push(tester);}tester.addedAt ||= at;
 const quote=clientCartQuote(store,cart,lines,at);
 // Home printers stay small while QR payments are confirmed by hand.
 const homeLimit=homeProfile(store,shop.supplierId)?homePrinterLimitMinor(store.settings):null;
 if(homeLimit!=null&&quote.totalMinor!=null&&quote.totalMinor>homeLimit) {
  store.carts=store.carts.filter(row=>row!==cart);store.cartLines=store.cartLines.filter(row=>!lines.includes(row));
  fail(409,'home_printer_order_limit','Home printers take orders up to the manual payment limit.');
 }
 delete quote.voucherGroups; delete quote.downpaymentPercent;
 shop.readyAt=projectListingGroup(store,lines,{now:at}).projection.promiseBy;
 return {status:201,body:{cartId:cart.id,confirmation:expressConfirmation(cart,lines),paymentTiming:acceptFirst||lines.some(l=>l.expressPrint.paper==='a3'||l.expressPrint.productType==='plans')?'after_acceptance':'checkout',
  ...(acceptFirst?{acceptFirst:true}:{}),quote,shop},mutated:true};
}
const ROUTING_SORTS=['nearest','nearby','all_davao','fastest','top_rated','lowest_price','fewest_jobs','cheapest','ready_soonest'];
/** The client's list order and filters, kept so a refused request moves the same way. */
function expressRouting(body,productType) {
 const sort=body.sort??'nearest';
 if(!ROUTING_SORTS.includes(sort))fail(400,'invalid_express_sort');
 for(const key of ['shopsOnly','verifiedOnly'])if(body[key]!=null&&typeof body[key]!=='boolean')fail(400,'invalid_express_filter');
 return {sort,shopsOnly:body.shopsOnly===true,verifiedOnly:body.verifiedOnly===true,productType,roundAsked:1,round:1};
}

/** Preview the same draft builder with isolated draft arrays. No carts, missions,
 * vouchers, notifications or IDs are persisted by the printer-list read. */
export function quotedExpressPrinters(store,user,body,at) {
 if(!Array.isArray(body.files)||!body.files.length||body.files.length>20)fail(400,'invalid_express_files');
 const location=expressPoint(body.fulfillmentMode==='delivery'?body.dropoff:body.location);
 const rows=expressShopList(store,user,{location,fulfillmentMode:body.fulfillmentMode,includeClosed:true,productType:body.productType},at);
 const quoted=[];
 for(const shop of rows) {
  // Closed cards remain visible but cannot manufacture a current checkout quote.
  if(!shop.selectable){quoted.push(shop);continue;}
  const preview={...store,carts:[],cartLines:[],foundingTesters:[]};let sequence=0;
  try {
   const result=createExpressDraft(preview,user,{...body,selection:undefined,supplierId:shop.supplierId},prefix=>`preview_${prefix}_${++sequence}`,at).body;
   if(result.quote.status!=='priced')continue;
   const privatePoint=store.supplierProfiles.find(profile=>profile.userId===shop.supplierId).shop;
   // The card total is this checkout quote, never a sum of display prices.
   quoted.push({...shop,readyAt:result.shop.readyAt,quote:result.quote,paymentTiming:result.paymentTiming,
    price:expressCardPrice(result.quote,preview.cartLines),
    paymentMethods:expressPaymentMethods(store,user,{home:shop.printerType==='home',verified:shop.verified,fulfillmentMode:body.fulfillmentMode,printAndFeeMinor:result.quote.clientItemSubtotalMinor}),
    deliveryFareMinor:deliveryFeeForDistance(distanceMetersBetween(privatePoint,location),store.settings)});
  } catch(error) {
   if(!['express_listing_unavailable','express_listing_configuration_required','document_capability_unavailable','express_night_capacity','express_shop_unavailable','print_layout_not_supported','artwork_file_format_not_accepted','home_printer_order_limit'].includes(error.code))throw error;
  }
 }
 return expressPrinterChoices(store,user,{...body,location},at,quoted);
}
