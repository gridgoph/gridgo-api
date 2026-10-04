import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSeasonWindows, routeSeasonWindows, applySeasonNotices, seasonPushAllowed } from '../src/season-windows.js';

const AT = '2026-10-01T16:00:00.000Z'; // Oct 2 in Manila, 42 days before Nov 13.
const window = () => ({ id: 'sea_1', name: 'School season', startDate: '2026-11-13', endDate: '2026-11-30', demandLevel: 'Peak', message: 'Plan your printing early.', version: 1, noticeQueuedAt: null });
function fixture() {
  return {
    settings: {}, seasonWindows: [window()], notifications: [], auditLog: [],
    users: ['client', 'ops_admin', 'super_admin', 'supplier', 'rider', 'no_device', 'held'].map(id => ({ id, role: id === 'no_device' || id === 'held' ? 'client' : id, accountStatus: id === 'held' ? 'suspended' : 'active' })),
    userRoleMemberships: ['client', 'ops_admin', 'super_admin', 'supplier', 'rider', 'no_device', 'held'].map(userId => ({ userId, role: userId === 'no_device' || userId === 'held' ? 'client' : userId })),
    deviceTokens: [
      { id: 'a', userId: 'client', appRole: 'client' },
      { id: 'b', userId: 'client', appRole: 'client' },
      { id: 'c', userId: 'supplier', appRole: 'supplier' },
      { id: 'd', userId: null, appRole: 'client' },
      { id: 'e', userId: 'held', appRole: 'client' },
    ],
  };
}
let serial = 0;
const createId = prefix => `${prefix}_${++serial}`;
const audit = (store, entry) => store.auditLog.push(entry);
async function call(store, method, pathname, body, actor = 'super_admin') {
  return routeSeasonWindows({ req: { method }, url: new URL(`http://test.invalid${pathname}`), store, user: store.users.find(u => u.id === actor), readBody: async () => body, now: () => AT, createId, audit });
}

test('banner boundaries use Asia/Manila midnight and include 42 through 28 days ahead', () => {
  const cases = [
    ['2026-10-01T15:59:59.999Z', false],
    [AT, true],
    ['2026-10-16T15:59:59.999Z', true],
    ['2026-10-16T16:00:00.000Z', false],
  ];
  for (const [at, active] of cases) {
    const result = projectSeasonWindows([window()], at);
    assert.equal(result.windows[0].banner.active, active, at);
    assert.equal(result.banners.length, active ? 1 : 0);
    assert.equal(result.windows[0].banner.startDate, '2026-10-02');
    assert.equal(result.windows[0].banner.endDate, '2026-10-16');
  }
});

test('overlapping seasons survive independently; inclusive current dates expire at Manila midnight', () => {
  const second = { ...window(), id: 'sea_2', startDate: '2026-11-20' };
  const result = projectSeasonWindows([second, window()], '2026-11-30T15:59:59Z');
  assert.deepEqual(result.windows.map(w => [w.id, w.status]), [['sea_1', 'current'], ['sea_2', 'current']]);
  assert.deepEqual(projectSeasonWindows([window(), second], '2026-11-30T16:00:00Z').windows, []);
  assert.equal(projectSeasonWindows([window()], '2026-11-12T16:00:00Z').windows[0].status, 'current');
});

test('public projection omits scheduling internals and keeps an empty shape', async () => {
  const store = fixture();
  const result = await call(store, 'GET', '/season-windows', null, null);
  assert.equal(result.status, 200);
  assert.equal(result.body.timeZone, 'Asia/Manila');
  assert.equal(Object.hasOwn(result.body.windows[0], 'noticeQueuedAt'), false);
  assert.deepEqual(projectSeasonWindows([], AT).banners, []);
});

test('only a database Super Admin membership can mutate or preview sending', async () => {
  for (const actor of [null, 'client', 'ops_admin', 'supplier', 'rider']) {
    for (const [method, path] of [['POST', '/admin/season-windows'], ['PATCH', '/admin/season-windows/sea_1'], ['DELETE', '/admin/season-windows/sea_1'], ['PATCH', '/admin/season-windows/push-settings'], ['POST', '/admin/season-windows/push-dry-run'], ['GET', '/admin/season-windows']]) {
      await assert.rejects(call(fixture(), method, path, {}, actor), e => e.status === (actor ? 403 : 401));
    }
  }
  const store = fixture();
  store.users.find(u => u.id === 'client').role = 'super_admin';
  await assert.rejects(call(store, 'POST', '/admin/season-windows', window(), 'client'), e => e.status === 403);
});

test('Super Admin CRUD validates calendar dates, uses versions and never resets the notice marker', async () => {
  const store = fixture();
  const created = await call(store, 'POST', '/admin/season-windows', { ...window(), name: ' New season ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.window.name, 'New season');
  const existing = store.seasonWindows[0];
  existing.noticeQueuedAt = AT;
  const edited = await call(store, 'PATCH', '/admin/season-windows/sea_1', { expectedVersion: 1, message: 'Allow extra time.', startDate: '2026-11-14' });
  assert.equal(edited.body.window.version, 2);
  assert.equal(existing.noticeQueuedAt, AT);
  await assert.rejects(call(store, 'PATCH', '/admin/season-windows/sea_1', { expectedVersion: 1, name: 'Stale' }), e => e.status === 409);
  for (const values of [{ startDate: '2026-02-30' }, { startDate: '2026-12-01' }, { startDate: '2026-11-13T00:00:00Z' }, { demandLevel: 'Urgent' }, { message: '' }, { name: 'x'.repeat(121) }]) {
    await assert.rejects(call(store, 'POST', '/admin/season-windows', { ...window(), ...values }), e => e.status === 400);
  }
  const leap = await call(store, 'POST', '/admin/season-windows', { ...window(), startDate: '2028-02-29', endDate: '2028-02-29' });
  assert.equal(leap.status, 201);
  await assert.rejects(call(store, 'DELETE', '/admin/season-windows/sea_1', { expectedVersion: 1 }), e => e.status === 409);
  assert.equal((await call(store, 'DELETE', '/admin/season-windows/sea_1', { expectedVersion: 2 })).status, 200);
  assert.equal(store.seasonWindows.some(w => w.id === 'sea_1'), false);
  assert.equal(store.auditLog.length, 4);
});

test('dry run works while sending is off, counts clients and devices separately and has no side effects', async () => {
  const store = fixture();
  const before = structuredClone(store);
  const dry = await call(store, 'POST', '/admin/season-windows/push-dry-run', {});
  assert.equal(dry.body.enabled, false);
  assert.equal(dry.body.eligibleClients, 1);
  assert.equal(dry.body.eligibleDevices, 2);
  assert.deepEqual(dry.body.windows.map(w => [w.id, w.wouldNotifyClients, w.due]), [['sea_1', 1, true]]);
  assert.deepEqual(store, before);
  assert.equal(applySeasonNotices(store, { at: AT, createId, audit }).length, 0);
  assert.deepEqual(store, before);
  await assert.rejects(call(store, 'PATCH', '/admin/season-windows/push-settings', { enabled: 'true', expectedVersion: 1, reason: 'Reviewed' }), e => e.status === 400);
  await call(store, 'PATCH', '/admin/season-windows/push-settings', { enabled: true, expectedVersion: 1, reason: 'Reviewed rollout' });
  assert.equal(store.settings.seasonWindowPush.enabled, true);
});

test('once per window including overlapping windows, repeated sweeps, disabled periods and edits', () => {
  const store = fixture();
  store.settings.seasonWindowPush = { enabled: true, version: 1 };
  store.seasonWindows.push({ ...window(), id: 'sea_2' });
  const queued = applySeasonNotices(store, { at: AT, createId, audit });
  assert.equal(queued.length, 2);
  assert.equal(store.notifications.filter(n => n.appRole === 'client').length, 2);
  assert.equal(store.notifications.filter(n => n.appRole === 'ops_admin').length, 2);
  assert.equal(store.notifications.filter(n => n.appRole === 'super_admin').length, 2);
  assert.equal(store.seasonWindows[0].noticeQueuedAt, AT);
  store.notifications = []; // Removing inbox history cannot rearm a window.
  store.seasonWindows[0].startDate = '2026-11-14';
  assert.deepEqual(applySeasonNotices(store, { at: AT, createId, audit }), []);
  store.settings.seasonWindowPush.enabled = false;
  store.settings.seasonWindowPush.enabled = true;
  assert.deepEqual(applySeasonNotices(store, { at: AT, createId, audit }), []);
});

test('scheduler skips too early and late; outbox rechecks disable, deleted seasons and wrong app devices', () => {
  const store = fixture();
  store.settings.seasonWindowPush = { enabled: true };
  assert.deepEqual(applySeasonNotices(store, { at: '2026-10-01T15:59:59Z', createId, audit }), []);
  assert.deepEqual(applySeasonNotices(store, { at: '2026-10-16T16:00:00Z', createId, audit }), []);
  applySeasonNotices(store, { at: AT, createId, audit });
  const n = store.notifications.find(n => n.appRole === 'client');
  assert.equal(seasonPushAllowed(store, store.deviceTokens[0], n, AT), true);
  assert.equal(seasonPushAllowed(store, { ...store.deviceTokens[0], appRole: 'supplier' }, n, AT), false);
  assert.equal(seasonPushAllowed(store, store.deviceTokens[0], n, '2026-10-16T16:00:00Z'), false);
  store.settings.seasonWindowPush.enabled = false;
  assert.equal(seasonPushAllowed(store, store.deviceTokens[0], n, AT), false);
  store.settings.seasonWindowPush.enabled = true;
  store.seasonWindows = [];
  assert.equal(seasonPushAllowed(store, store.deviceTokens[0], n, AT), false);
});

test('season push carries the public admin message and only allowlisted routing data', async () => {
  const { pushMessageFor } = await import('../src/push.js');
  const message = pushMessageFor({ id: 'ntf_season', type: 'season_window', title: 'School season', body: 'Plan your printing early.', seasonWindowId: 'sea_1', at: AT });
  assert.equal(message.title, 'School season');
  assert.equal(message.body, 'Plan your printing early.');
  assert.deepEqual(Object.keys(message.data).sort(), ['at', 'notificationId', 'type']);
});

test('season changes write durable staff inbox rows for both privileged memberships', async () => {
  const store = fixture();
  await call(store, 'POST', '/admin/season-windows', window());
  assert.equal(store.notifications.filter(n => n.type === 'season_window_created' && n.appRole === 'ops_admin').length, 1);
  assert.equal(store.notifications.filter(n => n.type === 'season_window_created' && n.appRole === 'super_admin').length, 1);
  assert.equal(store.notifications.some(n => n.appRole === 'client'), false);
});

test('an explicitly selected client app cannot use a second Super Admin membership', async () => {
  const { selectActorRole } = await import('../src/authorization-context.js');
  const store = fixture();
  store.userRoleMemberships.push({ userId: 'client', role: 'super_admin' });
  const actor = selectActorRole(store, store.users[0], 'client', { restrictMemberships: true });
  await assert.rejects(routeSeasonWindows({ req: { method: 'POST' }, url: new URL('http://test.invalid/admin/season-windows'), store, user: actor, readBody: async () => window(), now: () => AT, createId, audit }), e => e.status === 403);
});
