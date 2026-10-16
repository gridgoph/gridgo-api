import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;

// A JPEG signature with a tail, so each `n` is a different picture.
const photo = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64 + n, n), Buffer.from([0xff, 0xd9])]);

async function storageStub(t) {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://storage');
    if (url.searchParams.has('location')) { res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<LocationConstraint></LocationConstraint>'); return; }
    if (req.method === 'PUT') {
      const chunks = []; req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => { objects.set(url.pathname, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"fixture"' }); res.end(); });
      return;
    }
    if (req.method === 'DELETE') { objects.delete(url.pathname); res.writeHead(204); res.end(); return; }
    const bytes = objects.get(url.pathname);
    if (!bytes) { res.writeHead(url.pathname.split('/').filter(Boolean).length <= 1 ? 200 : 404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'image/jpeg', ETag: '"fixture"' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, prepare = () => {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1,
    applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT });
  prepare(store);
  await db.transaction(() => saveStore(db, store));
  const storage = await storageStub(t);
  return { db, api: await apiForTest(t, { MINIO_ENDPOINT: storage, MINIO_PUBLIC_URL: storage }) };
}

// File routes answer 503 storage_initializing until boot-time storage
// recovery finishes, which can outlast the first healthy /health.
async function whenStorageReady(send) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await send();
    if (result.status !== 503 || result.body.error !== 'storage_initializing' || attempt >= 200) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function upload(api, key, purpose, bytes, name) {
  const uploaded = await whenStorageReady(() => {
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('file', new Blob([bytes], { type: 'image/jpeg' }), name);
    return api(key, 'POST', '/files', form);
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  return uploaded.body.file.fileId;
}

async function file(api, key, purpose, bytes, name, target) {
  const fileId = await upload(api, key, purpose, bytes, name);
  const attached = await whenStorageReady(() => api(key, 'POST', `/files/${fileId}/attach`, { orderId: 'order', ...target }));
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  return fileId;
}

const stage = (order, code) => order.payoutMilestones.find((milestone) => milestone.code === code);

test('one delivery capture the rider sends twice is one delivered proof for every role', { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t, (store) => {
    Object.assign(store.orders[0], { state: 'out_for_delivery', riderId: 'rider' });
  });
  // What the rider app does: the same capture as the delivery photo and as the
  // delivered Proof of Fulfilment, then delivery names the photo.
  const capture = photo(1);
  const doorstep = await file(api, 'rider', 'delivery_photo', capture, 'delivery-photo-1792118252472.jpeg', {});
  const proof = await file(api, 'rider', 'fulfilment_proof', capture, 'delivery-photo-1792118252472.jpeg', { milestoneCode: 'delivered' });
  const delivered = await api('rider', 'POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: doorstep });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

  for (const key of ['supplier', 'ops', 'admin']) {
    const read = await api(key, 'GET', '/orders/order');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(stage(read.body.order, 'delivered').pofFileIds, [proof], key);
    assert.equal(stage(read.body.order, 'delivered').status, 'pof_attached', key);
  }
  for (const key of ['client', 'rider']) {
    const read = await api(key, 'GET', '/orders/order');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.order.payoutMilestones, undefined, key);
  }
  // The stored stage lists the picture once; the delivery photo stays the
  // delivery evidence.
  const order = (await loadStore(db)).orders[0];
  assert.deepEqual(stage(order, 'delivered').pofFileIds, [proof]);
  assert.equal(order.deliveryEvidence.fileId, doorstep);
});

test('a shop files as many start-of-production photos as it likes, before and after release, each shown once', { skip: !DATABASE_URL }, async (t) => {
  const { db, api } = await setup(t);
  const filed = [];
  for (const n of [11, 12, 13]) {
    filed.push(await file(api, 'supplier', 'fulfilment_proof', photo(n), `IMG_${n}.jpeg`, { milestoneCode: 'production_started' }));
  }
  // The second picture again, as a fresh upload: a retry whose first answer was lost.
  const retried = await file(api, 'supplier', 'fulfilment_proof', photo(12), 'IMG_12.jpeg', { milestoneCode: 'production_started' });
  assert.notEqual(retried, filed[1]);
  for (const key of ['supplier', 'ops', 'admin']) {
    const read = await api(key, 'GET', '/orders/order');
    assert.deepEqual(stage(read.body.order, 'production_started').pofFileIds, filed, key);
  }
  const client = await api('client', 'GET', '/orders/order');
  assert.equal(client.body.order.payoutMilestones, undefined);
  assert.deepEqual(client.body.order.productionProgress.photos.map((item) => item.fileId), filed);

  const released = await api('ops', 'POST', '/orders/order/milestones/production_started/release', { note: 'Proof reviewed' });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  // A released stage still takes more evidence and stays released.
  const later = await file(api, 'supplier', 'fulfilment_proof', photo(14), 'IMG_14.jpeg', { milestoneCode: 'production_started' });
  const read = await api('supplier', 'GET', '/orders/order');
  assert.deepEqual(stage(read.body.order, 'production_started').pofFileIds, [...filed, later]);
  assert.equal(stage(read.body.order, 'production_started').status, 'released');
  const stored = stage((await loadStore(db)).orders[0], 'production_started');
  assert.deepEqual(stored.pofFileIds, [...filed, later]);
});

test('a stage stored with one picture under two uploads is drawn once, without losing a different picture', { skip: !DATABASE_URL }, async (t) => {
  // Uploads from before files were hashed: only what the uploader sent.
  const legacy = (fileId, size, purpose) => ({ fileId, ownerId: 'rider', purpose, state: 'ready', objectKey: `private/${fileId}`,
    originalFilename: 'delivery-photo-1792118252472.jpeg', declaredContentType: 'image/jpeg', detectedContentType: 'image/jpeg',
    size, createdAt: AT, readyAt: AT, references: [{ type: 'order', id: 'order', field: purpose === 'delivery_photo' ? 'deliveryPhotoFileIds' : 'fulfilmentProofFileIds', ...(purpose === 'fulfilment_proof' ? { milestoneCode: 'delivered' } : {}) }] });
  const { db, api } = await setup(t, (store) => {
    const order = store.orders[0];
    Object.assign(order, { state: 'delivered', riderId: 'rider' });
    store.files.push(legacy('legacy_proof', 2048, 'fulfilment_proof'), legacy('legacy_photo', 2048, 'delivery_photo'),
      legacy('legacy_other', 4096, 'delivery_photo'));
    stage(order, 'delivered').pofFileIds = ['legacy_proof', 'legacy_photo', 'legacy_other'];
    stage(order, 'delivered').status = 'pof_attached';
  });
  for (const key of ['supplier', 'ops', 'admin']) {
    const read = await api(key, 'GET', '/orders/order');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(stage(read.body.order, 'delivered').pofFileIds, ['legacy_proof', 'legacy_other'], key);
  }
  // Nothing stored is rewritten to draw it.
  assert.deepEqual(stage((await loadStore(db)).orders[0], 'delivered').pofFileIds, ['legacy_proof', 'legacy_photo', 'legacy_other']);
});
