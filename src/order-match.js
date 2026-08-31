import { distanceMetersBetween } from "./operational-model.js";
import { publicCatalogItem } from "./supplier-catalog.js";
import { defaultShopSchedule, fitsDeadline, projectFinish } from "./availability.js";

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
const RANK_WEIGHTS = Object.freeze([0.4, 0.3, 0.2, 0.1]);
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Below this, a shop is scored on how complete its listing is; at or above it,
 * on what clients actually said. Star ratings are savage in small numbers, and
 * a shop's first unlucky review should not bury it.
 */
export const MIN_REVIEWS_FOR_RATING = 5;

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

/**
 * What clients said about this shop's work.
 *
 * Only the quality star feeds matching. Speed is measured from whether the shop
 * hit its own date, and cost is the price on the listing -- taking those from a
 * remembered rating would override a timestamp with a recollection, and would
 * mark a shop down twice for being expensive.
 */
export function shopRating(store, supplierId) {
  const reviews = (store.shopReviews || []).filter((row) => row.supplierId === supplierId);
  if (reviews.length === 0) return null;
  const stars = reviews.map((row) => Number(row.qualityStars)).filter((value) => Number.isFinite(value) && value > 0);
  if (stars.length === 0) return null;
  return {
    count: stars.length,
    average: stars.reduce((total, value) => total + value, 0) / stars.length,
  };
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
    const estimate = Number.isSafeInteger(row.estimatedHours) && row.estimatedHours > 0
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
  const members = new Set(
    (store.userRoleMemberships || [])
      .filter((row) => row.role === "supplier")
      .map((row) => row.userId),
  );
  const approved = new Set(
    (store.approvalCases || [])
      .filter((row) => row.kind === "supplier" && row.status === "approved")
      .map((row) => row.userId),
  );
  const profiles = new Map();
  for (const profile of (store.supplierProfiles || [])) {
    if (profile.isClosed === true || !profile.shop) continue;
    if (!members.has(profile.userId) || !approved.has(profile.userId)) continue;
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

function candidateRows(store, { subcategoryCode, dropoff, excludedSupplierIds, deadline, now, units }) {
  const excluded = new Set((excludedSupplierIds || []).map(String));
  const shops = approvedOpenSuppliers(store);
  const allowanceMinutes = allowanceMinutesFrom(store.settings);
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
    const listings = items
      .map((item) => publicCatalogItem(store, item))
      .filter(Boolean)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (listings.length === 0) continue;
    const profile = shops.get(supplierId);

    // The fastest thing this shop offers for the work, because that is what it
    // would put the job on.
    const turnarounds = listings
      .map((item) => item.turnaroundHours)
      .filter((hours) => Number.isSafeInteger(hours) && hours > 0);
    const turnaroundHours = turnarounds.length ? Math.min(...turnarounds) : 24;
    const queue = queueMinutesFor(store, supplierId, turnaroundHours);
    const capacityDaily = (store.supplierServices || [])
      .filter((row) => row.supplierId === supplierId && row.state === "live")
      .reduce((best, row) => (Number.isSafeInteger(row.capacityDaily) ? Math.max(best, row.capacityDaily) : best), 0);

    const projection = projectFinish({
      schedule: scheduleFor(profile),
      now,
      queueMinutes: queue.minutes,
      turnaroundMinutes: turnaroundHours * 60,
      // Quantity is not known until a listing is configured, so capacity cannot
      // bite here. The exact check runs again once the client sets it.
      units: Number.isSafeInteger(units) && units > 0 ? units : null,
      capacityDaily: capacityDaily > 0 ? capacityDaily : null,
      allowanceMinutes,
    });

    const row = {
      supplierId,
      shop: matchShopCard(profile, listings),
      listings,
      projection,
      queue: {
        jobsAhead: queue.jobsAhead,
        // Hours the client actually waits, counted against the date they are
        // given -- not the shop's working hours, which run out overnight and at
        // weekends while the client keeps waiting.
        estimatedHours: Math.max(
          0,
          Math.round((Date.parse(projection.promiseBy) - Date.parse(now)) / 3_600_000),
        ),
      },
      quality: capabilityScore(store, supplierId, listings),
      speed: Math.max(1, Date.parse(projection.promiseBy) - Date.parse(now)),
      cost: fromPrice(listings),
      distance: dropoff ? distanceMetersBetween(profile.shop, dropoff) : null,
    };

    // The filter. A shop that cannot make the date is absent, not last.
    if (!fitsDeadline(projection, deadline)) {
      missedDeadline.push({ supplierId, promiseBy: projection.promiseBy });
      continue;
    }
    rows.push(row);
  }
  return { rows, missedDeadline };
}

function scoreRows(rows, ranking) {
  const weights = Object.fromEntries(ranking.map((factor, index) => [factor, RANK_WEIGHTS[index]]));
  const bestSpeed = Math.min(...rows.map((row) => row.speed));
  const costs = rows.map((row) => row.cost).filter(Number.isFinite);
  const bestCost = costs.length ? Math.min(...costs) : null;
  const distances = rows.map((row) => row.distance).filter(Number.isFinite);
  const bestDistance = distances.length ? Math.min(...distances) : null;
  // Every factor is scored against the best candidate in the running, quality
  // included. Scored absolutely it sat between 50 and 100 while the others
  // spanned the full range, so the weight a client put on quality was quietly
  // worth about half of what they asked for.
  const bestQuality = Math.max(...rows.map((row) => row.quality));
  for (const row of rows) {
    row.factorScores = {
      quality: bestQuality > 0 ? Math.min(100, (row.quality / bestQuality) * 100) : 0,
      speed: normalizedInverse(row.speed, bestSpeed),
      cost: bestCost == null || !Number.isFinite(row.cost) ? 0 : normalizedInverse(row.cost, bestCost),
      distance: bestDistance == null ? 0 : normalizedInverse(row.distance, bestDistance),
    };
    row.totalScore = MATCH_FACTORS.reduce(
      (total, factor) => total + row.factorScores[factor] * weights[factor],
      0,
    );
  }
  rows.sort((left, right) => right.totalScore - left.totalScore || left.supplierId.localeCompare(right.supplierId));
  return weights;
}

function reasonsFor(row, ranking, preferred, alternativesCount) {
  const reasons = ranking.map((factor, index) => {
    const detail = factor === "quality"
      ? `${Math.round(row.quality)}% listing completeness and approved standing`
      : factor === "speed"
        ? `${row.queue.jobsAhead} jobs ahead; ready by ${row.projection.promiseBy}`
        : factor === "cost"
          ? row.cost == null
            ? "This shop has not published a starting price"
            : `Cheapest of the ${alternativesCount + 1} that can make your date`
          : row.distance == null
            ? "Distance was not scored because no delivery pin was supplied"
            : `${row.distance} metres from the delivery pin`;
    return { code: `ranked_${factor}`, factor, rank: index + 1, weight: RANK_WEIGHTS[index], detail };
  });
  if (preferred) {
    reasons.unshift({
      code: "same_shop_bundle",
      factor: "bundle",
      rank: 0,
      weight: 1,
      detail: "This shop is already in the cart and has an eligible listing for the requested work.",
    });
  }
  return reasons;
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
        shopsConsidered: missedDeadline.length,
      });
    }
    fail(404, "match_not_found", "No approved open shop currently has a public listing for this subcategory.");
  }

  const weights = scoreRows(rows, ranking);
  const preferredSupplierId = input.preferredSupplierId == null ? null : String(input.preferredSupplierId);
  const preferred = preferredSupplierId ? rows.find((row) => row.supplierId === preferredSupplierId) : null;
  const winner = preferred || rows[0];
  const alternativesCount = rows.length - 1;

  return {
    shop: winner.shop,
    queue: winner.queue,
    reasons: reasonsFor(winner, ranking, Boolean(preferred), alternativesCount),
    listings: winner.listings,
    alternativesCount,
    /**
     * What the client is told. The shop's own date is deliberately absent: a
     * shop shown the padded date works to the padded date, and the allowance is
     * spent before the job starts.
     */
    promiseBy: winner.projection.promiseBy,
    /** Not for the client. Persisted when the order is placed, and what the shop is held to. */
    shopReadyBy: winner.projection.readyBy,
    score: {
      total: Number(winner.totalScore.toFixed(4)),
      weights,
      factors: Object.fromEntries(Object.entries(winner.factorScores).map(([key, value]) => [key, Number(value.toFixed(4))])),
    },
  };
}
