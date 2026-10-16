import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { FUNNEL_DAILY_LIMIT, FUNNEL_BURST, pricingDashboard } from '../src/pricing-dashboard.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DB = process.env.DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;

async function setup(db) {
  assert.match(new URL(DB).pathname, /(?:_|-)test(?:_|$)/);
  await resetDatabase(db, 'TRUNCATE users, platform_settings, funnel_events RESTART IDENTITY CASCADE');
  const store = fixture(), at = new Date().toISOString();
  Object.assign(store.orders[0], { state: 'needs_qa', updatedAt: at,
    fileCheck: { status: 'pending', requestedAt: at, reviewedAt: null, reviewedBy: null, reason: null } });
  await db.transaction(() => saveStore(db, store));
}

test('HTTP funnel events dedupe and cap per client, and the pricing dashboard is bounded and aggregated in SQL', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await setup(db);
  const api = await apiForTest(t);
  const count = async () => (await db.query('SELECT count(*)::int AS n FROM funnel_events')).rows[0].n;

  assert.equal((await api('ops', 'POST', '/funnel-events', { kind: 'paid' })).status, 403);
  const first = await api('client', 'POST', '/funnel-events', { kind: 'product_viewed', productCode: 'flyers' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const twin = await api('client', 'POST', '/funnel-events', { kind: 'product_viewed', productCode: 'flyers' });
  assert.equal(twin.status, 200);
  assert.deepEqual(twin.body, { id: first.body.id, at: first.body.at, duplicate: true });
  assert.equal((await api('client', 'POST', '/funnel-events', { kind: 'product_viewed', productCode: 'posters' })).status, 201);
  assert.equal((await api('client', 'POST', '/funnel-events', [{ kind: 'paid' }])).body.error, 'invalid_funnel_event');
  const huge = await api('client', 'POST', '/funnel-events', { kind: 'checkout_left', exitAnswer: 'x'.repeat(4000) });
  assert.deepEqual([huge.status, huge.body.error], [413, 'funnel_event_too_large']);
  assert.equal(await count(), 2);
  await db.query('DELETE FROM funnel_events');

  // A fixed past range, so every checkout is old enough to be settled either way.
  const from = new Date(Date.now() - 20 * DAY); from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 5 * DAY - 1);
  const shift = (ms) => new Date(from.getTime() + ms).toISOString();
  const rows = [
    ['e01', shift(-DAY), 'client', 'product_viewed', null, 'flyers', null],
    ['e02', shift(0), 'client', 'checkout_reached', 'order', null, null],
    ['e03', shift(2 * 3600e3), 'client', 'paid', 'order', null, null],
    ['e04', shift(DAY), 'client', 'checkout_reached', null, null, null],
    ['e05', shift(DAY + 3600e3), 'client', 'checkout_left', null, null, 'Too expensive'],
    ['e06', shift(DAY + 7200e3), 'client', 'checkout_left', null, null, 'Too expensive'],
    ['e07', shift(2 * DAY), 'other', 'checkout_left', null, null, 'Later'],
    ['e08', shift(2 * DAY), 'other', 'product_viewed', null, 'flyers', null],
    ['e09', new Date(to.getTime() - 3600e3).toISOString(), 'other', 'checkout_reached', null, null, null],
    ['e10', new Date(to.getTime() + 2 * 3600e3).toISOString(), 'other', 'paid', null, null, null],
    ['e11', shift(3 * DAY), 'client', 'listing_viewed', null, 'posters', null],
  ];
  for (const row of rows) {
    await db.query(`INSERT INTO funnel_events (id, at, client_id, kind, order_id, product_code, exit_answer)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, row);
  }
  const events = rows.map(([id, at, clientId, kind, orderId, productCode, exitAnswer]) =>
    ({ id, at, clientId, kind, orderId, listingId: null, productCode, exitAnswer }));
  const store = await db.transaction(() => loadStore(db));
  const day = (date) => date.toISOString().slice(0, 10);
  const compareTo = new Date(from.getTime() - 1);
  const compareFrom = new Date(compareTo.getTime() - 3 * DAY + 1);

  assert.equal((await api('ops', 'GET', '/admin/pricing')).status, 403);
  for (const filters of [{}, { accountType: 'individual' }, { accountType: 'business' }, { cohort: 'repeat' }, { cohort: 'new' }, { category: 'flyers' }]) {
    const query = { from: day(from), to: day(to), compareFrom: day(compareFrom), compareTo: day(compareTo), ...filters };
    const response = await api('admin', 'GET', `/admin/pricing?${new URLSearchParams(query)}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const expected = pricingDashboard({ events, orders: store.orders, users: store.users, lines: store.orderLineItems,
      catalog: store.catalogItems, query, now: new Date().toISOString() });
    assert.deepEqual(response.body.period.funnel, expected.period.funnel, JSON.stringify(filters));
    assert.deepEqual(response.body.compare.funnel, expected.compare.funnel, JSON.stringify(filters));
  }
  const all = (await api('admin', 'GET', `/admin/pricing?from=${day(from)}&to=${day(to)}`)).body.period.funnel;
  assert.deepEqual(all.counts, { product_viewed: 1, listing_viewed: 1, checkout_reached: 3, paid: 1, checkout_left: 3 });
  assert.deepEqual([all.reached, all.paidInTime, all.dropOff], [3, 2, 1], 'a payment within 24 hours after the range still clears its checkout');
  assert.deepEqual(all.exitQuestion.answers, [{ answer: 'Too expensive', count: 2 }, { answer: 'Later', count: 1 }]);

  const recent = await api('admin', 'GET', '/admin/pricing');
  assert.equal(recent.status, 200);
  const windowStart = new Date(Date.parse(recent.body.range.to) - 29 * DAY); windowStart.setUTCHours(0, 0, 0, 0);
  assert.equal(recent.body.range.from, windowStart.toISOString(), 'no dates means the last 30 days');
  assert.equal(recent.body.period.funnel.counts.checkout_reached, 3, 'events 20 days old are inside the default window');
  const tooLong = await api('admin', 'GET', '/admin/pricing?from=2024-01-01&to=2026-01-01');
  assert.deepEqual([tooLong.status, tooLong.body.error], [400, 'pricing_range_too_long']);
  assert.equal((await api('admin', 'GET', '/admin/pricing?compareFrom=2026-01-01')).body.error, 'invalid_pricing_range');

  // The daily cap is read from stored rows, so it survives a restart.
  await db.query(`INSERT INTO funnel_events (id, at, client_id, kind, product_code)
    SELECT 'cap_' || n, now() - interval '1 hour', 'client', 'product_viewed', 'p' || n FROM generate_series(1, $1) n`, [FUNNEL_DAILY_LIMIT]);
  const capped = await api('client', 'POST', '/funnel-events', { kind: 'paid' });
  assert.deepEqual([capped.status, capped.body.error], [429, 'funnel_event_daily_limit']);

  let refused = null;
  for (let n = 0; n <= FUNNEL_BURST.limit && !refused; n++) {
    const response = await api('other', 'POST', '/funnel-events', { kind: 'listing_viewed', listingId: `l${n}` });
    if (response.status === 429) refused = { n, error: response.body.error };
    else assert.equal(response.status, 201);
  }
  assert.deepEqual(refused, { n: FUNNEL_BURST.limit, error: 'too_many_funnel_events' });
});

test('HTTP QA checkbox audits record each change of state, not each repeated tick', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await setup(db);
  const api = await apiForTest(t);
  const ticks = async () => (await db.query(
    "SELECT data->'detail'->>'checkId' AS check, data->'detail'->>'checked' AS checked FROM audit_log WHERE action = 'order.qa_tick' ORDER BY at, id")).rows;

  const tick = (checkId, checked) => api('ops', 'POST', '/orders/order/qa-checks', { checkId, checked });
  assert.equal((await tick('artwork', false)).body.recorded, false, 'every check starts unticked');
  assert.equal((await tick('artwork', true)).body.recorded, true);
  const repeat = await tick('artwork', true);
  assert.deepEqual([repeat.status, repeat.body.recorded, repeat.body.checked], [200, false, true]);
  assert.equal((await tick('spec', true)).body.recorded, true);
  assert.equal((await tick('artwork', false)).body.recorded, true);
  assert.equal((await tick('artwork', false)).body.recorded, false);
  assert.deepEqual(await ticks(), [
    { check: 'artwork', checked: 'true' }, { check: 'spec', checked: 'true' }, { check: 'artwork', checked: 'false' },
  ]);
  assert.equal((await tick('nope', true)).body.error, 'invalid_qa_check');
});
