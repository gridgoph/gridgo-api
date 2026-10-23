import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadPushDeliveryStore } from '../src/postgres-store.js';
import { loadVapid, validSubscription, validPushEndpoint, routeWebPush, createWebPushDelivery } from '../src/web-push.js';
import { enqueueNotificationPushes, createOutboxWorker } from '../src/push-outbox.js';

const databaseUrl = process.env.DATABASE_URL;
function subscription(suffix = 'one') {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return { endpoint: `https://web.push.apple.com/${suffix}`, keys: {
    p256dh: key.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url'),
  } };
}

test('browser subscription validation refuses arbitrary destinations and invalid curve keys', () => {
  assert.ok(validSubscription(subscription()));
  for (const endpoint of ['http://web.push.apple.com/x', 'https://localhost/x', 'https://127.0.0.1/x',
    'https://web.push.apple.com.evil.test/x', 'https://user:pass@web.push.apple.com/x',
    'https://web.push.apple.com:8443/x', 'https://web.push.apple.com/x#fragment']) assert.equal(validPushEndpoint(endpoint), false);
  assert.equal(validSubscription({ ...subscription(), keys: { p256dh: Buffer.alloc(65).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } }), false);
});

async function fixture(db) {
  const prefix = `web_${crypto.randomUUID()}`;
  const at = new Date().toISOString();
  await db.transaction(async () => {
    const store = await loadStore(db);
    for (const suffix of ['a', 'b', 'c']) {
      const id = prefix + suffix;
      const role = suffix === 'c' ? 'client' : 'supplier';
      store.users.push({ id, clerkUserId: id, email: `${id}@test.invalid`, name: 'Web test', role, verificationStatus: role === 'supplier' ? 'pending' : undefined, accountType: role === 'client' ? 'individual' : undefined, createdAt: at });
      store.userRoleMemberships.push({ userId: id, role, createdAt: at });
      if (role === 'client') store.clientProfiles.push({ userId: id, clientKind: 'personal', updatedAt: at });
    }
    await saveStore(db, store);
  });
  return { prefix, a: prefix + 'a', b: prefix + 'b', c: prefix + 'c', async cleanup() {
    await db.transaction(async () => {
      for (const table of ['notifications', 'device_tokens', 'client_profiles', 'user_role_memberships'])
        await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1)`, [[prefix+'a', prefix+'b', prefix+'c']]);
      await db.query('DELETE FROM users WHERE id=ANY($1)', [[prefix+'a', prefix+'b', prefix+'c']]);
    });
  } };
}

test('PostgreSQL Web Push keys, atomic outbox, encrypted transport, retry, role suppression and pruning', { skip: !databaseUrl }, async () => {
  const db = createDatabase({ DATABASE_URL: databaseUrl });
  const f = await fixture(db).catch(async error => { await db.close(); throw error; });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gridgo-web-push-'));
  let server;
  try {
    const [vapid, concurrent] = await Promise.all([loadVapid(db, {}), loadVapid(db, {})]);
    assert.deepEqual(vapid, concurrent);
    assert.deepEqual(await loadVapid(db, {}), vapid, 'persisted keys survive a new load');
    const envKeys = webpush.generateVAPIDKeys();
    assert.deepEqual(await loadVapid(db, { VAPID_PUBLIC_KEY: envKeys.publicKey, VAPID_PRIVATE_KEY: envKeys.privateKey, VAPID_SUBJECT: 'mailto:test@example.com' }), { ...envKeys, subject: 'mailto:test@example.com' });
    await assert.rejects(loadVapid(db, { VAPID_PUBLIC_KEY: envKeys.publicKey }));
    await assert.rejects(loadVapid(db, { VAPID_PUBLIC_KEY: envKeys.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.com' }));

    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${temp}/key.pem`, '-out', `${temp}/cert.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    let status = 503;
    const received = [];
    server = https.createServer({ key: await readFile(`${temp}/key.pem`), cert: await readFile(`${temp}/cert.pem`) }, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status); res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const agent = new https.Agent({ rejectUnauthorized: false }); // local fake service only
    const payloads = [];
    const delivery = createWebPushDelivery({ vapid, sendNotification: (sub, payload, options) => {
      payloads.push(JSON.parse(payload));
      return webpush.sendNotification({ ...sub, endpoint: `https://127.0.0.1:${server.address().port}/push` }, payload, { ...options, agent });
    } });
    const call = (userId, pathname, body, method = 'POST') => db.transaction(async () => routeWebPush({
      database: db, store: await loadStore(db), user: { id: userId }, pathname, method, body,
      userAgent: 'test-browser', delivery,
    }));
    const sub = subscription(f.prefix);
    assert.equal((await call(f.c, '/web-push/subscribe', { subscription: sub })).status, 403);
    assert.deepEqual((await call(f.a, '/web-push/public-key', null, 'GET')).body, { publicKey: vapid.publicKey });
    assert.equal((await call(f.a, '/web-push/subscribe', { subscription: sub })).status, 200);
    const row = () => db.query('SELECT * FROM web_push_subscriptions WHERE endpoint=$1', [sub.endpoint]).then(r => r.rows[0]);
    const firstId = (await row()).id;
    await call(f.a, '/web-push/subscribe', { subscription: sub });
    assert.equal((await row()).id, firstId, 'ordinary refresh preserves queued work');
    await call(f.b, '/web-push/unsubscribe', { endpoint: sub.endpoint });
    assert.ok(await row(), 'another account cannot unsubscribe');
    const queue = async (suffix, fields = {}, rollback = false) => db.transaction(async () => {
      const store = await loadStore(db);
      const notification = { id: f.prefix + suffix, userId: f.a, appRole: 'supplier', type: 'general', title: 'Private shop detail', body: 'Private payout detail', at: new Date().toISOString(), ...fields };
      store.notifications.push(notification);
      await saveStore(db, store);
      const queued = await enqueueNotificationPushes(db, store, [notification]);
      if (rollback) throw new Error('rollback');
      return queued;
    });
    await assert.rejects(queue('rollback', {}, true), /rollback/);
    assert.equal((await db.query('SELECT 1 FROM notification_push_outbox WHERE user_id=$1', [f.a])).rowCount, 0);
    assert.equal(await queue('silent', { push: false }), 0);
    assert.equal(await queue('client', { appRole: 'client' }), 0);
    assert.equal(await queue('send'), 1);
    const drain = createOutboxWorker({ database: db, loadStore: loadPushDeliveryStore, delivery: { configured: false }, webDelivery: delivery });
    await drain();
    let attempt = (await db.query('SELECT * FROM notification_push_outbox WHERE user_id=$1', [f.a])).rows[0];
    assert.equal(attempt.status, 'pending');
    assert.equal(attempt.last_code, 'web_push_503');
    assert.ok((await row()).last_failure_at);
    assert.equal(received[0].headers['content-encoding'], 'aes128gcm');
    assert.match(received[0].headers.authorization, /^vapid /);
    assert.equal(received[0].body.includes(Buffer.from('GRIDGO')), false, 'payload is encrypted on the wire');
    assert.equal(payloads[0].title, 'GRIDGO update');
    assert.equal(payloads[0].body, 'Open GRIDGO for the latest update.');
    assert.equal(payloads[0].url, '/supplier');
    assert.deepEqual(Object.keys(payloads[0].data).sort(), ['at', 'notificationId', 'type']);
    status = 201;
    await db.query('UPDATE notification_push_outbox SET next_attempt_at=now() WHERE user_id=$1', [f.a]);
    await drain();
    assert.equal((await db.query('SELECT status FROM notification_push_outbox WHERE user_id=$1', [f.a])).rows[0].status, 'delivered');
    assert.ok((await row()).last_success_at);
    assert.equal((await row()).last_failure_code, null);
    await queue('rebound');
    await call(f.b, '/web-push/subscribe', { subscription: sub });
    assert.notEqual((await row()).id, firstId);
    await drain();
    assert.equal(received.length, 2, 'old account queued work is deleted on reassignment');
    await call(f.a, '/web-push/subscribe', { subscription: sub });
    await queue('removed-role');
    await db.query("DELETE FROM user_role_memberships WHERE user_id=$1 AND role='supplier'", [f.a]);
    await drain();
    assert.equal(received.length, 2, 'membership checked at delivery');
    await db.query("INSERT INTO user_role_memberships(user_id, role, created_at) VALUES ($1,'supplier',now())", [f.a]);
    for (const gone of [404, 410]) {
      await call(f.a, '/web-push/subscribe', { subscription: sub });
      await queue(`gone${gone}`);
      status = gone;
      await drain();
      assert.equal(await row(), undefined);
    }
    agent.destroy();
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(temp, { recursive: true, force: true });
    await f.cleanup(); await db.close();
  }
});

test('HTTP Web Push requires Clerk supplier membership, keeps credentials private, and unregisters on logout', { skip: !databaseUrl }, async () => {
  const db = createDatabase({ DATABASE_URL: databaseUrl });
  const f = await fixture(db).catch(async error => { await db.close(); throw error; });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://casual-crab-9.clerk.accounts.dev';
  const party = 'http://localhost:19006';
  const token = subject => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: issuer, sub: subject, sid: `sess_${subject}`, azp: party, iat: now - 5, nbf: now - 5, exp: now + 300 })).toString('base64url');
    return `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
  };
  let child;
  try {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, ['src/server.js'], { env: {
      ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl,
      CLERK_SECRET_KEY: 'test-only-placeholder', CLERK_ISSUER: issuer,
      CLERK_AUTHORIZED_PARTIES: party, CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
      HOST: '127.0.0.1', PORT: String(port), VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '',
      GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: '0',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode != null) throw new Error(`API exited: ${output}`);
      try { if ((await fetch(`${origin}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, output);
    const call = async (pathname, subject, body) => {
      const response = await fetch(origin + pathname, { method: body ? 'POST' : 'GET', headers: {
        ...(subject ? { Authorization: `Bearer ${token(subject)}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const sub = subscription(f.prefix);
    for (const [route, body] of [['/web-push/public-key', null], ['/web-push/subscribe', { subscription: sub }], ['/web-push/unsubscribe', { endpoint: sub.endpoint }]]) {
      assert.equal((await call(route, null, body)).status, 401);
      assert.equal((await call(route, f.c, body)).status, 403);
    }
    const publicResult = await call('/web-push/public-key', f.a);
    assert.equal(publicResult.status, 200);
    assert.deepEqual(Object.keys(publicResult.body), ['publicKey']);
    assert.equal(publicResult.body.publicKey, (await loadVapid(db, {})).publicKey);
    assert.equal((await call('/web-push/subscribe', f.a, { subscription: { ...sub, endpoint: 'https://localhost/private' } })).status, 400);
    assert.deepEqual(await call('/web-push/subscribe', f.a, { subscription: sub, userId: f.b, appRole: 'client' }), { status: 200, body: { ok: true } });
    const stored = () => db.query('SELECT user_id, app_role FROM web_push_subscriptions WHERE endpoint=$1', [sub.endpoint]).then(r => r.rows);
    assert.deepEqual(await stored(), [{ user_id: f.a, app_role: 'supplier' }]);
    assert.equal((await call('/auth/logout', f.b, { webPushEndpoint: sub.endpoint })).status, 200);
    assert.equal((await stored()).length, 1);
    assert.equal((await call('/auth/logout', f.a, { webPushEndpoint: sub.endpoint })).status, 200);
    assert.equal((await stored()).length, 0);
  } finally {
    if (child && child.exitCode == null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await f.cleanup(); await db.close();
  }
});

test('Web Push click URLs open the order and failures never reveal provider secrets', async () => {
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:test@example.com' };
  const messages = [];
  const delivery = createWebPushDelivery({ vapid, sendNotification: async (_sub, payload) => { messages.push(JSON.parse(payload)); } });
  await delivery.send({ title: 'GRIDGO update', body: 'Open GRIDGO', data: { orderId: 'order_123', type: 'new_job' } }, [subscription()]);
  assert.equal(messages[0].url, '/supplier/jobs/order_123');
  await delivery.send({ title: 'GRIDGO update', body: 'Open GRIDGO', data: { orderId: '//external.test/?secret' } }, [subscription()]);
  assert.equal(messages[1].url, '/supplier/jobs/%2F%2Fexternal.test%2F%3Fsecret');
  const failing = createWebPushDelivery({ vapid, sendNotification: async () => { throw new Error('private endpoint and auth secret'); } });
  assert.deepEqual(await failing.send({ title: 't', body: 'b', data: {} }, [subscription()]), [{ ok: false, prune: false, code: 'web_push_transport_error' }]);
});
