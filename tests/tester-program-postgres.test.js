import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
const DB = process.env.DATABASE_URL;
const answers = { fulfillmentStars: 5, easeStars: 4, priceFeeling: 3 };
async function setup(t) {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture(), at = new Date().toISOString();
  store.surveyLaunchedAt = (await db.query('SELECT launched_at FROM survey_launch')).rows[0].launched_at;
  // Two established client identities; operational fulfillment facts are test fixtures.
  for (const clientId of ['client', 'other']) {
    if (clientId === 'other') {
      store.orders.push({ ...structuredClone(store.orders[0]), id: 'other-order', clientId, issueWindowOpenedAt: at, state: 'issue_window_open', dropoff: { lat: 7.2, lng: 125.6, label: '99 Different Street Davao' } });
      store.orderLineItems.push({ ...structuredClone(store.orderLineItems[0]), id: 'other-line', orderId: 'other-order', jobId: null });
    }
  }
  store.orders[0].issueWindowOpenedAt = at; store.orders[0].state = 'issue_window_open';
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t) };
}
async function ok(api, actor, method, path, body = {}) {
  const r = await api(actor, method, path, body); assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`); return r.body;
}
async function setting(api, values, actor = 'admin') {
  const current = await api('admin', 'GET', '/settings');
  return api(actor, 'PATCH', '/settings', { expectedVersion: current.body.version, reason: 'Tester integration validation', ...values });
}
test('real HTTP: client isolation, attribution, tracking, two referral vouchers, staff reads and audited void', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  assert.equal((await api(null, 'GET', '/me/founding-tester')).status, 401);
  for (const role of ['supplier', 'rider', 'ops', 'admin']) assert.equal((await api(role, 'POST', '/orders/order/tester-tracking', {})).status, 403);
  assert.equal((await api('other', 'POST', '/orders/order/tester-tracking', {})).status, 404);
  assert.equal((await api('client', 'POST', '/me/founding-tester/installation', { installationId: 'bad' })).status, 400);
  assert.equal((await setting(api, { testerMonthlyBudgetMinor: 15000 }, 'ops')).status, 403);
  for (const value of [-1, 1.5, '1500', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await setting(api, { testerMonthlyBudgetMinor: value })).status, 400);
  for (const value of ['http://form.test/?code={code}', 'https://form.test/', 'https://{code}.test/', 'https://user:pass@form.test/?code={code}']) {
    assert.equal((await setting(api, { testerSignupFormUrlTemplate: value })).status, 400);
  }
  assert.equal((await setting(api, { testerSignupFormUrlTemplate: 'https://forms.example.test/join?entry.123={code}', testerMonthlyBudgetMinor: null })).status, 200);
  const invite = await ok(api, 'client', 'POST', '/me/founding-tester/invite', { installationId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(invite.invites.link, `https://forms.example.test/join?entry.123=${invite.invites.code}`);
  const untrusted = await api('client', 'POST', '/ops/tester-invites', { code: invite.invites.code, email: 'other@example.invalid' });
  assert.equal(untrusted.status, 403);
  await ok(api, 'ops', 'POST', '/ops/tester-invites', { code: invite.invites.code, email: 'OTHER@example.invalid' });
  await ok(api, 'ops', 'POST', '/ops/tester-invites', { code: invite.invites.code, email: 'missing@example.invalid' });
  const unmatched = await ok(api, 'ops', 'GET', '/ops/tester-invites?status=unmatched', null);
  assert.equal(unmatched.total, 1); assert.equal(unmatched.invites[0].unmatchedReason, 'no_client_account');
  assert.equal((await api('client', 'GET', '/ops/tester-rewards')).status, 403);
  const before = await ok(api, 'other', 'GET', '/me/founding-tester', null);
  assert.deepEqual(before.foundingTester.missions, { added: true, placed: true, tracked: false, received: true, rated: false });
  const track = await ok(api, 'other', 'POST', '/orders/other-order/tester-tracking', { installationId: '00000000-0000-4000-8000-000000000002' });
  assert.equal(track.foundingTester.completedCount, 4);
  const replies = await Promise.all([api('other', 'POST', '/orders/other-order/survey', answers), api('other', 'POST', '/orders/other-order/survey', answers)]);
  assert.ok(replies.every(r => r.status === 200), JSON.stringify(replies));
  const wallet = await ok(api, 'other', 'GET', '/me/vouchers?tab=all', null);
  assert.equal(wallet.vouchers.length, 2);
  const self = await ok(api, 'client', 'GET', '/me/founding-tester', null);
  assert.deepEqual({ invited: self.invites.invited, joined: self.invites.joined, completed: self.invites.completed }, { invited: 2, joined: 1, completed: 1 });
  const rewards = await ok(api, 'ops', 'GET', '/ops/tester-rewards', null);
  assert.equal(rewards.budget.usedMinor, 4500); assert.equal(rewards.rewards.length, 2);
  assert.ok(rewards.rewards.every(r => !('evidence' in r)));
  const reward = rewards.rewards.find(r => r.kind === 'referral');
  assert.equal(reward.checks.phone.status, 'missing'); assert.equal(reward.status, 'issued');
  assert.equal((await api('ops', 'POST', `/admin/tester-rewards/${reward.id}/void`, { reason: 'Review' })).status, 403);
  await ok(api, 'admin', 'POST', `/admin/tester-rewards/${reward.id}/void`, { reason: 'Review confirmed duplicate' });
  const stored = await loadStore(db);
  assert.equal(stored.vouchers.filter(v => v.status === 'void').length, 2);
  assert.ok(stored.auditLog.some(a => a.action === 'tester_reward.voided' && a.actorId === 'admin'));
  assert.equal((await api('admin', 'POST', `/admin/vouchers/${reward.voucherId}/reissue`, { reason: 'Try repeat' })).body.error, 'tester_reward_managed');
  assert.equal((await api('admin', 'POST', `/admin/voucher-campaigns/${stored.vouchers.find(v => v.id === reward.voucherId).campaignId}/issue`, { emails: ['client@example.invalid'] })).status, 409);
  await assert.rejects(db.query("UPDATE tester_installations SET installation_id='00000000-0000-4000-8000-000000000099'"), /append-only/);
  await assert.rejects(db.query('DELETE FROM tester_rewards'), /immutable/);
  await assert.rejects(db.query("UPDATE tester_rewards SET status='paused' WHERE status='voided'"), /immutable/);
  assert.equal((await ok(api, 'other', 'GET', '/me/founding-tester', null)).foundingTester.completedCount, 5);
});
test('real HTTP: positive device block, budget pause, explicit resume and eligibility boundary', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  const installationId = '00000000-0000-4000-8000-000000000001';
  const invite = await ok(api, 'client', 'POST', '/me/founding-tester/invite', { installationId });
  await ok(api, 'ops', 'POST', '/ops/tester-invites', { code: invite.invites.code, email: 'other@example.invalid' });
  await ok(api, 'other', 'POST', '/orders/other-order/tester-tracking', { installationId });
  await ok(api, 'other', 'POST', '/orders/other-order/survey', answers);
  const blocked = (await ok(api, 'ops', 'GET', '/ops/tester-rewards?status=blocked', null)).rewards[0];
  assert.equal(blocked.reason, 'same_device');
  assert.equal((await loadStore(db)).vouchers.length, 1, 'only the independent mission reward');
  assert.equal((await api('admin', 'POST', `/admin/tester-rewards/${blocked.id}/resume`, { reason: 'Cannot bypass' })).status, 409);
  assert.equal((await setting(api, { testerMonthlyBudgetMinor: 1500 })).status, 200);
  await ok(api, 'client', 'POST', '/orders/order/tester-tracking');
  await ok(api, 'client', 'POST', '/orders/order/survey', answers);
  const paused = (await ok(api, 'ops', 'GET', '/ops/tester-rewards?status=paused', null)).rewards[0];
  assert.equal(paused.clientId, 'client');
  assert.equal((await setting(api, { testerMonthlyBudgetMinor: 3000 })).status, 200);
  await ok(api, 'client', 'GET', '/auth/me/client', null);
  assert.equal((await loadStore(db)).vouchers.length, 1);
  const resumed = await ok(api, 'admin', 'POST', `/admin/tester-rewards/${paused.id}/resume`, { reason: 'Approved budget' });
  assert.equal(resumed.reward.status, 'issued'); assert.equal(resumed.budget.usedMinor, 3000);
  assert.equal((await setting(api, { foundingTesterLaunchAt: '2020-01-01T00:00:00.000Z' })).status, 200);
  assert.equal((await ok(api, 'client', 'GET', '/me/founding-tester', null)).foundingTester.label, 'Founding Tester');
});

test('unrelated settings writes and staff invite ingestion never bulk-award completed accounts', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  const { submitSurvey } = await import('../src/surveys.js');
  await db.transaction(async () => {
    const s = await loadStore(db), at = new Date().toISOString();
    for (const order of s.orders) submitSurvey(s, order, answers, { id, at });
    s.testerTracking = s.orders.map(o => ({ clientId: o.clientId, orderId: o.id, createdAt: at }));
    assert.equal(s.vouchers.length, 0);
    await saveStore(db, s);
  });
  assert.equal((await setting(api, { testerMonthlyBudgetMinor: null })).status, 200);
  assert.equal((await loadStore(db)).vouchers.length, 0, 'a settings save must not treat every survey as newly submitted');
  await ok(api, 'other', 'GET', '/auth/me/client', null);
  const s = await loadStore(db);
  assert.equal(s.vouchers.length, 1); assert.equal(s.vouchers[0].clientId, 'other');
});
