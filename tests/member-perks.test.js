import test from 'node:test';
import assert from 'node:assert/strict';
import { AT, checkoutFixture, makeCart } from './helpers/promotion-checkout.mjs';
import { addPartner, addMember, setPerk } from './fixtures/organization-members.js';
import { id } from './fixtures/reschedule.js';
import { schoolYear, selectMemberPerk, reconcileMemberPerks, restoreMemberPerkForRefund, usablePerk, perkSpentMinor } from '../src/member-perks.js';
import { voucherMoney } from '../src/voucher-money.js';
import { publicOrderFor, calculateOrderMoney, createPaymentSchedule } from '../src/operational-model.js';
import { cashAmounts } from '../src/cash-policy.js';
import { clientInvoice } from '../src/invoice-projection.js';
import { acknowledgementSnapshot } from '../src/acknowledgement-receipts.js';
import { calculateRefundSettlement } from '../src/refund-policy.js';
import { sumMinor } from '../src/refund-policy.js';

const pay = { payment: { method: 'qr_manual', reference: 'MEMBER', proofFileId: 'receipt' } };
function setup({ perk = {}, voucher = false, quantity = 5 } = {}) {
  const store = checkoutFixture();
  if (!voucher) { store.vouchers = []; }
  addPartner(store, { at: AT, perk });
  addMember(store, 'client', { at: AT });
  return { store, quantity };
}
const basePrice = async (quantities, change = () => {}) => {
  const store = checkoutFixture(); store.vouchers = []; change(store);
  const { call, path } = await makeCart(store, quantities);
  return (await call('GET', path)).body.cart.clientQuote;
};
const lastOrders = (store, count = 1) => store.orders.slice(-count);

test('a term is one Manila school year ending 31 May', () => {
  assert.deepEqual([schoolYear('2026-11-25T00:00:00Z').code, schoolYear('2026-11-25T00:00:00Z').label], ['2026-27', 'SY 2026-27']);
  assert.equal(schoolYear('2027-05-31T15:59:59Z').code, '2026-27');
  assert.equal(schoolYear('2027-05-31T16:00:00Z').code, '2027-28');
  assert.equal(schoolYear('2026-11-25T00:00:00Z').endsAt, '2027-05-31T16:00:00.000Z');
  assert.equal(schoolYear('2099-07-01T00:00:00Z').code, '2099-00');
});

test('nothing changes until a Super Admin sets the perk, and only a live membership earns it', async () => {
  const plain = await basePrice([5]);
  for (const change of [s => { s.memberPerkSettings = []; }, s => { s.memberPerkSettings[0].enabled = false; }, s => { s.memberPerkSettings[0].endsAt = AT; },
    s => { s.organizationMemberships[0].status = 'pending'; }, s => { s.organizationMemberships[0].status = 'expired'; }, s => { s.organizationMemberships[0].status = 'removed'; },
    s => { s.organizationMemberships[0].termEndsAt = AT; }, s => { s.organizationPartners[0].status = 'ended'; },
    s => { s.approvalCases.find(c => c.userId === 'org').status = 'suspended'; }, s => { s.organizationAccounts[0].currentOfficer = null; },
    s => { s.users.find(u => u.id === 'org').accountStatus = 'suspended'; }, s => { s.users.find(u => u.id === 'org').reviewData = true; }]) {
    const { store } = setup(); change(store);
    const { call, path } = await makeCart(store, [5]);
    const quote = (await call('GET', path)).body.cart.clientQuote;
    assert.equal(quote.totalMinor, plain.totalMinor); assert.equal(quote.memberPerk, null); assert.equal(quote.memberPerkMinor, 0);
    await call('POST', `${path}/checkout`, pay);
    assert.equal(lastOrders(store)[0].memberPerkMinor, undefined); assert.equal(store.memberPerkUses.length, 0);
  }
});

test('the perk lowers only the GRIDGO fee: cart, quote, order, invoice and receipt agree and the shop and rider are paid the same', async () => {
  const plainStore = checkoutFixture(); plainStore.vouchers = [];
  const plainCart = await makeCart(plainStore, [5]);
  await plainCart.call('POST', `${plainCart.path}/checkout`, pay);
  const plain = lastOrders(plainStore)[0];
  const { store } = setup();
  const { call, path } = await makeCart(store, [5]);
  const { clientQuote: quote, groups } = (await call('GET', path)).body.cart;
  assert.deepEqual([quote.memberPerkMinor, quote.discountKind, quote.totalMinor], [1000, 'member_perk', plain.totalMinor - 1000]);
  assert.deepEqual(quote.memberPerk, { membershipId: 'mem_org_client', label: 'Sample Guild member', amountMinor: 1000, useNumber: 1, maxOrdersPerTerm: 5, fundedBy: 'GRIDGO' });
  assert.equal(groups[0].memberPerkMinor, 1000); assert.equal(groups[0].totalMinor, quote.totalMinor);
  const result = await call('POST', `${path}/checkout`, pay);
  const order = lastOrders(store)[0];
  assert.equal(order.totalMinor, quote.totalMinor); assert.equal(order.memberPerkMinor, 1000);
  assert.equal(order.serviceFeeMinor, plain.serviceFeeMinor - 1000); assert.equal(order.grossServiceFeeMinor, plain.grossServiceFeeMinor);
  for (const key of ['supplierSubtotalMinor', 'supplierPlatformPayoutMinor', 'deliveryFeeMinor', 'riderPayoutMinor', 'platformDeliveryShareMinor', 'payoutPlanVersion']) assert.equal(order[key], plain[key], key);
  assert.deepEqual(order.payoutMilestones.map(row => row.amountMinor), plain.payoutMilestones.map(row => row.amountMinor));
  assert.equal(sumMinor(order.paymentAllocations.map(row => row.amountMinor)), order.totalMinor);
  assert.equal(order.payments.initial.amountMinor, order.totalMinor);
  assert.equal(result.body.invoice.memberPerkMinor, 1000); assert.equal(result.body.invoice.memberPerk.organizationUserId, undefined); assert.equal(result.body.invoice.memberPerk.label, 'Sample Guild member');
  assert.equal(result.body.order.memberPerkMinor, 1000);
  assert.equal(store.memberPerkUses.length, 1);
  assert.deepEqual([store.memberPerkUses[0].status, store.memberPerkUses[0].amountMinor, store.memberPerkUses[0].data.orderIds], ['reserved', 1000, [order.id]]);
  // Role-scoped: the client and staff see the line, a shop or rider never learns of the membership.
  assert.equal(publicOrderFor(order, { id: 'client', role: 'client' }, store).memberPerk.useNumber, 1);
  assert.equal(publicOrderFor(order, { id: 'ops', role: 'ops_admin' }, store).memberPerk.organizationUserId, 'org');
  for (const actor of [{ id: 'supplier', role: 'supplier' }, { id: 'rider', role: 'rider' }]) assert.doesNotMatch(JSON.stringify(publicOrderFor(order, actor, store)), /memberPerk|Sample Guild/);
  order.payments.initial.status = 'confirmed';
  const receipt = acknowledgementSnapshot(store, order, AT);
  assert.deepEqual([receipt.memberPerkMinor, receipt.roundingAdjustmentMinor, receipt.grandTotalMinor], [1000, 0, order.totalMinor]);
  // Refunds return client cash only; the perk is never paid out.
  assert.equal(calculateRefundSettlement(order, { store, beforeProduction: true, shopEntitlementMinor: 0, riderEntitlementMinor: 0 }).totalMinor, order.totalMinor);
});

test('the perk never exceeds the service fee and a total never goes below zero', async () => {
  const plain = await basePrice([1]);
  const { store } = setup({ perk: { amountMinor: 10_000_000, budgetCapMinor: 100_000_000 } });
  const { call, path } = await makeCart(store, [1]);
  await call('POST', `${path}/checkout`, pay);
  const order = lastOrders(store)[0];
  assert.equal(order.serviceFeeMinor, 0); assert.equal(order.memberPerkMinor, order.grossServiceFeeMinor);
  assert.equal(order.totalMinor, order.supplierSubtotalMinor + order.deliveryFeeMinor);
  assert.equal(order.totalMinor, plain.totalMinor - order.grossServiceFeeMinor);
  assert.equal(store.memberPerkUses[0].amountMinor, order.grossServiceFeeMinor);
});

test('75 percent checkout rounds once: both payments and every allocation add up', async () => {
  const store = checkoutFixture({ percent: 75 }); store.vouchers = [];
  addPartner(store, { at: AT, perk: { amountMinor: 333 } }); addMember(store, 'client', { at: AT });
  const { call, path } = await makeCart(store, [5]);
  const quote = (await call('GET', path)).body.cart.clientQuote;
  await call('POST', `${path}/checkout`, pay);
  const order = lastOrders(store)[0];
  assert.equal(order.payments.initial.amountMinor, quote.downpaymentMinor);
  assert.equal(order.payments.initial.amountMinor + order.payments.final_online.amountMinor, order.totalMinor);
  for (const component of ['supplier_principal', 'service_fee', 'delivery_pass_through']) assert.equal(sumMinor(order.paymentAllocations.filter(r => r.component === component).map(r => r.amountMinor)),
    { supplier_principal: order.supplierSubtotalMinor, service_fee: order.serviceFeeMinor, delivery_pass_through: order.deliveryFeeMinor }[component]);
});

test('one use covers a whole basket and is split across its groups by their fees without losing a centavo', async () => {
  const { store } = setup({ perk: { amountMinor: 1001 } });
  const { call, path } = await makeCart(store, [5, 4]);
  const quote = (await call('GET', path)).body.cart.clientQuote;
  const result = await call('POST', `${path}/checkout`, pay);
  const orders = lastOrders(store, 2);
  assert.equal(orders.reduce((sum, order) => sum + order.memberPerkMinor, 0), 1001);
  assert.equal(result.body.basket.totalMinor, quote.totalMinor);
  assert.equal(result.body.invoice.memberPerkMinor, 1001);
  assert.equal(result.body.basket.groups.reduce((sum, group) => sum + group.memberPerkMinor, 0), 1001);
  assert.equal(store.memberPerkUses.length, 1);
  assert.deepEqual([...store.memberPerkUses[0].data.orderIds].sort(), orders.map(order => order.id).sort());
  // One group cancelled unpaid keeps the use; the last one returns it.
  orders[0].state = 'cancelled'; reconcileMemberPerks(store, { id, at: AT }); assert.equal(store.memberPerkUses[0].status, 'reserved');
  orders[1].state = 'cancelled'; reconcileMemberPerks(store, { id, at: AT }); assert.equal(store.memberPerkUses[0].status, 'returned');
});

test('cash carries the same lower fee: the client pays less and the shop and rider shares are untouched', async () => {
  const run = async perk => {
    const store = checkoutFixture(); store.vouchers = []; store.settings.cash.enabled = true;
    if (perk) { addPartner(store, { at: AT, perk: {} }); addMember(store, 'client', { at: AT }); }
    const { call, path } = await makeCart(store, [5]);
    await call('POST', `${path}/checkout`, { payment: { method: 'cash' } });
    return { store, order: lastOrders(store)[0] };
  };
  const plain = await run(false), { store, order } = await run(true);
  const a = cashAmounts(plain.order), b = cashAmounts(order);
  assert.equal(b.shopMinor, a.shopMinor); assert.equal(order.riderPayoutMinor, plain.order.riderPayoutMinor);
  assert.equal(order.totalMinor, plain.order.totalMinor - 1000);
  assert.equal(order.payments.initial.amountMinor, order.totalMinor);
  assert.equal(order.payoutMilestones[0].amountMinor, plain.order.payoutMilestones[0].amountMinor);
  order.payments.initial.status = 'confirmed'; reconcileMemberPerks(store, { id, at: AT });
  assert.equal(store.memberPerkUses[0].status, 'confirmed');
});

test('a voucher stacks on the perk but only on what is left of the fee', async () => {
  const { store } = setup({ voucher: true, perk: { amountMinor: 500 } });
  for (const voucher of store.vouchers) Object.assign(voucher, { valueMinor: 300, data: {}, promotionKind: null });
  for (const campaign of store.voucherCampaigns) campaign.coversOrderTotal = false;
  const plain = await basePrice([5]);
  const { call, path } = await makeCart(store, [5]);
  const quote = (await call('GET', path)).body.cart.clientQuote;
  assert.deepEqual([quote.memberPerkMinor, quote.voucherDiscountMinor, quote.totalMinor], [500, 300, plain.totalMinor - 800]);
  await call('POST', `${path}/checkout`, pay);
  const order = lastOrders(store)[0];
  assert.equal(order.totalMinor, plain.totalMinor - 800); assert.equal(order.memberPerkMinor, 500); assert.equal(order.voucherDiscountMinor, 300);
  assert.equal(order.serviceFeeMinor, order.grossServiceFeeMinor - 500); assert.equal(order.clientServiceFeeMinor, order.grossServiceFeeMinor - 800);
  assert.equal(sumMinor(order.paymentAllocations.map(row => row.amountMinor)), order.totalMinor);
});

test('a voucher that already covers the whole order does not burn a perk use', async () => {
  const { store } = setup({ voucher: true });
  store.vouchers[0].valueMinor = 1_000_000;
  const { call, path } = await makeCart(store, [1]);
  const quote = (await call('GET', path)).body.cart.clientQuote;
  assert.deepEqual([quote.totalMinor, quote.memberPerk], [0, null]);
});

test('only the larger of the organization discount and one member perk applies', async () => {
  const asOrganization = store => {
    Object.assign(store.users.find(u => u.id === 'client'), { accountType: 'organization' });
    store.approvalCases.push({ id: 'case_client', userId: 'client', kind: 'business_client', status: 'approved', version: 1 });
    store.settings.organizationDiscountRateBps = 1000;
  };
  const discounted = await basePrice([5], asOrganization);
  assert.equal(discounted.organizationDiscountMinor, 500);
  for (const [amountMinor, expected] of [[499, [500, 0]], [500, [500, 0]], [501, [0, 501]]]) {
    const { store } = setup({ perk: { amountMinor } }); asOrganization(store);
    const { call, path } = await makeCart(store, [5]);
    const quote = (await call('GET', path)).body.cart.clientQuote;
    assert.deepEqual([quote.organizationDiscountMinor, quote.memberPerkMinor], expected);
    await call('POST', `${path}/checkout`, pay);
    const order = lastOrders(store)[0];
    assert.deepEqual([order.organizationDiscountMinor, order.memberPerkMinor ?? 0], expected);
    assert.equal(order.totalMinor, quote.totalMinor); assert.equal(store.memberPerkUses.length, expected[1] ? 1 : 0);
  }
});

test('two organizations never add up: the larger usable perk applies, then the other when its uses run out', () => {
  const store = checkoutFixture();
  addPartner(store, { at: AT, orgId: 'org', perk: { amountMinor: 1000 } });
  addPartner(store, { at: AT, orgId: 'club', label: 'Second Club', override: { amountMinor: 1500, maxOrdersPerTerm: 1 } });
  addMember(store, 'client', { at: AT }); const club = addMember(store, 'client', { at: AT, orgId: 'club' });
  const money = [{ grossServiceFeeMinor: 5000 }];
  assert.deepEqual([selectMemberPerk(store, 'client', money, AT).amountMinor, selectMemberPerk(store, 'client', money, AT).membership.id], [1500, club.id]);
  store.memberPerkUses.push({ id: 'use', membershipId: club.id, organizationUserId: 'club', clientId: 'client', term: club.term, amountMinor: 1500, status: 'reserved', createdAt: AT, data: { orderIds: [] } });
  assert.equal(selectMemberPerk(store, 'client', money, AT).amountMinor, 1000);
  store.memberPerkUses[0].status = 'returned';
  assert.equal(selectMemberPerk(store, 'client', money, AT).amountMinor, 1500);
  // An override that is switched off does not fall back to the standard perk.
  setPerk(store, 'club', { enabled: false }, AT);
  assert.equal(usablePerk(store, club, AT), null);
});

test('the member cap and the organization budget stop new orders; a perk that does not fit the budget is not cut down', async () => {
  const { store } = setup({ perk: { maxOrdersPerTerm: 2, budgetCapMinor: 2500 } });
  for (const expected of [1, 2, null]) {
    const { call, path } = await makeCart(store, [5]);
    const quote = (await call('GET', path)).body.cart.clientQuote;
    assert.equal(quote.memberPerk?.useNumber ?? null, expected);
    await call('POST', `${path}/checkout`, pay);
  }
  setPerk(store, null, { maxOrdersPerTerm: 5, budgetCapMinor: 2500 }, AT);
  assert.equal(perkSpentMinor(store, 'org'), 2000);
  const { call, path } = await makeCart(store, [5]);
  assert.equal((await call('GET', path)).body.cart.clientQuote.memberPerk, null);
  // Returning one use frees both the member's count and the budget.
  store.orders.find(order => order.id === store.memberPerkUses[0].data.orderIds[0]).state = 'cancelled';
  assert.equal(reconcileMemberPerks(store, { id, at: AT }), true);
  assert.equal((await call('GET', path)).body.cart.clientQuote.memberPerkMinor, 1000);
  assert.ok(store.notifications.some(row => row.userId === 'client' && row.type === 'member_perk.returned'));
});

test('a changed perk reprices drafts only; a placed order keeps its snapshot after removal', async () => {
  const { store } = setup();
  const first = await makeCart(store, [5]); await first.call('POST', `${first.path}/checkout`, pay);
  const placed = structuredClone(lastOrders(store)[0]);
  setPerk(store, null, { amountMinor: 250 }, AT);
  const second = await makeCart(store, [5]);
  assert.equal((await second.call('GET', second.path)).body.cart.clientQuote.memberPerkMinor, 250);
  store.organizationMemberships[0].status = 'removed';
  assert.equal((await second.call('GET', second.path)).body.cart.clientQuote.memberPerk, null);
  assert.deepEqual(store.orders.find(order => order.id === placed.id), placed);
});

test('after payment a use returns only when every order was cancelled without client fault', async () => {
  for (const [clientCaused, cancelled, expected] of [[false, true, 'returned'], [true, true, 'confirmed'], [undefined, true, 'confirmed'], [false, false, 'confirmed']]) {
    const { store } = setup();
    const { call, path } = await makeCart(store, [5]); await call('POST', `${path}/checkout`, pay);
    const order = lastOrders(store)[0];
    order.payments.initial.status = 'confirmed'; reconcileMemberPerks(store, { id, at: AT });
    if (cancelled) order.state = 'cancelled';
    reconcileMemberPerks(store, { id, at: AT });
    assert.equal(store.memberPerkUses[0].status, 'confirmed', 'paid cancellation alone never returns the use');
    restoreMemberPerkForRefund(store, order, { id, at: AT, actorId: 'ops', clientCaused, reason: 'Recorded' });
    assert.equal(store.memberPerkUses[0].status, expected);
    reconcileMemberPerks(store, { id, at: AT }); assert.equal(store.memberPerkUses[0].status, expected);
  }
});

test('a partial save that cannot see every order of a use leaves the use alone', () => {
  const store = { memberPerkUses: [{ id: 'use', status: 'reserved', data: { orderIds: ['a', 'b'] } }], orders: [{ id: 'a', state: 'cancelled', payments: {} }] };
  assert.equal(reconcileMemberPerks(store, { id, at: AT }), false); assert.equal(store.memberPerkUses[0].status, 'reserved');
});

test('legacy quote money takes the perk from the fee only and voucher money keeps the share', () => {
  const settings = checkoutFixture().settings;
  const args = { supplierSubtotalMinor: 10000, fulfillmentMode: 'delivery', paymentPlan: 'delivery_online', supplierDownpaymentRateBps: 5000, distanceMeters: 1000, settings };
  const plain = calculateOrderMoney(args), perk = calculateOrderMoney({ ...args, memberPerkMinor: 700 });
  assert.equal(perk.totalMinor, plain.totalMinor - 700); assert.equal(perk.serviceFeeMinor, plain.serviceFeeMinor - 700); assert.equal(perk.supplierPlatformPayoutMinor, plain.supplierPlatformPayoutMinor);
  assert.equal(perk.riderPayoutMinor, plain.riderPayoutMinor);
  assert.equal(sumMinor(Object.values(createPaymentSchedule(perk).payments).map(row => row.amountMinor)), perk.totalMinor);
  assert.throws(() => calculateOrderMoney({ ...args, memberPerkMinor: plain.serviceFeeMinor + 1 }), { code: 'invalid_money' });
  const [group] = voucherMoney([{ supplierSubtotalMinor: 1000, grossServiceFeeMinor: 450, deliveryFeeMinor: 0, memberPerkMinor: 400, organizationDiscountMinor: 0 }], 100).groups;
  assert.deepEqual([group.voucherServiceFeeMinor, group.clientServiceFeeMinor, group.memberPerkMinor, group.totalMinor], [50, 0, 400, 1000]);
  assert.equal(clientInvoice({ itemSubtotalMinor: 1000, serviceFeeMinor: 50, grossServiceFeeMinor: 450, serviceFeeRateBps: 4500, lines: [], memberPerk: { useId: 'x', organizationUserId: 'org', label: 'L', amountMinor: 400 } }).memberPerk.useId, undefined);
});
