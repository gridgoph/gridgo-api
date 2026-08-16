import test from "node:test";
import assert from "node:assert/strict";

import {
  OperationalError,
  calculateOrderMoney,
  createPaymentSchedule,
  createPayoutMilestones,
  defaultOperationalSettings,
  expireIssueWindows,
  moneyReportingForOrder,
  publicOrderFor,
  releaseMilestone,
  roundBps,
} from "../src/operational-model.js";

const AT = "2026-08-10T12:00:00.000Z";

function expectDomainError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof OperationalError, true);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.match(error.message, /[A-Za-z]/);
    return true;
  });
}

test("uses BigInt half-up basis-point rounding including the 99,999 remainder vector", () => {
  assert.equal(roundBps(100_000, 1_000), 10_000);
  assert.equal(roundBps(99_999, 1_000), 10_000);
  assert.equal(roundBps(99_999, 2_500), 25_000);
  assert.equal(99_999 - roundBps(99_999, 2_500), 74_999);
  assert.equal(roundBps(Number.MAX_SAFE_INTEGER, 10_000), Number.MAX_SAFE_INTEGER);
});

function plan(overrides = {}) {
  return calculateOrderMoney({
    supplierSubtotalMinor: 100_000,
    fulfillmentMode: "delivery",
    paymentPlan: "delivery_online",
    supplierDownpaymentRateBps: 2_500,
    pickup: { lat: 7.0731, lng: 125.6128 },
    dropoff: { lat: 7.0731, lng: 125.6128 },
    settings: defaultOperationalSettings(),
    ...overrides,
  });
}

test("allocates delivery, pickup full-online, and pickup-at-store plans exactly", () => {
  const delivery = plan();
  assert.deepEqual(
    {
      fee: delivery.serviceFeeMinor,
      principalNow: delivery.initialSupplierPrincipalMinor,
      initial: delivery.initialOnlineMinor,
      later: delivery.finalOnlineMinor,
      store: delivery.directStoreDueMinor,
      total: delivery.totalMinor,
      supplierPayout: delivery.supplierPlatformPayoutMinor,
    },
    { fee: 10_000, principalNow: 25_000, initial: 35_000, later: 77_500, store: 0, total: 112_500, supplierPayout: 100_000 },
  );

  const fullOnline = plan({ fulfillmentMode: "pickup", paymentPlan: "pickup_full_online", supplierDownpaymentRateBps: 10_000 });
  assert.deepEqual(
    [fullOnline.initialOnlineMinor, fullOnline.finalOnlineMinor, fullOnline.directStoreDueMinor, fullOnline.totalMinor],
    [110_000, 0, 0, 110_000],
  );

  const atStore = plan({ fulfillmentMode: "pickup", paymentPlan: "pickup_downpayment_store" });
  assert.deepEqual(
    [atStore.initialOnlineMinor, atStore.finalOnlineMinor, atStore.directStoreDueMinor, atStore.totalMinor, atStore.supplierPlatformPayoutMinor],
    [35_000, 0, 75_000, 110_000, 25_000],
  );

  const schedule = createPaymentSchedule(delivery);
  assert.deepEqual(Object.keys(schedule.payments), ["initial", "final_online"]);
  assert.deepEqual(schedule.paymentAllocations, [
    { paymentCode: "initial", component: "supplier_principal", amountMinor: 25_000 },
    { paymentCode: "initial", component: "service_fee", amountMinor: 10_000 },
    { paymentCode: "final_online", component: "supplier_principal", amountMinor: 75_000 },
    { paymentCode: "final_online", component: "delivery_pass_through", amountMinor: 2_500 },
  ]);
});

test("uses the provisional configurable distance boundaries exactly", () => {
  const settings = defaultOperationalSettings();
  assert.equal(plan({ supplierSubtotalMinor: 1_000, distanceMeters: 4_999, settings }).deliveryFeeMinor, 2_500);
  assert.equal(plan({ supplierSubtotalMinor: 1_000, distanceMeters: 5_000, settings }).deliveryFeeMinor, 5_000);
  assert.equal(plan({ supplierSubtotalMinor: 1_000, distanceMeters: 10_000, settings }).deliveryFeeMinor, 5_000);
  assert.equal(plan({ supplierSubtotalMinor: 1_000, distanceMeters: 10_001, settings }).deliveryFeeMinor, 7_500);
});

test("role-aware projections expose client fee lines and truthful supplier settlement", () => {
  const money = plan();
  const schedule = createPaymentSchedule(money);
  const order = {
    id: "ord-a",
    clientId: "client-a",
    supplierId: "supplier-a",
    state: "production",
    commercialCommittedAt: AT,
    ...money,
    ...schedule,
    payoutMilestones: createPayoutMilestones(100_000),
  };
  order.payments.initial.status = "confirmed";
  order.payments.initial.reference = "PRIVATE-GCASH-REFERENCE";

  const clientOrder = publicOrderFor(order, { id: "client-a", role: "client" });
  assert.equal("supplierSubtotalMinor" in clientOrder, false);
  assert.equal(clientOrder.payoutMilestones.some((milestone) => "amountMinor" in milestone), false);
  assert.equal(clientOrder.payments.initial.amountMinor, 35_000);
  assert.equal(clientOrder.subtotalMinor, 100_000);
  assert.equal(clientOrder.serviceFeeMinor, 10_000);
  assert.equal(clientOrder.deliveryFeeMinor, 2_500);
  assert.equal(clientOrder.totalMinor, 112_500);

  const supplierOrder = publicOrderFor(order, { id: "supplier-a", role: "supplier" });
  assert.equal(supplierOrder.supplierSubtotalMinor, 100_000);
  assert.equal(supplierOrder.supplierSettlement.gridgoDeductionsMinor, 0);
  assert.equal(supplierOrder.supplierSettlement.totalSupplierEarningsMinor, 100_000);
  assert.equal(supplierOrder.payoutMilestones[0].amountMinor, 50_000);
  assert.equal("reference" in supplierOrder.payments.initial, false);

  assert.equal(clientOrder.payments.initial.reference, "PRIVATE-GCASH-REFERENCE");

  const opsOrder = publicOrderFor(order, { id: "ops-a", role: "ops_admin" });
  assert.equal(opsOrder.supplierSubtotalMinor, 100_000);
  assert.equal(opsOrder.platformRevenue.collectedMinor, 10_000);
  assert.equal(opsOrder.payments.initial.reference, "PRIVATE-GCASH-REFERENCE");
  assert.deepEqual(moneyReportingForOrder(order).platformRevenue, {
    billedMinor: 10_000,
    collectedMinor: 10_000,
    recognizedMinor: 0,
    refundedAdjustedMinor: 0,
  });
  const adjusted = structuredClone(order);
  adjusted.state = "delivered";
  adjusted.revenueAdjustments = [{ amountMinor: -2_000 }];
  assert.deepEqual(moneyReportingForOrder(adjusted).platformRevenue, {
    billedMinor: 10_000,
    collectedMinor: 10_000,
    recognizedMinor: 8_000,
    refundedAdjustedMinor: -2_000,
  });

  const pickupAtStore = {
    ...order,
    ...plan({ fulfillmentMode: "pickup", paymentPlan: "pickup_downpayment_store" }),
    state: "delivered",
    payoutMilestones: createPayoutMilestones(25_000, "pickup"),
  };
  assert.deepEqual(moneyReportingForOrder(pickupAtStore).supplierSettlement, {
    orderPriceMinor: 100_000,
    dueAtStoreMinor: 75_000,
    receivedAtStoreMinor: 0,
    protectedPaymentMinor: 25_000,
    gridgoDeductionsMinor: 0,
    totalSupplierEarningsMinor: 100_000,
    supplierReleasedMinor: 0,
    supplierOutstandingMinor: 100_000,
  });
});

test("milestone shares sum exactly to supplier earnings and release is gated on POF", () => {
  const milestones = createPayoutMilestones(100_001);
  assert.deepEqual(
    milestones.map(({ code, sharePercent, amountMinor }) => ({ code, sharePercent, amountMinor })),
    [
      { code: "printing", sharePercent: 50, amountMinor: 50_001 },
      { code: "packaging_qc", sharePercent: 15, amountMinor: 15_000 },
      { code: "delivered", sharePercent: 25, amountMinor: 25_000 },
      { code: "retention", sharePercent: 10, amountMinor: 10_000 },
    ],
  );
  assert.equal(milestones.reduce((sum, item) => sum + item.amountMinor, 0), 100_001);

  const order = { id: "ord-a", state: "production", payoutHold: false, payoutMilestones: milestones };
  expectDomainError(() => releaseMilestone(order, "printing", { id: "ops-a", role: "ops_admin" }, AT), 409, "pof_required");
  milestones[0].pofFileIds.push("file-printing");
  const released = releaseMilestone(order, "printing", { id: "ops-a", role: "ops_admin" }, AT);
  assert.equal(released.status, "released");
  assert.equal(released.releasedAt, AT);
  assert.equal(released.releasedBy, "ops-a");
  milestones[1].pofFileIds.push("file-packaging");
  expectDomainError(
    () => releaseMilestone(order, "packaging_qc", { id: "ops-a", role: "ops_admin" }, AT),
    409,
    "milestone_not_reached",
  );
});

test("elapsed global issue window completes the order and releases retained earnings", () => {
  const milestones = createPayoutMilestones(100_000);
  for (const milestone of milestones.slice(0, 3)) {
    milestone.pofFileIds.push(`file-${milestone.code}`);
    milestone.status = "released";
  }
  milestones[3].pofFileIds.push("file-delivered");
  const store = {
    claims: [],
    settings: defaultOperationalSettings(),
    orders: [
      {
        id: "ord-expired",
        state: "issue_window_open",
        payoutHold: false,
        issueWindowExpiresAt: "2026-08-10T11:59:59.000Z",
        payoutMilestones: milestones,
        timeline: [],
      },
    ],
  };

  assert.equal(expireIssueWindows(store, AT), true);
  assert.equal(store.orders[0].state, "completed");
  assert.equal(store.orders[0].payoutMilestones[3].status, "released");
  assert.equal(store.orders[0].payoutMilestones[3].releasedBy, "system");
  assert.equal(expireIssueWindows(store, AT), false);
});
