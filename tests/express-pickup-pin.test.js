import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller } from './fixtures/scheduling.js';
import { routeExpressOrders } from '../src/express-routes.js';
import { publicExpress, startExpressAcceptance } from '../src/express-orders.js';
import { orderTracker, routeOrderTracking, ratingAllowed } from '../src/order-tracker.js';
import { riderPinBlocksPickup, counterCashDueMinor, walkEstimate } from '../src/pickup-pin.js';
import { quickMessageCodes, quickMessageText } from '../src/quick-messages.js';
import { clientNotificationDraft, rateReminderDraft } from '../src/client-order-notifications.js';
import { staffExpressProjection } from '../src/shop-staff-order.js';
import { staffRouteAllowed } from '../src/shop-team.js';

const AT = '2026-09-23T01:00:00.000Z';
const later = minutes => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

function setup({ version = 2, fulfillmentMode = 'pickup' } = {}) {
  const { store, client } = fixture({ express: true });
  client.name = 'Mara Lindqvist';
  store.users.push({ id: 'staff_one', role: 'supplier', name: 'Tomas Reyes' }, { id: 'ops', role: 'ops_admin', name: 'Ops' }, { id: 'rider_one', role: 'rider', name: 'Rider', verificationStatus: 'approved' });
  store.userRoleMemberships.push({ userId: 'ops', role: 'ops_admin' }, { userId: 'rider_one', role: 'rider', status: 'approved' });
  const order = { id: 'order_x', orderType: 'express', clientId: client.id, supplierId: 'shop_a', state: 'supplier_assigned', fulfillmentMode,
    fileCheck: { status: 'passed' }, totalMinor: 4350, supplierSubtotalMinor: 3600, createdAt: AT, promiseBy: later(50), readyBy: later(40),
    pickup: { lat: 7.064, lng: 125.6085 }, timeline: [], payoutMilestones: [],
    payments: { initial: { status: 'confirmed', amountMinor: 4350 }, final_online: { status: 'not_required', amountMinor: 0 } },
    expressOrder: { version: 1, originalSupplierId: 'shop_a', location: { lat: 7.0685, lng: 125.6085 }, declines: 0, events: [],
      ...(version === 2 ? { handoverVersion: 2 } : { pickupCode: '012345' }) } };
  store.orders.push(order);
  startExpressAcceptance(order, AT);
  let n = 0;
  const id = p => `${p}_${++n}`;
  const audit = (s, event) => s.auditLog.push({ id: id('aud'), ...event });
  const call = (path, user, body = {}, at = AT) => routeExpressOrders({ req: { method: 'POST' }, url: new URL(`http://test/orders/order_x/express/${path}`),
    store, user, readBody: async () => body, id, now: () => at, audit });
  const progress = (user, body, at = AT) => routeOrderTracking({ req: { method: 'POST' }, url: new URL('http://test/orders/order_x/production-progress'),
    store, user, readBody: async () => body, now: () => at, audit });
  return { store, client, order, call, progress, id };
}
const shop = { id: 'shop_a', role: 'supplier' };
const staff = { id: 'shop_a', role: 'supplier', actorUserId: 'staff_one', shopRole: 'staff' };
const ops = { id: 'ops', role: 'ops_admin' };
const rider = { id: 'rider_one', role: 'rider' };
const move = (order, state, by, at) => { order.state = state; order.timeline.push({ at, state, by }); if (state === 'ready_for_dispatch') order.readyAt = at; };

test('the tracker walks sent, accepted by name, printing with progress, ready and picked up', async () => {
  const { store, client, order, call, progress } = setup();
  let tracker = orderTracker(store, order, client, AT);
  assert.equal(tracker.status, 'sent');
  assert.equal(tracker.steps[0].at, AT);
  assert.equal(tracker.readyBy, later(50));
  assert.equal(orderTracker(store, order, { id: 'someone', role: 'client' }, AT), null);
  assert.equal(orderTracker(store, order, rider, AT), null);

  assert.equal((await call('accept', staff, {}, later(1))).status, 200);
  tracker = orderTracker(store, order, client, later(1));
  assert.equal(tracker.status, 'accepted');
  assert.deepEqual([tracker.steps[1].at, tracker.steps[1].byFirstName], [later(1), 'Tomas']);

  await assert.rejects(progress(staff, { done: 1, total: 10 }), e => e.code === 'production_progress_unavailable');
  move(order, 'production', 'staff_one', later(10));
  await assert.rejects(progress(staff, { done: 11, total: 10 }), e => e.code === 'invalid_production_progress');
  await assert.rejects(progress(staff, { done: 1, total: 10, unit: 'reams' }), e => e.code === 'invalid_production_progress');
  await assert.rejects(progress({ id: 'shop_b', role: 'supplier' }, { done: 1, total: 10 }), e => e.code === 'forbidden');
  const reported = await progress(staff, { done: 60, total: 100 }, later(16));
  assert.equal(reported.status, 200);
  tracker = orderTracker(store, order, client, later(16));
  assert.equal(tracker.status, 'printing');
  assert.deepEqual(tracker.steps[2], { key: 'printing', status: 'current', at: later(10), byFirstName: 'Tomas',
    progress: { done: 60, total: 100, unit: 'pages', updatedAt: later(16) } });
  // Six minutes for 60 pages: the remaining 40 take four more.
  assert.deepEqual([tracker.readyBy, tracker.readyBySource], [later(20), 'progress']);
  assert.equal(tracker.steps[3].expectedAt, later(20));

  move(order, 'ready_for_dispatch', 'staff_one', later(21));
  tracker = orderTracker(store, order, client, later(21));
  assert.equal(tracker.status, 'ready');
  assert.equal(tracker.steps[2].progress, null);
  assert.equal(tracker.steps[3].at, later(21));
  assert.equal(tracker.pickup.onMyWayAvailable, true);
  assert.equal(orderTracker(store, order, shop, later(21)).pickup.onMyWayAvailable, false);
});

test('the tracker covers regular orders through their own timeline', () => {
  const { store, client, order } = setup();
  delete order.orderType; delete order.expressOrder; order.fulfillmentMode = 'delivery';
  order.shopAcceptance = { supplierId: 'shop_a', assignedAt: later(2), status: 'accepted', acceptedAt: later(5), acceptedBy: 'staff_one' };
  move(order, 'payment_authorized', 'shop_a', later(5));
  move(order, 'production', 'shop_a', later(30));
  move(order, 'ready_for_dispatch', 'shop_a', later(90));
  move(order, 'out_for_delivery', 'rider_one', later(100));
  let tracker = orderTracker(store, order, client, later(100));
  assert.deepEqual(tracker.steps.map(step => [step.key, step.status]), [['sent', 'done'], ['accepted', 'done'], ['printing', 'done'], ['ready', 'current'], ['delivered', 'upcoming']]);
  assert.equal(tracker.steps[0].at, later(2));
  assert.equal(tracker.steps[1].byFirstName, 'Tomas');
  assert.equal(tracker.pickup, null);
  order.state = 'issue_window_open'; order.issueWindowOpenedAt = later(120);
  tracker = orderTracker(store, order, client, later(120));
  assert.equal(tracker.status, 'delivered');
  assert.equal(tracker.steps[4].at, later(120));
  assert.equal(tracker.ratingDue, false, 'regular orders are still rated after the issue window');
  assert.equal(orderTracker(store, order, ops, later(120)).status, 'delivered');
});

test("on my way creates the PIN only then, shows it only to the client and tells the shop the walk time", async () => {
  const { store, client, order, call } = setup();
  await call('accept', shop);
  move(order, 'production', 'shop_a', later(5));
  await assert.rejects(call('on-my-way', client), e => e.code === 'express_not_ready');
  assert.equal(publicExpress(order, client).pickupPinIssued, false);
  assert.equal(publicExpress(order, client).pickupPin, undefined);
  move(order, 'ready_for_dispatch', 'shop_a', later(20));
  assert.equal(publicExpress(order, client).pickupCode, undefined, 'version 2 never shows a checkout counter code');
  await assert.rejects(call('pickup', shop, { code: '123456' }, later(21)), e => e.code === 'express_pickup_pin_not_issued');
  await assert.rejects(call('on-my-way', { id: 'other', role: 'client' }), e => e.code === 'forbidden');
  await assert.rejects(call('on-my-way', client, { location: { lat: 99, lng: 0 } }), e => e.code === 'invalid_location');

  const result = await call('on-my-way', client, {}, later(22));
  assert.equal(result.status, 200);
  const pin = result.body.expressOrder.pickupPin;
  assert.match(pin, /^\d{6}$/);
  // 0.0045 degrees of latitude is about 500 m: seven minutes at 80 m a minute.
  assert.deepEqual([order.expressOrder.onMyWay.walkMinutes, order.expressOrder.onMyWay.clientLabel], [7, 'Mara L.']);
  const notice = store.notifications.find(n => n.type === 'shop_client_on_the_way');
  assert.deepEqual([notice.userId, notice.title], ['shop_a', 'Mara L. is on the way']);
  assert.match(notice.body, /About 7 min away/);
  assert.doesNotMatch(JSON.stringify(notice), new RegExp(pin));
  for (const viewer of [shop, staff, ops, rider, { id: 'other', role: 'client' }]) {
    assert.doesNotMatch(JSON.stringify(publicExpress(order, viewer) || {}), new RegExp(`"${pin}"`));
  }
  assert.equal(publicExpress(order, shop).onMyWay.walkMinutes, 7);
  assert.equal(staffExpressProjection(publicExpress(order, staff)).onMyWay.clientLabel, 'Mara L.');

  const again = await call('on-my-way', client, { location: { lat: 7.064, lng: 125.6085 } }, later(25));
  assert.equal(again.body.expressOrder.pickupPin, pin, 'a second tap keeps the PIN');
  assert.equal(order.expressOrder.onMyWay.walkMinutes, 1);
  assert.equal(store.notifications.filter(n => n.type === 'shop_client_on_the_way').length, 1);
});

test('hand-over needs the right PIN, waits after five wrong tries and locks after ten until Operations resets it', async () => {
  const { store, client, order, call } = setup();
  await call('accept', shop);
  move(order, 'ready_for_dispatch', 'shop_a', later(20));
  const pin = (await call('on-my-way', client, {}, later(21))).body.expressOrder.pickupPin;
  const wrong = pin === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 5; i++) {
    const refused = await call('pickup', staff, { code: wrong }, later(22));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'express_pickup_code_mismatch');
  }
  assert.equal(order.state, 'ready_for_dispatch');
  assert.equal(order.expressOrder.pickedUpAt, undefined);
  const waiting = await call('pickup', staff, { code: pin }, later(23));
  assert.deepEqual([waiting.status, waiting.body.error], [429, 'express_pickup_attempts_exceeded']);
  for (let i = 1; i <= 4; i++) assert.equal((await call('pickup', staff, { code: wrong }, later(40))).status, 409);
  const locked = await call('pickup', staff, { code: wrong }, later(41));
  assert.deepEqual([locked.status, locked.body.error], [423, 'express_pickup_pin_locked']);
  assert.equal((await call('pickup', staff, { code: pin }, later(80))).status, 423, 'even the right PIN waits for the reset');
  assert.equal(publicExpress(order, client).pickupPin, undefined);
  assert.equal(publicExpress(order, client).pickupPinLocked, true);
  assert.ok(store.notifications.some(n => n.userId === client.id && n.type === 'order_pickup_pin_locked'));
  assert.ok(store.notifications.some(n => n.userId === 'ops' && n.type === 'ops_express_pickup_pin_locked'));

  await assert.rejects(call('pickup-pin/reset', shop, { reason: 'x' }), e => e.code === 'forbidden');
  await assert.rejects(call('pickup-pin/reset', ops, {}), e => e.code === 'reason_required');
  assert.equal((await call('pickup-pin/reset', ops, { reason: 'Client confirmed by call' }, later(81))).status, 200);
  const fresh = publicExpress(order, client).pickupPin;
  assert.match(fresh, /^\d{6}$/);
  if (fresh !== pin) assert.equal((await call('pickup', staff, { code: pin }, later(82))).status, 409, 'the old PIN stops working');
  const done = await call('pickup', staff, { code: fresh }, later(83));
  assert.equal(done.status, 200);
  assert.equal(order.state, 'issue_window_open');
  assert.equal(order.expressOrder.pickedUpAt, later(83));
  assert.deepEqual(order.expressOrder.pickupHandover, { at: later(83), method: 'pickup_pin', byUserId: 'staff_one', cashCollectedMinor: 0 });
  assert.equal(publicExpress(order, client).pickupPin, undefined, 'the PIN disappears after pickup');
  assert.equal((await call('pickup', staff, { code: fresh }, later(84))).status, 200, 'repeat success is idempotent');

  assert.equal(ratingAllowed(order), true);
  assert.equal(orderTracker(store, order, client, later(84)).ratingDue, true);
  assert.equal(orderTracker(store, order, client, later(84)).status, 'picked_up');
  assert.equal(rateReminderDraft(store, order).type, 'order_rate_reminder');
  assert.equal(clientNotificationDraft(order).title, 'Picked up');
});

test('counter cash must match what is owed and is recorded at hand-over', async () => {
  const { store, client, order, call } = setup();
  await call('accept', shop);
  order.paymentMethod = 'counter_cash';
  order.payments.initial = { status: 'not_submitted', amountMinor: 4350, method: 'counter_cash' };
  move(order, 'ready_for_dispatch', 'shop_a', later(20));
  assert.equal(counterCashDueMinor(order), 4350);
  const pin = (await call('on-my-way', client, {}, later(21))).body.expressOrder.pickupPin;
  assert.deepEqual(publicExpress(order, shop).counterCollection, { amountMinor: 4350 });
  assert.deepEqual(staffExpressProjection(publicExpress(order, staff)).counterCollection, { amountMinor: 4350 });
  await assert.rejects(call('pickup', staff, { code: pin }, later(22)), e => e.code === 'cash_collected_required' && e.details.amountDueMinor === 4350);
  await assert.rejects(call('pickup', staff, { code: pin, cashCollectedMinor: 4000 }, later(22)), e => e.code === 'cash_collected_mismatch');
  assert.equal(order.expressOrder.pickupPin.totalFailedAttempts, 0, 'a cash mistake is not a PIN guess');
  assert.equal((await call('pickup', staff, { code: pin, cashCollectedMinor: 4350 }, later(23))).status, 200);
  assert.equal(order.expressOrder.pickupHandover.cashCollectedMinor, 4350);
  assert.equal(publicExpress(order, shop).handedOver.cashCollectedMinor, 4350);
  assert.equal(publicExpress(order, client).handedOver.cashCollectedMinor, undefined);
  assert.ok(store.auditLog.some(row => row.action === 'express.counter_cash_collected'));
  assert.ok(store.notifications.some(n => n.type === 'ops_express_counter_cash_collected'));

  const paid = setup();
  await paid.call('accept', shop);
  move(paid.order, 'ready_for_dispatch', 'shop_a', later(20));
  const paidPin = (await paid.call('on-my-way', paid.client, {}, later(21))).body.expressOrder.pickupPin;
  await assert.rejects(paid.call('pickup', shop, { code: paidPin, cashCollectedMinor: 100 }, later(22)), e => e.code === 'cash_not_due');
});

test('orders placed with the old counter code keep working unchanged', async () => {
  const { store, client, order, call } = setup({ version: 1 });
  await call('accept', shop);
  move(order, 'ready_for_dispatch', 'shop_a', later(20));
  assert.equal(publicExpress(order, client).pickupCode, '012345');
  assert.equal(publicExpress(order, client).pickupHandover, 'counter_code');
  await assert.rejects(call('on-my-way', client), e => e.code === 'express_on_my_way_unavailable');
  assert.equal(orderTracker(store, order, client, later(20)).pickup.handover, 'counter_code');
  assert.equal(clientNotificationDraft(order).body, 'Show your pickup code at the shop counter.');
  assert.equal((await call('pickup', shop, { code: '012345' }, later(21))).status, 200);
  assert.equal(order.state, 'issue_window_open');
});

test('Express checkout opts into the PIN flow; other values are refused and the default stays on the counter code', async () => {
  for (const [extra, expected] of [[{}, 'legacy'], [{ expressPickupPin: 'on_my_way' }, 'pin']]) {
    const { store, client } = fixture({ express: true });
    for (const item of store.catalogItems) { item.express = true; item.printLayouts = ['fit_to_paper']; item.pricingUnit = 'per_page'; item.subcategoryCode = 'document_printing'; }
    for (const service of store.supplierServices) service.categoryCode = 'document_publication';
    store.files.find(f => f.fileId === 'file_art').detected = { pageCount: 3 };
    const call = caller(store, client, AT);
    const draft = await call('POST', '/express/drafts', { supplierId: 'shop_a', location: { lat: 7.064, lng: 125.6085 }, fulfillmentMode: 'pickup',
      files: [{ fileId: 'file_art', copies: 1, colour: 'bw', paper: 'a4', sides: 'one', layout: 'fit_to_paper', acceptedWarnings: [] }] });
    const body = { expressConfirmation: draft.body.confirmation, looksRight: true, payment: { method: 'qr_manual', reference: 'EXPRESS-1', proofFileId: 'file_qr' } };
    if (expected === 'pin') await assert.rejects(call('POST', `/me/carts/${draft.body.cartId}/checkout`, { ...body, expressPickupPin: 'yes' }), e => e.code === 'invalid_express_pickup_pin');
    const placed = await call('POST', `/me/carts/${draft.body.cartId}/checkout`, { ...body, ...extra });
    const order = store.orders.find(o => o.id === placed.body.order.id);
    if (expected === 'pin') {
      assert.equal(order.expressOrder.handoverVersion, 2);
      assert.equal(Object.hasOwn(order.expressOrder, 'pickupCode'), false);
    } else {
      assert.equal(order.expressOrder.handoverVersion, undefined);
      assert.match(order.expressOrder.pickupCode, /^\d{6}$/);
    }
  }
});

test('delivery gives the rider the PIN step; Super Admin decides when pickup checks wait for it', async () => {
  const { store, order, call } = setup({ fulfillmentMode: 'delivery' });
  await call('accept', shop);
  move(order, 'ready_for_dispatch', 'shop_a', later(20));
  await assert.rejects(call('on-my-way', rider), e => e.code === 'forbidden');
  order.riderId = 'rider_one';
  move(order, 'rider_assigned', 'rider_one', later(25));
  assert.equal(riderPinBlocksPickup(store, order), false, 'off by default for released rider builds');
  store.settings.expressRiderPinRequired = true;
  assert.equal(riderPinBlocksPickup(store, order), true);
  const issued = await call('on-my-way', rider, {}, later(26));
  const code = issued.body.expressOrder.riderPin.code;
  assert.match(code, /^\d{6}$/);
  assert.equal(publicExpress(order, shop).riderPin.code, undefined);
  assert.ok(store.notifications.some(n => n.type === 'shop_rider_on_the_way' && n.userId === 'shop_a'));
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await call('pickup', staff, { code: wrong }, later(27))).status, 409);
  assert.equal(riderPinBlocksPickup(store, order), true);
  assert.equal((await call('pickup', staff, { code }, later(28))).status, 200);
  assert.equal(order.state, 'rider_assigned', 'the rider checks still move the package');
  assert.equal(order.expressOrder.riderPin.verifiedAt, later(28));
  assert.equal(riderPinBlocksPickup(store, order), false);
  assert.equal(publicExpress(order, rider).riderPin.code, undefined, 'used PINs are hidden');
  order.riderId = 'rider_two';
  assert.equal(riderPinBlocksPickup(store, order), true, 'a new rider needs a new PIN');
});

test('quick messages follow the pickup stage and are fixed text', () => {
  const { order } = setup();
  order.state = 'production';
  assert.deepEqual(quickMessageCodes(order, 'client'), []);
  order.state = 'ready_for_dispatch';
  assert.deepEqual(quickMessageCodes(order, 'client'), ['there_in_10', 'keep_until']);
  assert.deepEqual(quickMessageCodes(order, 'supplier'), ['ready_at_counter', 'see_you_soon']);
  assert.equal(quickMessageText(order, 'client', { code: 'keep_until', time: '17:00' }), 'Please keep it until 5 PM');
  assert.equal(quickMessageText(order, 'client', { code: 'keep_until', time: '09:30' }), 'Please keep it until 9:30 AM');
  assert.throws(() => quickMessageText(order, 'client', { code: 'keep_until', time: '5pm' }), e => e.code === 'invalid_quick_message');
  assert.throws(() => quickMessageText(order, 'client', { code: 'im_here' }), e => e.code === 'quick_message_unavailable');
  order.expressOrder.onMyWay = { at: AT };
  assert.deepEqual(quickMessageCodes(order, 'client'), ['im_here', 'running_late', 'thank_you']);
  assert.equal(quickMessageText(order, 'client', { code: 'im_here' }), "I'm here · Ania na ko");
  order.fulfillmentMode = 'delivery';
  assert.deepEqual(quickMessageCodes(order, 'client'), []);
});

test('pushes name each pickup step, staff may report progress, and walk time hides a home address', () => {
  const { order } = setup();
  order.state = 'production'; order.timeline.push({ at: AT, state: 'production' });
  assert.equal(clientNotificationDraft(order).title, 'Printing has started');
  order.state = 'ready_for_dispatch'; order.timeline.push({ at: later(1), state: 'ready_for_dispatch' });
  assert.deepEqual([clientNotificationDraft(order).title, clientNotificationDraft(order).body],
    ['Your print is ready!', "Tap I'm on my way when you leave. Your 6-digit pickup PIN shows then."]);
  assert.equal(staffRouteAllowed('POST', '/orders/o/production-progress'), true);
  assert.equal(staffRouteAllowed('POST', '/orders/o/express/on-my-way'), false);
  assert.deepEqual(walkEstimate({ pickup: { lat: 7.064, lng: 125.6085 }, homePrinter: {} }, { lat: 7.0641, lng: 125.6085 }), { walkMinutes: 7, walkEstimateSource: 'straight_line_80m_per_minute' });
});
