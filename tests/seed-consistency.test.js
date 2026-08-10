import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { PICKUP_CHECK_CODES, backfillOperationalModel } from "../src/operational-model.js";

function freshSeed() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gridgo-seed-consistency-"));
  const storePath = path.join(tempDir, "store.json");
  const result = spawnSync(process.execPath, ["src/seed.js", "--reset"], {
    cwd: path.resolve("."),
    env: { ...process.env, STORE_PATH: storePath },
    encoding: "utf8",
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(fs.readFileSync(storePath, "utf8"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function configuredBandFee(order, settings) {
  const band = settings.deliveryFeeBands.find(
    ({ maxDistanceMeters }) => maxDistanceMeters === null || order.deliveryDistanceMeters <= maxDistanceMeters,
  );
  assert.ok(band, `${order.id} has no configured delivery band`);
  return band.feeMinor;
}

test("fresh seed is coherent with operational model v2", () => {
  const store = freshSeed();
  const configuredFees = new Set(store.settings.deliveryFeeBands.map(({ feeMinor }) => feeMinor));
  const filesById = new Map(store.files.map((file) => [file.fileId, file]));

  assert.ok(store.orders.length > 0);
  assert.ok(store.zones.length > 0);
  assert.equal(store.zones.some((zone) => Object.hasOwn(zone, "deliveryFeeMinor")), false);

  for (const order of store.orders) {
    assert.equal(order.operationalModelVersion, 2, order.id);
    assert.equal(order.supplierPriceMinor % 100, 0, `${order.id} supplier price should be whole pesos`);
    assert.equal(order.commissionRatePercent, 10, order.id);
    assert.equal(order.commissionMinor, Math.round(order.supplierPriceMinor * 0.1), order.id);
    assert.equal(order.subtotalMinor, order.supplierPriceMinor + order.commissionMinor, order.id);
    assert.equal(configuredFees.has(order.deliveryFeeMinor), true, order.id);
    assert.equal(order.deliveryFeeMinor, configuredBandFee(order, store.settings), order.id);
    assert.equal(order.totalMinor, order.subtotalMinor + order.deliveryFeeMinor, order.id);

    assert.equal(order.downpaymentMinor, Math.round(order.totalMinor * 0.75), order.id);
    assert.equal(order.balanceMinor, order.totalMinor - order.downpaymentMinor, order.id);
    assert.equal(order.payments.downpayment.amountMinor, order.downpaymentMinor, order.id);
    assert.equal(order.payments.balance.amountMinor, order.balanceMinor, order.id);
    assert.equal(order.payments.downpayment.method, "qr_manual", order.id);
    assert.equal(order.payments.balance.method, "qr_manual", order.id);
    for (const installment of Object.values(order.payments)) {
      assert.equal(Object.hasOwn(installment, "rejectedAt"), true, order.id);
      assert.equal(Object.hasOwn(installment, "rejectedBy"), true, order.id);
      assert.equal(Object.hasOwn(installment, "rejectionReason"), true, order.id);
    }

    assert.deepEqual(order.payoutMilestones.map(({ sharePercent }) => sharePercent), [50, 15, 25, 10], order.id);
    assert.equal(
      order.payoutMilestones.reduce((sum, milestone) => sum + milestone.amountMinor, 0),
      order.supplierPriceMinor,
      order.id,
    );
    for (const milestone of order.payoutMilestones.filter(({ status }) => status === "released")) {
      assert.ok(milestone.pofFileIds.length > 0, `${order.id}/${milestone.code} released without POF`);
      for (const fileId of milestone.pofFileIds) {
        const file = filesById.get(fileId);
        assert.equal(file?.purpose, "fulfilment_proof", `${order.id}/${milestone.code}/${fileId}`);
        assert.equal(file?.state, "ready", `${order.id}/${milestone.code}/${fileId}`);
      }
    }
  }

  const supplier = store.users.find(({ email }) => email === "supplier@gridgo.local");
  const taxonomyCodes = new Set(store.taxonomy.categories.map(({ code }) => code));
  assert.ok(supplier.categoryRanks.length > 0);
  assert.deepEqual(supplier.categoryRanks.map(({ rank }) => rank), [1, 2]);
  assert.equal(supplier.categoryRanks.every(({ categoryCode }) => taxonomyCodes.has(categoryCode)), true);

  const pofOrder = store.orders.find((order) =>
    order.payoutMilestones.some(({ status, pofFileIds }) => status === "released" && pofFileIds.length > 0));
  assert.ok(pofOrder, "seed needs POF-backed released supplier milestones");

  const escalation = store.escalations.find(({ type, status }) => type === "pickup_check_failed" && status === "open");
  assert.ok(escalation, "seed needs an open failed-pickup escalation");
  const failedOrder = store.orders.find(({ id }) => id === escalation.orderId);
  assert.equal(failedOrder.state, "rider_assigned");
  assert.equal(failedOrder.pickupChecklist.status, "failed_escalated");
  assert.deepEqual(failedOrder.pickupChecklist.checks.map(({ code }) => code), PICKUP_CHECK_CODES);
  assert.equal(failedOrder.pickupChecklist.checks.some(({ passed }) => !passed), true);
  assert.ok(escalation.evidenceFileIds.length > 0);
  for (const fileId of escalation.evidenceFileIds) {
    const file = filesById.get(fileId);
    assert.equal(file?.purpose, "delivery_photo");
    assert.equal(file?.ownerId, escalation.riderId);
    assert.equal(file?.state, "ready");
  }

  const demoEmails = [
    "client@gridgo.local",
    "individual@gridgo.local",
    "supplier@gridgo.local",
    "rider@gridgo.local",
    "ops@gridgo.local",
    "admin@gridgo.local",
  ];
  for (const email of demoEmails) assert.equal(store.users.find((user) => user.email === email)?.password, "demo", email);
  assert.deepEqual(
    store.users.find((user) => user.email === "supplier@gridgo.local")?.verificationDocumentFileIds,
    [],
  );

  const at = store.orders[0].createdAt;
  assert.equal(backfillOperationalModel(store, at), false, "native v2 seed should need no migration");
  const afterFirst = JSON.stringify(store);
  assert.equal(backfillOperationalModel(store, at), false);
  assert.equal(JSON.stringify(store), afterFirst, "second backfill changed the seed");

  const stateCounts = Object.fromEntries(
    [...new Set(store.orders.map(({ state }) => state))]
      .sort()
      .map((state) => [state, store.orders.filter((order) => order.state === state).length]),
  );
  console.log("seed summary", {
    ordersByState: stateCounts,
    pofBackedReleasedOrders: store.orders.filter((order) =>
      order.payoutMilestones.some(({ status, pofFileIds }) => status === "released" && pofFileIds.length > 0)).map(({ id }) => id),
    failedPickupEscalations: store.escalations.filter(({ type }) => type === "pickup_check_failed").map(({ id }) => id),
  });
});
