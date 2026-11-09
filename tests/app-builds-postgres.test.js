import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { PICKUP_CHECK_CODES } from '../src/operational-model.js';
import { up as migrateMinimums } from '../migrations/1794191100000_rider_packs_minimum_builds.js';

const DATABASE_URL = process.env.DATABASE_URL;
const minimums = { client: 0, supplier: 0, rider: 161 };
async function setup(t, change = () => {}, { queryProbe = false, storageHandler } = {}) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store = fixture();
  // The startup lifecycle sweep must not independently warn on this fixture
  // while the test verifies that a refused custody request writes nothing.
  Object.assign(store.orders[0], { shopHandoverVersion: 2, riderId: 'rider', readyBy: '2099-10-10T00:00:00.000Z' });
  store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1,
    applicationRevision: 1, submittedAt: AT, decidedAt: AT, createdAt: AT, updatedAt: AT });
  for (const [fileId, purpose, ownerId] of [['finished', 'finished_product_photo', 'supplier'], ['packed', 'packing_photo', 'rider'],
    ['signature', 'handoff_signature', 'rider'], ['delivery', 'delivery_photo', 'rider'],
    ['package', 'delivery_package_photo', 'rider'], ['proof', 'fulfilment_proof', 'rider']]) {
    store.files.push({ fileId, purpose, ownerId, state: 'ready', objectKey: `private/${fileId}`, originalFilename: 'photo.png',
      declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [] });
  }
  change(store);
  await db.transaction(() => saveStore(db, store));
  let queryOutput = '';
  const api = await apiForTest(t, queryProbe ? {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${new URL('./fixtures/request-query-probe.mjs', import.meta.url).href}`,
  } : {}, { storageHandler, onOutput: chunk => { queryOutput += chunk; } });
  const traces = () => queryOutput.split('\n').filter(line => line.startsWith('GRIDGO_TEST_QUERY_TRACE '))
    .map(line => JSON.parse(line.slice('GRIDGO_TEST_QUERY_TRACE '.length)));
  async function call(method, path, body = {}, header, actor = 'rider', queryId) {
    for (let attempt = 0; ; attempt++) {
      const result = await api(actor, method, path, body, { headers: {
        ...(header === undefined ? {} : { 'X-GRIDGO-App': header }), ...(queryId ? { 'X-GRIDGO-Test-Query-Id': queryId } : {}),
      } });
      if (result.body.error !== 'storage_initializing' || attempt === 99) return { status: result.status, body: result.body };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return { db, api, call, traces };
}

async function custodyRows(db) {
  const scope = {
    orders: "id = 'order'", order_jobs: "order_id = 'order'", order_line_items: "order_id = 'order'",
    order_line_item_options: "order_line_item_id IN (SELECT id FROM order_line_items WHERE order_id = 'order')",
    order_payments: "order_id = 'order'", order_payment_allocations: "order_id = 'order'", payout_milestones: "order_id = 'order'",
    files: "owner_id = 'rider' OR file_id IN (SELECT file_id FROM file_references WHERE reference_type = 'order' AND reference_id = 'order')",
    file_references: "reference_type = 'order' AND reference_id = 'order' OR file_id IN (SELECT file_id FROM files WHERE owner_id = 'rider')",
    audit_log: "order_id = 'order' OR actor_id = 'rider'", notifications: "order_id = 'order' OR user_id = 'rider'",
    notification_push_outbox: "user_id = 'rider' OR notification_id IN (SELECT id FROM notifications WHERE order_id = 'order')",
    location_pings: "order_id = 'order' OR rider_id = 'rider'", escalations: "order_id = 'order' OR rider_id = 'rider'",
    acknowledgement_receipts: "order_id = 'order'", hub_handouts: "order_id = 'order'",
    users: "id = 'rider'", user_role_memberships: "user_id = 'rider'", rider_profiles: "user_id = 'rider'",
    rider_documents: "rider_id = 'rider'", user_sign_in_sessions: "user_id = 'rider'", device_tokens: "user_id = 'rider'",
  };
  return db.snapshot(async () => {
    const rows = {};
    for (const [table, where] of Object.entries(scope)) {
      rows[table] = (await db.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS bytes
        FROM ${table} t WHERE ${where}`)).rows[0].bytes;
    }
    return rows;
  });
}

// These refusal cases are exercised against the original implementation too.
// None advances custody; transition refusals retain their existing audit behavior.
const custody = [
  ['POST', '/dispatch/order/accept', {}, 409],
  ['POST', '/dispatch/order/arrived-packed', {}, 409],
  ['POST', '/dispatch/order/pickup-checklist', {}, 409],
  ['POST', '/dispatch/order/pickup-confirm', {}, 409],
  ['POST', '/dispatch/order/delivery', {}, 409],
  ...['rider_assigned', 'picked_up', 'out_for_delivery', 'delivered', 'issue_window_open'].map(state =>
    ['POST', '/orders/order/transition', { state }, 409]),
  ['GET', '/orders/order/handover', null, 200],
  ['POST', '/orders/order/handover/escalate', {}, 409],
  ['POST', '/orders/order/acknowledgement-receipt', {}, 403],
  ['POST', '/files/packed/attach', { orderId: 'order' }, 409],
  ['POST', '/files/signature/attach', { orderId: 'order' }, 409],
  ['POST', '/files/delivery/attach', { orderId: 'order' }, 409],
  ['POST', '/files/package/attach', { orderId: 'order' }, 409],
  ['POST', '/files/proof/attach', { orderId: 'order', milestoneCode: 'invalid' }, 400],
];

test('custody responses without an app header retain the original response bodies', { skip: !DATABASE_URL }, async t => {
  const { call } = await setup(t);
  const responses = [];
  for (const [method, path, body, status] of custody) {
    const response = await call(method, path, body);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    responses.push({ method, path, request: body, ...response });
    for (const header of ['rider/1.0.161+161', 'rider/1.0.260+260', 'supplier/1.0.1+1', 'client/1.0.1+1', 'rider', 'rider/1.0.160', 'rider/bad+160']) {
      assert.deepEqual(await call(method, path, body, header), response, `${method} ${path}: ${header}`);
    }
  }
  if (process.env.APP_BUILD_BASELINE_WRITE) await writeFile(process.env.APP_BUILD_BASELINE_WRITE, JSON.stringify(responses, null, 2));
  if (process.env.APP_BUILD_BASELINE_READ) assert.deepEqual(responses, JSON.parse(await readFile(process.env.APP_BUILD_BASELINE_READ, 'utf8')));
});

test('public launch minimums expose only app minimums and the settings version, including older settings rows', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t, store => { delete store.settings.riderPacksMinimumBuilds; });
  const before = await loadStore(db);
  const response = await api(null, 'GET', '/app-minimum-builds');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { version: before.version, minimumBuilds: minimums });
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual((await api('admin', 'GET', '/settings')).body.settings.riderPacksMinimumBuilds, minimums);
});

test('only Super Admin can update minimums with the settings version handshake and an audit reason', { skip: !DATABASE_URL }, async t => {
  const { api, db } = await setup(t);
  const version = (await loadStore(db)).version;
  const body = { expectedVersion: version, reason: 'Publish the compatible rider release', riderPacksMinimumBuilds: { ...minimums, rider: 260 } };
  assert.equal((await api(null, 'PATCH', '/settings', body)).status, 401);
  for (const actor of ['ops', 'client', 'supplier', 'rider']) assert.equal((await api(actor, 'PATCH', '/settings', body)).status, 403, actor);
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, expectedVersion: version - 1 })).body.error, 'settings_version_conflict');
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, expectedVersion: undefined })).body.error, 'settings_version_conflict');
  assert.equal((await api('admin', 'PATCH', '/settings', { ...body, reason: '' })).body.error, 'settings_reason_required');
  for (const value of [null, [], {}, { rider: 260 }, { ...minimums, rider: -1 }, { ...minimums, rider: 1.5 },
    { ...minimums, rider: '260' }, { ...minimums, rider: Number.MAX_SAFE_INTEGER + 1 }, { ...minimums, dashboard: 1 }]) {
    const invalid = await api('admin', 'PATCH', '/settings', { ...body, riderPacksMinimumBuilds: value });
    assert.equal(invalid.status, 400, JSON.stringify(value));
    assert.equal(invalid.body.error, 'invalid_rider_packs_minimum_builds');
  }
  const updated = await api('admin', 'PATCH', '/settings', body);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.version, version + 1);
  assert.deepEqual(updated.body.settings.riderPacksMinimumBuilds, body.riderPacksMinimumBuilds);
  const stale = await api('admin', 'PATCH', '/settings', body);
  assert.deepEqual(stale.body, { error: 'settings_version_conflict', version: version + 1 });
  const publicRead = await api(null, 'GET', '/app-minimum-builds');
  assert.deepEqual(publicRead.body, { version: version + 1, minimumBuilds: body.riderPacksMinimumBuilds });
  const saved = await loadStore(db);
  const audit = saved.auditLog.filter(row => row.action === 'settings.operational_update');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, body.reason);
  assert.deepEqual(audit[0].detail.current.riderPacksMinimumBuilds, body.riderPacksMinimumBuilds);
  const preserved = await api('admin', 'PATCH', '/settings', { expectedVersion: version + 1, reason: 'Unrelated setting', shopReceiptScanRequired: true });
  assert.deepEqual(preserved.body.settings.riderPacksMinimumBuilds, body.riderPacksMinimumBuilds);
});

test('every rider-packs custody entry point refuses an old rider build before domain checks or writes', { skip: !DATABASE_URL }, async t => {
  const { call, db, traces } = await setup(t, store => {
    store.settings.productionNudge.enabled = false;
    for (const user of store.users) user.createdAt = new Date().toISOString();
    store.orders[0].performanceClock = { version: 1, supplierId: 'supplier', schedule: store.settings.operatingHours.schedule };
  }, { queryProbe: true });
  const before = await custodyRows(db);
  for (const [index, [method, path, body]] of custody.entries()) {
    assert.deepEqual(await call(method, path, body, 'rider/1.0.160+160', 'rider', `rejected-${index}`), {
      status: 426, body: { error: 'app_update_required', minimumBuild: 161, app: 'rider' },
    }, `${method} ${path}`);
  }
  assert.deepEqual(await custodyRows(db), before);
  for (let attempt = 0; traces().length < custody.length && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(traces().length, custody.length, 'each rejected request must have its own query trace');
  for (const trace of traces()) {
    assert.ok(trace.statements.some(sql => sql.includes('shopHandoverVersion')), trace.id);
    assert.deepEqual(trace.statements.filter(sql => /^\s*(BEGIN|INSERT|UPDATE|DELETE|COMMIT)\b/i.test(sql)
      || /pg_(try_)?advisory_xact_lock/.test(sql)), [], trace.id);
  }
});

test('header parsing uses the safe integer build rather than the display version and tolerates missing or malformed headers', { skip: !DATABASE_URL }, async t => {
  const { call } = await setup(t);
  const path = '/dispatch/order/pickup-confirm';
  const baseline = await call('POST', path);
  for (const header of ['rider/99.99.99+160', ' rider/1.0.260+1 ', 'rider/1.0.1+0']) {
    assert.deepEqual(await call('POST', path, {}, header), { status: 426, body: { error: 'app_update_required', minimumBuild: 161, app: 'rider' } });
  }
  for (const header of [undefined, '', 'rider', 'RIDER/1.0.1+1', 'rider/1.0+1', 'rider/1.0.160+bad', 'rider/1.0.160+-1',
    'rider/1.0.160+1.5', 'rider/1.0.160+9007199254740992', 'rider/1.0.160+160 trailing',
    'rider/1.0.160+160, rider/1.0.1+1', 'rider/1.0.0+161', 'rider/1.0.0+260', 'supplier/1.0.1+1', 'client/1.0.1+1']) {
    assert.deepEqual(await call('POST', path, {}, header), baseline, String(header));
  }
});

test('published minimum changes immediately affect custody and zero can disable the staged gate', { skip: !DATABASE_URL }, async t => {
  const { api, call, db } = await setup(t);
  let version = (await loadStore(db)).version;
  for (const rider of [260, 0]) {
    const update = await api('admin', 'PATCH', '/settings', { expectedVersion: version++, reason: 'Release compatibility', riderPacksMinimumBuilds: { ...minimums, rider } });
    assert.equal(update.status, 200);
    const result = await call('POST', '/dispatch/order/pickup-confirm', {}, 'rider/1.0.161+161');
    if (rider) assert.deepEqual(result, { status: 426, body: { error: 'app_update_required', minimumBuild: 260, app: 'rider' } });
    else assert.equal(result.body.error, 'pickup_checklist_not_available');
  }
});

test('the forward settings migration adds versioned defaults once and preserves an existing published minimum', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  const store = fixture();
  delete store.settings.riderPacksMinimumBuilds;
  store.version = 12;
  await db.transaction(() => saveStore(db, store));
  const migrate = () => db.transaction(() => migrateMinimums({ sql: sql => db.query(sql) }));
  await migrate();
  let saved = await loadStore(db);
  assert.equal(saved.version, 13);
  assert.deepEqual(saved.settings.riderPacksMinimumBuilds, minimums);
  await migrate();
  assert.equal((await loadStore(db)).version, 13);
  saved.settings.riderPacksMinimumBuilds.rider = 300;
  await db.transaction(() => saveStore(db, saved));
  await migrate();
  saved = await loadStore(db);
  assert.equal(saved.version, 13);
  assert.equal(saved.settings.riderPacksMinimumBuilds.rider, 300);
});

test('file attachment rechecks a minimum raised during storage inspection before committing custody evidence', { skip: !DATABASE_URL }, async t => {
  let armed = false, reachedStat, releaseStat;
  const statReached = new Promise(resolve => { reachedStat = resolve; });
  const statReleased = new Promise(resolve => { releaseStat = resolve; });
  t.after(() => releaseStat());
  const { api, call, db } = await setup(t, store => {
    store.orders[0].state = 'rider_assigned';
    store.orders[0].pickupChecklist = { status: 'inspected', completedBy: 'rider', inspectionId: 'inspection' };
  }, { storageHandler: async (req, res) => {
    if (req.method === 'HEAD') {
      if (armed && req.url.endsWith('/private/packed')) { reachedStat(); await statReleased; }
      res.writeHead(200, { 'Content-Length': '100', 'Content-Type': 'image/png', ETag: 'test' });
    } else res.writeHead(404);
    res.end();
  } });
  armed = true;
  const attachment = call('POST', '/files/packed/attach', { orderId: 'order' }, 'rider/1.0.161+161');
  await statReached;
  const version = (await loadStore(db)).version;
  const updated = await api('admin', 'PATCH', '/settings', { expectedVersion: version, reason: 'Release a new compatible build',
    riderPacksMinimumBuilds: { ...minimums, rider: 260 } });
  assert.equal(updated.status, 200);
  releaseStat();
  assert.deepEqual(await attachment, { status: 426, body: { error: 'app_update_required', minimumBuild: 260, app: 'rider' } });
  const saved = await loadStore(db);
  assert.deepEqual(saved.files.find(file => file.fileId === 'packed').references, []);
  assert.equal(saved.orders[0].packingPhotoFileIds, undefined);
  assert.equal(saved.auditLog.some(row => row.action === 'order.rider_packing_photo'), false);
});

test('old builds keep legacy flow responses and non-custody routes; authentication remains required', { skip: !DATABASE_URL }, async t => {
  const { call } = await setup(t, store => { store.orders[0].shopHandoverVersion = 1; });
  for (const [method, path, body] of custody) {
    assert.deepEqual(await call(method, path, body, 'rider/1.0.1+1'), await call(method, path, body), path);
  }
  const current = await setup(t);
  for (const [method, path, body] of [
    ['GET', '/orders/order', null], ['GET', '/dispatch/offers', null],
    ['POST', '/dispatch/order/milestones', { milestone: 'invalid' }], ['POST', '/dispatch/order/location', {}],
    ['POST', '/orders/order/transition', { state: 'production' }],
    ['POST', '/files/finished/attach', { orderId: 'order' }],
  ]) assert.deepEqual(await current.call(method, path, body, 'rider/1.0.1+1'), await current.call(method, path, body), path);
  assert.equal((await current.call('POST', '/dispatch/order/pickup-confirm', {}, 'rider/1.0.1+1', null)).status, 401);
});

test('a compatible build completes inspection, packing, signed pickup and delivery and audit keeps the raw header', { skip: !DATABASE_URL }, async t => {
  const { call, db } = await setup(t, store => { delete store.orders[0].riderId; });
  const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const header = 'rider/1.0.161+161';
  ok(await call('POST', '/files/finished/attach', { orderId: 'order' }, undefined, 'supplier'));
  ok(await call('POST', '/orders/order/production-finished', {}, undefined, 'supplier'));
  ok(await call('POST', '/orders/order/production-review', { decision: 'approved' }, undefined, 'ops'));
  ok(await call('POST', '/orders/order/transition', { state: 'ready_for_dispatch' }, undefined, 'supplier'));
  ok(await call('POST', '/dispatch/order/accept', {}, header));
  ok(await call('POST', '/dispatch/order/pickup-checklist', {
    checks: PICKUP_CHECK_CODES.map(code => ({ code, passed: true })), counts: [{ lineItemId: 'line', countedQuantity: 10 }],
  }, header));
  ok(await call('POST', '/files/packed/attach', { orderId: 'order' }, header));
  ok(await call('POST', '/files/signature/attach', { orderId: 'order' }, header));
  ok(await call('POST', '/dispatch/order/pickup-confirm', { signature: { fileId: 'signature', signerName: 'Shop Person' } }, header));
  ok(await call('POST', '/orders/order/transition', { state: 'out_for_delivery' }, header));
  ok(await call('POST', '/files/delivery/attach', { orderId: 'order' }, header));
  const delivered = ok(await call('POST', '/dispatch/order/delivery', { evidenceType: 'photo', evidenceFileId: 'delivery', receivedBy: 'Client' }, header));
  assert.equal(delivered.order.state, 'issue_window_open');
  const saved = await loadStore(db);
  assert.equal(saved.auditLog.find(row => row.action === 'pickup_checklist.handoff_signed').app, header);
});
