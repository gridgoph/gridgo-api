import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDatabase } from '../src/database.js';
import { emptyStore, loadStore, saveStore } from '../src/postgres-store.js';
import { defaultPromotionSettings } from '../src/promotion-settings.js';
import { claimFounding, inviteFriend, claimFriendPass, sweepPromotions, promotionBudget, promotionSlotsLeft } from '../src/promotions.js';
import { applyVoucherMoney, voucherMoney } from '../src/voucher-money.js';
import { reserveVoucher, confirmVoucher } from '../src/vouchers.js';
import { defaultOperationalSettings, createPayoutMilestones, collectedSupplierPrincipalMinor } from '../src/operational-model.js';
import { calculateRefundSettlement } from '../src/refund-policy.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { fixture as testerFixture } from './fixtures/reschedule.js';
import { submitSurvey, syncSurveys } from '../src/surveys.js';
import { reconcileFoundingTester } from '../src/founding-testers.js';
import { reconcileTesterInvite, submitTesterInvite, createInviteCode } from '../src/tester-invites.js';

const DB = process.env.DATABASE_URL, AT = '2026-10-27T01:00:00.000Z';
const id = p => `${p}_${crypto.randomUUID()}`;
const ctx = { id, at: AT };
async function fixture(db, count = 35) {
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, promotion_settings RESTART IDENTITY CASCADE');
  const store = emptyStore(); store.settings = defaultOperationalSettings();
  store.promotionSettings = [{ id: 'launch', version: 1, settings: defaultPromotionSettings() }];
  store.users = Array.from({ length: count }, (_, n) => ({ id: `client${n}`, role: 'client', email: `client${n}@launch.test`, name: `Client ${n}`, clerkUserId: `clerk_client${n}`, accountType: 'individual', createdAt: AT }));
  store.users.push({ id: 'admin', role: 'super_admin', email: 'admin@launch.test', name: 'Admin', clerkUserId: 'clerk_admin', createdAt: AT });
  store.userRoleMemberships = store.users.map(u => ({ userId: u.id, role: u.role, createdAt: AT }));
  store.clientProfiles = store.users.filter(u => u.role === 'client').map(u => ({ userId: u.id, clientKind: 'personal', updatedAt: AT }));
  await db.transaction(() => saveStore(db, store));
}
async function mutate(db, action) {
  return db.transaction(async () => { const s = await loadStore(db); const result = await action(s); await saveStore(db, s); return result; });
}
test('PostgreSQL domain lock serializes 35 concurrent claims into exactly 30 slots and permanent personal history', { skip: !DB }, async t => {
  const a = createDatabase({ DATABASE_URL: DB, DATABASE_POOL_MAX: 2, DATABASE_CONNECT_TIMEOUT_MS: 60000 }),
    b = createDatabase({ DATABASE_URL: DB, DATABASE_POOL_MAX: 2, DATABASE_CONNECT_TIMEOUT_MS: 60000 });
  t.after(() => Promise.all([a.close(), b.close()]));
  await fixture(a);
  const claims = await Promise.allSettled(Array.from({ length: 35 }, (_, n) => mutate(n % 2 ? a : b, s => claimFounding(s, `client${n}`, ctx))));
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 30);
  assert.deepEqual(claims.filter(r => r.status === 'rejected').map(r => r.reason.code), Array(5).fill('promotion_sold_out'));
  let s = await loadStore(a); assert.equal(s.vouchers.length, 30); assert.equal(promotionBudget(s, AT).committedMinor, 600000);
  const winner = s.vouchers[0], loser = s.users.find(u => u.role === 'client' && !s.vouchers.some(v => v.clientId === u.id));
  await mutate(a, s => { const v = s.vouchers.find(v => v.id === winner.id); v.expiresAt = '2026-10-28T00:00:00Z'; });
  const later = { id, at: '2026-10-29T00:00:00Z' };
  await assert.rejects(mutate(a, s => claimFounding(s, winner.clientId, later)), { code: 'promotion_already_has_discount' });
  await mutate(a, s => claimFounding(s, loser.id, later));
  s = await loadStore(a); assert.equal(s.vouchers.length, 31); assert.equal(promotionSlotsLeft(s, later.at), 0);
  await assert.rejects(a.query('INSERT INTO vouchers SELECT id||\'-again\',campaign_id,client_id,status,value_minor,issued_at,expires_at,email_allowed,data,promotion_kind FROM vouchers LIMIT 1'), { code: '23505' });
});
test('PostgreSQL hard budget, upgrades and invite provenance survive round trips', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close()); await fixture(db, 6);
  await mutate(db, s => { s.promotionSettings[0].settings.budgetCapMinor = 50000; claimFounding(s, 'client0', ctx); inviteFriend(s, 'client0', 'client1@launch.test', ctx); claimFriendPass(s, 'client1', ctx); });
  await mutate(db, s => { claimFounding(s, 'client2', ctx); });
  await assert.rejects(mutate(db, s => claimFounding(s, 'client3', ctx)), { code: 'promotion_budget_reached' });
  await mutate(db, s => { assert.equal(sweepPromotions(s, { id, at: '2026-11-02T00:00:00Z' }), false); s.vouchers.find(v => v.clientId === 'client2').status = 'void'; });
  await mutate(db, s => { assert.equal(sweepPromotions(s, { id, at: '2026-11-02T00:00:00Z' }), true); });
  await mutate(db, s => { assert.equal(sweepPromotions(s, { id, at: '2026-11-02T00:00:00Z' }), false); });
  const s = await loadStore(db);
  assert.equal(s.promotionInvites[0].clientId, 'client1'); assert.equal(s.vouchers.find(v => v.clientId === 'client1').valueMinor, 20000);
  assert.equal(s.voucherLedger.filter(l => l.kind === 'upgraded').length, 1);
});
function order(orderId, principal, delivery, percent = 100) {
  const fee = Number((BigInt(principal) * 4500n + 5000n) / 10000n), total = principal + fee + delivery;
  const round = v => Number((BigInt(v) * BigInt(percent) + 50n) / 100n);
  const first = round(total), firstFee = round(fee), firstDelivery = round(delivery), firstPrincipal = first - firstFee - firstDelivery;
  const o = { id: orderId, clientId: 'client0', state: 'initial_payment_review', createdAt: AT, updatedAt: AT,
    moneyModelVersion: 3, commercialCommittedAt: AT, quoteVersion: 1, payoutPlanVersion: 2, supplierDownpaymentRateBps: 10000,
    downpaymentPercent: percent, paymentPlan: 'order_match_qr_75_25', fulfillmentMode: 'delivery',
    supplierSubtotalMinor: principal, subtotalMinor: principal, serviceFeeRateBps: null, serviceFeeMinor: fee, grossServiceFeeMinor: fee,
    serviceFeeSchedule: { version: 2, rounding: 'half_up_once', brackets: [{ upToMinor: 200000, rateBps: 4500 }, { upToMinor: 2000000, rateBps: 2500 }, { upToMinor: null, rateBps: 1500 }] },
    organizationDiscountRateBps: 0, organizationDiscountMinor: 0, deliveryFeeMinor: delivery, riderCommissionBps: 8500,
    supplierPlatformPayoutMinor: principal, totalMinor: total, onlineDueMinor: total, directStoreDueMinor: 0,
    payments: { initial: { amountMinor: first, method: 'qr_manual', status: 'pending_confirmation' }, final_online: { amountMinor: total - first, method: 'qr_manual', status: percent === 100 ? 'not_required' : 'not_submitted' } },
    paymentAllocations: [['supplier_principal', principal, firstPrincipal], ['service_fee', fee, firstFee], ['delivery_pass_through', delivery, firstDelivery]].flatMap(([component, amount, initial]) => [
      { paymentCode: 'initial', component, amountMinor: initial }, { paymentCode: 'final_online', component, amountMinor: amount - initial }]).filter(a => a.amountMinor > 0), timeline: [] };
  o.payoutMilestones = createPayoutMilestones(o, { version: 2 }); return o;
}
test('PostgreSQL whole-order single/basket allocations protect full payouts, cash-only refunds and immutable funding', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  for (const groupCount of [1, 2]) for (const percent of groupCount === 1 ? [75, 100] : [100]) for (const valueMinor of [20000, 50000]) {
    await fixture(db, 2);
    await mutate(db, s => { s.promotionSettings[0].settings.founding.amountMinor = valueMinor; claimFounding(s, 'client0', ctx); });
    const orderIds = Array.from({ length: groupCount }, (_, n) => `order${n}`);
    await mutate(db, s => {
      s.carts = [{ id: 'cart', clientId: 'client0', state: 'draft', version: 1, fulfillmentMode: 'delivery', serviceLevel: 'standard', createdAt: AT, updatedAt: AT }];
      const orders = orderIds.map(key => order(key, groupCount === 1 ? 20000 : 6000, groupCount === 1 ? 10000 : 1000, percent));
      const v = s.vouchers[0], plan = voucherMoney(orders, v.valueMinor, v.data);
      orders.forEach((o, n) => applyVoucherMoney(o, plan.groups[n], v));
      s.orders.push(...orders); reserveVoucher(s, v, s.carts[0], { ...ctx, orderIds, amountMinor: plan.voucherDiscountMinor });
    });
    await mutate(db, s => { confirmVoucher(s, s.orders, ctx); s.orders.forEach(o => Object.values(o.payments).forEach(p => { p.status = p === o.payments.initial || p.amountMinor ? 'confirmed' : 'not_required'; })); });
    const s = await loadStore(db);
    for (const o of s.orders) {
      assert.equal(collectedSupplierPrincipalMinor(o), o.supplierSubtotalMinor);
      assert.equal(calculateRefundSettlement(o, { beforeProduction: true, shopEntitlementMinor: 0, riderEntitlementMinor: 0 }).totalMinor, o.totalMinor);
      assert.equal(calculateRefundSettlement(o, { beforeProduction: false, shopEntitlementMinor: o.supplierSubtotalMinor, riderEntitlementMinor: o.riderPayoutMinor }).principalMinor, 0);
      assert.equal(o.payoutMilestones.reduce((sum, p) => sum + p.amountMinor, 0), o.supplierSubtotalMinor);
      await assert.rejects(db.query("UPDATE order_payment_allocations SET gridgo_funded_minor=gridgo_funded_minor+1 WHERE order_id=$1 AND component='supplier_principal'", [o.id]), /immutable|reconcile/);
      await assert.rejects(db.query("UPDATE orders SET data=jsonb_set(data,'{gridgoSupplierTopupMinor}','1') WHERE id=$1", [o.id]), /immutable/);
    }
    await db.query('SELECT validate_refund_funds($1)', [s.orders[0].id]);
  }
});
test('HTTP promotion permissions, claim race, expectedVersion and admin usage projections', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close()); await fixture(db, 3);
  const api = await apiForTest(t);
  assert.equal((await api(null, 'GET', '/me/promotions')).status, 401);
  assert.equal((await api('client0', 'GET', '/admin/promotions')).status, 403);
  assert.equal((await api('client0', 'PATCH', '/admin/promotions', { expectedVersion: 1 })).status, 403);
  const before = await api('admin', 'GET', '/admin/promotions'); assert.equal(before.body.version, 1);
  const setting = await api('admin', 'PATCH', '/admin/promotions', { expectedVersion: 1, founding: { slots: 1 } });
  assert.equal(setting.status, 200); assert.equal(setting.body.version, 2);
  const race = await Promise.all([api('client0', 'POST', '/me/promotions/founding/claim', {}), api('client1', 'POST', '/me/promotions/founding/claim', {})]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  const winner = race[0].status === 200 ? 'client0' : 'client1';
  const invite = await api(winner, 'POST', '/me/promotions/friend-pass/invite', { email: 'client2@launch.test' }); assert.equal(invite.status, 200);
  assert.ok((await api('client2', 'GET', '/me/promotions')).body.friendPass.offer);
  const claimed = await api('client2', 'POST', '/me/promotions/friend-pass/claim', {}); assert.equal(claimed.status, 200);
  assert.equal(claimed.body.friendPass.voucher.valueMinor, 10000);
  const admin = await api('admin', 'GET', '/admin/promotions');
  assert.equal(admin.body.budget.committedMinor, 30000); assert.equal(admin.body.founding.claimed, 1);
  assert.equal(admin.body.friendPass.invites[0].founder.id, winner);
  assert.equal((await api('admin', 'PATCH', '/admin/promotions', { expectedVersion: 1 })).body.error, 'settings_version_conflict');
});

test('PostgreSQL adjustable survey/mission/referral rewards preserve issued values and the existing reward rules', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, promotion_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const s = testerFixture();
  const at = new Date().toISOString(), rewardCtx = { id, at };
  s.surveyLaunchedAt = (await db.query('SELECT launched_at FROM survey_launch')).rows[0].launched_at; s.settings.foundingTesterLaunchAt = '2026-01-01T00:00:00.000Z';
  s.promotionSettings = [{ id: 'launch', version: 1, settings: defaultPromotionSettings() }];
  s.promotionSettings[0].settings.rewards = { surveyMinor: 1700, missionMinor: 1800, inviteMinor: 1900 };
  s.orders[0].state = 'issue_window_open'; s.orders[0].issueWindowOpenedAt = at;
  syncSurveys(s, rewardCtx); submitSurvey(s, s.orders[0], { fulfillmentStars: 5, easeStars: 4, priceFeeling: 3 }, rewardCtx);
  await db.transaction(() => saveStore(db, s));
  let stored = await loadStore(db); assert.equal(stored.vouchers[0].valueMinor, 1700);
  // Existing survey entitlement is reused even after the live amount changes.
  await mutate(db, s => {
    s.promotionSettings[0].settings.rewards.surveyMinor = 2200;
    s.settings.foundingTesterLaunchAt = null;
    s.foundingTesters = [{ clientId: 'client', addedAt: at }];
    s.testerTracking = [{ clientId: 'client', orderId: 'order', createdAt: at }];
    reconcileFoundingTester(s, 'client', rewardCtx);
  });
  stored = await loadStore(db); assert.equal(stored.vouchers.length, 1); assert.equal(stored.vouchers[0].valueMinor, 1700);
  assert.equal(stored.foundingTesters[0].rewardReused, true);
  // A second tester earns the current mission amount and both referral sides earn inviteMinor.
  await mutate(db, s => {
    const otherOrder = structuredClone(s.orders[0]); otherOrder.id = 'other-order'; otherOrder.clientId = 'other';
    otherOrder.dropoff = { lat: 7.2, lng: 125.6, label: 'Different delivery destination' };
    s.orders.push(otherOrder);
    s.orderLineItems.push({ ...structuredClone(s.orderLineItems[0]), id: 'other-line', orderId: 'other-order', jobId: null });
    createInviteCode(s, 'client', rewardCtx);
    submitTesterInvite(s, { code: s.testerInviteCodes[0].code, email: 'other@example.invalid' }, rewardCtx);
    s.testerInvites[0].clientId = 'other'; s.testerInvites[0].matchedAt = at; s.testerInvites[0].unmatchedReason = null;
    s.foundingTesters.push({ clientId: 'other', addedAt: at });
    s.testerTracking.push({ clientId: 'other', orderId: 'other-order', createdAt: at });
    syncSurveys(s, rewardCtx); submitSurvey(s, otherOrder, { fulfillmentStars: 5, easeStars: 4, priceFeeling: 3 }, rewardCtx);
    reconcileTesterInvite(s, 'other', rewardCtx);
  });
  stored = await loadStore(db);
  assert.ok(stored.vouchers.some(v => v.clientId === 'other' && v.valueMinor === 1800));
  assert.equal(stored.vouchers.filter(v => v.valueMinor === 1900).length, 2);
  assert.equal(stored.testerRewards.find(r => r.kind === 'referral').amountMinor, 3800);
});

test('real cart checkout snapshots whole-order funding into single invoices and multi-shop basket receipts', { skip: !DB }, async t => {
  const db = createDatabase({ DATABASE_URL: DB }); t.after(() => db.close());
  for (const shops of [1, 2]) {
    await resetDatabase(db, 'TRUNCATE users, platform_settings, voucher_campaigns, promotion_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
    const s = testerFixture(); s.settings.downpaymentPercent = 75;
    s.settings.serviceFeeSchedule = { version: 2, rounding: 'half_up_once', brackets: [{ upToMinor: 200000, rateBps: 4500 }, { upToMinor: 2000000, rateBps: 2500 }, { upToMinor: null, rateBps: 1500 }] };
    s.promotionSettings = [{ id: 'launch', version: 1, settings: defaultPromotionSettings() }];
    s.promotionSettings[0].settings.founding.amountMinor = shops * 20000;
    for (const [fileId, purpose] of [['artwork', 'artwork'], ['receipt', 'payment_proof']]) s.files.push({ fileId, purpose, ownerId: 'client', state: 'ready', objectKey: `private/${fileId}`, originalFilename: `${fileId}.pdf`, size: 100,
      declaredContentType: 'application/pdf', detectedContentType: 'application/pdf', artworkCheck: { status: 'passed', checkedAt: AT }, createdAt: AT, references: [] });
    claimFounding(s, 'client', ctx);
    await db.transaction(() => saveStore(db, s));
    const client = s.users.find(u => u.id === 'client');
    const call = (method, path, body = {}) => routeOrderMatch({ store: s, user: client, req: { method, headers: {} }, url: new URL(path, 'http://test'), readBody: async () => body, id, now: () => AT });
    const made = await call('POST', '/me/carts', { fulfillmentMode: 'delivery', defaultDropoff: s.orders[0].dropoff });
    const path = `/me/carts/${made.body.cart.id}`;
    for (const shop of ['supplier', 'replacement'].slice(0, shops)) await call('POST', `${path}/lines`, { catalogItemId: `item_${shop}`, quantity: 10, optionIds: [], artworkFileId: 'artwork', deadline: '2026-10-30T10:00:00.000Z' });
    const preview = await call('GET', `${path}/quote`);
    assert.equal(preview.body.quote.voucherDiscountMinor, shops * 20000);
    const placed = await call('POST', `${path}/checkout`, { payment: { method: 'qr_manual', proofFileId: 'receipt', reference: `LAUNCH-${shops}` } });
    assert.equal(placed.status, 201);
    const newOrders = s.orders.filter(o => o.id !== 'order');
    assert.equal(newOrders.length, shops);
    assert.equal(newOrders.reduce((n, o) => n + o.payments.initial.amountMinor, 0), preview.body.quote.downpaymentMinor);
    assert.equal(newOrders.reduce((n, o) => n + o.totalMinor, 0), preview.body.quote.totalMinor);
    assert.ok(newOrders.every(o => o.gridgoSupplierTopupMinor > 0));
    await db.transaction(() => saveStore(db, s));
    const stored = await loadStore(db), invoice = stored.orderInvoices[0].snapshot;
    assert.equal(invoice.voucherDiscountMinor, shops * 20000);
    assert.ok(invoice.voucherSupplierMinor > 0);
    if (shops === 2) {
      assert.ok(invoice.groups.every(g => g.voucher.supplierMinor > 0));
      assert.equal(stored.baskets.length, 1);
      assert.ok(newOrders.every(o => o.downpaymentPercent === 100));
    }
  }
});
