import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id } from './fixtures/reschedule.js';
import { syncSurveys, publicSurvey, submitSurvey, surveyReport } from '../src/surveys.js';
import { addVoucherCode } from '../src/vouchers.js';

const AT = '2026-10-14T00:00:00.000Z';
const DAY = 86400000;
const time = days => new Date(Date.parse(AT) + days * DAY).toISOString();
const answers = { fulfillmentStars: 5, fulfillmentTags: ['on_time'], easeStars: 4, easeTags: ['easy_checkout'], priceFeeling: 3 };
function setup() {
  const store = fixture(); store.surveyLaunchedAt = AT;
  const order = store.orders[0];
  Object.assign(order, { state: 'issue_window_open', issueWindowOpenedAt: AT, issueWindowExpiresAt: time(1) });
  return store;
}
const sync = (store, at = AT) => syncSurveys(store, { id, at });
const submit = (store, orderId = 'order', body = answers, at = AT) => submitSurvey(store, store.orders.find(o => o.id === orderId), body, { id, at });

test('launch includes the preceding 14 days; survey expiry is exclusive and notices are once per order', () => {
  const store = setup();
  store.orders[0].issueWindowOpenedAt = time(-14);
  store.orders.push({ ...store.orders[0], id: 'old', issueWindowOpenedAt: new Date(Date.parse(time(-14)) - 1).toISOString() });
  store.orders.push({ ...store.orders[0], id: 'unclaimed', state: 'awaiting_collection', issueWindowOpenedAt: undefined });
  assert.equal(sync(store), true); assert.equal(sync(store), false);
  assert.deepEqual(store.orderSurveys.map(s => s.orderId), ['order']);
  assert.equal(store.orderSurveys[0].expiresAt, time(7));
  assert.equal(store.notifications.filter(n => n.type === 'order_survey_available' && n.userId === 'client').length, 1);
  assert.equal(publicSurvey(store, store.orders[0], time(7)).status, 'expired');
  assert.throws(() => submit(store, 'order', answers, time(7)), { code: 'survey_closed' });
});

test('three answers issue a fixed in-app reward; retries and cooldown never mint again', () => {
  const store = setup(); sync(store);
  const response = submit(store);
  assert.equal(response.reward.valueMinor, 1500); assert.equal(response.reward.expiresAt, time(30));
  assert.match(response.reward.code, /^[A-Z0-9-]+$/);
  assert.equal(store.voucherEmailOutbox.length, 0); assert.equal(store.vouchers[0].emailAllowed, false);
  assert.equal(submit(store).reward.id, response.reward.id);
  assert.equal(store.voucherLedger.filter(e => e.kind === 'issued').length, 1);
  assert.equal(addVoucherCode(store, 'client', response.reward.code, { id, at: AT }).body.voucher.id, response.reward.id);
  assert.equal(addVoucherCode(store, 'other', response.reward.code, { id, at: AT }).status, 400);
  store.orders.push({ ...store.orders[0], id: 'second' }); sync(store);
  assert.equal(submit(store, 'second').rewardStatus, 'cooldown');
  // A submitted cooldown response never becomes a deferred entitlement.
  assert.equal(submit(store, 'second', answers, time(7)).rewardStatus, 'cooldown');
  store.orders.push({ ...store.orders[0], id: 'third', issueWindowOpenedAt: time(7) }); sync(store, time(7));
  assert.equal(submit(store, 'third', { ...answers, fulfillmentStars: 1 }, time(7)).reward.valueMinor, 1500);
  assert.equal(store.vouchers.length, 2);
});

test('low stars offer an issue link only inside the live issue window; surveys never create remedies', () => {
  const store = setup(); sync(store);
  const result = submit(store, 'order', { ...answers, fulfillmentStars: 2, recommendScore: 0, improvementNote: '=unsafe cell' });
  assert.equal(result.needsFollowUp, true);
  assert.equal(result.reportProblem.path, '/orders/order/issues');
  assert.equal(publicSurvey(store, store.orders[0], time(1)).reportProblem, null);
  assert.equal(store.claims.length, 0); assert.equal(store.issues.length, 0);
  const report = surveyReport(store, new URLSearchParams());
  assert.equal(report.aggregates.nps, -100); assert.equal(report.aggregates.averages.fulfillmentStars, 2);
  assert.equal(surveyReport(store, new URLSearchParams('needsFollowUp=false')).total, 0);
  assert.match(surveyReport(store, new URLSearchParams('format=csv')).bytes.toString(), /'=unsafe cell/);
});

test('validation rejects malformed scores, tags and money before issuing anything', () => {
  for (const body of [null, [], {}, { ...answers, easeStars: 0 }, { ...answers, priceFeeling: 6 },
    { ...answers, expectedPriceMinor: 1.5 }, { ...answers, expectedPriceMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...answers, fulfillmentTags: ['invented'] }, { ...answers, recommendScore: 11 }, { ...answers, improvementNote: 'a'.repeat(2001) }]) {
    const store = setup(); sync(store);
    assert.throws(() => submit(store, 'order', body), { status: 400 }); assert.equal(store.vouchers.length, 0);
  }
});

test('dismissal can reopen, missing optional scores stay out of NPS, and completed responses keep original facts', async () => {
  const { routeSurveys } = await import('../src/survey-routes.js');
  const store = setup(); sync(store);
  const call = () => routeSurveys({ store, user: { id: 'client', role: 'client' }, req: { method: 'POST' },
    url: new URL('http://test/orders/order/survey/dismiss'), id, now: () => AT });
  assert.equal((await call()).body.survey.status, 'open');
  assert.equal((await call()).mutated, false);
  submit(store);
  const report = surveyReport(store, new URLSearchParams());
  assert.equal(report.aggregates.nps, null); assert.equal(report.aggregates.counts.recommendScore, 0);
  const original = structuredClone(store.orderSurveys[0]);
  store.orders[0].issueWindowOpenedAt = time(1);
  sync(store, time(1));
  assert.deepEqual(store.orderSurveys[0], original);
  assert.equal(submit(store, 'order', { ...answers, easeStars: 1 }, time(10)).answers.easeStars, 4);
});

test('new handovers do not open in advance; NPS uses only answered recommendation scores across all filtered rows', () => {
  const store = setup();
  store.orders[0].issueWindowOpenedAt = time(1);
  assert.equal(sync(store), false); assert.equal(publicSurvey(store, store.orders[0], AT), null);
  sync(store, time(1)); submit(store, 'order', { ...answers, recommendScore: 10 }, time(1));
  for (const [orderId, score] of [['passive', 8], ['detractor', 0], ['missing', null]]) {
    store.orders.push({ ...store.orders[0], id: orderId }); sync(store, time(1));
    submit(store, orderId, { ...answers, recommendScore: score }, time(1));
  }
  const report = surveyReport(store, new URLSearchParams('limit=1'));
  assert.equal(report.total, 4); assert.equal(report.aggregates.nps, 0);
  assert.equal(report.aggregates.promoters, 1); assert.equal(report.aggregates.passives, 1); assert.equal(report.aggregates.detractors, 1);
  assert.equal(report.aggregates.counts.recommendScore, 3);
  assert.equal(surveyReport(store, new URLSearchParams('recommendScore=10')).aggregates.nps, 100);
  assert.equal(surveyReport(store, new URLSearchParams('fulfillmentKind=pickup')).aggregates.nps, null);
});
