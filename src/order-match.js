import { operatingHours, reviewTiming } from './operating-hours.js';
import { addOpeningMilliseconds } from './availability.js';
import { shopProductionDayMinutes } from "./production-days.js";
import { cartGroups } from "./cart-groups.js";
import { approvedCatalogView } from "./catalog-review-state.js";
import { recentLapseQualityPenalty } from './production-penalties.js';
import { distanceMetersBetween, distanceZoneForDistance } from "./operational-model.js";
import { itemTurnaroundHours, listingFitsPrinterCap, publicCatalogItem } from "./supplier-catalog.js";
import { defaultShopSchedule, fitsDeadline, projectFinish } from "./availability.js";
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

const ACTIVE_JOB_STATES = new Set([
  "needs_qa",
  "client_correction",
  "approved_for_production",
  "production",
  "supplier_self_qc",
  "ready_for_dispatch",
  "rider_assigned",
  "picked_up",
  "out_for_delivery",
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
  if (Number.isSafeInteger(item.turnaroundHours) && item.turnaroundHours > 0) score += 7;
  if ((item.photos || []).length) score += 7;
  if ((item.acceptedFormats || []).length) score += 5;
  if ((item.optionGroups || []).length) score += 3;
  if ((item.prepSteps || []).length) score += 3;
  return Math.min(100, score);
}

/** Whether the shop hit the date its own board promised, across finished work. */
export function onTimeRate(store, supplierId) {
  const finished = (store.orders || []).filter(
    (order) => order.supplierId === supplierId && order.readyBy && order.readyAt,
  );
  if (finished.length === 0) return null;
  const onTime = finished.filter((order) => Date.parse(order.readyAt) <= Date.parse(order.readyBy));
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
function queueMinutesFor(store, supplierId, fallbackHours) {
  const jobs = (store.orderJobs || []).filter(
    (job) => job.supplierId === supplierId && ACTIVE_JOB_STATES.has(job.state),
  );
  const orders = (store.orders || []).filter(
    (order) => order.supplierId === supplierId
      && ACTIVE_JOB_STATES.has(order.state)
      && !jobs.some((job) => job.orderId === order.id),
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

function matchShopCard(profile, listings) {
  return {
    supplierId: profile.userId,
    shopName: profile.shopName,
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

/** One queue/calendar projection for matching, cart previews, and checkout. */
export function projectShopFinish(store, { supplierId, turnaroundHours, turnaroundDays, units, now }) {
  const hours = Number.isSafeInteger(turnaroundDays) && turnaroundDays > 0
    ? turnaroundDays * shopProductionDayMinutes(store, supplierId) / 60
    : Number.isFinite(turnaroundHours) && turnaroundHours > 0 ? turnaroundHours : 24;
  const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
  const queue = queueMinutesFor(store, supplierId, hours);
  const capacityDaily = (store.supplierServices || [])
    .filter((row) => row.supplierId === supplierId && row.state === "live")
    .reduce((best, row) => (Number.isSafeInteger(row.capacityDaily) ? Math.max(best, row.capacityDaily) : best), 0);
  const review = store.settings?.operatingHours ? reviewTiming(store.settings, now) : null;
  const projection = projectFinish({
    schedule: scheduleFor(profile),
    now: review?.reviewCompletesAt || now,
    preserveSeconds: Boolean(review),
    queueMinutes: queue.minutes,
    turnaroundMinutes: hours * 60,
    units: Number.isSafeInteger(units) && units > 0 ? units : null,
    capacityDaily: capacityDaily > 0 ? capacityDaily : null,
    allowanceMinutes: review ? 0 : allowanceMinutesFrom(store.settings),
  });
  if (review) {
    projection.review = review;
    projection.promiseBy = addOpeningMilliseconds(operatingHours(store.settings).schedule,
      projection.readyBy, allowanceMinutesFrom(store.settings) * 60000);
  }
  return { projection, queue };
}

function candidateRows(store, { subcategoryCode, dropoff, excludedSupplierIds, deadline, now, units, widthRequest, ranking = MATCH_FACTORS }) {
  store = approvedCatalogView(store);
  const excluded = new Set((excludedSupplierIds || []).map(String));
  const shops = approvedOpenSuppliers(store);
  const itemsBySupplier = new Map();
  for (const item of (store.catalogItems || [])) {
    if (item.subcategoryCode !== subcategoryCode) continue;
    if (excluded.has(item.supplierId) || !shops.has(item.supplierId)) continue;
    const held = itemsBySupplier.get(item.supplierId);
    if (held) held.push(item);
    else itemsBySupplier.set(item.supplierId, [item]);
  }

  const rows = [];
  const missedDeadline = [];
  for (const [supplierId, items] of itemsBySupplier) {
    const eligibleListings = items
      .map((item) => publicCatalogItem(store, item))
      .filter(Boolean)
      .filter((listing) => listingFitsPrinterCap(listing, widthRequest, store));
    const profile = shops.get(supplierId);
    const distance = dropoff ? distanceMetersBetween(profile.shop, dropoff) : null;
    const distanceZone = distance == null ? null : distanceZoneForDistance(distance, store.settings);
    // Rank real listing projections, never combine one listing's low price
    // with another's fast promise. Each offered listing must meet the deadline.
    const draftGroups = cartGroups(null, (widthRequest?.cartLines || []).filter(line => line.supplierId === supplierId));
    const requestedDate = deadline == null ? null : new Date(deadline).toISOString();
    const groupLines = draftGroups.find(group => group.deadline === requestedDate)?.lines || [];
    const earlierJobs = draftGroups.filter(group => group.deadline != null
      && (requestedDate == null || Date.parse(group.deadline) < Date.parse(requestedDate))).map(group => ({
      supplierId, state: "needs_qa", estimatedHours: Math.max(...group.lines.map(line => {
        const item = (store.catalogItems || []).find(row => row.id === line.catalogItemId);
        const service = (store.supplierServices || []).find(row => row.id === item?.supplierServiceId);
        return item ? itemTurnaroundHours(item, service) : 24;
      })),
    }));
    const projectionStore = earlierJobs.length ? { ...store, orderJobs: [...(store.orderJobs || []), ...earlierJobs] } : store;
    const groupUnits = groupLines.reduce((total, line) => total + BigInt(line.quantity), 0n);
    const groupHours = groupLines.map((line) => {
      const item = (store.catalogItems || []).find((row) => row.id === line.catalogItemId);
      const service = (store.supplierServices || []).find((row) => row.id === item?.supplierServiceId);
      return item ? itemTurnaroundHours(item, service) : 0;
    });
    const choices = eligibleListings.map((listing) => {
      // Draft lines consume capacity when another product joins their group.
      // Use the same combined quantity and slowest turnaround as checkout.
      const combinedUnits = groupUnits + BigInt(units ?? listing.minimumOrderQuantity ?? 1);
      if (combinedUnits > MAX_SAFE_MINOR) fail(400, "invalid_quantity", "The group's quantity exceeds the supported range.");
      const { projection, queue } = projectShopFinish(projectionStore, {
        supplierId, turnaroundHours: Math.max(listing.turnaroundHours, ...groupHours), now,
        units: groupLines.length ? Number(combinedUnits) : units,
      });
      return {
        supplierId, listing, projection, distance, distanceZone,
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
      shop: matchShopCard(profile, choices.map((choice) => choice.listing)) };
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
      "minimumOrderQuantity", "printerMaxWidthFeet", "priceTiers", "speedTiers", "pricingBasis",
      "turnaroundHours", "minimumTurnaroundHours", "turnaroundDays", "minimumTurnaroundDays", "productionDayMinutes", "rush", "acceptedFormats", "optionGroups", "version",
    ].map((key) => [key, item[key]])),
    id: item.id, name: item.name, photos: item.photos.map(({ fileId, sortOrder, url }) => ({ fileId, sortOrder, url })),
    fromPriceMinor: item.fromPriceMinor, clientFromPriceMinor: item.clientFromPriceMinor,
    pricingUnit: item.pricingUnit, packageQty: item.packageQty,
    distanceZone: row.distanceZone,
    ...(row.distanceZone?.key === "out_of_zone" ? { distanceKm: Number((row.distance / 1000).toFixed(1)) } : {}),
    ...(item.rating ? { rating: item.rating } : {}),
    review: row.projection.review ?? null,
    readyBy: row.projection.promiseBy, placeInLine: row.queue.jobsAhead + 1,
  };
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

/**
 * Which days GRIDGO could actually make, for one kind of work.
 *
 * The client's version of the shop's schedule. A shop's calendar asks "how
 * full am I"; this asks "can anybody finish by then", which is the only form
 * of the question a client is allowed to see — the queues and capacities that
 * decide it belong to the shops.
 *
 * One candidate pass answers the whole month. Every shop that could take this
 * work already carries the date it would be ready, so a day is simply a
 * threshold: how many of those dates fall on or before the end of it.
 *
 * Deliberately returns no count. A client is never told how many shops print
 * something, here or anywhere -- `tight` says choice is narrow without saying
 * how narrow, which is the honest half of the same fact.
 */
export function deadlineDays(store, { subcategoryCode, dropoff = null, now, days = 120 } = {}) {
  const at = now || new Date().toISOString();
  const { rows, missedDeadline } = candidateRows(store, {
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

  const promises = [...rows, ...missedDeadline]
    // A candidate that passed carries its date on its projection; one that was
    // filtered out carries it directly. Reading only one of the two shapes is
    // how this quietly answered "nobody can" for every day.
    .map((row) => row.choices
      ? Math.min(...row.choices.map((choice) => Date.parse(choice.projection.promiseBy)))
      : Date.parse(row.promiseBy))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  const manilaDay = new Date(Date.parse(at) + 480 * 60000).toISOString().slice(0, 10);
  const start = Date.parse(`${manilaDay}T00:00:00+08:00`);

  const out = [];
  /** Where the run of possible days starts, so its first two can be called tight. */
  let firstPossible = null;
  for (let index = 0; index < days; index += 1) {
    const day = new Date(start + index * 86400000);
    const endOfDay = new Date(day.getTime() + 86400000 - 1);

    const reachable = promises.filter((value) => value <= endOfDay.getTime()).length;

    /*
      Two ways a day is narrow, and a client feels both.

      Half the shops or fewer can make it -- with two shops, one available is
      exactly the day this is for, so the test is half or fewer rather than
      strictly fewer than half.

      Or it is among the first days anything is possible at all. On the day a
      job first becomes makeable there is no slack in it: the shop goes
      straight from the order in front to this one, and a client choosing it is
      choosing the tightest date on offer. Work only one shop prints would
      otherwise jump from impossible to comfortable overnight, which is not
      what it is like to order that way.
    */
    if (firstPossible === null && reachable > 0) firstPossible = index;
    const narrowByChoice = reachable > 0 && reachable * 2 <= promises.length;
    const narrowByDate = firstPossible !== null && index - firstPossible < 2;

    out.push({
      day: new Date(day.getTime() + 480 * 60000).toISOString().slice(0, 10),
      reason: reachable ? null : promises.length ? "review_production_delivery_exceeds_deadline" : "no_eligible_listing",
      state: reachable === 0 ? "cannot" : narrowByChoice || narrowByDate ? "tight" : "open",
    });
  }

  return {
    days: out,
    operatingStatus: reviewTiming(store.settings, at),
    /** The first moment anybody could finish, or null when nobody prints this. */
    earliest: promises.length ? new Date(promises[0]).toISOString() : null,
  };
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
  const winner = rows[0];
  const reasonKey = decidingFactor(winner, rows[1], ranking) || "vetted";
  const alternativesCount = rows.length - 1;

  const distanceZone = winner.distance == null ? null : distanceZoneForDistance(winner.distance, store.settings);
  const rating = publicShopRating(store, winner.supplierId);
  return {
    ranking,
    matchReason: { key: reasonKey, label: REASON_LABELS[reasonKey] },
    otherListings: rows.slice(1).map(otherListing),
    distanceZone,
    ...(rating ? { rating } : {}),
    shop: winner.shop,
    queue: winner.queue,
    reasons: reasonsFor(winner, ranking, distanceZone),
    listings: winner.choices.map((choice) => ({
      ...choice.listing,
      readyBy: choice.projection.promiseBy,
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
