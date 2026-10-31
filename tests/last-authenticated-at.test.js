import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;

async function setup(t) {
  const db = createDatabase({ DATABASE_URL });
  t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, voucher_campaigns RESTART IDENTITY CASCADE');
  const store = fixture();
  await db.transaction(() => saveStore(db, store));
  return db;
}

function userById(store, id) {
  return store.users.find((user) => user.id === id);
}

test('a successful session records lastAuthenticatedAt and a new session moves it forward', { skip: !DATABASE_URL }, async (t) => {
  const db = await setup(t);
  const api = await apiForTest(t);

  const before = await api('admin', 'GET', '/users');
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const untouched = before.body.users.find((user) => user.id === 'client');
  assert.equal(untouched.lastAuthenticatedAt, null);
  assert.notEqual(untouched.createdAt, untouched.lastAuthenticatedAt);
  assert.equal(untouched.createdAt, AT);

  const session = await api('client', 'GET', '/auth/me/client');
  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.equal(Object.hasOwn(session.body.user, 'lastAuthenticatedAt'), false);
  assert.equal(JSON.stringify(session.body).includes('lastAuthenticatedAt'), false);

  const first = await waitForTimestamp(db, 'client', value => typeof value === 'string', () => api('client', 'GET', '/auth/me/client'));
  assert.equal(typeof first, 'string');
  assert.notEqual(first, AT);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await api('client', 'GET', '/auth/me/client')).status, 200);
  assert.equal(userById(await loadStore(db), 'client').lastAuthenticatedAt, first);
  const newSession = () => api('client', 'GET', '/auth/me/client', null, { claims: { sid: 'session_client_new' } });
  assert.equal((await newSession()).status, 200);
  const second = await waitForTimestamp(db, 'client', value => Date.parse(value) > Date.parse(first), newSession);
  assert.ok(Date.parse(second) > Date.parse(first), `${second} should be later than ${first}`);

  const directory = await api('admin', 'GET', '/users');
  assert.equal(directory.body.users.find((user) => user.id === 'client').lastAuthenticatedAt, second);
  assert.equal(directory.body.users.find((user) => user.id === 'supplier').lastAuthenticatedAt, null);
  assert.equal(directory.body.users.find((user) => user.id === 'rider').lastAuthenticatedAt, null);

  const ops = await api('ops', 'GET', '/users');
  assert.equal(ops.status, 200);
  assert.equal(ops.body.users.find((user) => user.id === 'client').lastAuthenticatedAt, second);
  assert.equal((await api('client', 'GET', '/users')).status, 403);
  assert.equal((await api('supplier', 'GET', '/users')).status, 403);

  const profile = await api('admin', 'GET', '/users/client');
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.equal(Object.hasOwn(profile.body.user, 'lastAuthenticatedAt'), false);

  assert.equal((await api('supplier', 'GET', '/auth/me/supplier')).status, 200);
  await waitForTimestamp(db, 'supplier', value => typeof value === 'string', () => api('supplier', 'GET', '/auth/me/supplier'));
  const matching = await api('admin', 'GET', '/orders/order/eligible-suppliers');
  assert.equal(matching.status, 200, JSON.stringify(matching.body));
  const supplier = matching.body.candidates.find((candidate) => candidate.supplier?.id === 'supplier');
  assert.ok(supplier, 'matching should still name the shop');
  assert.equal(Object.hasOwn(supplier.supplier, 'lastAuthenticatedAt'), false);
  assert.equal(JSON.stringify(matching.body).includes('lastAuthenticatedAt'), false);
  const listedSupplier = (await api('admin', 'GET', '/users')).body.users.find((user) => user.id === 'supplier');
  assert.equal(typeof listedSupplier.lastAuthenticatedAt, 'string');

  await db.query(`UPDATE users SET last_authenticated_at = '2099-01-01T00:00:00.000Z' WHERE id = 'rider'`);
  assert.equal((await api('rider', 'GET', '/auth/me/rider')).status, 200);
  assert.equal(userById(await loadStore(db), 'rider').lastAuthenticatedAt, '2099-01-01T00:00:00.000Z');

  const stored = await loadStore(db);
  assert.equal(stored.auditLog.filter((row) => row.action === 'staff.sign_in' && row.actorId === 'client').length, 0);
  const blob = (await db.query(`SELECT data FROM users WHERE id = 'client'`)).rows[0].data;
  assert.equal(Object.hasOwn(blob, 'lastAuthenticatedAt'), false);
  assert.equal(JSON.stringify(blob).includes('session_'), false);
});

// A synchronous UPDATE here used to make readable requests wait for this lock.
test('a locked user row does not delay an authenticated GET', { skip: !DATABASE_URL }, async (t) => {
  await setup(t);
  const api = await apiForTest(t);
  assert.equal((await api('client', 'GET', '/settings')).status, 200);
  const locker = new pg.Client({ connectionString: DATABASE_URL });
  await locker.connect();
  try {
    await locker.query('BEGIN');
    await locker.query("SELECT id FROM users WHERE id = 'client' FOR UPDATE");
    const response = await api('client', 'GET', '/settings', null, { signal: AbortSignal.timeout(750), claims: { sid: 'new_locked_session' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // The lock is still held when the response arrives.
  } finally {
    await locker.query('ROLLBACK');
    await locker.end();
  }
});

async function rejectTimestampWrites(db) {
  await db.query(`
    CREATE SEQUENCE test_auth_write_attempt;
    CREATE FUNCTION test_fail_auth_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.last_authenticated_at IS DISTINCT FROM OLD.last_authenticated_at THEN
        PERFORM nextval('test_auth_write_attempt');
        RAISE EXCEPTION 'test timestamp write failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_fail_auth_write BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION test_fail_auth_write();
  `);
}

async function removeTimestampFailure(db) {
  await db.query(`DROP TRIGGER test_fail_auth_write ON users;
    DROP FUNCTION test_fail_auth_write(); DROP SEQUENCE test_auth_write_attempt;`);
}

async function waitFor(db, read, predicate) {
  for (let n = 0; n < 100; n++) {
    const value = await read(db);
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for the timestamp write');
}

async function waitForFailedWrite(db) {
  await waitFor(db, async () => (await db.query('SELECT is_called FROM test_auth_write_attempt')).rows[0].is_called, Boolean);
}

test('a failing timestamp write cannot fail an authenticated GET', { skip: !DATABASE_URL }, async (t) => {
  const db = await setup(t);
  const api = await apiForTest(t);
  await rejectTimestampWrites(db);
  try {
    const response = await api('client', 'GET', '/settings');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await waitForFailedWrite(db);
    assert.equal(userById(await loadStore(db), 'client').lastAuthenticatedAt, undefined);
  } finally {
    await removeTimestampFailure(db);
  }
});

test('a failing timestamp write cannot abort a mutation transaction', { skip: !DATABASE_URL }, async (t) => {
  const db = await setup(t);
  const api = await apiForTest(t);
  await rejectTimestampWrites(db);
  try {
    const ranking = ['distance', 'quality', 'cost', 'speed'];
    const response = await api('client', 'PUT', '/me/preferences', { ranking });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // A concurrent FK/key-share lock may legitimately skip the optional write.
    const stored = await loadStore(db);
    assert.deepEqual(stored.clientPreferences.find(row => row.userId === 'client').ranking, ranking);
    assert.equal(userById(stored, 'client').lastAuthenticatedAt, undefined);
  } finally {
    await removeTimestampFailure(db);
  }
});

async function waitForTimestamp(db, userId, predicate, retryAuthentication) {
  return waitFor(db, async () => {
    const value = userById(await loadStore(db), userId).lastAuthenticatedAt;
    // Optional telemetry can skip a bootstrap's concurrent FK/key-share lock.
    // Retry authentication instead of relying on a slow full-store read to
    // give the independent timestamp connection time to win that race.
    if (!predicate(value)) await retryAuthentication?.();
    return value;
  }, predicate);
}

test('timestamp SQL failures use a separate connection and leave the domain transaction usable', { skip: !DATABASE_URL }, async (t) => {
  const db = await setup(t);
  await rejectTimestampWrites(db);
  try {
    await db.transaction(async () => {
      await assert.rejects(db.recordLastAuthenticated('client', new Date().toISOString(), 'a'.repeat(64)), /test timestamp write failure/);
      await db.query("UPDATE users SET name = 'Committed client' WHERE id = 'client'");
    });
    assert.equal(userById(await loadStore(db), 'client').name, 'Committed client');
  } finally {
    await removeTimestampFailure(db);
  }
});

test('timestamp recording skips a locked row and bounds a slow SQL write', { skip: !DATABASE_URL }, async (t) => {
  const db = await setup(t);
  const locker = new pg.Client({ connectionString: DATABASE_URL });
  await locker.connect();
  try {
    await locker.query('BEGIN');
    await locker.query("SELECT id FROM users WHERE id = 'client' FOR UPDATE");
    const result = await db.recordLastAuthenticated('client', new Date().toISOString(), 'a'.repeat(64));
    assert.equal(result.rowCount, 0);
    assert.equal((await db.query('SELECT count(*) AS n FROM user_sign_in_sessions')).rows[0].n, 0);
  } finally {
    await locker.query('ROLLBACK');
    await locker.end();
  }
  await db.query(`CREATE FUNCTION test_slow_auth_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$;
    CREATE TRIGGER test_slow_auth_write BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION test_slow_auth_write();`);
  try {
    await assert.rejects(db.recordLastAuthenticated('client', new Date().toISOString(), 'a'.repeat(64)), error => error.code === '57014');
    assert.equal(userById(await loadStore(db), 'client').lastAuthenticatedAt, undefined);
    assert.equal((await db.query('SELECT count(*) AS n FROM user_sign_in_sessions')).rows[0].n, 0);
  } finally {
    await db.query('DROP TRIGGER test_slow_auth_write ON users; DROP FUNCTION test_slow_auth_write();');
  }
});
