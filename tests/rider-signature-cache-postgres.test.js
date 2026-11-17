import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const PRIVATE_CACHE = 'private, no-store, max-age=0';
const ok = (result, status = 200) => {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
};
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const proxied of [false, true]) test(`recipient signature forbids caching on API reads and ${proxied ? 'proxied' : 'direct'} signed image responses`, { skip: !DATABASE_URL }, async t => {
  const png = await readFile(new URL('./fixtures/artwork-check/pixel.png', import.meta.url));
  const bucket = 'signature-cache-test';
  const objects = new Map([
    [`/${bucket}/private/drop`, { bytes: png }],
    [`/${bucket}/private/control`, { bytes: png, cache: PRIVATE_CACHE }],
  ]);
  const origin = await listen(t, http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://storage.test');
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(url.pathname, { bytes: Buffer.concat(chunks), cache: req.headers['cache-control'] });
      res.writeHead(200, { ETag: '"signature-test"' }); res.end(); return;
    }
    if (req.method === 'HEAD' && url.pathname === `/${bucket}`) {
      res.writeHead(200); res.end(); return;
    }
    const object = objects.get(url.pathname);
    if (!object) { res.writeHead(404); res.end(); return; }
    const cache = url.searchParams.get('response-cache-control') ?? object.cache;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': object.bytes.length,
      ETag: '"signature-test"', ...(cache ? { 'Cache-Control': cache } : {}) });
    res.end(req.method === 'HEAD' ? undefined : object.bytes);
  }));
  // Preserve Host and signed query parameters through the same public-origin
  // reverse-proxy arrangement used by deployed object storage.
  const publicOrigin = proxied ? await listen(t, http.createServer((req, res) => {
    const upstream = http.request(`${origin}${req.url}`, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', error => res.destroy(error)); req.pipe(upstream);
  })) : origin;

  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  Object.assign(store.orders[0], { state: 'out_for_delivery', riderId: 'rider', riderAssignedAt: AT,
    riderProgress: { riderId: 'rider', assignedAt: AT, events: { arrived: AT } } });
  for (const [fileId, purpose, ownerId] of [['drop', 'delivery_photo', 'rider'], ['control', 'supplier_invoice', 'supplier']]) {
    store.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`,
      originalFilename: 'evidence.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: png.length,
      createdAt: AT, references: [{ type: 'order', id: 'order', field: `${purpose}FileIds` }] });
  }
  await db.transaction(() => saveStore(db, store));
  const api = await apiForTest(t, { MINIO_ENDPOINT: origin, MINIO_PUBLIC_URL: publicOrigin,
    MINIO_BUCKET: bucket, MINIO_ACCESS_KEY: 'signature-cache-test', MINIO_SECRET_KEY: 'signature-cache-test-secret' });
  const form = new FormData();
  form.set('purpose', 'acknowledgement_signature');
  form.set('file', new Blob([png], { type: 'image/png' }), 'signature.png');
  const fileId = ok(await api('rider', 'POST', '/files', form), 201).file.fileId;
  const file = (await loadStore(db)).files.find(row => row.fileId === fileId);
  const object = objects.get(`/${bucket}/${file.objectKey}`);
  assert.deepEqual(object.bytes, png);
  const uploadedCache = object.cache;
  const receipt = ok(await api('rider', 'POST', '/orders/order/acknowledgement-receipt', {}), 201).receipt;
  ok(await api('rider', 'POST', `/files/${fileId}/attach`, { orderId: 'order' }));
  ok(await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'drop',
    receiptMode: 'digital', acknowledgementSignature: { fileId, signerName: 'Recipient', arNumber: receipt.arNumber } }));
  const control = await api('ops', 'GET', '/files/control'); ok(control);
  // Previously uploaded objects have no cache metadata. The signed override
  // must protect their bytes as well as newly uploaded signatures.
  delete object.cache;
  for (const reader of ['client', 'ops']) {
    const metadata = await api(reader, 'GET', `/files/${fileId}`); ok(metadata);
    assert.equal(metadata.headers.get('cache-control'), PRIVATE_CACHE);
    for (const header of ['vary', 'pragma']) assert.equal(metadata.headers.get(header), control.headers.get(header));
    const signed = await api(reader, 'GET', `/files/${fileId}/download-url`); ok(signed);
    assert.equal(signed.headers.get('cache-control'), PRIVATE_CACHE);
    for (const header of ['vary', 'pragma']) assert.equal(signed.headers.get(header), control.headers.get(header));
    assert.equal(new URL(signed.body.url).origin, publicOrigin);
    assert.equal(new URL(signed.body.url).searchParams.get('response-cache-control'), PRIVATE_CACHE);
    const image = await fetch(signed.body.url);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('cache-control'), PRIVATE_CACHE);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  }
  assert.equal(uploadedCache, PRIVATE_CACHE);
  for (const reader of ['rider', 'supplier', 'other']) {
    assert.equal((await api(reader, 'GET', `/files/${fileId}/download-url`)).status, 403);
  }
});
