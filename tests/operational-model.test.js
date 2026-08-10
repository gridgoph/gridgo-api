import test from "node:test";
import assert from "node:assert/strict";

import {
  OperationalError,
  backfillOperationalModel,
  calculateFinalPrice,
  createPayoutMilestones,
  defaultOperationalSettings,
  expireIssueWindows,
  publicOrderFor,
  releaseMilestone,
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

test("calculates the captain's exact commission, subtotal, delivery, total, and 75/25 split", () => {
  const result = calculateFinalPrice({
    supplierPriceMinor: 100_000,
    pickup: { lat: 7.0731, lng: 125.6128 },
    dropoff: { lat: 7.0731, lng: 125.6128 },
    settings: defaultOperationalSettings(),
  });

  assert.deepEqual(result, {
    supplierPriceMinor: 100_000,
    commissionRatePercent: 10,
    commissionMinor: 10_000,
    subtotalMinor: 110_000,
    deliveryDistanceMeters: 0,
    deliveryFeeMinor: 2_500,
    totalMinor: 112_500,
    downpaymentMinor: 84_375,
    balanceMinor: 28_125,
  });
});

test("uses the provisional configurable distance boundaries exactly", () => {
  const settings = defaultOperationalSettings();
  assert.equal(calculateFinalPrice({ supplierPriceMinor: 1_000, distanceMeters: 4_999, settings }).deliveryFeeMinor, 2_500);
  assert.equal(calculateFinalPrice({ supplierPriceMinor: 1_000, distanceMeters: 5_000, settings }).deliveryFeeMinor, 5_000);
  assert.equal(calculateFinalPrice({ supplierPriceMinor: 1_000, distanceMeters: 10_000, settings }).deliveryFeeMinor, 5_000);
  assert.equal(calculateFinalPrice({ supplierPriceMinor: 1_000, distanceMeters: 10_001, settings }).deliveryFeeMinor, 7_500);
});

test("client order projection cannot expose supplier price, commission, or milestone amounts", () => {
  const order = {
    id: "ord-a",
    clientId: "client-a",
    supplierId: "supplier-a",
    supplierPriceMinor: 100_000,
    commissionRatePercent: 10,
    commissionMinor: 10_000,
    subtotalMinor: 110_000,
    deliveryFeeMinor: 2_500,
    totalMinor: 112_500,
    payments: {
      downpayment: { amountMinor: 84_375, status: "confirmed", reference: "PRIVATE-GCASH-REFERENCE" },
      balance: { amountMinor: 28_125, status: "not_submitted", reference: null },
    },
    payoutMilestones: createPayoutMilestones(100_000),
  };

  const clientOrder = publicOrderFor(order, { id: "client-a", role: "client" });
  const serialized = JSON.stringify(clientOrder);
  assert.equal(serialized.includes("supplierPriceMinor"), false);
  assert.equal(serialized.includes("commissionMinor"), false);
  assert.equal(serialized.includes("commissionRatePercent"), false);
  assert.equal(clientOrder.payoutMilestones.some((milestone) => "amountMinor" in milestone), false);
  assert.equal(clientOrder.payments.downpayment.amountMinor, 84_375);
  assert.equal(clientOrder.subtotalMinor, 110_000);
  assert.equal(clientOrder.deliveryFeeMinor, 2_500);
  assert.equal(clientOrder.totalMinor, 112_500);

  const supplierOrder = publicOrderFor(order, { id: "supplier-a", role: "supplier" });
  assert.equal(supplierOrder.supplierPriceMinor, 100_000);
  assert.equal("commissionMinor" in supplierOrder, false);
  assert.equal(supplierOrder.payoutMilestones[0].amountMinor, 50_000);
  assert.equal("reference" in supplierOrder.payments.downpayment, false);

  assert.equal(clientOrder.payments.downpayment.reference, "PRIVATE-GCASH-REFERENCE");

  const opsOrder = publicOrderFor(order, { id: "ops-a", role: "ops_admin" });
  assert.equal(opsOrder.supplierPriceMinor, 100_000);
  assert.equal(opsOrder.commissionMinor, 10_000);
  assert.equal(opsOrder.payments.downpayment.reference, "PRIVATE-GCASH-REFERENCE");
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

test("v2 backfill migrates supplier proof and COD coherently and is byte-idempotent", () => {
  const untouched = {
    users: [{ id: "client-a", role: "client" }, { id: "supplier-a", role: "supplier" }],
    sessions: { token: { userId: "client-a" } },
    files: [{ fileId: "legacy-proof", purpose: "proof", state: "ready" }],
    credits: { "client-a": { balanceMinor: 123, ledger: [] } },
    claims: [],
    issues: [],
    locationPings: [{ id: "ping-a" }],
    proofs: [{ id: "proof-a", kind: "cod" }],
  };
  const store = {
    ...structuredClone(untouched),
    zones: [{ id: "zone-a", code: "davao_central", deliveryFeeMinor: 15_000, active: true }],
    notifications: [],
    orders: [
      {
        id: "ord-legacy",
        clientId: "client-a",
        supplierId: "supplier-a",
        state: "supplier_proof_review",
        totalMinor: 110_000,
        deliveryFeeMinor: 2_500,
        paymentMethod: "COD",
        paymentStatus: "authorized",
        proofFileIds: ["legacy-proof"],
        timeline: [],
        createdAt: "2026-08-09T00:00:00.000Z",
      },
    ],
  };

  assert.equal(backfillOperationalModel(store, AT), true);
  const order = store.orders[0];
  assert.equal(order.state, "awaiting_downpayment");
  assert.equal(order.subtotalMinor, 110_000);
  assert.equal(order.supplierPriceMinor + order.commissionMinor, 110_000);
  assert.equal(order.totalMinor, 112_500);
  assert.equal(order.paymentMethod, "digital_manual_legacy");
  assert.equal("codEligible" in order, false);
  assert.equal(order.payments.downpayment.status, "legacy_confirmed");
  assert.equal(order.payments.balance.status, "not_submitted");
  assert.equal(order.assignmentNotificationId, store.notifications[0].id);
  assert.deepEqual(order.proofFileIds, ["legacy-proof"]);
  assert.equal(Object.hasOwn(store.zones[0], "deliveryFeeMinor"), false);
  for (const key of Object.keys(untouched)) assert.deepEqual(store[key], untouched[key], `${key} changed`);

  const afterFirst = JSON.stringify(store);
  assert.equal(backfillOperationalModel(store, AT), false);
  assert.equal(JSON.stringify(store), afterFirst);
});

test("legacy issue-window migration never releases retention before the window expires", () => {
  const store = {
    users: [],
    notifications: [],
    claims: [{ id: "claim-a", orderId: "ord-window", status: "payout_held" }],
    orders: [
      {
        id: "ord-window",
        clientId: "client-a",
        supplierId: "supplier-a",
        state: "issue_window_open",
        totalMinor: 110_000,
        deliveryFeeMinor: 2_500,
        payoutHold: true,
        timeline: [{ at: "2026-08-10T11:00:00.000Z", state: "issue_window_open", by: "system", note: "legacy" }],
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-10T11:00:00.000Z",
      },
    ],
  };

  backfillOperationalModel(store, AT);
  const delivered = store.orders[0].payoutMilestones.find((item) => item.code === "delivered");
  const retention = store.orders[0].payoutMilestones.find((item) => item.code === "retention");
  assert.equal(delivered.status, "released");
  assert.equal(retention.status, "pending_pof");
});
