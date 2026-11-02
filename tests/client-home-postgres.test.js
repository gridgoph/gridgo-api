import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, id } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, loadStore, saveStore } from '../src/postgres-store.js';

const DB = process.env.DATABASE_URL;
const FIRSTMATE = 'client-home-firstmate-token';

async function setup(t) {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, issue_reports, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  await db.transaction(() => saveStore(db, store));
  return { db, api: await apiForTest(t, { FIRSTMATE_TRACKER_TOKEN: FIRSTMATE }) };
}
async function ok(api, actor, method, path, body = {}) {
  const r = await api(actor, method, path, body); assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`); return r.body;
}
async function setting(api, values) {
  const current = await api('admin', 'GET', '/settings');
  const r = await api('admin', 'PATCH', '/settings', { expectedVersion: current.body.version, reason: 'Client home validation', ...values });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function file(api, actor, issue) {
  const r = await api(actor, 'POST', '/issue-reports', { issue, category: 'bug' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

test('theme preference: default system, saved by the client, visible on /me and /auth/me/client', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  assert.equal((await ok(api, 'client', 'GET', '/auth/me/client', null)).clientProfile.themePreference, 'system');
  assert.equal((await ok(api, 'client', 'GET', '/me', null)).user.themePreference, 'system');
  assert.equal((await api(null, 'PATCH', '/me/theme', { themePreference: 'dark' })).status, 401);
  assert.equal((await api('supplier', 'PATCH', '/me/theme', { themePreference: 'dark' })).status, 403);
  for (const body of [{ themePreference: 'blue' }, { themePreference: null }, {}]) {
    const r = await api('client', 'PATCH', '/me/theme', body);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_theme_preference');
  }
  assert.equal((await api('client', 'PATCH', '/me/theme', { themePreference: 'dark', fontSize: 2 })).body.error, 'unexpected_field');
  assert.deepEqual(await ok(api, 'client', 'PATCH', '/me/theme', { themePreference: 'dark' }), { themePreference: 'dark' });
  assert.deepEqual(await ok(api, 'client', 'PATCH', '/me/theme', { themePreference: 'dark' }), { themePreference: 'dark' }, 'repeat is a no-op');
  assert.equal((await ok(api, 'client', 'GET', '/auth/me/client', null)).clientProfile.themePreference, 'dark');
  assert.equal((await ok(api, 'client', 'GET', '/me', null)).user.themePreference, 'dark');
  assert.equal((await ok(api, 'other', 'GET', '/me', null)).user.themePreference, 'system', 'per account');
  assert.equal((await db.query("SELECT theme_preference FROM client_profiles WHERE user_id = 'client'")).rows[0].theme_preference, 'dark');
  await assert.rejects(db.query("UPDATE client_profiles SET theme_preference = 'sepia' WHERE user_id = 'client'"), /client_profiles_theme_preference_check/);
});

test('home summary is a targeted read of the caller\'s own orders, missions and tester vouchers', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  assert.equal((await api(null, 'GET', '/me/home-summary', null)).status, 401);
  assert.equal((await api('supplier', 'GET', '/me/home-summary', null)).body.error, 'membership_required');
  let home = await ok(api, 'client', 'GET', '/me/home-summary', null);
  assert.equal(home.tile, 'missions');
  assert.deepEqual(home.activeOrder, { orderId: 'order', state: 'production', step: 2, stepKey: 'printing', stepCount: 4,
    fulfillmentMode: 'delivery', basketId: null, awaitingPayment: false, promisedAt: '2026-10-10T01:00:00.000Z',
    statusAt: home.activeOrder.statusAt, time: { kind: 'promised', at: '2026-10-10T01:00:00.000Z' } });
  assert.equal(home.activeOrderCount, 1);
  assert.equal(home.testerVoucher, null);
  assert.deepEqual(home.bugReport, { rewardAvailable: true, amountMinor: 1500 });
  assert.equal((await ok(api, 'other', 'GET', '/me/home-summary', null)).activeOrder, null, 'never another client\'s order');

  // Unrelated history does not enter the scoped graph.
  await db.transaction(async () => {
    const s = await loadStore(db);
    for (let n = 0; n < 20; n++) {
      s.orders.push({ ...structuredClone(s.orders[0]), id: `noise-${n}`, clientId: 'other' });
      s.notifications.push({ id: id('not'), userId: 'client', appRole: 'client', type: 'noise', title: 'n', body: 'n', at: new Date().toISOString(), read: false });
    }
    await saveStore(db, s);
  });
  const scoped = await loadHotReadStore(db, 'clerk_client', '/me/home-summary');
  assert.deepEqual(scoped.orders.map(o => o.id), ['order']);
  assert.equal(scoped.notifications.length, 0);
  assert.equal(scoped.auditLog.length, 0);
  assert.deepEqual(scoped.users.map(u => u.id), ['client']);

  await setting(api, { foundingTesterLaunchAt: '2020-01-01T00:00:00.000Z' });
  home = await ok(api, 'client', 'GET', '/me/home-summary', null);
  assert.equal(home.missions.eligible, false);
  assert.equal(home.tile, 'active_order');
  assert.equal(home.bugReport.rewardAvailable, false);
});

test('confirming a real bug grants a tester one PHP 15 voucher, once ever, idempotently and audited', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  const first = await file(api, 'client', 'Checkout button does nothing');
  const anonymous = await file(api, null, 'Landing page typo');
  assert.equal((await api('client', 'POST', '/issue-reports', { issue: 'x' }, { headers: { Authorization: 'Bearer not-a-session' } })).status, 401);
  assert.equal((await db.query('SELECT reporter_id FROM issue_reports WHERE id = $1', [first])).rows[0].reporter_id, 'client');
  assert.equal((await db.query('SELECT reporter_id FROM issue_reports WHERE id = $1', [anonymous])).rows[0].reporter_id, null);

  const before = await ok(api, 'ops', 'GET', `/ops/issue-reports/${first}`, null);
  assert.deepEqual(before.reporter, { id: 'client', name: 'client', tester: true, bugRewardAvailable: true });
  assert.equal(before.bugConfirmation, null);
  const firstmate = await api(null, 'GET', `/firstmate/issue-reports/${first}`, null, { headers: { Authorization: `Bearer ${FIRSTMATE}` } });
  assert.equal(firstmate.status, 200); assert.equal('reporter' in firstmate.body, false, 'reporter identity is staff-only');

  for (const actor of ['client', 'supplier', 'rider']) assert.equal((await api(actor, 'POST', `/ops/issue-reports/${first}/confirm-bug`, {})).status, 403);
  assert.equal((await api('ops', 'POST', '/ops/issue-reports/00000000-0000-4000-8000-000000000000/confirm-bug', {})).body.error, 'issue_report_not_found');

  // Concurrent confirmations of the same report: one reward, both succeed.
  const replies = await Promise.all([1, 2].map(() => api('ops', 'POST', `/ops/issue-reports/${first}/confirm-bug`, {})));
  assert.ok(replies.every(r => r.status === 200), JSON.stringify(replies.map(r => r.body)));
  const confirmed = replies[0].body;
  assert.equal(confirmed.bugConfirmation.voucherOutcome, 'granted');
  assert.equal(confirmed.bugConfirmation.voucherGranted, true);
  assert.equal(confirmed.bugConfirmation.confirmedBy.id, 'ops');
  assert.equal(confirmed.bugConfirmation.reward.status, 'issued');
  assert.equal(confirmed.bugConfirmation.reward.amountMinor, 1500);
  assert.deepEqual([confirmed.triage.validity, confirmed.triage.category], ['valid', 'bug']);
  assert.equal(confirmed.reporter.bugRewardAvailable, false);
  const repeat = await ok(api, 'admin', 'POST', `/ops/issue-reports/${first}/confirm-bug`, {});
  assert.deepEqual(repeat.bugConfirmation, confirmed.bugConfirmation, 'a retry changes nothing');

  let stored = await loadStore(db);
  const vouchers = stored.vouchers.filter(v => v.clientId === 'client');
  assert.equal(vouchers.length, 1); assert.equal(vouchers[0].valueMinor, 1500);
  assert.equal(stored.voucherCampaigns.find(c => c.id === vouchers[0].campaignId).purpose, 'tester_bug_report');
  assert.equal(stored.auditLog.filter(a => a.action === 'issue_report.bug_confirmed').length, 1);
  assert.ok(stored.auditLog.some(a => a.action === 'tester_reward.issued'));
  assert.ok(stored.notifications.some(n => n.userId === 'client' && n.type === 'voucher_issued'));
  const wallet = await ok(api, 'client', 'GET', '/me/vouchers?tab=all', null);
  assert.equal(wallet.vouchers[0].valueMinor, 1500);
  assert.equal((await ok(api, 'ops', 'GET', '/ops/tester-rewards?status=issued', null)).budget.usedMinor, 1500);
  const home = await ok(api, 'client', 'GET', '/me/home-summary', null);
  assert.equal(home.testerVoucher.kind, 'bug_report');
  assert.equal(home.bugReport.rewardAvailable, false);

  // A second real bug from the same tester is confirmed but earns nothing more.
  const second = await file(api, 'client', 'Map pin jumps');
  const again = await ok(api, 'ops', 'POST', `/ops/issue-reports/${second}/confirm-bug`, {});
  assert.equal(again.bugConfirmation.voucherOutcome, 'already_rewarded');
  assert.equal(again.bugConfirmation.voucherGranted, false);
  assert.equal(again.bugConfirmation.reward, null);
  assert.equal((await ok(api, 'ops', 'POST', `/ops/issue-reports/${anonymous}/confirm-bug`, {})).bugConfirmation.voucherOutcome, 'no_reporter');

  const spam = await file(api, 'other', 'Buy cheap followers');
  await ok(api, 'ops', 'PATCH', `/ops/issue-reports/${spam}`, { triage: { validity: 'spam' } });
  assert.equal((await api('ops', 'POST', `/ops/issue-reports/${spam}/confirm-bug`, {})).body.error, 'issue_report_not_confirmable');

  stored = await loadStore(db);
  assert.equal(stored.vouchers.filter(v => v.clientId === 'client').length, 1, 'never twice');
  // PostgreSQL enforces once per tester and an immutable confirmation.
  await assert.rejects(db.query(`INSERT INTO tester_rewards (id, kind, client_id, amount_minor, status, created_at)
    VALUES ('trwd_dup', 'bug_report', 'client', 1500, 'paused', now())`), /tester_rewards_kind_client_id_key/);
  await assert.rejects(db.query("UPDATE issue_reports SET bug_reward_outcome = 'not_tester', bug_reward_id = NULL WHERE id = $1", [first]), /immutable/);
  await assert.rejects(db.query('UPDATE issue_reports SET reporter_id = NULL WHERE id = $1', [second]), /reporter is immutable/);
  const reward = confirmed.bugConfirmation.reward.id;
  await assert.rejects(db.query("UPDATE issue_reports SET bug_confirmed_at = now(), bug_confirmed_by = 'ops', bug_reward_outcome = 'granted', bug_reward_id = $2 WHERE id = $1", [spam, reward]), /duplicate key|owner mismatch/);

  // A staff member who is also a client never confirms their own report.
  await db.query("INSERT INTO user_role_memberships (user_id, role, created_at) VALUES ('ops', 'client', now())");
  const own = await file(api, 'ops', 'Staff found this while testing as a client');
  const self = await api('ops', 'POST', `/ops/issue-reports/${own}/confirm-bug`, {});
  assert.equal(self.status, 403); assert.equal(self.body.error, 'issue_report_self_confirmation');
  await assert.rejects(db.query("UPDATE issue_reports SET bug_confirmed_at = now(), bug_confirmed_by = 'ops', bug_reward_outcome = 'not_tester' WHERE id = $1", [own]),
    /issue_reports_bug_self_confirmation_check/);
  assert.equal((await ok(api, 'admin', 'POST', `/ops/issue-reports/${own}/confirm-bug`, {})).bugConfirmation.confirmedBy.id, 'admin');
});

test('budget pause holds the bug-report voucher until Super Admin resumes it; non-testers earn none', { skip: !DB }, async t => {
  const { db, api } = await setup(t);
  await setting(api, { testerMonthlyBudgetMinor: 0 });
  const report = await file(api, 'other', 'Receipt total is wrong');
  const paused = await ok(api, 'ops', 'POST', `/ops/issue-reports/${report}/confirm-bug`, {});
  assert.equal(paused.bugConfirmation.voucherOutcome, 'paused');
  assert.equal(paused.bugConfirmation.voucherGranted, false);
  assert.equal(paused.bugConfirmation.reward.status, 'paused');
  assert.equal((await loadStore(db)).vouchers.length, 0);
  assert.equal((await ok(api, 'other', 'GET', '/me/home-summary', null)).bugReport.rewardAvailable, false, 'the entitlement exists');
  const rewardId = paused.bugConfirmation.reward.id;
  const still = await ok(api, 'admin', 'POST', `/admin/tester-rewards/${rewardId}/resume`, { reason: 'Budget still zero' });
  assert.equal(still.reward.status, 'paused');
  await setting(api, { testerMonthlyBudgetMinor: 1500 });
  const resumed = await ok(api, 'admin', 'POST', `/admin/tester-rewards/${rewardId}/resume`, { reason: 'Budget approved' });
  assert.equal(resumed.reward.status, 'issued');
  assert.equal(resumed.budget.usedMinor, 1500);
  const after = await ok(api, 'ops', 'GET', `/ops/issue-reports/${report}`, null);
  assert.equal(after.bugConfirmation.voucherOutcome, 'paused', 'the confirmation-time outcome is history');
  assert.equal(after.bugConfirmation.voucherGranted, true);

  await setting(api, { foundingTesterLaunchAt: '2020-01-01T00:00:00.000Z' });
  const late = await file(api, 'client', 'Signed up after launch');
  assert.equal((await ok(api, 'ops', 'GET', `/ops/issue-reports/${late}`, null)).reporter.tester, false);
  const confirmed = await ok(api, 'ops', 'POST', `/ops/issue-reports/${late}/confirm-bug`, {});
  assert.equal(confirmed.bugConfirmation.voucherOutcome, 'not_tester');
  assert.equal((await loadStore(db)).vouchers.filter(v => v.clientId === 'client').length, 0);
});
