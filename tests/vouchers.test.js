import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { voucherMoney, splitVoucherMinor, applyVoucherMoney } from '../src/voucher-money.js';
import { issueVoucher, reserveVoucher, confirmVoucher, restoreVoucherForRefund, sweepVouchers, addVoucherCode, publicVoucher } from '../src/vouchers.js';
import { routeVouchers, parseVoucherCsv } from '../src/voucher-routes.js';
import { calculateRefundSettlement } from '../src/refund-policy.js';
import { createPayoutMilestones, deliverySplit } from '../src/operational-model.js';

const AT = '2026-10-09T00:00:00.000Z';
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const atOptions = { id, at: AT, actorId: 'super' };
function fixture({ valueMinor = 1500, mode = 'assigned' } = {}) {
  const campaign = { id: 'campaign', name: 'Tester thanks', code: 'TESTERS', status: 'active', mode, valueMinor, totalLimit: 10, perAccountLimit: 1, endsAt: null, validityDays: 7, createdAt: AT, updatedAt: AT };
  const store = { users: [{ id: 'client', email: 'client@example.test' }, { id: 'super', role: 'super_admin' }, { id: 'ops', role: 'ops_admin' }],
    userRoleMemberships: [{ userId: 'client', role: 'client' }, { userId: 'super', role: 'super_admin' }, { userId: 'ops', role: 'ops_admin' }], voucherCampaigns: [campaign], notifications: [], auditLog: [] };
  const voucher = issueVoucher(store, campaign, 'client', atOptions).voucher;
  return { store, campaign, voucher, cart: { id: 'cart', clientId: 'client' } };
}
function order({ fee = 1000, delivery = 8900, principal = 10000, percent = 100 } = {}) {
  const total = principal + fee + delivery;
  const p = value => Number((BigInt(value) * BigInt(percent) + 50n) / 100n);
  const initial = p(total), feeInitial = p(fee), deliveryInitial = p(delivery), principalInitial = initial - feeInitial - deliveryInitial;
  const result = { id: 'order', clientId: 'client', state: 'initial_payment_review', supplierSubtotalMinor: principal, supplierPlatformPayoutMinor: principal,
    grossServiceFeeMinor: fee, serviceFeeMinor: fee, deliveryFeeMinor: delivery, totalMinor: total, organizationDiscountMinor: 0,
    ...deliverySplit(delivery, 8500), payments: { initial: { amountMinor: initial, status: 'pending_confirmation', method: 'qr_manual' }, final_online: { amountMinor: total - initial, status: percent === 100 ? 'not_required' : 'not_submitted', method: 'qr_manual' } },
    paymentAllocations: [['supplier_principal', principal, principalInitial], ['service_fee', fee, feeInitial], ['delivery_pass_through', delivery, deliveryInitial]].flatMap(([component, full, first]) => [
      { paymentCode: 'initial', component, amountMinor: first }, { paymentCode: 'final_online', component, amountMinor: full - first }]).filter(a => a.amountMinor > 0) };
  result.payoutMilestones = createPayoutMilestones(result);
  return result;
}
test('fee-first voucher floors, safe integer arithmetic and proportional remainder allocation', () => {
  const groups = [{ supplierSubtotalMinor: 10000, grossServiceFeeMinor: 1000, deliveryFeeMinor: 2000 }];
  assert.deepEqual(voucherMoney(groups, 1500).groups[0], { organizationDiscountMinor: 0, organizationDiscountRateBps: 0,
    serviceFeeMinor: 1000, voucherDiscountMinor: 1500, voucherServiceFeeMinor: 1000, voucherDeliveryMinor: 500,
    clientServiceFeeMinor: 0, clientDeliveryFeeMinor: 1500, totalMinor: 11500 });
  assert.equal(voucherMoney(groups, 999999).groups[0].totalMinor, 10000);
  assert.deepEqual(splitVoucherMinor(7, [100, 100, 100]), [3, 2, 2]);
  assert.deepEqual(splitVoucherMinor(9, [0, 0]), [5, 4]);
  assert.throws(() => voucherMoney(groups, 1.5), RangeError);
  assert.deepEqual(splitVoucherMinor(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, 1]).reduce((a,b) => a + BigInt(b), 0n), BigInt(Number.MAX_SAFE_INTEGER));
});
test('only the larger discount applies; organization wins a tie', () => {
  const g = [{ supplierSubtotalMinor: 30000, grossServiceFeeMinor: 3000, deliveryFeeMinor: 1000, organizationDiscountMinor: 1500, organizationDiscountRateBps: 500 }];
  for (const value of [1000, 1500]) { const plan = voucherMoney(g, value); assert.equal(plan.discountKind, 'organization'); assert.equal(plan.groups[0].totalMinor, 32500); }
  const plan = voucherMoney(g, 1501); assert.equal(plan.organizationDiscountMinor, 0); assert.equal(plan.groups[0].organizationDiscountRateBps, 0); assert.equal(plan.groups[0].totalMinor, 32499);
});
test('multi-shop split uses fee shares and redistributes delivery overflow without touching principal', () => {
  const g = [{ supplierSubtotalMinor: 1000, grossServiceFeeMinor: 100, deliveryFeeMinor: 0 }, { supplierSubtotalMinor: 3000, grossServiceFeeMinor: 300, deliveryFeeMinor: 1000 }];
  assert.deepEqual(voucherMoney(g, 200).groups.map(g => g.voucherDiscountMinor), [50, 150]);
  assert.deepEqual(voucherMoney(g, 1000).groups.map(g => g.voucherDiscountMinor), [100, 900]);
  assert.equal(voucherMoney(g, 99999).groups.reduce((sum, g) => sum + g.totalMinor, 0), 4000);
});
test('supplier payout stages, principal allocations and rider earnings are byte-for-byte unchanged', () => {
  for (const percent of [75, 100]) {
    const o = order({ percent });
    const before = JSON.stringify({ stages: o.payoutMilestones, principal: o.paymentAllocations.filter(a => a.component === 'supplier_principal'), rider: o.riderPayoutMinor, split: o.riderCommissionBps, delivery: o.deliveryFeeMinor });
    applyVoucherMoney(o, voucherMoney([o], 1500).groups[0], { id: 'v', campaignId: 'c' });
    assert.equal(JSON.stringify({ stages: o.payoutMilestones, principal: o.paymentAllocations.filter(a => a.component === 'supplier_principal'), rider: o.riderPayoutMinor, split: o.riderCommissionBps, delivery: o.deliveryFeeMinor }), before);
    assert.equal(Object.values(o.payments).reduce((s,p) => s+p.amountMinor,0), o.totalMinor);
    o.payments.initial.status = 'confirmed'; if (percent === 100) {
      const refund = calculateRefundSettlement(o, { beforeProduction: true, shopEntitlementMinor: 0, riderEntitlementMinor: 0 });
      assert.equal(refund.totalMinor, o.totalMinor); assert.equal(refund.feeMinor, 0); assert.equal(refund.deliveryMinor, 8400);
    }
  }
});
test('reservation ownership, double-use prevention, confirmation expiry and released checkout refusal', () => {
  const { store, voucher, cart } = fixture();
  reserveVoucher(store, voucher, cart, { ...atOptions, orderIds: ['order'], amountMinor: 1500 });
  assert.throws(() => reserveVoucher(store, voucher, { ...cart, id: 'other' }, atOptions), { code: 'voucher_unavailable' });
  const o = { id: 'order', voucher: { id: voucher.id } };
  assert.throws(() => confirmVoucher(store, [o], { ...atOptions, at: '2026-10-09T00:30:00.000Z' }), { code: 'voucher_expired_or_unavailable' });
  confirmVoucher(store, [o], atOptions);
  assert.equal(voucher.status, 'used'); assert.equal(store.voucherRedemptions.length, 1);
  assert.throws(() => confirmVoucher(store, [o], atOptions), { code: 'voucher_expired_or_unavailable' });
  const other = fixture(); reserveVoucher(other.store, other.voucher, other.cart, atOptions);
  sweepVouchers(other.store, { ...atOptions, at: '2026-10-09T00:31:00.000Z' });
  assert.equal(other.store.voucherReservations[0].status, 'released');
});
test('expired voucher refuses payment even when reservation timestamp is later', () => {
  const { store, voucher, cart } = fixture();
  reserveVoucher(store, voucher, cart, { ...atOptions, orderIds: ['order'], amountMinor: 1500 });
  voucher.expiresAt = '2026-10-09T00:01:00.000Z';
  assert.throws(() => confirmVoucher(store, [{ id: 'order', voucher: {} }], { ...atOptions, at: voucher.expiresAt }), { code: 'voucher_expired_or_unavailable' });
});
test('no-fault restoration is idempotent, unexpired only and waits for all basket groups', () => {
  for (const fault of [true, false]) {
    const { store, voucher, cart } = fixture();
    const orders = [{ id: 'one', voucher: {} }, { id: 'two', voucher: {} }];
    reserveVoucher(store, voucher, cart, { ...atOptions, orderIds: orders.map(o => o.id), amountMinor: 1500 });
    confirmVoucher(store, orders, atOptions);
    restoreVoucherForRefund(store, orders[0], { ...atOptions, clientCaused: false, reason: 'shop' });
    assert.equal(voucher.status, 'used');
    restoreVoucherForRefund(store, orders[1], { ...atOptions, clientCaused: fault, reason: 'decision' });
    restoreVoucherForRefund(store, orders[1], { ...atOptions, clientCaused: fault, reason: 'retry' });
    assert.equal(voucher.status, fault ? 'used' : 'available');
    assert.equal(store.voucherLedger.filter(r => r.kind === 'restored').length, fault ? 0 : 1);
  }
});
test('bulk JSON/CSV email matching, idempotency, cap, staff permissions and wallet isolation', async () => {
  const { store, campaign } = fixture();
  const call = (user, method, path, body) => routeVouchers({ store, user, req: { method }, url: new URL(path, 'http://test'), readBody: async () => body, now: () => AT, id });
  const superUser = { id: 'super', role: 'super_admin' }, client = { id: 'client', role: 'client' }, ops = { id: 'ops', role: 'ops_admin' };
  const body = { emails: [' CLIENT@EXAMPLE.TEST ', 'missing@example.test', 'bad', 'client@example.test'] };
  const result = await call(superUser, 'POST', '/admin/voucher-campaigns/campaign/issue', body);
  assert.equal(result.body.matched.length, 2); assert.equal(result.body.unmatched.length, 2); assert.equal(store.vouchers.length, 1); assert.ok(result.body.matched.every(r => !r.issued));
  for (const user of [ops, client]) await assert.rejects(call(user, 'POST', '/admin/voucher-campaigns/campaign/issue', body), { status: 403 });
  await assert.rejects(call(client, 'GET', '/ops/vouchers?clientId=client'), { status: 403 });
  assert.equal((await call(ops, 'GET', '/ops/vouchers?clientId=client')).body.vouchers.length, 1);
  assert.equal((await call({ id: 'other', role: 'client' }, 'GET', '/me/vouchers')).body.vouchers.length, 0);
  assert.deepEqual(parseVoucherCsv('email,adultConfirmed\r\n"client@example.test",true\r\n'), [{ email: 'client@example.test', adultConfirmed: true }]);
  assert.throws(() => parseVoucherCsv('name\na'), { code: 'invalid_voucher_csv_header' });
  campaign.totalLimit = 1; store.userRoleMemberships.push({ userId: 'other', role: 'client' });
  assert.throws(() => issueVoucher(store, campaign, 'other', atOptions), { code: 'voucher_campaign_cap_reached' });
});
test('five wrong codes lock for fifteen minutes; counts persist and shared claims are unique', () => {
  const { store } = fixture({ mode: 'shared' });
  for (let n = 1; n <= 5; n++) assert.equal(addVoucherCode(store, 'client', 'wrong', atOptions).status, n === 5 ? 429 : 400);
  assert.equal(addVoucherCode(store, 'client', 'TESTERS', atOptions).status, 429);
  assert.equal(addVoucherCode(store, 'client', ' testers ', { ...atOptions, at: '2026-10-09T00:16:00.000Z' }).status, 200);
  assert.equal(store.vouchers.length, 1);
});
test('issue and 48/24 hour notices are deduplicated; under-18/unknown recipients get only in-app', () => {
  const { store, voucher, campaign } = fixture();
  assert.equal(store.voucherEmailOutbox.length, 0); assert.equal(store.notifications.find(n => n.userId === 'client').push, false);
  store.users.push({ id: 'adult', email: 'adult@example.test' }); store.userRoleMemberships.push({ userId: 'adult', role: 'client' });
  issueVoucher(store, campaign, 'adult', { ...atOptions, adultConfirmed: true });
  for (const at of ['2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z']) sweepVouchers(store, { id, at });
  assert.equal(store.notifications.filter(n => n.userId === 'client').length, 3);
  assert.equal(store.voucherEmailOutbox.length, 3);
  assert.equal(publicVoucher(store, voucher, voucher.expiresAt).status, 'expired');
});

test('campaign lifecycle, raw CSV issuance, void/reissue and CSV ledger export are staff-controlled', async () => {
  const { store } = fixture();
  const user = { id: 'super', role: 'super_admin' };
  const call = (method, path, body = {}, csv = null) => routeVouchers({ store, user, req: { method, headers: csv ? { 'content-type': 'text/csv' } : {} },
    url: new URL(path, 'http://test'), readBody: async () => body, readRawBody: async () => Buffer.from(csv), now: () => AT, id });
  const campaign = (await call('POST', '/admin/voucher-campaigns', { name: 'New', mode: 'assigned', valueMinor: 1500, totalLimit: 2, validityDays: 7 })).body.campaign;
  assert.equal(campaign.status, 'draft'); assert.match(campaign.code, /^[A-F0-9]{16}$/);
  await call('PATCH', `/admin/voucher-campaigns/${campaign.id}`, { name: 'Updated' });
  await call('POST', `/admin/voucher-campaigns/${campaign.id}/status`, { status: 'active' });
  await assert.rejects(call('PATCH', `/admin/voucher-campaigns/${campaign.id}`, { valueMinor: 5000 }), { code: 'voucher_campaign_immutable' });
  const issued = await call('POST', `/admin/voucher-campaigns/${campaign.id}/issue`, {}, 'email,adultConfirmed\r\nclient@example.test,true');
  assert.equal(issued.body.matched[0].issued, true);
  const voucherId = issued.body.matched[0].voucherId;
  await assert.rejects(call('POST', `/admin/vouchers/${voucherId}/void`, {}), { code: 'voucher_reason_required' });
  await call('POST', `/admin/vouchers/${voucherId}/void`, { reason: 'Correction' });
  assert.equal(store.vouchers.find(v => v.id === voucherId).status, 'void');
  await call('POST', `/admin/vouchers/${voucherId}/reissue`, { reason: 'Reissue after review' });
  assert.equal(store.vouchers.find(v => v.id === voucherId).status, 'available');
  const csv = await call('GET', `/admin/voucher-redemptions?campaignId=${campaign.id}&format=csv`);
  assert.match(csv.bytes.toString(), /reissue/);
  await call('POST', `/admin/voucher-campaigns/${campaign.id}/status`, { status: 'ended' });
  await assert.rejects(call('POST', `/admin/voucher-campaigns/${campaign.id}/status`, { status: 'active' }), { code: 'voucher_campaign_status_conflict' });
});

test('an expired no-fault refund does not extend voucher validity', () => {
  const { store, voucher, cart } = fixture();
  const o = { id: 'order', voucher: {} };
  reserveVoucher(store, voucher, cart, { ...atOptions, orderIds: [o.id], amountMinor: 1500 });
  confirmVoucher(store, [o], atOptions);
  restoreVoucherForRefund(store, o, { ...atOptions, at: voucher.expiresAt, clientCaused: false, reason: 'No fault' });
  assert.equal(voucher.status, 'used'); assert.equal(store.voucherLedger.filter(row => row.kind === 'restored').length, 0);
});

test('partial refunds prorate the fee actually paid after voucher funding', () => {
  const o = order();
  applyVoucherMoney(o, voucherMoney([o], 500).groups[0], { id: 'v', campaignId: 'c' });
  o.payments.initial.status = 'confirmed';
  const refund = calculateRefundSettlement(o, { beforeProduction: false, shopEntitlementMinor: 5000, riderEntitlementMinor: 0, principalMinor: 5000 });
  assert.equal(refund.feeMinor, 250);
});
