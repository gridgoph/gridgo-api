import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DB = process.env.DATABASE_URL;
const answers = { fulfillmentStars: 4, easeStars: 4, priceFeeling: 4, expectedPriceMinor: 9000,
  directShopComparison: 'more_expensive', priceWorthTags: ['door_delivery', 'quality_check'], orderAgainAtPrice: 'maybe' };
async function setup(db) {
  assert.match(new URL(DB).pathname, /(?:_|-)test(?:_|$)/);
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns RESTART IDENTITY CASCADE');
  const store = fixture(), at = new Date().toISOString();
  store.surveyLaunchedAt = (await db.query('SELECT launched_at FROM survey_launch')).rows[0].launched_at;
  Object.assign(store.orders[0], { state: 'issue_window_open', issueWindowOpenedAt: at,
    issueWindowExpiresAt: new Date(Date.parse(at) + 86400000).toISOString() });
  store.carts.push({ id: 'cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard', fulfillmentMode: 'delivery',
    defaultDropoff: { lat: 7.07, lng: 125.61, label: 'Home' }, createdAt: at, updatedAt: at });
  store.cartLines.push({ id: 'cline', cartId: 'cart', supplierId: 'supplier', catalogItemId: 'item_supplier', optionIds: [], quantity: 10,
    structuredSpec: {}, sortOrder: 0, createdAt: at, updatedAt: at });
  await db.transaction(() => saveStore(db, store));
}

test('HTTP pricing survey answers, the weekly checkout exit question and Admin results persist in PostgreSQL', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await setup(db);
  const api = await apiForTest(t);

  // Tester rewards now require opening tracking as well as the existing order facts.
  assert.equal((await api('client', 'POST', '/orders/order/tester-tracking', {})).status, 200);
  const survey = await api('client', 'POST', '/orders/order/survey', answers);
  assert.equal(survey.status, 200, JSON.stringify(survey.body));
  assert.equal(survey.body.survey.reward.valueMinor, 1500);
  assert.deepEqual(survey.body.survey.answers.priceWorthTags, ['door_delivery', 'quality_check']);
  assert.equal((await api('client', 'POST', '/orders/order/survey', { ...answers, orderAgainAtPrice: 'bad' })).body.survey.answers.orderAgainAtPrice, 'maybe');
  const row = (await db.query('SELECT direct_shop_comparison, price_worth_tags, order_again_at_price FROM order_surveys')).rows[0];
  assert.deepEqual(row, { direct_shop_comparison: 'more_expensive', price_worth_tags: ['door_delivery', 'quality_check'], order_again_at_price: 'maybe' });
  await assert.rejects(db.query("UPDATE order_surveys SET order_again_at_price='no'"), /immutable/);

  assert.equal((await api('supplier', 'POST', '/me/carts/cart/checkout-visit', {})).status, 403);
  assert.equal((await api('other', 'POST', '/me/carts/cart/checkout-visit', {})).status, 404);
  const visit = await api('client', 'POST', '/me/carts/cart/checkout-visit', {});
  assert.equal(visit.status, 200, JSON.stringify(visit.body));
  const cartTotalMinor = (await db.query('SELECT cart_total_minor FROM checkout_visits')).rows[0].cart_total_minor;
  assert.ok(Number.isSafeInteger(cartTotalMinor) && cartTotalMinor > 0);
  assert.equal((await api('client', 'POST', '/me/checkout-exit-feedback/prompt', {})).body.prompt, null);
  // The hour that separates paying in another app from leaving has passed.
  await db.query("UPDATE checkout_visits SET first_reached_at=first_reached_at - interval '2 hours', last_reached_at=last_reached_at - interval '2 hours'");
  const claimed = await api('client', 'POST', '/me/checkout-exit-feedback/prompt', {});
  assert.equal(claimed.status, 200); assert.equal(claimed.body.prompt.status, 'unanswered');
  assert.match(claimed.headers.get('cache-control'), /no-store/);
  const second = await api('client', 'POST', '/me/checkout-exit-feedback/prompt', {});
  assert.equal(second.body.prompt, null); assert.equal(second.body.nextEligibleAt, claimed.body.nextEligibleAt);
  const path = `/me/checkout-exit-feedback/${claimed.body.prompt.id}`;
  assert.equal((await api('other', 'POST', path, { skip: true })).status, 404);
  assert.equal((await api('client', 'POST', path, { reason: 'other' })).body.error, 'invalid_checkout_exit_note');
  const answered = await api('client', 'POST', path, { reason: 'delivery_cost_or_time' });
  assert.equal(answered.status, 200); assert.equal(answered.body.prompt.reason, 'delivery_cost_or_time');
  assert.equal((await api('client', 'POST', path, { skip: true })).body.prompt.status, 'answered');

  for (const actor of ['client', 'ops']) {
    assert.equal((await api(actor, 'GET', '/admin/pricing-feedback')).status, 403);
    assert.equal((await api(actor, 'GET', '/admin/checkout-exit-feedback?format=csv')).status, 403);
  }
  const report = await api('admin', 'GET', '/admin/pricing-feedback?accountType=individual&categoryCode=marketing_collateral');
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.survey.responses, 1); assert.equal(report.body.checkoutExit.answered, 1);
  assert.equal(report.body.checkoutExit.reasons.options.find(o => o.code === 'delivery_cost_or_time').percent, 100);
  assert.equal((await api('admin', 'GET', '/admin/pricing-feedback?orderSize=20000_and_up')).body.survey.responses, 0);
  assert.equal((await api('admin', 'GET', '/admin/pricing-feedback?orderSize=nope')).status, 400);
  const exported = await api('admin', 'GET', '/admin/pricing-feedback?format=csv', null, { raw: true });
  assert.match(exported.headers.get('content-disposition'), /pricing-feedback\.csv/);
  assert.ok(exported.body.includes('"survey","directShopComparison","more_expensive","1","100","1"'));
  const list = await api('admin', 'GET', '/admin/checkout-exit-feedback?reason=delivery_cost_or_time');
  assert.equal(list.body.total, 1); assert.equal(list.body.prompts[0].cartTotalMinor, cartTotalMinor);

  // The database itself keeps the history immutable and the question at most weekly.
  await assert.rejects(db.query("UPDATE checkout_exit_prompts SET reason='just_browsing'"), /immutable/);
  await assert.rejects(db.query('DELETE FROM checkout_exit_prompts'), /immutable/);
  await assert.rejects(db.query(`INSERT INTO checkout_exit_prompts(id,client_id,cart_id,reached_at,asked_at)
    VALUES ('bypass','client','cart',now(),now() + interval '6 days')`), /cooldown/);
  await assert.rejects(db.query(`INSERT INTO checkout_exit_prompts(id,client_id,cart_id,reached_at,asked_at,answered_at,reason)
    VALUES ('bad-other','other','cart',now(),now(),now(),'other')`), /check constraint/);
  const store = await loadStore(db);
  assert.equal(store.checkoutExitPrompts.length, 1); assert.equal(store.vouchers.length, 1, 'the exit question never rewards');
});
