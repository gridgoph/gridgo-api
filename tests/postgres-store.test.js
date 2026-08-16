import test from "node:test";
import assert from "node:assert/strict";

import { createDatabase } from "../src/database.js";
import { emptyStore, loadStore, saveStore, loadDeviceTokenStore, saveDeviceTokenStore } from "../src/postgres-store.js";
import { claimDeviceToken, registerUnclaimedDeviceToken } from "../src/push.js";

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
  store.settings = { serviceFeeRateBps: 1000, issueWindowHours: 24, deliveryFeeBands: [{ maxDistanceMeters: null, feeMinor: 5000 }] };
  store.zones = [{ id: "zone_central", code: "davao_central", name: "Davao Central", active: true }];
  store.supplierServices = [{ id: "svc_banner", supplierId: "user_supplier", categoryCode: "marketing", state: "live", referenceRateMinor: 100000, turnaroundHours: 24, materialCodes: ["vinyl"], finishCodes: ["none"], createdAt: AT, updatedAt: AT }];
  store.orders = [{
    id: "ord_one", clientId: "user_client", supplierId: "user_supplier", riderId: "user_rider",
    productId: "prod_banner", state: "issue_window_open", zone: "davao_central",
    supplierSubtotalMinor: 100000, subtotalMinor: 100000, serviceFeeRateBps: 1000, serviceFeeMinor: 10000,
    deliveryFeeMinor: 5000, totalMinor: 115000, fulfillmentMode: "delivery", paymentPlan: "delivery_online",
    quoteVersion: 1, supplierDownpaymentRateBps: null, onlineDueMinor: 115000, directStoreDueMinor: 0,
    supplierPlatformPayoutMinor: 100000, commercialCommittedAt: AT, moneyModelVersion: 1,
    initialOnlineMinor: 86250, finalOnlineMinor: 28750,
    payoutHold: true, pickup: { lat: 7.064, lng: 125.6085, label: "Davao shop" },
    dropoff: { lat: 7.0731, lng: 125.6128, label: "Client address" },
    issueWindowOpenedAt: "2026-08-15T00:00:00.000Z",
    issueWindowExpiresAt: "2026-08-17T00:00:00.000Z",
    title: "Launch banner", quantity: 1, address: "Client address",
    payments: {
      initial: { amountMinor: 86250, method: "qr_manual", status: "confirmed", reference: "DP-1" },
      final_online: { amountMinor: 28750, method: "qr_manual", status: "confirmed", reference: "BAL-1" },
    },
    paymentAllocations: [
      { paymentCode: "final_online", component: "delivery_pass_through", amountMinor: 5000 },
      { paymentCode: "final_online", component: "supplier_principal", amountMinor: 23750 },
      { paymentCode: "initial", component: "service_fee", amountMinor: 10000 },
      { paymentCode: "initial", component: "supplier_principal", amountMinor: 76250 },
    ],
    revenueAdjustments: [],
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
  assert.equal(reloaded.orders[0].payments.final_online.amountMinor, 28750);
  assert.equal(reloaded.orders[0].payoutMilestones[0].amountMinor, 50000);
  assert.equal(reloaded.credits.user_client.balanceMinor, 500000);

  await clear(database);
  await database.close();
});

test("relational store maps memberships, approval records, profiles, and rider documents", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clear(database);
  const store = emptyStore();
  store.users = [
    { id: "user_supplier", clerkUserId: "clerk_supplier_roles", email: "supplier-roles@gridgo.test", name: "Supplier", role: "supplier", verificationStatus: "pending", shop: { lat: 7.064, lng: 125.6085, label: "Davao shop" }, createdAt: AT },
    { id: "user_rider", clerkUserId: "clerk_rider_roles", email: "rider-roles@gridgo.test", name: "Rider", role: "rider", verificationStatus: "pending", createdAt: AT },
  ];
  store.userRoleMemberships = [
    { userId: "user_supplier", role: "supplier", createdAt: AT },
    { userId: "user_rider", role: "rider", createdAt: AT, createdBy: "user_supplier" },
  ];
  store.supplierProfiles = [{ userId: "user_supplier", shopName: "PrintRight", contactName: "Supplier", shop: { lat: 7.064, lng: 125.6085, label: "Davao shop" }, pickupAvailable: true, updatedAt: AT }];
  store.riderProfiles = [{ userId: "user_rider", vehicleType: "motorcycle", plateNumber: "ABC-123", licenseNumber: "LIC-123", updatedAt: AT }];
  store.approvalCases = [{ id: "case_rider", userId: "user_rider", kind: "rider", status: "pending", version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT }];
  store.approvalCaseEvents = [{ id: "event_rider", approvalCaseId: "case_rider", applicationRevision: 1, toStatus: "pending", actorUserId: "user_rider", actorKind: "applicant", requestId: "request-rider", snapshot: { vehicleType: "motorcycle" }, createdAt: AT }];
  store.files = [{ fileId: "file_license", ownerId: "user_rider", purpose: "rider_verification_document", originalFilename: "license.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 100, state: "ready", objectKey: "riders/license.jpg", references: [{ type: "rider_document", id: "document_rider", field: "fileId" }], createdAt: AT }];
  store.riderDocuments = [{ id: "document_rider", riderId: "user_rider", kind: "drivers_license", fileId: "file_license", expiresOn: "2027-08-16", isCurrent: true, uploadedAt: AT }];

  await database.transaction(async () => saveStore(database, store));
  const reloaded = await loadStore(database);

  assert.deepEqual(reloaded.userRoleMemberships, [...store.userRoleMemberships].sort((a, b) => a.userId.localeCompare(b.userId)));
  assert.deepEqual(reloaded.supplierProfiles, store.supplierProfiles);
  assert.deepEqual(reloaded.riderProfiles, store.riderProfiles);
  assert.deepEqual(reloaded.approvalCases, store.approvalCases);
  assert.deepEqual(reloaded.approvalCaseEvents, store.approvalCaseEvents);
  assert.deepEqual(reloaded.riderDocuments, store.riderDocuments);

  reloaded.approvalCaseEvents[0].reason = "events cannot be rewritten";
  await assert.rejects(database.transaction(() => saveStore(database, reloaded)), /approval_case_events rows are append-only/);

  await clear(database);
  await database.close();
});

async function seedRaceFixture(database, tokens) {
  await clear(database);
  const store = emptyStore();
  store.users.push({ id: "user_client", clerkUserId: "clerk_client", email: "race@gridgo.test", name: "Race", role: "client", accountType: "individual", createdAt: AT });
  for (const [index, token] of tokens.entries()) {
    store.deviceTokens.push({ id: `dev_race_${index}`, userId: null, token, platform: "android", createdAt: AT, updatedAt: AT });
  }
  await database.transaction(() => saveStore(database, store));
}

test("anonymous device registration cannot unclaim a token claimed under the domain lock", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  const rival = createDatabase({ DATABASE_URL });
  const LATER = "2026-08-16T01:00:00.000Z";
  const fcmToken = "race-claimed-mid-flight-token-0123456789012345678901234567890123456789";
  await seedRaceFixture(database, [fcmToken]);

  await database.transaction(async () => {
    const deviceStore = await loadDeviceTokenStore(database);
    await rival.transaction(async () => {
      const full = await loadStore(rival);
      claimDeviceToken(full, { token: fcmToken, userId: "user_client", at: LATER });
      await saveStore(rival, full);
    });
    const outcome = registerUnclaimedDeviceToken(deviceStore, { token: fcmToken, platform: "web", at: LATER });
    if (outcome.changed) await saveDeviceTokenStore(database, deviceStore);
  }, { lockKey: "gridgo-device-tokens" });

  const row = (await database.query("SELECT user_id, platform FROM device_tokens WHERE token = $1", [fcmToken])).rows[0];
  assert.equal(row.user_id, "user_client");
  assert.equal(row.platform, "android");

  await clear(database);
  await database.close();
  await rival.close();
});

test("anonymous eviction cannot delete a token claimed under the domain lock", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  const rival = createDatabase({ DATABASE_URL });
  const LATER = "2026-08-16T01:00:00.000Z";
  const claimedToken = "race-evicted-after-claim-token-0123456789012345678901234567890123456789";
  const freshToken = "race-brand-new-install-token-0123456789012345678901234567890123456789";
  await seedRaceFixture(database, [claimedToken]);

  await database.transaction(async () => {
    const deviceStore = await loadDeviceTokenStore(database);
    await rival.transaction(async () => {
      const full = await loadStore(rival);
      claimDeviceToken(full, { token: claimedToken, userId: "user_client", at: LATER });
      await saveStore(rival, full);
    });
    const outcome = registerUnclaimedDeviceToken(deviceStore, { token: freshToken, platform: "android", at: LATER, limit: 1 });
    assert.equal(outcome.evicted, 1);
    if (outcome.changed) await saveDeviceTokenStore(database, deviceStore);
  }, { lockKey: "gridgo-device-tokens" });

  const rows = (await database.query("SELECT token, user_id FROM device_tokens ORDER BY token")).rows;
  assert.deepEqual(rows, [
    { token: freshToken, user_id: null },
    { token: claimedToken, user_id: "user_client" },
  ]);

  await clear(database);
  await database.close();
  await rival.close();
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
