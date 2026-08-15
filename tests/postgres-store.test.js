import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { emptyStore, loadStore, saveStore } from "../src/postgres-store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const AT = "2026-08-16T00:00:00.000Z";

async function clear(database) {
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, orders, supplier_services, zones,
    taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
}

test("relational store round-trips typed money, relationships, and composite route data", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clear(database);
  const store = emptyStore();
  store.users = [
    { id: "user_client", clerkUserId: "clerk_client", email: "client@gridgo.test", name: "Client", phone: "+63900", role: "client", accountType: "individual", createdAt: AT },
    { id: "user_supplier", clerkUserId: "clerk_supplier", email: "supplier@gridgo.test", name: "Supplier", role: "supplier", supplierName: "Print Shop", verificationStatus: "approved", shop: { lat: 7.064, lng: 125.6085, label: "Davao shop" }, createdAt: AT },
    { id: "user_rider", clerkUserId: "clerk_rider", email: "rider@gridgo.test", name: "Rider", role: "rider", verificationStatus: "approved", createdAt: AT },
  ];
  store.catalog = [{ id: "prod_banner", name: "Banner", family: "banner", basePriceMinor: 45000, unit: "sqm" }];
  store.taxonomy = {
    categories: [{ id: "cat_marketing", code: "marketing", name: "Marketing", active: true, sortOrder: 1 }],
    categoryAliases: [{ code: "large_format", categoryCode: "marketing" }],
    subcategories: [{ id: "sub_banner", code: "banner", categoryCode: "marketing", name: "Banner", active: true, sortOrder: 1 }],
    materials: [{ id: "mat_vinyl", code: "vinyl", name: "Vinyl", categoryCodes: ["marketing"], active: true }],
    finishes: [{ id: "fin_none", code: "none", name: "None", categoryCodes: ["marketing"], active: true }],
  };
  store.settings = { issueWindowHours: 24, commissionPercent: 10, deliveryFeeBands: [{ maxKm: 5, feeMinor: 5000 }] };
  store.zones = [{ id: "zone_central", code: "davao_central", name: "Davao Central", active: true }];
  store.supplierServices = [{ id: "svc_banner", supplierId: "user_supplier", categoryCode: "marketing", state: "live", referenceRateMinor: 100000, turnaroundHours: 24, materialCodes: ["vinyl"], finishCodes: ["none"], createdAt: AT, updatedAt: AT }];
  store.orders = [{
    id: "ord_one", clientId: "user_client", supplierId: "user_supplier", riderId: "user_rider",
    productId: "prod_banner", state: "issue_window_open", zone: "davao_central",
    supplierPriceMinor: 100000, commissionMinor: 10000, subtotalMinor: 110000,
    deliveryFeeMinor: 5000, totalMinor: 115000, downpaymentMinor: 86250, balanceMinor: 28750,
    payoutHold: true, pickup: { lat: 7.064, lng: 125.6085, label: "Davao shop" },
    dropoff: { lat: 7.0731, lng: 125.6128, label: "Client address" },
    issueWindowOpenedAt: "2026-08-15T00:00:00.000Z",
    issueWindowExpiresAt: "2026-08-17T00:00:00.000Z",
    title: "Launch banner", quantity: 1, address: "Client address",
    payments: {
      downpayment: { amountMinor: 86250, method: "qr_manual", status: "confirmed", reference: "DP-1" },
      balance: { amountMinor: 28750, method: "qr_manual", status: "confirmed", reference: "BAL-1" },
    },
    payoutMilestones: [{ code: "printing", sharePercent: 50, amountMinor: 50000, status: "released", pofFileIds: ["file_pof"] }],
    pickupChecklist: { status: "passed", checks: [{ code: "sealed", passed: true }] },
    timeline: [{ at: AT, state: "issue_window_open", by: "system" }],
    createdAt: AT, updatedAt: AT,
  }];
  store.files = [{ fileId: "file_pof", ownerId: "user_supplier", purpose: "fulfilment_proof", originalFilename: "proof.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 128000, state: "ready", objectKey: "proof/file_pof.jpg", references: [{ type: "order", id: "ord_one", field: "fulfilmentProofFileIds", milestoneCode: "printing" }], createdAt: AT, readyAt: AT }];
  store.credits = { user_client: { balanceMinor: 500000, ledger: [{ id: "led_one", type: "grant", amountMinor: 500000, balanceAfterMinor: 500000, at: AT, actorId: "user_client" }] } };
  store.claims = [{ id: "clm_one", orderId: "ord_one", status: "payout_held", reason: "quality", createdAt: AT, updatedAt: AT }];
  store.issues = [{ id: "iss_one", orderId: "ord_one", clientId: "user_client", claimId: "clm_one", kind: "quality", status: "open", description: "Peeling", createdAt: AT, updatedAt: AT }];
  store.auditLog = [{ id: "aud_one", at: AT, actorId: "user_client", actorRole: "client", action: "issue.report", entityType: "issue", entityId: "iss_one", orderId: "ord_one", detail: { claimId: "clm_one" } }];
  store.notifications = [{ id: "ntf_one", userId: "user_client", type: "issue_opened", orderId: "ord_one", title: "Issue opened", body: "Review", read: false, at: AT }];
  store.locationPings = [{ id: "ping_one", orderId: "ord_one", riderId: "user_rider", lat: 7.07, lng: 125.61, accuracy: 8, at: AT }];
  store.escalations = [{ id: "esc_one", orderId: "ord_one", riderId: "user_rider", status: "open", type: "pickup_check_failed", createdAt: AT, updatedAt: AT }];
  store.deviceTokens = [{ id: "dev_one", userId: "user_client", token: "fcm-token-that-is-long-enough-for-roundtrip-1234567890", platform: "android", createdAt: AT, updatedAt: AT }];

  await database.transaction(async () => saveStore(database, store));
  const reloaded = await loadStore(database);

  assert.deepEqual(reloaded, store);
  assert.equal(typeof reloaded.orders[0].totalMinor, "number");
  assert.equal(reloaded.orders[0].payments.balance.amountMinor, 28750);
  assert.equal(reloaded.orders[0].payoutMilestones[0].amountMinor, 50000);
  assert.equal(reloaded.credits.user_client.balanceMinor, 500000);

  await clear(database);
  await database.close();
});

test("store rejects money outside JavaScript's safe integer range", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clear(database);
  const store = emptyStore();
  store.users.push({ id: "user_client", clerkUserId: "clerk_client", email: "safe@gridgo.test", name: "Safe", role: "client", accountType: "individual", createdAt: AT });
  store.catalog.push({ id: "prod_unsafe", name: "Unsafe", family: "test", basePriceMinor: Number.MAX_SAFE_INTEGER + 1, unit: "each" });
  await assert.rejects(database.transaction(() => saveStore(database, store)), /safe integer/);
  await clear(database);
  await database.close();
});
