import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { saveStore, loadStore } from '../src/postgres-store.js';
import { resolveAuthorizationContext } from '../src/authorization-context.js';
import { routeTesterProgram, manilaDate, shiftDate } from '../src/tester-program.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { resetDatabase } from './fixtures/reset-database.js';

const DB = process.env.DATABASE_URL;
const checked = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; };
async function setup(t) {
  const db = createDatabase({ DATABASE_URL: DB });
  t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE tester_program_settings, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t, { TZ: 'America/Los_Angeles' });
  const call = async (userId, method, path, body, at) => {
    const user = store.users.find(row => row.id === userId);
    resolveAuthorizationContext(store, user);
    return routeTesterProgram({ req: { method }, url: new URL(path, 'http://tester.invalid'), user, database: db,
      readBody: async () => body, now: () => at, auditEvent: async () => { throw new Error('Unexpected staff write in clock tests'); } });
  };
  const enroll = async (app = 'client', userId = app) => checked(await api('ops', 'POST', '/ops/testers', { app, email: `${userId}@example.invalid` }));
  return { db, store, api, call, enroll };
}
const checkin = (call, at, app = 'client', extra = {}) => call(app, 'POST', '/me/tester-program/check-in', { app, version: '1.2.3', source: 'open', ...extra }, at);
const state = (call, at, app = 'client') => call(app, 'GET', `/me/tester-program?app=${app}`, null, at);
const feedback = (call, at, event, trigger, app = 'client') => call(app, 'POST', '/me/tester-program/feedback', { app, event, trigger }, at);
async function startAt(db, at) {
  await db.query('UPDATE tester_program_enrollments SET added_at=$1', [at]);
}

test('Manila day boundaries ignore the phone timezone and supplied date; HTTP check-ins dedupe concurrently and preserve first facts', { skip: !DB }, async t => {
  const { db, api, call, enroll } = await setup(t);
  assert.equal(manilaDate('2026-10-01T15:59:59.999Z'), '2026-10-01');
  assert.equal(manilaDate('2026-10-01T16:00:00.000Z'), '2026-10-02');
  await enroll();
  const secondApi = await apiForTest(t, { TZ: 'Pacific/Honolulu' });
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? secondApi : api)('client', 'POST', '/me/tester-program/check-in', {
    app: 'client', version: '1.0.0', source: 'open', manilaDate: '1999-01-01', timeZone: 'America/Los_Angeles' })));
  for (const response of responses) assert.equal(checked(response).streak, 1);
  assert.equal((await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count, 1);
  const first = (await db.query('SELECT * FROM tester_program_checkins')).rows[0];
  checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'client', version: '2.0.0', source: 'button' }));
  const repeat = (await db.query('SELECT * FROM tester_program_checkins')).rows[0];
  assert.equal(repeat.version, '1.0.0'); assert.equal(repeat.source, 'open'); assert.equal(repeat.checked_in_at, first.checked_in_at);
  assert.ok(repeat.latest_seen_at >= first.latest_seen_at);
  assert.equal(first.manila_date, manilaDate(new Date()));
  await assert.rejects(db.query(`INSERT INTO tester_program_checkins SELECT 'duplicate',user_id,app,manila_date,version,source,checked_in_at,latest_seen_at FROM tester_program_checkins LIMIT 1`), /unique constraint/);
  await db.query('DELETE FROM tester_program_enrollment_days'); await db.query('DELETE FROM tester_program_checkins');
  await startAt(db, '2026-10-01T15:00:00Z');
  assert.equal(checked(await checkin(call, '2026-10-01T15:59:59.999Z')).manilaDate, '2026-10-01');
  const midnight = checked(await checkin(call, '2026-10-01T16:00:00.000Z'));
  assert.equal(midnight.manilaDate, '2026-10-02'); assert.equal(midnight.day, 2);
  assert.equal((await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count, 2);
});

test('a gap resets Day N, 14 straight days permanently complete a run, and Ops reads fourteen chronological boxes', { skip: !DB }, async t => {
  const { db, api, call, enroll } = await setup(t); await enroll();
  await startAt(db, '2026-10-01T00:00:00Z');
  checked(await checkin(call, '2026-10-01T00:00:00Z'));
  let s = checked(await state(call, '2026-10-02T00:00:00Z'));
  assert.equal(s.streak, 1); assert.equal(s.day, 2); assert.equal(s.checkedInToday, false);
  s = checked(await state(call, '2026-10-03T00:00:00Z')); assert.equal(s.streak, 0); assert.equal(s.day, 1);
  for (let n = 0; n < 14; n++) {
    s = checked(await checkin(call, `${shiftDate('2026-10-03', n)}T00:00:00Z`));
    assert.equal(s.streak, n + 1); assert.equal(s.day, n + 1); assert.equal(s.runComplete, n === 13);
  }
  assert.equal(s.stopped, true); assert.equal(s.nudge.trigger, 'streak_14');
  const count = (await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count;
  s = checked(await checkin(call, '2026-11-06T00:00:00Z'));
  assert.equal(s.streak, 14); assert.equal(s.stopped, true); assert.equal(s.checkedInToday, false);
  assert.equal((await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count, count);
  const dashboard = checked(await api('ops', 'GET', '/ops/testers?app=client'));
  assert.equal(dashboard.stats.fullStreak, 1); assert.equal(dashboard.stats.needed, 12);
  assert.equal(dashboard.testers[0].days.length, 14);
  assert.deepEqual(dashboard.testers[0].days.map(row => row.state), Array(14).fill('checked_in'));
  assert.equal(dashboard.testers[0].days[0].date, '2026-10-03');
  assert.equal(dashboard.testers[0].days.at(-1).date, '2026-10-16');
  assert.equal(dashboard.testers[0].stoppedCheckingIn, false);
});

test('production approval stops check-ins and nudges only for its app; settings are validated and audited', { skip: !DB }, async t => {
  const { db, api, call, enroll } = await setup(t); await enroll(); await enroll('supplier');
  const approved = '2026-10-01T00:00:00Z';
  checked(await api('ops', 'PATCH', '/ops/testers/settings', { app: 'client', playClockStartDate: '2026-10-01', optedInCount: 13, productionApprovedAt: approved }));
  const s = checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'client', version: '1', source: 'open' }));
  assert.equal(s.stopped, true); assert.equal(s.runComplete, false); assert.equal(s.nudge, null);
  assert.equal((await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count, 0);
  assert.equal(checked(await api('supplier', 'POST', '/me/tester-program/check-in', { app: 'supplier', version: '1', source: 'button' })).stopped, false);
  const dashboard = checked(await api('admin', 'GET', '/ops/testers?app=client'));
  assert.deepEqual(dashboard.stats, { activeToday: 0, fullStreak: 0, needed: 12, playClockStartDate: '2026-10-01', optedInCount: 13, productionApprovedAt: new Date(approved).toISOString() });
  for (const [values, error] of [[{ optedInCount: -1 }, 'invalid_opted_in_count'], [{ optedInCount: 1.5 }, 'invalid_opted_in_count'],
    [{ playClockStartDate: '2026-02-30' }, 'invalid_play_clock_start_date'], [{ productionApprovedAt: '2099-01-01T00:00:00Z' }, 'invalid_production_approved_at'],
    [{ productionApprovedAt: 'bad' }, 'invalid_production_approved_at'], [{ unexpected: true }, 'unexpected_field']]) {
    assert.equal(checked(await api('ops', 'PATCH', '/ops/testers/settings', { app: 'client', ...values }), 400).error, error);
  }
  assert.ok((await loadStore(db)).auditLog.some(row => row.action === 'tester_program.settings_updated'));
  checked(await api('admin', 'PATCH', '/ops/testers/settings', { app: 'client', productionApprovedAt: null }));
  assert.equal(checked(await state(call, new Date().toISOString())).stopped, false);
});

test('feedback triggers at streaks 3/7/10/14, uses a rolling 72-hour limit, and stops forever after a tap', { skip: !DB }, async t => {
  const { db, api, call, enroll } = await setup(t); await enroll(); await startAt(db, '2026-10-01T00:00:00Z');
  for (let day = 1; day <= 14; day++) {
    const at = `${shiftDate('2026-10-01', day - 1)}T00:00:00Z`;
    const s = checked(await checkin(call, at));
    assert.deepEqual(s.nudge, [3, 7, 10, 14].includes(day) ? { trigger: `streak_${day}` } : null);
    if ([3, 7, 10, 14].includes(day)) {
      checked(await feedback(call, at, 'shown', s.nudge.trigger));
      checked(await feedback(call, at, 'shown', s.nudge.trigger)); // retry, no inflated count
      assert.equal(checked(await state(call, at)).nudge, null);
      checked(await feedback(call, at, 'dismissed', s.nudge.trigger));
      checked(await feedback(call, at, 'dismissed', s.nudge.trigger));
    }
  }
  let dashboard = checked(await api('ops', 'GET', '/ops/testers?app=client'));
  assert.deepEqual(dashboard.testers[0].feedback, { shownCount: 4, tappedAt: null, dismissedCount: 4 });
  const tapAt = '2026-10-14T00:01:00Z'; checked(await feedback(call, tapAt, 'tapped', 'streak_14'));
  checked(await feedback(call, tapAt, 'tapped', 'streak_14'));
  assert.equal(checked(await state(call, '2026-10-14T00:02:00Z')).nudge, null);
  // Re-enrolment resets the run, but cannot reset feedback opt-out.
  checked(await api('ops', 'DELETE', '/ops/testers/client/client')); await enroll();
  await startAt(db, '2026-10-20T00:00:00Z');
  for (let day = 20; day <= 22; day++) checked(await checkin(call, `2026-10-${day}T00:00:00Z`));
  assert.equal(checked(await state(call, '2026-10-22T00:00:00Z')).nudge, null);
  dashboard = checked(await api('ops', 'GET', '/ops/testers?app=client'));
  assert.equal(dashboard.testers[0].feedback.tappedAt, new Date(tapAt).toISOString());
});

test('completed orders trigger feedback by read only; cooldown rejects early prompts and allows exactly 72 hours', { skip: !DB }, async t => {
  const { db, call, enroll } = await setup(t); await enroll(); await startAt(db, '2026-10-01T00:00:00Z');
  const completed = async at => db.query("UPDATE orders SET state='completed',updated_at=$1 WHERE id='order'", [at]);
  await completed('2026-10-01T01:00:00Z');
  const firstAt = '2026-10-01T02:00:00Z';
  assert.deepEqual(checked(await state(call, firstAt)).nudge, { trigger: 'completed_order' });
  checked(await feedback(call, firstAt, 'shown', 'completed_order'));
  checked(await feedback(call, firstAt, 'dismissed', 'completed_order'));
  await db.transaction(async () => {
    const store = await loadStore(db);
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'order2', updatedAt: '2026-10-02T01:00:00Z' });
    await saveStore(db, store);
  });
  assert.equal(checked(await state(call, '2026-10-04T01:59:59.999Z')).nudge, null);
  assert.equal(checked(await feedback(call, '2026-10-04T01:59:59.999Z', 'shown', 'completed_order'), 409).error, 'nudge_not_available');
  assert.deepEqual(checked(await state(call, '2026-10-04T02:00:00Z')).nudge, { trigger: 'completed_order' });
  checked(await feedback(call, '2026-10-04T02:00:00Z', 'shown', 'completed_order'));
  checked(await feedback(call, '2026-10-04T02:00:01Z', 'dismissed', 'completed_order'));
  await completed('2026-10-05T01:00:00Z');
  assert.equal(checked(await state(call, '2026-10-08T00:00:00Z')).nudge, null, 'old completion is consumed');
  assert.equal((await db.query("SELECT updated_at FROM orders WHERE id='order'")).rows[0].updated_at, '2026-10-05T01:00:00.000Z');
});

test('enrolment errors, removal/re-addition, app and own-account isolation, stopped-checking-in threshold and day boxes', { skip: !DB }, async t => {
  const { db, api, call, enroll } = await setup(t);
  for (const app of ['client', 'supplier', 'rider']) {
    assert.deepEqual(checked(await api(app, 'GET', `/me/tester-program?app=${app}`)), { enrolled: false });
    assert.equal(checked(await api(app, 'POST', '/me/tester-program/check-in', { app, source: 'open', version: '1' }), 404).error, 'not_enrolled');
    assert.equal(checked(await api(app, 'POST', '/me/tester-program/feedback', { app, event: 'shown', trigger: 'streak_3' }), 404).error, 'not_enrolled');
  }
  for (const [email, app, status, error] of [['bad', 'client', 400, 'invalid_email'], ['absent@example.invalid', 'client', 404, 'user_not_found'],
    ['supplier@example.invalid', 'client', 400, 'role_mismatch'], ['ops@example.invalid', 'client', 400, 'role_mismatch']]) {
    assert.equal(checked(await api('ops', 'POST', '/ops/testers', { email, app }), status).error, error);
  }
  await enroll();
  assert.equal(checked(await api('admin', 'POST', '/ops/testers', { app: 'client', email: 'CLIENT@example.invalid' }), 409).error, 'already_enrolled');
  checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'client', version: '1', source: 'open', userId: 'other' }));
  assert.deepEqual(checked(await api('other', 'GET', '/me/tester-program?app=client&userId=client')), { enrolled: false });
  assert.equal((await db.query('SELECT user_id FROM tester_program_checkins')).rows[0].user_id, 'client');
  const before = checked(await api('ops', 'GET', '/ops/testers?app=client')).testers[0];
  assert.equal(before.days.length, 14); assert.equal(before.days.at(-1).state, 'checked_in');
  assert.ok(before.days.slice(0, -1).every(row => row.state === 'before_start'));
  checked(await api('admin', 'DELETE', '/ops/testers/client/client'));
  assert.deepEqual(checked(await api('client', 'GET', '/me/tester-program?app=client')), { enrolled: false });
  assert.equal((await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count, 1);
  await enroll();
  let s = checked(await api('client', 'GET', '/me/tester-program?app=client')); assert.equal(s.streak, 0); assert.equal(s.day, 1); assert.equal(s.checkedInToday, false);
  checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'client', version: '2', source: 'button' }));
  assert.equal((await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count, 1, 'one daily row across re-enrolments');
  assert.equal((await db.query('SELECT count(*) FROM tester_program_enrollments')).rows[0].count, 2);
  const today = manilaDate(new Date());
  await startAt(db, `${shiftDate(today, -4)}T00:00:00Z`);
  await db.query('UPDATE tester_program_checkins SET manila_date=$1', [shiftDate(today, -2)]);
  assert.equal(checked(await api('ops', 'GET', '/ops/testers?app=client')).testers[0].stoppedCheckingIn, false);
  await db.query('UPDATE tester_program_checkins SET manila_date=$1', [shiftDate(today, -3)]);
  let dashboard = checked(await api('ops', 'GET', '/ops/testers?app=client'));
  assert.equal(dashboard.testers[0].stoppedCheckingIn, true); assert.equal(dashboard.testers[0].streak, 0);
  assert.equal(dashboard.testers[0].days.at(-2).state, 'missed'); assert.equal(dashboard.testers[0].days.at(-1).state, 'today');
  assert.equal((await loadStore(db)).auditLog.filter(row => row.action.startsWith('tester_program.')).length, 3);
  assert.equal(checked(await api('ops', 'DELETE', '/ops/testers/client/other'), 404).error, 'not_enrolled');
  // A legacy role column cannot grant an enrollment without its membership.
  await db.query("DELETE FROM user_role_memberships WHERE user_id='rider' AND role='rider'");
  assert.equal(checked(await api('ops', 'POST', '/ops/testers', { app: 'rider', email: 'rider@example.invalid' }), 400).error, 'role_mismatch');
});

test('every route refuses anonymous/wrong-role/test-operations requests, and feedback validates event and trigger', { skip: !DB }, async t => {
  const { db, api, enroll } = await setup(t);
  const staffRoutes = [['GET', '/ops/testers?app=client'], ['POST', '/ops/testers', { app: 'client', email: 'client@example.invalid' }],
    ['DELETE', '/ops/testers/client/client'], ['PATCH', '/ops/testers/settings', { app: 'client', optedInCount: 12 }]];
  const ownRoutes = [['GET', '/me/tester-program?app=client'], ['POST', '/me/tester-program/check-in', { app: 'client', version: '1', source: 'open' }],
    ['POST', '/me/tester-program/feedback', { app: 'client', event: 'shown', trigger: 'streak_3' }]];
  for (const [method, path, body] of [...staffRoutes, ...ownRoutes]) {
    checked(await api(null, method, path, body), 401);
    checked(await api(null, method, path, body, { headers: { Authorization: 'Bearer invalid' } }), 401);
  }
  for (const actor of ['client', 'supplier', 'rider']) for (const [method, path, body] of staffRoutes) checked(await api(actor, method, path, body), 403);
  for (const actor of ['supplier', 'rider', 'ops', 'admin']) for (const [method, path, body] of ownRoutes) checked(await api(actor, method, path, body), 403);
  checked(await api('client', 'GET', '/me/tester-program?app=unknown'), 400);
  await enroll();
  checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'client', version: '', source: 'open' }), 400);
  checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'client', version: '1', source: 'timezone' }), 400);
  assert.equal(checked(await api('client', 'POST', '/me/tester-program/feedback', { app: 'client', event: 'done', trigger: 'streak_3' }), 400).error, 'invalid_event');
  assert.equal(checked(await api('client', 'POST', '/me/tester-program/feedback', { app: 'client', event: 'shown', trigger: 'made_up' }), 400).error, 'invalid_trigger');
  assert.equal(checked(await api('client', 'POST', '/me/tester-program/feedback', { app: 'client', event: 'tapped', trigger: 'streak_3' }), 409).error, 'feedback_not_shown');
  assert.equal(checked(await api('client', 'POST', '/me/tester-program/feedback', { app: 'client', event: 'shown', trigger: 'streak_3' }), 409).error, 'nudge_not_available');
  // Existing test-operations default deny applies to all seven endpoints.
  await db.query("UPDATE users SET review_data=true WHERE id='ops'");
  for (const [method, path, body] of [...staffRoutes, ...ownRoutes]) assert.equal(checked(await api('ops', method, path, body), 403).error, 'test_operations_forbidden');
  // Super Admin remains staff even when its account is marked review data.
  await db.query("UPDATE users SET review_data=true WHERE id='admin'");
  checked(await api('admin', 'GET', '/ops/testers?app=client'));
  assert.equal((await db.query('SELECT count(*) FROM tester_program_checkins')).rows[0].count, 0);
});

test('all three apps have isolated HTTP state; own telemetry cannot advance an expired order; audit failure rolls enrollment back', { skip: !DB }, async t => {
  const { db, store, api, enroll } = await setup(t);
  for (const app of ['client', 'supplier', 'rider']) {
    await enroll(app);
    const s = checked(await api(app, 'POST', '/me/tester-program/check-in', { app, version: `${app}-1`, source: 'button' }));
    assert.equal(s.app, app); assert.equal(s.streak, 1); assert.equal(s.checkedInToday, true);
    const dashboard = checked(await api('ops', 'GET', `/ops/testers?app=${app}`));
    assert.equal(dashboard.testers.length, 1); assert.equal(dashboard.testers[0].userId, app); assert.equal(dashboard.stats.activeToday, 1);
  }
  await db.query("UPDATE orders SET state='issue_window_open',issue_window_expires_at='2020-01-01T00:00:00Z' WHERE id='order'");
  checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'client', version: '1', source: 'open' }));
  checked(await api('client', 'GET', '/me/tester-program?app=client'));
  assert.equal((await db.query("SELECT state FROM orders WHERE id='order'")).rows[0].state, 'issue_window_open');
  const orderBefore = (await db.query('SELECT row_to_json(o) AS value FROM orders o ORDER BY id')).rows;
  const notificationsBefore = (await db.query('SELECT count(*) FROM notifications')).rows[0].count;
  checked(await api('ops', 'PATCH', '/ops/testers/settings', { app: 'client', optedInCount: 12 }));
  await enroll('supplier', 'replacement');
  assert.deepEqual((await db.query('SELECT row_to_json(o) AS value FROM orders o ORDER BY id')).rows, orderBefore);
  assert.equal((await db.query('SELECT count(*) FROM notifications')).rows[0].count, notificationsBefore);
  const actor = store.users.find(row => row.id === 'ops'); resolveAuthorizationContext(store, actor);
  await assert.rejects(routeTesterProgram({ req: { method: 'POST' }, url: new URL('http://test/ops/testers'), user: actor, database: db,
    readBody: async () => ({ app: 'client', email: 'other@example.invalid' }), auditEvent: async () => { throw new Error('audit unavailable'); } }), /audit unavailable/);
  assert.equal((await db.query("SELECT count(*) FROM tester_program_enrollments WHERE user_id='other'")).rows[0].count, 0);
  await enroll('client', 'other');
  const today = manilaDate(new Date());
  await db.query("UPDATE tester_program_enrollments SET added_at=$1 WHERE user_id='other'", [`${shiftDate(today, -3)}T00:00:00+08:00`]);
  const never = checked(await api('ops', 'GET', '/ops/testers?app=client')).testers.find(row => row.userId === 'other');
  assert.equal(never.stoppedCheckingIn, true); assert.equal(never.streak, 0); assert.equal(never.day, 1);
  assert.equal(never.days.at(-2).state, 'missed');
  // The app membership, not a legacy primary role, selects a multi-role tester.
  await db.query("INSERT INTO user_role_memberships(user_id,role,created_at) VALUES ('client','supplier',now())");
  await enroll('supplier', 'client');
  assert.equal(checked(await api('client', 'POST', '/me/tester-program/check-in', { app: 'supplier', version: 'shop-1', source: 'open' })).app, 'supplier');
  checked(await api('client', 'GET', '/me/tester-program?app=supplier', null, { headers: { 'X-GRIDGO-Role': 'client' } }), 403);
  checked(await api('client', 'GET', '/me/tester-program?app=supplier', null, { headers: { 'X-GRIDGO-Role': 'supplier' } }));
});
