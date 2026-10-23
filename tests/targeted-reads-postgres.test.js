import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadInboxStore, loadHotReadStore, loadDeliveryStore, loadPushDeliveryStore } from '../src/postgres-store.js';
import { seedReferenceData } from '../src/seed.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { listInbox, notificationVisible, canAccessOrder } from '../src/notifications.js';
import { deviceAcceptsNotification, createOutboxWorker } from '../src/push-outbox.js';
import { routeShopRecovery } from '../src/shop-recovery-routes.js';
import { routeCatalogReview } from '../src/catalog-review-routes.js';
import { testOperationsView } from '../src/test-operations.js';

const AT = '2026-10-01T00:00:00.000Z';
const skip = !process.env.DATABASE_URL;
function instrument(database) {
  const queries = [];
  return { queries, db: { ...database, query: async (sql, values) => {
    const result = await database.query(sql, values);
    queries.push({ sql, rows: result.rowCount });
    return result;
  } } };
}

test('targeted route and delivery graphs preserve compatibility and bound history reads', { skip }, async t => {
  const database = createDatabase(process.env);
  t.after(() => database.close());
  await resetDatabase(database, 'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin']) {
      store.users.push({ id: role, clerkUserId: `clerk_${role}`, email: `${role}@example.test`, name: role, role,
        accountType: role === 'client' ? 'individual' : undefined,
        verificationStatus: ['supplier', 'rider'].includes(role) ? 'approved' : undefined, createdAt: AT });
      store.userRoleMemberships.push({ userId: role, role, createdAt: AT });
    }
    store.users.push({ id: 'test_ops', clerkUserId: 'clerk_test_ops', email: 'testops@example.test', name: 'Test ops', role: 'ops_admin', reviewData: true, createdAt: AT });
    store.users.push({ id: 'review_supplier', clerkUserId: 'clerk_review_supplier', email: 'reviewshop@example.test', name: 'Review shop', role: 'supplier', verificationStatus: 'unverified', reviewData: true, createdAt: AT });
    store.userRoleMemberships.push({ userId: 'test_ops', role: 'ops_admin', createdAt: AT }, { userId: 'review_supplier', role: 'supplier', createdAt: AT });
    store.approvalCases.push({ id: 'case_supplier', userId: 'supplier', kind: 'supplier', status: 'approved', version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
    store.approvalCases.push({ id: 'case_rider', userId: 'rider', kind: 'rider', status: 'approved', version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
    store.orders.push({ id: 'order', title: 'Current title', clientId: 'client', supplierId: 'supplier', riderId: 'rider', state: 'awaiting_collection', fulfillmentMode: 'pickup', supplierSubtotalMinor: 10000, subtotalMinor: 10000, serviceFeeRateBps: 1000, serviceFeeMinor: 1000, deliveryFeeMinor: 0, totalMinor: 11000, riderCommissionBps: 8500, moneyModelVersion: 2, payoutHold: false, payments: { initial: { amountMinor: 8250, method: 'qr_manual', status: 'confirmed' }, final_online: { amountMinor: 2750, method: 'qr_manual', status: 'not_submitted' } }, payoutMilestones: [], paymentAllocations: [], revenueAdjustments: [], createdAt: AT, updatedAt: AT });
    for (let i = 0; i < 150; i++) store.notifications.push({ id: `hidden_${i}`, userId: 'supplier', type: 'general', appRole: 'rider', at: AT });
    for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin']) {
      for (const extra of [{}, { orderId: 'order' }, { approvalCaseId: 'case_supplier' }, { appRole: 'ops_admin' }, { audienceRoles: ['client'] }, { deletedAt: AT }]) {
        store.notifications.push({ id: `${role}_${store.notifications.length}`, userId: role, type: 'general', title: 'Notice', body: 'Body', at: AT, ...extra });
      }
      store.deviceTokens.push({ id: `device_${role}`, userId: role, token: `token_${role}`, platform: 'android', appRole: role, createdAt: AT, updatedAt: AT });
    }
    store.notifications.push({ id: 'deleted_watermark', userId: 'supplier', type: 'general', at: AT, deletedAt: AT });
    for (let i = 0; i < 120; i++) store.productTypeRequests.push({ id: `ptr_${String(i).padStart(4, '0')}`, supplierId: i % 2 ? 'review_supplier' : 'supplier', categoryCode: store.taxonomy.categories[0].code, name: `Type ${i}`, description: 'Requested', status: i % 3 ? 'pending' : 'approved', productTypeCode: i % 3 ? null : store.taxonomy.subcategories[0].code, version: 1, createdAt: AT, updatedAt: AT });
    const category = store.taxonomy.categories[0].code;
    const subcategory = store.taxonomy.subcategories.find(row => row.categoryCode === category).code;
    for (const supplierId of ['supplier', 'review_supplier']) {
      store.supplierServices.push({ id: `service_${supplierId}`, supplierId, categoryCode: category, state: 'live', referenceRateMinor: 100, turnaroundHours: 1, createdAt: AT, updatedAt: AT });
    }
    for (let i = 0; i < 120; i++) {
      const supplierId = i % 2 ? 'review_supplier' : 'supplier';
      store.catalogItems.push({ id: `item_${String(i).padStart(4, '0')}`, supplierId, supplierServiceId: `service_${supplierId}`, subcategoryCode: subcategory, name: `Listing ${i}`, description: 'Test listing', basePriceMinor: 100, turnaroundMode: 'override', turnaroundHours: 1, fileFormatMode: 'inherit', active: true, sortOrder: i, version: 1, reviewStatus: i % 3 ? 'pending' : 'approved', createdAt: AT, updatedAt: AT });
    }
    store.orders[0].shopFailureEvents = [{ id: 'failure', supplierId: 'supplier', kind: 'declined', stage: 'supplier_assigned', reason: 'Test event', at: AT }];
    store.orders.push({ ...structuredClone(store.orders[0]), id: 'order_without_failure_events', shopFailureEvents: null });
    await saveStore(database, store);
  });
  let full = await loadStore(database);

  await t.test('reference and role graphs return the same decoded rows and see committed updates', async () => {
    const expected = { '/settings': ['version', 'settings'], '/taxonomy': ['taxonomy'], '/zones': ['zones'], '/catalog': ['catalog'], '/auth/me/ops': ['users', 'userRoleMemberships', 'approvalCases'], '/auth/me/supplier': ['supplierProfiles'], '/auth/me/rider': ['riderProfiles', 'riderDocuments'] };
    for (const [path, fields] of Object.entries(expected)) {
      const { queries, db } = instrument(database);
      const scoped = await loadHotReadStore(db, 'clerk_ops_admin', path);
      for (const field of fields) assert.deepEqual(scoped[field], ['users', 'userRoleMemberships', 'approvalCases'].includes(field) ? full[field].filter(row => (row.userId || row.id) === 'ops_admin') : full[field]);
      assert.ok(!queries.some(q => /FROM (notifications|location_pings|notification_push_outbox)\b/.test(q.sql)));
      await assert.rejects(database.transaction(() => saveStore(database, scoped)), /read-only/);
    }
    await database.query("UPDATE platform_settings SET version=version+1, settings=jsonb_set(settings,'{testMarker}','true') WHERE singleton");
    const refreshed = await loadHotReadStore(database, 'clerk_ops_admin', '/settings');
    assert.equal(refreshed.settings.testMarker, true);
    assert.equal(refreshed.version, full.version + 1);
    full = await loadStore(database);
  });

  await t.test('inbox keeps role filtering, hidden-page refill and deleted watermark', async () => {
    for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin']) {
      for (const selectedRole of [undefined, role]) {
        for (const limit of ['1', '40', '100', 'bad']) {
          const options = { role: selectedRole, limit };
          const scoped = await loadInboxStore(database, `clerk_${role}`, options);
          assert.deepEqual(listInbox(scoped, role, options), listInbox(full, role, options));
        }
      }
    }
    assert.deepEqual(listInbox(await loadInboxStore(database, 'missing'), 'missing'), { notifications: [], snapshot: null });
  });

  await t.test('paginated product request queue keeps cursor/status and test-operations view', async () => {
    for (const userId of ['ops_admin', 'test_ops']) for (const status of [null, 'pending', 'approved']) for (const after of ['', 'ptr_0030']) {
      const options = { status, after }, url = new URL('http://localhost/ops/product-type-requests');
      if (status) url.searchParams.set('status', status);
      if (after) url.searchParams.set('after', after);
      const scoped = await loadHotReadStore(database, `clerk_${userId}`, url.pathname, options);
      const project = async store => {
        const user = store.users.find(row => row.id === userId);
        const view = userId === 'test_ops' ? testOperationsView(store, user) : store;
        return (await routeCatalogReview({ req: { method: 'GET' }, url, store: view, user })).body;
      };
      assert.deepEqual(await project(scoped), await project(full));
      assert.ok(scoped.productTypeRequests.length <= 51);
    }
  });

  await t.test('listing review pages and shop-failure queue preserve existing projections', async () => {
    for (const userId of ['ops_admin', 'test_ops']) for (const status of ['pending', 'approved']) for (const after of ['', 'item_0030']) {
      const url = new URL(`http://localhost/ops/catalog-reviews?status=${status}&after=${after}`);
      const scoped = await loadHotReadStore(database, `clerk_${userId}`, url.pathname, { status, after });
      const project = async store => {
        const user = store.users.find(row => row.id === userId);
        return (await routeCatalogReview({ req: { method: 'GET' }, url, store: userId === 'test_ops' ? testOperationsView(store, user) : store, user })).body;
      };
      assert.deepEqual(await project(scoped), await project(full));
      assert.ok(scoped.catalogItems.length <= 51);
    }
    const scoped = await loadHotReadStore(database, 'clerk_ops_admin', '/ops/shop-failures');
    const project = async store => (await routeShopRecovery({ req: { method: 'GET' }, url: new URL('http://localhost/ops/shop-failures'), store, user: store.users.find(row => row.id === 'ops_admin') })).body;
    assert.deepEqual(await project(scoped), await project(full));
  });

  await t.test('delivery policy and ownership match complete store and react to revocation', async () => {
    for (const n of full.notifications) {
      const scoped = await loadDeliveryStore(database, { userIds: [n.userId], notificationIds: [n.id] });
      assert.equal(notificationVisible(scoped, scoped.notifications[0], n.userId), notificationVisible(full, n, n.userId));
      const device = full.deviceTokens.find(row => row.userId === n.userId);
      assert.equal(deviceAcceptsNotification(scoped, device, scoped.notifications[0]), deviceAcceptsNotification(full, device, n));
    }
    const location = await loadDeliveryStore(database, { userIds: ['rider'], subjectId: 'order' });
    assert.equal(canAccessOrder(location, 'rider', location.orders[0], { role: 'rider', location: true }), canAccessOrder(full, 'rider', full.orders[0], { role: 'rider', location: true }));
    await database.query("DELETE FROM user_role_memberships WHERE user_id='ops_admin'");
    const n = full.notifications.find(row => row.userId === 'ops_admin' && row.appRole === 'ops_admin');
    const revoked = await loadDeliveryStore(database, { userIds: ['ops_admin'], notificationIds: [n.id] });
    assert.equal(notificationVisible(revoked, revoked.notifications[0], 'ops_admin'), false);
  });

  await t.test('tenfold unrelated history does not increase rows returned by hot reads or push batch', async () => {
    const row = { user_id: 'supplier', notification_id: full.notifications.find(n => n.userId === 'supplier' && n.orderId).id, device_id: 'device_supplier' };
    const sample = async () => {
      const { queries, db } = instrument(database);
      await loadInboxStore(db, 'clerk_client');
      await loadHotReadStore(db, 'clerk_super_admin', '/settings');
      const batch = await loadPushDeliveryStore(db, [row]);
      assert.equal(batch.deviceTokens.length, 1);
      assert.equal(batch.notifications.length, 1);
      assert.ok(!queries.some(q => /FROM (audit_log|location_pings|notification_push_outbox)\b/.test(q.sql)));
      return queries.map(q => q.rows);
    };
    await database.query(`INSERT INTO notifications(id,user_id,type,created_at,position) SELECT 'growth_'||i,'rider','general',$1,1000+i FROM generate_series(1,1000) i`, [AT]);
    const before = await sample();
    await database.query(`INSERT INTO notifications(id,user_id,type,created_at,position) SELECT 'growth_'||i,'rider','general',$1,1000+i FROM generate_series(1001,10000) i`, [AT]);
    assert.deepEqual(await sample(), before);
    // Real worker uses the scoped batch loader; no full-store fixture injection.
    const n = full.notifications.find(n => n.userId === 'supplier' && n.orderId);
    await database.query('INSERT INTO notification_push_outbox(notification_id,device_id,user_id) VALUES ($1,$2,$3)', [n.id, 'device_supplier', 'supplier']);
    const sent = [];
    const drain = createOutboxWorker({ database, loadStore: loadPushDeliveryStore, delivery: { configured: true, send: async (_, devices) => { sent.push(...devices.map(d => d.id)); return devices.map(d => ({ ok: true, deviceId: d.id })); } } });
    await drain();
    assert.deepEqual(sent, ['device_supplier']);
  });
});
