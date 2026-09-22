/**
 * What clients said about each shop, read back.
 *
 * `POST /orders/:id/review` writes one row per finished order; this is the
 * only place those rows are turned into something a shop or Operations can
 * read. Two readers, two shapes:
 *
 * - The shop reads its own reviews, one per job, with the three stars, the
 *   note, and what the job was — never who left it. A client is told nobody
 *   sees who rated, and that promise is kept here rather than in the app.
 * - Operations reads the whole league table, per category, because "who is
 *   good at tarpaulins" is a different question from "who is good", and a
 *   shop that is excellent at stickers can be a mediocre printer of books.
 *
 * Ranking is by the plain mean of the three star averages, ties broken by how
 * many reviews back the number up. Matching itself only ever reads the quality
 * star (see order-match.js); this table is for people, and people can hold
 * three numbers at once.
 */

import { MIN_REVIEWS_FOR_RATING, onTimeRate } from "./order-match.js";

function mean(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return null;
  return Math.round((numbers.reduce((total, value) => total + value, 0) / numbers.length) * 100) / 100;
}

const EMPTY_STATS = Object.freeze({ count: 0, quality: null, speed: null, value: null, overall: null });

function stats(reviews) {
  if (reviews.length === 0) return { ...EMPTY_STATS };
  const quality = mean(reviews.map((row) => Number(row.qualityStars)));
  const speed = mean(reviews.map((row) => Number(row.speedStars)));
  const value = mean(reviews.map((row) => Number(row.valueStars)));
  return { count: reviews.length, quality, speed, value, overall: mean([quality, speed, value]) };
}

/** Which kind of work a review was about, walked back from the order's lines. */
export function reviewSubject(store, review) {
  const lines = (store.orderLineItems || []).filter((row) => row.orderId === review.orderId);
  const item = lines
    .map((row) => (store.catalogItems || []).find((candidate) => candidate.id === row.sourceCatalogItemId))
    .find(Boolean);
  const subcategory = item
    ? (store.taxonomy?.subcategories || []).find((row) => row.code === item.subcategoryCode)
    : null;
  const category = subcategory
    ? (store.taxonomy?.categories || []).find((row) => row.code === subcategory.categoryCode)
    : null;
  return {
    categoryCode: category?.code ?? null,
    categoryName: category?.name ?? null,
    subcategoryCode: subcategory?.code ?? null,
    subcategoryName: subcategory?.name ?? null,
    itemName: lines[0]?.itemNameSnapshot || item?.name || null,
  };
}

function shopName(store, supplierId) {
  const profile = (store.supplierProfiles || []).find((row) => row.userId === supplierId);
  const owner = (store.users || []).find((row) => row.id === supplierId);
  return profile?.shopName || owner?.supplierName || owner?.name || "Unnamed shop";
}

function supplierIds(store) {
  const ids = new Set();
  for (const profile of store.supplierProfiles || []) ids.add(profile.userId);
  for (const membership of store.userRoleMemberships || []) {
    if (membership.role === "supplier") ids.add(membership.userId);
  }
  for (const user of store.users || []) if (user.role === "supplier") ids.add(user.id);
  return [...ids];
}

/** The cheapest thing this shop lists in a category, before options and quantity. */
function fromPriceMinor(store, supplierId, categoryCode) {
  const subcategories = new Set(
    (store.taxonomy?.subcategories || [])
      .filter((row) => row.categoryCode === categoryCode)
      .map((row) => row.code),
  );
  const prices = (store.catalogItems || [])
    .filter((item) => item.supplierId === supplierId && subcategories.has(item.subcategoryCode))
    .map((item) => (Number.isSafeInteger(item.fromPriceMinor) ? item.fromPriceMinor : item.basePriceMinor))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * Every shop, with its review statistics overall and per category.
 *
 * Built once per request and handed to `rankShops` as many times as needed,
 * because the shop's own screen asks for its place in every category it has
 * been reviewed in.
 */
export function shopScoreboard(store) {
  const categories = (store.taxonomy?.categories || [])
    .filter((row) => row.active !== false)
    .map((row) => ({ code: row.code, name: row.name }));
  const reviews = (store.shopReviews || []).map((row) => ({ ...row, subject: reviewSubject(store, row) }));

  const shops = supplierIds(store).map((supplierId) => {
    const mine = reviews
      .filter((row) => row.supplierId === supplierId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || right.id.localeCompare(left.id));
    const byCategory = {};
    for (const review of mine) {
      const code = review.subject.categoryCode;
      if (!code) continue;
      (byCategory[code] ||= []).push(review);
    }
    return {
      supplierId,
      shopName: shopName(store, supplierId),
      overall: stats(mine),
      onTime: onTimeRate(store, supplierId),
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([code, rows]) => [code, stats(rows)])),
      // Priced in every category the shop lists in, reviewed or not: a shop
      // nobody has rated for stickers still has a sticker price to compare.
      prices: Object.fromEntries(categories.map((row) => [row.code, fromPriceMinor(store, supplierId, row.code)])),
      reviews: mine,
    };
  });

  return { categories, shops };
}

function compareRanked(left, right) {
  return (right.overall - left.overall)
    || (right.count - left.count)
    || ((right.quality ?? 0) - (left.quality ?? 0))
    || left.shopName.localeCompare(right.shopName);
}

/**
 * The league table for one category, or for everything when none is given.
 *
 * A shop with no review in the category is still listed, unranked and after
 * the ranked ones, so Operations can see who has never been rated for that
 * work rather than wondering whether the shop exists.
 */
export function rankShops(scoreboard, categoryCode = null) {
  const rows = scoreboard.shops.map((shop) => {
    const source = categoryCode ? shop.byCategory[categoryCode] : shop.overall;
    return {
      supplierId: shop.supplierId,
      shopName: shop.shopName,
      count: source?.count ?? 0,
      quality: source?.quality ?? null,
      speed: source?.speed ?? null,
      value: source?.value ?? null,
      overall: source?.overall ?? null,
      onTime: shop.onTime,
      fromPriceMinor: categoryCode ? (shop.prices?.[categoryCode] ?? null) : null,
      position: null,
    };
  });
  const ranked = rows.filter((row) => row.count > 0).sort(compareRanked);
  ranked.forEach((row, index) => { row.position = index + 1; });
  const unranked = rows.filter((row) => row.count === 0).sort((left, right) => left.shopName.localeCompare(right.shopName));
  return { categoryCode, rankedCount: ranked.length, rows: [...ranked, ...unranked] };
}

/** What one shop gets to read about itself. */
export function supplierReviewsView(store, supplierId) {
  const board = shopScoreboard(store);
  const shop = board.shops.find((row) => row.supplierId === supplierId) || {
    supplierId,
    shopName: shopName(store, supplierId),
    overall: { ...EMPTY_STATS },
    onTime: onTimeRate(store, supplierId),
    byCategory: {},
    prices: {},
    reviews: [],
  };
  const overallTable = rankShops(board, null);
  const mine = overallTable.rows.find((row) => row.supplierId === supplierId);
  const byCategory = Object.keys(shop.byCategory).map((code) => {
    const table = rankShops(board, code);
    const row = table.rows.find((candidate) => candidate.supplierId === supplierId);
    const category = board.categories.find((candidate) => candidate.code === code);
    return {
      categoryCode: code,
      categoryName: category?.name ?? code,
      position: row?.position ?? null,
      of: table.rankedCount,
      count: row?.count ?? 0,
      quality: row?.quality ?? null,
      speed: row?.speed ?? null,
      value: row?.value ?? null,
      overall: row?.overall ?? null,
    };
  }).sort((left, right) => (left.position ?? Infinity) - (right.position ?? Infinity) || left.categoryName.localeCompare(right.categoryName));

  return {
    summary: {
      ...shop.overall,
      onTime: shop.onTime,
      // Matching starts trusting the stars over the listing once there are
      // enough of them; before that a shop's first unlucky review would bury it.
      reviewsUntilMatching: Math.max(0, MIN_REVIEWS_FOR_RATING - shop.overall.count),
    },
    ranking: {
      position: mine?.position ?? null,
      of: overallTable.rankedCount,
      byCategory,
    },
    reviews: shop.reviews.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      createdAt: row.createdAt,
      qualityStars: row.qualityStars,
      speedStars: row.speedStars,
      valueStars: row.valueStars,
      comment: row.comment ?? null,
      ...row.subject,
    })),
  };
}
