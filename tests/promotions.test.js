import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { defaultPromotionSettings } from '../src/promotion-settings.js';
import { claimFounding, inviteFriend, claimFriendPass, myPromotions, adminPromotions, sweepPromotions, promotionSlotsLeft, promotionBudget, reconcilePromotionInvites } from '../src/promotions.js';
import { routePromotions } from '../src/promotion-routes.js';
import { issueVoucher, selectVoucher, sweepVouchers } from '../src/vouchers.js';
import { voucherMoney, applyVoucherMoney } from '../src/voucher-money.js';
import { createPayoutMilestones, collectedSupplierPrincipalMinor, deliverySplit, publicOrderFor } from '../src/operational-model.js';
import { calculateRefundSettlement } from '../src/refund-policy.js';
import { clientInvoice } from '../src/invoice-projection.js';
import { fixture as domainFixture } from './fixtures/reschedule.js';
import { createTesterReward, issueTesterReward } from '../src/tester-rewards.js';

const AT = '2026-10-27T01:00:00.000Z', UPGRADE = '2026-11-01T16:00:00.000Z';
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const ctx = { id, at: AT };
function fixture(count = 6) {
  const users = Array.from({ length: count }, (_, n) => ({ id: `client${n}`, email: `client${n}@launch.test`, name: `Client ${n}`, role: 'client', accountStatus: 'active' }));
  return { users, userRoleMemberships: users.map(u => ({ userId: u.id, role: 'client' })), notifications: [], auditLog: [],
    voucherCampaigns: [], vouchers: [], voucherReservations: [], voucherRedemptions: [], voucherLedger: [],
    promotionSettings: [{ id: 'launch', version: 1, settings: defaultPromotionSettings() }], promotionInvites: [], settings: {} };
}
const settings = s => s.promotionSettings[0].settings;
const voucher = (s, user = 'client0') => s.vouchers.find(v => v.clientId === user);
function friend(s, founder = 'client0', target = 'client1', at = AT) {
  inviteFriend(s, founder, `${target}@launch.test`, { id, at });
  claimFriendPass(s, target, { id, at });
}
test('Founding launch claims are client-only, window-bound and permanently exclusive with friend passes', () => {
  const s = fixture();
  assert.equal(myPromotions(s, 'client0', AT).founding.slotsLeft, 30);
  assert.throws(() => claimFounding(s, 'client0', { id, at: '2026-10-26T00:00:00Z' }), { code: 'promotion_not_started' });
  claimFounding(s, 'client0', ctx);
  assert.equal(voucher(s).valueMinor, 20000);
  assert.equal(myPromotions(s, 'client0', AT).founding.slotsLeft, 29);
  assert.equal(s.voucherEmailOutbox.length, 0);
  assert.equal(s.notifications.filter(n => n.userId === 'client0' && n.type === 'voucher_issued').length, 1);
  for (const status of ['available', 'used', 'void']) {
    voucher(s).status = status;
    assert.throws(() => claimFounding(s, 'client0', ctx), { code: 'promotion_already_has_discount' });
    assert.throws(() => claimFriendPass(s, 'client0', ctx), { code: 'promotion_already_has_discount' });
  }
  for (const kind of ['review', 'suspended', 'staff', 'super_admin', 'ops_admin', 'nonclient']) {
    const t = fixture();
    if (kind === 'review') t.users[0].reviewData = true;
    else if (kind === 'suspended') t.users[0].accountStatus = 'suspended';
    else if (kind === 'nonclient') t.userRoleMemberships = [];
    else t.userRoleMemberships.push({ userId: 'client0', role: kind });
    assert.throws(() => claimFounding(t, 'client0', ctx), { code: 'promotion_ineligible_account' });
  }
  assert.throws(() => claimFounding(fixture(), 'client0', { id, at: '2026-11-08T15:59:59Z' }), { code: 'promotion_ended' });
});
test('unused expiry and void return slots and commitment, but never restore a personal entitlement', () => {
  const s = fixture(); settings(s).founding.slots = 1;
  claimFounding(s, 'client0', ctx);
  assert.throws(() => claimFounding(s, 'client1', ctx), { code: 'promotion_sold_out' });
  voucher(s).expiresAt = '2026-10-28T00:00:00.000Z';
  const later = { id, at: '2026-10-29T00:00:00.000Z' };
  sweepVouchers(s, later);
  assert.equal(promotionSlotsLeft(s, later.at), 1);
  assert.equal(promotionBudget(s, later.at).committedMinor, 0);
  assert.throws(() => claimFounding(s, 'client0', later), { code: 'promotion_already_has_discount' });
  claimFounding(s, 'client1', later);
  voucher(s, 'client1').status = 'used';
  voucher(s, 'client1').expiresAt = '2026-10-29T01:00:00Z';
  assert.equal(promotionSlotsLeft(s, '2026-10-30T00:00:00Z'), 0);
  voucher(s, 'client1').status = 'void';
  assert.equal(promotionSlotsLeft(s, later.at), 1);
});
test('Friend Pass is normalized, private to the matched account, and skips existing Founders without spending invite quotas', () => {
  const s = fixture();
  claimFounding(s, 'client0', ctx); claimFounding(s, 'client1', ctx);
  inviteFriend(s, 'client0', ' CLIENT1@LAUNCH.TEST ', ctx);
  assert.equal(s.promotionInvites[0].status, 'skipped_already_founder');
  assert.equal(myPromotions(s, 'client0', AT).friendPass.canInvite, true);
  friend(s, 'client0', 'client2');
  assert.equal(voucher(s, 'client2').valueMinor, 10000);
  assert.equal(s.notifications.filter(n => n.userId === 'client2' && n.type === 'promotion_friend_pass_waiting').length, 1);
  assert.equal(reconcilePromotionInvites(s, ctx), false);
  assert.throws(() => inviteFriend(s, 'client0', 'client3@launch.test', ctx), { code: 'promotion_invite_used' });
  assert.throws(() => inviteFriend(s, 'client1', 'client2@launch.test', ctx), { code: 'promotion_email_already_invited' });
  assert.throws(() => inviteFriend(s, 'client1', 'CLIENT1@LAUNCH.TEST', ctx), { code: 'promotion_self_invite' });
  assert.throws(() => claimFounding(s, 'client2', ctx), { code: 'promotion_already_has_discount' });
  assert.equal(myPromotions(s, 'client3', AT).friendPass.offer, null);
  const newClient = fixture(); claimFounding(newClient, 'client0', ctx);
  inviteFriend(newClient, 'client0', 'future@launch.test', ctx);
  newClient.users[1].email = 'Future@launch.test';
  assert.ok(myPromotions(newClient, 'client1', AT).friendPass.offer);
  reconcilePromotionInvites(newClient, ctx);
  assert.equal(newClient.promotionInvites[0].clientId, 'client1');
  claimFounding(newClient, 'client1', ctx);
  assert.equal(newClient.promotionInvites[0].status, 'skipped_already_founder');
});
test('automatic upgrades are earliest-claim-first, budget-limited, reservation-safe and idempotent', () => {
  const s = fixture(8); settings(s).friendPass.perFounder = 5;
  claimFounding(s, 'client0', ctx);
  for (let n = 1; n <= 4; n++) friend(s, 'client0', `client${n}`, `2026-10-2${7 + Math.floor(n / 3)}T0${n}:00:00.000Z`);
  settings(s).founding.slots = 3;
  s.voucherReservations.push({ id: 'reserved', voucherId: voucher(s, 'client1').id, status: 'reserved', expiresAt: '2026-11-02T00:00:00Z' });
  voucher(s, 'client4').status = 'used';
  assert.equal(sweepPromotions(s, { id, at: AT }), false);
  assert.equal(sweepPromotions(s, { id, at: UPGRADE }), true);
  assert.equal(voucher(s, 'client1').valueMinor, 10000);
  assert.equal(voucher(s, 'client2').valueMinor, 20000);
  assert.equal(voucher(s, 'client3').valueMinor, 20000);
  assert.equal(voucher(s, 'client4').valueMinor, 10000);
  assert.equal(promotionSlotsLeft(s, UPGRADE), 0);
  assert.equal(sweepPromotions(s, { id, at: UPGRADE }), false);
  assert.equal(s.voucherLedger.filter(l => l.kind === 'upgraded').length, 2);
  assert.equal(s.auditLog.filter(l => l.action === 'voucher.upgraded').length, 2);
  const b = fixture(); settings(b).friendPass.perFounder = 2;
  claimFounding(b, 'client0', ctx); friend(b); friend(b, 'client0', 'client2');
  settings(b).budgetCapMinor = 50000;
  sweepPromotions(b, { id, at: UPGRADE });
  assert.equal(voucher(b, 'client1').valueMinor, 20000);
  assert.equal(voucher(b, 'client2').valueMinor, 10000);
  assert.equal(promotionBudget(b, UPGRADE).committedMinor, 50000);
  assert.throws(() => claimFounding(b, 'client3', ctx), { code: 'promotion_budget_reached' });
});
test('settings version handshake, strict validation, staff authorization and claim snapshots', async () => {
  const s = fixture(); const admin = { id: 'super', role: 'super_admin' };
  const call = (user, method, path, body) => routePromotions({ store: s, user, req: { method }, url: new URL(path, 'http://test'), readBody: async () => body, id, now: () => AT });
  claimFounding(s, 'client0', ctx);
  const response = await call(admin, 'PATCH', '/admin/promotions', { expectedVersion: 1, founding: { amountMinor: 25000 }, rewards: { missionMinor: 1700, inviteMinor: 1900, surveyMinor: 1800 } });
  assert.equal(response.body.version, 2);
  claimFounding(s, 'client1', ctx);
  assert.equal(voucher(s).valueMinor, 20000); assert.equal(voucher(s, 'client1').valueMinor, 25000);
  assert.equal(response.body.settings.rewards.surveyMinor, 1800);
  assert.deepEqual(myPromotions(s, 'client0', AT).rewards, { surveyMinor: 1800, missionMinor: 1700, inviteMinor: 1900 });
  await assert.rejects(call(admin, 'PATCH', '/admin/promotions', { expectedVersion: 1 }), { code: 'settings_version_conflict' });
  await assert.rejects(call({ role: 'ops_admin' }, 'PATCH', '/admin/promotions', { expectedVersion: 2 }), { status: 403 });
  await assert.rejects(call(admin, 'PATCH', '/admin/promotions', { expectedVersion: 2, founding: { amountMinor: 1.5 } }), { code: 'invalid_promotion_settings' });
  await assert.rejects(call(admin, 'PATCH', '/admin/promotions', { expectedVersion: 2, budgetCapMinor: 1 }), { code: 'promotion_budget_reached' });
  await assert.rejects(call(null, 'GET', '/me/promotions'), { status: 401 });
  assert.equal((await call({ role: 'ops_admin' }, 'GET', '/admin/promotions')).body.founding.claims.length, 2);
  const reward = createTesterReward(s, { kind: 'mission', clientId: 'client2', amountMinor: 1700 }, ctx);
  issueTesterReward(s, reward, ctx); assert.equal(voucher(s, 'client2').valueMinor, 1700);
  const referral = createTesterReward(s, { kind: 'referral', clientId: 'client3', inviterId: 'client4', amountMinor: 3800 }, ctx);
  issueTesterReward(s, referral, ctx); assert.equal(voucher(s, 'client3').valueMinor, 1900); assert.equal(voucher(s, 'client4').valueMinor, 1900);
});
function order(principal = 20000, fee = 9000, delivery = 10000, percent = 100) {
  const total = principal + fee + delivery;
  const p = v => Number((BigInt(v) * BigInt(percent) + 50n) / 100n);
  const initial = p(total), initialFee = p(fee), initialDelivery = p(delivery), initialPrincipal = initial - initialFee - initialDelivery;
  const o = { id: id('ord'), clientId: 'client0', moneyModelVersion: 3, payoutPlanVersion: 2,
    supplierSubtotalMinor: principal, supplierPlatformPayoutMinor: principal, serviceFeeMinor: fee, grossServiceFeeMinor: fee,
    serviceFeeSchedule: { version: 2 }, deliveryFeeMinor: delivery, totalMinor: total, organizationDiscountMinor: 0,
    ...deliverySplit(delivery, 8500), payments: { initial: { amountMinor: initial, method: 'qr_manual', status: 'pending_confirmation' },
      final_online: { amountMinor: total - initial, method: 'qr_manual', status: percent === 100 ? 'not_required' : 'not_submitted' } },
    paymentAllocations: [['supplier_principal', principal, initialPrincipal], ['service_fee', fee, initialFee], ['delivery_pass_through', delivery, initialDelivery]].flatMap(([component, full, first]) =>
      [{ paymentCode: 'initial', component, amountMinor: first }, { paymentCode: 'final_online', component, amountMinor: full - first }]).filter(a => a.amountMinor > 0) };
  o.payoutMilestones = createPayoutMilestones(o, { version: 2 }); return o;
}
test('whole-order discounts fund supplier and rider without reducing entitlements, single and multi-shop', () => {
  for (const percent of [75, 100]) for (const amount of [15000, 30000, 999999]) {
    const orders = [order(20000, 9000, 10000, percent), order(10000, 4500, 2000, percent)];
    const before = orders.map(o => JSON.stringify([o.supplierPlatformPayoutMinor, o.payoutMilestones, o.riderPayoutMinor]));
    const plan = voucherMoney(orders, amount, { coversOrderTotal: true });
    assert.equal(plan.voucherDiscountMinor, Math.min(amount, 55500));
    orders.forEach((o, i) => {
      applyVoucherMoney(o, plan.groups[i], { id: 'voucher', campaignId: 'campaign' });
      assert.equal(JSON.stringify([o.supplierPlatformPayoutMinor, o.payoutMilestones, o.riderPayoutMinor]), before[i]);
      assert.equal(Object.values(o.payments).reduce((t, p) => t + p.amountMinor, 0), o.totalMinor);
      assert.ok(o.totalMinor >= 0);
      assert.equal(o.paymentAllocations.filter(a => a.component === 'supplier_principal').reduce((t, a) => t + a.amountMinor + (a.gridgoFundedMinor || 0), 0), o.supplierSubtotalMinor);
      Object.values(o.payments).forEach(p => { p.status = 'confirmed'; });
      assert.equal(collectedSupplierPrincipalMinor(o), o.supplierSubtotalMinor);
      const full = calculateRefundSettlement(o, { beforeProduction: true, shopEntitlementMinor: 0, riderEntitlementMinor: 0 });
      assert.equal(full.totalMinor, o.totalMinor);
      const partial = calculateRefundSettlement(o, { beforeProduction: false, shopEntitlementMinor: o.supplierSubtotalMinor, riderEntitlementMinor: o.riderPayoutMinor });
      assert.equal(partial.principalMinor, 0);
      assert.ok(partial.totalMinor <= o.totalMinor);
    });
  }
  const only = order(20000, 0, 10000);
  const plan = voucherMoney([only], 20000, { coversOrderTotal: true });
  applyVoucherMoney(only, plan.groups[0], { id: 'v', campaignId: 'c' });
  assert.equal(only.totalMinor, 10000); assert.equal(only.gridgoSupplierTopupMinor, 10000); assert.equal(only.gridgoRiderTopupMinor, 8500);
  assert.equal(voucherMoney([order()], 999999).voucherDiscountMinor, 9000);
});
test('auto-selection maximizes actual discount and honors explicit remove/choice, with stable ties', () => {
  const s = fixture(); claimFounding(s, 'client0', ctx);
  const campaign = { id: 'reward', name: 'Reward', status: 'active', mode: 'assigned', purpose: 'survey', valueMinor: 1500, totalLimit: 1, validityDays: 30 };
  s.voucherCampaigns.push(campaign); const reward = issueVoucher(s, campaign, 'client0', ctx).voucher;
  const cart = { id: 'cart', clientId: 'client0' }, groups = [order()];
  assert.equal(selectVoucher(s, cart, groups, AT).id, voucher(s).id);
  s.voucherCartChoices = [{ id: 'cart', voucherId: reward.id }]; assert.equal(selectVoucher(s, cart, groups, AT).id, reward.id);
  s.voucherCartChoices[0].removed = true; assert.equal(selectVoucher(s, cart, groups, AT), null);
  assert.equal(adminPromotions(s, AT).budget.committedMinor, 20000);
  s.voucherCartChoices = [];
  voucher(s).valueMinor = 10000; reward.valueMinor = 999999;
  assert.equal(selectVoucher(s, cart, groups, AT).id, voucher(s).id); // Ordinary reward caps at the 9000 fee.
});

test('client and supplier projections keep funding details private while staff can reconcile the top-up', () => {
  const s = domainFixture(), o = s.orders[0];
  applyVoucherMoney(o, voucherMoney([o], 5000, { coversOrderTotal: true }).groups[0], { id: 'voucher', campaignId: 'campaign' });
  const client = publicOrderFor(o, { id: 'client', role: 'client' }, s);
  assert.equal(client.voucherDiscountMinor, 5000);
  for (const field of ['voucherSupplierMinor', 'clientSupplierSubtotalMinor', 'gridgoSupplierTopupMinor', 'gridgoRiderTopupMinor']) assert.equal(field in client, false);
  assert.equal('supplierMinor' in client.voucher, false);
  const supplier = publicOrderFor(o, { id: 'supplier', role: 'supplier' }, s);
  assert.equal('voucher' in supplier, false);
  assert.ok(supplier.paymentAllocations.every(a => !('gridgoFundedMinor' in a)));
  const staff = publicOrderFor(o, { id: 'admin', role: 'super_admin' }, s);
  assert.equal(staff.voucherFunding.supplierMinor, 3000);
  const raw = { itemSubtotalMinor: 10000, serviceFeeMinor: 1000, deliveryFeeMinor: 1000, lines: [], voucher: o.voucher, voucherSupplierMinor: o.voucherSupplierMinor };
  assert.equal('supplierMinor' in clientInvoice(raw).voucher, false);
  assert.equal(clientInvoice(raw, { exposeWorking: true }).voucher.supplierMinor, 3000);
});

test('expired pending offers do not send stale waiting notices, and a changed email cannot create duplicate offers for one identity', () => {
  const s = fixture(); claimFounding(s, 'client0', ctx); claimFounding(s, 'client2', ctx);
  inviteFriend(s, 'client0', 'future@launch.test', ctx);
  s.users[1].email = 'future@launch.test';
  reconcilePromotionInvites(s, { id, at: '2026-11-09T00:00:00Z' });
  assert.equal(s.notifications.filter(n => n.type === 'promotion_friend_pass_waiting').length, 0);
  s.users[1].email = 'new-address@launch.test';
  assert.throws(() => inviteFriend(s, 'client2', 'new-address@launch.test', ctx), { code: 'promotion_email_already_invited' });
  assert.throws(() => inviteFriend(s, 'client2', ['new-address@launch.test'], ctx), { code: 'invalid_promotion_email' });
});
