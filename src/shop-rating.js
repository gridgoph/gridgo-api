/** The same minimum gates both public stars and quality ranking. */
export const MIN_REVIEWS_FOR_RATING = 5;

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

/** Omit public ratings until enough valid quality reviews exist. */
export function publicShopRating(store, supplierId) {
  const rating = shopRating(store, supplierId);
  return rating && rating.count >= MIN_REVIEWS_FOR_RATING
    ? { average: Number(rating.average.toFixed(1)), count: rating.count }
    : null;
}
