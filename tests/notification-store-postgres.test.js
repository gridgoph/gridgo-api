import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import * as postgresStore from '../src/postgres-store.js';
import { seedReferenceData } from '../src/seed.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { listInbox, notificationVisible, orderFromNotification, publicNotification } from '../src/notifications.js';

const AT = '2026-10-01T00:00:00.000Z';
test('notification reads keep inbox and stream visibility without loading unrelated domain history', { skip: !process.env.DATABASE_URL }, async (t) => {
  assert.equal(typeof postgresStore.loadNotificationStore, 'function');
  const database = createDatabase(process.env);
  t.after(() => database.close());
  await resetDatabase(database, 'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await postgresStore.loadStore(database);
    for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin']) {
      store.users.push({ id: role, clerkUserId: `clerk_${role}`, email: `${role}@example.test`, name: role, role, verificationStatus: role === 'supplier' || role === 'rider' ? 'approved' : undefined, accountType: role === 'client' ? 'individual' : undefined, createdAt: AT });
      store.userRoleMemberships.push({ userId: role, role, createdAt: AT });
    }
    store.approvalCases.push({ id: 'case_supplier', userId: 'supplier', kind: 'supplier', status: 'approved', version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT });
    store.orders.push({ id: 'order', title: 'Current title', clientId: 'client', supplierId: 'supplier', riderId: 'rider', state: 'awaiting_collection', fulfillmentMode: 'pickup', supplierSubtotalMinor: 10000, subtotalMinor: 10000, serviceFeeRateBps: 1000, serviceFeeMinor: 1000, deliveryFeeMinor: 0, totalMinor: 11000, riderCommissionBps: 8500, moneyModelVersion: 2, payoutHold: false, payments: { initial: { amountMinor: 8250, method: 'qr_manual', status: 'confirmed' }, final_online: { amountMinor: 2750, method: 'qr_manual', status: 'not_submitted' } }, payoutMilestones: [], paymentAllocations: [], revenueAdjustments: [], createdAt: AT, updatedAt: AT });
    let n = 0;
    for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin']) {
      for (const extra of [{}, { orderId: 'order' }, { approvalCaseId: 'case_supplier' }, { appRole: 'ops_admin' }, { audienceRoles: ['client'] }, { deletedAt: AT }]) {
        store.notifications.push({ id: `ntf_${++n}`, userId: role, type: 'general', title: 'Notice', body: 'Body', at: AT, read: n % 2 === 0, ...extra });
      }
    }
    store.notifications.push({ id: 'silent', userId: 'supplier', type: 'general', at: AT, push: false });
    store.notifications.push({ id: 'deleted_watermark', userId: 'supplier', type: 'general', at: AT, deletedAt: AT });
    await postgresStore.saveStore(database, store);
  });
  await database.query(`INSERT INTO notifications (id,user_id,type,created_at,position,data) SELECT 'unrelated_'||i,'client','general',$1,100+i,'{}'::jsonb FROM generate_series(1,2000) i`, [AT]);
  const full = await postgresStore.loadStore(database);
  for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin']) {
    const queries = [];
    const measured = { ...database, query: async (sql, values) => { const result = await database.query(sql, values); queries.push({ sql, rows: result.rowCount }); return result; } };
    const scoped = await postgresStore.loadNotificationStore(measured, `clerk_${role}`, { lastEventId: 'ntf_1' });
    if (role === 'supplier') {
      const inbox = listInbox(scoped, role, { role });
      assert.deepEqual(inbox.notifications.map(n => n.id), ['ntf_7', 'ntf_8', 'ntf_9', 'silent']);
      assert.equal(inbox.snapshot, 'deleted_watermark');
      assert.equal(inbox.notifications[1].orderTitle, 'Current title');
    }
    if (role === 'client') {
      const notice = listInbox(scoped, role, { role }).notifications.find(n => n.id === 'ntf_2');
      assert.equal(notice.collectHold, true);
      assert.deepEqual(notice.paymentAction, { installment: 'final_online', status: 'due', amountMinor: 2750 });
    }
    for (const selected of [undefined, role]) {
      for (const limit of [undefined, '1', '100', 'bad']) {
        assert.deepEqual(listInbox(scoped, role, { role: selected, limit }), listInbox(full, role, { role: selected, limit }));
      }
      const frames = s => s.notifications.filter(n => n.userId === role && n.push !== false && notificationVisible(s, n, role, selected)).map(n => publicNotification(n, orderFromNotification(s, n)));
      assert.deepEqual(frames(scoped), frames(full));
    }
    assert.ok(queries.length < 20, `queries: ${queries.length}`);
    assert.ok(!queries.some(q => /FROM (audit_log|files|supplier_catalog_items)\b/.test(q.sql)));
    if (role !== 'client') assert.ok(scoped.notifications.length < 20, 'other users history must not enter this request');
    assert.equal(scoped.notifications.find(n => n.id === 'ntf_1').userId, 'client', 'foreign resume cursor retains the 403 distinction');
    await assert.rejects(database.transaction(() => postgresStore.saveStore(database, scoped)), /read-only/);
  }
  assert.deepEqual((await postgresStore.loadNotificationStore(database, 'unmapped')).users, []);
  for (const lastEventId of ['ntf_7', 'ntf_1', 'missing']) {
    const replay = await postgresStore.loadNotificationStore(database, 'clerk_supplier', { lastEventId, replay: true });
    const originalIndex = full.notifications.findIndex(n => n.id === lastEventId);
    if (lastEventId === 'ntf_7') assert.deepEqual(replay.notifications, full.notifications.slice(originalIndex).filter(n => n.userId === 'supplier'));
    if (lastEventId === 'ntf_1') assert.deepEqual(replay.notifications, [full.notifications[originalIndex]]);
    if (lastEventId === 'missing') assert.deepEqual(replay.notifications, []);
  }
  await database.query("UPDATE order_payments SET status='confirmed' WHERE order_id='order' AND code='final_online'");
  const settled = listInbox(await postgresStore.loadNotificationStore(database, 'clerk_client'), 'client', { role: 'client' });
  assert.equal(settled.notifications.find(n => n.id === 'ntf_2').collectHold, false);
  assert.equal(settled.notifications.find(n => n.id === 'ntf_2').paymentAction, undefined);
  await database.transaction(async () => {
    const store = await postgresStore.loadStore(database);
    const original = store.orders[0];
    store.users.push({ id: 'other_supplier', clerkUserId: 'clerk_other_supplier', email: 'other@example.test', name: 'Other shop', role: 'supplier', verificationStatus: 'approved', createdAt: AT });
    store.userRoleMemberships.push({ userId: 'other_supplier', role: 'supplier', createdAt: AT });
    store.orders.push({ ...structuredClone(original), id: 'multi', supplierId: null });
    for (const [id, supplierId] of [['job_one', 'supplier'], ['job_two', 'other_supplier']]) {
      store.orderJobs.push({ id, orderId: 'multi', supplierId, riderId: null, state: 'production', fulfillmentMode: 'pickup', pickup: { lat: 7, lng: 125, label: 'Shop' }, supplierSubtotalMinor: 5000, deliveryFeeMinor: 0, riderCommissionBps: 8500, estimatedHours: 24, createdAt: AT, updatedAt: AT });
    }
    store.notifications.push({ id: 'multi_notice', userId: 'supplier', appRole: 'supplier', type: 'general', orderId: 'multi', at: AT });
    for (const id of ['offer_open', 'offer_held']) {
      store.orders.push({ ...structuredClone(original), id, state: 'ready_for_dispatch', riderId: null, fulfillmentMode: 'delivery' });
      store.notifications.push({ id: `${id}_notice`, userId: 'rider', appRole: 'rider', type: 'dispatch_available', orderId: id, at: AT });
    }
    store.refundRequests.push({ id: 'request', orderId: 'offer_held', clientId: 'client', policyVersion: 'available_funds_v1', status: 'requested', version: 1, kind: 'cancellation', reason: 'Refund', beforeProduction: false, late: false, orderStateAtFiling: 'ready_for_dispatch', evidenceFileIds: [], createdAt: AT, updatedAt: AT });
    await postgresStore.saveStore(database, store);
  });
  const shop = listInbox(await postgresStore.loadNotificationStore(database, 'clerk_supplier'), 'supplier', { role: 'supplier' });
  assert.ok(shop.notifications.some(n => n.id === 'multi_notice'));
  const rider = listInbox(await postgresStore.loadNotificationStore(database, 'clerk_rider'), 'rider', { role: 'rider' });
  assert.ok(rider.notifications.some(n => n.id === 'offer_open_notice'));
  assert.ok(!rider.notifications.some(n => n.id === 'offer_held_notice'));
  // No cached authorization or stale event actions after a committed change.
  await database.query("DELETE FROM user_role_memberships WHERE user_id='supplier' AND role='supplier'");
  const revoked = await postgresStore.loadNotificationStore(database, 'clerk_supplier');
  assert.deepEqual(listInbox(revoked, 'supplier', { role: 'supplier' }).notifications, []);
});
