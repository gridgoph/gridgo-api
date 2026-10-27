import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, id, audit } from './fixtures/reschedule.js';
import { checkoutFixture, makeCart, AT } from './helpers/promotion-checkout.mjs';
import { claimFounding, inviteFriend, claimFriendPass, reconcilePromotionInvites, myPromotions } from '../src/promotions.js';
import { defaultPromotionSettings } from '../src/promotion-settings.js';
import { routeRefunds } from '../src/refunds.js';
import { voucherMoney, applyVoucherMoney } from '../src/voucher-money.js';
import { moneyReportingForOrder, deliverySplit, collectedSupplierPrincipalMinor } from '../src/operational-model.js';

for (const [percent, amount, quantities] of [[100, 20000, [1]], [75, 20000, [1]], [75, 21000, [10]], [100, 50000, [1, 1]]]) {
  test(`no-cash checkout settles its voucher boundary without QR evidence (${percent}%, ${quantities.length} shops, ${amount})`, async () => {
    const s = checkoutFixture({ percent, amount }); const { call, path } = await makeCart(s, quantities);
    const quote = (await call('GET', `${path}/quote`)).body.quote;
    assert.equal(quote.downpaymentMinor, 0);
    const placed = await call('POST', `${path}/checkout`, {});
    const orders = s.orders.filter(o => o.id !== 'order');
    assert.equal(placed.status, 201); assert.equal(s.vouchers[0].status, 'used');
    assert.equal(s.voucherRedemptions.length, 1);
    for (const o of orders) {
      assert.equal(o.payments.initial.method, 'gridgo_voucher'); assert.equal(o.payments.initial.status, 'confirmed');
      assert.equal(o.payments.initial.reference, null); assert.equal(o.payments.initial.proofFileId, null);
      assert.equal(o.payments.initial.confirmationSource, 'gridgo_voucher');
      assert.equal(o.state, 'needs_qa'); assert.equal(o.fileCheck.status, 'pending');
      assert.ok(collectedSupplierPrincipalMinor(o) > 0);
    }
    if (quantities.length === 2) assert.equal(placed.body.basket.payment.method, 'gridgo_voucher');
    assert.equal(s.notifications.some(n => n.type === 'ops_payment_submitted' && orders.some(o => o.id === n.orderId)), false);
  });
}
const refundCall = (s, user, path, body, key = id('key'), at = AT) => routeRefunds({ store: s, user: s.users.find(u => u.id === user), req: { method: 'POST', headers: { 'idempotency-key': key } },
  url: new URL(path, 'http://test'), readBody: async () => body, now: () => at, id, audit });
for (const clientCaused of [true, false]) test(`zero-cash cancellation records ${clientCaused ? 'forfeiture' : 'restoration'} without refund evidence`, async () => {
  const s = checkoutFixture(); const { call, path } = await makeCart(s);
  const placed = await call('POST', `${path}/checkout`, {}), orderId = placed.body.order.id;
  const opened = await refundCall(s, 'client', `/orders/${orderId}/refund-requests`, { kind: 'cancellation', reason: 'Shop cannot fulfil' });
  const request = opened.body.refund;
  assert.equal(request.noCashSettlementEligible, true);
  const reviewed = await refundCall(s, 'ops', `/refund-requests/${request.id}/review`, { expectedVersion: request.version, reason: 'Reviewed funded order' });
  const body = { expectedVersion: reviewed.body.refund.version, reason: 'Approved cancellation', workStopped: true, clientCaused, shopAgreement: 'No work performed', deliveryEvidence: 'No dispatch',
    shopEntitlementMinor: 0, riderEntitlementMinor: 0, totalMinor: 0 };
  const key = id('settle');
  const settled = await refundCall(s, 'ops', `/refund-requests/${request.id}/settle`, body, key);
  assert.equal(settled.body.refund.status, 'paid'); assert.equal(settled.body.refund.settlement.noCashSettlement, true);
  assert.equal(settled.body.refund.payment, null); assert.equal(s.refundPayments.length, 0); assert.equal(s.refundAttempts.length, 0);
  assert.equal(s.orders.find(o => o.id === orderId).state, 'cancelled');
  assert.equal(s.vouchers[0].status, clientCaused ? 'used' : 'available');
  assert.deepEqual((await refundCall(s, 'ops', `/refund-requests/${request.id}/settle`, body, key)).body, settled.body);
  assert.equal(s.refundSettlements.length, 1);
});
for (const percent of [75, 100]) for (const finalPaid of [false, true]) for (const delta of [-2000, 2000]) {
  test(`funded delivery collection reconciles after ${delta} pin change (${percent}%, final paid=${finalPaid})`, () => {
    const o = fixture().orders[0], total = 21000, part = value => Number(BigInt(value) * BigInt(percent) / 100n);
    Object.assign(o, { deliveryFeeMinor: 10000, totalMinor: total, onlineDueMinor: total, ...deliverySplit(10000, 8500), coversOrderTotal: true });
    const values = [['supplier_principal', 10000], ['service_fee', 1000], ['delivery_pass_through', 10000]];
    o.paymentAllocations = values.flatMap(([component, full]) => [{ component, paymentCode: 'initial', amountMinor: part(full) }, { component, paymentCode: 'final_online', amountMinor: full - part(full) }]).filter(a => a.amountMinor);
    o.payments = { initial: { amountMinor: part(total), status: 'confirmed', method: 'qr_manual' }, final_online: { amountMinor: total - part(total), status: percent === 100 ? 'not_required' : finalPaid ? 'confirmed' : 'not_submitted', method: 'qr_manual' } };
    applyVoucherMoney(o, voucherMoney([o], 6000, { coversOrderTotal: true }).groups[0], { id: 'v', campaignId: 'c' });
    o.deliveryPin = { change: { status: 'applied', feeDifferenceMinor: delta, riderDifferenceMinor: Number(BigInt(delta) * 85n / 100n), platformDifferenceMinor: Number(BigInt(delta) * 15n / 100n),
      payment: delta > 0 ? { amountMinor: delta } : null } };
    const d = moneyReportingForOrder(o).deliverySettlement;
    assert.equal(d.collectedMinor + d.fundedRiderMinor, d.riderCollectedMinor + d.platformCollectedMinor);
    if (percent === 100 || finalPaid) assert.equal(d.riderCollectedMinor, 8500 + (delta > 0 ? 1700 : 0));
  });
}
for (const claimed of [false, true]) test(`deferred invitation matching preserves the first attribution (claimed=${claimed})`, () => {
  const s = fixture(); s.promotionSettings = [{ id: 'launch', version: 1, settings: defaultPromotionSettings() }];
  s.users.push({ id: 'third', name: 'Third', email: 'third@example.invalid', role: 'client' }); s.userRoleMemberships.push({ userId: 'third', role: 'client' });
  const ctx = { id, at: AT }; claimFounding(s, 'client', ctx); claimFounding(s, 'other', ctx);
  inviteFriend(s, 'client', 'future-a@example.invalid', ctx); inviteFriend(s, 'other', 'future-b@example.invalid', ctx);
  s.users.find(u => u.id === 'third').email = 'future-a@example.invalid'; reconcilePromotionInvites(s, ctx);
  if (claimed) claimFriendPass(s, 'third', ctx);
  s.users.find(u => u.id === 'third').email = 'future-b@example.invalid'; reconcilePromotionInvites(s, ctx);
  assert.equal(s.promotionInvites.filter(i => i.clientId === 'third').length, 1);
  assert.equal(s.promotionInvites[1].unmatchedReason, 'account_already_attributed');
  assert.equal(s.promotionInvites[1].clientId, null);
  if (!claimed) { assert.equal(myPromotions(s, 'third', AT).friendPass.offer.id, s.promotionInvites[0].id); claimFriendPass(s, 'third', ctx); }
  assert.equal(s.vouchers.filter(v => v.clientId === 'third').length, 1);
});

test('Founding enabled remains the master switch for Friend Pass offers, invites and claims', () => {
  const s=fixture();s.promotionSettings=[{id:'launch',version:1,settings:defaultPromotionSettings()}];
  const ctx={id,at:AT};claimFounding(s,'client',ctx);inviteFriend(s,'client','other@example.invalid',ctx);
  s.promotionSettings[0].settings.founding.enabled=false;
  assert.equal(myPromotions(s,'other',AT).friendPass.offer,null);
  assert.equal(myPromotions(s,'client',AT).friendPass.canInvite,false);
  assert.throws(()=>claimFriendPass(s,'other',ctx),{code:'promotion_disabled'});
  assert.throws(()=>inviteFriend(s,'client','new@example.invalid',ctx),{code:'promotion_disabled'});
});

test('funded pin collection uses the snapshotted adjustment rounding exactly once', () => {
  const o=fixture().orders[0];Object.assign(o,{deliveryFeeMinor:8900,totalMinor:19900,onlineDueMinor:19900,...deliverySplit(8900,8001)});
  o.paymentAllocations.find(a=>a.component==='delivery_pass_through').amountMinor=8900;o.payments.initial.amountMinor=19900;
  applyVoucherMoney(o,voucherMoney([o],6000,{coversOrderTotal:true}).groups[0],{id:'v',campaignId:'c'});
  o.deliveryPin={change:{status:'applied',feeDifferenceMinor:6000,riderDifferenceMinor:4800,platformDifferenceMinor:1200,payment:{amountMinor:6000}}};
  const d=moneyReportingForOrder(o).deliverySettlement;
  assert.equal(d.riderCollectedMinor,11921);assert.equal(d.platformCollectedMinor,1200);
  assert.equal(d.collectedMinor+d.fundedRiderMinor,d.riderCollectedMinor+d.platformCollectedMinor);
});
