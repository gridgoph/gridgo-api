import test from "node:test";
import assert from "node:assert/strict";

import {
  OperationalError,
  calculateOrderMoney,
  confirmIssueWindow,
  createPaymentSchedule,
  createPayoutMilestones,
  defaultOperationalSettings,
  defaultProductionNudge,
  deliverySplit,
  expireIssueWindows,
  moneyReportingForOrder,
  publicOrderFor,
  PAYOUT_STAGES,
  releaseMilestone,
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

test("requires the client service-fee row visibility to be a JSON boolean when set", () => {
  assert.equal(defaultOperationalSettings().serviceFeeVisibleToClient, true);
  const { serviceFeeVisibleToClient: _omitted, ...withoutVisibility } = defaultOperationalSettings();
  assert.equal(validateOperationalSettings(withoutVisibility), true);
  for (const serviceFeeVisibleToClient of ["true", 1, null]) {
    expectDomainError(
      () => validateOperationalSettings({ ...defaultOperationalSettings(), serviceFeeVisibleToClient }),
      400,
      "invalid_service_fee_visibility",
    );
  }
  assert.equal(
    validateOperationalSettings({ ...defaultOperationalSettings(), serviceFeeVisibleToClient: false }),
    true,
  );
});

test("production reminders reject a zero wait, 31 days, 11 repeats, and a numeric string", () => {
  const base = defaultProductionNudge();
  for (const productionNudge of [
    { ...base, afterValue: 0 },
    { ...base, afterValue: 31, afterUnit: "days" },
    { ...base, maxCount: 11 },
    { ...base, afterValue: "4" },
    { ...base, enabled: "true" },
    { ...base, afterUnit: "weeks" },
    { ...base, afterValue: 3601, afterUnit: "seconds" },
    { ...base, repeatValue: 0, repeatUnit: "minutes" },
  ]) {
    expectDomainError(
      () => validateOperationalSettings({ ...defaultOperationalSettings(), productionNudge }),
      400,
      "invalid_production_nudge",
    );
  }
  assert.equal(
    validateOperationalSettings({ ...defaultOperationalSettings(), productionNudge: { ...base, afterValue: 2, afterUnit: "days", repeatValue: 12, repeatUnit: "hours", maxCount: 5 } }),
    true,
  );
  assert.equal(
    validateOperationalSettings({ ...defaultOperationalSettings(), productionNudge: { ...base, afterValue: 30, afterUnit: "seconds", repeatValue: 1, repeatUnit: "minutes" } }),
    true,
  );
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

test("publicOrderFor always sends a timeline array, even when the row never stored one", () => {
  const projected = publicOrderFor(
    { id: "ord-bare", clientId: "client-a", state: "production" },
    { id: "client-a", role: "client" },
  );
  assert.deepEqual(projected.timeline, []);
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
  assert.deepEqual(collected.pickup, {
    lat: 7.092287234449552,
    lng: 125.61651084538697,
    label: "GRIDGO Office",
  });

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

test("a physical-invoice request reaches only the client who asked and Operations", () => {
  const order = {
    id: "ord-paper",
    clientId: "client-a",
    supplierId: "supplier-a",
    riderId: "rider-a",
    state: "production",
    physicalInvoiceRequest: {
      contactPerson: "Ana Reyes",
      officeAddress: "7th floor, 12 J.P. Laurel Ave, Davao City",
      operatingHours: "Mon\u2013Fri 9am\u20135pm",
      requestedAt: AT,
      promisedDeliveryAt: "2026-09-21T02:00:00.000Z",
    },
  };

  for (const reader of [
    { id: "supplier-a", role: "supplier" },
    { id: "rider-a", role: "rider" },
    { id: "other-client", role: "client" },
  ]) {
    assert.equal(
      "physicalInvoiceRequest" in publicOrderFor(order, reader),
      false,
      `${reader.role} ${reader.id} must not read the client's office contact`,
    );
  }

  for (const reader of [
    { id: "client-a", role: "client" },
    { id: "ops-a", role: "ops_admin" },
    { id: "super-a", role: "super_admin" },
  ]) {
    const projected = publicOrderFor(order, reader).physicalInvoiceRequest;
    assert.equal(
      projected.officeAddress,
      "7th floor, 12 J.P. Laurel Ave, Davao City",
      `${reader.role} ${reader.id} must still read the request`,
    );
    assert.equal(
      projected.promisedDeliveryAt,
      "2026-09-21T02:00:00.000Z",
      `${reader.role} ${reader.id} must still read the promised delivery`,
    );
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
  // The first stage is printing at half the shop's own price, whatever share of
  // it the client happened to pay up front.
  assert.equal(supplierOrder.payoutMilestones[0].code, "printing");
  assert.equal(supplierOrder.payoutMilestones[0].amountMinor, 50_000);
  assert.equal(supplierOrder.supplierSettlement.collectedSupplierPrincipalMinor, 25_000);
  assert.equal(supplierOrder.supplierSettlement.protectedPaymentMinor, 25_000);
  assert.equal("reference" in supplierOrder.payments.initial, false);

  assert.equal(clientOrder.payments.initial.reference, "PRIVATE-GCASH-REFERENCE");

  const opsOrder = publicOrderFor(order, { id: "ops-a", role: "ops_admin" });
  assert.equal(opsOrder.supplierSubtotalMinor, 100_000);
  assert.equal(opsOrder.platformRevenue.collectedMinor, 10_000);
  assert.equal(opsOrder.payments.initial.reference, "PRIVATE-GCASH-REFERENCE");
  assert.deepEqual(moneyReportingForOrder(order).platformRevenue, {
    billedMinor: 10_375,
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
    billedMinor: 10_375,
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

test("four stages, summing to exactly what the shop is owed", () => {
  // A stray centavo in the shares would either shortchange the shop or have
  // GRIDGO pay out more than it holds, and both are silent.
  for (const supplierSubtotalMinor of [100_000, 99_999, 1, 7, 123_457]) {
    const money = plan({ supplierSubtotalMinor });
    const milestones = createPayoutMilestones(money);
    assert.deepEqual(milestones.map((m) => m.code), PAYOUT_STAGES.map((s) => s.code));
    assert.deepEqual(milestones.map((m) => m.sharePercent), [50, 15, 25, 10]);
    assert.equal(
      milestones.reduce((sum, m) => sum + m.amountMinor, 0),
      money.supplierPlatformPayoutMinor,
    );
    for (const milestone of milestones) assert.ok(milestone.amountMinor >= 0);
  }
});

test("nothing releases itself, and nothing releases without a photograph", () => {
  const money = plan({ supplierDownpaymentRateBps: 5_000 });
  const schedule = createPaymentSchedule(money);
  schedule.payments.initial.status = "confirmed";
  const order = {
    id: "ord-stages",
    fulfillmentMode: "delivery",
    state: "production",
    payoutHold: false,
    ...money,
    ...schedule,
    payoutMilestones: createPayoutMilestones(money),
  };
  const ops = { id: "user_ops", role: "ops_admin" };

  // The proof is the whole point of the release: a stage with nothing to look
  // at is refused rather than granted quietly.
  expectDomainError(() => releaseMilestone(order, "printing", ops, AT, { claims: [] }), 409, "pof_required");

  const attach = (code) => {
    order.payoutMilestones.find((m) => m.code === code).pofFileIds = [`file_${code}`];
  };
  for (const code of ["printing", "packaging_qc", "delivered", "retention"]) attach(code);

  // Each stage names work that has to have happened first.
  expectDomainError(() => releaseMilestone(order, "packaging_qc", ops, AT, { claims: [] }), 409, "milestone_not_reached");
  expectDomainError(() => releaseMilestone(order, "delivered", ops, AT, { claims: [] }), 409, "delivery_required");
  expectDomainError(() => releaseMilestone(order, "retention", ops, AT, { claims: [] }), 409, "issue_window_open");

  assert.equal(releaseMilestone(order, "printing", ops, AT, { claims: [] }).status, "released");

  order.state = "supplier_self_qc";
  order.payments.final_online.status = "confirmed";
  assert.equal(releaseMilestone(order, "packaging_qc", ops, AT, { claims: [] }).status, "released");
});

test("a stage is never released ahead of the money the client actually sent", () => {
  // The older four-stage code never checked this, which is how it could have
  // GRIDGO funding the gap out of its own pocket.
  const money = plan({ supplierDownpaymentRateBps: 5_000 });
  const schedule = createPaymentSchedule(money);
  schedule.payments.initial.status = "confirmed";
  const order = {
    id: "ord-collected",
    fulfillmentMode: "delivery",
    state: "issue_window_open",
    payoutHold: false,
    ...money,
    ...schedule,
    payoutMilestones: createPayoutMilestones(money),
  };
  const ops = { id: "user_ops", role: "ops_admin" };
  for (const milestone of order.payoutMilestones) milestone.pofFileIds = ["file_proof"];

  // 50 percent collected covers printing, and stops at packing.
  assert.equal(releaseMilestone(order, "printing", ops, AT, { claims: [] }).status, "released");
  expectDomainError(
    () => releaseMilestone(order, "packaging_qc", ops, AT, { claims: [] }),
    409,
    "supplier_principal_not_collected",
  );

  order.payments.final_online.status = "confirmed";
  for (const code of ["packaging_qc", "delivered"]) {
    assert.equal(releaseMilestone(order, code, ops, AT, { claims: [] }).status, "released");
  }

  // Retention still waits out the window, whatever has been collected.
  expectDomainError(() => releaseMilestone(order, "retention", ops, AT, { claims: [] }), 409, "issue_window_open");
  order.state = "completed";
  assert.equal(releaseMilestone(order, "retention", ops, AT, { claims: [] }).status, "released");

  assert.equal(
    order.payoutMilestones.reduce((sum, m) => sum + m.amountMinor, 0),
    money.supplierPlatformPayoutMinor,
  );
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

test("client confirmation closes the issue window now, the same way expiry would", () => {
  const money = plan();
  const milestones = createPayoutMilestones(money);
  for (const milestone of milestones) milestone.status = "released";
  const order = {
    id: "ord-fine",
    clientId: "client-a",
    state: "issue_window_open",
    payoutHold: false,
    issueWindowExpiresAt: "2026-08-11T12:00:00.000Z",
    payoutMilestones: milestones,
    timeline: [],
  };
  const store = { claims: [], issues: [], settings: defaultOperationalSettings(), orders: [order] };

  assert.equal(confirmIssueWindow(store, order, { id: "client-a", role: "client" }, AT), order);
  assert.equal(order.state, "completed");
  assert.equal(order.updatedAt, AT);
  assert.equal(order.timeline[0].by, "client-a");
  assert.match(order.timeline[0].note, /no problems/);
  assert.equal(order.payoutMilestones.every((milestone) => milestone.status === "released"), true);
  // Already closed: the clock has nothing left to do, and a second confirm is refused.
  assert.equal(expireIssueWindows(store, "2026-08-12T00:00:00.000Z"), false);
  expectDomainError(
    () => confirmIssueWindow(store, order, { id: "client-a", role: "client" }, AT),
    409,
    "issue_window_not_open",
  );
});

test("a client with a report open cannot call the job clean", () => {
  const order = {
    id: "ord-held",
    clientId: "client-a",
    state: "issue_window_open",
    payoutHold: true,
    issueWindowExpiresAt: "2026-08-11T12:00:00.000Z",
    payoutMilestones: [],
    timeline: [],
  };
  const store = {
    claims: [{ orderId: "ord-held", status: "payout_held" }],
    issues: [{ id: "iss-1", orderId: "ord-held", status: "open" }],
    orders: [order],
  };

  expectDomainError(
    () => confirmIssueWindow(store, order, { id: "client-a", role: "client" }, AT),
    409,
    "issue_open",
  );
  assert.equal(order.state, "issue_window_open");
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

test('expiry worker processes a bounded batch and repeats without double closing',()=>{
 const at='2026-09-08T01:00:00.000Z';const store={orders:Array.from({length:3},(_,i)=>({id:`bounded_${i}`,state:'issue_window_open',issueWindowExpiresAt:'2026-09-08T00:00:00.000Z',payoutHold:false,timeline:[],payoutMilestones:[]})),claims:[]};
 assert.equal(expireIssueWindows(store,at,{limit:2}),true);
 assert.equal(store.orders.filter(o=>o.state==='completed').length,2);
 assert.equal(expireIssueWindows(store,at,{limit:2}),true);
 assert.equal(store.orders.every(o=>o.timeline.length===1),true);
 assert.equal(expireIssueWindows(store,at,{limit:2}),false);
});


test("production items show every assigned line and options without payment evidence or prices", () => {
  const order = { id: "production-order", clientId: "client", supplierId: "supplier", riderId: "rider", state: "out_for_delivery", payments: { final_online: { status: "pending_confirmation", proofFileId: "receipt" } }, timeline: [] };
  const store = { orderLineItems: [1, 2].map((n) => ({ id: `line-${n}`, orderId: order.id, itemNameSnapshot: `Item ${n}`, quantity: n, pricingUnitSnapshot: "per_area", measurement: { width: 2000, height: 3000 }, structuredSpecSnapshot: { size: "2 × 3 ft", material: "Canvas", finish: "None", measureUnit: "ft", privateData: { reference: "secret" } }, artworkFileId: `art-${n}`, mockupFileId: `mock-${n}`, baseUnitPriceMinor: 900, sortOrder: n })), orderLineItemOptions: [{ orderLineItemId: "line-2", groupNameSnapshot: "Sides", optionLabelSnapshot: "Both", priceModifierMinor: 100 }] };
  for (const role of ["client", "supplier", "rider", "ops_admin"]) {
    const projected = publicOrderFor(order, { id: role, role }, store);
    assert.equal(projected.productionItems.length, 2);
    assert.deepEqual(projected.productionItems[0].measurement, { widthMilli: 2000, heightMilli: 3000, unit: "ft" });
    assert.deepEqual(projected.productionItems[1].options, [{ groupName: "Sides", label: "Both" }]);
    assert.deepEqual(projected.productionItems[1].structuredSpec, { size: "2 × 3 ft", material: "Canvas", finish: "None" });
    assert.equal(JSON.stringify(projected.productionItems).includes("Minor"), false);
    assert.equal(projected.payments.final_online.proofFileId, ["client", "ops_admin"].includes(role) ? "receipt" : undefined);
  }
  assert.deepEqual(publicOrderFor(order, { id: "unassigned", role: "rider" }, store).productionItems, []);
  assert.equal(order.payments.final_online.proofFileId, "receipt");
});


test("production line visibility follows jobs ahead of legacy primary party ids", () => {
  const order = { id: "mixed", clientId: "client", supplierId: "supplier-a", riderId: "rider-a", timeline: [] };
  const store = {
    orderJobs: ["a", "b"].map((key) => ({ id: `job-${key}`, orderId: order.id, supplierId: `supplier-${key}`, riderId: `rider-${key}` })),
    orderLineItems: ["a", "b"].map((key) => ({ id: `line-${key}`, orderId: order.id, jobId: `job-${key}`, quantity: 1 })),
  };
  for (const role of ["supplier", "rider"]) for (const key of ["a", "b"]) {
    assert.deepEqual(publicOrderFor(order, { role, id: `${role}-${key}` }, store).productionItems.map((line) => line.id), [`line-${key}`]);
  }
  assert.equal(publicOrderFor(order, { role: "client", id: "client" }, store).productionItems.length, 2);
});

test("delivery split snapshots the rider rate and rounds half-up with an exact remainder", () => {
  for (const [feeMinor, rate, payout, share] of [
    [2500, 8500, 2125, 375], [10, 8500, 9, 1], [3, 8500, 3, 0],
    [0, 8500, 0, 0], [99, 0, 0, 99], [99, 10000, 99, 0],
  ]) {
    const settings = { ...defaultOperationalSettings(), riderCommissionBps: rate,
      deliveryFeeBands: [{ maxDistanceMeters: null, feeMinor }] };
    const money = plan({ settings });
    settings.riderCommissionBps = 1000;
    assert.equal(money.riderCommissionBps, rate);
    assert.equal(money.riderPayoutMinor, payout);
    assert.equal(money.platformDeliveryShareMinor, share);
    assert.equal(money.riderPayoutMinor + money.platformDeliveryShareMinor, feeMinor);
  }
  assert.equal(plan().riderCommissionBps, 8500);
});

test("rider commission setting rejects coerced and out-of-range rates", () => {
  for (const riderCommissionBps of [null, "8500", -1, 10001, 85.5, true]) {
    expectDomainError(() => validateOperationalSettings({ ...defaultOperationalSettings(), riderCommissionBps }),
      400, "invalid_rider_commission_rate");
  }
});

test("dispatch and ops expose delivery earnings while client and supplier omit the split", () => {
  const order = { id: "split", clientId: "client", supplierId: "supplier", ...plan() };
  for (const role of ["rider", "ops_admin", "super_admin"]) {
    const projected = publicOrderFor(order, { id: role, role });
    assert.equal(projected.riderPayoutMinor, 2125);
    assert.equal(projected.platformDeliveryShareMinor, 375);
    assert.equal(projected.riderCommissionBps, 8500);
  }
  for (const role of ["client", "supplier"]) {
    const projected = publicOrderFor(order, { id: role, role });
    assert.equal(projected.riderPayoutMinor, undefined);
    assert.equal(projected.platformDeliveryShareMinor, undefined);
    assert.equal(projected.riderCommissionBps, undefined);
    assert.equal(projected.deliveryFeeMinor, 2500);
  }
});

test("finance counts GRIDGO delivery revenue only from confirmed collection", () => {
  const order = { ...plan(), ...createPaymentSchedule(plan()), commercialCommittedAt: AT, state: "delivered" };
  assert.equal(moneyReportingForOrder(order).platformRevenue.billedMinor, 10375);
  assert.equal(moneyReportingForOrder(order).platformRevenue.collectedMinor, 0);
  order.payments.final_online.status = "confirmed";
  assert.equal(moneyReportingForOrder(order).platformRevenue.collectedMinor, 375);
  assert.equal(moneyReportingForOrder(order).platformRevenue.recognizedMinor, 375);
  assert.equal(moneyReportingForOrder(order).deliverySettlement.riderPayoutMinor, 2125);
  // The 75/25 plan collects delivery in both installments. Round cumulatively:
  // 8 paid centavos at 85% -> 7 rider, 1 platform; all 10 -> 9 rider, 1 platform.
  Object.assign(order, { deliveryFeeMinor: 10, riderCommissionBps: 8500, paymentAllocations: [
    { paymentCode: "initial", component: "delivery_pass_through", amountMinor: 8 },
    { paymentCode: "final_online", component: "delivery_pass_through", amountMinor: 2 },
  ] });
  order.payments.initial.status = "confirmed";
  order.payments.final_online.status = "not_submitted";
  assert.equal(moneyReportingForOrder(order).deliverySettlement.platformCollectedMinor, 1);
  order.payments.final_online.status = "confirmed";
  const full = moneyReportingForOrder(order).deliverySettlement;
  assert.equal(full.platformCollectedMinor, 1);
  assert.equal(full.riderCollectedMinor, 9);
});

test("delivery split stays exact at the largest API-safe amount", () => {
  assert.deepEqual(deliverySplit(Number.MAX_SAFE_INTEGER, 8500), {
    riderCommissionBps: 8500, riderPayoutMinor: 7656119366529842, platformDeliveryShareMinor: 1351079888211149,
  });
});


test("finance includes the final service-fee allocation of a 75/25 checkout", () => {
  const order = { ...plan(), commercialCommittedAt: AT, state: "delivered",
    payments: { initial: { status: "confirmed" }, final_online: { status: "not_submitted" } },
    paymentAllocations: [
      { paymentCode: "initial", component: "service_fee", amountMinor: 7500 },
      { paymentCode: "final_online", component: "service_fee", amountMinor: 2500 },
    ],
  };
  assert.equal(moneyReportingForOrder(order).platformRevenue.collectedMinor, 7500);
  order.payments.final_online.status = "confirmed";
  assert.equal(moneyReportingForOrder(order).platformRevenue.collectedMinor, 10000);
  assert.equal(moneyReportingForOrder(order).platformRevenue.recognizedMinor, 10000);
});
