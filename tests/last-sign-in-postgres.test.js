import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { recordUserSignIn, backfillLastSignIns } from '../src/last-sign-in.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t) {
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, voucher_campaigns RESTART IDENTITY CASCADE');
  await db.transaction(() => saveStore(db, fixture()));
  return db;
}
const timestamp = async (db, id = 'client') => (await db.query('SELECT last_signed_in_at FROM users WHERE id=$1', [id])).rows[0].last_signed_in_at;

test('session adoption throttles writes to once per session, including concurrent and returning-device bootstraps', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  const first = '2026-10-01T00:00:00.000Z', next = '2026-10-02T00:00:00.000Z';
  assert.equal(await timestamp(db), null);
  const results = await Promise.all(Array.from({ length: 4 }, () => recordUserSignIn(db, 'client', 'private-session-one', first)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await timestamp(db), first);
  assert.equal(await recordUserSignIn(db, 'client', 'private-session-one', next), false);
  assert.equal(await timestamp(db), first);
  assert.equal(await recordUserSignIn(db, 'client', 'private-session-two', next), true);
  assert.equal(await recordUserSignIn(db, 'client', 'private-session-one', '2026-10-03T00:00:00.000Z'), false);
  assert.equal(await timestamp(db), next);
  assert.equal(await recordUserSignIn(db, 'client', null, next), false);
  const sessions = (await db.query('SELECT * FROM user_sign_in_sessions')).rows;
  assert.equal(sessions.length, 2);
  assert.equal(JSON.stringify(sessions).includes('private-session'), false);
  // Unrelated adapter writes must preserve the relational timestamp.
  await db.transaction(async () => { const store = await loadStore(db); store.users.find(u => u.id === 'client').name = 'New Name'; await saveStore(db, store); });
  assert.equal(await timestamp(db), next);
  await assert.rejects(db.transaction(async () => { await recordUserSignIn(db, 'client', 'rolled-back', '2026-10-04T00:00:00.000Z'); throw new Error('rollback'); }), /rollback/);
  assert.equal(await timestamp(db), next);
  assert.equal((await db.query('SELECT count(*) AS n FROM user_sign_in_sessions')).rows[0].n, 2);
});

test('staff directory has ISO/null timestamps, nulls-last sorting and inclusive rolling recency filters', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  const at = Date.now();
  const recent = new Date(at - 86400000).toISOString(), month = new Date(at - 20 * 86400000).toISOString(), old = new Date(at - 60 * 86400000).toISOString();
  await recordUserSignIn(db, 'client', 'client-session', recent);
  await recordUserSignIn(db, 'supplier', 'supplier-session', month);
  await recordUserSignIn(db, 'rider', 'rider-session', old);
  const api = await apiForTest(t);
  for (const actor of ['ops', 'admin']) {
    const response = await api(actor, 'GET', '/users');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    assert.equal(response.body.users.find(u => u.id === 'client').lastSignedInAt, recent);
    assert.equal(response.body.users.find(u => u.id === 'other').lastSignedInAt, null);
    const newest = (await api(actor, 'GET', '/users?sort=last_signed_in_newest')).body.users;
    assert.deepEqual(newest.filter(u => u.lastSignedInAt).map(u => u.id), ['client', 'supplier', 'rider']);
    assert.equal(newest.at(-1).lastSignedInAt, null);
    const oldest = (await api(actor, 'GET', '/users?sort=last_signed_in_oldest')).body.users;
    assert.deepEqual(oldest.filter(u => u.lastSignedInAt).map(u => u.id), ['rider', 'supplier', 'client']);
    assert.equal(oldest.at(-1).lastSignedInAt, null);
    assert.deepEqual((await api(actor, 'GET', '/users?signedIn=7d')).body.users.map(u => u.id), ['client']);
    assert.deepEqual((await api(actor, 'GET', '/users?signedIn=30d&sort=last_signed_in_oldest')).body.users.map(u => u.id), ['supplier', 'client']);
    const never = (await api(actor, 'GET', '/users?signedIn=never')).body.users;
    assert.ok(never.length > 0); assert.ok(never.every(u => u.lastSignedInAt === null));
    assert.deepEqual((await api(actor, 'GET', '/users?role=supplier&signedIn=30d')).body.users.map(u => u.id), ['supplier']);
    assert.deepEqual((await api(actor, 'GET', '/users?role=client&foundingTester=false&signedIn=7d')).body.users.map(u => u.id), ['client']);
    assert.equal((await api(actor, 'GET', '/users?sort=unknown')).status, 400);
    assert.equal((await api(actor, 'GET', '/users?signedIn=90d')).status, 400);
  }
  for (const actor of [null, 'client', 'supplier', 'rider']) {
    assert.equal((await api(actor, 'GET', '/users?sort=last_signed_in_newest&signedIn=never')).status, actor ? 403 : 401);
  }
  const selectedClient = await api('admin', 'GET', '/users', null, { headers: { 'X-GRIDGO-Role': 'client' } });
  assert.equal(selectedClient.status, 403);
  for (const path of ['/auth/me', '/auth/me/client', '/me', '/catalog', '/users/client']) {
    const response = await api(path.startsWith('/users') ? 'ops' : 'client', 'GET', path);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(JSON.stringify(response.body).includes('lastSignedInAt'), false, path);
    assert.equal(JSON.stringify(response.body).includes('sessionHash'), false, path);
  }
});

test('successful auth bootstraps record all roles; failures and ordinary requests do not', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t), api = await apiForTest(t);
  assert.equal((await api('client', 'GET', '/me')).status, 200);
  assert.equal(await timestamp(db), null);
  assert.equal((await api(null, 'GET', '/auth/me/client')).status, 401);
  assert.equal((await api('client', 'GET', '/auth/me/supplier')).status, 403);
  assert.equal(await timestamp(db), null);
  assert.equal((await api('client', 'GET', '/auth/me/client')).status, 200);
  const first = await timestamp(db); assert.ok(first);
  assert.equal((await api('client', 'GET', '/auth/me/client')).status, 200);
  assert.equal(await timestamp(db), first);
  for (const [actor, role] of [['supplier', 'supplier'], ['rider', 'rider'], ['ops', 'ops'], ['admin', 'admin']]) {
    assert.equal((await api(actor, 'GET', `/auth/me/${role}`)).status, 200);
    assert.ok(await timestamp(db, actor));
  }
  assert.equal((await api('other', 'GET', '/auth/me')).status, 200);
  assert.ok(await timestamp(db, 'other'));
});

test('bounded Clerk backfill uses subject IDs only, ignores null/future values, preserves newer observations and is idempotent', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t), calls = [];
  const before = '2026-09-01T00:00:00.000Z', after = '2026-10-01T00:00:00.000Z';
  await recordUserSignIn(db, 'client', 'one', after);
  const backend = { users: { getUserList: async params => { calls.push(params); return { data: [
    { id: 'clerk_client', lastSignInAt: Date.parse(before), privateMetadata: { secret: 'never store' } },
    { id: 'clerk_other', lastSignInAt: Date.parse(before) },
    { id: 'clerk_rider', lastSignInAt: null },
    { id: 'clerk_supplier', lastSignInAt: Date.now() + 86400000 },
    { id: 'unmapped', lastSignInAt: Date.parse(after) },
  ] }; } } };
  assert.equal((await backfillLastSignIns(db, backend)).updated, 1);
  assert.equal(await timestamp(db), after);
  assert.equal(await timestamp(db, 'other'), before);
  assert.equal(await timestamp(db, 'rider'), null);
  assert.equal(await timestamp(db, 'supplier'), null);
  assert.equal((await backfillLastSignIns(db, backend)).updated, 0);
  assert.ok(calls.every(call => call.limit === 100 && call.userId.length <= 100));
  assert.equal(JSON.stringify(await loadStore(db)).includes('never store'), false);
});
