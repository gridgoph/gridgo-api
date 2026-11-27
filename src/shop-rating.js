import { maskChatContacts } from './chat-contact-masking.js';
import { expressAcceptRate, isAcceptFirst } from './express-checkout-rules.js';
import { reportOrderAllowed } from './review-data.js';
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
  const reviews = (store.shopReviews || []).filter((row) => row.supplierId === supplierId && reportOrderAllowed(store, row.orderId));
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

export const POSITIVE_RATING_TAGS = Object.freeze(['Accepted fast', 'Clear print', 'Ready on time', 'Friendly', 'Good value', 'Easy to find']);
export const NEGATIVE_RATING_TAGS = Object.freeze(['Faded print', 'Wrong settings', 'Slow to accept', 'Not ready on time', 'Rude', 'Hard to find']);

/** Omission is compatible with clients that only send three scores. */
export function ratingTags(tags, qualityStars) {
  if (tags === undefined) return [];
  const allowed = qualityStars >= 4 ? POSITIVE_RATING_TAGS : NEGATIVE_RATING_TAGS;
  if (!Array.isArray(tags) || tags.length > 12 || tags.some(tag => !allowed.includes(tag))) {
    throw Object.assign(new Error('invalid_rating_tags'), { status: 400, code: 'invalid_rating_tags' });
  }
  return [...new Set(tags)];
}

/** Extract one complete tag line. The stored comment stays intact. */
export function legacyReviewTags(comment, qualityStars) {
  const lines = (comment || '').split(/\r?\n/u).filter(line => line.startsWith('Tags: '));
  if (lines.length !== 1) return [];
  try { return ratingTags(lines[0].slice(6).split(/[,·]/u).map(tag => tag.trim()), qualityStars); }
  catch { return []; }
}

export function reviewTags(review) {
  return review.tags?.length ? [...new Set(review.tags)] : legacyReviewTags(review.comment, review.qualityStars);
}

/** Suppress risky free text at every display boundary; retain original evidence. */
export function visibleReviewComment(comment, privateLabels = []) {
  if (!comment) return null;
  const text = String(comment).normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  if (maskChatContacts(text).contactAttempt
    || /(?<!\d)\d(?:[\s().-]*\d){6,}(?!\d)/u.test(text)
    || /\b(?:address|street|st|road|rd|avenue|ave|boulevard|blvd|barangay|brgy\.?|purok|sitio|subdivision|village|block|blk\.?|lot|unit|gate|guardhouse|landmark|compound|lane|drive|house|apartment|apt|building|bldg|floor|residence)\b/iu.test(text)
    || /#\s*\d+[a-z]?\b/iu.test(text)
    || /\b(?:near|beside|behind|opposite|across\s+from|located\s+at|pick\s*up\s+at|corner\s+of)\b/iu.test(text)
    || /[-+]?\d{1,3}\.\d{3,}\s*[,/]\s*[-+]?\d{1,3}\.\d{3,}/u.test(text)
    || privateLabels.some(label => typeof label === 'string' && label.trim().length >= 3 && text.toLowerCase().includes(label.trim().toLowerCase()))) return null;
  return text;
}

/** Keep the queue identical to the Express printer cards. */
export function shopJobsAhead(store, supplierId) {
  return (store.orders || []).filter(order => order.supplierId === supplierId
    && ['supplier_assigned', 'payment_authorized', 'production', 'supplier_self_qc'].includes(order.state)
    && !(order.state === 'supplier_assigned' && order.expressOrder?.acceptFlow === 2 && order.shopAcceptance?.status !== 'pending')).length;
}

export function reviewPrivateLabels(store, supplierId) {
  const profile = (store.supplierProfiles || []).find(row => row.userId === supplierId);
  const homes = (store.orders || []).filter(row => row.supplierId === supplierId)
    .flatMap(row => [row.homePrinter, ...(row.homePrinterHistory || [])].filter(Boolean));
  return [profile?.shop?.label, profile?.homePrinter?.street, profile?.homePrinter?.landmark,
    profile?.homePrinter?.pickupPoint?.description,
    ...homes.flatMap(home => [home.street, home.landmark, home.pin?.label, home.pickupPoint?.description]),
    ...(store.orders || []).filter(row => row.supplierId === supplierId).map(row => row.pickup?.label)];
}

function reviewerName(store, clientId) {
  const name = (store.users || []).find(row => row.id === clientId)?.name || '';
  // Letters only: malformed profile names cannot smuggle contact or address text.
  const parts = name.trim().split(/\s+/u);
  if (!parts.length || !parts.every(part => /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(part))) return 'Client';
  return parts.length > 1 ? `${parts[0]} ${[...parts.at(-1)][0]}.` : parts[0];
}

/** Authenticated client summary. Below five reviews no review data is shown. */
export function shopRatingsSummary(store, supplierId, at) {
  const rating = publicShopRating(store, supplierId);
  if (!rating) return null;
  const reviews = (store.shopReviews || []).filter(row => row.supplierId === supplierId && reportOrderAllowed(store, row.orderId)
    && Number.isInteger(row.qualityStars) && row.qualityStars >= 1 && row.qualityStars <= 5);
  const tags = new Map();
  for (const review of reviews) for (const tag of reviewTags(review)) tags.set(tag, (tags.get(tag) || 0) + 1);
  const latest = [...reviews].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id))[0];
  const since = Date.parse(at) - 30 * 86400000;
  const answers = [];
  for (const order of store.orders || []) {
    const offer = order.shopAcceptance;
    if (!isAcceptFirst(order) || order.reviewData === true || !reportOrderAllowed(store, order.id) || offer?.supplierId !== supplierId) continue;
    const assigned = Date.parse(offer.assignedAt);
    if (!(assigned > since && assigned <= Date.parse(at))) continue;
    const answer = offer.status === 'accepted' ? offer.acceptedAt : offer.status === 'declined'
      ? order.expressOrder.events?.find(event => event.state === 'declined' && event.supplierId === supplierId && Date.parse(event.at) >= assigned)?.at : null;
    const elapsed = Date.parse(answer) - assigned;
    if (elapsed >= 0 && Date.parse(answer) <= Date.parse(at)) answers.push(elapsed / 1000);
  }
  return { ...rating,
    starBars: [5,4,3,2,1].map(stars => ({ stars, count: reviews.filter(row => row.qualityStars === stars).length })),
    acceptRate: expressAcceptRate(store, supplierId, at),
    averageAnswerSeconds: answers.length ? Math.round(answers.reduce((a,b) => a+b, 0) / answers.length) : null,
    jobsAhead: shopJobsAhead(store, supplierId),
    topTags: [...tags].map(([tag,count]) => ({tag,count})).sort((a,b) => b.count-a.count || a.tag.localeCompare(b.tag)).slice(0,3),
    latestReview: latest ? { reviewer: reviewerName(store, latest.clientId), qualityStars: latest.qualityStars,
      tags: reviewTags(latest), comment: visibleReviewComment(latest.comment, reviewPrivateLabels(store, supplierId)), createdAt: latest.createdAt } : null,
  };
}
