import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { enqueueNotificationPushes } from '../src/push-outbox.js';
import { applySeasonNotices } from '../src/season-windows.js';

const DATABASE_URL = process.env.DATABASE_URL;
const AT = new Date().toISOString();
const startDate = new Date(Date.now() + 8 * 3600000 + 35 * 86400000).toISOString().slice(0, 10);
const ISSUER = 'https://season-tests.clerk.accounts.dev';
const PARTY = 'http://localhost:19006';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function jwt(subject) {
  const t = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: ISSUER, sub: subject, sid: 'season_session', azp: PARTY, iat: t - 5, exp: t + 300 })).toString('base64url');
  const input = `${header}.${body}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const createId = prefix => `${prefix}_${crypto.randomUUID()}`;
const audit = (store, entry) => store.auditLog.push({ id: createId('aud'), at: AT, actorId: null, actorRole: 'system', ...entry, actor: undefined });

test('HTTP season roles and CRUD persist; locked concurrent sweeps enqueue once and rollback atomically', { skip: !DATABASE_URL }, async () => {
  const db = createDatabase({ DATABASE_URL });
  const prefix = `season_${crypto.randomUUID()}`;
  let child;
  let windowId;
  const users = ['client', 'ops_admin', 'super_admin'].map(role => ({ id: `${prefix}_${role}`, role }));
  try {
    await db.transaction(async () => {
      const store = await loadStore(db);
      store.settings.seasonWindowPush = { enabled: false, version: 1 };
      for (const u of users) {
        store.users.push({ ...u, clerkUserId: u.id, email: `${u.id}@test.invalid`, name: 'Test fixture', createdAt: AT, ...(u.role === 'client' ? { accountType: 'individual' } : {}) });
        store.userRoleMemberships.push({ userId: u.id, role: u.role, createdAt: AT });
      }
      store.deviceTokens.push({ id: `${prefix}_device`, userId: users[0].id, token: `${prefix}_token`, appRole: 'client', platform: 'android', createdAt: AT, updatedAt: AT });
      await saveStore(db, store);
    });
    const { createServer } = await import('node:net');
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(r => reservation.close(r));
    child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, DATABASE_URL, HOST: '127.0.0.1', PORT: String(port), CLERK_SECRET_KEY: 'test-only-placeholder', CLERK_ISSUER: ISSUER, CLERK_AUTHORIZED_PARTIES: PARTY, CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }), GRIDGO_FCM_SERVICE_ACCOUNT_FILE: '', GRIDGO_APNS_KEY_FILE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', d => { logs += d; });
    child.stderr.on('data', d => { logs += d; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode != null) throw new Error(logs);
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 25));
    }
    async function request(path, method = 'GET', role, body) {
      const response = await fetch(`${base}${path}`, { method, headers: { ...(role ? { Authorization: `Bearer ${jwt(`${prefix}_${role}`)}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await request('/season-windows')).status, 200);
    const values = { name: 'Upcoming season', startDate, endDate: startDate, demandLevel: 'Busy', message: 'Plan printing early.' };
    assert.equal((await request('/admin/season-windows', 'POST', null, values)).status, 401);
    assert.equal((await request('/admin/season-windows', 'POST', 'ops_admin', values)).status, 403);
    assert.equal((await request('/admin/season-windows', 'POST', 'client', values)).status, 403);
    const created = await request('/admin/season-windows', 'POST', 'super_admin', values);
    assert.equal(created.status, 201);
    windowId = created.body.window.id;
    assert.equal((await request('/season-windows')).body.banners.some(w => w.id === windowId), true);
    const dry = await request('/admin/season-windows/push-dry-run', 'POST', 'super_admin', {});
    assert.equal(dry.body.enabled, false);
    assert.equal(dry.body.windows.find(w => w.id === windowId).wouldNotifyClients >= 1, true);
    assert.equal((await db.query('SELECT notice_queued_at FROM season_windows WHERE id=$1', [windowId])).rows[0].notice_queued_at, null);
    const edited = await request(`/admin/season-windows/${windowId}`, 'PATCH', 'super_admin', { expectedVersion: 1, message: 'Allow extra time.' });
    assert.equal(edited.status, 200);
    assert.equal((await loadStore(db)).seasonWindows.find(w => w.id === windowId).message, 'Allow extra time.');
    assert.equal((await request('/admin/season-windows', 'GET', 'ops_admin')).status, 403);
    assert.equal((await request('/admin/season-windows', 'GET', 'super_admin')).body.windows.some(w => w.id === windowId), true);
    assert.deepEqual((await request('/admin/season-windows/push-settings', 'GET', 'super_admin')).body, { enabled: false, version: 1 });
    assert.equal((await request('/admin/season-windows/push-settings', 'PATCH', 'client', { enabled: false, expectedVersion: 1, reason: 'Keep disabled' })).status, 403);
    assert.deepEqual((await request('/admin/season-windows/push-settings', 'PATCH', 'super_admin', { enabled: false, expectedVersion: 1, reason: 'Keep disabled' })).body, { enabled: false, version: 2 });
    const removable = await request('/admin/season-windows', 'POST', 'super_admin', values);
    assert.equal((await request(`/admin/season-windows/${removable.body.window.id}`, 'DELETE', 'super_admin', { expectedVersion: 1 })).status, 200);
    assert.equal((await request('/season-windows')).body.windows.some(w => w.id === removable.body.window.id), false);
    child.kill('SIGTERM');
    await once(child, 'exit');
    child = null;
    // Enable only in the isolated test database, with no API/transport running.
    await db.transaction(async () => {
      const store = await loadStore(db);
      store.settings.seasonWindowPush = { enabled: true, version: 2 };
      await saveStore(db, store);
    });
    async function sweep(rollback = false) {
      return db.transaction(async () => {
        const store = await loadStore(db);
        const original = new Set(store.notifications.map(n => n.id));
        const queued = applySeasonNotices(store, { at: AT, createId, audit });
        await saveStore(db, store);
        await enqueueNotificationPushes(db, store, store.notifications.filter(n => !original.has(n.id)));
        if (rollback) throw new Error('test rollback');
        return queued;
      });
    }
    await assert.rejects(sweep(true), /test rollback/);
    assert.equal((await loadStore(db)).seasonWindows.find(w => w.id === windowId).noticeQueuedAt, null);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM notification_push_outbox o JOIN notifications n ON n.id=o.notification_id WHERE n.data->>'seasonWindowId'=$1", [windowId])).rows[0].count, 0);
    const results = await Promise.all([sweep(), sweep()]);
    assert.equal(results.flat().filter(id => id === windowId).length, 1);
    await assert.rejects(db.query('UPDATE season_windows SET notice_queued_at=NULL WHERE id=$1', [windowId]), e => e.code === '23514');
    const store = await loadStore(db);
    const notices = store.notifications.filter(n => n.userId === users[0].id && n.seasonWindowId === windowId);
    assert.equal(notices.length, 1);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM notification_push_outbox WHERE notification_id=$1', [notices[0].id])).rows[0].count, 1);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await db.transaction(async () => {
      await db.query('DELETE FROM season_windows WHERE id=$1', [windowId || '']);
      await db.query('DELETE FROM audit_log WHERE entity_id=$1 OR actor_id=ANY($2::text[])', [windowId || '', users.map(u => u.id)]);
      await db.query('DELETE FROM notifications WHERE user_id=ANY($1::text[]) OR data->>\'seasonWindowId\'=$2', [users.map(u => u.id), windowId || '']);
      await db.query('DELETE FROM device_tokens WHERE id=$1', [`${prefix}_device`]);
      await db.query('DELETE FROM user_role_memberships WHERE user_id=ANY($1::text[])', [users.map(u => u.id)]);
      await db.query('DELETE FROM users WHERE id=ANY($1::text[])', [users.map(u => u.id)]);
      await db.query("UPDATE platform_settings SET settings = settings - 'seasonWindowPush'");
    });
    await db.close();
  }
});
