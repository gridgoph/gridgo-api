import { distanceMetersBetween } from "./operational-model.js";
import { publicCatalogItem } from "./supplier-catalog.js";

export const MATCH_FACTORS = Object.freeze(["quality", "speed", "distance"]);
const RANK_WEIGHTS = Object.freeze([0.5, 0.3, 0.2]);
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
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
    fail(400, "invalid_preference_ranking", "ranking must contain quality, speed, and distance exactly once.", {
      field: "ranking",
      allowed: MATCH_FACTORS,
    });
  }
  const ranking = value.map((factor) => String(factor));
  if (new Set(ranking).size !== MATCH_FACTORS.length || MATCH_FACTORS.some((factor) => !ranking.includes(factor))) {
    fail(400, "invalid_preference_ranking", "ranking must contain quality, speed, and distance exactly once.", {
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

function listingQuality(item) {
  let score = 50; // approved supplier standing; reviews can replace part of this later
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

function queueFor(store, supplierId, listings) {
  const active = (store.orderJobs || [])
    .filter((job) => job.supplierId === supplierId && ACTIVE_JOB_STATES.has(job.state));
  const ownHours = Math.min(...listings.map((item) => item.turnaroundHours).filter((hours) => Number.isSafeInteger(hours) && hours > 0));
  const baseHours = Number.isFinite(ownHours) ? ownHours : 24;
  const queuedHours = active.reduce((total, job) => {
    const estimate = Number.isSafeInteger(job.estimatedHours) && job.estimatedHours > 0 ? job.estimatedHours : baseHours;
    return total + estimate;
  }, 0);
  return { jobsAhead: active.length, estimatedHours: baseHours + queuedHours };
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

function candidateRows(store, { subcategoryCode, dropoff, excludedSupplierIds }) {
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
  for (const [supplierId, items] of itemsBySupplier) {
    const listings = items
      .map((item) => publicCatalogItem(store, item))
      .filter(Boolean)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (listings.length === 0) continue;
    const profile = shops.get(supplierId);
    const queue = queueFor(store, supplierId, listings);
    rows.push({
      supplierId,
      shop: matchShopCard(profile, listings),
      listings,
      queue,
      quality: Math.max(...listings.map(listingQuality)),
      speed: queue.estimatedHours,
      distance: dropoff ? distanceMetersBetween(profile.shop, dropoff) : null,
    });
  }
  return rows;
}

function scoreRows(rows, ranking) {
  const weights = Object.fromEntries(ranking.map((factor, index) => [factor, RANK_WEIGHTS[index]]));
  const bestSpeed = Math.min(...rows.map((row) => row.speed));
  const distances = rows.map((row) => row.distance).filter(Number.isFinite);
  const bestDistance = distances.length ? Math.min(...distances) : null;
  for (const row of rows) {
    row.factorScores = {
      quality: row.quality,
      speed: normalizedInverse(row.speed, bestSpeed),
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

function reasonsFor(row, ranking, preferred) {
  const reasons = ranking.map((factor, index) => {
    const detail = factor === "quality"
      ? `${Math.round(row.quality)}% listing completeness and approved standing`
      : factor === "speed"
        ? `${row.queue.jobsAhead} jobs ahead; about ${row.queue.estimatedHours} hours`
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
  const rows = candidateRows(store, {
    subcategoryCode,
    dropoff,
    excludedSupplierIds: input.excludedSupplierIds,
  });
  if (rows.length === 0) {
    fail(404, "match_not_found", "No approved open shop currently has a public listing for this subcategory.");
  }
  const weights = scoreRows(rows, ranking);
  const preferredSupplierId = input.preferredSupplierId == null ? null : String(input.preferredSupplierId);
  const preferred = preferredSupplierId ? rows.find((row) => row.supplierId === preferredSupplierId) : null;
  const winner = preferred || rows[0];
  return {
    shop: winner.shop,
    queue: winner.queue,
    reasons: reasonsFor(winner, ranking, Boolean(preferred)),
    listings: winner.listings,
    alternativesCount: rows.length - 1,
    score: {
      total: Number(winner.totalScore.toFixed(4)),
      weights,
      factors: Object.fromEntries(Object.entries(winner.factorScores).map(([key, value]) => [key, Number(value.toFixed(4))])),
    },
  };
}
