import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id } from './fixtures/reschedule.js';
import { syncSurveys, submitSurvey, surveyReport } from '../src/surveys.js';
import { recordCheckoutVisit, claimCheckoutExitPrompt, answerCheckoutExitPrompt, pricingFeedbackReport, checkoutExitReport,
  orderSizeOf } from '../src/pricing-feedback.js';
import { routePricingFeedback } from '../src/pricing-feedback-routes.js';

const AT = '2026-10-14T00:00:00.000Z';
const HOUR = 3600000, DAY = 24 * HOUR;
const time = ms => new Date(Date.parse(AT) + ms).toISOString();
const answers = { fulfillmentStars: 5, easeStars: 4, priceFeeling: 4 };
const pricing = { directShopComparison: 'more_expensive', priceWorthTags: ['door_delivery', 'no_shop_visits'], orderAgainAtPrice: 'maybe' };
function setup() {
  const store = fixture(); store.surveyLaunchedAt = AT;
  Object.assign(store.orders[0], { state: 'issue_window_open', issueWindowOpenedAt: AT, issueWindowExpiresAt: time(DAY) });
  return store;
}
const addOrder = (store, orderId, extra = {}) => { store.orders.push({ ...store.orders[0], id: orderId, ...extra }); syncSurveys(store, { id, at: AT }); };
const submit = (store, orderId = 'order', body = answers, at = AT) => submitSurvey(store, store.orders.find(o => o.id === orderId), body, { id, at });
function addCart(store, cartId = 'cart', at = AT) {
  store.carts.push({ id: cartId, clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard', fulfillmentMode: 'delivery',
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' }, createdAt: at, updatedAt: at });
  store.cartLines.push({ id: `${cartId}_line`, cartId, supplierId: 'supplier', catalogItemId: 'item_supplier', optionIds: [], quantity: 10,
    structuredSpec: {}, sortOrder: 0, createdAt: at, updatedAt: at });
}
const visit = (store, cartId = 'cart', at = AT, totalMinor = 19900) => recordCheckoutVisit(store, store.carts.find(c => c.id === cartId),
  store.cartLines.filter(l => l.cartId === cartId), { at, totalMinor });
const claim = (store, at, clientId = 'client') => claimCheckoutExitPrompt(store, clientId, { id, at });

test('the three pricing answers are optional, stored once and never change the fixed survey reward', () => {
  const store = setup(); syncSurveys(store, { id, at: AT });
  const first = submit(store, 'order', { ...answers, ...pricing });
  assert.deepEqual([first.answers.directShopComparison, first.answers.priceWorthTags, first.answers.orderAgainAtPrice],
    ['more_expensive', ['door_delivery', 'no_shop_visits'], 'maybe']);
  // Before and after: the same ₱15 voucher, the same seven-day cooldown, with or without pricing answers.
  assert.equal(first.rewardStatus, 'issued'); assert.equal(first.reward.valueMinor, 1500);
  assert.equal(first.needsFollowUp, false);
  addOrder(store, 'second');
  const second = submit(store, 'second', answers);
  assert.equal(second.rewardStatus, 'cooldown'); assert.equal(second.reward, null);
  assert.deepEqual([second.answers.directShopComparison, second.answers.priceWorthTags, second.answers.orderAgainAtPrice], [null, [], null]);
  addOrder(store, 'third');
  assert.equal(submit(store, 'third', { ...answers, ...pricing, orderAgainAtPrice: 'no' }, time(7 * DAY - 1)).rewardStatus, 'cooldown');
  assert.equal(store.vouchers.length, 1);
  // A replay keeps the original pricing answers.
  assert.equal(submit(store, 'order', { ...answers, orderAgainAtPrice: 'no' }).answers.orderAgainAtPrice, 'maybe');
});

test('pricing answers are validated before anything is saved', () => {
  for (const extra of [{ directShopComparison: 'free' }, { orderAgainAtPrice: true }, { priceWorthTags: ['invented'] },
    { priceWorthTags: ['print_quality', 'print_quality'] }, { priceWorthTags: ['not_worth_it', 'on_time'] }, { priceWorthTags: 'on_time' }]) {
    const store = setup(); syncSurveys(store, { id, at: AT });
    assert.throws(() => submit(store, 'order', { ...answers, ...extra }), { status: 400 });
    assert.equal(store.orderSurveys[0].submittedAt, undefined); assert.equal(store.vouchers.length, 0);
  }
  const store = setup(); syncSurveys(store, { id, at: AT });
  assert.deepEqual(submit(store, 'order', { ...answers, priceWorthTags: ['not_worth_it'] }).answers.priceWorthTags, ['not_worth_it']);
});

test('the exit question waits an hour after checkout, asks once, and never twice inside seven days', () => {
  const store = setup(); addCart(store); addCart(store, 'later');
  assert.equal(claim(store, AT).prompt, null);
  visit(store);
  assert.equal(claim(store, time(HOUR - 1)).prompt, null, 'paying in another app is not leaving');
  const asked = claim(store, time(HOUR));
  assert.equal(asked.prompt.cartId, 'cart'); assert.equal(asked.prompt.reachedAt, AT);
  assert.equal(asked.nextEligibleAt, time(HOUR + 7 * DAY));
  assert.equal(claim(store, time(HOUR)).prompt, null, 'shown once, even unanswered');
  // A new abandoned checkout inside the week waits for the seven-day limit.
  visit(store, 'later', time(DAY));
  const waiting = claim(store, time(7 * DAY + HOUR - 1));
  assert.equal(waiting.prompt, null); assert.equal(waiting.nextEligibleAt, time(HOUR + 7 * DAY));
  const again = claim(store, time(7 * DAY + HOUR));
  assert.equal(again.prompt.cartId, 'later');
  // Without another abandoned checkout since the last question, a week passing asks nothing.
  assert.equal(claim(store, time(30 * DAY)).prompt, null);
  assert.equal(store.vouchers.length, 0, 'no reward');
});

test('paying later, from this cart or another, means checkout was not abandoned', () => {
  const store = setup(); addCart(store); visit(store);
  store.carts[0].state = 'checked_out';
  assert.equal(claim(store, time(2 * HOUR)).prompt, null);
  store.carts[0].state = 'draft';
  store.orders.push({ ...store.orders[0], id: 'paid-elsewhere', createdAt: time(HOUR / 2) });
  assert.equal(claim(store, time(2 * HOUR)).prompt, null);
  assert.equal(claim(store, time(2 * HOUR), 'other').prompt, null, 'another client never sees this checkout');
});

test('one-tap answers, Other text and skip are recorded once; a skip still counts toward the week', () => {
  const store = setup(); addCart(store); visit(store);
  const { prompt } = claim(store, time(HOUR));
  const answer = body => answerCheckoutExitPrompt(store, 'client', prompt.id, body, { id, at: time(HOUR + 1) });
  for (const body of [null, {}, { reason: 'invented' }, { reason: 'price_too_high', skip: true }, { skip: true, reason: 'other', otherText: 'x' }]) {
    assert.throws(() => answer(body), { code: 'invalid_checkout_exit_answer' });
  }
  for (const body of [{ reason: 'other' }, { reason: 'other', otherText: '   ' }, { reason: 'other', otherText: 'a'.repeat(501) },
    { reason: 'price_too_high', otherText: 'not for this answer' }]) assert.throws(() => answer(body), { code: 'invalid_checkout_exit_note' });
  assert.throws(() => answerCheckoutExitPrompt(store, 'other', prompt.id, { skip: true }, { id, at: AT }), { code: 'checkout_exit_prompt_not_found' });
  const saved = answer({ reason: 'other', otherText: '  Needed it sooner  ' });
  assert.equal(saved.changed, true); assert.equal(saved.prompt.otherText, 'Needed it sooner');
  assert.equal(answer({ reason: 'just_browsing' }).prompt.reason, 'other');
  assert.equal(store.auditLog.filter(e => e.action === 'checkout_exit.answered').length, 1);

  const skipped = setup(); addCart(skipped); visit(skipped);
  const second = claim(skipped, time(HOUR)).prompt;
  assert.equal(answerCheckoutExitPrompt(skipped, 'client', second.id, { skip: true }, { id, at: time(HOUR) }).prompt.skippedAt, time(HOUR));
  visit(skipped, 'cart', time(2 * DAY));
  assert.equal(claim(skipped, time(3 * DAY)).prompt, null);
  assert.ok(claim(skipped, time(7 * DAY + HOUR)).prompt);
});

test('client routes record a visit, claim the question and answer it; other roles cannot', async () => {
  const store = setup(); addCart(store);
  const call = (user, method, path, body, at = AT) => routePricingFeedback({ store, user, req: { method }, url: new URL(`http://api${path}`),
    readBody: async () => body, id, now: () => at });
  const client = { id: 'client', role: 'client' };
  await assert.rejects(call(null, 'POST', '/me/carts/cart/checkout-visit'), { status: 401 });
  await assert.rejects(call({ id: 'supplier', role: 'supplier' }, 'POST', '/me/checkout-exit-feedback/prompt'), { status: 403 });
  await assert.rejects(call({ id: 'other', role: 'client' }, 'POST', '/me/carts/cart/checkout-visit'), { code: 'cart_not_found' });
  const recorded = await call(client, 'POST', '/me/carts/cart/checkout-visit');
  assert.equal(recorded.mutated, true); assert.equal(recorded.body.visit.lastReachedAt, AT);
  assert.equal(store.checkoutVisits[0].cartTotalMinor, 19900); assert.deepEqual(store.checkoutVisits[0].categoryCodes, ['marketing_collateral']);
  assert.equal((await call(client, 'POST', '/me/carts/cart/checkout-visit', null, time(60000))).mutated, false);
  const early = await call(client, 'POST', '/me/checkout-exit-feedback/prompt', null, time(HOUR - 1));
  assert.equal(early.body.prompt, null); assert.equal(early.mutated, false);
  const due = await call(client, 'POST', '/me/checkout-exit-feedback/prompt', null, time(HOUR));
  assert.equal(due.body.question, 'What stopped you from ordering?');
  assert.equal(due.body.options.length, 7); assert.equal(due.body.prompt.status, 'unanswered');
  const answered = await call(client, 'POST', `/me/checkout-exit-feedback/${due.body.prompt.id}`, { reason: 'price_too_high' }, time(HOUR));
  assert.equal(answered.body.prompt.status, 'answered'); assert.equal(answered.mutated, true);
  store.carts[0].state = 'checked_out';
  await assert.rejects(call(client, 'POST', '/me/carts/cart/checkout-visit'), { code: 'cart_checked_out' });
  for (const user of [client, { id: 'ops', role: 'ops_admin' }]) {
    await assert.rejects(call(user, 'GET', '/admin/pricing-feedback'), { status: 403 });
    await assert.rejects(call(user, 'GET', '/admin/checkout-exit-feedback'), { status: 403 });
  }
});

test('Admin pricing results count every question with percentages, filters and a safe CSV', () => {
  const store = setup(); syncSurveys(store, { id, at: AT });
  store.users.push({ id: 'shop-client', role: 'client', accountType: 'business', email: 'b@example.invalid', name: 'b', createdAt: AT });
  store.userRoleMemberships.push({ userId: 'shop-client', role: 'client', createdAt: AT });
  addOrder(store, 'large', { totalMinor: 2500000 });
  addOrder(store, 'business', { clientId: 'shop-client', totalMinor: 60000 });
  submit(store, 'order', { ...answers, ...pricing, expectedPriceMinor: 9000 });
  submit(store, 'large', { ...answers, priceFeeling: 5, directShopComparison: 'much_more_expensive', priceWorthTags: ['not_worth_it'], orderAgainAtPrice: 'no', expectedPriceMinor: 2500000 });
  submit(store, 'business', { ...answers, priceFeeling: 3, priceWorthTags: ['door_delivery'] });
  addCart(store); visit(store, 'cart', AT, null);
  const prompt = claim(store, time(HOUR)).prompt;
  answerCheckoutExitPrompt(store, 'client', prompt.id, { reason: 'other', otherText: '=HYPERLINK("x")' }, { id, at: time(HOUR) });

  const all = pricingFeedbackReport(store, new URLSearchParams());
  assert.equal(all.survey.responses, 3);
  const q = all.survey.questions;
  const option = (question, code) => question.options.find(o => o.code === code);
  assert.deepEqual(option(q.priceFeeling, 'expensive'), { code: 'expensive', count: 1, percent: 33.3 });
  assert.equal(q.directShopComparison.answered, 2); assert.equal(option(q.directShopComparison, 'more_expensive').percent, 50);
  assert.equal(q.priceWorthTags.answered, 3); assert.equal(option(q.priceWorthTags, 'door_delivery').count, 2);
  assert.equal(option(q.priceWorthTags, 'door_delivery').percent, 66.7);
  assert.equal(q.orderAgainAtPrice.answered, 2); assert.equal(option(q.orderAgainAtPrice, 'no').count, 1);
  // ₱90 against a ₱120 order is under 80%; ₱25,000 against ₱25,000 is about the same.
  assert.equal(option(q.expectedPrice, 'much_lower').count, 1); assert.equal(option(q.expectedPrice, 'about_the_same').count, 1);
  assert.equal(q.expectedPrice.answered, 2);
  assert.deepEqual(all.checkoutExit, { asked: 1, answered: 1, skipped: 0, unanswered: 0,
    reasons: { answered: 1, options: all.checkoutExit.reasons.options } });
  assert.equal(all.checkoutExit.reasons.options.find(o => o.code === 'other').percent, 100);

  const report = query => pricingFeedbackReport(store, new URLSearchParams(query));
  assert.equal(report('accountType=business').survey.responses, 1);
  assert.equal(report('accountType=business').checkoutExit.asked, 0);
  assert.equal(report('orderSize=20000_and_up').survey.responses, 1);
  assert.equal(report('orderSize=under_500').survey.responses, 1);
  assert.equal(report('orderSize=under_500').checkoutExit.asked, 0, 'an unpriced cart has no size');
  // Only the fixture's original order has line items, so only it has a category.
  assert.equal(report('categoryCode=marketing_collateral').survey.responses, 1);
  assert.equal(report('categoryCode=marketing_collateral').checkoutExit.asked, 1);
  assert.equal(report(`from=${time(1)}`).survey.responses, 0);
  assert.equal(report(`from=${time(1)}`).checkoutExit.asked, 1);
  for (const bad of ['categoryCode=nope', 'orderSize=huge', 'accountType=shop', 'from=yesterday', `from=${time(1)}&to=${AT}`, 'format=xml']) {
    assert.throws(() => report(bad), { code: 'invalid_survey_filter' });
  }
  const csv = pricingFeedbackReport(store, new URLSearchParams('format=csv')).bytes.toString();
  assert.ok(csv.startsWith('section,question,code,count,percent,answered\r\n'));
  assert.ok(csv.includes('"survey","priceWorthTags","door_delivery","2","66.7","3"'));
  assert.ok(csv.includes('"checkout_exit","reason","other","1","100","1"'));
  const rows = checkoutExitReport(store, new URLSearchParams('status=answered'));
  assert.equal(rows.total, 1); assert.equal(rows.prompts[0].otherText, '=HYPERLINK("x")');
  assert.ok(checkoutExitReport(store, new URLSearchParams('format=csv')).bytes.toString().includes(`"'=HYPERLINK(""x"")"`));
  assert.throws(() => checkoutExitReport(store, new URLSearchParams('status=maybe')), { code: 'invalid_survey_filter' });

  // The existing response list and export carry the same filters and the new answers.
  const responses = surveyReport(store, new URLSearchParams('accountType=individual'));
  assert.equal(responses.total, 2); assert.equal(responses.responses[0].orderSize !== undefined, true);
  assert.match(surveyReport(store, new URLSearchParams('format=csv')).bytes.toString().split('\r\n')[0], /directShopComparison,priceWorthTags,orderAgainAtPrice,orderTotalMinor,orderSize,categoryCodes,accountType$/);
});

test('order size brackets are inclusive whole-peso bands', () => {
  assert.deepEqual([0, 49999, 50000, 199999, 200000, 499999, 500000, 1999999, 2000000, null].map(orderSizeOf),
    ['under_500', 'under_500', '500_to_1999', '500_to_1999', '2000_to_4999', '2000_to_4999', '5000_to_19999', '5000_to_19999', '20000_and_up', null]);
});
