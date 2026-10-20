import { sameReviewData, reportOrderAllowed } from './review-data.js';
import { performanceTopPick } from './supplier-performance-policy.js';
import { shopHoursStatus } from './shop-hours.js';
import { operatingHours, reviewTiming, schedulingDay, deadlineDayReason, dispatchReadyAt } from './operating-hours.js';
import { addOpeningMilliseconds } from './availability.js';
import { shopProductionDayMinutes, displayProductionDayMinutes } from "./production-days.js";
import { cartGroups } from "./cart-groups.js";
import { approvedCatalogView } from "./catalog-review-state.js";
import { riderPackingFlow } from './shop-handover.js';
import { recentLapseQualityPenalty, productionTiming } from './production-penalties.js';
import { distanceMetersBetween, distanceZoneForDistance } from "./operational-model.js";
import { itemTurnaroundHours, listingFitsPrinterCap, publicCatalogItem } from "./supplier-catalog.js";
import { defaultShopSchedule, fitsDeadline, projectFinish } from "./availability.js";
import { listingExpress } from "./express.js";
import { supplierMatchBlockersFor } from "./supplier-eligibility.js";
import { shopRating, publicShopRating, MIN_REVIEWS_FOR_RATING } from "./shop-rating.js";
export { shopRating, MIN_REVIEWS_FOR_RATING } from "./shop-rating.js";

/**
 * Which press runs a job.
 *
 * Two steps, and the order of them is the whole design. First a filter: a shop
 * that cannot do the work, or cannot do it by the date the client gave, is not
 * offered -- it is not ranked lower, it is absent. Only then does the client's
 * own ordering of quality, speed, cost and distance choose between whoever is
 * left.
 *
 * That order matters because "can you make Friday?" is not a preference. A
 * marketplace that scores it as one will cheerfully hand a client the best shop
 * that happens to miss their deadline, and only admit it at checkout.
 *
 * The ranking stays a strict ordering rather than weights, for the reason the
 * client app states: nobody can honestly say "quality 0.6", and a strict order
 * always produces one winner and always produces a sentence -- which is what
 * the card prints under its WHY band.
 */

export const MATCH_FACTORS = Object.freeze(["quality", "speed", "cost", "distance"]);
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/** One working day, until Operations sets its own. See `projectFinish`. */
const DEFAULT_ALLOWANCE_MINUTES = 600;

const FINISHED_ORDER_STATES = new Set(['picked_up', 'out_for_delivery', 'delivered', 'issue_window_open', 'completed', 'cancelled', 'payout_released']);

const ACTIVE_JOB_STATES = new Set([
  "needs_qa",
  "client_correction",
  "approved_for_production",
  "production",
  "supplier_self_qc",
  "ready_for_dispatch",
  "rider_assigned",
]);

export class MatchError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "MatchError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details = {}) {
  throw new MatchError(status, code, message, details);
}

export function validatePreferenceRanking(value) {
  if (!Array.isArray(value) || value.length !== MATCH_FACTORS.length) {
    fail(400, "invalid_preference_ranking", "ranking must contain quality, speed, cost, and distance exactly once.", {
      field: "ranking",
      allowed: MATCH_FACTORS,
    });
  }
  const ranking = value.map((factor) => String(factor));
  if (new Set(ranking).size !== MATCH_FACTORS.length || MATCH_FACTORS.some((factor) => !ranking.includes(factor))) {
    fail(400, "invalid_preference_ranking", "ranking must contain quality, speed, cost, and distance exactly once.", {
      field: "ranking",
      allowed: MATCH_FACTORS,
    });
  }
  return ranking;
}

export function multiplyMinor(unitPriceMinor, quantity, field = "money") {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0
      || !Number.isSafeInteger(quantity) || quantity < 0) {
    fail(400, "invalid_money", `${field} must use non-negative safe integers.`, { field });
  }
  const result = BigInt(unitPriceMinor) * BigInt(quantity);
  if (result > MAX_SAFE_MINOR) {
    fail(400, "invalid_money", `${field} exceeds the supported safe-integer range.`, { field });
  }
  return Number(result);
}

function point(value, { required = false, field = "dropoff" } = {}) {
  if (value == null && !required) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.lat !== "number" || !Number.isFinite(value.lat) || value.lat < -90 || value.lat > 90
      || typeof value.lng !== "number" || !Number.isFinite(value.lng) || value.lng < -180 || value.lng > 180) {
    fail(400, required ? "dropoff_required" : "invalid_location", `${field} must include valid numeric lat and lng.`, { field });
  }
  return { lat: value.lat, lng: value.lng, ...(String(value.label || "").trim() ? { label: String(value.label).trim() } : {}) };
}

/** How completely a shop has described what it sells. The stand-in for a rating. */
function listingCompleteness(item) {
  let score = 50; // approved supplier standing
  if (String(item.name || "").trim()) score += 8;
  if (String(item.description || "").trim()) score += 10;
  if (Number.isSafeInteger(item.fromPriceMinor) && item.fromPriceMinor >= 0) score += 7;
  if (Number.isFinite(item.turnaroundHours) && item.turnaroundHours > 0) score += 7;
  if ((item.photos || []).length) score += 7;
  if ((item.acceptedFormats || []).length) score += 5;
  if ((item.optionGroups || []).length) score += 3;
  if ((item.prepSteps || []).length) score += 3;
  return Math.min(100, score);
}

/** Whether the shop hit the date its own board promised, across finished work. */
export function onTimeRate(store, supplierId) {
  const finished = (store.orders || []).filter(
    (order) => reportOrderAllowed(store, order.id) && order.supplierId === supplierId && order.readyBy && productionTiming(order, null).finishedAt,
  );
  if (finished.length === 0) return null;
  const onTime = finished.filter((order) => order.shopClock || riderPackingFlow(order)
    ? productionTiming(order, null).elapsedMs <= 0 : Date.parse(order.readyAt) <= Date.parse(order.readyBy));
  return { count: finished.length, rate: onTime.length / finished.length };
}

function capabilityScore(store, supplierId, listings) {
  const rating = shopRating(store, supplierId);
  if (rating && rating.count >= MIN_REVIEWS_FOR_RATING) return Math.min(100, rating.average * 20);
  return Math.max(...listings.map(listingCompleteness));
}

/** The cheapest this shop could do the job for, before options and quantity. */
function fromPrice(listings) {
  const prices = listings
    .map((item) => (Number.isSafeInteger(item.fromPriceMinor) ? item.fromPriceMinor : item.basePriceMinor))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * Work already committed to this shop, in minutes.
 *
 * Read from both places a job can be recorded: the per-shop jobs a cart
 * checkout writes, and orders assigned to the shop directly. One of those is on
 * its way out, and counting only one of them would understate a real queue.
 */
function productionQueueEligible(order, supplierId) {
  if (!order) return true; // Synthetic draft reservations have no parent yet.
  if (FINISHED_ORDER_STATES.has(order.state)) return false;
  const recovery = order.shopRecovery;
  // Recovery withdraws work from the failed shop even while payment/refund or
  // client consent keeps the order's ordinary lifecycle state unchanged.
  return !recovery || recovery.originalSupplierId !== supplierId
    || (recovery.status === 'accepted' && order.supplierId === supplierId);
}

function queueMinutesFor(store, supplierId, fallbackHours) {
  const supplier = store.users?.find(user => user.id === supplierId);
  const ordersById = new Map((store.orders || []).map(order => [order.id, order]));
  const orderScope = orderId => sameReviewData(ordersById.get(orderId), supplier);
  const relatedJobs = (store.orderJobs || []).filter(job => job.supplierId === supplierId && orderScope(job.orderId));
  const jobs = relatedJobs.filter(
    (job) => ACTIVE_JOB_STATES.has(job.state)
      // Parent state is authoritative even when an older transition left a stale job.
      // Synthetic draft jobs have no parent yet and still reserve queue capacity.
      && productionQueueEligible(ordersById.get(job.orderId), supplierId),
  );
  const orders = (store.orders || []).filter(
    (order) => orderScope(order.id) && order.supplierId === supplierId
      && (ACTIVE_JOB_STATES.has(order.state)
        || (order.state === 'supplier_assigned' && order.shopRecovery?.status === 'accepted'))
      && productionQueueEligible(order, supplierId)
      && !relatedJobs.some((job) => job.orderId === order.id),
  );
  const hours = [...jobs, ...orders].reduce((total, row) => {
    const estimate = Number.isFinite(row.estimatedHours) && row.estimatedHours > 0
      ? row.estimatedHours
      : fallbackHours;
    return total + estimate;
  }, 0);
  return { jobsAhead: jobs.length + orders.length, minutes: hours * 60 };
}

function normalizedInverse(value, best) {
  if (value === 0) return 100;
  if (!Number.isFinite(value) || !Number.isFinite(best)) return 0;
  return Math.max(0, Math.min(100, (best / value) * 100));
}

function approvedOpenSuppliers(store) {
  const blockersFor = supplierMatchBlockersFor(store);
  const profiles = new Map();
  for (const profile of (store.supplierProfiles || [])) {
    if (blockersFor(profile.userId, profile).length) continue;
    profiles.set(profile.userId, profile);
  }
  return profiles;
}

function matchShopCard(profile, listings, settings, at) {
  return {
    supplierId: profile.userId,
    shopName: profile.shopName,
    hours: shopHoursStatus(profile, settings, at),
    shop: profile.shop,
    media: [],
    categories: [...new Set(listings.map((item) => item.categoryCode))],
    services: [],
  };
}

/** A shop's opening hours, or the platform default until it sets its own. */
function scheduleFor(profile) {
  return profile?.schedule || defaultShopSchedule();
}

function allowanceMinutesFrom(settings) {
  const declared = settings?.promiseAllowanceMinutes;
  return Number.isSafeInteger(declared) && declared >= 0 ? declared : DEFAULT_ALLOWANCE_MINUTES;
}

/** One ready-by rule for every new quote, including Express and listed tiers. */
export function projectShopFinish(store, { supplierId, turnaroundHours, turnaroundDays, turnaroundMinutes,
  minimumTurnaroundHours = null, units, now, express = false, deadline = null }) {
  const hours = Number.isSafeInteger(turnaroundDays) && turnaroundDays > 0
    ? turnaroundDays * shopProductionDayMinutes(store, supplierId) / 60
    : Number.isSafeInteger(turnaroundMinutes) && turnaroundMinutes > 0 ? turnaroundMinutes / 60
    : Number.isFinite(turnaroundHours) && turnaroundHours > 0 ? turnaroundHours : 24;
  const shortest = minimumTurnaroundHours > 0 ? Math.min(hours, minimumTurnaroundHours) : hours;
  const profile = (store.supplierProfiles || []).find(row => row.userId === supplierId);
  const queue = queueMinutesFor(store, supplierId, hours);
  const capacityDaily = (store.supplierServices || []).filter(row => row.supplierId === supplierId && row.state === 'live')
    .reduce((best, row) => Number.isSafeInteger(row.capacityDaily) ? Math.max(best, row.capacityDaily) : best, 0);
  const project = duration => {
    const sameDay = duration * 60 < (displayProductionDayMinutes(store, supplierId) ?? 600);
    const review = reviewTiming(store.settings, now, { sameDay });
    const projection = projectFinish({ schedule: scheduleFor(profile), now: review.reviewCompletesAt,
      preserveSeconds: true, queueMinutes: queue.minutes, turnaroundMinutes: duration * 60,
      units: Number.isSafeInteger(units) && units > 0 ? units : null, capacityDaily: capacityDaily || null });
    projection.review = review;
    projection.promiseBy = dispatchReadyAt(store.settings, addOpeningMilliseconds(operatingHours(store.settings).schedule,
      projection.readyBy, allowanceMinutesFrom(store.settings) * 60000));
    if (schedulingDay(projection.promiseBy) === schedulingDay(now) && deadlineDayReason(store.settings, projection.promiseBy, now)) {
      const tomorrow = new Date(Date.parse(`${schedulingDay(now)}T00:00:00+08:00`) + 86400000).toISOString();
      projection.promiseBy = dispatchReadyAt(store.settings, tomorrow);
    }
    return { ...projection, sameDay };
  };
  const earliest = project(shortest), secured = shortest === hours ? earliest : project(hours);
  const reason = deadline ? deadlineDayReason(store.settings, deadline, now)
    || (Date.parse(earliest.promiseBy) > Date.parse(deadline) ? 'before_shortest_time' : null) : null;
  const tight = !reason && Date.parse(secured.promiseBy) > Date.parse(deadline ?? earliest.promiseBy);
  const projection = deadline && !tight ? secured : earliest;
  return { queue, projection: { ...projection, express: false,
    scheduling: { version: 1, status: reason ? 'not_possible' : tight ? 'tight' : 'secured', reason,
      earliestReadyBy: earliest.promiseBy, securedReadyBy: secured.promiseBy, readyBy: projection.promiseBy,
      sameDay: projection.sameDay, tightDeadline: tight, label: tight ? 'Tight deadline' : null,
      rushTier: null, expressListing: express } } };
}

/** Selected tiers are resolved from the approved catalogue, never request money. */
export function listingTiming(store, item, line = {}) {
  const listing = publicCatalogItem(store, item);
  if (!listing) throw new MatchError(409, 'catalog_item_stale', 'This listing is no longer available.');
  const tier = line.speedTierId == null ? null : listing.speedTiers.find(row => row.id === line.speedTierId);
  if (line.speedTierId != null && !tier) throw new MatchError(409, 'speed_tier_unavailable', 'Choose a current listed speed tier.');
  if (tier && item.pricedByColour) throw new MatchError(409, 'speed_tier_unavailable', 'This price-check listing does not support a speed tier.');
  return { maximum: tier?.turnaroundHours ?? listing.turnaroundHours,
    minimum: tier?.turnaroundHours ?? listing.minimumTurnaroundHours ?? listing.turnaroundHours, tier };
}

export function projectListingGroup(store, lines, { now, deadline = null } = {}) {
  const items = lines.map(line => store.catalogItems.find(item => item.id === line.catalogItemId));
  const timing = items.map((item, index) => listingTiming(store, item, lines[index]));
  const result = projectShopFinish(store, { supplierId: items[0].supplierId, now, deadline,
    turnaroundHours: Math.max(...timing.map(row => row.maximum)), minimumTurnaroundHours: Math.max(...timing.map(row => row.minimum)),
    units: lines.reduce((sum, line) => sum + line.quantity, 0), express: items.every(listingExpress) });
  const tiers = timing.map(row => row.tier).filter(Boolean);
  if (tiers.length) {
    result.projection.scheduling.rushTier = tiers[0];
    if (!result.projection.scheduling.reason) result.projection.scheduling.status = 'rush';
  }
  return result;
}

function candidateRows(store, { subcategoryCode, supplierId: onlySupplierId, dropoff, excludedSupplierIds, deadline, now, units, widthRequest, ranking = MATCH_FACTORS }) {
  store = approvedCatalogView(store);
  const excluded = new Set((excludedSupplierIds || []).map(String));
  const shops = approvedOpenSuppliers(store);
  const activeSubcategories = new Set((store.taxonomy?.subcategories || []).filter(row => row.active !== false).map(row => row.code));
  const itemsBySupplier = new Map();
  for (const item of (store.catalogItems || [])) {
    if (subcategoryCode ? item.subcategoryCode !== subcategoryCode : !activeSubcategories.has(item.subcategoryCode)) continue;
    if (onlySupplierId && item.supplierId !== onlySupplierId) continue;
    if (excluded.has(item.supplierId) || !shops.has(item.supplierId)) continue;
    const held = itemsBySupplier.get(item.supplierId);
    if (held) held.push(item);
    else itemsBySupplier.set(item.supplierId, [item]);
  }

  const rows = [];
  const missedDeadline = [];
  for (const [supplierId, items] of itemsBySupplier) {
    const eligibleListings = items
      .map((item) => publicCatalogItem(store, item, { at: now }))
      .filter(Boolean)
      .filter((listing) => listingFitsPrinterCap(listing, widthRequest, store));
    if (!eligibleListings.length) continue;
    const profile = shops.get(supplierId);
    const distance = dropoff ? distanceMetersBetween(profile.shop, dropoff) : null;
    const distanceZone = distance == null ? null : distanceZoneForDistance(distance, store.settings);
    // Rank real listing projections, never combine one listing's low price
    // with another's fast promise. Each offered listing must meet the deadline.
    const draftGroups = cartGroups(null, (widthRequest?.cartLines || []).filter(line => line.supplierId === supplierId));
    const requestedDate = deadline == null ? null : new Date(deadline).toISOString();
    const groupLines = draftGroups.find(group => group.deadline === requestedDate)?.lines || [];
    const draftTiming = new Map();
    try {
      for (const group of draftGroups.filter(group => group.deadline === requestedDate || (group.deadline != null
        && (requestedDate == null || Date.parse(group.deadline) < Date.parse(requestedDate))))) {
        for (const line of group.lines) {
          const item = store.catalogItems.find(item => item.id === line.catalogItemId);
          if (!item) throw new MatchError(409, 'catalog_item_stale', 'Repair unavailable draft work before adding another listing.');
          draftTiming.set(line, listingTiming(store, item, line));
        }
      }
    } catch (error) {
      if (error instanceof MatchError) continue;
      throw error;
    }
    const earlierJobs = draftGroups.filter(group => group.deadline != null
      && (requestedDate == null || Date.parse(group.deadline) < Date.parse(requestedDate))).map(group => ({
      supplierId, state: "needs_qa", estimatedHours: Math.max(...group.lines.map(line => draftTiming.get(line).maximum)),
    }));
    const projectionStore = earlierJobs.length ? { ...store, orderJobs: [...(store.orderJobs || []), ...earlierJobs] } : store;
    const groupUnits = groupLines.reduce((total, line) => total + BigInt(line.quantity), 0n);
    const groupHours = groupLines.map(line => draftTiming.get(line).maximum);
    const groupMinimumHours = groupLines.map(line => draftTiming.get(line).minimum);
    // Preserve listing metadata; Express uses the same scheduling calculation.
    const groupExpress = groupLines.every((line) => listingExpress((store.catalogItems || []).find((row) => row.id === line.catalogItemId)));
    const choices = eligibleListings.map((listing) => {
      // Draft lines consume capacity when another product joins their group.
      // Use the same combined quantity and slowest turnaround as checkout.
      const combinedUnits = groupUnits + BigInt(units ?? listing.minimumOrderQuantity ?? 1);
      if (combinedUnits > MAX_SAFE_MINOR) fail(400, "invalid_quantity", "The group's quantity exceeds the supported range.");
      let { projection, queue } = projectShopFinish(projectionStore, {
        supplierId, turnaroundHours: Math.max(listing.turnaroundHours, ...groupHours),
        minimumTurnaroundHours: Math.max(listing.minimumTurnaroundHours ?? listing.turnaroundHours, ...groupMinimumHours), now,
        units: Number(combinedUnits),
        express: listing.express === true && groupExpress, deadline,
      });
      const rushChoices = listing.pricedByColour ? [] : listing.speedTiers.filter(tier => tier.turnaroundHours < (listing.minimumTurnaroundHours ?? listing.turnaroundHours)).map(tier => {
        const fast = projectShopFinish(projectionStore, { supplierId, now, deadline,
          turnaroundHours: Math.max(tier.turnaroundHours, ...groupHours),
          minimumTurnaroundHours: Math.max(tier.turnaroundHours, ...groupMinimumHours),
          units: Number(combinedUnits) }).projection;
        fast.scheduling.rushTier = tier;
        if (!fast.scheduling.reason) fast.scheduling.status = 'rush';
        return fast;
      });
      if (deadline && !fitsDeadline(projection, deadline)) {
        const fast = rushChoices.find(row => fitsDeadline(row, deadline));
        if (fast) projection = fast;
      }
      return {
        supplierId, listing, projection, rushChoices, distance, distanceZone,
        queue: { jobsAhead: queue.jobsAhead, estimatedHours: Math.max(0,
          Math.round((Date.parse(projection.promiseBy) - Date.parse(now)) / 3_600_000)) },
        quality: Math.max(0, capabilityScore(store, supplierId, [listing]) - recentLapseQualityPenalty(store, supplierId, now)),
        speed: Math.max(1, Date.parse(projection.promiseBy) - Date.parse(now)),
        cost: fromPrice([listing]),
      };
    }).filter((choice) => {
      if (fitsDeadline(choice.projection, deadline)) return true;
      missedDeadline.push({ supplierId, promiseBy: choice.projection.promiseBy });
      return false;
    });
    choices.sort((a, b) => compareFactors(a, b, ranking) || a.listing.id.localeCompare(b.listing.id));
    if (!choices.length) continue;
    const row = { ...choices[0], listings: choices.map((choice) => choice.listing), choices,
      shop: matchShopCard(profile, choices.map((choice) => choice.listing), store.settings, now) };
    rows.push(row);
  }
  return { rows, missedDeadline };
}

const ZONE_RANK = { nearby: 0, away: 1, long_distance: 2, out_of_zone: 3 };
const REASON_LABELS = {
  quality: "Matched for Quality", cost: "Matched for Best Value",
  speed: "Matched for Fastest Turnaround", distance: "Matched for Distance",
  vetted: "GRIDGO-Vetted Supplier",
};

function factorValue(row, factor) {
  if (factor === "quality") return -Math.floor(row.quality);
  if (factor === "speed") return Math.floor(Date.parse(row.projection.promiseBy) / 3_600_000);
  if (factor === "distance") return ZONE_RANK[row.distanceZone?.key] ?? 4;
  return row.cost ?? Infinity;
}

function decidingFactor(left, right, ranking) {
  return right ? ranking.find((factor) => factorValue(left, factor) !== factorValue(right, factor)) : undefined;
}

function compareFactors(left, right, ranking) {
  const factor = decidingFactor(left, right, ranking);
  return factor ? (factorValue(left, factor) < factorValue(right, factor) ? -1 : 1) : 0;
}

function scoreRows(rows, ranking) {
  // Retained diagnostic shape for older apps; these numbers never sort rows.
  const weights = Object.fromEntries(ranking.map((factor, index) => [factor, index === 0 ? 1 : 0]));
  const bestSpeed = Math.min(...rows.map((row) => row.speed));
  const bestCost = Math.min(...rows.map((row) => row.cost ?? Infinity));
  const bestDistance = Math.min(...rows.map((row) => row.distance ?? Infinity));
  const bestQuality = Math.max(...rows.map((row) => row.quality));
  for (const row of rows) {
    row.factorScores = {
      quality: bestQuality > 0 ? row.quality / bestQuality * 100 : 0,
      speed: normalizedInverse(row.speed, bestSpeed),
      cost: row.cost == null ? 0 : normalizedInverse(row.cost, bestCost),
      distance: row.distance == null ? 0 : normalizedInverse(row.distance, bestDistance),
    };
    row.totalScore = row.factorScores[ranking[0]];
  }
  rows.sort((a, b) => compareFactors(a, b, ranking) || a.supplierId.localeCompare(b.supplierId));
  return weights;
}

// An allowlist: never spread a catalog record into an anonymous match card.
function otherListing(row) {
  const item = row.listing;
  return {
    ...Object.fromEntries([
      "categoryCode", "subcategoryCode", "basePriceMinor", "clientBasePriceMinor", "effectivePriceMinor", "clientEffectivePriceMinor",
      "measurementKind", "measureUnit", "minimumWidthMilli", "minimumHeightMilli", "minimumLengthMilli",
      "minimumOrderQuantity", "printerMaxWidthFeet", "printLayouts", "coverSpineForm", "priceTiers", "speedTiers", "pricingBasis",
      "turnaroundHours", "minimumTurnaroundHours", "turnaroundDays", "minimumTurnaroundDays", "turnaroundMinutes", "minimumTurnaroundMinutes", "productionDayMinutes", "rush", "acceptedFormats", "optionGroups", "version", "express",
    ].map((key) => [key, item[key]])),
    id: item.id, name: item.name, photos: item.photos.map(({ fileId, sortOrder, url }) => ({ fileId, sortOrder, url })),
    fromPriceMinor: item.fromPriceMinor, clientFromPriceMinor: item.clientFromPriceMinor,
    pricingUnit: item.pricingUnit, packageQty: item.packageQty,
    distanceZone: row.distanceZone,
    ...(row.distanceZone?.key === "out_of_zone" ? { distanceKm: Number((row.distance / 1000).toFixed(1)) } : {}),
    ...(item.rating ? { rating: item.rating } : {}),
    review: row.projection.review ?? null,
    scheduling: row.projection.scheduling,
    readyBy: row.projection.promiseBy, expressPromise: row.projection.express === true, placeInLine: row.queue.jobsAhead + 1,
  };
}

/** Read-only add-more catalogue: the same eligibility/promise and anonymous card as matching. */
export function cartGroupListings(store, { supplierId, deadline, cartLines, now }) {
  const { rows, missedDeadline } = candidateRows(store, {
    supplierId, deadline, now, dropoff: null, widthRequest: { cartLines },
  });
  const listings = rows.flatMap(row => row.choices.map(otherListing));
  return { listings, emptyReason: listings.length ? null
    : missedDeadline.length ? "deadline_not_met" : "no_orderable_listings" };
}

function reasonsFor(row, ranking, distanceZone) {
  const reasons = ranking.map((factor, index) => {
    const detail = factor === "quality"
      ? `${Math.round(row.quality)} quality points from established ratings or listing completeness and approved standing`
      : factor === "speed"
        ? `${row.queue.jobsAhead} jobs ahead; ready by ${row.projection.promiseBy}`
        : factor === "cost"
          ? row.cost == null
            ? "This shop has not published a starting price"
            : `Starting price: ${row.cost} PHP minor units`
          : row.distance == null
            ? "Distance was not scored because no delivery pin was supplied"
            : distanceZone.label;
    return { code: `ranked_${factor}`, factor, rank: index + 1, weight: index === 0 ? 1 : 0, detail };
  });
  return reasons;
}

/** One candidate pass supplies shortest/longest and listed-tier bounds for every date.
 * Never expose shop counts; Secured means at least one ordinary maximum is met. */
export function deadlineDays(store, { subcategoryCode, dropoff = null, now, days = 120 } = {}) {
  const at = now || new Date().toISOString();
  const { rows } = candidateRows(store, {
    subcategoryCode,
    dropoff,
    excludedSupplierIds: [],
    // No deadline: every candidate is wanted, along with the date it could
    // actually finish. Filtering here would answer one day instead of all.
    deadline: null,
    now: at,
    units: null,
    ranking: ["speed", "quality", "cost", "distance"],
  });

  const choices = rows.flatMap(row => row.choices);
  return schedulingCalendar(store, choices, { now: at, days });
}

/** Shared calendar projection for client search and the shop editor preview. */
export function schedulingCalendar(store, choices, { now: at, days }) {
  const manilaDay = schedulingDay(at), start = Date.parse(`${manilaDay}T00:00:00+08:00`);
  const out = [];
  for (let index = 0; index < days; index++) {
    const end = new Date(start + (index + 1) * 86400000 - 1).toISOString();
    const day = schedulingDay(end), closed = deadlineDayReason(store.settings, end, at);
    const ordinary = choices.filter(row => Date.parse(row.projection.scheduling.earliestReadyBy) <= Date.parse(end));
    const secured = ordinary.filter(row => Date.parse(row.projection.scheduling.securedReadyBy) <= Date.parse(end));
    const rush = choices.flatMap(row => row.rushChoices).filter(row => Date.parse(row.promiseBy) <= Date.parse(end))
      .sort((a,b) => a.promiseBy.localeCompare(b.promiseBy));
    const status = closed ? 'not_possible' : secured.length ? 'secured' : ordinary.length ? 'tight' : rush.length ? 'rush' : 'not_possible';
    const reason = closed || (status === 'not_possible' ? choices.length ? 'before_shortest_time' : 'no_eligible_listing' : null);
    const readyBy = status === 'not_possible' ? null : status === 'rush' ? rush[0].promiseBy
      : status === 'secured' ? secured.map(row => row.projection.scheduling.securedReadyBy).sort()[0]
        : ordinary.map(row => row.projection.scheduling.earliestReadyBy).sort()[0];
    out.push({ day, state: status === 'not_possible' ? 'cannot' : status === 'tight' || status === 'rush' ? 'tight' : 'open',
      status, reason, readyBy, rushTier: status === 'rush' ? rush[0].scheduling.rushTier : null });
  }
  return { days: out, operatingStatus: reviewTiming(store.settings, at),
    earliest: choices.flatMap(row => [row.projection.scheduling.earliestReadyBy, ...row.rushChoices.map(fast => fast.promiseBy)]).sort()[0] ?? null,
    expressAvailable: choices.some(row => row.listing.express === true) };

}

export function matchShop(store, input = {}) {
  const subcategoryCode = String(input.subcategoryCode || "").trim();
  const subcategory = (store.taxonomy?.subcategories || []).find(
    (row) => row.code === subcategoryCode && row.active !== false,
  );
  if (!subcategory) {
    fail(400, "invalid_subcategory_code", "Choose an active taxonomy subcategory.", { field: "subcategoryCode" });
  }
  const ranking = validatePreferenceRanking(input.ranking);
  const dropoff = point(input.dropoff, { required: ranking[0] === "distance" });
  const now = input.now || new Date().toISOString();
  const deadline = input.deadline ?? null;
  if (deadline != null && !Number.isFinite(Date.parse(deadline))) {
    fail(400, "invalid_deadline", "Send the date this is needed by as a valid date and time.", { field: "deadline" });
  }

  const { rows, missedDeadline } = candidateRows(store, {
    subcategoryCode,
    dropoff,
    excludedSupplierIds: input.excludedSupplierIds,
    deadline,
    now,
    units: input.units,
    ranking,
    widthRequest: {
      widthFeet: input.widthFeet,
      measurement: input.measurement,
      structuredSpec: input.structuredSpec,
      optionIds: input.optionIds,
      cartLines: input.cartLines,
    },
  });

  if (rows.length === 0) {
    // Being able to say "everybody is too slow" separately from "nobody prints
    // this" is the difference between offering a later date and a dead end.
    if (missedDeadline.length > 0) {
      const soonest = missedDeadline
        .map((row) => row.promiseBy)
        .sort()[0];
      fail(409, "deadline_not_met", "No open shop can finish this by the date you gave.", {
        field: "deadline",
        earliestAvailable: soonest,
        shopsConsidered: new Set(missedDeadline.map((row) => row.supplierId)).size,
      });
    }
    fail(404, "match_not_found", "No approved open shop currently has a public listing for this subcategory.");
  }

  const weights = scoreRows(rows, ranking);
  // Performance demotes a shop only when an unhidden candidate can meet the request.
  // Preserve the ordinary winner when every candidate is hidden.
  const unhidden = rows.filter(row => !performanceTopPick(store, row.supplierId, now).hidden);
  const contenders = unhidden.length ? unhidden : rows;
  const winner = contenders[0];
  const alternatives = rows.filter(row => row !== winner);
  const runnerUp = contenders[1];
  const reasonKey = decidingFactor(winner, runnerUp, ranking) || "vetted";
  const alternativesCount = rows.length - 1;

  // Internal capture keeps supplier production timing out of client projections.
  for (const row of rows) for (const choice of row.choices) input.onOffer?.(choice.listing.id, choice.projection);
  const distanceZone = winner.distance == null ? null : distanceZoneForDistance(winner.distance, store.settings);
  const rating = publicShopRating(store, winner.supplierId);
  return {
    ranking,
    matchReason: { key: reasonKey, label: REASON_LABELS[reasonKey] },
    otherListings: alternatives.map(otherListing),
    distanceZone,
    ...(rating ? { rating } : {}),
    shop: winner.shop,
    queue: winner.queue,
    reasons: reasonsFor(winner, ranking, distanceZone),
    listings: winner.choices.map((choice) => ({
      ...choice.listing,
      readyBy: choice.projection.promiseBy,
      scheduling: choice.projection.scheduling,
      expressPromise: choice.projection.express === true,
      review: choice.projection.review ?? null,
      placeInLine: choice.queue.jobsAhead + 1,
      distanceZone,
      ...(distanceZone?.key === "out_of_zone" ? { distanceKm: Number((winner.distance / 1000).toFixed(1)) } : {}),
    })),
    alternativesCount,
    /**
     * What the client is told. The shop's own date is deliberately absent: a
     * shop shown the padded date works to the padded date, and the allowance is
     * spent before the job starts.
     */
    promiseBy: winner.projection.promiseBy,
    scheduling: winner.projection.scheduling,
    /** Whether `promiseBy` is the Express same-day promise. */
    expressPromise: winner.projection.express === true,
    operatingStatus: winner.projection.review ?? null,
    /** Not for the client. Persisted when the order is placed, and what the shop is held to. */
    shopReadyBy: winner.projection.readyBy,
    score: {
      total: Number(winner.totalScore.toFixed(4)),
      weights,
      factors: Object.fromEntries(Object.entries(winner.factorScores).map(([key, value]) => [key, Number(value.toFixed(4))])),
    },
  };
}
