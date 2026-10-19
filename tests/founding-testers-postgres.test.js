import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { syncSurveys, submitSurvey } from '../src/surveys.js';
import { reconcileFoundingTester, remindFoundingTesters } from '../src/founding-testers.js';

const DB = process.env.DATABASE_URL;
const answers = { fulfillmentStars: 5, easeStars: 4, priceFeeling: 3 };
async function setup(db) {
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(), at = new Date().toISOString();
  store.surveyLaunchedAt = (await db.query('SELECT launched_at FROM survey_launch')).rows[0].launched_at;
  Object.assign(store.orders[0], { state: 'issue_window_open', issueWindowOpenedAt: at });
  await db.transaction(() => saveStore(db, store));
  return at;
}

test('concurrent submissions issue one tester entitlement; SQL immutability, ownership and rollback hold', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close()); const at = await setup(db);
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'second' });
    await saveStore(db, store);
  });
  const submit = (orderId = 'order') => db.transaction(async () => {
    const store = await loadStore(db);
    const result = submitSurvey(store, store.orders.find(o => o.id === orderId), answers, { id, at });
    await saveStore(db, store); return result;
  });
  const [a, b, c] = await Promise.all([submit(), submit(), submit('second')]);
  assert.equal(a.reward.id, c.reward.id);
  assert.equal(a.reward.id, b.reward.id); assert.equal(a.rewardStatus, 'founding_tester');
  const stored = await loadStore(db);
  assert.equal(stored.foundingTesters.length, 1); assert.equal(stored.vouchers.length, 1);
  assert.equal(stored.voucherLedger.filter(e => e.kind === 'issued').length, 1);
  await assert.rejects(db.query("UPDATE founding_testers SET awarded_at=awarded_at + interval '1 second'"), /immutable/);
  await assert.rejects(db.query('DELETE FROM founding_testers'), /immutable/);
  await assert.rejects(db.query("INSERT INTO founding_testers(client_id,awarded_at,reward_voucher_id) SELECT 'other',awarded_at,reward_voucher_id FROM founding_testers"), /invalid tester reward/);
  await setup(db);
  await assert.rejects(db.transaction(async () => {
    const store = await loadStore(db); submitSurvey(store, store.orders[0], answers, { id, at: new Date().toISOString() });
    await saveStore(db, store); throw new Error('rollback tester');
  }), /rollback tester/);
  assert.equal((await db.query('SELECT * FROM founding_testers')).rowCount, 0);
  assert.equal((await db.query('SELECT * FROM vouchers')).rowCount, 0);
});

test('HTTP profiles, staff directory/filter, dashboard, settings gates and wallet share the same award', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close()); await setup(db);
  const api = await apiForTest(t);
  assert.equal((await api(null, 'GET', '/me')).status, 401);
  const first = await api('client', 'GET', '/auth/me/client');
  assert.equal(first.status, 200); assert.equal(first.body.clientProfile.foundingTester.completedCount, 2);
  const submitted = await api('client', 'POST', '/orders/order/survey', answers);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const reward = submitted.body.survey.reward;
  assert.equal((await api('client', 'GET', '/auth/me/client')).body.clientProfile.foundingTester.reward.id, reward.id);
  assert.equal((await api('client', 'GET', '/me')).body.user.foundingTester.label, 'Founding Tester');
  const filtered = await api('ops', 'GET', '/users?role=client&foundingTester=true');
  assert.deepEqual(filtered.body.users.map(u => u.id), ['client']); assert.equal(filtered.body.users[0].foundingTester, true);
  assert.equal((await api('ops', 'GET', '/users?foundingTester=maybe')).status, 400);
  assert.equal((await api('client', 'GET', '/users?foundingTester=true')).status, 403);
  const dashboard = await api('ops', 'GET', '/ops/founding-testers');
  assert.equal(dashboard.body.clients.find(c => c.clientId === 'client').foundingTester.reward.id, reward.id);
  for (const actor of ['client', 'supplier', 'rider']) assert.equal((await api(actor, 'GET', '/ops/founding-testers')).status, 403);
  for (const role of ['supplier', 'rider']) {
    assert.equal(JSON.stringify((await api(role, 'GET', `/auth/me/${role}`)).body).includes('foundingTester'), false);
    assert.equal((await api('ops', 'GET', `/users?role=${role}`)).body.users.some(u => 'foundingTester' in u), false);
  }
  const settings = await api('admin', 'GET', '/settings');
  const patch = { expectedVersion: settings.body.version, reason: 'Set tester launch', foundingTesterLaunchAt: '2026-01-01T00:00:00.000Z' };
  assert.equal((await api('ops', 'PATCH', '/settings', patch)).status, 403);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...patch, expectedVersion: -1 })).status, 409);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...patch, foundingTesterLaunchAt: 'invalid' })).status, 400);
  assert.equal((await api('admin', 'PATCH', '/settings', patch)).status, 200);
  assert.equal((await api('other', 'GET', '/auth/me/client')).body.clientProfile.foundingTester.eligible, false);
  assert.equal((await api('client', 'GET', '/auth/me/client')).body.clientProfile.foundingTester.label, 'Founding Tester');
  assert.equal((await api('admin', 'POST', `/admin/voucher-campaigns/${reward.campaignId}/issue`, { emails: ['other@example.invalid'] })).status, 409);
  const stored = await loadStore(db);
  assert.equal(stored.vouchers.length, 1);
  assert.ok(stored.auditLog.some(a => a.action === 'settings.operational_update' && a.detail.current.foundingTesterLaunchAt === patch.foundingTesterLaunchAt));
});

test('profile lazily awards historical completion once, reusing its survey voucher without a bulk sweep', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close()); const at = await setup(db);
  let rewardId;
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.settings.foundingTesterLaunchAt = '2026-01-01T00:00:00.000Z';
    rewardId = submitSurvey(store, store.orders[0], answers, { id, at }).reward.id;
    store.settings.foundingTesterLaunchAt = null; await saveStore(db, store);
  });
  const api = await apiForTest(t);
  assert.equal((await loadStore(db)).foundingTesters.some(f => f.awardedAt), false);
  const responses = await Promise.all([api('client', 'GET', '/auth/me/client'), api('client', 'GET', '/auth/me/client')]);
  for (const response of responses) {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.clientProfile.foundingTester.reward.id, rewardId);
    assert.equal(response.body.clientProfile.foundingTester.rewardStatus, 'existing_survey_reward');
  }
  const store = await loadStore(db); assert.equal(store.vouchers.length, 1);
  assert.equal(store.foundingTesters.filter(f => f.awardedAt).length, 1);
});

test('reminder markers survive reload and prohibit repeats; lifecycle queues inbox and push', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close()); const at = await setup(db);
  await db.transaction(async () => {
    const store = await loadStore(db);
    const user = store.users.find(u => u.id === 'other'); user.createdAt = new Date(Date.parse(at) - 2 * 86400000).toISOString();
    store.deviceTokens.push({ id: 'tester-token', userId: user.id, token: 'tester-reminder-token-1234567890', platform: 'android', appRole: 'client', tokenProvider: 'fcm', createdAt: at, updatedAt: at });
    await saveStore(db, store);
  });
  await apiForTest(t);
  let store;
  for (let n = 0; n < 100; n++) {
    store = await loadStore(db); if (store.foundingTesters.some(f => f.clientId === 'other' && f.reminded2At)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const notice = store.notifications.find(n => n.userId === 'other' && n.type === 'founding_tester_reminder');
  assert.ok(notice);
  assert.equal((await db.query('SELECT 1 FROM notification_push_outbox WHERE notification_id=$1', [notice.id])).rowCount, 1);
  await db.transaction(async () => {
    const current = await loadStore(db);
    assert.equal(remindFoundingTesters(current, { id, at }), false);
    assert.equal(remindFoundingTesters(current, { id, at: new Date(Date.parse(at) + 3 * 86400000).toISOString() }), true);
    await saveStore(db, current);
  });
  await assert.rejects(db.query("UPDATE founding_testers SET reminded_2_at=NULL WHERE client_id='other'"), /immutable/);
  store = await loadStore(db);
  assert.equal(remindFoundingTesters(store, { id, at: new Date(Date.parse(at) + 9 * 86400000).toISOString() }), false);
  assert.equal(store.notifications.filter(n => n.userId === 'other' && n.type === 'founding_tester_reminder').length, 2);
});


test('a recorded shop failure opens the existing HTTP survey and awards without a handover', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close()); const at = await setup(db);
  await db.transaction(async () => {
    const store = await loadStore(db), order = store.orders[0];
    order.issueWindowOpenedAt = null; order.state = 'production';
    order.shopFailureEvents = [{ id: 'failure', at, kind: 'cancelled', supplierId: 'supplier' }];
    await saveStore(db, store);
  });
  const api = await apiForTest(t);
  const before = await api('client', 'GET', '/orders/order/survey');
  assert.equal(before.status, 200); assert.equal(before.body.survey.status, 'open');
  const response = await api('client', 'POST', '/orders/order/survey', answers);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.survey.reward.valueMinor, 1500);
  const store = await loadStore(db);
  assert.equal(store.orders[0].state, 'production'); assert.equal(store.orders[0].issueWindowOpenedAt, undefined);
  assert.equal(store.foundingTesters.find(f => f.clientId === 'client').rewardVoucherId, response.body.survey.reward.id);
});
