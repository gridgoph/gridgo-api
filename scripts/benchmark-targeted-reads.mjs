/** Destructive synthetic benchmark. Run ONLY against a private migrated test DB.
 * DATABASE_URL=..._test MINIO_... node scripts/benchmark-targeted-reads.mjs
 * Reports API request-log timings (JWT signed locally; no Clerk/production calls),
 * plus rows transferred by the complete and scoped readers at 1x and 10x history.
 */
import './assert-test-database.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadHotReadStore, loadInboxStore, loadPushDeliveryStore, loadDeliveryStore, loadClientBootstrapStore } from '../src/postgres-store.js';
import { seedReferenceData } from '../src/seed.js';
import { resetDatabase } from '../tests/fixtures/reset-database.js';

const database = createDatabase(process.env);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://benchmark.clerk.accounts.dev', party = 'http://localhost:19006';
const samples = Number(process.env.PERF_SAMPLES || 10);
const baseRows = Number(process.env.PERF_BASE_ROWS || 10000);
function token(subject = 'clerk_perf_ops') {
  const now = Math.floor(Date.now() / 1000);
  const parts = [Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'perf' })).toString('base64url'), Buffer.from(JSON.stringify({ iss: issuer, sub: subject, sid: 'perf-session', azp: party, iat: now - 5, nbf: now - 5, exp: now + 3600 })).toString('base64url')];
  const payload = parts.join('.');
  return `${payload}.${crypto.sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture() {
  await resetDatabase(database, 'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  await seedReferenceData(database);
  const at = new Date().toISOString();
  await database.transaction(async () => {
    const store = await loadStore(database);
    for (const role of ['ops_admin', 'client', 'rider']) {
      const id = role === 'ops_admin' ? 'perf_ops' : `perf_${role}`;
      store.users.push({ id, clerkUserId: `clerk_${id}`, email: `${id}@example.test`, name: id, role, accountType: role === 'client' ? 'individual' : undefined, verificationStatus: role === 'rider' ? 'unverified' : undefined, createdAt: at });
      store.userRoleMemberships.push({ userId: id, role, createdAt: at });
    }
    store.orders.push({ id: 'perf_order', title: 'Historical job', clientId: 'perf_client', state: 'cancelled', cancelledAt: at, cancellationReason: 'Synthetic historical benchmark', fulfillmentMode: 'pickup', supplierSubtotalMinor: 10000, subtotalMinor: 10000, serviceFeeRateBps: 1000, serviceFeeMinor: 1000, deliveryFeeMinor: 0, totalMinor: 11000, riderCommissionBps: 8500, moneyModelVersion: 2, payoutHold: false, payments: { initial: { amountMinor: 8250, method: 'qr_manual', status: 'not_submitted' }, final_online: { amountMinor: 2750, method: 'qr_manual', status: 'not_submitted' } }, payoutMilestones: [], paymentAllocations: [], revenueAdjustments: [], createdAt: at, updatedAt: at });
    store.deviceTokens.push({ id: 'perf_device', userId: 'perf_ops', token: 'perf_token', platform: 'android', createdAt: at, updatedAt: at });
    await saveStore(database, store);
  });
}
async function grow(from, to) {
  await database.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data)
    SELECT 'perf_notice_'||i,'perf_ops','general',now()-i*interval '1 second',i,jsonb_build_object('title','Notice','body',repeat('x',100)) FROM generate_series($1::int,$2::int) i`, [from, to]);
  await database.query(`INSERT INTO audit_log(id,at,action,position,data)
    SELECT 'perf_audit_'||i,now(),'benchmark.history',i,jsonb_build_object('detail',repeat('x',100)) FROM generate_series($1::int,$2::int) i`, [from, to]);
  await database.query(`INSERT INTO location_pings(id,order_id,rider_id,lat,lng,at,position)
    SELECT 'perf_ping_'||i,'perf_order','perf_rider',7,125,now()-i*interval '1 second',i FROM generate_series($1::int,$2::int) i`, [from, to]);
  await database.query(`INSERT INTO notification_push_outbox(notification_id,device_id,user_id,status)
    SELECT 'perf_notice_'||i,'perf_device','perf_ops','delivered' FROM generate_series($1::int,$2::int) i`, [from, to]);
  await database.query('ANALYZE');
}
async function readerRows() {
  async function count(fn) {
    let rows = 0, queries = 0;
    const db = { ...database, query: async (...args) => { const r = await database.query(...args); rows += r.rows.length; queries++; return r; } };
    await fn(db); return { rows, queries };
  }
  return {
    full: await count(loadStore),
    settings: await count(db => loadHotReadStore(db, 'clerk_perf_ops', '/settings')),
    inbox: await count(db => loadInboxStore(db, 'clerk_perf_ops')),
    clientBootstrap: await count(db => loadClientBootstrapStore(db, 'perf_client')),
    realtime: await count(db => loadDeliveryStore(db, { userIds: ['perf_ops'] })),
    push: await count(db => loadPushDeliveryStore(db, [{ user_id: 'perf_ops', notification_id: 'perf_notice_1', device_id: 'perf_device' }])),
  };
}
async function measure(scale) {
  const port = await freePort();
  // Clerk identity fetch is deterministic local 404; token verification remains
  // real RSA/issuer/azp verification. Never contact a real identity provider.
  const clerk = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"errors":[{"code":"not_found"}]}'); });
  clerk.listen(0, '127.0.0.1'); await once(clerk, 'listening');
  // Optional baseline application, loaded from Git without another checkout or
  // modifying the worktree. Load all src modules at that ref, including readers.
  const hook = `import { registerHooks } from 'node:module';
    import { execFileSync } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    import { relative } from 'node:path';
    registerHooks({load(url, context, next) {
      if (!url.startsWith('file:')) return next(url,context);
      const path = relative(process.cwd(), fileURLToPath(url));
      if (!path.startsWith('src/') || !path.endsWith('.js')) return next(url,context);
      const source = execFileSync('git', ['show', process.env.PERF_SERVER_REF + ':' + path], {encoding:'utf8'});
      return {format:'module',source,shortCircuit:true};
    }});`;
  const args = process.env.PERF_SERVER_REF ? ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, 'src/server.js'] : ['src/server.js'];
  const child = spawn(process.execPath, args, { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', CLERK_SECRET_KEY: 'test-only-placeholder', CLERK_ISSUER: issuer, CLERK_AUTHORIZED_PARTIES: party, CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }), CLERK_API_URL: `http://127.0.0.1:${clerk.address().port}`, GRIDGO_LIFECYCLE_INTERVAL_MS: '3600000', GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: '0', GRIDGO_FCM_SERVICE_ACCOUNT_FILE: '', GRIDGO_APNS_KEY_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode != null || i > 200) throw new Error(`API startup failed: ${output}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // Wait for startup lifecycle work so the sample excludes startup contention.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const paths = ['/notifications', '/settings', '/taxonomy', '/auth/me/ops', '/auth/me', '/ops/product-type-requests', '/ops/catalog-reviews', '/ops/shop-failures', '/ops/colour-price-checks', '/me', '/auth/me/client', '/auth/me?client'];
    const subjectFor = path => ['/me', '/auth/me/client', '/auth/me?client'].includes(path) ? 'clerk_perf_client' : 'clerk_perf_ops';
    for (const path of paths) {
      const warm = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token(subjectFor(path))}` } });
      assert.equal(warm.status, 200, `${path}: ${await warm.text()}`);
    }
    const timings = {};
    for (const path of paths) {
      await new Promise(resolve => setTimeout(resolve, 50)); output = '';
      for (let i = 0; i < samples; i++) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token(subjectFor(path))}` } });
        assert.equal(response.status, 200, path); await response.arrayBuffer();
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      const values = [...output.matchAll(/\[gridgo-api\] GET (\S+) 200 (\d+)ms/g)].filter(m => m[1] === path.split('?')[0]).map(m => Number(m[2])).sort((a, b) => a - b);
      assert.equal(values.length, samples, `request log samples ${path}`);
      timings[path] = { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.ceil(values.length * .95) - 1] };
    }
    console.log(JSON.stringify({ label: process.env.PERF_LABEL || 'current', serverRef: process.env.PERF_SERVER_REF || 'working-tree', scale, rowsPerHistoryTable: baseRows * scale, timings, readerRef: 'working-tree', reads: await readerRows() }));
    if (process.env.PERF_PRINT_LOGS === '1') console.log(output);
  } finally {
    // Only the child PID created by this process is signalled.
    if (child.exitCode == null && child.signalCode == null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await new Promise(resolve => clerk.close(resolve));
  }
}
try {
  await fixture(); await grow(1, baseRows); await measure(1);
  await grow(baseRows + 1, baseRows * 10); await measure(10);
} finally { await database.close(); }
