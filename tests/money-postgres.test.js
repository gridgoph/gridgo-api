import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import {
  calculateOrderMoney,
  createPaymentSchedule,
  createPayoutMilestones,
  defaultOperationalSettings,
} from "../src/operational-model.js";
import { emptyStore, loadStore, saveStore } from "../src/postgres-store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const AT = "2026-08-16T00:00:00.000Z";
const SHOP = { lat: 7.064, lng: 125.6085, label: "Davao Shop" };
const DROPOFF = { lat: 7.064, lng: 125.6085, label: "Client" };

async function clear(database) {
  await database.query("TRUNCATE users, platform_settings RESTART IDENTITY CASCADE");
}

function committedOrder(id, options) {
  const money = calculateOrderMoney({
    supplierSubtotalMinor: options.supplierSubtotalMinor ?? 100_000,
    fulfillmentMode: options.fulfillmentMode,
    paymentPlan: options.paymentPlan,
    supplierDownpaymentRateBps: options.supplierDownpaymentRateBps,
    pickup: SHOP,
    dropoff: DROPOFF,
    distanceMeters: 0,
    settings: defaultOperationalSettings(),
  });
  const schedule = createPaymentSchedule(money);
  return {
    id,
    clientId: "money_client",
    supplierId: "money_supplier",
    riderId: null,
    productId: null,
    state: "awaiting_initial_payment",
    zone: null,
    ...money,
    ...schedule,
    revenueAdjustments: [],
    quoteVersion: 1,
    commercialCommittedAt: AT,
    moneyModelVersion: 2,
    payoutHold: false,
    pickup: SHOP,
    dropoff: options.fulfillmentMode === "delivery" ? DROPOFF : null,
    payoutPlanVersion: options.payoutPlanVersion ?? 2,
    payoutMilestones: createPayoutMilestones(money, { version: options.payoutPlanVersion ?? 2 }),
    timeline: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test("real PostgreSQL persists all plan allocations and immutable fee snapshots", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clear(database);
  const store = emptyStore();
  store.settings = defaultOperationalSettings();
  store.version = 4;
  store.users = [
    { id: "money_client", clerkUserId: "clerk_money_client", email: "money-client@gridgo.test", name: "Money Client", role: "client", accountType: "individual", createdAt: AT },
    { id: "money_supplier", clerkUserId: "clerk_money_supplier", email: "money-supplier@gridgo.test", name: "Money Supplier", role: "supplier", verificationStatus: "approved", shop: SHOP, createdAt: AT },
    { id: "money_supplier_2", clerkUserId: "clerk_money_supplier_2", email: "money-supplier-2@gridgo.test", name: "Money Supplier 2", role: "supplier", verificationStatus: "approved", shop: SHOP, createdAt: AT },
  ];
  store.userRoleMemberships = [
    { userId: "money_client", role: "client", createdAt: AT },
    { userId: "money_supplier", role: "supplier", createdAt: AT },
    { userId: "money_supplier_2", role: "supplier", createdAt: AT },
  ];
  store.clientProfiles = [{ userId: "money_client", clientKind: "personal", updatedAt: AT }];
  store.supplierProfiles = [
    { userId: "money_supplier", shopName: "Davao Shop", contactName: "Money Supplier", shop: SHOP, pickupAvailable: true, updatedAt: AT },
    { userId: "money_supplier_2", shopName: "Davao Shop 2", contactName: "Money Supplier 2", shop: SHOP, pickupAvailable: false, updatedAt: AT },
  ];
  store.supplierPaymentTerms = [{
    supplierId: "money_supplier",
    deliveryDownpaymentRateBps: 2_500,
    pickupFullOnlineEnabled: true,
    pickupDownpaymentStoreEnabled: true,
    pickupDownpaymentRateBps: 2_500,
    updatedAt: AT,
  }];
  store.orders = [
    committedOrder("delivery_rounding", {
      supplierSubtotalMinor: 99_999,
      fulfillmentMode: "delivery",
      paymentPlan: "delivery_online",
      supplierDownpaymentRateBps: 2_500,
    }),
    committedOrder("pickup_full", {
      fulfillmentMode: "pickup",
      paymentPlan: "pickup_full_online",
      supplierDownpaymentRateBps: 10_000,
    }),
    committedOrder("pickup_store", {
      fulfillmentMode: "pickup",
      paymentPlan: "pickup_downpayment_store",
      supplierDownpaymentRateBps: 2_500,
    }),
    // Placed before the escrow split: four stages under plan 1.
    committedOrder("legacy_four_stage", {
      supplierSubtotalMinor: 99_999,
      fulfillmentMode: "pickup",
      paymentPlan: "pickup_full_online",
      supplierDownpaymentRateBps: 10_000,
      payoutPlanVersion: 1,
    }),
    {
      id: "uncommitted_target",
      clientId: "money_client",
      supplierId: "money_supplier_2",
      riderId: null,
      productId: null,
      state: "draft",
      payments: {},
      paymentAllocations: [],
      payoutMilestones: [],
      timeline: [],
      createdAt: AT,
      updatedAt: AT,
    },
  ];

  await database.transaction(() => saveStore(database, store));
  const persisted = await loadStore(database);
  const delivery = persisted.orders.find((order) => order.id === "delivery_rounding");
  assert.deepEqual(
    {
      serviceFeeMinor: delivery.serviceFeeMinor,
      initialSupplierPrincipalMinor: delivery.initialSupplierPrincipalMinor,
      supplierRemainderMinor: delivery.supplierRemainderMinor,
      initialOnlineMinor: delivery.initialOnlineMinor,
      finalOnlineMinor: delivery.finalOnlineMinor,
      totalMinor: delivery.totalMinor,
    },
    {
      serviceFeeMinor: 10_000,
      initialSupplierPrincipalMinor: 25_000,
      supplierRemainderMinor: 74_999,
      initialOnlineMinor: 35_000,
      finalOnlineMinor: 77_499,
      totalMinor: 112_499,
    },
  );
  // Each order keeps the plan it was committed under, split the way the
  // database recomputes it: half-up per stage, the remainder on the last.
  assert.equal(delivery.payoutPlanVersion, 2);
  assert.deepEqual(
    delivery.payoutMilestones.map(({ code, amountMinor }) => [code, amountMinor]),
    [["production_started", 40_000], ["delivered", 35_000], ["issue_window", 24_999]],
  );
  const legacy = persisted.orders.find((order) => order.id === "legacy_four_stage");
  assert.equal(legacy.payoutPlanVersion, 1);
  assert.deepEqual(
    legacy.payoutMilestones.map(({ code, amountMinor }) => [code, amountMinor]),
    [["printing", 50_000], ["packaging_qc", 15_000], ["delivered", 25_000], ["retention", 9_999]],
  );
  assert.deepEqual(persisted.orders.find((order) => order.id === "pickup_full").paymentAllocations, [
    { paymentCode: "initial", component: "service_fee", amountMinor: 10_000 },
    { paymentCode: "initial", component: "supplier_principal", amountMinor: 100_000 },
  ]);
  assert.deepEqual(persisted.orders.find((order) => order.id === "pickup_store").paymentAllocations, [
    { paymentCode: "initial", component: "service_fee", amountMinor: 10_000 },
    { paymentCode: "initial", component: "supplier_principal", amountMinor: 25_000 },
  ]);

  assert.equal(delivery.riderCommissionBps, 8500);
  assert.equal(delivery.riderPayoutMinor, 2125);
  assert.equal(delivery.platformDeliveryShareMinor, 375);
  assert.deepEqual((await database.query(`SELECT rider_payout_minor, platform_delivery_share_minor
    FROM orders WHERE id = 'delivery_rounding'`)).rows[0], {
    rider_payout_minor: 2125, platform_delivery_share_minor: 375,
  });
  persisted.settings.riderCommissionBps = 7000;
  const snapshotted = {
    riderRate: delivery.riderCommissionBps,
    riderPayout: delivery.riderPayoutMinor,
    rate: delivery.serviceFeeRateBps,
    fee: delivery.serviceFeeMinor,
    total: delivery.totalMinor,
  };
  persisted.settings.serviceFeeRateBps = 2_500;
  persisted.version += 1;
  await database.transaction(() => saveStore(database, persisted));
  const afterSettingChange = (await loadStore(database)).orders.find((order) => order.id === delivery.id);
  assert.deepEqual({
    riderRate: afterSettingChange.riderCommissionBps,
    riderPayout: afterSettingChange.riderPayoutMinor,
    rate: afterSettingChange.serviceFeeRateBps,
    fee: afterSettingChange.serviceFeeMinor,
    total: afterSettingChange.totalMinor,
  }, snapshotted);

  await assert.rejects(
    database.query("UPDATE orders SET rider_commission_bps = 7000 WHERE id = 'delivery_rounding'"),
    (error) => error.code === "23514" && error.constraint === "orders_delivery_snapshot_immutable",
  );
  await assert.rejects(
    database.query("UPDATE orders SET rider_payout_minor = 2500 WHERE id = 'delivery_rounding'"),
    (error) => error.code === "428C9",
  );
  await assert.rejects(
    database.query("UPDATE orders SET service_fee_minor = service_fee_minor + 1 WHERE id = 'delivery_rounding'"),
    (error) => error.code === "23514" && error.constraint === "orders_committed_snapshot_immutable",
  );
  await assert.rejects(
    database.query("UPDATE orders SET money_model_version = 1 WHERE id = 'delivery_rounding'"),
    (error) => error.code === "23514" && error.constraint === "orders_committed_snapshot_immutable",
  );
  // The payout plan is part of the commitment: an order cannot be moved onto
  // another plan after the fact.
  await assert.rejects(
    database.query("UPDATE orders SET payout_plan_version = 1 WHERE id = 'delivery_rounding'"),
    (error) => error.code === "23514" && error.constraint === "orders_committed_snapshot_immutable",
  );
  // A split that still sums to the payout but moves a centavo between stages
  // is refused under either plan.
  for (const [orderId, first, last] of [
    ["delivery_rounding", "production_started", "issue_window"],
    ["legacy_four_stage", "printing", "retention"],
  ]) {
    await assert.rejects(
      database.query(`
        UPDATE payout_milestones
           SET amount_minor = amount_minor + CASE code WHEN $2 THEN 1 WHEN $3 THEN -1 ELSE 0 END
         WHERE order_id = $1
      `, [orderId, first, last]),
      (error) => error.code === "23514" && error.constraint === "payout_milestones_amount_check",
      orderId,
    );
  }
  // And one plan's stages are never valid under the other's version.
  await assert.rejects(
    database.query(`
      UPDATE payout_milestones SET code = 'production_started'
       WHERE order_id = 'legacy_four_stage' AND code = 'printing'
    `),
    (error) => error.code === "23514" && error.constraint === "payout_milestones_amount_check",
  );
  await assert.rejects(
    database.query(`
      UPDATE order_payment_allocations
         SET amount_minor = amount_minor + 1
       WHERE order_id = 'delivery_rounding'
         AND payment_code = 'initial'
         AND component = 'service_fee'
    `),
    (error) => error.code === "23514" && error.constraint === "order_payment_allocations_shape_check",
  );
  await assert.rejects(
    database.query(`
      UPDATE payout_milestones
         SET status = 'released'
       WHERE order_id = 'delivery_rounding'
         AND code = 'delivered'
    `),
    (error) => error.code === "23514" && error.constraint === "payout_milestones_collected_principal_check",
  );
  await assert.rejects(
    database.query(`
      UPDATE payout_milestones
         SET order_id = 'uncommitted_target'
       WHERE order_id = 'delivery_rounding'
         AND code = 'production_started'
    `),
    (error) => error.code === "23514" && error.constraint === "payout_milestones_amount_check",
  );
  await database.query("DELETE FROM supplier_payment_terms WHERE supplier_id = 'money_supplier_2'");
  await assert.rejects(
    database.query(`
      UPDATE supplier_payment_terms
         SET supplier_id = 'money_supplier_2'
       WHERE supplier_id = 'money_supplier'
    `),
    (error) => error.code === "23514" && error.constraint === "supplier_payment_terms_supplier_immutable",
  );

  await clear(database);
  await database.close();
});
