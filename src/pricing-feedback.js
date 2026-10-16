import { resolveCategoryCode } from './taxonomy.js';
import { voucherFail as fail } from './vouchers.js';

const HOUR = 3600000;
const iso = ms => new Date(ms).toISOString();
/** Leaving checkout to pay in a bank app must not read as leaving: wait this long first. */
export const CHECKOUT_EXIT_GRACE_MS = HOUR;
export const CHECKOUT_EXIT_SPACING_MS = 168 * HOUR;
export const PRICING_OPTIONS = Object.freeze({
  priceFeeling: ['very_cheap', 'cheap', 'fair', 'expensive', 'very_expensive'],
  directShopComparison: ['much_cheaper', 'cheaper', 'about_the_same', 'more_expensive', 'much_more_expensive', 'not_sure'],
  priceWorthTags: ['print_quality', 'on_time', 'door_delivery', 'no_shop_visits', 'quality_check', 'easy_ordering',
    'clear_upfront_price', 'helpful_support', 'other', 'not_worth_it'],
  orderAgainAtPrice: ['yes', 'maybe', 'no'],
  // What the client said would have felt right, against the total the order came to.
  expectedPrice: ['much_lower', 'lower', 'about_the_same', 'higher'],
});
export const CHECKOUT_EXIT_QUESTION = 'What stopped you from ordering?';
export const CHECKOUT_EXIT_REASONS = Object.freeze([
  { code: 'price_too_high', label: 'The price was too high' },
  { code: 'delivery_cost_or_time', label: 'Delivery cost or time' },
  { code: 'still_deciding', label: 'Still deciding' },
  { code: 'payment_problem', label: 'Trouble paying' },
  { code: 'found_another_option', label: 'Found another option' },
  { code: 'just_browsing', label: 'Just looking around' },
  { code: 'other', label: 'Other' },
]);
const REASON_CODES = CHECKOUT_EXIT_REASONS.map(r => r.code);
export const ORDER_SIZE_BRACKETS = Object.freeze([
  { code: 'under_500', minMinor: 0, maxMinor: 49999 },
  { code: '500_to_1999', minMinor: 50000, maxMinor: 199999 },
  { code: '2000_to_4999', minMinor: 200000, maxMinor: 499999 },
  { code: '5000_to_19999', minMinor: 500000, maxMinor: 1999999 },
  { code: '20000_and_up', minMinor: 2000000, maxMinor: null },
]);
const ACCOUNT_TYPES = ['individual', 'business', 'organization'];
export const orderSizeOf = minor => minor == null ? null
  : ORDER_SIZE_BRACKETS.find(b => minor >= b.minMinor && (b.maxMinor == null || minor <= b.maxMinor))?.code ?? null;

export const csvCell = value => '"' + String(value ?? '').replace(/^[\s]*[=+@\-]/, "'$&").replace(/^[\t\r\n]/, "'$&").replaceAll('"', '""') + '"';
const csv = (fields, rows) => Buffer.from([fields.join(','), ...rows.map(r => fields.map(k => csvCell(Array.isArray(r[k]) ? r[k].join('|') : r[k])).join(','))].join('\r\n'));

/** A listing's category: its product type's family first, then its service line. */
function categoryOf(store, catalogItemId, serviceId) {
  const item = catalogItemId && (store.catalogItems || []).find(i => i.id === catalogItemId);
  const sub = item && (store.taxonomy?.subcategories || []).find(s => s.code === item.subcategoryCode);
  const service = (store.supplierServices || []).find(s => s.id === (serviceId || item?.supplierServiceId));
  const code = sub?.categoryCode ?? service?.categoryCode ?? null;
  return code == null ? null : resolveCategoryCode(store.taxonomy, code)?.code ?? code;
}
const distinct = codes => [...new Set(codes.filter(Boolean))].sort();
const accountTypeOf = (store, clientId) => {
  const user = store.users.find(u => u.id === clientId);
  return user ? user.accountType || 'individual' : null;
};

export function orderPricingFacts(store, order, clientId) {
  const lines = order ? (store.orderLineItems || []).filter(l => l.orderId === order.id) : [];
  const orderTotalMinor = order?.totalMinor ?? null;
  return { orderTotalMinor, orderSize: orderSizeOf(orderTotalMinor),
    categoryCodes: distinct(lines.map(l => categoryOf(store, l.sourceCatalogItemId, l.sourceSupplierServiceId))),
    accountType: accountTypeOf(store, clientId) };
}
export const cartCategoryCodes = (store, lines) => distinct(lines.map(l => categoryOf(store, l.catalogItemId, null)));

/** A submitted response with the order and account facts the pricing filters read. */
export function surveyResponseRow(store, survey) {
  const order = store.orders.find(o => o.id === survey.orderId);
  return { ...survey, priceWorthTags: survey.priceWorthTags || [], ...orderPricingFacts(store, order, survey.clientId) };
}
const exitStatus = p => p.answeredAt ? 'answered' : p.skippedAt ? 'skipped' : 'unanswered';
function exitRow(store, prompt) {
  return { ...prompt, status: exitStatus(prompt), orderSize: orderSizeOf(prompt.cartTotalMinor),
    accountType: accountTypeOf(store, prompt.clientId) };
}

/** Category, order size and account type filters shared by every survey and pricing read. */
export function pricingFilter(store, params) {
  const category = params.has('categoryCode') ? resolveCategoryCode(store.taxonomy, params.get('categoryCode')) : null;
  if (params.has('categoryCode') && !category
    || params.has('orderSize') && !ORDER_SIZE_BRACKETS.some(b => b.code === params.get('orderSize'))
    || params.has('accountType') && !ACCOUNT_TYPES.includes(params.get('accountType'))) fail(400, 'invalid_survey_filter');
  return row => (!category || row.categoryCodes.includes(category.code))
    && (!params.has('orderSize') || row.orderSize === params.get('orderSize'))
    && (!params.has('accountType') || row.accountType === params.get('accountType'));
}
function dateFilter(params) {
  for (const key of ['from', 'to']) if (params.has(key) && !Number.isFinite(Date.parse(params.get(key)))) fail(400, 'invalid_survey_filter');
  const from = params.has('from') ? Date.parse(params.get('from')) : -Infinity, to = params.has('to') ? Date.parse(params.get('to')) : Infinity;
  if (from > to || params.has('format') && !['json', 'csv'].includes(params.get('format'))) fail(400, 'invalid_survey_filter');
  return at => Date.parse(at) >= from && Date.parse(at) <= to;
}

export function recordCheckoutVisit(store, cart, lines, { at, totalMinor }) {
  store.checkoutVisits ||= [];
  const snapshot = { cartTotalMinor: totalMinor ?? null, categoryCodes: cartCategoryCodes(store, lines) };
  let visit = store.checkoutVisits.find(v => v.cartId === cart.id);
  // Every checkout screen focus calls this; a fresh, unchanged visit needs no write.
  if (visit && Date.parse(at) - Date.parse(visit.lastReachedAt) < 5 * 60000
    && JSON.stringify(snapshot) === JSON.stringify({ cartTotalMinor: visit.cartTotalMinor, categoryCodes: visit.categoryCodes })) return { visit, changed: false };
  if (!visit) store.checkoutVisits.push(visit = { cartId: cart.id, clientId: cart.clientId, firstReachedAt: at });
  Object.assign(visit, { lastReachedAt: at, ...snapshot });
  return { visit, changed: true };
}

/** The latest checkout left unpaid since the last question, once a week at most. */
export function checkoutExitDue(store, clientId, at) {
  const now = Date.parse(at);
  const asked = (store.checkoutExitPrompts || []).filter(p => p.clientId === clientId).map(p => Date.parse(p.askedAt));
  const lastAsked = asked.length ? Math.max(...asked) : null;
  const nextEligibleAt = lastAsked == null ? null : iso(lastAsked + CHECKOUT_EXIT_SPACING_MS);
  if (lastAsked != null && now < lastAsked + CHECKOUT_EXIT_SPACING_MS) return { visit: null, nextEligibleAt };
  const ordered = store.orders.filter(o => o.clientId === clientId).map(o => Date.parse(o.createdAt));
  const visit = (store.checkoutVisits || []).filter(v => {
    const reached = Date.parse(v.lastReachedAt);
    return v.clientId === clientId && (lastAsked == null || reached > lastAsked) && reached <= now - CHECKOUT_EXIT_GRACE_MS
      && store.carts.find(c => c.id === v.cartId)?.state === 'draft' && !ordered.some(t => t >= reached);
  }).sort((a, b) => b.lastReachedAt.localeCompare(a.lastReachedAt))[0] || null;
  return { visit, nextEligibleAt };
}
export function publicCheckoutExitPrompt(prompt) {
  return prompt && { id: prompt.id, question: CHECKOUT_EXIT_QUESTION, status: exitStatus(prompt), reachedAt: prompt.reachedAt,
    askedAt: prompt.askedAt, answeredAt: prompt.answeredAt ?? null, skippedAt: prompt.skippedAt ?? null,
    reason: prompt.reason ?? null, otherText: prompt.otherText ?? null };
}
export function claimCheckoutExitPrompt(store, clientId, { id, at }) {
  store.checkoutExitPrompts ||= [];
  const { visit, nextEligibleAt } = checkoutExitDue(store, clientId, at);
  if (!visit) return { prompt: null, nextEligibleAt, changed: false };
  const prompt = { id: id('cxp'), clientId, cartId: visit.cartId, reachedAt: visit.lastReachedAt, askedAt: at,
    cartTotalMinor: visit.cartTotalMinor ?? null, categoryCodes: [...(visit.categoryCodes || [])],
    answeredAt: null, skippedAt: null, reason: null, otherText: null };
  store.checkoutExitPrompts.push(prompt);
  return { prompt, nextEligibleAt: iso(Date.parse(at) + CHECKOUT_EXIT_SPACING_MS), changed: true };
}
export function answerCheckoutExitPrompt(store, clientId, promptId, body, { id, at }) {
  const prompt = (store.checkoutExitPrompts || []).find(p => p.id === promptId && p.clientId === clientId);
  if (!prompt) fail(404, 'checkout_exit_prompt_not_found');
  // A retry returns the first answer; it never replaces it.
  if (prompt.answeredAt || prompt.skippedAt) return { prompt, changed: false };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_checkout_exit_answer');
  if (body.skip === true) {
    if (body.reason != null || body.otherText != null) fail(400, 'invalid_checkout_exit_answer');
    prompt.skippedAt = at;
  } else {
    if (!REASON_CODES.includes(body.reason) || body.skip != null && body.skip !== false) fail(400, 'invalid_checkout_exit_answer');
    const text = typeof body.otherText === 'string' ? body.otherText.trim() : body.otherText;
    if (body.reason === 'other' ? typeof text !== 'string' || !text || text.length > 500 : text != null && text !== '') fail(400, 'invalid_checkout_exit_note');
    Object.assign(prompt, { answeredAt: at, reason: body.reason, otherText: body.reason === 'other' ? text : null });
  }
  store.auditLog.push({ id: id('aud'), actorId: clientId, actorRole: 'client', at, action: prompt.answeredAt ? 'checkout_exit.answered' : 'checkout_exit.skipped',
    entityType: 'checkout_exit_prompt', entityId: prompt.id, detail: { reason: prompt.reason } });
  return { prompt, changed: true };
}

const percent = (count, of) => of ? Math.round(1000 * count / of) / 10 : null;
function tally(values, codes) {
  const answered = values.filter(v => v != null);
  return { answered: answered.length, options: codes.map(code => {
    const count = answered.filter(v => v === code).length;
    return { code, count, percent: percent(count, answered.length) };
  }) };
}
function expectedBand(expected, total) {
  if (expected == null || !total) return null;
  const [e, t] = [BigInt(expected) * 100n, BigInt(total)];
  return e < t * 80n ? 'much_lower' : e < t * 95n ? 'lower' : e <= t * 105n ? 'about_the_same' : 'higher';
}

/** Counts and percentages for every pricing question and the checkout exit question. */
export function pricingFeedbackReport(store, params) {
  const inRange = dateFilter(params), matches = pricingFilter(store, params);
  const surveys = (store.orderSurveys || []).filter(s => s.submittedAt && inRange(s.submittedAt)).map(s => surveyResponseRow(store, s)).filter(matches);
  const prompts = (store.checkoutExitPrompts || []).filter(p => inRange(p.askedAt)).map(p => exitRow(store, p)).filter(matches);
  const worthAnswered = surveys.filter(s => s.priceWorthTags.length);
  const questions = {
    priceFeeling: tally(surveys.map(s => PRICING_OPTIONS.priceFeeling[s.priceFeeling - 1] ?? null), PRICING_OPTIONS.priceFeeling),
    expectedPrice: tally(surveys.map(s => expectedBand(s.expectedPriceMinor, s.orderTotalMinor)), PRICING_OPTIONS.expectedPrice),
    directShopComparison: tally(surveys.map(s => s.directShopComparison ?? null), PRICING_OPTIONS.directShopComparison),
    // Choose any: each option is the share of clients who answered this question at all.
    priceWorthTags: { answered: worthAnswered.length, options: PRICING_OPTIONS.priceWorthTags.map(code => {
      const count = worthAnswered.filter(s => s.priceWorthTags.includes(code)).length;
      return { code, count, percent: percent(count, worthAnswered.length) };
    }) },
    orderAgainAtPrice: tally(surveys.map(s => s.orderAgainAtPrice ?? null), PRICING_OPTIONS.orderAgainAtPrice),
  };
  const reasons = tally(prompts.map(p => p.reason ?? null), REASON_CODES);
  const count = status => prompts.filter(p => p.status === status).length;
  const checkoutExit = { asked: prompts.length, answered: count('answered'), skipped: count('skipped'), unanswered: count('unanswered'), reasons };
  if (params.get('format') === 'csv') {
    const rows = [
      ...Object.entries(questions).flatMap(([question, q]) => q.options.map(o => ({ section: 'survey', question, ...o, answered: q.answered }))),
      ...reasons.options.map(o => ({ section: 'checkout_exit', question: 'reason', ...o, answered: reasons.answered })),
    ];
    return { bytes: csv(['section', 'question', 'code', 'count', 'percent', 'answered'], rows) };
  }
  return { survey: { responses: surveys.length, questions }, checkoutExit, orderSizeBrackets: ORDER_SIZE_BRACKETS };
}

export function checkoutExitReport(store, params) {
  const inRange = dateFilter(params), matches = pricingFilter(store, params);
  if (params.has('status') && !['answered', 'skipped', 'unanswered'].includes(params.get('status'))
    || params.has('reason') && !REASON_CODES.includes(params.get('reason'))) fail(400, 'invalid_survey_filter');
  const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 100);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'invalid_pagination');
  const rows = (store.checkoutExitPrompts || []).filter(p => inRange(p.askedAt)).map(p => exitRow(store, p))
    .filter(p => matches(p) && ['clientId', 'status', 'reason'].every(k => !params.has(k) || p[k] === params.get(k)))
    .sort((a, b) => b.askedAt.localeCompare(a.askedAt) || a.id.localeCompare(b.id));
  if (params.get('format') === 'csv') {
    return { bytes: csv(['id', 'clientId', 'cartId', 'reachedAt', 'askedAt', 'status', 'reason', 'otherText', 'answeredAt', 'skippedAt',
      'cartTotalMinor', 'orderSize', 'categoryCodes', 'accountType'], rows) };
  }
  return { prompts: rows.slice(offset, offset + limit), total: rows.length };
}
