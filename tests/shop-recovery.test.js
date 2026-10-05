import { publicHubPickup } from "../src/hub-pickup.js";
import { gridgoOfficePoint } from "../src/gridgo-office.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultOperationalSettings, createPayoutMilestones, activePayoutHold, publicOrderFor } from '../src/operational-model.js';
import { startShopAcceptance, expireShopAcceptances, recordShopFailure, findReplacementShop, CANCELLABLE_SHOP_STATES } from '../src/shop-recovery.js';
import { routeShopRecovery } from '../src/shop-recovery-routes.js';
import { assertRefundWorkAllowed } from '../src/refund-policy.js';
import { defaultShopSchedule } from '../src/availability.js';
const AT = '2026-10-05T00:00:00.000Z';
let seq = 0;
const id = (prefix) => `${prefix}_${++seq}`;
function addShop(store, {
  id,
  lat,
  lng,
  turnaroundHours,
  description = "Complete listing description",
  prepSteps = 1,
  openJobs = 0,
  closed = false,
  subcategories = ["flyers"],
  priceMinor = 10_000,
  capacityDaily = null,
  schedule = null,
  reviews = [],
}) {
  store.users.push({ id, role: "supplier", email: `${id}@gridgo.test` });
  store.userRoleMemberships.push({ userId: id, role: "supplier" });
  store.approvalCases.push({ id: `case_${id}`, userId: id, kind: "supplier", status: "approved" });
  store.supplierProfiles.push({
    userId: id,
    shopName: `${id} Printshop`,
    contactName: id,
    shop: { lat, lng, label: `${id} Davao` },
    pickupAvailable: true,
    isClosed: closed,
    ...(schedule ? { schedule } : {}),
  });
  for (const [index, qualityStars] of reviews.entries()) {
    store.shopReviews.push({ id: `rev_${id}_${index}`, supplierId: id, qualityStars, createdAt: AT });
  }
  const serviceId = `service_${id}`;
  store.supplierServices.push({
    id: serviceId,
    supplierId: id,
    categoryCode: "marketing_collateral",
    state: "live",
    pricingBasis: "per_unit",
    standardTurnaroundHours: turnaroundHours,
    turnaroundHours,
    ...(capacityDaily ? { capacityDaily } : {}),
    version: 1,
  });
  store.supplierServiceFileFormats.push({ supplierServiceId: serviceId, formatCode: "pdf" });
  for (const [index, subcategoryCode] of subcategories.entries()) {
    const itemId = `item_${id}_${subcategoryCode}`;
    store.catalogItems.push({
      id: itemId,
      supplierId: id,
      supplierServiceId: serviceId,
      subcategoryCode,
      name: `${id} ${subcategoryCode}`,
      description,
      basePriceMinor: priceMinor + index,
      pricingUnit: "per_unit",
      turnaroundMode: "inherit",
      fileFormatMode: "inherit",
      active: true,
      sortOrder: index,
      version: 1,
    });
    const fileId = `photo_${itemId}`;
    store.files.push({ fileId, ownerId: id, purpose: "catalog_item_photo", state: "ready", objectKey: `${id}/${itemId}.jpg` });
    store.catalogItemPhotos.push({ catalogItemId: itemId, fileId, sortOrder: 0 });
    for (let step = 0; step < prepSteps; step += 1) {
      store.catalogPrepSteps.push({ id: `step_${itemId}_${step}`, catalogItemId: itemId, sortOrder: step, title: `Step ${step}`, body: "Prepare artwork" });
    }
  }
  for (let index = 0; index < openJobs; index += 1) {
    store.orderJobs.push({
      id: `job_${id}_${index}`,
      supplierId: id,
      state: "production",
      estimatedHours: turnaroundHours,
      createdAt: AT,
    });
  }
}

function matchFixture() {
  return {
    taxonomy: {
      categories: [{ code: "marketing_collateral", active: true }],
      categoryAliases: [],
      subcategories: [{ code: "flyers", categoryCode: "marketing_collateral", active: true }],
    },
    users: [],
    userRoleMemberships: [],
    approvalCases: [],
    supplierProfiles: [],
    supplierServices: [],
    supplierServiceFileFormats: [],
    acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
    catalogItems: [],
    catalogItemFileFormats: [],
    catalogItemPhotos: [],
    catalogOptionGroups: [],
    catalogOptions: [],
    catalogPrepSteps: [],
    files: [],
    orderJobs: [],
    orders: [],
    shopReviews: [],
    settings: { ...defaultOperationalSettings(), promiseAllowanceMinutes: 0 },
  };
}

function fixture() {
  const store = matchFixture();
  store.auditLog = []; store.notifications = []; store.claims = [];
  store.userRoleMemberships.push({ userId: 'client', role: 'client' }, { userId: 'ops', role: 'ops_admin' }, { userId: 'admin', role: 'super_admin' });
  for (const name of ['original', 'replacement']) addShop(store, { id: name, lat: 7.06, lng: 125.6, turnaroundHours: 1 });
  store.catalogItems.forEach((item) => { item.name = 'Flyers'; });
  const order = { id: 'order', clientId: 'client', supplierId: 'original', state: 'supplier_assigned',
    supplierSubtotalMinor: 10000, supplierPlatformPayoutMinor: 10000, serviceFeeMinor: 1000, totalMinor: 11000,
    payoutPlanVersion: 2, commercialCommittedAt: AT, moneyModelVersion: 3, timeline: [],
    payments: { initial: { status: 'confirmed', method: 'qr_manual', amountMinor: 11000 } },
    paymentAllocations: [{ paymentCode: 'initial', component: 'supplier_principal', amountMinor: 10000 },
      { paymentCode: 'initial', component: 'service_fee', amountMinor: 1000 }] };
  order.payoutMilestones = createPayoutMilestones(order, { version: 2 });
  store.orders.push(order);
  store.orderLineItems = [{ id: 'line', orderId: order.id, sourceCatalogItemId: 'item_original_flyers', itemNameSnapshot: 'Flyers',
    quantity: 1, lineSubtotalMinor: 10000, pricingUnitSnapshot: 'per_unit', turnaroundHoursSnapshot: 1 }];
  return store;
}
const failShop = (store, extra = {}) => recordShopFailure(store, store.orders[0], { kind: 'cancelled', reason: 'Machine unavailable', at: AT, createId: id, ...extra });
const call = (store, action, body = {}, user = { id: 'client', role: 'client' }) => routeShopRecovery({
  req: { method: 'POST', headers: { 'idempotency-key': id('key') } }, url: new URL(`http://test/orders/order/${action}`),
  store, user, readBody: async () => body, now: () => AT, id,
  audit: (store, row) => store.auditLog.push(row),
});

test('one opening hour pauses overnight, weekends, split shifts and closures; never expires early by seconds', () => {
  const store = fixture(), order = store.orders[0];
  startShopAcceptance(store, order, '2026-10-10T09:30:30.000Z');
  assert.equal(order.shopAcceptance.deadlineAt, '2026-10-12T00:30:30.000Z');
  const schedule = defaultShopSchedule();
  schedule.closures = [{ startDay: '2026-10-12', endDay: '2026-10-12' }];
  store.supplierProfiles[0].schedule = schedule;
  startShopAcceptance(store, order, '2026-10-10T09:30:00.000Z');
  assert.equal(order.shopAcceptance.deadlineAt, '2026-10-13T00:30:00.000Z');
  schedule.week = [{ weekday: 1, opensMinute: 480, closesMinute: 510 }, { weekday: 1, opensMinute: 600, closesMinute: 660 }];
  schedule.closures = [];
  startShopAcceptance(store, order, AT);
  assert.equal(order.shopAcceptance.deadlineAt, '2026-10-05T02:30:00.000Z');
});

test('timeout creates one stage event, client proposal, durable admin notifications and independent holds', () => {
  const store = fixture(), order = store.orders[0];
  startShopAcceptance(store, order, AT);
  assert.equal(expireShopAcceptances(store, { at: '2026-10-05T00:59:59Z', createId: id }), false);
  assert.equal(expireShopAcceptances(store, { at: '2026-10-05T01:00:00Z', createId: id }), true);
  assert.equal(order.shopFailureEvents[0].kind, 'timed_out');
  assert.equal(order.shopFailureEvents[0].stage, 'supplier_assigned');
  assert.equal(order.shopRecovery.proposal.supplierId, 'replacement');
  assert.equal(order.supplierId, 'original');
  assert.equal(store.notifications.length, 4);
  assert.equal(activePayoutHold(store, order), true);
  assert.throws(() => assertRefundWorkAllowed(store, order), { code: 'shop_recovery_pending' });
  assert.equal(expireShopAcceptances(store, { at: '2026-10-06T00:00:00Z', createId: id }), false);
  assert.equal(order.shopFailureEvents.length, 1);
});

for (const state of CANCELLABLE_SHOP_STATES) test(`cancellation at ${state} records original stage`, () => {
  const store = fixture(); store.orders[0].state = state;
  failShop(store);
  assert.equal(store.orders[0].shopFailureEvents[0].stage, state);
  assert.equal(store.orders[0].shopRecovery.status, 'awaiting_client');
});

test('dispatch custody is the cancellation cutoff', () => {
  const store = fixture(); store.orders[0].state = 'picked_up';
  assert.throws(() => failShop(store), { code: 'shop_cancel_not_available' });
});

test('any released share forces Operations review; cannot accept even a tampered offer', async () => {
  const store = fixture(), order = store.orders[0];
  order.payoutMilestones[1].status = 'released';
  failShop(store);
  assert.equal(order.shopRecovery.status, 'ops_review');
  assert.equal(order.shopRecovery.proposal, null);
  order.shopRecovery.status = 'awaiting_client'; order.shopRecovery.proposal = { supplierId: 'replacement' };
  await assert.rejects(call(store, 'shop-recovery/accept', { recoveryId: order.shopRecovery.id }), { code: 'shop_recovery_requires_operations' });
});

test('matching rejects missing specs, higher prices, wrong product, and previously failed shops', () => {
  const store = fixture(), order = store.orders[0];
  assert.equal(findReplacementShop(store, order, AT).supplierId, 'replacement');
  store.catalogItems[1].basePriceMinor = 10001;
  assert.equal(findReplacementShop(store, order, AT), null);
  store.catalogItems[1].basePriceMinor = 10000;
  store.catalogItems[1].name = 'Other product';
  assert.equal(findReplacementShop(store, order, AT), null);
  store.catalogItems[1].name = 'Flyers';
  store.orderLineItemOptions = [{ orderLineItemId: 'line', groupNameSnapshot: 'Paper', optionLabelSnapshot: 'Heavy' }];
  assert.equal(findReplacementShop(store, order, AT), null);
  store.orderLineItemOptions = [];
  order.declinedBy = ['replacement'];
  assert.equal(findReplacementShop(store, order, AT), null);
});

test('client acceptance reassigns jobs and artwork scope, keeps money and snapshots, restarts acceptance', async () => {
  const store = fixture(), order = store.orders[0];
  store.orderJobs = [{ id: 'job', orderId: order.id, supplierId: 'original', state: 'ready_for_dispatch' }];
  failShop(store);
  const before = structuredClone(store.orderLineItems);
  const response = await call(store, 'shop-recovery/accept', { recoveryId: order.shopRecovery.id });
  assert.equal(response.status, 200);
  assert.equal(order.supplierId, 'replacement');
  assert.equal(order.totalMinor, 11000);
  assert.equal(store.orderJobs[0].supplierId, 'replacement');
  assert.deepEqual(store.orderLineItems, before);
  assert.equal(order.shopAcceptance.status, 'pending');
  assert.equal(activePayoutHold(store, order), false);
  assert.equal((await call(store, 'shop-recovery/accept', { recoveryId: order.shopRecovery.id })).status, 200);
});

test('client refund choice opens full-refund case and holds work without claiming money was sent', async () => {
  const store = fixture(), order = store.orders[0]; failShop(store);
  const response = await call(store, 'shop-recovery/refund', { recoveryId: order.shopRecovery.id });
  assert.equal(response.status, 200);
  assert.equal(store.refundRequests.length, 1);
  assert.equal(store.refundRequests[0].status, 'requested');
  assert.equal(order.shopRecovery.refundRequestId, store.refundRequests[0].id);
  assert.equal(store.refundPayments.length, 0);
  await call(store, 'shop-recovery/refund', { recoveryId: order.shopRecovery.id });
  assert.equal(store.refundRequests.length, 1);
});

test('client projection keeps alternative identity, pickup, specs mapping and internal history private', () => {
  const store = fixture(), order = store.orders[0]; failShop(store);
  const view = publicOrderFor(order, { id: 'client', role: 'client' }, store);
  assert.equal(view.shopRecovery.canAccept, true);
  assert.equal(view.shopRecovery.proposal, undefined);
  assert.deepEqual(Object.keys(view.shopRecovery).sort(), ['canAccept', 'canRefund', 'createdAt', 'id', 'refundRequestId', 'replacement', 'status']);
  assert.deepEqual(Object.keys(view.shopRecovery.replacement), ['promiseBy']);
  assert.equal(view.shopFailureEvents, undefined);
});

test('stale or unrelated client cannot choose; supplier cancellation needs a reason', async () => {
  const store = fixture(); failShop(store);
  await assert.rejects(call(store, 'shop-recovery/accept', { recoveryId: 'old' }), { code: 'shop_recovery_stale' });
  await assert.rejects(call(store, 'shop-recovery/refund', {}, { id: 'other', role: 'client' }), { code: 'forbidden' });
  await assert.rejects(call(fixture(), 'shop-cancel', {}, { id: 'original', role: 'supplier' }), { code: 'shop_cancel_reason_required' });
});

test('expired or changed offers refresh with a conflict and never assign without fresh consent', async () => {
  const store = fixture(), order = store.orders[0]; failShop(store);
  order.shopRecovery.proposal.expiresAt = '2020-01-01T00:00:00.000Z';
  const response = await call(store, 'shop-recovery/accept', { recoveryId: order.shopRecovery.id });
  assert.equal(response.status, 409);
  assert.equal(response.mutated, true);
  assert.equal(response.body.error, 'shop_recovery_offer_changed');
  assert.equal(order.supplierId, 'original');
  assert.equal(order.shopRecovery.status, 'awaiting_client');
  assert.equal((await call(store, 'shop-recovery/accept', { recoveryId: order.shopRecovery.id })).status, 200);
});

test('ordinary refund intake during recovery also records the full-refund choice', async () => {
  const { routeRefunds } = await import('../src/refunds.js');
  const store = fixture(), order = store.orders[0]; failShop(store);
  const response = await routeRefunds({ req: { method: 'POST', headers: { 'idempotency-key': id('key') } },
    url: new URL('http://test/orders/order/refund-requests'), store, user: { id: 'client', role: 'client' },
    readBody: async () => ({ kind: 'cancellation', reason: 'Refund requested' }), now: () => AT, id, audit: () => {} });
  assert.equal(order.shopRecovery.refundRequestId, response.body.refund.id);
  assert.equal(order.shopRecovery.status, 'refund_requested');
});


for (const fulfillmentMode of ["delivery", "pickup"]) {
  test(`pre-match ${fulfillmentMode} recovery uses the chosen point and preserves charges`, async () => {
    const store = fixture(), order = store.orders[0];
    const dropoff = fulfillmentMode === "pickup" ? gridgoOfficePoint()
      : { lat: 7.2, lng: 125.7, label: "Recipient" };
    order.fulfillmentMode = fulfillmentMode;
    order.dropoff = fulfillmentMode === "pickup" ? null : { ...dropoff };
    order.requestFulfillment = { fulfillmentMode, dropoff };
    order.deliveryFeeMinor = fulfillmentMode === "pickup" ? 2500 : 8900;
    order.totalMinor += order.deliveryFeeMinor;
    order.payments.initial.amountMinor = order.totalMinor;
    order.paymentAllocations.push({ paymentCode: "initial", component: "delivery_pass_through", amountMinor: order.deliveryFeeMinor });
    if (fulfillmentMode === "pickup") {
      store.settings.hubPickup.feeMinor = 2500;
      order.hubPickup = publicHubPickup(store.settings);
      order.pickupFeeMinor = 2500;
      order.riderCommissionBps = 0;
    }
    store.clientPreferences = [{ userId: order.clientId, ranking: ["distance", "quality", "speed", "cost"] }];
    const snapshot = structuredClone({ requestFulfillment: order.requestFulfillment, hubPickup: order.hubPickup,
      pickupFeeMinor: order.pickupFeeMinor, deliveryFeeMinor: order.deliveryFeeMinor, totalMinor: order.totalMinor });
    failShop(store);
    assert.equal(order.shopRecovery.proposal.supplierId, "replacement");
    store.settings.hubPickup.feeMinor = 9000;
    const accepted = await call(store, "shop-recovery/accept", { recoveryId: order.shopRecovery.id });
    assert.equal(accepted.status, 200);
    assert.equal(order.supplierId, "replacement");
    assert.deepEqual({ requestFulfillment: order.requestFulfillment, hubPickup: order.hubPickup,
      pickupFeeMinor: order.pickupFeeMinor, deliveryFeeMinor: order.deliveryFeeMinor, totalMinor: order.totalMinor }, snapshot);
  });
}

for (const status of ['pending', 'failed']) test(`supplier recovery routes stay private while file check is ${status}`, async () => {
  const store = fixture(), order = store.orders[0];
  order.state = 'needs_qa';
  order.fileCheck = { status, requestedAt: AT };
  const user = { id: order.supplierId, role: 'supplier' };
  await assert.rejects(routeShopRecovery({ req: { method: 'GET' }, url: new URL('http://test/orders/order/shop-recovery'),
    store, user, readBody: async () => ({}), now: () => AT, id }), { code: 'forbidden' });
  await assert.rejects(call(store, 'decline', { reason: 'Cannot fulfil' }, user), { code: 'forbidden' });
  await assert.rejects(call(store, 'shop-cancel', { reason: 'Cannot fulfil' }, user), { code: 'forbidden' });
  assert.equal(order.shopAcceptance, undefined);
  assert.equal(store.notifications.length, 0);
  assert.equal(expireShopAcceptances(store, { at: '2026-10-06T00:00:00Z', createId: id }), false);
  assert.equal(order.shopAcceptance, undefined);
});

test('replacement matching uses the approved type and specs while a listing revision is pending', async () => {
  const { startListingReview } = await import('../src/catalog-review-state.js');
  const store = fixture();
  const item = store.catalogItems.find(row => row.supplierId === 'replacement');
  startListingReview(store, item);
  item.subcategoryCode = 'brochures';
  item.basePriceMinor = 90000;
  const replacement = findReplacementShop(store, store.orders[0], AT);
  assert.equal(replacement?.supplierId, 'replacement');
  item.approvedSnapshot = null;
  assert.equal(findReplacementShop(store, store.orders[0], AT), null);
});
