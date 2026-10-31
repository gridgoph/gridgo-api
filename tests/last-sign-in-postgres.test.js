// Adapted from the red-phase specs in 26bdb94 to the merged
// lastAuthenticatedAt projection and failure-isolated request telemetry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { recordUserSignIn, backfillLastSignIns } from '../src/last-sign-in.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t, { cleanAuditAfter = false } = {}) {
  const db = createDatabase({ DATABASE_URL });
  t.after(async () => {
    try {
      // The compatibility adapter cannot read a synthetic infinity timestamp.
      // Do not leave that adversarial SQL fixture for another suite invocation.
      if (cleanAuditAfter) await resetDatabase(db, 'TRUNCATE audit_log');
    } finally {
      await db.close();
    }
  });
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, voucher_campaigns RESTART IDENTITY CASCADE');
  await db.transaction(() => saveStore(db, fixture()));
  return db;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const timestamp = async (db, id = 'client') => (await db.query('SELECT last_authenticated_at FROM users WHERE id=$1', [id])).rows[0].last_authenticated_at;
const sessions = async db => (await db.query('SELECT * FROM user_sign_in_sessions')).rows;
async function waitFor(db, read, predicate, retry) {
  for (let n = 0; n < 100; n++) {
    const value = await read(db);
    if (predicate(value)) return value;
    await retry?.();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for sign-in recording');
}

test('session adoption is durable across connections, concurrent requests and returning devices', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t), other = createDatabase({ DATABASE_URL });
  t.after(() => other.close());
  const first = '2026-10-01T00:00:00.000Z', next = '2026-10-02T00:00:00.000Z';
  assert.equal(await timestamp(db), null);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => recordUserSignIn(i % 2 ? db : other, 'client', 'private-session-one', first)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await timestamp(db), first);
  assert.equal(await recordUserSignIn(other, 'client', 'private-session-one', next), false);
  assert.equal(await recordUserSignIn(db, 'client', 'private-session-two', next), true);
  assert.equal(await recordUserSignIn(other, 'client', 'private-session-one', '2026-10-03T00:00:00.000Z'), false);
  assert.equal(await timestamp(db), next);
  assert.equal(await recordUserSignIn(db, 'client', null, next), false);
  assert.equal(await recordUserSignIn(db, 'client', '', next), false);
  assert.equal((await sessions(db)).length, 2);
  assert.equal(JSON.stringify(await sessions(db)).includes('private-session'), false);
  assert.equal((await sessions(db))[0].session_hash.length, 64);
  // Both null and older compatibility-adapter snapshots preserve newer telemetry.
  for (const stale of [undefined, first]) {
    await db.transaction(async () => {
      const store = await loadStore(db);
      Object.assign(store.users.find(u => u.id === 'client'), { name: 'New Name', lastAuthenticatedAt: stale });
      await saveStore(db, store);
    });
    assert.equal(await timestamp(db), next);
  }
  // An out-of-order new session is remembered without moving the time backwards.
  assert.equal(await recordUserSignIn(db, 'client', 'older-session', first), true);
  assert.equal(await timestamp(db), next);
  assert.equal(await recordUserSignIn(other, 'client', 'older-session', '2026-10-04T00:00:00.000Z'), false);
  assert.equal(await timestamp(db), next);
  // Different accounts never share a marker, even if a verified sid is reused.
  assert.equal(await recordUserSignIn(other, 'supplier', 'private-session-one', next), true);
  assert.equal(await timestamp(db, 'supplier'), next);
});

test('a skipped or failed session observation is retryable and independent of a request rollback', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t), locker = new pg.Client({ connectionString: DATABASE_URL });
  await locker.connect();
  try {
    await locker.query('BEGIN');
    await locker.query("SELECT id FROM users WHERE id='client' FOR UPDATE");
    assert.equal(await recordUserSignIn(db, 'client', 'locked', '2026-10-01T00:00:00.000Z'), false);
    assert.equal((await sessions(db)).length, 0);
  } finally {
    await locker.query('ROLLBACK');
    await locker.end();
  }
  assert.equal(await recordUserSignIn(db, 'client', 'locked', '2026-10-02T00:00:00.000Z'), true);
  await assert.rejects(db.transaction(async () => {
    assert.equal(await recordUserSignIn(db, 'client', 'independent', '2026-10-03T00:00:00.000Z'), true);
    throw new Error('domain rollback');
  }), /domain rollback/);
  assert.equal(await timestamp(db), '2026-10-03T00:00:00.000Z');
  assert.equal((await sessions(db)).length, 2);
  await db.query(`CREATE FUNCTION test_reject_sign_in() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test failure'; END $$;
    CREATE TRIGGER test_reject_sign_in BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION test_reject_sign_in()`);
  try {
    await db.transaction(async () => {
      assert.equal(await recordUserSignIn(db, 'client', 'retry-failed', '2026-10-04T00:00:00.000Z'), false);
      assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok, 1);
    });
    assert.equal((await sessions(db)).length, 2);
  } finally {
    await db.query('DROP TRIGGER test_reject_sign_in ON users; DROP FUNCTION test_reject_sign_in()');
  }
  assert.equal(await recordUserSignIn(db, 'client', 'retry-failed', '2026-10-04T00:00:00.000Z'), true);
});

test('verified session IDs deduplicate ordinary requests, JWT refreshes and restarted APIs for every role', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t), api = await apiForTest(t);
  assert.equal((await api(null, 'GET', '/settings')).status, 401);
  assert.equal((await api('client', 'GET', '/settings', null, { claims: { sid: null } })).status, 200);
  assert.equal((await api('client', 'GET', '/settings', null, { claims: { sub: 'unmapped' } })).status, 401);
  assert.equal((await sessions(db)).length, 0);
  for (const actor of ['client', 'supplier', 'rider', 'ops', 'admin', 'other']) {
    assert.equal((await api(actor, 'GET', '/settings')).status, 200);
    // Optional telemetry can skip a bootstrap/lifecycle row lock. Retry the
    // same verified session, as the next real app request would.
    const first = await waitFor(db, () => timestamp(db, actor), Boolean, () => api(actor, 'GET', '/settings'));
    assert.equal((await api(actor, 'GET', '/settings', null, { claims: { iat: Math.floor(Date.now() / 1000) } })).status, 200);
    assert.equal(await timestamp(db, actor), first);
  }
  const first = await timestamp(db);
  const restartedApi = await apiForTest(t);
  assert.equal((await restartedApi('client', 'GET', '/settings')).status, 200);
  // Drain the independent pool by observing a different session before checking.
  assert.equal((await restartedApi('client', 'GET', '/settings', null, { claims: { sid: 'new-device' } })).status, 200);
  await waitFor(db, sessions, rows => rows.length === 7, () => restartedApi('client', 'GET', '/settings', null, { claims: { sid: 'new-device' } }));
  const second = await timestamp(db);
  assert.ok(Date.parse(second) > Date.parse(first));
  assert.equal((await api('client', 'GET', '/settings')).status, 200);
  assert.equal((await api('client', 'GET', '/settings', null, { claims: { sid: 'new-device' } })).status, 200);
  assert.equal(await timestamp(db), second);
  // Preserve the merged directory shape and privacy boundary.
  const directory = await api('ops', 'GET', '/users');
  assert.equal(directory.body.users.find(u => u.id === 'client').lastAuthenticatedAt, second);
  for (const path of ['/auth/me/client', '/me', '/catalog', '/users/client']) {
    const response = await api(path.startsWith('/users') ? 'ops' : 'client', 'GET', path);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(JSON.stringify(response.body).includes('lastAuthenticatedAt'), false, path);
    assert.equal(JSON.stringify(response.body).includes('session_hash'), false, path);
  }
});

test('historical backfill uses only GRIDGO sign-in audits, advances older values and is idempotent', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t, { cleanAuditAfter: true });
  const before = '2026-09-01T00:00:00.000Z', after = '2026-10-01T00:00:00.000Z';
  await recordUserSignIn(db, 'client', 'one', after);
  await recordUserSignIn(db, 'rider', 'old-observation', before);
  const evidence = [
    ['older', 'client', 'staff.sign_in', before, hash('one')],
    ['null-value', 'other', 'staff.sign_in', before, hash('historic')],
    ['advance', 'rider', 'staff.sign_in', after, hash('newer')],
    ['latest', 'other', 'staff.sign_in', after, hash('historic-latest')],
    ['not-sign-in', 'supplier', 'staff.invited', after, null],
    ['future', 'supplier', 'staff.sign_in', '2099-01-01T00:00:00.000Z', hash('future')],
    ['infinite', 'supplier', 'staff.sign_in', 'infinity', hash('infinite')],
    ['deleted-account', 'no-such-user', 'staff.sign_in', after, hash('deleted')],
  ];
  for (const [id, actor, action, at, sessionHash] of evidence) {
    await db.query(`INSERT INTO audit_log (id, actor_id, action, at, position, data)
      VALUES ($1, $2, $3, $4, 0, $5)`, [id, actor, action, at, { detail: { sessionHash } }]);
  }
  const originalAudit = (await db.query('SELECT id, at::text, actor_id, action, data FROM audit_log ORDER BY id')).rows;
  assert.deepEqual(await backfillLastSignIns(db), { updated: 2 });
  assert.equal(await timestamp(db), after);
  assert.equal(await timestamp(db, 'other'), after);
  assert.equal(await timestamp(db, 'rider'), after);
  assert.equal(await timestamp(db, 'supplier'), null);
  assert.deepEqual(await backfillLastSignIns(db), { updated: 0 });
  assert.deepEqual((await db.query('SELECT id, at::text, actor_id, action, data FROM audit_log ORDER BY id')).rows, originalAudit);
  // A returning historical session does not become a fresh sign-in.
  assert.equal(await recordUserSignIn(db, 'other', 'historic', '2026-10-02T00:00:00.000Z'), false);
  assert.equal(await timestamp(db, 'other'), after);
  assert.equal((await sessions(db)).some(row => row.session_hash === hash('future')), false);
});
