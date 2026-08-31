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
  releaseEligibleSupplierPayouts,
  roundBps,
  validateOperationalSettings,
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

test("requires service-fee settings to use an actual integer", () => {
  for (const serviceFeeRateBps of ["1000", "", null]) {
    expectDomainError(
      () => validateOperationalSettings({ ...defaultOperationalSettings(), serviceFeeRateBps }),
      400,
      "invalid_service_fee_rate",
    );
  }
});

test("requires delivery fee settings to use actual safe integers", () => {
  const settings = defaultOperationalSettings();
  for (const feeMinor of ["2500", "", null]) {
    expectDomainError(
      () => validateOperationalSettings({
        ...settings,
        deliveryFeeBands: [{ maxDistanceMeters: null, feeMinor }],
      }),
      400,
      "invalid_money",
    );
  }
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

test("a client collects at GRIDGO's office and is never given the shop's address", () => {
  const shop = { lat: 7.064, lng: 125.6085, label: "Lovis Printshop · Bajada, Davao City" };
  const base = {
    id: "ord-pickup",
    clientId: "client-a",
    supplierId: "supplier-a",
    state: "production",
    pickup: { ...shop },
    dropoff: null,
    payments: {},
  };

  // Collecting: one pin, and it is GRIDGO's counter. A rider brings the job
  // there; the client never goes to the press.
  const collected = publicOrderFor({ ...base, fulfillmentMode: "pickup" }, { id: "client-a", role: "client" });
  assert.deepEqual(collected.pickup, { lat: 7.13267, lng: 125.611265, label: "GRIDGO Office" });

  // Delivered: the client watches the rider and their own address. The shop's
  // coordinates are not theirs to have, so no origin is projected at all.
  const delivered = publicOrderFor(
    { ...base, fulfillmentMode: "delivery", dropoff: { lat: 7.076, lng: 125.615, label: "Talomo" } },
    { id: "client-a", role: "client" },
  );
  assert.equal("pickup" in delivered, false);

  // Production is untouched: whoever actually drives there still gets the shop.
  for (const reader of [{ id: "rider-a", role: "rider" }, { id: "supplier-a", role: "supplier" }, { id: "ops-a", role: "ops_admin" }]) {
    const projected = publicOrderFor({ ...base, fulfillmentMode: "pickup" }, reader);
    assert.deepEqual(projected.pickup, shop, `${reader.role} keeps the shop pickup`);
  }
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
    payoutMilestones: createPayoutMilestones(money),
    acceptedQuote: {
      payments: structuredClone(schedule.payments),
      paymentTerms: { deliveryDownpaymentRateBps: 2_500 },
      supplierDownpaymentRateBps: 2_500,
    },
    quoteHistory: [{
      payments: structuredClone(schedule.payments),
      paymentTerms: { deliveryDownpaymentRateBps: 5_000 },
      supplierDownpaymentRateBps: 5_000,
    }],
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
  assert.equal(supplierOrder.payoutMilestones[0].amountMinor, 25_000);
  assert.equal(supplierOrder.supplierSettlement.collectedSupplierPrincipalMinor, 25_000);
  assert.equal(supplierOrder.supplierSettlement.protectedPaymentMinor, 25_000);
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
    adjustedMinor: 0,
    refundedMinor: 0,
  });
  const adjusted = structuredClone(order);
  adjusted.state = "delivered";
  adjusted.revenueAdjustments = [
    { kind: "adjustment", amountMinor: -1_000 },
    { kind: "refund", amountMinor: -2_000 },
  ];
  assert.deepEqual(moneyReportingForOrder(adjusted).platformRevenue, {
    billedMinor: 10_000,
    collectedMinor: 10_000,
    recognizedMinor: 7_000,
    adjustedMinor: -1_000,
    refundedMinor: -2_000,
  });

  const riderOrder = publicOrderFor(order, { id: "rider-a", role: "rider" });
  assert.equal("supplierDownpaymentRateBps" in riderOrder, false);
  assert.equal("initialSupplierPrincipalMinor" in riderOrder, false);
  assert.equal("supplierRemainderMinor" in riderOrder, false);
  assert.equal("payoutMilestones" in riderOrder, false);
  assert.equal("quoteHistory" in riderOrder, false);
  assert.equal("componentLines" in riderOrder.payments.initial, false);
  assert.equal("supplierPrincipalRateBps" in riderOrder.payments.initial, false);
  assert.equal("componentLines" in riderOrder.acceptedQuote.payments.initial, false);
  assert.equal("supplierPrincipalRateBps" in riderOrder.acceptedQuote.payments.initial, false);
  assert.equal("paymentTerms" in riderOrder.acceptedQuote, false);
  assert.equal("supplierDownpaymentRateBps" in riderOrder.acceptedQuote, false);

  const pickupMoney = plan({ fulfillmentMode: "pickup", paymentPlan: "pickup_downpayment_store" });
  const pickupSchedule = createPaymentSchedule(pickupMoney);
  pickupSchedule.payments.initial.status = "confirmed";
  const pickupAtStore = {
    ...order,
    ...pickupMoney,
    ...pickupSchedule,
    state: "delivered",
    payoutMilestones: createPayoutMilestones(pickupMoney),
  };
  assert.deepEqual(moneyReportingForOrder(pickupAtStore).supplierSettlement, {
    orderPriceMinor: 100_000,
    dueAtStoreMinor: 75_000,
    receivedAtStoreMinor: 0,
    collectedSupplierPrincipalMinor: 25_000,
    protectedPaymentMinor: 25_000,
    gridgoDeductionsMinor: 0,
    totalSupplierEarningsMinor: 100_000,
    supplierReleasedMinor: 0,
    supplierOutstandingMinor: 100_000,
  });
});

test("uses 0, 25, and 50 percent supplier payout shapes", () => {
  assert.deepEqual(
    [0, 2_500, 5_000].map((supplierDownpaymentRateBps) => {
      const money = plan({ supplierDownpaymentRateBps });
      return createPayoutMilestones(money).map(({ code, sharePercent, amountMinor }) => ({
        code,
        sharePercent,
        amountMinor,
      }));
    }),
    [
      [{ code: "completion", sharePercent: 100, amountMinor: 100_000 }],
      [
        { code: "initial", sharePercent: 25, amountMinor: 25_000 },
        { code: "completion", sharePercent: 75, amountMinor: 75_000 },
      ],
      [
        { code: "initial", sharePercent: 50, amountMinor: 50_000 },
        { code: "completion", sharePercent: 50, amountMinor: 50_000 },
      ],
    ],
  );
});

test("caps automatic supplier payouts at confirmed collected principal", () => {
  for (const supplierDownpaymentRateBps of [0, 2_500, 5_000]) {
    const money = plan({ supplierDownpaymentRateBps });
    const schedule = createPaymentSchedule(money);
    schedule.payments.initial.status = "confirmed";
    const order = {
      id: `ord-${supplierDownpaymentRateBps}`,
      fulfillmentMode: "delivery",
      state: "production",
      payoutHold: false,
      ...money,
      ...schedule,
      payoutMilestones: createPayoutMilestones(money),
    };
    const initialReleases = releaseEligibleSupplierPayouts(
      order,
      { id: "system", role: "system" },
      AT,
      { claims: [] },
    );
    assert.deepEqual(initialReleases.map((milestone) => milestone.amountMinor),
      supplierDownpaymentRateBps === 0 ? [] : [money.initialSupplierPrincipalMinor]);

    order.state = "delivered";
    expectDomainError(
      () => releaseEligibleSupplierPayouts(order, { id: "system", role: "system" }, AT, { claims: [] }),
      409,
      "supplier_principal_not_collected",
    );
    order.payments.final_online.status = "confirmed";
    const completionReleases = releaseEligibleSupplierPayouts(
      order,
      { id: "system", role: "system" },
      AT,
      { claims: [] },
    );
    assert.deepEqual(completionReleases.map((milestone) => milestone.amountMinor), [money.supplierRemainderMinor]);
    assert.equal(
      order.payoutMilestones.reduce(
        (sum, milestone) => sum + (milestone.status === "released" ? milestone.amountMinor : 0),
        0,
      ),
      money.supplierSubtotalMinor,
    );
  }
});

test("elapsed global issue window completes an already settled order", () => {
  const money = plan();
  const milestones = createPayoutMilestones(money);
  for (const milestone of milestones) milestone.status = "released";
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
  assert.equal(store.orders[0].payoutMilestones.every((milestone) => milestone.status === "released"), true);
  assert.equal(expireIssueWindows(store, AT), false);
});

test("publicOrderFor fills specification from checkout line items", () => {
  const order = {
    id: "ord_line",
    clientId: "client-a",
    supplierId: null,
    state: "needs_qa",
    dropoff: { lat: 7.19, lng: 125.46, label: "12 Bara, Barangay, Davao City" },
    timeline: [],
  };
  const store = {
    orderLineItems: [
      {
        id: "cline_1",
        orderId: "ord_line",
        itemNameSnapshot: "Flyers",
        quantity: 2,
        pricingUnitSnapshot: "per_package",
        packageQtySnapshot: 100,
        structuredSpecSnapshot: { size: "A4", material: "matte_150gsm", finish: "lamination" },
        artworkFileId: "file_art",
        mockupFileId: "file_mock",
        sortOrder: 0,
      },
    ],
    files: [
      { fileId: "file_art", originalFilename: "flyer.jpeg", purpose: "artwork", state: "ready" },
      { fileId: "file_mock", originalFilename: "mockup.png", purpose: "mockup", state: "ready" },
    ],
  };
  const projected = publicOrderFor(order, { id: "client-a", role: "client" }, store);
  assert.equal(projected.title, "Flyers");
  assert.equal(projected.quantity, 2);
  assert.equal(projected.unit, "pack100");
  assert.equal(projected.size, "A4");
  assert.equal(projected.material, "matte_150gsm");
  assert.equal(projected.finish, "lamination");
  assert.equal(projected.address, "12 Bara, Barangay, Davao City");
  assert.deepEqual(projected.artworkFileIds, ["file_art"]);
  assert.deepEqual(projected.mockupFileIds, ["file_mock"]);
  assert.equal(projected.artworkName, "flyer.jpeg");
  assert.equal("quantity" in order, false);
});
