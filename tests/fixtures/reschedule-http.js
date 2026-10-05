import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { id } from './reschedule.js';
const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = 'https://reschedule-tests.clerk.accounts.dev';
const PARTY = 'http://localhost:19006';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function token(key, extra = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'reschedule-test' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, sub: `clerk_${key}`, sid: `session_${key}`, azp: PARTY,
    iat: seconds - 5, nbf: seconds - 5, exp: seconds + 300, ...extra })).toString('base64url');
  const input = `${head}.${payload}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function apiForTest(t) {
  const storage = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': '100', 'Content-Type': 'image/png', ETag: 'test' }); res.end(); }
    else if (req.method === 'DELETE') { res.writeHead(204); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => storage.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => storage.close(resolve)));
  const storageUrl = `http://127.0.0.1:${storage.address().port}`;
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATABASE_URL,
    CLERK_SECRET_KEY: 'test-only', CLERK_ISSUER: ISSUER, CLERK_AUTHORIZED_PARTIES: PARTY,
    CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    HOST: '127.0.0.1', PORT: String(port), MINIO_ENDPOINT: storageUrl, MINIO_PUBLIC_URL: storageUrl,
    MINIO_ACCESS_KEY: 'reschedule-test', MINIO_SECRET_KEY: 'reschedule-test-secret', MINIO_BUCKET: 'reschedule-test',
    GRIDGO_LIFECYCLE_INTERVAL_MS: '3600000', GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } });
  const origin = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${origin}/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(healthy, output);
  return async (key, method, path, body, opts = {}) => {
    const res = await fetch(`${origin}${path}`, { method,
      headers: { ...(key ? { Authorization: `Bearer ${token(key, opts.claims)}` } : {}),
        'Content-Type': 'application/json', 'Idempotency-Key': opts.key || id('httpkey'), ...opts.headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
}

