import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadHotReadStore, loadClientBootstrapStore } from '../src/postgres-store.js';
import { testerBootstrapNeedsWrite } from '../src/client-bootstrap.js';
import { matchTesterInvites, reconcileTesterInvite } from '../src/tester-invites.js';
import { reconcilePromotionInvites } from '../src/promotions.js';
import { recordTesterCartStep, reconcileFoundingTester, publicFoundingTester } from '../src/founding-testers.js';
import { submitSurvey } from '../src/surveys.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const skip = !process.env.DATABASE_URL;
const at = new Date().toISOString();
function reconcile(store, clientId) {
  const ctx = { at, id };
  let changed = matchTesterInvites(store, ctx);
  changed = reconcilePromotionInvites(store, ctx) || changed;
  changed = recordTesterCartStep(store, clientId, at) || changed;
  changed = reconcileFoundingTester(store, clientId, ctx) || changed;
  return reconcileTesterInvite(store, clientId, ctx) || changed;
}
async function setup(db, edit = () => {}) {
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, promotion_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  for (const user of store.users) user.lastAuthenticatedAt = at;
  Object.assign(store.orders[0], { state: 'cancelled', cancelledAt: at, cancellationReason: 'Synthetic historical order' });
  store.foundingTesters = [{ clientId: 'client', addedAt: at }];
  store.surveyLaunchedAt = (await db.query('SELECT launched_at FROM survey_launch')).rows[0].launched_at;
  await edit(store);
  await db.transaction(() => saveStore(db, store));
}
async function graphPair(db) {
  return { full: await loadStore(db), scoped: await loadClientBootstrapStore(db, 'client') };
}
function instrument(db) {
  const queries = [];
  return { queries, db: { ...db, query: async (sql, values) => {
    const result = await db.query(sql, values); queries.push({ sql, rows: result.rowCount }); return result;
  } } };
}

test('client bootstrap graphs preserve progress, reward guards, invitation policy and history bounds', { skip }, async t => {
  const db = createDatabase(process.env); t.after(() => db.close());
  const check = async () => {
    const { full, scoped } = await graphPair(db);
    assert.deepEqual(publicFoundingTester(scoped, 'client', at), publicFoundingTester(full, 'client', at));
    const before = structuredClone(scoped);
    assert.equal(testerBootstrapNeedsWrite(scoped, 'client', { at }), reconcile(full, 'client'));
    assert.deepEqual(scoped, before, 'the probe cannot change its response graph');
    await assert.rejects(db.transaction(() => saveStore(db, scoped)), /read-only/);
    return scoped;
  };
  await t.test('no-op and preserved cart step use the existing guards', async () => {
    await setup(db); assert.equal(testerBootstrapNeedsWrite(await check(), 'client', { at }), false);
    await setup(db, store => { store.foundingTesters = []; });
    assert.equal(testerBootstrapNeedsWrite(await check(), 'client', { at }), true);
  });
  await t.test('unmatched invites retain self, missing, joined and Unicode email decisions', async () => {
    for (const email of ['missing@example.invalid', 'client@example.invalid', 'other@example.invalid', 'Üser@example.invalid']) {
      await setup(db, store => {
        if (email.startsWith('Ü')) store.users.find(u => u.id === 'other').email = '\u00a0üser@example.invalid\u00a0';
        store.testerInviteCodes = [{ clientId: 'client', code: 'CODE', createdAt: at }];
        store.testerInvites = [{ id: 'invite', inviterId: 'client', code: 'CODE', email: email.toLowerCase(), createdAt: at, unmatchedReason: 'no_client_account' }];
      });
      await check();
    }
  });
  await t.test('friend-pass matching uses active targets, existing attribution and settings', async () => {
    for (const target of ['client', 'other', 'supplier', 'missing']) {
      await setup(db, store => {
        store.promotionInvites = [{ id: 'friend', founderId: 'other', email: `${target}@example.invalid`, status: 'invited', createdAt: at, unmatchedReason: 'no_client_account' }];
      });
      await check();
    }
  });
  await t.test('completed missions and paused/issued awards keep their mutation decisions', async () => {
    for (const budget of [0, null]) {
      await setup(db, store => {
        Object.assign(store.orders[0], { state: 'issue_window_open', issueWindowOpenedAt: at });
        delete store.orders[0].cancelledAt;
        delete store.orders[0].cancellationReason;
        store.testerTracking = [{ clientId: 'client', orderId: 'order', createdAt: at }];
        store.settings.foundingTesterLaunchAt = '2026-01-01T00:00:00.000Z';
        submitSurvey(store, store.orders[0], { fulfillmentStars: 5, easeStars: 4, priceFeeling: 3 }, { id, at });
        // A historical cooldown response has no reusable survey entitlement.
        store.orderSurveys[0].rewardStatus = 'cooldown';
        store.orderSurveys[0].rewardVoucherId = null;
        store.settings.foundingTesterLaunchAt = null;
        store.settings.testerMonthlyBudgetMinor = budget;
      });
      await check();
      await db.transaction(async () => { const store = await loadStore(db); reconcile(store, 'client'); await saveStore(db, store); });
      assert.equal((await loadStore(db)).testerRewards.find(r => r.kind === 'mission').status, budget === 0 ? 'paused' : 'issued');
      assert.equal(testerBootstrapNeedsWrite(await check(), 'client', { at }), false);
    }
  });
  await t.test('tenfold unrelated history returns exactly the same graph and row count', async () => {
    await setup(db, store => store.deviceTokens.push({ id: 'history_device', userId: 'other', token: 'history_token', platform: 'android', createdAt: at, updatedAt: at }));
    async function read() { const traced = instrument(db); const store = await loadClientBootstrapStore(traced.db, 'client'); return { store, ...traced }; }
    const before = await read();
    for (const size of [100, 1000]) {
      await db.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data)
        SELECT 'history_'||i,'other','general',$1,i,'{}' FROM generate_series($2::int,$3::int) i`, [at, size === 100 ? 1 : 101, size]);
      await db.query(`INSERT INTO audit_log(id,at,action,position,data)
        SELECT 'history_'||i,$1,'test.history',i,'{}' FROM generate_series($2::int,$3::int) i`, [at, size === 100 ? 1 : 101, size]);
      await db.query(`INSERT INTO location_pings(id,order_id,rider_id,lat,lng,at,position)
        SELECT 'history_'||i,'order','rider',7,125,$1,i FROM generate_series($2::int,$3::int) i`, [at, size === 100 ? 1 : 101, size]);
      await db.query(`INSERT INTO notification_push_outbox(notification_id,device_id,user_id,status)
        SELECT 'history_'||i,'history_device','other','delivered' FROM generate_series($1::int,$2::int) i`, [size === 100 ? 1 : 101, size]);
      const after = await read();
      assert.deepEqual(after.store, before.store);
      assert.equal(after.queries.reduce((n, q) => n + q.rows, 0), before.queries.reduce((n, q) => n + q.rows, 0));
      assert.ok(!after.queries.some(q => /FROM (notifications|audit_log|location_pings|notification_push_outbox)\b/.test(q.sql)));
    }
    const hot = instrument(db); await loadHotReadStore(hot.db, 'clerk_client', '/auth/me');
    assert.ok(!hot.queries.some(q => /FROM (notifications|location_pings|notification_push_outbox)\b/.test(q.sql)));
  });
});

test('HTTP /me and both client auth bootstraps equal full-store responses for every role and denial', { skip }, async t => {
  const db = createDatabase(process.env); t.after(() => db.close()); await setup(db);
  const clerk = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); });
  clerk.listen(0, '127.0.0.1'); await once(clerk, 'listening'); t.after(() => new Promise(resolve => clerk.close(resolve)));
  const env = { NODE_ENV: 'test', NODE_OPTIONS: `--import=${new URL('./fixtures/client-bootstrap-hook.mjs', import.meta.url).href}`,
    GRIDGO_TEST_BOOTSTRAP_TIME: String(Date.parse(at)), CLERK_API_URL: `http://127.0.0.1:${clerk.address().port}` };
  const clockToken = api => (key, method, path, body, opts = {}) => api(key, method, path, body, { ...opts,
    claims: { iat: Math.floor(Date.parse(at) / 1000) - 5, nbf: Math.floor(Date.parse(at) / 1000) - 5, exp: Math.floor(Date.parse(at) / 1000) + 300 } });
  const full = clockToken(await apiForTest(t, { ...env, GRIDGO_TEST_BOOTSTRAP_FULL: '1' }));
  const scoped = clockToken(await apiForTest(t, env));
  for (const path of ['/me', '/auth/me/client', '/auth/me']) {
    for (const role of [null, 'client', 'other', 'supplier', 'rider', 'ops', 'admin', 'unmapped']) {
      for (const headers of [{}, { 'x-gridgo-role': 'client' }, { 'x-gridgo-role': 'invalid' }]) {
        const a = await full(role, 'GET', path, undefined, { headers });
        const b = await scoped(role, 'GET', path, undefined, { headers });
        assert.deepEqual({ status: b.status, body: b.body }, { status: a.status, body: a.body }, `${role} ${path} ${JSON.stringify(headers)}`);
        assert.equal(b.headers.get('cache-control'), a.headers.get('cache-control'));
      }
    }
  }
  for (const accountType of ['business', 'organization']) {
    await setup(db, store => {
      Object.assign(store.users.find(u => u.id === 'client'), { accountType, orgName: 'Campus Club' });
      Object.assign(store.clientProfiles.find(p => p.userId === 'client'), { clientKind: 'business', businessName: 'Campus Club', businessNature: 'Events' });
      store.userRoleMemberships.push({ userId: 'client', role: 'rider', createdAt: at });
      store.riderProfiles.push({ userId: 'client', vehicleType: 'bicycle', plateNumber: 'TEST', licenseNumber: null, updatedAt: at });
      if (accountType === 'organization') store.organizationAccounts.push({ userId: 'client', nameKey: 'campus club', schoolKey: 'school', name: 'Campus Club', school: 'School', email: 'club@example.invalid',
        currentOfficer: { id: 'officer', fullName: 'Officer', verifiedAt: at }, history: [] });
    });
    for (const path of ['/me', '/auth/me/client', '/auth/me']) {
      const a = await full('client', 'GET', path), b = await scoped('client', 'GET', path);
      assert.deepEqual({ status: b.status, body: b.body }, { status: a.status, body: a.body }, `${accountType} ${path}`);
    }
  }
  await setup(db, store => {
    Object.assign(store.orders[0], { state: 'issue_window_open', issueWindowOpenedAt: at });
    delete store.orders[0].cancelledAt; delete store.orders[0].cancellationReason;
    store.testerTracking = [{ clientId: 'client', orderId: 'order', createdAt: at }];
    store.settings.foundingTesterLaunchAt = '2026-01-01T00:00:00.000Z';
    submitSurvey(store, store.orders[0], { fulfillmentStars: 5, easeStars: 4, priceFeeling: 3 }, { id, at });
    store.settings.foundingTesterLaunchAt = null;
    reconcile(store, 'client');
  });
  for (const path of ['/me', '/auth/me/client', '/auth/me']) {
    const a = await full('client', 'GET', path), b = await scoped('client', 'GET', path);
    assert.deepEqual({ status: b.status, body: b.body }, { status: a.status, body: a.body }, `awarded ${path}`);
  }
  await db.query("UPDATE users SET account_status = 'suspended', account_status_reason = 'Test suspension', account_status_at = $1, account_status_by = 'admin' WHERE id = 'client'", [at]);
  for (const path of ['/me', '/auth/me/client', '/auth/me']) {
    const a = await full('client', 'GET', path), b = await scoped('client', 'GET', path);
    assert.deepEqual({ status: b.status, body: b.body }, { status: a.status, body: a.body });
  }
});
