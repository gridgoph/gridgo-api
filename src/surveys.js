import { promotionSettings } from './promotion-settings.js';
import { foundingTesterEligible, testerOrderFacts, reconcileFoundingTester, publicFoundingTester } from './founding-testers.js';
import { carriedToOffice } from './operational-model.js';
import { notifyAdmins } from './domain-events.js';
import { queueOrderInvalidate } from './notifications.js';
import { issueVoucher, publicVoucher, generatedVoucherCode, voucherFail as fail } from './vouchers.js';
import { PRICING_OPTIONS, csvCell, pricingFilter, surveyResponseRow } from './pricing-feedback.js';
import { isReviewData } from './review-data.js';

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
export const SURVEY_OPTIONS = Object.freeze({
  fulfillmentTags: {
    delivery: ['on_time', 'late', 'friendly_rider', 'clear_updates', 'hard_to_contact', 'careful_handling', 'damaged_package', 'other'],
    pickup: ['easy_to_find', 'ready_on_time', 'long_wait', 'helpful_staff', 'clear_instructions', 'inconvenient_hours', 'damaged_package', 'other'],
  },
  easeTags: ['easy_to_find_product', 'clear_options', 'easy_checkout', 'upload_difficulty', 'confusing_steps', 'payment_difficulty', 'slow_app', 'other'],
  priceFeeling: PRICING_OPTIONS.priceFeeling,
  directShopComparison: PRICING_OPTIONS.directShopComparison,
  priceWorthTags: PRICING_OPTIONS.priceWorthTags,
  orderAgainAtPrice: PRICING_OPTIONS.orderAgainAtPrice,
});
const ANSWER_KEYS = ['fulfillmentStars', 'fulfillmentTags', 'easeStars', 'easeTags', 'priceFeeling', 'expectedPriceMinor',
  'directShopComparison', 'priceWorthTags', 'orderAgainAtPrice', 'qualityStars', 'recommendScore', 'improvementNote'];
function invitation(store, order) {
  const launch = Date.parse(store.surveyLaunchedAt);
  const failureAt = foundingTesterEligible(store, order.clientId) ? testerOrderFacts(store, order).failureAt : null;
  const completedAt = failureAt || order.issueWindowOpenedAt || order.timeline?.find(e => e.state === 'delivered')?.at;
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(launch) || !Number.isFinite(completed) || completed < launch - 14 * DAY
    || (!failureAt && !['delivered', 'issue_window_open', 'completed', 'payout_released'].includes(order.state))) return null;
  const opened = Math.max(launch, completed);
  return { orderId: order.id, clientId: order.clientId, completedAt, openedAt: iso(opened), expiresAt: iso(opened + 7 * DAY),
    fulfillmentKind: carriedToOffice(order) || order.fulfillmentMode !== 'delivery' ? 'pickup' : 'delivery' };
}
export function syncSurveys(store, { id, at }) {
  store.orderSurveys ||= [];
  let changed = false;
  const existing = new Set(store.orderSurveys.map(s => s.orderId));
  for (const order of store.orders) {
    if (existing.has(order.id)) continue;
    const record = invitation(store, order);
    if (!record || Date.parse(at) < Date.parse(record.openedAt) || Date.parse(at) >= Date.parse(record.expiresAt)) continue;
    store.orderSurveys.push({ ...record, notifiedAt: at, fulfillmentTags: [], easeTags: [], priceWorthTags: [], needsFollowUp: false });
    store.notifications.push({ id: id('not'), userId: order.clientId, appRole: 'client', orderId: order.id,
      type: 'order_survey_available', title: 'How did your order go?',
      body: 'Share your experience in a short optional survey. Open this order to answer within 7 days. Survey reward limits apply.', at, read: false });
    notifyAdmins(store, 'order_survey_available', 'Order survey opened', order, `survey-open:${order.id}`, { createId: id, at });
    queueOrderInvalidate(store, order, ['orders', 'notifications']);
    changed = true;
  }
  return changed;
}
const lowStars = s => [s.fulfillmentStars, s.easeStars, s.qualityStars].some(v => v != null && v <= 2);
function rewardNextAt(store, clientId) {
  const times = (store.orderSurveys || []).filter(s => s.clientId === clientId && s.rewardVoucherId).map(s => Date.parse(s.submittedAt));
  return times.length ? iso(Math.max(...times) + 7 * DAY) : null;
}
export function publicSurvey(store, order, at) {
  // Pure reads can show a card before the backfill sweep has queued its notice.
  const s = store.orderSurveys?.find(s => s.orderId === order.id) || invitation(store, order);
  if (!s || Date.parse(at) < Date.parse(s.openedAt)) return null;
  const status = s.submittedAt ? 'submitted' : Date.parse(at) >= Date.parse(s.expiresAt) ? 'expired' : 'open';
  const rewardsAllowed = !isReviewData(order) && !isReviewData(store.users.find(u => u.id === order.clientId));
  const tester = rewardsAllowed && foundingTesterEligible(store, order.clientId);
  const testerView = tester ? publicFoundingTester(store, order.clientId, at) : null;
  const nextRewardAt = rewardsAllowed && !tester ? rewardNextAt(store, order.clientId) : null;
  const voucher = s.rewardVoucherId && store.vouchers.find(v => v.id === s.rewardVoucherId);
  return { orderId: order.id, status, fulfillmentKind: s.fulfillmentKind, openedAt: s.openedAt, expiresAt: s.expiresAt,
    dismissedAt: s.dismissedAt || null, submittedAt: s.submittedAt || null,
    answers: s.submittedAt ? Object.fromEntries(ANSWER_KEYS.map(key => [key, s[key] ?? (key === 'priceWorthTags' ? [] : null)])) : null,
    needsFollowUp: s.needsFollowUp || false,
    rewardStatus: s.rewardStatus || null, reward: voucher ? publicVoucher(store, voucher, at) : s.rewardStatus === 'founding_tester' ? testerView?.reward || null : null,
    rewardEligible: rewardsAllowed && status === 'open' && (tester ? !testerView.awardedAt && !store.orderSurveys?.some(s => s.clientId === order.clientId && s.rewardVoucherId) && testerOrderFacts(store, order).received : (!nextRewardAt || Date.parse(at) >= Date.parse(nextRewardAt))), nextRewardAt,
    rewardProgram: tester ? 'founding_tester' : 'survey',
    reportProblem: s.submittedAt && lowStars(s) && order.state === 'issue_window_open' && Date.parse(order.issueWindowExpiresAt) > Date.parse(at)
      ? { label: 'Report a problem with this order', path: `/orders/${order.id}/issues`, method: 'POST' } : null };
}
function validateAnswers(body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_survey_answers');
  const result = {};
  for (const [key, max, required, min] of [['fulfillmentStars', 5, true, 1], ['easeStars', 5, true, 1], ['priceFeeling', 5, true, 1], ['qualityStars', 5, false, 1], ['recommendScore', 10, false, 0]]) {
    const value = body[key];
    if (value == null && !required) { result[key] = null; continue; }
    if (!Number.isInteger(value) || value < min || value > max) fail(400, 'invalid_survey_answers');
    result[key] = value;
  }
  for (const key of ['fulfillmentTags', 'easeTags']) {
    const value = body[key] ?? [];
    const allowed = key === 'fulfillmentTags' ? SURVEY_OPTIONS.fulfillmentTags[kind] : SURVEY_OPTIONS.easeTags;
    if (!Array.isArray(value) || value.length > 8 || value.some(v => !allowed.includes(v)) || new Set(value).size !== value.length) fail(400, 'invalid_survey_tags');
    result[key] = [...value];
  }
  for (const key of ['directShopComparison', 'orderAgainAtPrice']) {
    if (body[key] != null && !SURVEY_OPTIONS[key].includes(body[key])) fail(400, 'invalid_survey_answers');
    result[key] = body[key] ?? null;
  }
  const worth = body.priceWorthTags ?? [];
  // "Not worth it" is the opposite of every reason, so it stands alone.
  if (!Array.isArray(worth) || worth.some(v => !SURVEY_OPTIONS.priceWorthTags.includes(v)) || new Set(worth).size !== worth.length
    || worth.includes('not_worth_it') && worth.length > 1) fail(400, 'invalid_survey_tags');
  result.priceWorthTags = [...worth];
  if (body.expectedPriceMinor != null && (!Number.isSafeInteger(body.expectedPriceMinor) || body.expectedPriceMinor < 0)) fail(400, 'invalid_survey_expected_price');
  if (body.improvementNote != null && (typeof body.improvementNote !== 'string' || body.improvementNote.length > 2000)) fail(400, 'invalid_survey_note');
  result.expectedPriceMinor = body.expectedPriceMinor ?? null;
  result.improvementNote = body.improvementNote?.trim() || null;
  return result;
}
export function submitSurvey(store, order, body, { id, at }) {
  let record = store.orderSurveys?.find(s => s.orderId === order.id);
  if (record?.submittedAt) return publicSurvey(store, order, at);
  const view = publicSurvey(store, order, at);
  if (!view || view.status !== 'open') fail(409, 'survey_closed');
  const answers = validateAnswers(body, view.fulfillmentKind);
  syncSurveys(store, { id, at });
  record = store.orderSurveys.find(s => s.orderId === order.id);
  Object.assign(record, answers, { submittedAt: at, needsFollowUp: lowStars(answers) || answers.recommendScore != null && answers.recommendScore <= 6,
    rewardStatus: 'cooldown' });
  if (!isReviewData(order) && foundingTesterEligible(store, order.clientId)) {
    record.rewardStatus = 'founding_tester';
    reconcileFoundingTester(store, order.clientId, { id, at });
  } else if (view.rewardEligible) {
    // A private assigned campaign per entitlement preserves the wallet's one-per-campaign
    // rule without calendar-week loopholes or changes to published campaign terms.
    const campaign = { id: id('vcamp'), name: 'Thank you for your order feedback', purpose: 'survey', code: generatedVoucherCode(),
      mode: 'assigned', status: 'active', valueMinor: promotionSettings(store).rewards.surveyMinor, totalLimit: 1, perAccountLimit: 1,
      validityDays: 30, endsAt: null, createdAt: at, updatedAt: at };
    store.voucherCampaigns.push(campaign);
    const { voucher } = issueVoucher(store, campaign, order.clientId, { id, at, actorId: order.clientId, adultConfirmed: false });
    voucher.data.surveyOrderId = order.id;
    record.rewardVoucherId = voucher.id; record.rewardStatus = 'issued';
  }
  store.auditLog.push({ id: id('aud'), actorId: order.clientId, actorRole: 'client', at, action: 'survey.submitted',
    entityType: 'order_survey', entityId: order.id, orderId: order.id, detail: { rewardStatus: record.rewardStatus, needsFollowUp: record.needsFollowUp } });
  notifyAdmins(store, 'order_survey_submitted', 'Order survey received', order, `survey-submit:${order.id}`, { createId: id, at });
  queueOrderInvalidate(store, order, ['orders', 'notifications']);
  return publicSurvey(store, order, at);
}
export function surveyReport(store, params) {
  for (const key of ['from', 'to']) if (params.has(key) && !Number.isFinite(Date.parse(params.get(key)))) fail(400, 'invalid_survey_filter');
  if (params.has('from') && params.has('to') && Date.parse(params.get('from')) > Date.parse(params.get('to'))) fail(400, 'invalid_survey_filter');
  if (params.has('needsFollowUp') && !['true', 'false'].includes(params.get('needsFollowUp'))
    || params.has('fulfillmentKind') && !['delivery', 'pickup'].includes(params.get('fulfillmentKind'))
    || params.has('rewardStatus') && !['issued', 'cooldown', 'founding_tester'].includes(params.get('rewardStatus'))
    || params.has('format') && !['json', 'csv'].includes(params.get('format'))) fail(400, 'invalid_survey_filter');
  for (const [key, max, min] of [['fulfillmentStars', 5, 1], ['easeStars', 5, 1], ['qualityStars', 5, 1], ['priceFeeling', 5, 1], ['recommendScore', 10, 0]]) {
    if (params.has(key) && (!/^\d+$/.test(params.get(key)) || Number(params.get(key)) < min || Number(params.get(key)) > max)) fail(400, 'invalid_survey_filter');
  }
  const matchesPricing = pricingFilter(store, params);
  const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 100);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'invalid_pagination');
  const rows = (store.orderSurveys || []).filter(s => s.submittedAt).map(s => surveyResponseRow(store, s)).filter(s =>
    matchesPricing(s)
    && ['clientId', 'orderId', 'fulfillmentKind', 'rewardStatus'].every(k => !params.has(k) || s[k] === params.get(k))
    && ['fulfillmentStars', 'easeStars', 'qualityStars', 'priceFeeling', 'recommendScore'].every(k => !params.has(k) || s[k] === Number(params.get(k)))
    && (!params.has('needsFollowUp') || s.needsFollowUp === (params.get('needsFollowUp') === 'true'))
    && (!params.has('tag') || [...s.fulfillmentTags, ...s.easeTags].includes(params.get('tag')))
    && (!params.has('from') || Date.parse(s.submittedAt) >= Date.parse(params.get('from')))
    && (!params.has('to') || Date.parse(s.submittedAt) <= Date.parse(params.get('to'))))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.orderId.localeCompare(b.orderId));
  const averages = {}, counts = {};
  for (const key of ['fulfillmentStars', 'easeStars', 'priceFeeling', 'qualityStars', 'recommendScore']) {
    const values = rows.map(s => s[key]).filter(v => v != null);
    counts[key] = values.length; averages[key] = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  }
  const promoters = rows.filter(s => s.recommendScore >= 9).length;
  const detractors = rows.filter(s => s.recommendScore != null && s.recommendScore <= 6).length;
  const aggregates = { averages, counts, needsFollowUp: rows.filter(s => s.needsFollowUp).length, promoters, detractors,
    passives: counts.recommendScore - promoters - detractors,
    nps: counts.recommendScore ? 100 * (promoters - detractors) / counts.recommendScore : null };
  if (params.get('format') === 'csv') {
    const fields = ['orderId', 'clientId', 'fulfillmentKind', 'submittedAt', 'fulfillmentStars', 'fulfillmentTags', 'easeStars', 'easeTags',
      'priceFeeling', 'expectedPriceMinor', 'qualityStars', 'recommendScore', 'improvementNote', 'needsFollowUp', 'rewardStatus', 'rewardVoucherId',
      'directShopComparison', 'priceWorthTags', 'orderAgainAtPrice', 'orderTotalMinor', 'orderSize', 'categoryCodes', 'accountType'];
    return { bytes: Buffer.from([fields.join(','), ...rows.map(s => fields.map(k => csvCell(Array.isArray(s[k]) ? s[k].join('|') : s[k])).join(','))].join('\r\n')) };
  }
  return { responses: rows.slice(offset, offset + limit), total: rows.length, aggregates };
}

