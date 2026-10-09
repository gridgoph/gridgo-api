import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabase } from '../src/database.js';
import { emptyStore, saveStore, loadStore } from '../src/postgres-store.js';
import { defaultOperationalSettings, createPayoutMilestones } from '../src/operational-model.js';
import { issueVoucher, reserveVoucher, confirmVoucher, restoreVoucherForRefund } from '../src/vouchers.js';
import { voucherMoney, applyVoucherMoney } from '../src/voucher-money.js';
import { routeVouchers } from '../src/voucher-routes.js';

const AT = '2026-10-09T00:00:00.000Z';
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const DB = process.env.DATABASE_URL;
async function fixture(db) {
  await db.query('TRUNCATE users, platform_settings, voucher_campaigns RESTART IDENTITY CASCADE');
  const store = emptyStore(); store.settings = defaultOperationalSettings();
  store.users = ['client', 'super'].map(key => ({ id: key, role: key === 'super' ? 'super_admin' : 'client', email: `${key}@voucher.test`, name: key, clerkUserId: `clerk_${key}`, createdAt: AT, ...(key === 'client' ? { accountType: 'individual' } : {}) }));
  store.userRoleMemberships = store.users.map(u => ({ userId: u.id, role: u.role, createdAt: AT }));
  store.clientProfiles = [{ userId: 'client', clientKind: 'personal', updatedAt: AT }];
  store.carts = [{ id: 'cart', clientId: 'client', state: 'draft', version: 1, fulfillmentMode: 'delivery', serviceLevel: 'standard', createdAt: AT, updatedAt: AT }];
  store.voucherCampaigns = [{ id: 'campaign', name: 'Testers', code: 'TESTERS', mode: 'assigned', status: 'active', valueMinor: 1500, totalLimit: 10, perAccountLimit: 1, endsAt: null, validityDays: 7, createdAt: AT, updatedAt: AT }];
  await db.transaction(() => saveStore(db, store));
}
test('PostgreSQL voucher issuance serializes, stores reservations/redemptions and enforces append-only money', { skip: !DB }, async () => {
  assert.match(new URL(DB).pathname, /test/);
  const db = createDatabase({ DATABASE_URL: DB });
  try {
    await fixture(db);
    const issue = () => db.transaction(async () => { const store = await loadStore(db); const result = issueVoucher(store, store.voucherCampaigns[0], 'client', { id, at: AT }); await saveStore(db, store); return result; });
    const issued = await Promise.all([issue(), issue()]);
    assert.equal(issued.filter(r => r.issued).length, 1);
    assert.equal((await db.query('SELECT * FROM vouchers')).rowCount, 1);
    await db.transaction(async () => {
      const store = await loadStore(db), voucher = store.vouchers[0];
      const order = { id: 'order', clientId: 'client', state: 'initial_payment_review', createdAt: AT, updatedAt: AT,
        moneyModelVersion: 3, commercialCommittedAt: AT, quoteVersion: 1, payoutPlanVersion: 2, supplierDownpaymentRateBps: 10000,
        downpaymentPercent: 100, paymentPlan: 'order_match_qr_75_25', fulfillmentMode: 'delivery',
        supplierSubtotalMinor: 10000, subtotalMinor: 10000, serviceFeeRateBps: 1000, serviceFeeMinor: 1000, grossServiceFeeMinor: 1000,
        organizationDiscountRateBps: 0, organizationDiscountMinor: 0, deliveryFeeMinor: 8900, riderCommissionBps: 8500,
        supplierPlatformPayoutMinor: 10000, totalMinor: 19900, onlineDueMinor: 19900, directStoreDueMinor: 0,
        payments: { initial: { amountMinor: 19900, method: 'qr_manual', status: 'pending_confirmation' }, final_online: { amountMinor: 0, method: 'qr_manual', status: 'not_required' } },
        paymentAllocations: [['supplier_principal', 10000], ['service_fee', 1000], ['delivery_pass_through', 8900]].map(([component, amountMinor]) => ({ paymentCode: 'initial', component, amountMinor })), timeline: [] };
      order.payoutMilestones = createPayoutMilestones(order, { version: 2 });
      applyVoucherMoney(order, voucherMoney([order], voucher.valueMinor).groups[0], voucher);
      store.orders.push(order); reserveVoucher(store, voucher, store.carts[0], { id, at: AT, orderIds: [order.id], amountMinor: 1500 });
      await saveStore(db, store);
    });
    let loaded = await loadStore(db);
    assert.equal(loaded.orders[0].totalMinor, 18400); assert.equal(loaded.orders[0].riderPayoutMinor, 7565);
    await assert.rejects(db.query("UPDATE orders SET data = jsonb_set(data, '{voucherDiscountMinor}', '1400') WHERE id='order'"), { code: '23514' });
    await assert.rejects(db.query("UPDATE order_payment_allocations SET amount_minor=8300 WHERE order_id='order' AND component='delivery_pass_through'"), /reconcile/);
    await db.transaction(async () => {
      const store = await loadStore(db); confirmVoucher(store, store.orders, { id, at: AT, actorId: 'super' });
      store.orders[0].payments.initial.status = 'confirmed'; await saveStore(db, store);
    });
    loaded = await loadStore(db); assert.equal(loaded.voucherRedemptions.length, 1); assert.equal(loaded.vouchers[0].status, 'used');
    await assert.rejects(db.query("DELETE FROM voucher_ledger"), /append only/);
    await db.transaction(async () => { const store = await loadStore(db); restoreVoucherForRefund(store, store.orders[0], { id, at: AT, actorId: 'super', reason: 'No fault', clientCaused: false }); await saveStore(db, store); });
    loaded = await loadStore(db); assert.equal(loaded.vouchers[0].status, 'available'); assert.equal(loaded.voucherRedemptions[0].status, 'restored');
    // Wrong-code errors must commit their counters, unlike thrown domain errors.
    for (let n = 0; n < 5; n++) await db.transaction(async () => { const store = await loadStore(db); const response = await routeVouchers({ store, user: { id: 'client', role: 'client' }, req: { method: 'POST' }, url: new URL('http://test/me/vouchers/code'), readBody: async () => ({ code: 'WRONG' }), now: () => AT, id }); if (response.mutated) await saveStore(db, store); });
    assert.equal((await loadStore(db)).voucherCodeAttempts[0].failures, 5);
  } finally { await db.close(); }
});
