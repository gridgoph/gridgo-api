import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { routeAccountDeletion } from '../src/account-deletion.js';
import { resolveAuthorizationContext } from '../src/authorization-context.js';

const DATABASE_URL = process.env.DATABASE_URL;
test('deletion requests are durable, idempotent, private and manually completed', { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const user = { id: 'deletion_test_client', email: 'account@example.test', role: 'client', suspended: true };
  const ops = { id: 'deletion_test_ops', role: 'ops_admin' };
  const store = { userRoleMemberships: [{ userId: ops.id, role: 'ops_admin' }] };
  resolveAuthorizationContext(store, ops);
  await database.query('TRUNCATE account_deletion_requests');
  for (const person of [user, ops]) await database.query(
    `INSERT INTO users (id,clerk_user_id,email,name,role,account_type,created_at,position,data) VALUES ($1,$1,$2,'Test account',$3,CASE WHEN $3='client' THEN 'individual' ELSE NULL END,now(),0,'{}') ON CONFLICT DO NOTHING`,
    [person.id, person.email || 'operator@example.test', person.role],
  );
  t.after(async () => {
    await database.query('TRUNCATE account_deletion_requests');
    await database.query('DELETE FROM users WHERE id = ANY($1)', [[user.id, ops.id]]);
    await database.close();
  });
  const events = [];
  const call = (method, pathname, actor, body = {}, onEvent = async (event) => { events.push(event); }) => routeAccountDeletion({
    req: { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    url: new URL(pathname, 'http://test'), user: actor, database, readBody: async () => body, onEvent,
  });
  assert.equal((await call('POST', '/me/account-deletion-request', null)).status, 401);
  const first = await call('POST', '/me/account-deletion-request', user, { userId: ops.id, email: 'other@example.test', confirmed: true });
  assert.equal(first.status, 202);
  assert.equal(first.body.message, 'We will delete your account within 30 days');
  const row = (await database.query('SELECT * FROM account_deletion_requests')).rows[0];
  assert.equal(row.user_id, user.id);
  assert.equal(row.contact_email, user.email);
  assert.equal(row.status, 'pending');
  assert.equal(row.source, 'app');
  assert.equal((await call('POST', '/me/account-deletion-request', user, { confirmed: true })).status, 202);
  assert.equal((await database.query('SELECT * FROM account_deletion_requests')).rowCount, 1);
  assert.equal(events.length, 1);
  assert.equal((await call('POST', '/me/account-deletion-request', user)).status, 400);
  assert.equal((await call('GET', '/ops/account-deletion-requests', user)).status, 403);
  assert.equal((await call('GET', '/ops/account-deletion-requests', { ...user, role: 'ops_admin' })).status, 403);
  assert.equal((await call('GET', '/ops/account-deletion-requests', ops)).body.requests.length, 1);
  assert.equal((await call('PATCH', `/ops/account-deletion-requests/${row.id}`, user, { status: 'done', confirmed: true })).status, 403);
  assert.equal((await call('PATCH', `/ops/account-deletion-requests/${row.id}`, ops, { status: 'done' })).status, 400);
  const done = await call('PATCH', `/ops/account-deletion-requests/${row.id}`, ops, { status: 'done', confirmed: true });
  assert.equal(done.body.request.status, 'done');
  assert.equal(done.body.request.completedBy, ops.id);
  assert.ok(done.body.request.completedAt);
  const again = await call('PATCH', `/ops/account-deletion-requests/${row.id}`, ops, { status: 'done', confirmed: true });
  assert.equal(again.body.request.completedAt, done.body.request.completedAt);
  assert.equal(events.length, 2);
  assert.equal((await database.query('SELECT id FROM users WHERE id=$1', [user.id])).rowCount, 1, 'marking done must not erase data');
  const web = await call('POST', '/account-deletion-requests', null, { email: user.email, confirmed: true });
  const unknown = await call('POST', '/account-deletion-requests', null, { email: 'unknown@example.test', confirmed: true });
  assert.deepEqual(web, unknown, 'no email or request existence disclosure');
  const publicRow = (await database.query("SELECT * FROM account_deletion_requests WHERE source='web' AND contact_email=$1", [user.email])).rows[0];
  assert.equal(publicRow.user_id, null, 'never link by unverified email');
  assert.equal((await call('POST', '/account-deletion-requests', null, { email: 'invalid', confirmed: true })).status, 400);
  await assert.rejects(call('POST', '/account-deletion-requests', null, { email: 'rollback@example.test', confirmed: true }, async () => { throw new Error('rollback'); }), /rollback/);
  assert.equal((await database.query("SELECT id FROM account_deletion_requests WHERE contact_email='rollback@example.test'")).rowCount, 0);
});

const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const AT = "2026-09-20T03:00:00.000Z";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
const PREFIX = `deletion_${process.pid}_${Date.now().toString(36)}`;

function clerkToken(subject) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: subject, sid: `sess_${subject}`, azp: AUTHORIZED_PARTY,
    iat: current - 5, nbf: current - 5, exp: current + 300,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startApi(extraEnv = {}) {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATABASE_URL,
      CLERK_SECRET_KEY: "test-only-placeholder",
      CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
      CLERK_JWT_KEY: JWT_KEY,
      HOST: "127.0.0.1",
      PORT: String(port),
      GRIDGO_BUILD_SHA: "account-deletion-test",
      GRIDGO_BUILD_TIME: AT,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`API exited before health:\n${output}`);
    try {
      if ((await fetch(`${api}/health`)).ok) return { api, child, output: () => output };
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`API did not become healthy:\n${output}`);
}

async function stopApi(instance) {
  if (!instance) return;
  instance.child.kill("SIGTERM");
  await new Promise((resolve) => instance.child.once("exit", resolve));
}

async function request(api, pathname, { method = "GET", token, role, body, headers = {} } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(role ? { "X-GRIDGO-Role": role } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: response.status, body: parsed };
}


test('HTTP requests bypass account holds, audit atomically and notify only staff', { skip: !DATABASE_URL }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const people = ['client', 'supplier', 'rider', 'ops_admin', 'super_admin'];
  let instance;
  t.after(async () => {
    await stopApi(instance);
    await database.query('DELETE FROM account_deletion_requests WHERE user_id LIKE $1 OR contact_email=$2', [`${PREFIX}%`, `${PREFIX}@example.test`]);
    await database.query("DELETE FROM audit_log WHERE actor_id LIKE $1 OR entity_type='account_deletion_request'", [`${PREFIX}%`]);
    await database.query('DELETE FROM notifications WHERE user_id LIKE $1', [`${PREFIX}%`]);
    await database.query('DELETE FROM user_role_memberships WHERE user_id LIKE $1', [`${PREFIX}%`]);
    await database.query('DELETE FROM users WHERE id LIKE $1', [`${PREFIX}%`]);
    await database.close();
  });
  for (const role of people) {
    await database.query(`INSERT INTO users (id,clerk_user_id,email,name,role,account_type,verification_status,created_at,position,data,account_status,account_status_reason,account_status_at,account_status_by)
      VALUES ($1,$1,$2,'Test account',$3,$4,CASE WHEN $3 IN ('supplier','rider') THEN 'approved' END,now(),0,'{}',$5,CASE WHEN $5='suspended' THEN 'Test hold' END,CASE WHEN $5='suspended' THEN now() END,CASE WHEN $5='suspended' THEN 'test_operator' END)`,
      [`${PREFIX}_${role}`, `${PREFIX}_${role}@example.test`, role, role === 'client' ? 'individual' : null, role === 'client' ? 'suspended' : 'active']);
    await database.query('INSERT INTO user_role_memberships (user_id,role,created_at) VALUES ($1,$2,now())', [`${PREFIX}_${role}`, role]);
  }
  instance = await startApi({ GRIDGO_LIFECYCLE_INTERVAL_MS: '3600000', GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: '0' });
  const post = (role) => request(instance.api, '/me/account-deletion-request', { method: 'POST', token: clerkToken(`${PREFIX}_${role}`), body: { confirmed: true } });
  for (const role of ['client', 'supplier', 'rider']) assert.equal((await post(role)).status, 202);
  assert.equal((await post('client')).status, 202);
  const rows = (await database.query('SELECT * FROM account_deletion_requests WHERE user_id LIKE $1', [`${PREFIX}%`])).rows;
  assert.equal(rows.length, 3);
  const audits = await database.query("SELECT * FROM audit_log WHERE entity_type='account_deletion_request' AND actor_id LIKE $1", [`${PREFIX}%`]);
  assert.equal(audits.rowCount, 3);
  const notes = (await database.query("SELECT user_id FROM notifications WHERE type='account_deletion_requested' AND user_id LIKE $1", [`${PREFIX}%`])).rows;
  assert.equal(notes.length, 6);
  assert.ok(notes.every((n) => n.user_id.endsWith('_ops_admin') || n.user_id.endsWith('_super_admin')));
  assert.equal((await request(instance.api, '/ops/account-deletion-requests', { token: clerkToken(`${PREFIX}_supplier`) })).status, 403);
  assert.equal((await request(instance.api, '/ops/account-deletion-requests', { token: clerkToken(`${PREFIX}_super_admin`) })).status, 200);
  const web = await request(instance.api, '/account-deletion-requests', { method: 'POST', body: { email: `${PREFIX}@example.test`, confirmed: true } });
  assert.equal(web.status, 202);
  assert.equal((await request(instance.api, '/me/account-deletion-request', { method: 'POST', body: { confirmed: true } })).status, 401);
});
