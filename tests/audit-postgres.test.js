import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { appendAudit, deriveMissingAudit, withAuditRequest, setAuditActor } from '../src/audit.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
const DATABASE_URL = process.env.DATABASE_URL;
async function setup(t) {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats, voucher_campaigns RESTART IDENTITY CASCADE');
  const store = fixture();
  store.orders[0].readyBy = '2099-01-01T00:00:00.000Z'; store.orders[0].promiseBy = '2099-01-01T01:00:00.000Z';
  store.users.find(user => user.id === 'admin').name = '=Admin, "One"';
  await db.transaction(() => saveStore(db, store));
  return db;
}
async function write(db, callback) {
  return db.transaction(async () => { const store = await loadStore(db); await callback(store); await saveStore(db, store); });
}
test('audit SQL rejects UPDATE, DELETE, TRUNCATE and store edits; references and snapshots survive source changes', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  await write(db, store => appendAudit(store, { actor: store.users.find(u => u.id === 'other'), action: 'user.created', entityType: 'user', entityId: 'other' }));
  const row = (await db.query('SELECT * FROM audit_log')).rows[0];
  for (const sql of ["UPDATE audit_log SET action='tampered'", 'DELETE FROM audit_log', 'TRUNCATE audit_log']) {
    await assert.rejects(db.query(sql), error => error.code === '23514' && /append-only/.test(error.message));
  }
  // Test as an ordinary role with deliberately broad DML grants, not only the test owner.
  await db.query('CREATE ROLE audit_test_writer');
  await db.query('GRANT USAGE ON SCHEMA public TO audit_test_writer');
  try {
  await db.query('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON audit_log TO audit_test_writer');
  for (const sql of ["UPDATE audit_log SET action='tampered'", 'DELETE FROM audit_log', 'TRUNCATE audit_log']) {
    await assert.rejects(db.transaction(async () => { await db.query('SET LOCAL ROLE audit_test_writer'); await db.query(sql); }), /append-only/);
  }
  } finally { await db.query('DROP OWNED BY audit_test_writer; DROP ROLE audit_test_writer'); }
  await assert.rejects(write(db, store => { store.auditLog[0].reason = 'tampered'; }), /append-only/);
  await assert.rejects(write(db, store => { store.auditLog = []; }), /append-only/);
  await db.query("DELETE FROM user_role_memberships WHERE user_id='other'");
  await db.query("DELETE FROM client_profiles WHERE user_id='other'");
  await db.query("DELETE FROM users WHERE id='other'");
  assert.deepEqual((await db.query('SELECT * FROM audit_log WHERE id=$1', [row.id])).rows[0], row);
  await db.query("UPDATE users SET name='Renamed' WHERE id='admin'");
  assert.equal(row.data.actorName, 'other');
});

test('audit HTTP search, bounded paging, date filters, CSV, permissions and order scopes', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  await write(db, store => {
    const actor = store.users.find(u => u.id === 'admin');
    for (const [id, at, action, orderId] of [
      ['a', '2026-10-01T12:00:00.000Z', 'order.transition', 'order'],
      ['b', '2026-10-02T12:00:00.000Z', 'order.production_override', 'order'],
      ['c', '2026-10-02T12:00:00.000Z', 'settings.operational_update', null],
    ]) appendAudit(store, { actor, action, entityType: orderId ? 'order' : 'settings', entityId: orderId || 'platform', orderId,
      reason: '=SUM(1,2)\nsecond line', detail: { password: 'never-save', nested: { accessToken: 'never-save', count: 3 }, document: { content: 'never-save' } } }, { id: () => id, at });
  });
  const api = await apiForTest(t);
  const list = async query => { const result = await api('admin', 'GET', `/audit${query}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  assert.deepEqual((await list('?limit=2')).audit.map(r => r.id), ['c', 'b']);
  assert.equal((await list('?limit=2')).nextOffset, 2);
  assert.deepEqual((await list('?limit=2&offset=2')).audit.map(r => r.id), ['a']);
  assert.equal((await list('?limit=2&offset=2')).nextOffset, null);
  for (const query of ['?person=Admin', '?actorId=admin', '?q=SUM']) assert.equal((await list(query)).audit.length, 3);
  assert.equal((await list('?q=%25')).audit.length, 0, 'SQL wildcard is literal');
  assert.deepEqual((await list('?orderId=order&action=order.production_override&from=2026-10-02&to=2026-10-02')).audit.map(r => r.id), ['b']);
  for (const query of ['?limit=-1', '?limit=NaN', '?limit=0', '?limit=501', '?offset=1.5', '?from=2026-02-30', '?from=bad', '?from=2026-10-03&to=2026-10-01', '?format=html']) {
    assert.equal((await api('admin', 'GET', `/audit${query}`)).status, 400, query);
  }
  const csv = await api('admin', 'GET', '/audit?format=csv&limit=2', null, { raw: true });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.equal(csv.headers.get('x-next-offset'), '2');
  assert.match(csv.body, /"'=Admin, ""One"""/); assert.match(csv.body, /"'=SUM\(1,2\)\nsecond line"/);
  assert.equal(csv.body.includes('never-save'), false);
  assert.equal((await api(null, 'GET', '/audit')).status, 401);
  for (const key of ['client', 'supplier', 'rider']) {
    assert.equal((await api(key, 'GET', '/audit?format=csv')).status, 403);
    assert.equal((await api(key, 'GET', '/orders/order/audit')).status, 403);
  }
  assert.equal((await api('ops', 'GET', '/audit?orderId=order')).status, 403);
  const scoped = await api('ops', 'GET', '/orders/order/audit');
  assert.deepEqual(scoped.body.audit.map(r => r.id), ['b']);
  assert.equal((await api('ops', 'GET', '/orders/order/audit?action=settings.operational_update')).body.audit.length, 0);
  assert.equal((await api('admin', 'GET', '/orders/order/audit')).body.audit.length, 2);
  assert.equal((await api('admin', 'GET', '/orders/order/audit?orderId=another')).status, 400);
  assert.equal((await api('admin', 'GET', '/orders/missing/audit')).status, 404);
  for (const method of ['PATCH', 'DELETE']) assert.equal((await api('admin', method, '/audit/a', {})).status, 404);
  const persisted = JSON.stringify((await db.query('SELECT data FROM audit_log')).rows);
  assert.equal(persisted.includes('never-save'), false);
});

test('new HTTP writes capture settings, lifecycle, staff sign-in once and private artwork authorization', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  await write(db, store => {
    store.files.push({ fileId: 'production-audit', ownerId: 'supplier', purpose: 'production_photo', state: 'ready', objectKey: 'production/photo', originalFilename: 'photo.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT, references: [{ type: 'order', id: 'order', field: 'productionPhotoFileIds' }] });
    store.files.push({ fileId: 'artwork-audit', ownerId: 'client', purpose: 'artwork', state: 'ready', objectKey: 'private/secret-artwork',
      originalFilename: 'private.png', declaredContentType: 'image/png', detectedContentType: 'image/png', size: 100, createdAt: AT,
      references: [{ type: 'order', id: 'order', field: 'artworkFileIds' }] });
  });
  const api = await apiForTest(t);
  const settings = await api('admin', 'GET', '/settings');
  const changed = await api('admin', 'PATCH', '/settings', { expectedVersion: settings.body.version, reason: 'Approved fee revision', serviceFeeRateBps: 1200 }, { headers: { 'X-GRIDGO-App': 'dashboard', 'User-Agent': 'Audit Test Device' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const moved = await api('supplier', 'POST', '/orders/order/transition', { state: 'supplier_self_qc', note: 'Printing finished' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  for (let i = 0; i < 2; i++) assert.equal((await api('admin', 'GET', '/auth/me/admin')).status, 200);
  assert.equal((await api('other', 'GET', '/files/artwork-audit/download-url')).status, 403);
  assert.equal((await api('admin', 'GET', '/files/artwork-audit/download-url')).status, 200);
  const store = await loadStore(db);
  const fee = store.auditLog.find(r => r.action === 'settings.operational_update');
  assert.equal(fee.actorName, '=Admin, "One"'); assert.equal(fee.actorRole, 'super_admin');
  assert.equal(fee.app, 'dashboard'); assert.equal(fee.device, 'Audit Test Device');
  assert.equal(fee.before.serviceFeeRateBps, 1000); assert.equal(fee.after.serviceFeeRateBps, 1200);
  assert.equal(fee.reason, 'Approved fee revision');
  const transition = store.auditLog.find(r => r.action === 'order.transition');
  assert.equal(transition.actorRole, 'supplier'); assert.equal(transition.before.state, 'production'); assert.equal(transition.after.state, 'supplier_self_qc');
  assert.equal(transition.orderId, 'order');
  assert.equal(store.auditLog.filter(r => r.action === 'staff.sign_in').length, 1);
  const artwork = store.auditLog.filter(r => r.action === 'artwork.download_authorized');
  assert.equal(artwork.length, 1); assert.equal(artwork[0].orderId, 'order');
  assert.equal(artwork[0].actorId, 'admin');
  assert.equal(JSON.stringify(store.auditLog).includes('private/secret-artwork'), false);
  assert.equal(JSON.stringify(store.auditLog).includes('session_admin'), false);
  await db.query("UPDATE users SET name='Changed later' WHERE id='admin'");
  const history = await api('admin', 'GET', '/audit?action=settings.operational_update');
  assert.equal(history.body.audit[0].actorName, '=Admin, "One"');
});

test('gap derivation preserves actor, creation/deletion, rider changes, rollback and system identity', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  await withAuditRequest({ headers: { 'x-gridgo-app': 'dashboard', 'user-agent': 'Test' } }, async () => {
    setAuditActor({ id: 'admin', role: 'super_admin', name: 'Admin' });
    await write(db, store => {
      const baseline = structuredClone(store);
      store.orders[0].riderId = 'rider';
      store.orders[0].supplierId = 'replacement';
      store.users.push({ id: 'new-client', name: 'New', email: 'private@example.test', clerkUserId: 'secret-subject', role: 'client', accountType: 'individual', createdAt: AT });
      deriveMissingAudit(store, baseline);
    });
  });
  const audit = (await loadStore(db)).auditLog;
  assert.equal(audit.find(r => r.action === 'order.rider_assigned').after.riderId, 'rider');
  assert.equal(audit.find(r => r.action === 'order.supplier_changed').before.supplierId, 'supplier');
  assert.equal(audit.find(r => r.action === 'order.supplier_changed').after.supplierId, 'replacement');
  const created = audit.find(r => r.action === 'user.created');
  assert.equal(created.actorId, 'admin'); assert.equal(created.before, null); assert.equal(created.after.name, 'New');
  assert.equal(JSON.stringify(created).includes('private@example.test'), false);
  await assert.rejects(db.transaction(async () => {
    const store = await loadStore(db);
    appendAudit(store, { actor: { role: 'system' }, action: 'system.test', entityType: 'order', entityId: 'order' });
    await saveStore(db, store); throw new Error('roll back');
  }), /roll back/);
  assert.equal((await db.query("SELECT 1 FROM audit_log WHERE action='system.test'")).rows.length, 0);
});


test('order audit includes shared basket and file evidence without exposing it to Operations', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  await write(db, store => {
    appendAudit(store, { actor: store.users.find(u => u.id === 'admin'), action: 'basket.payment_confirm',
      entityType: 'basket', entityId: 'shared-basket', detail: { orderIds: ['order', 'other-order'] } });
    store.files[0].references = [{ type: 'order', id: 'order', field: 'artworkFileIds' }];
    appendAudit(store, { actor: store.users.find(u => u.id === 'admin'), action: 'file.early_delete', entityType: 'file', entityId: store.files[0].fileId });
  });
  const api = await apiForTest(t);
  const admin = await api('admin', 'GET', '/orders/order/audit');
  assert.deepEqual(admin.body.audit.map(row => row.action).sort(), ['basket.payment_confirm', 'file.early_delete']);
  const ops = await api('ops', 'GET', '/orders/order/audit');
  assert.deepEqual(ops.body.audit.map(row => row.action), ['file.early_delete']);
});

test('forward migration preserves legacy evidence, links order/basket history, and enables permanent guards', { skip: !DATABASE_URL }, async t => {
  const db = createDatabase({ DATABASE_URL }); t.after(() => db.close());
  const { up } = await import('../migrations/1792017100000_permanent_audit.js');
  await db.transaction(async () => {
    await db.query(`CREATE SCHEMA audit_migration_test;
      SET LOCAL search_path TO audit_migration_test;
      CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE orders(id text PRIMARY KEY);
      CREATE TABLE audit_log(id text PRIMARY KEY, at timestamptz NOT NULL, actor_id text REFERENCES users(id) ON DELETE SET NULL,
        actor_role text, action text, entity_type text, entity_id text, order_id text REFERENCES orders(id) ON DELETE SET NULL, position integer, data jsonb);
      INSERT INTO audit_log VALUES('legacy-order', now(), null, 'system', 'order.transition', 'order', 'old-order', null, 0, '{"reason":"Historical reason"}');
      INSERT INTO audit_log VALUES('legacy-basket', now(), null, 'system', 'basket.checkout', 'basket', 'old-basket', null, 1, '{"detail":{"orderIds":["old-order","another-order"]}}');`);
    await up({ sql: sql => db.query(sql) });
    const order = (await db.query("SELECT * FROM audit_log WHERE id='legacy-order'")).rows[0];
    assert.equal(order.order_id, 'old-order'); assert.equal(order.data.reason, 'Historical reason');
    const basket = (await db.query("SELECT * FROM audit_log WHERE id='legacy-basket'")).rows[0];
    assert.deepEqual(basket.data.orderIds, ['old-order', 'another-order']);
    assert.deepEqual(basket.data.detail.orderIds, basket.data.orderIds);
    const guards = (await db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='audit_log'::regclass AND NOT tgisinternal")).rows;
    assert.equal(guards.length, 2); assert.ok(guards.every(row => row.tgenabled === 'A'));
    db.markRollback();
  });
});


test('audit authority uses memberships and honors explicit role selection instead of legacy primary role', { skip: !DATABASE_URL }, async t => {
  const db = await setup(t);
  await write(db, store => {
    const admin = store.users.find(user => user.id === 'admin');
    admin.role = 'client'; admin.accountType = 'individual';
    store.userRoleMemberships.push({ userId: 'admin', role: 'client', createdAt: AT });
    store.clientProfiles.push({ userId: 'admin', clientKind: 'personal', updatedAt: AT });
  });
  const api = await apiForTest(t);
  for (const path of ['/audit', '/orders/order/audit']) {
    assert.equal((await api('admin', 'GET', path)).status, 200);
    assert.equal((await api('admin', 'GET', path, null, { headers: { 'X-GRIDGO-Role': 'client' } })).status, 403);
    assert.equal((await api('admin', 'GET', path, null, { headers: { 'X-GRIDGO-Role': 'super_admin' } })).status, 200);
  }
});
