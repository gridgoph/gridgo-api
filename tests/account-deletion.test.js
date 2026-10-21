import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
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
  await database.query('TRUNCATE account_deletion_requests, account_deletion_apple_revocations');
  for (const person of [user, ops]) await database.query(
    `INSERT INTO users (id,clerk_user_id,email,name,role,account_type,created_at,position,data) VALUES ($1,$1,$2,'Test account',$3,CASE WHEN $3='client' THEN 'individual' ELSE NULL END,now(),0,'{}') ON CONFLICT DO NOTHING`,
    [person.id, person.email || 'operator@example.test', person.role],
  );
  t.after(async () => {
    await database.query('TRUNCATE account_deletion_requests, account_deletion_apple_revocations');
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
  assert.equal((await request(instance.api, '/api/account-deletion-requests', { method: 'POST', body: { email: `${PREFIX}@example.test`, confirmed: true } })).status, 202);
  assert.equal((await request(instance.api, '/me/account-deletion-request', { method: 'POST', body: { confirmed: true } })).status, 401);
});

test('HTTP Apple revocation binds Clerk identity, audits results, retries safely and exposes staff status', { skip: !DATABASE_URL, timeout: 30000 }, async (t) => {
  const database = createDatabase({ DATABASE_URL });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const supplierKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const riderKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signingKeys = {
    'ph.gridgo.client': { keyId: 'MOCKKEY001', ...ec },
    'ph.gridgo.supplier': { keyId: 'SUPPLIER01', ...supplierKey },
    'ph.gridgo.rider': { keyId: 'RIDERKEY01', ...riderKey },
  };
  const apple = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...apple.publicKey.export({ format: 'jwk' }), kid: 'mock-apple', use: 'sig', alg: 'RS256' };
  const users = ['client', 'supplier', 'rider', 'ops_admin', 'super_admin'];
  const prefix = `${PREFIX}_apple`;
  const uid = role => `${prefix}_${role}`;
  let instance;
  let missing;
  let linked = true;
  let clerkAvailable = true;
  let clerkStall;
  let releaseSlow;
  let slowStarted;
  const slowReady = new Promise(resolve => { slowStarted = resolve; });
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const calls = [];
  const identity = (clientId, subject, badSignature = false) => {
    const now = Math.floor(Date.now() / 1000);
    const input = [{ alg: 'RS256', kid: jwk.kid }, { iss: 'https://appleid.apple.com', aud: clientId,
      sub: subject, iat: now, exp: now + 300 }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), badSignature ? privateKey : apple.privateKey).toString('base64url')}`;
  };
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = new URLSearchParams(raw);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url.startsWith('/v1/users/')) {
      if (clerkStall) {
        const stall = clerkStall;
        res.once('close', stall.closed.resolve);
        if (stall.body) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"object":"user",'); }
        stall.entered.resolve();
        await stall.release.promise;
        if (res.destroyed) return;
      }
      if (!clerkAvailable) return json(503, { errors: [{ code: 'unavailable', message: 'mock unavailable' }] });
      const id = req.url.split('/').at(-1);
      return json(200, { object: 'user', id, email_addresses: [], phone_numbers: [], web3_wallets: [],
        external_accounts: linked ? [{ object: 'external_account', id: 'eac_mock', provider: 'oauth_apple',
          provider_user_id: `apple-${id}`, identification_id: 'idn_not_an_apple_subject',
          verification: { status: 'verified', strategy: 'oauth_apple' } }] : [] });
    }
    calls.push({ path: req.url, method: req.method, type: req.headers['content-type'], body });
    if (req.url === '/auth/keys') return json(200, { keys: [jwk] });
    if (['/auth/token', '/auth/revoke'].includes(req.url)) {
      try {
        const [header, payload, signature] = body.get('client_secret').split('.');
        const selected = signingKeys[body.get('client_id')];
        if (!selected || JSON.parse(Buffer.from(header, 'base64url')).kid !== selected.keyId
          || JSON.parse(Buffer.from(payload, 'base64url')).sub !== body.get('client_id')
          || !crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: selected.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) throw new Error();
      } catch { return json(400, { error: 'invalid_client' }); }
    }
    if (req.url === '/auth/token') {
      const code = body.get('code');
      if (code === 'slow-response') { slowStarted(); await slowGate; }
      if (code.startsWith('invalid')) return json(400, { error: 'invalid_grant', error_description: 'DO_NOT_STORE_PROVIDER_DETAILS' });
      if (code.startsWith('exchange-error')) return json(500, { error: 'server_error', error_description: 'DO_NOT_STORE_PROVIDER_DETAILS' });
      if (code.startsWith('malformed')) { res.writeHead(200); return res.end('not-json'); }
      const role = code.startsWith('supplier') ? 'supplier' : code.startsWith('rider') ? 'rider' : 'client';
      return json(200, { id_token: identity(code.startsWith('wrong-audience') ? 'other.bundle' : body.get('client_id'),
        code.startsWith('wrong-user') ? 'apple-someone-else' : `apple-${uid(role)}`, code.startsWith('bad-signature')),
      access_token: `PRIVATE_ACCESS_${code}`, ...(code.startsWith('access-only') ? {} : { refresh_token: `PRIVATE_REFRESH_${code}` }) });
    }
    if (req.url === '/auth/revoke') {
      if (body.get('token').includes('revoke-error')) return json(500, { error: 'server_error', detail: 'DO_NOT_STORE_PROVIDER_DETAILS' });
      res.writeHead(200); return res.end();
    }
    return json(404, {});
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const appleEnv = { NODE_ENV: 'test', CLERK_API_URL: mockUrl,
    GRIDGO_APPLE_TEAM_ID: 'MOCKTEAM01', GRIDGO_APPLE_KEY_ID: 'MOCKKEY001',
    GRIDGO_APPLE_PRIVATE_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GRIDGO_APPLE_SIGNING_KEYS: JSON.stringify(Object.fromEntries(['ph.gridgo.supplier', 'ph.gridgo.rider'].map(clientId => [clientId, {
      keyId: signingKeys[clientId].keyId, privateKey: signingKeys[clientId].privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }]))),
    GRIDGO_APPLE_CLIENT_IDS: 'ph.gridgo.client,ph.gridgo.supplier,ph.gridgo.rider', GRIDGO_APPLE_API_URL: mockUrl,
    DATABASE_POOL_MAX: '3', DATABASE_CONNECT_TIMEOUT_MS: '1000',
    GRIDGO_LIFECYCLE_INTERVAL_MS: '3600000', GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: '0' };
  t.after(async () => {
    clerkStall?.release.resolve();
    releaseSlow();
    await stopApi(instance); await stopApi(missing);
    await new Promise(resolve => mock.close(resolve));
    await database.query('DELETE FROM account_deletion_requests WHERE user_id LIKE $1', [`${prefix}%`]);
    await database.query('DELETE FROM notifications WHERE user_id LIKE $1', [`${prefix}%`]);
    await database.query('DELETE FROM user_role_memberships WHERE user_id LIKE $1', [`${prefix}%`]);
    await database.query('DELETE FROM users WHERE id LIKE $1', [`${prefix}%`]);
    await database.close();
  });
  for (const role of users) {
    await database.query(`INSERT INTO users (id,clerk_user_id,email,name,role,account_type,verification_status,created_at,position,data,
      account_status,account_status_reason,account_status_at,account_status_by)
      VALUES ($1,$1,$2,'Apple test',$3,$4,CASE WHEN $3 IN ('supplier','rider') THEN 'approved' END,now(),0,'{}','suspended','Test hold',now(),'test_operator')`,
    [uid(role), `${uid(role)}@example.test`, role, role === 'client' ? 'individual' : null]);
    await database.query('INSERT INTO user_role_memberships (user_id,role,created_at) VALUES ($1,$2,now())', [uid(role), role]);
  }
  // Staff are active so the Operations queue remains available.
  await database.query("UPDATE users SET account_status='active', account_status_reason=NULL, account_status_at=NULL, account_status_by=NULL WHERE id=ANY($1)", [[uid('ops_admin'), uid('super_admin')]]);
  await database.query("UPDATE users SET account_status='removed' WHERE id=$1", [uid('rider')]);
  instance = await startApi(appleEnv);
  const endpoint = '/me/account-deletion-request/apple-revocation';
  const post = (code, role = 'client', extra = {}, api = instance.api) => request(api, endpoint, {
    method: 'POST', token: clerkToken(uid(role)), body: { confirmed: true, clientId: `ph.gridgo.${role}`, authorizationCode: code, ...extra },
  });
  assert.equal((await request(instance.api, endpoint, { method: 'POST', body: { confirmed: true } })).status, 401);
  assert.equal((await post('unused')).body.error, 'account_deletion_request_required');
  assert.equal(calls.length, 0);
  for (const role of ['client', 'supplier', 'rider']) assert.equal((await request(instance.api, '/me/account-deletion-request', {
    method: 'POST', token: clerkToken(uid(role)), body: { confirmed: true },
  })).status, 202);
  missing = await startApi({ ...appleEnv, GRIDGO_APPLE_PRIVATE_KEY: '' });
  assert.equal((await post('missing', 'client', {}, missing.api)).body.error, 'apple_revocation_not_configured');
  assert.equal((await post('unused', 'client', { confirmed: false })).body.error, 'confirmation_required');
  assert.equal((await post('', 'client')).body.error, 'invalid_apple_authorization_code');
  assert.equal((await post('unused', 'client', { clientId: 'untrusted.bundle' })).body.error, 'invalid_apple_client_id');
  linked = false;
  assert.equal((await post('unlinked')).body.error, 'apple_account_not_linked');
  linked = true;
  clerkAvailable = false;
  assert.equal((await post('clerk-outage')).body.error, 'clerk_unavailable');
  clerkAvailable = true;
  assert.equal(calls.length, 0, 'configuration, validation and Clerk failures never spend the code');

  const first = await post('success');
  assert.equal(first.status, 200);
  assert.equal(first.body.appleRevocation.status, 'revoked');
  assert.ok(first.body.appleRevocation.revokedAt);
  assert.deepEqual((await post('success')).body, first.body);
  assert.equal((await post('success', 'client', {}, missing.api)).status, 200, 'lost-response retries still work if configuration is later removed');
  assert.equal(calls.filter(c => c.path === '/auth/token').length, 1);
  assert.equal(calls.filter(c => c.path === '/auth/revoke').length, 1);
  // Concurrent duplicates are refused promptly; a later replay stays idempotent.
  const concurrent = await Promise.all([post('concurrent'), post('concurrent')]);
  const completed = concurrent.find(row => row.status === 200);
  assert.ok(completed);
  for (const result of concurrent) {
    // A request scheduled after completion can legitimately replay immediately.
    if (result.status === 200) assert.deepEqual(result, completed);
    else { assert.equal(result.status, 409); assert.equal(result.body.error, 'apple_revocation_in_progress'); }
  }
  assert.deepEqual(await post('concurrent'), completed);
  assert.equal(calls.filter(c => c.path === '/auth/token' && c.body.get('code') === 'concurrent').length, 1);
  // This process has no default private key, but its two separately keyed apps
  // must remain configured. Client failures cannot disable supplier or rider.
  for (const role of ['supplier', 'rider']) assert.equal((await post(`${role}-override-no-default`, role, {}, missing.api)).status, 200);
  const beforeMissing = calls.length;
  assert.equal((await post('still-missing-client-key', 'client', {}, missing.api)).body.error, 'apple_revocation_not_configured');
  assert.equal(calls.length, beforeMissing, 'missing bundle keys never call Apple');
  for (const body of [false, true]) {
    const stall = { body, entered: Promise.withResolvers(), closed: Promise.withResolvers(), release: Promise.withResolvers() };
    clerkStall = stall;
    const before = calls.length;
    const code = body ? 'clerk-body-stall' : 'clerk-header-stall';
    const pending = [post(code)];
    try {
      await stall.entered.promise;
      // Mixed same-code/fresh-code duplicates exceed the API process's pool.
      for (let i = 0; i < 12; i++) pending.push(post(i % 2 ? code : `${code}-${i}`));
      await new Promise(resolve => setTimeout(resolve, 100));
      const started = Date.now();
      const health = await request(instance.api, '/health');
      assert.equal(health.status, 200, 'Clerk stalls and duplicates must not exhaust the API pool');
      assert.equal(health.body.database.status, 'available');
      const otherRole = body ? 'super_admin' : 'ops_admin';
      const mutation = await request(instance.api, '/me/account-deletion-request', {
        method: 'POST', token: clerkToken(uid(otherRole)), body: { confirmed: true },
      });
      assert.equal(mutation.status, 202, 'an unrelated mutation must still commit through the same API pool');
      assert.ok(Date.now() - started < 1500, 'unrelated requests must not await the Clerk deadline');
      assert.equal((await database.query("SELECT id FROM account_deletion_requests WHERE user_id=$1 AND status='pending'", [uid(otherRole)])).rowCount, 1);
      const result = await pending[0];
      assert.equal(result.status, 502);
      assert.equal(result.body.error, 'clerk_unavailable');
      assert.ok(Date.now() - started < 6000, 'stalled Clerk response has a bounded deadline');
      await Promise.race([stall.closed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Clerk socket was not aborted')), 1000))]);
      const duplicates = await Promise.all(pending.slice(1));
      assert.ok(duplicates.every(result => result.status === 409 && result.body.error === 'apple_revocation_in_progress'));
      assert.equal(calls.length, before, 'no Apple call is allowed after a stalled Clerk lookup');
    } finally {
      clerkStall = null;
      stall.release.resolve();
      await Promise.allSettled(pending);
    }
    assert.equal((await post(code)).status, 200, 'the same code can succeed after Clerk recovers');
  }
  // Simulate a different API replica owning this user's transaction lock.
  const replicaEntered = Promise.withResolvers();
  const replicaRelease = Promise.withResolvers();
  const replica = database.transaction(async () => { replicaEntered.resolve(); await replicaRelease.promise; }, {
    lockKey: `gridgo-apple-revocation:${uid('client')}`,
  });
  await replicaEntered.promise;
  const beforeReplica = calls.length;
  const contended = post('replica-contention');
  let replicaTimer;
  try {
    const result = await Promise.race([contended,
      new Promise((_, reject) => { replicaTimer = setTimeout(() => reject(new Error('replica lock waiter retained an API connection')), 1500); })]);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'apple_revocation_in_progress');
    assert.equal((await request(instance.api, '/health')).status, 200);
    assert.equal(calls.length, beforeReplica, 'cross-replica conflicts must not call Apple');
  } finally { clearTimeout(replicaTimer); replicaRelease.resolve(); await replica; await Promise.allSettled([contended]); }
  assert.equal((await post('replica-contention')).status, 200);
  for (const [code, status, error] of [
    ['invalid-code', 400, 'invalid_apple_authorization_code'], ['wrong-user', 403, 'apple_identity_mismatch'],
    ['wrong-audience', 502, 'apple_identity_invalid'], ['bad-signature', 502, 'apple_identity_invalid'],
    ['exchange-error', 502, 'apple_token_exchange_failed'], ['malformed', 502, 'apple_token_exchange_failed'],
    ['revoke-error', 502, 'apple_revocation_failed'],
  ]) {
    const result = await post(code);
    assert.equal(result.status, status, code);
    assert.equal(result.body.error, error, code);
    assert.equal(result.body.appleRevocation.status, 'retry_required');
    const count = calls.length;
    assert.deepEqual(await post(code), result, 'same-code failures are replayed without consuming again');
    assert.equal(calls.length, count);
  }
  assert.ok(!calls.some(c => c.path === '/auth/revoke' && /wrong-user|wrong-audience|bad-signature/.test(c.body.get('token'))), 'never revoke a mismatched or invalid identity');
  assert.equal((await post('fresh-after-failure')).status, 200, 'fresh sign-in can recover a consumed code');
  assert.equal((await post('access-only')).status, 200);
  assert.equal(calls.at(-1).body.get('token_type_hint'), 'access_token');
  for (const role of ['supplier', 'rider']) assert.equal((await post(`${role}-success`, role)).status, 200);
  const slow = post('slow-response');
  await slowReady;
  let timer;
  try {
    const duplicates = await Promise.all(Array.from({ length: 12 }, (_, index) => post(index % 2 ? 'slow-response' : `slow-duplicate-${index}`)));
    assert.ok(duplicates.every(row => row.status === 409 && row.body.error === 'apple_revocation_in_progress'));
    assert.equal((await request(instance.api, '/health')).status, 200, 'Apple stalls also leave the API pool available');
    await Promise.race([database.transaction(async () => database.query('SELECT 1')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Apple held the domain lock during token exchange')), 1000); })]);
  } finally { clearTimeout(timer); releaseSlow(); }
  assert.equal((await slow).status, 200);
  const own = await request(instance.api, '/me/account-deletion-request', { token: clerkToken(uid('client')) });
  assert.equal(own.body.request.id, first.body.requestId);
  assert.equal(own.body.request.appleRevocations[0].status, 'revoked');
  assert.equal(own.body.request.appleRevocations[0].clientId, 'ph.gridgo.client');
  const queue = await request(instance.api, '/ops/account-deletion-requests', { token: clerkToken(uid('super_admin')) });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.requests.find(row => row.id === first.body.requestId).appleRevocations[0].status, 'revoked');
  const rows = (await database.query('SELECT * FROM account_deletion_apple_revocations WHERE request_id=$1', [first.body.requestId])).rows;
  const audit = (await database.query("SELECT * FROM audit_log WHERE entity_id=$1 AND action LIKE 'account_deletion_apple_%'", [first.body.requestId])).rows;
  assert.equal(audit.length, rows.length, 'every result has exactly one durable audit, including failures');
  const notes = (await database.query("SELECT user_id FROM notifications WHERE type LIKE 'account_deletion_apple_%' AND user_id LIKE $1", [`${prefix}%`])).rows;
  const attempts = (await database.query(`SELECT a.id FROM account_deletion_apple_revocations a
    JOIN account_deletion_requests r ON r.id=a.request_id WHERE r.user_id LIKE $1`, [`${prefix}%`])).rowCount;
  assert.equal(notes.length, attempts * 2, 'each attempt notifies both current staff memberships');
  assert.ok(notes.every(row => row.user_id.endsWith('_ops_admin') || row.user_id.endsWith('_super_admin')));
  const persisted = JSON.stringify({ rows, audit, queue, logs: instance.output() });
  assert.ok(!/PRIVATE_ACCESS|PRIVATE_REFRESH|DO_NOT_STORE_PROVIDER_DETAILS|authorizationCode|client_secret|id_token/.test(persisted));
  assert.ok(!persisted.includes('eyJ'), 'JWT values never enter persistence, responses or logs');
  assert.ok(!persisted.includes(appleEnv.GRIDGO_APPLE_PRIVATE_KEY));
  for (const pair of Object.values(JSON.parse(appleEnv.GRIDGO_APPLE_SIGNING_KEYS))) assert.ok(!persisted.includes(pair.privateKey), 'override keys never enter persistence or logs');
  // Force audit failure: the result row and its event must roll back together.
  const user = { id: uid('client'), clerkUserId: uid('client') };
  await assert.rejects(routeAccountDeletion({ req: { method: 'POST' }, url: new URL(endpoint, instance.api),
    user, database, readBody: async () => ({ confirmed: true, clientId: 'ph.gridgo.client', authorizationCode: 'rollback-result' }),
    env: appleEnv, loadClerkUser: async id => ({ id, externalAccounts: [{ provider: 'apple', providerUserId: `apple-${id}`, verification: { status: 'verified' } }] }),
    onEvent: async () => { throw new Error('audit rollback'); },
  }), /audit rollback/);
  assert.equal((await database.query("SELECT id FROM account_deletion_apple_revocations WHERE code_digest=$1", [crypto.createHash('sha256').update('rollback-result').digest('hex')])).rowCount, 0);
  const done = await request(instance.api, `/ops/account-deletion-requests/${first.body.requestId}`, {
    method: 'PATCH', token: clerkToken(uid('ops_admin')), body: { status: 'done', confirmed: true },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.request.appleRevocations[0].status, 'revoked');
  assert.deepEqual(await post('success'), first, 'recorded retries remain idempotent after manual completion');
  assert.equal((await post('new-after-completion')).body.error, 'account_deletion_request_required');
});
