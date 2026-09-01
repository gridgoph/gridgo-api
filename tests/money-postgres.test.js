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
    payoutMilestones: createPayoutMilestones(money),
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
  assert.deepEqual(persisted.orders.find((order) => order.id === "pickup_full").paymentAllocations, [
    { paymentCode: "initial", component: "service_fee", amountMinor: 10_000 },
    { paymentCode: "initial", component: "supplier_principal", amountMinor: 100_000 },
  ]);
  assert.deepEqual(persisted.orders.find((order) => order.id === "pickup_store").paymentAllocations, [
    { paymentCode: "initial", component: "service_fee", amountMinor: 10_000 },
    { paymentCode: "initial", component: "supplier_principal", amountMinor: 25_000 },
  ]);

  const snapshotted = {
    rate: delivery.serviceFeeRateBps,
    fee: delivery.serviceFeeMinor,
    total: delivery.totalMinor,
  };
  persisted.settings.serviceFeeRateBps = 2_500;
  persisted.version += 1;
  await database.transaction(() => saveStore(database, persisted));
  const afterSettingChange = (await loadStore(database)).orders.find((order) => order.id === delivery.id);
  assert.deepEqual({
    rate: afterSettingChange.serviceFeeRateBps,
    fee: afterSettingChange.serviceFeeMinor,
    total: afterSettingChange.totalMinor,
  }, snapshotted);

  await assert.rejects(
    database.query("UPDATE orders SET service_fee_minor = service_fee_minor + 1 WHERE id = 'delivery_rounding'"),
    (error) => error.code === "23514" && error.constraint === "orders_committed_snapshot_immutable",
  );
  await assert.rejects(
    database.query("UPDATE orders SET money_model_version = 1 WHERE id = 'delivery_rounding'"),
    (error) => error.code === "23514" && error.constraint === "orders_committed_snapshot_immutable",
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
         AND code = 'printing'
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
