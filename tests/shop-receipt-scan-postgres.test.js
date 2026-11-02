import { resetDatabase } from './fixtures/reset-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';

const DATABASE_URL = process.env.DATABASE_URL;
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);

async function storageStub(t) {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://storage');
    if (url.searchParams.has('location')) { res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<LocationConstraint></LocationConstraint>'); return; }
    if (req.method === 'PUT') {
      const chunks = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { objects.set(url.pathname, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"fixture"' }); res.end(); });
      return;
    }
    if (req.method === 'DELETE') { objects.delete(url.pathname); res.writeHead(204); res.end(); return; }
    const bytes = objects.get(url.pathname);
    if (!bytes) {
      // Pre-seeded fixture objects report the 100-byte size their file rows declare.
      if (url.pathname.includes('/private/')) { res.writeHead(200, { 'Content-Length': '100', 'Content-Type': 'image/png', ETag: '"fixture"' }); res.end(); return; }
      res.writeHead(url.pathname.split('/').filter(Boolean).length <= 1 ? 200 : 404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'image/jpeg', ETag: '"fixture"' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, change = () => {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1,
    applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT });
  for (const purpose of ['production_photo', 'packing_photo', 'supplier_invoice']) store.files.push({
    fileId: purpose, purpose, ownerId: 'supplier', state: 'ready', objectKey: `private/${purpose}`,
    originalFilename: 'scan.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [],
  });
  change(store);
  await db.transaction(() => saveStore(db, store));
  const storage = await storageStub(t);
  return { db, api: await apiForTest(t, { MINIO_ENDPOINT: storage, MINIO_PUBLIC_URL: storage }) };
}
async function whenStorageReady(send) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await send();
    if (result.status !== 503 || result.body.error !== 'storage_initializing' || attempt >= 200) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const attach = (api, fileId, actor = 'supplier') => whenStorageReady(() => api(actor, 'POST', `/files/${fileId}/attach`, { orderId: 'order' }));
const move = (api, state, actor = 'supplier', extra = {}) => api(actor, 'POST', '/orders/order/transition', { state, ...extra });
const gateOn = store => { store.settings.shopReceiptScanRequired = true; };
async function photos(api) {
  assert.equal((await attach(api, 'production_photo')).status, 200);
  assert.equal((await attach(api, 'packing_photo')).status, 200);
}
const offered = async api => (await api('rider', 'GET', '/dispatch/offers')).body.offers.map(order => order.id);

test('the receipt-scan switch defaults off and leaves Ready for rider pickup unchanged', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const settings = await api('ops', 'GET', '/settings');
  assert.equal(settings.body.settings.shopReceiptScanRequired, false);
  await photos(api);
  const job = (await api('supplier', 'GET', '/jobs')).body.jobs[0];
  assert.deepEqual(job.transitionReadiness.ready_for_dispatch.receiptScan, { required: false, attached: false });
  assert.equal(job.transitionReadiness.ready_for_dispatch.allowed, true);
  assert.equal((await move(api, 'ready_for_dispatch')).status, 200);
  assert.deepEqual(await offered(api), ['order']);
  assert.equal((await loadStore(db)).orders[0].state, 'ready_for_dispatch');
});

test('only Super Admin changes the version-checked switch and every change is audited', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const { version } = (await api('admin', 'GET', '/settings')).body;
  const body = { expectedVersion: version, reason: 'Finance pilot: scans before dispatch', shopReceiptScanRequired: true };
  assert.equal((await api('ops', 'PATCH', '/settings', body)).status, 403);
  assert.equal((await api('supplier', 'PATCH', '/settings', body)).status, 403);
  const invalid = await api('admin', 'PATCH', '/settings', { ...body, shopReceiptScanRequired: 'yes' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_shop_receipt_scan_required');
  const stale = await api('admin', 'PATCH', '/settings', { ...body, expectedVersion: version - 1 });
  assert.equal(stale.body.error, 'settings_version_conflict');
  const saved = await api('admin', 'PATCH', '/settings', body);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.shopReceiptScanRequired, true);
  assert.equal(saved.body.version, version + 1);
  assert.equal((await api('ops', 'GET', '/settings')).body.settings.shopReceiptScanRequired, true);
  // A later unrelated settings edit keeps the switch where it was.
  const unrelated = await api('admin', 'PATCH', '/settings', { expectedVersion: version + 1, reason: 'Fee note', issueWindowHours: 24 });
  assert.equal(unrelated.body.settings.shopReceiptScanRequired, true);
  const rows = (await loadStore(db)).auditLog.filter(row => row.action === 'settings.operational_update');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actorId, 'admin');
  assert.equal(rows[0].reason, 'Finance pilot: scans before dispatch');
  assert.equal(rows[0].detail.previous.shopReceiptScanRequired ?? false, false);
  assert.equal(rows[0].detail.current.shopReceiptScanRequired, true);
});

test('with the switch on the shop cannot call a rider until its scan is attached', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, gateOn);
  await photos(api);
  const job = (await api('supplier', 'GET', '/jobs')).body.jobs[0];
  assert.deepEqual(job.transitionReadiness.ready_for_dispatch.receiptScan, { required: true, attached: false });
  assert.deepEqual(job.transitionReadiness.ready_for_dispatch.missing.map(item => item.code), ['receipt_scan_required']);
  assert.equal(job.transitionReadiness.supplier_self_qc.receiptScan.required, false);
  const denied = await move(api, 'ready_for_dispatch');
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, 'receipt_scan_required');
  assert.match(denied.body.message, /receipt/);
  assert.deepEqual(denied.body.missing.map(item => item.code), ['receipt_scan_required']);
  assert.deepEqual(await offered(api), []);
  // The shop may still finish self-QC; only the dispatch step waits for the scan.
  assert.equal((await move(api, 'supplier_self_qc')).status, 200);
  assert.equal((await move(api, 'ready_for_dispatch')).body.error, 'receipt_scan_required');
  const refusals = (await api('ops', 'GET', '/audit?action=order.transition_refused&orderId=order')).body.audit;
  assert.ok(refusals.length >= 2 && refusals.every(row => row.detail.code === 'receipt_scan_required'));

  const attached = await attach(api, 'supplier_invoice');
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.deepEqual(attached.body.order.transitionReadiness.ready_for_dispatch.receiptScan, { required: true, attached: true });
  assert.equal((await move(api, 'ready_for_dispatch')).status, 200);
  assert.deepEqual(await offered(api), ['order']);
  const accepted = await api('rider', 'POST', '/dispatch/order/accept', {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const saved = await loadStore(db);
  assert.equal(saved.orders[0].state, 'rider_assigned');
  assert.ok(saved.auditLog.some(row => row.action === 'supplier_invoice.scan_attached' && row.orderId === 'order'));
});

test('another shop or a client cannot attach a scan that satisfies the gate', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t, store => {
    gateOn(store);
    store.files.push({ ...store.files.find(file => file.fileId === 'supplier_invoice'), fileId: 'foreign', ownerId: 'replacement', objectKey: 'private/foreign' });
  });
  await photos(api);
  assert.equal((await attach(api, 'foreign', 'replacement')).status, 403);
  assert.equal((await attach(api, 'supplier_invoice', 'client')).status, 403);
  assert.equal((await move(api, 'ready_for_dispatch')).body.error, 'receipt_scan_required');
});

test('an Operations forced step records the missing scan instead of silently skipping it', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, gateOn);
  const forced = await move(api, 'ready_for_dispatch', 'ops', { reasonCode: 'evidence_verified_offline', reason: 'Shop app cannot upload; paper copy seen at counter' });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  const saved = await loadStore(db);
  const step = saved.orders[0].forcedSteps.at(-1);
  assert.ok(step.skippedChecks.includes('receipt_scan_required'));
  const row = saved.auditLog.find(entry => entry.action === 'order.production_override');
  assert.equal(row.detail.receiptScanMissing, true);
});

test('orders already ready when the switch turns on keep their offer and pickup', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  await photos(api);
  assert.equal((await move(api, 'ready_for_dispatch')).status, 200);
  const { version } = (await api('admin', 'GET', '/settings')).body;
  assert.equal((await api('admin', 'PATCH', '/settings', { expectedVersion: version, reason: 'Enable scans', shopReceiptScanRequired: true })).status, 200);
  assert.deepEqual(await offered(api), ['order']);
  assert.equal((await api('rider', 'POST', '/dispatch/order/accept', {})).status, 200);
  assert.equal((await loadStore(db)).orders[0].state, 'rider_assigned');
});

test('Operations and Super Admin see the scan on order lists and details; clients and riders never do', { skip: !DATABASE_URL }, async t => {
  const { api } = await setup(t, store => {
    store.files.push({ ...store.files.find(file => file.fileId === 'supplier_invoice'), fileId: 'second_scan', objectKey: 'private/second', createdAt: '2026-10-05T01:00:00.000Z' });
  });
  for (const actor of ['ops', 'admin']) {
    const before = (await api(actor, 'GET', '/orders')).body.orders.find(order => order.id === 'order');
    assert.deepEqual(before.receiptScan, { attached: false, fileIds: [], latestFileId: null, latestUploadedAt: null });
  }
  await attach(api, 'supplier_invoice');
  await attach(api, 'second_scan');
  for (const actor of ['ops', 'admin']) {
    const listed = (await api(actor, 'GET', '/orders')).body.orders.find(order => order.id === 'order');
    assert.deepEqual(listed.receiptScan, { attached: true, fileIds: ['supplier_invoice', 'second_scan'],
      latestFileId: 'second_scan', latestUploadedAt: '2026-10-05T01:00:00.000Z' });
    const detail = (await api(actor, 'GET', '/orders/order')).body.order;
    assert.deepEqual(detail.receiptScan, listed.receiptScan);
    const signed = await api(actor, 'GET', `/files/${detail.receiptScan.latestFileId}`);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
  }
  const client = (await api('client', 'GET', '/orders/order')).body.order;
  assert.equal(client.receiptScan, undefined);
  assert.equal(client.supplierInvoiceFileIds, undefined);
  assert.equal(JSON.stringify(client).includes('second_scan'), false);
  assert.equal((await api('client', 'GET', '/files/supplier_invoice')).status, 403);
  assert.equal((await api('rider', 'GET', '/files/supplier_invoice')).status, 403);
  const shop = (await api('supplier', 'GET', '/orders/order')).body.order;
  assert.equal(shop.receiptScan, undefined);
  assert.equal(shop.transitionReadiness.ready_for_dispatch.receiptScan.attached, true);
});

test('a real scan upload is audited and the attached scan clears the gate', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, gateOn);
  await photos(api);
  const uploaded = await whenStorageReady(() => {
    const form = new FormData();
    form.set('purpose', 'supplier_invoice');
    form.set('file', new Blob([jpeg], { type: 'image/jpeg' }), 'receipt.jpg');
    return api('supplier', 'POST', '/files', form);
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const fileId = uploaded.body.file.fileId;
  const saved = await loadStore(db);
  const row = saved.auditLog.find(entry => entry.action === 'supplier_invoice.scan_uploaded');
  assert.equal(row.actorId, 'supplier');
  assert.equal(row.entityType, 'file');
  assert.equal(row.entityId, fileId);
  assert.equal(row.detail.supplierId, 'supplier');
  assert.equal(JSON.stringify(row).includes('objectKey'), false);
  assert.equal((await attach(api, fileId)).status, 200);
  assert.equal((await move(api, 'ready_for_dispatch')).status, 200);
  const listed = (await api('ops', 'GET', '/orders/order')).body.order;
  assert.equal(listed.receiptScan.latestFileId, fileId);
});
