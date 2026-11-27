import { expressOfferOutcomes, expressAcceptRate } from './express-checkout-rules.js';
import { homeDistance } from './home-printers.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WEIGHTS = Object.freeze({ stars: 40, acceptance: 30, onTime: 20, answerSpeed: 10 });
const DEFAULTS = Object.freeze({ minimumOrders: 5, radiusKm: 5, monthlyTopCount: 3 });
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const mean = values => values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;
const iso = ms => new Date(ms).toISOString();

export function leaderboardSettings(settings) {
  return { ...DEFAULTS, ...settings?.shopLeaderboard, weights: { ...WEIGHTS, ...settings?.shopLeaderboard?.weights } };
}
export function nextLeaderboardSettings(settings, patch) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(patch) || Object.keys(patch).some(key => ![...Object.keys(DEFAULTS),'weights'].includes(key))
    || Object.hasOwn(patch,'weights') && (!object(patch.weights) || Object.keys(patch.weights).some(key => !Object.hasOwn(WEIGHTS,key)))) fail('invalid_shop_leaderboard_settings');
  const current = leaderboardSettings(settings);
  const next = { ...current, ...patch, weights: { ...current.weights, ...patch.weights } };
  const weights = Object.values(next.weights);
  if (weights.some(value => !Number.isInteger(value) || value < 0 || value > 100) || weights.reduce((a,b) => a+b,0) !== 100
    || !Number.isInteger(next.minimumOrders) || next.minimumOrders < 1 || next.minimumOrders > 10000
    || typeof next.radiusKm !== 'number' || !Number.isFinite(next.radiusKm) || next.radiusKm <= 0 || next.radiusKm > 500
    || !Number.isInteger(next.monthlyTopCount) || next.monthlyTopCount < 1 || next.monthlyTopCount > 100) fail('invalid_shop_leaderboard_settings');
  return next;
}

/** Half-open Manila calendar periods; weeks start on Monday. */
export function leaderboardPeriod(kind, at) {
  if (!['week','month'].includes(kind)) fail('invalid_leaderboard_period');
  const local = new Date(Date.parse(at) + 8 * HOUR);
  let start, end;
  if (kind === 'month') {
    start = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),1);
    end = Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,1);
  } else {
    start = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()) - ((local.getUTCDay()+6)%7) * DAY;
    end = start + 7 * DAY;
  }
  return { kind, startAt: iso(start - 8 * HOUR), endAt: iso(end - 8 * HOUR) };
}

/** Zero credit for missing evidence; no invented stars or on-time successes. */
export function shopScore(store, supplierId, period, at, policy = leaderboardSettings(store.settings)) {
  const range = { since: Date.parse(period.startAt), until: Date.parse(period.endAt) };
  const offers = expressOfferOutcomes(store,supplierId,at,range);
  const accepted = offers.filter(row => row.status === 'accepted');
  const ids = new Set(accepted.map(row => row.order.id));
  const stars = (store.shopReviews || []).filter(row => ids.has(row.orderId) && row.supplierId === supplierId
    && Date.parse(row.createdAt) >= range.since && Date.parse(row.createdAt) < range.until && Date.parse(row.createdAt) <= Date.parse(at)
    && Number.isInteger(row.qualityStars) && row.qualityStars >= 1 && row.qualityStars <= 5).map(row => row.qualityStars);
  const readiness = [];
  for (const { order } of accepted) {
    const deadline = Date.parse(order.readyBy || order.promiseBy);
    const readyAt = Date.parse(order.readyAt || order.awaitingCollectionAt
      || order.timeline?.find(row => ['ready_for_dispatch','awaiting_collection'].includes(row.state))?.at);
    if (!Number.isFinite(deadline)) continue;
    if (readyAt <= Date.parse(at)) readiness.push(readyAt <= deadline ? 100 : 0);
    else if (deadline <= Date.parse(at)) readiness.push(0);
  }
  const acceptance = expressAcceptRate(store,supplierId,at,range);
  const averageStars = mean(stars);
  const answerSeconds = mean(offers.map(row => row.answerSeconds ?? 60));
  const values = { stars: averageStars, acceptance: acceptance.offered ? accepted.length / acceptance.offered * 100 : null,
    onTime: mean(readiness), answerSpeed: answerSeconds };
  const normalized = { stars: (averageStars ?? 0) / 5 * 100, acceptance: values.acceptance ?? 0,
    onTime: values.onTime ?? 0, answerSpeed: answerSeconds === null ? 0 : Math.max(0,100 * (1-answerSeconds/60)) };
  const samples = { stars: stars.length, acceptance: offers.length, onTime: readiness.length, answerSpeed: offers.length };
  const parts = Object.fromEntries(Object.keys(WEIGHTS).map(key => [key,{ weight: policy.weights[key], value: values[key] === null ? null : round(values[key]),
    normalized: round(normalized[key]), contribution: round(normalized[key]*policy.weights[key]/100), samples: samples[key] }]));
  return { supplierId, score: round(Object.keys(WEIGHTS).reduce((total,key) => total + normalized[key]*policy.weights[key]/100,0)),
    orderCount: accepted.length, ordersToQualify: Math.max(0,policy.minimumOrders-accepted.length), acceptance,
    declines: acceptance.declined, missed: acceptance.timedOut, parts };
}

const point = profile => profile?.shop && Number.isFinite(profile.shop.lat) && Number.isFinite(profile.shop.lng);
function shopIdentity(profile) {
  const home = Boolean(profile.homePrinter) || profile.supplierType === 'home';
  return { supplierId: profile.userId, name: home ? profile.barangay || profile.homePrinter?.barangay || 'Home printer' : profile.shopName || 'Shop', printerType: home ? 'home' : 'shop' };
}
export function leaderboardScores(store, period, at, policy = leaderboardSettings(store.settings)) {
  const reviewIds = new Set((store.users || []).filter(row => row.reviewData === true).map(row => row.id));
  return (store.supplierProfiles || []).filter(profile => !reviewIds.has(profile.userId)).map(profile => ({ ...shopIdentity(profile),
    ...shopScore(store,profile.userId,period,at,policy) }));
}
const rankOrder = (a,b) => b.score-a.score || b.orderCount-a.orderCount || a.supplierId.localeCompare(b.supplierId);
/** Each shop's neighborhood is centered on its own private point, not a transitive cluster. */
export function localLeaderboard(store, supplierId, scores, policy) {
  const profiles = new Map((store.supplierProfiles || []).map(profile => [profile.userId,profile]));
  const center = profiles.get(supplierId);
  if (!point(center)) return [];
  return scores.filter(row => row.orderCount >= policy.minimumOrders && point(profiles.get(row.supplierId))
    && homeDistance(center.shop,profiles.get(row.supplierId).shop) <= policy.radiusKm*1000)
    .sort(rankOrder).map((row,index) => ({ ...row, rank: index+1 }));
}

export function shopLeaderboard(store, supplierId, kind, at) {
  const period = leaderboardPeriod(kind,at), policy = leaderboardSettings(store.settings);
  const scores = leaderboardScores(store,period,at,policy);
  const self = scores.find(row => row.supplierId === supplierId);
  if (!self) fail('shop_not_found',404);
  const local = localLeaderboard(store,supplierId,scores,policy);
  const ranked = local.find(row => row.supplierId === supplierId);
  const next = ranked?.rank > 1 ? local[ranked.rank-2] : null;
  // Avoid a misleading promise that acceptance alone can beat every score.
  const base = self.score - self.parts.acceptance.contribution;
  const neededRate = next && policy.weights.acceptance ? (next.score - base + 0.01) / policy.weights.acceptance : null;
  const acceptedOrdersToPass = neededRate !== null && neededRate < 1
    ? Math.max(0,Math.ceil((neededRate*self.acceptance.offered-self.orderCount)/(1-neededRate))) : null;
  return { period, radiusKm: policy.radiusKm, minimumOrders: policy.minimumOrders, monthlyTopCount: policy.monthlyTopCount,
    own: { ...self, rank: ranked?.rank ?? null, unrankedReason: !point((store.supplierProfiles || []).find(row => row.userId === supplierId)) ? 'shop_location_required'
      : self.orderCount < policy.minimumOrders ? 'minimum_orders_required' : null,
      gap: next ? { nextRank: next.rank, scorePoints: round(next.score-self.score), acceptedOrdersToPass, assumption: 'other_score_parts_and_competitors_unchanged' } : null },
    rows: local.map(row => ({ supplierId: row.supplierId, name: row.name, printerType: row.printerType, rank: row.rank, score: row.score,
      stars: row.parts.stars.value, acceptedPercent: row.parts.acceptance.value, onTimePercent: row.parts.onTime.value, orderCount: row.orderCount,
      isOwn: row.supplierId === supplierId })) };
}
