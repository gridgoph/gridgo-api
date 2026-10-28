import test from 'node:test';
import assert from 'node:assert/strict';
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

test('a successful authentication records lastAuthenticatedAt and a later one moves it forward', { skip: !DATABASE_URL }, async (t) => {
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

  const first = userById(await loadStore(db), 'client').lastAuthenticatedAt;
  assert.equal(typeof first, 'string');
  assert.notEqual(first, AT);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await api('client', 'GET', '/auth/me/client')).status, 200);
  const second = userById(await loadStore(db), 'client').lastAuthenticatedAt;
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
