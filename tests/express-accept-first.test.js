import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, addShop, caller } from './fixtures/scheduling.js';
import { routeExpressOrders } from '../src/express-routes.js';
import { sweepAcceptFirst } from '../src/express-accept-first.js';
import { publicExpress } from '../src/express-orders.js';
import { serviceFeeMoney, expressFeeSchedule } from '../src/service-fee.js';
import { expressPaymentOptions, nextExpressCheckoutSettings, expressCheckoutSettings, manualReviewOpen, expressAcceptRate } from '../src/express-checkout-rules.js';
import { supplierArtworkReleased } from '../src/artwork-gates.js';

// Wednesday 09:00, Asia/Manila.
const AT = '2026-09-23T01:00:00.000Z';
const later = (seconds, from = AT) => new Date(Date.parse(from) + seconds * 1000).toISOString();
const location = { lat: 7.064, lng: 125.6085 };
const files = [{ fileId: 'file_art', copies: 1, colour: 'bw', paper: 'a4', sides: 'one', layout: 'fit_to_paper', acceptedWarnings: [] }];

function setup({ prices = {}, pages = 12 } = {}) {
  const { store, client } = fixture({ express: true });
  addShop(store, 'shop_c', { lat: 7.07, lng: 125.61 });
  addShop(store, 'shop_d', { lat: 7.075, lng: 125.612 });
  for (const item of store.catalogItems) Object.assign(item, { express: true, pricingUnit: 'per_page', subcategoryCode: 'document_printing',
    printLayouts: ['fit_to_paper'], basePriceMinor: prices[item.supplierId] ?? 300 });
  for (const service of store.supplierServices) Object.assign(service, { categoryCode: 'document_publication', turnaroundHours: 1, standardTurnaroundHours: 1 });
  store.files.find(f => f.fileId === 'file_art').detected = { pageCount: pages };
  store.users.find(u => u.id === client.id).accountType = 'individual';
  let n = 0;
  const id = prefix => `${prefix}_t${++n}`;
  const shop = supplierId => ({ id: supplierId, role: 'supplier' });
  const express = (action, user, orderId, body = {}, at = AT) => routeExpressOrders({ req: { method: 'POST' },
    url: new URL(`http://test/orders/${orderId}/express/${action}`), store, user, readBody: async () => body, id, now: () => at,
    audit: (s, event) => (s.auditLog ||= []).push({ id: id('aud'), at, ...event }) });
  return { store, client, call: caller(store, client, AT), express, shop, id };
}
async function send(ctx, body = {}) {
  const draft = await ctx.call('POST', '/express/drafts', { acceptFirst: true, location, fulfillmentMode: 'pickup', files, supplierId: 'shop_a', ...body });
  assert.equal(draft.status, 201);
  const placed = await ctx.call('POST', `/me/carts/${draft.body.cartId}/checkout`, { looksRight: true, expressConfirmation: draft.body.confirmation });
  return { draft, order: ctx.store.orders.find(o => o.id === placed.body.order.id) };
}
const current = (store, order) => {
  let row = order;
  while (row.expressOrder.reroute?.nextOrderId) row = store.orders.find(o => o.id === row.expressOrder.reroute.nextOrderId);
  return row;
};

test('GRIDGO Express fee: the higher of the minimum and the rate, total rounded up to the next fifty centavos', () => {
  const schedule = expressFeeSchedule({ minimumMinor: 500, rateBps: 2000 });
  // Report examples: 12 x 3 = 36 -> 43.50; 1 x 1 = 1 -> 6; plus the screen totals 58, 72 and 29.
  for (const [printing, total, applied] of [[3600, 4350, 'rate'], [100, 600, 'minimum'], [4800, 5800, 'rate'], [6000, 7200, 'rate'],
    [2400, 2900, 'minimum'], [2500, 3000, 'rate'], [2501, 3050, 'rate'], [1, 550, 'minimum'], [0, 500, 'minimum'], [30000, 36000, 'rate']]) {
    const money = serviceFeeMoney(printing, schedule);
    assert.equal(printing + money.grossServiceFeeMinor, total, `printing ${printing}`);
    assert.equal(money.serviceFeeWorking[0].applied, applied);
    assert.equal((printing + money.grossServiceFeeMinor) % 50, 0);
  }
  // Exact arithmetic near the safe-integer limit never drifts.
  const big = 7_000_000_000_000;
  assert.equal((big + serviceFeeMoney(big, schedule).grossServiceFeeMinor) % 50, 0);
  assert.throws(() => expressFeeSchedule({ minimumMinor: -1, rateBps: 2000 }));
  assert.throws(() => expressFeeSchedule({ minimumMinor: 500, rateBps: 10001 }));
  assert.throws(() => serviceFeeMoney(100, { version: 3, rule: 'express_minimum_or_rate', minimumMinor: 500, rateBps: 2000, roundTotalUpToMinor: 100 }));
});

test('Super Admin settings: defaults, partial patches, validation, the gateway switch and staff-only reads', () => {
  assert.deepEqual(expressCheckoutSettings({}), { feeMinimumMinor: 500, feeRateBps: 2000, paymentConfirmation: 'manual',
    manualQrInstantMaxMinor: 30000, manualQrReviewMinutes: 3, manualQrReviewOpens: '08:00', manualQrReviewCloses: '17:00' });
  const next = nextExpressCheckoutSettings({}, { feeMinimumMinor: 700 });
  assert.equal(next.feeMinimumMinor, 700); assert.equal(next.feeRateBps, 2000);
  for (const patch of [{ feeRateBps: 10001 }, { feeMinimumMinor: 1.5 }, { manualQrReviewMinutes: 0 }, { manualQrReviewOpens: '18:00' },
    { manualQrReviewCloses: '25:00' }, { paymentConfirmation: 'auto' }, { unknown: true }]) {
    assert.throws(() => nextExpressCheckoutSettings({}, patch), e => e.code === 'invalid_express_checkout_settings', JSON.stringify(patch));
  }
  // No payment gateway is connected yet, so the switch cannot leave manual.
  assert.throws(() => nextExpressCheckoutSettings({}, { paymentConfirmation: 'gateway' }), e => e.code === 'payment_gateway_not_configured');
  assert.equal(nextExpressCheckoutSettings({}, { paymentConfirmation: 'gateway' }, { gatewayConnected: true }).paymentConfirmation, 'gateway');
  // Manila review hours: 08:00 opens, 17:00 closes.
  assert.equal(manualReviewOpen({}, '2026-09-23T00:00:00.000Z'), true);
  assert.equal(manualReviewOpen({}, '2026-09-22T23:59:59.000Z'), false);
  assert.equal(manualReviewOpen({}, '2026-09-23T08:59:00.000Z'), true);
  assert.equal(manualReviewOpen({}, '2026-09-23T09:00:00.000Z'), false);
});

test('send: the shop has sixty seconds, no manual file check, nothing to pay, and a clear price breakdown', async () => {
  const ctx = setup();
  const { draft, order } = await send(ctx);
  assert.equal(draft.body.paymentTiming, 'after_acceptance');
  assert.equal(draft.body.quote.printingMinor, 3600);
  assert.equal(draft.body.quote.gridgoFeeMinor, 750);
  assert.equal(draft.body.quote.totalMinor, 4350);
  assert.deepEqual(draft.body.quote.gridgoFeeRule, { minimumMinor: 500, rateBasisPoints: 2000, applied: 'rate', roundTotalUpToMinor: 50 });
  assert.equal(JSON.stringify(draft.body).includes('serviceFeeSchedule'), false);
  assert.equal(order.state, 'supplier_assigned');
  assert.equal(order.expressOrder.acceptFlow, 2);
  assert.equal(order.shopAcceptance.deadlineAt, later(60));
  assert.equal(order.fileCheck.status, 'passed'); assert.equal(order.fileCheck.automatic, true);
  assert.equal(order.supplierSubtotalMinor, 3600); assert.equal(order.totalMinor, 4350);
  assert.equal(order.supplierPlatformPayoutMinor, 3600, 'the shop keeps its full price');
  assert.equal(order.payments.initial.status, 'not_submitted');
  assert.equal(order.payments.final_online.status, 'not_required');
  assert.equal(supplierArtworkReleased(order), true);
  assert.ok(ctx.store.notifications.some(n => n.userId === 'shop_a' && n.orderId === order.id && n.type === 'shop_express_offer'));
  assert.equal(ctx.store.notifications.some(n => n.orderId === order.id && /qa|file check/i.test(n.type)), false);
  const view = publicExpress(order, { id: order.clientId, role: 'client' });
  assert.deepEqual([view.money.printingMinor, view.money.gridgoFeeMinor, view.money.totalMinor], [3600, 750, 4350]);
  assert.equal(view.acceptWindowSeconds, 60);
  // Paying before the shop accepts is refused on every route.
  await assert.rejects(ctx.express('pay', ctx.client, order.id, { method: 'qr_ph', reference: 'R1', proofFileId: 'file_qr' }), e => e.code === 'express_payment_not_due');
  const { assertExpressPaymentSubmission } = await import('../src/express-orders.js');
  assert.throws(() => assertExpressPaymentSubmission(order, AT), e => e.code === 'express_pay_route_required');
  // Released apps that do not opt in keep paying at checkout.
  const legacy = await ctx.call('POST', '/express/drafts', { location, fulfillmentMode: 'pickup', files, supplierId: 'shop_a' });
  assert.equal(legacy.body.paymentTiming, 'checkout');
  assert.equal(legacy.body.quote.gridgoFeeMinor, undefined);
});

test('a decline moves the request automatically to the next shop at the same or a lower price, with no warning', async () => {
  const ctx = setup({ prices: { shop_c: 250 } });
  const { order } = await send(ctx);
  const result = await ctx.express('decline', ctx.shop('shop_a'), order.id, { reason: 'Printer jammed' });
  assert.equal(result.status, 200);
  assert.equal(order.state, 'cancelled');
  assert.equal(order.expressOrder.reroute.status, 'moved');
  assert.equal(order.expressOrder.reroute.consent, 'automatic');
  const next = current(ctx.store, order);
  assert.notEqual(next.id, order.id);
  assert.equal(next.supplierId, 'shop_c');
  assert.equal(next.state, 'supplier_assigned');
  assert.equal(next.totalMinor, 3600, '12 x 2.50 = 30 + 6 fee = 36');
  assert.equal(next.expressOrder.requestId, order.id);
  assert.equal(next.expressOrder.attempt, 2);
  assert.equal(next.expressOrder.routing.roundAsked, 2);
  assert.equal(publicExpress(next, ctx.client).request.shopInRound, 2);
  assert.equal(supplierArtworkReleased(order), false, 'the refusing shop loses the job and its files');
  assert.equal((ctx.store.supplierPerformanceEvents || []).some(e => e.orderId === order.id), false, 'no warning');
  assert.equal(ctx.store.notifications.some(n => n.userId === 'shop_a' && /warning/i.test(`${n.type} ${n.title}`)), false);
});

test('a missed sixty-second window counts as a refusal and moves on; a pricier shop waits for the client', async () => {
  const ctx = setup({ prices: { shop_c: 400, shop_d: 400, shop_b: 400 } });
  const { order } = await send(ctx);
  assert.equal(sweepAcceptFirst(ctx.store, { at: later(59), id: ctx.id }), false);
  assert.equal(sweepAcceptFirst(ctx.store, { at: later(60), id: ctx.id }), true);
  assert.equal(order.shopAcceptance.status, 'timed_out');
  assert.equal(order.state, 'supplier_assigned');
  assert.equal(order.expressOrder.reroute.status, 'price_check');
  const candidate = order.expressOrder.reroute.candidate;
  assert.equal(candidate.supplierId, 'shop_c');
  assert.equal(candidate.totalMinor, 5800, '12 x 4 = 48 + 10 fee');
  assert.equal(candidate.previousTotalMinor, 4350);
  assert.deepEqual(publicExpress(order, ctx.client).reroute.options, ['accept', 'pick', 'cancel']);
  await assert.rejects(ctx.express('reroute', ctx.client, order.id, { action: 'accept', expectedTotalMinor: 4350 }), e => e.code === 'express_price_changed');
  assert.equal(order.state, 'supplier_assigned', 'a refused answer changes nothing');
  await ctx.express('reroute', ctx.client, order.id, { action: 'accept', expectedTotalMinor: 5800 }, later(70));
  const next = current(ctx.store, order);
  assert.equal(next.supplierId, 'shop_c'); assert.equal(next.totalMinor, 5800);
  assert.equal(order.expressOrder.reroute.consent, 'client');
  // An unanswered price question closes after ten minutes with nothing charged.
  const ctx2 = setup({ prices: { shop_c: 400, shop_d: 400, shop_b: 400 } });
  const second = await send(ctx2);
  await ctx2.express('decline', ctx2.shop('shop_a'), second.order.id, { reason: 'Busy' });
  assert.equal(sweepAcceptFirst(ctx2.store, { at: later(600), id: ctx2.id }), true);
  assert.equal(second.order.state, 'cancelled');
  assert.equal(second.order.expressOrder.reroute.status, 'expired');
  assert.equal(second.order.cancelledBy, null);
});

test('after three shops the client chooses: search away, keep trying nearby for five minutes, pick, or cancel', async () => {
  const ctx = setup();
  ctx.store.supplierProfiles.find(p => p.userId === 'shop_b').isClosed = true;
  addShop(ctx.store, 'shop_far', { lat: 7.13, lng: 125.6085 });
  const far = ctx.store.catalogItems.find(i => i.supplierId === 'shop_far');
  Object.assign(far, { express: true, pricingUnit: 'per_page', subcategoryCode: 'document_printing', printLayouts: ['fit_to_paper'], basePriceMinor: 300 });
  Object.assign(ctx.store.supplierServices.find(s => s.supplierId === 'shop_far'), { categoryCode: 'document_publication', turnaroundHours: 1, standardTurnaroundHours: 1 });
  const { order } = await send(ctx);
  let row = order;
  for (const reason of ['one', 'two', 'three']) {
    await ctx.express('decline', ctx.shop(row.supplierId), row.id, { reason });
    row = current(ctx.store, row);
  }
  assert.deepEqual([order.supplierId, ...ctx.store.orders.filter(o => o.expressOrder?.requestId === order.id && o.id !== order.id).map(o => o.supplierId)], ['shop_a', 'shop_c', 'shop_d']);
  assert.equal(row.state, 'supplier_assigned');
  assert.equal(row.expressOrder.reroute.status, 'exhausted');
  assert.deepEqual(publicExpress(row, ctx.client).reroute.options, ['search_away', 'keep_trying', 'pick', 'cancel']);
  assert.equal(row.expressOrder.reroute.searchAway.available, true);
  // Keep trying: nobody new nearby, so after five minutes the client is asked again.
  await ctx.express('reroute', ctx.client, row.id, { action: 'keep_trying' }, later(5));
  assert.equal(row.expressOrder.reroute.status, 'retrying');
  assert.deepEqual(publicExpress(row, ctx.client).reroute.options, ['pick', 'cancel']);
  sweepAcceptFirst(ctx.store, { at: later(40), id: ctx.id });
  assert.equal(row.expressOrder.reroute.status, 'retrying');
  sweepAcceptFirst(ctx.store, { at: later(310), id: ctx.id });
  assert.equal(row.expressOrder.reroute.status, 'exhausted');
  assert.ok(ctx.store.notifications.some(n => n.orderId === row.id && n.type === 'express_reroute_exhausted' && n.userId === ctx.client.id));
  // Search away: the client tapped the button showing the away delivery fee; one shop of a new round.
  row.expressOrder.reroute.searchAway = { available: true, deliveryFeeMinor: 0 };
  await ctx.express('reroute', ctx.client, row.id, { action: 'search_away' }, later(320));
  const away = current(ctx.store, row);
  assert.equal(away.supplierId, 'shop_far');
  assert.equal(away.expressOrder.routing.scope, 'away');
  assert.equal(away.expressOrder.routing.roundAsked, 1);
  // Cancel at any point before paying: nothing charged and no voucher forfeit.
  await ctx.express('cancel', ctx.client, away.id, {}, later(330));
  assert.equal(away.state, 'cancelled'); assert.equal(away.cancelledBy, ctx.client.id);
  assert.equal(away.shopAcceptance.status, 'withdrawn');
  assert.equal(supplierArtworkReleased(away), false);
});

test('a client pick starts a new round at a confirmed price; a shop that already refused cannot be picked', async () => {
  const ctx = setup({ prices: { shop_c: 400, shop_d: 400, shop_b: 350 } });
  const { order } = await send(ctx);
  await ctx.express('decline', ctx.shop('shop_a'), order.id, { reason: 'Out of paper' });
  await assert.rejects(ctx.express('reroute', ctx.client, order.id, { action: 'pick', supplierId: 'shop_a', expectedTotalMinor: 4350 }), e => e.code === 'express_shop_already_asked');
  await ctx.express('reroute', ctx.client, order.id, { action: 'pick', supplierId: 'shop_b', expectedTotalMinor: 5050 });
  const next = current(ctx.store, order);
  assert.equal(next.supplierId, 'shop_b'); assert.equal(next.totalMinor, 5050, '12 x 3.50 = 42 + 8.40 fee, rounded up to 50.50');
  assert.equal(next.expressOrder.routing.roundAsked, 1); assert.equal(next.expressOrder.routing.round, 2);
});

test('accept opens a five-minute window; with cash switched off, QR is the only choice', async () => {
  const ctx = setup();
  const { order } = await send(ctx);
  await ctx.express('accept', ctx.shop('shop_a'), order.id, {}, later(30));
  assert.equal(order.state, 'awaiting_initial_payment');
  assert.equal(order.expressOrder.payBy, later(330));
  const view = publicExpress(order, ctx.client);
  assert.equal(view.payment.options.defaultMethod, 'qr_ph');
  assert.deepEqual(view.payment.options.methods.map(m => [m.method, m.available, m.reason]), [['cash_at_pickup', false, 'cash_disabled'], ['qr_ph', true, null]]);
  await assert.rejects(ctx.express('pay', ctx.client, order.id, { method: 'cash_at_pickup' }, later(40)), e => e.code === 'express_cash_unavailable');
  // A receipt at or under 300 lets the shop print at once; GRIDGO still confirms later.
  await ctx.express('pay', ctx.client, order.id, { method: 'qr_ph', reference: 'REF-1', proofFileId: 'file_qr' }, later(60));
  assert.equal(order.state, 'payment_authorized');
  assert.equal(order.expressOrder.paymentRelease.kind, 'receipt_under_limit');
  assert.equal(order.payments.initial.status, 'pending_confirmation');
  // A receipt proves one payment only.
  const reuse = setup(); const other = await send(reuse);
  reuse.store.files.find(f => f.fileId === 'file_qr').references.push({ type: 'order', id: 'some_other_order', field: 'payment:initial:proof' });
  await reuse.express('accept', reuse.shop('shop_a'), other.order.id, {}, later(10));
  await assert.rejects(reuse.express('pay', reuse.client, other.order.id, { method: 'qr_ph', reference: 'REF-9', proofFileId: 'file_qr' }, later(20)), e => e.code === 'payment_proof_already_used');
  reuse.store.files.push({ fileId: 'file_qr2', ownerId: reuse.client.id, purpose: 'payment_proof', state: 'ready', references: [] });
  reuse.store.orders.push({ id: 'paid_before', payments: { initial: { method: 'qr_manual', reference: 'ref-9' } } });
  await assert.rejects(reuse.express('pay', reuse.client, other.order.id, { method: 'qr_ph', reference: 'REF-9', proofFileId: 'file_qr2' }, later(20)), e => e.code === 'payment_reference_already_used');
  // A rejected receipt keeps handover blocked, even after a replacement, until Operations confirms.
  order.state = 'ready_for_dispatch';
  order.payments.initial.status = 'rejected';
  order.expressOrder.paymentRelease.receiptRejected = { at: later(90), reason: 'Amount does not match' };
  ctx.store.files.push({ fileId: 'file_qr3', ownerId: ctx.client.id, purpose: 'payment_proof', state: 'ready', references: [] });
  await ctx.express('pay', ctx.client, order.id, { method: 'qr_ph', reference: 'REF-1B', proofFileId: 'file_qr3' }, later(100));
  assert.equal(order.payments.initial.status, 'pending_confirmation');
  await assert.rejects(ctx.express('pickup', ctx.shop('shop_a'), order.id, { code: order.expressOrder.pickupCode }, later(120)), e => e.code === 'payment_required');
  order.payments.initial.status = 'confirmed'; delete order.expressOrder.paymentRelease.receiptRejected;
  await ctx.express('pickup', ctx.shop('shop_a'), order.id, { code: order.expressOrder.pickupCode }, later(130));
  assert.ok(order.expressOrder.pickedUpAt);
  // No payment: the window closes and nothing is charged.
  const ctx2 = setup(); const second = await send(ctx2);
  await ctx2.express('accept', ctx2.shop('shop_a'), second.order.id, {}, later(10));
  const { expireExpressPayments } = await import('../src/express-orders.js');
  assert.equal(expireExpressPayments(ctx2.store, { at: later(309), id: ctx2.id }), false);
  assert.equal(expireExpressPayments(ctx2.store, { at: later(310), id: ctx2.id }), true);
  assert.equal(second.order.state, 'cancelled');
});

test('QR over the instant limit waits for a GRIDGO check during review hours and is hidden outside them', async () => {
  const ctx = setup({ pages: 120 });
  const { order } = await send(ctx);
  assert.equal(order.totalMinor, 43200, '120 x 3 = 360 + 72 fee');
  await ctx.express('accept', ctx.shop('shop_a'), order.id, {}, later(20));
  await ctx.express('pay', ctx.client, order.id, { method: 'qr_ph', reference: 'REF-2', proofFileId: 'file_qr' }, later(40));
  assert.equal(order.state, 'initial_payment_review');
  assert.equal(order.expressOrder.paymentRelease, undefined);
  assert.equal(order.expressOrder.paymentReview.dueAt, later(220));
  assert.equal(sweepAcceptFirst(ctx.store, { at: later(220), id: ctx.id }), true);
  assert.equal(order.expressOrder.paymentReview.overdueAt, later(220));
  // 17:30 Manila: QR above the limit is not offered and, with cash off, the send is refused.
  const evening = setup({ pages: 120 });
  evening.call = caller(evening.store, evening.client, '2026-09-23T09:30:00.000Z');
  const draft = await evening.call('POST', '/express/drafts', { acceptFirst: true, location, fulfillmentMode: 'pickup', files, supplierId: 'shop_a' });
  await assert.rejects(evening.call('POST', `/me/carts/${draft.body.cartId}/checkout`, { looksRight: true, expressConfirmation: draft.body.confirmation }),
    e => e.code === 'express_payment_unavailable');
  const options = expressPaymentOptions(evening.store, { ...order, supplierId: 'shop_a' }, { accountType: 'individual' }, '2026-09-23T09:30:00.000Z');
  assert.equal(options.methods.find(m => m.method === 'qr_ph').reason, 'manual_review_closed');
});

test('cash at pickup is the default only where cash is switched on, and the pickup PIN records the cash', async () => {
  const ctx = setup();
  ctx.store.settings.cash = { ...ctx.store.settings.cash, enabled: true };
  ctx.store.shopMoneyEvents = [{ id: 'policy_a', kind: 'policy', supplierId: 'shop_a', at: AT, data: { counterCashEnabled: true, version: 1 } }];
  const { order } = await send(ctx);
  await ctx.express('accept', ctx.shop('shop_a'), order.id, {}, later(30));
  const options = publicExpress(order, ctx.client).payment.options;
  assert.equal(options.defaultMethod, 'cash_at_pickup');
  assert.deepEqual(options.methods.map(m => m.method), ['cash_at_pickup', 'qr_ph']);
  await ctx.express('pay', ctx.client, order.id, { method: 'cash_at_pickup' }, later(40));
  assert.equal(order.state, 'payment_authorized');
  assert.equal(order.paymentMethod, 'counter_cash');
  assert.deepEqual(order.clientPayment.methods, ['counter_cash']);
  order.state = 'ready_for_dispatch';
  const code = order.expressOrder.pickupCode;
  await assert.rejects(ctx.express('pickup', ctx.shop('shop_a'), order.id, { code }, later(600)), e => e.code === 'express_cash_confirmation_required');
  await ctx.express('pickup', ctx.shop('shop_a'), order.id, { code, cashReceived: true }, later(600));
  assert.equal(order.payments.initial.status, 'confirmed');
  assert.equal(order.payments.initial.confirmationSource, 'counter_cash');
  const counter = ctx.store.shopMoneyEvents.find(e => e.key === `counter:${order.id}`);
  assert.equal(counter.data.amountMinor, 4350);
  assert.equal(counter.data.shareMinor, 750, 'the shop owes GRIDGO only the fee');
  // A shop without counter cash, or a client outside the cash rules, gets QR only.
  ctx.store.shopMoneyEvents.push({ id: 'policy_a2', kind: 'policy', supplierId: 'shop_a', at: later(700), data: { counterCashEnabled: false, version: 2 } });
  assert.equal(expressPaymentOptions(ctx.store, { ...order, payments: { initial: { amountMinor: 4350 } } }, { accountType: 'individual' }, AT).methods[0].reason, 'shop_cash_disabled');
});

test('home printers: QR only, capped at the manual limit, and a pickup point only the accepted client sees', async () => {
  const ctx = setup();
  const { homePickupPoint, HOME_PICKUP_POINT_CONSENT, homePrinterResponse } = await import('../src/home-printers.js');
  const point = homePickupPoint({ point: { lat: 7.0645, lng: 125.609 }, kind: 'gate', description: 'Green gate beside the chapel', consent: { accepted: true, wording: HOME_PICKUP_POINT_CONSENT } }, AT);
  assert.throws(() => homePickupPoint({ point: { lat: 7, lng: 125 }, kind: 'roof', description: 'x', consent: { accepted: true, wording: HOME_PICKUP_POINT_CONSENT } }, AT), e => e.code === 'invalid_home_pickup_point');
  assert.throws(() => homePickupPoint({ point: { lat: 7, lng: 125 }, kind: 'gate', description: 'x', consent: { accepted: false } }, AT), e => e.code === 'home_pickup_point_consent_required');
  const order = { id: 'home_1', orderType: 'express', clientId: ctx.client.id, supplierId: 'shop_h', state: 'awaiting_initial_payment', fulfillmentMode: 'pickup',
    shopAcceptance: { status: 'accepted' }, payments: { initial: { amountMinor: 4350 } }, totalMinor: 4350,
    homePrinter: { supplierId: 'shop_h', barangay: 'Sample Barangay', pickupPoint: { lat: point.lat, lng: point.lng, kind: point.kind, description: point.description } },
    expressOrder: { acceptFlow: 2, location, printSettings: [], events: [] } };
  ctx.store.settings.cash = { ...ctx.store.settings.cash, enabled: true };
  const options = expressPaymentOptions(ctx.store, order, { accountType: 'individual' }, AT);
  assert.equal(options.defaultMethod, 'qr_ph');
  assert.equal(options.methods[0].reason, 'home_printer_qr_only');
  const view = publicExpress(order, ctx.client);
  assert.equal(view.pickupPoint.description, 'Green gate beside the chapel');
  assert.equal(view.pickupPoint.onlyVisibleToYou, true);
  assert.equal(publicExpress(order, { id: 'someone', role: 'client' }), null);
  assert.equal(publicExpress({ ...order, shopAcceptance: { status: 'pending' }, state: 'supplier_assigned' }, ctx.client).pickupPoint, null, 'hidden before accept');
  assert.equal(publicExpress({ ...order, expressOrder: { ...order.expressOrder, pickedUpAt: later(900) }, state: 'delivered' }, ctx.client).pickupPoint, null, 'hidden after pickup');
  assert.equal(publicExpress({ ...order, state: 'cancelled' }, ctx.client).pickupPoint, null, 'hidden after cancel');
  // The redaction walker keeps the point for its client and strips it from anyone else.
  ctx.store.supplierProfiles.push({ userId: 'shop_h', shopName: 'Private Home Name', contactName: 'Private Person', shop: { lat: 7.0641, lng: 125.6086, label: 'Private street label' },
    homePrinter: { barangay: 'Sample Barangay', street: 'Private street', pickupPoint: point } });
  ctx.store.orders.push(order);
  const payload = { order: { id: order.id, supplierId: 'shop_h', expressOrder: publicExpress(order, ctx.client) } };
  assert.ok(JSON.stringify(homePrinterResponse(ctx.store, payload, ctx.client)).includes('Green gate beside the chapel'));
  const stranger = homePrinterResponse(ctx.store, payload, { id: 'other_client', role: 'client' });
  assert.equal(JSON.stringify(stranger).includes('Green gate'), false);
  assert.equal(JSON.stringify(stranger).includes('7.0645'), false);
  const history = homePrinterResponse(ctx.store, { order: { ...payload.order, homePrinter: order.homePrinter } }, ctx.client);
  assert.equal(JSON.stringify(history).includes('Private street'), false, 'order history keeps the barangay only');
  // Cap: a home printer cannot take an order above the manual QR limit.
  const { homePrinterLimitMinor } = await import('../src/express-checkout-rules.js');
  assert.equal(homePrinterLimitMinor({}), 30000);
  assert.equal(homePrinterLimitMinor({ expressCheckout: { paymentConfirmation: 'gateway' } }), null);
});

test('accept rate counts declines and missed windows, ignores client withdrawals, and gives no warning', () => {
  const offer = (status, supplierId = 'shop_a', assignedAt = AT) => ({ orderType: 'express', expressOrder: { acceptFlow: 2 }, shopAcceptance: { supplierId, status, assignedAt } });
  const store = { orders: [offer('accepted'), offer('accepted'), offer('declined'), offer('timed_out'), offer('withdrawn'), offer('pending'),
    offer('declined', 'shop_b'), offer('accepted', 'shop_a', '2026-08-01T00:00:00.000Z'), { ...offer('declined'), expressOrder: { version: 1 } }] };
  assert.deepEqual(expressAcceptRate(store, 'shop_a', later(60)), { windowDays: 30, offered: 4, accepted: 2, declined: 1, timedOut: 1, rate: 0.5 });
  assert.equal(expressAcceptRate(store, 'shop_z', AT).rate, null);
});

test('an "I\'m on my way" PIN order keeps its PIN across a move and takes cash at pickup on the same PIN hand-over', async () => {
  const ctx = setup({ prices: { shop_c: 250 } });
  ctx.store.settings.cash = { ...ctx.store.settings.cash, enabled: true };
  ctx.store.shopMoneyEvents = [{ id: 'policy_c', kind: 'policy', supplierId: 'shop_c', at: AT, data: { counterCashEnabled: true, version: 1 } }];
  const draft = await ctx.call('POST', '/express/drafts', { acceptFirst: true, location, fulfillmentMode: 'pickup', files, supplierId: 'shop_a' });
  const placed = await ctx.call('POST', `/me/carts/${draft.body.cartId}/checkout`, { looksRight: true, expressConfirmation: draft.body.confirmation, expressPickupPin: 'on_my_way' });
  assert.equal(placed.status, 201);
  const first = ctx.store.orders.find(o => o.id === placed.body.order.id);
  assert.equal(first.expressOrder.handoverVersion, 2);
  await ctx.express('decline', ctx.shop('shop_a'), first.id, { reason: 'Printer jammed' });
  const order = current(ctx.store, first);
  assert.equal(order.supplierId, 'shop_c');
  assert.equal(order.expressOrder.handoverVersion, 2, 'the move keeps the client\'s hand-over choice');
  assert.equal(Object.hasOwn(order.expressOrder, 'pickupCode'), false);
  await ctx.express('accept', ctx.shop('shop_c'), order.id, {}, later(30));
  await ctx.express('pay', ctx.client, order.id, { method: 'cash_at_pickup' }, later(40));
  order.state = 'ready_for_dispatch';
  await assert.rejects(ctx.express('pickup', ctx.shop('shop_c'), order.id, { code: '123456', cashReceived: true }, later(500)), e => e.code === 'express_pickup_pin_not_issued');
  const pin = (await ctx.express('on-my-way', ctx.client, order.id, {}, later(510))).body.expressOrder.pickupPin;
  assert.match(pin, /^\d{6}$/);
  assert.equal(publicExpress(order, ctx.shop('shop_c')).counterCollection.amountMinor, order.payments.initial.amountMinor);
  await assert.rejects(ctx.express('pickup', ctx.shop('shop_c'), order.id, { code: pin }, later(600)), e => e.code === 'express_cash_confirmation_required');
  await ctx.express('pickup', ctx.shop('shop_c'), order.id, { code: pin, cashReceived: true }, later(600));
  assert.deepEqual([order.payments.initial.status, order.payments.initial.confirmationSource], ['confirmed', 'counter_cash']);
  assert.equal(ctx.store.shopMoneyEvents.filter(e => e.key === `counter:${order.id}`).length, 1, 'one counter debt, one cash record');
  assert.deepEqual(publicExpress(order, ctx.shop('shop_c')).handedOver, { at: later(600), method: 'pickup_pin', cashReceived: true });
});

test('accept-first rerouting applies the monthly boost only for the saved Nearest sort',async()=>{
  for(const [sort,expected] of [['nearest','shop_c'],['nearby','shop_c'],['cheapest','shop_b'],['all_davao','shop_b']]) {
    const ctx=setup();
    Object.assign(ctx.store.supplierProfiles.find(row=>row.userId==='shop_b').shop,{lat:7.065,lng:125.6085});
    ctx.store.shopLeaderboardMonths=[{month:'2026-08',validFrom:'2026-08-31T16:00:00.000Z',validUntil:'2026-09-30T16:00:00.000Z',winners:[{supplierId:'shop_c'}]}];
    const {order}=await send(ctx,{sort});
    await ctx.express('decline',ctx.shop('shop_a'),order.id,{reason:'Capacity reached'});
    assert.equal(current(ctx.store,order).supplierId,expected,sort);
  }
});

test('a new-job pause refuses an outstanding offer but leaves an already accepted job accessible',async()=>{
 for(const kind of ['missed','money']) {
  const ctx=setup(),{order}=await send(ctx),profile=ctx.store.supplierProfiles.find(p=>p.userId==='shop_a');
  const pause=()=>{if(kind==='missed')profile.availability={...profile.availability,missedJobPause:{active:true}};
   else (ctx.store.shopMoneyEvents||=[]).push({id:'overdue-example',kind:'pay_request',supplierId:'shop_a',data:{amountMinor:1,deadlineAt:AT}});};
  pause();
  await assert.rejects(ctx.express('accept',ctx.shop('shop_a'),order.id,{},later(10)),e=>e.code==='shop_new_jobs_paused');
  profile.availability={};ctx.store.shopMoneyEvents=[];
  await ctx.express('accept',ctx.shop('shop_a'),order.id,{},later(20));pause();
  assert.equal((await ctx.express('accept',ctx.shop('shop_a'),order.id,{},later(25))).status,200);
 }
});
