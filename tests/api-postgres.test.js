import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import {
  attachRiderDocument,
  invalidateRiderDocumentsForFile,
  markFileDeleted,
} from "../src/attachments.js";
import { createPayoutMilestones } from "../src/operational-model.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
const AT = "2026-08-16T00:00:00.000Z";
const MANILA_YEAR = Number(new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  year: "numeric",
}).format(new Date()));
const LICENSE_EXPIRY = `${MANILA_YEAR + 2}-12-31`;
const REPLACEMENT_LICENSE_EXPIRY = `${MANILA_YEAR + 3}-12-31`;

function token(subject, claims = {}) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: subject, sid: `sess_${subject}`, azp: AUTHORIZED_PARTY,
    iat: current - 5, nbf: current - 5, exp: current + 300, ...claims,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startApi(extraEnv = {}) {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      DATABASE_URL,
      CLERK_SECRET_KEY: "test-only-placeholder",
      CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
      CLERK_JWT_KEY: JWT_KEY,
      HOST: "127.0.0.1",
      PORT: String(port),
      GRIDGO_BUILD_SHA: "api-postgres-test",
      GRIDGO_BUILD_TIME: AT,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`API exited before health:\n${output}`);
    try {
      const response = await fetch(`${api}/health`);
      if (response.ok) return { api, child, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`API did not become healthy:\n${output}`);
}

async function request(api, pathname, { method = "GET", subject, claims, body, headers = {} } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(subject ? { Authorization: `Bearer ${token(subject, claims)}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function loadStoreEventually(database, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const store = await loadStore(database);
    if (predicate(store)) return store;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the committed PostgreSQL state");
}

/** Sends rawPath exactly as given — fetch would normalize dot segments client-side. */
function rawRequest(api, rawPath, { method = "POST", subject, body } = {}) {
  const { hostname, port } = new URL(api);
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      {
        hostname,
        port,
        path: rawPath,
        method,
        headers: {
          ...(subject ? { Authorization: `Bearer ${token(subject)}` } : {}),
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end(body == null ? undefined : JSON.stringify(body));
  });
}

async function clearAndFixture(database) {
  await database.query(`TRUNCATE
    administrator_bootstrap, device_tokens, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, order_line_item_options, order_line_items, orders,
    supplier_catalog_prep_steps, supplier_catalog_item_photos, supplier_shop_media, supplier_catalog_item_file_formats,
    supplier_catalog_options, supplier_catalog_option_groups, supplier_catalog_items,
    supplier_service_file_formats, supplier_service_price_tiers, supplier_services,
    listing_starter_options, listing_starter_groups, listing_starters, accepted_file_formats,
    zones, taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
    taxonomy_category_aliases, taxonomy_categories, catalog_products, users,
    platform_settings RESTART IDENTITY CASCADE`);
  await seedReferenceData(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push(
      { id: "user_client", clerkUserId: "clerk_client", email: "client@gridgo.test", name: "Client", role: "client", accountType: "individual", createdAt: AT },
      { id: "user_supplier", clerkUserId: "clerk_supplier", email: "supplier@gridgo.test", name: "Supplier", role: "supplier", supplierName: "Print Shop", verificationStatus: "approved", shop: { lat: 7.064, lng: 125.6085, label: "Davao Shop" }, createdAt: AT },
      { id: "user_rider", clerkUserId: "clerk_rider", email: "rider@gridgo.test", name: "Rider", role: "rider", verificationStatus: "approved", createdAt: AT },
      { id: "user_ops", clerkUserId: "clerk_ops", email: "ops@gridgo.test", name: "Ops", role: "ops_admin", createdAt: AT },
      { id: "user_super", clerkUserId: "clerk_super", email: "super@gridgo.test", name: "Super", role: "super_admin", createdAt: AT },
      { id: "user_promote", clerkUserId: "clerk_promote", email: "promote@gridgo.test", name: "Promote", role: "client", accountType: "individual", createdAt: AT },
    );
    store.userRoleMemberships.push(
      { userId: "user_client", role: "client", createdAt: AT },
      { userId: "user_supplier", role: "supplier", createdAt: AT },
      { userId: "user_rider", role: "rider", createdAt: AT },
      { userId: "user_ops", role: "ops_admin", createdAt: AT },
      { userId: "user_super", role: "super_admin", createdAt: AT },
      { userId: "user_promote", role: "client", createdAt: AT },
    );
    store.clientProfiles.push(
      { userId: "user_client", clientKind: "personal", updatedAt: AT },
      { userId: "user_promote", clientKind: "personal", updatedAt: AT },
    );
    store.supplierProfiles.push({
      userId: "user_supplier", shopName: "Print Shop", contactName: "Supplier",
      shop: { lat: 7.064, lng: 125.6085, label: "Davao Shop" },
      pickupAvailable: false, updatedAt: AT,
    });
    store.riderProfiles.push({
      userId: "user_rider", vehicleType: "motorcycle", plateNumber: "GRIDGO-1", updatedAt: AT,
    });
    store.approvalCases.push(
      {
        id: "case_supplier", userId: "user_supplier", kind: "supplier", status: "approved",
        version: 1, applicationRevision: 1, submittedAt: AT, decidedAt: AT,
        createdAt: AT, updatedAt: AT,
      },
      {
        id: "case_rider", userId: "user_rider", kind: "rider", status: "approved",
        version: 1, applicationRevision: 1, submittedAt: AT, decidedAt: AT,
        createdAt: AT, updatedAt: AT,
      },
    );
    store.supplierServices.push({
      id: "svc_banner", supplierId: "user_supplier", categoryCode: "marketing_collateral",
      materialCodes: ["tarpaulin_13oz"], finishCodes: ["none"], productFamilyIds: ["banner"],
      qtyMin: 1, qtyMax: 100, pricingBasis: "per_sqm", referenceRateMinor: 100000,
      turnaroundHours: 24, capacityDaily: 20, capacityWeekly: 100, zones: ["davao_central"],
      state: "live", verifiedAt: AT, verifiedBy: "user_ops", createdAt: AT, updatedAt: AT,
    });
    const milestones = [
      ["printing", 50, 50000],
      ["packaging_qc", 15, 15000],
      ["delivered", 25, 25000],
      ["retention", 10, 10000],
    ].map(([code, sharePercent, amountMinor]) => ({
      code,
      sharePercent,
      amountMinor,
      status: "released",
      pofFileIds: ["file_pof"],
      releasedAt: AT,
      releasedBy: "user_ops",
    }));
    for (const milestone of milestones) {
      milestone.status = "released";
    }
    milestones[0].status = "pof_attached";
    milestones[0].releasedAt = null;
    milestones[0].releasedBy = null;
    store.orders.push({
      id: "ord_payout", clientId: "user_client", supplierId: "user_supplier", riderId: null,
      productId: "prod_tarpaulin", state: "completed", zone: "davao_central",
      supplierSubtotalMinor: 100000, subtotalMinor: 100000, serviceFeeRateBps: 1000, serviceFeeMinor: 10000,
      deliveryFeeMinor: 2500, totalMinor: 112500, fulfillmentMode: "delivery", paymentPlan: "delivery_online",
      quoteVersion: 1, supplierDownpaymentRateBps: null, onlineDueMinor: 112500, directStoreDueMinor: 0,
      supplierPlatformPayoutMinor: 100000, commercialCommittedAt: AT, moneyModelVersion: 1,
      payoutHold: false, pickup: { lat: 7.064, lng: 125.6085, label: "Davao Shop" },
      dropoff: { lat: 7.08, lng: 125.62, label: "Client" }, payments: {
        initial: { amountMinor: 84375, method: "qr_manual", status: "confirmed" },
        final_online: { amountMinor: 28125, method: "qr_manual", status: "confirmed" },
      }, paymentAllocations: [
        { paymentCode: "initial", component: "service_fee", amountMinor: 10000 },
        { paymentCode: "initial", component: "supplier_principal", amountMinor: 74375 },
        { paymentCode: "final_online", component: "supplier_principal", amountMinor: 25625 },
        { paymentCode: "final_online", component: "delivery_pass_through", amountMinor: 2500 },
      ], payoutMilestones: milestones, timeline: [], createdAt: AT, updatedAt: AT,
    });
    store.orders.push({
      id: "ord_expired", clientId: "user_client", supplierId: null, riderId: null,
      productId: "prod_tarpaulin", state: "issue_window_open", zone: "davao_central",
      payoutHold: false, pickup: null,
      dropoff: { lat: 7.08, lng: 125.62, label: "Client" }, payments: {}, payoutMilestones: [],
      issueWindowOpenedAt: "2020-01-01T00:00:00.000Z",
      issueWindowExpiresAt: "2020-01-02T00:00:00.000Z",
      timeline: [], createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    });
    store.files.push({ fileId: "file_pof", ownerId: "user_supplier", purpose: "fulfilment_proof", originalFilename: "proof.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", size: 100, state: "ready", objectKey: "proof/file_pof.jpg", references: [{ type: "order", id: "ord_payout", field: "fulfilmentProofFileIds", milestoneCode: "printing" }], createdAt: AT, readyAt: AT });
    const riderLicense = {
      fileId: "file_rider_license_fixture",
      ownerId: "user_rider",
      purpose: "rider_verification_document",
      originalFilename: "license.png",
      declaredContentType: "image/png",
      detectedContentType: "image/png",
      size: 128,
      state: "ready",
      objectKey: "rider_verification_document/fixture-license.png",
      references: [],
      createdAt: AT,
      readyAt: AT,
    };
    store.files.push(riderLicense);
    attachRiderDocument(store, riderLicense, {
      type: "rider_document",
      record: store.users.find((user) => user.id === "user_rider"),
      kind: "drivers_license",
      expiresOn: LICENSE_EXPIRY,
      replacedDocuments: [],
    }, { documentId: "rdoc_rider_license_fixture", at: AT });
    await saveStore(database, store);
  });
}

async function addApprovalDecisionFixtures(database) {
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push(
      {
        id: "user_supplier_pending", clerkUserId: "clerk_supplier_pending",
        email: "pending-supplier@gridgo.test", name: "Pending Supplier", role: "supplier",
        verificationStatus: "pending", createdAt: AT,
      },
      {
        id: "user_supplier_incomplete", clerkUserId: "clerk_supplier_incomplete",
        email: "incomplete-supplier@gridgo.test", name: "Incomplete Supplier", role: "supplier",
        verificationStatus: "pending", createdAt: AT,
      },
      {
        id: "user_rider_intake", clerkUserId: "clerk_rider_intake",
        email: "intake-rider@gridgo.test", name: "Intake Rider", role: "rider",
        verificationStatus: "pending", createdAt: AT,
      },
      {
        id: "user_business_pending", clerkUserId: "clerk_business_pending",
        email: "business@gridgo.test", name: "Business Applicant", role: "client",
        accountType: "business", orgName: "GRIDGO Buyer", createdAt: AT,
      },
    );
    store.userRoleMemberships.push(
      { userId: "user_supplier_pending", role: "supplier", createdAt: AT },
      { userId: "user_supplier_incomplete", role: "supplier", createdAt: AT },
      { userId: "user_rider_intake", role: "rider", createdAt: AT },
      { userId: "user_business_pending", role: "client", createdAt: AT },
    );
    store.supplierProfiles.push(
      {
        userId: "user_supplier_pending", shopName: "Ready Prints", contactName: "Pending Supplier",
        shop: { lat: 7.07, lng: 125.61, label: "Ready Shop" }, pickupAvailable: false, updatedAt: AT,
      },
      {
        userId: "user_supplier_incomplete", shopName: "Draft Prints", contactName: "Incomplete Supplier",
        shop: { lat: 7.08, lng: 125.62, label: "Draft Shop" }, pickupAvailable: false, updatedAt: AT,
      },
    );
    store.riderProfiles.push({
      userId: "user_rider_intake", vehicleType: "motorcycle", plateNumber: "INTAKE-1", updatedAt: AT,
    });
    store.clientProfiles.push({
      userId: "user_business_pending", clientKind: "business",
      businessName: "GRIDGO Buyer", businessNature: "Retail", updatedAt: AT,
    });
    store.approvalCases.push(
      {
        id: "case_supplier_pending", userId: "user_supplier_pending", kind: "supplier", status: "pending",
        version: 1, applicationRevision: 1, submittedAt: "2026-08-15T00:00:00.000Z",
        createdAt: AT, updatedAt: AT,
      },
      {
        id: "case_supplier_incomplete", userId: "user_supplier_incomplete", kind: "supplier", status: "pending",
        version: 1, applicationRevision: 1, submittedAt: "2026-08-15T01:00:00.000Z",
        createdAt: AT, updatedAt: AT,
      },
      {
        id: "case_rider_intake", userId: "user_rider_intake", kind: "rider", status: "pending",
        version: 1, applicationRevision: 1, createdAt: AT, updatedAt: AT,
      },
      {
        id: "case_business_pending", userId: "user_business_pending", kind: "business_client", status: "pending",
        version: 1, applicationRevision: 1, submittedAt: "2026-08-15T02:00:00.000Z",
        createdAt: AT, updatedAt: AT,
      },
    );
    store.supplierServices.push(
      {
        id: "svc_pending_complete", supplierId: "user_supplier_pending",
        categoryCode: "marketing_collateral", state: "pending_verification",
        pricingBasis: "per_unit", referenceRateMinor: 2500, turnaroundHours: 24,
        materialCodes: [], finishCodes: [], productFamilyIds: ["business_cards"], zones: [],
        createdAt: AT, updatedAt: AT,
      },
      {
        id: "svc_pending_incomplete", supplierId: "user_supplier_pending",
        categoryCode: "marketing_collateral", state: "pending_verification",
        pricingBasis: "", referenceRateMinor: 2500, turnaroundHours: 24,
        materialCodes: [], finishCodes: [], productFamilyIds: [], zones: [],
        createdAt: AT, updatedAt: AT,
      },
    );
    await saveStore(database, store);
  });
}

test("fixed auth projections authorize every state from memberships and approval cases", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_no_membership", clerkUserId: "clerk_no_membership",
      email: "nomembership@gridgo.test", name: "No Membership",
      role: "super_admin", createdAt: AT,
    });
    for (const status of ["pending", "rejected", "suspended"]) {
      const userId = `user_supplier_${status}`;
      store.users.push({
        id: userId, clerkUserId: `clerk_supplier_${status}`,
        email: `supplier-${status}@gridgo.test`, name: `Supplier ${status}`,
        role: "supplier", verificationStatus: status, createdAt: AT,
      });
      store.userRoleMemberships.push({ userId, role: "supplier", createdAt: AT });
      store.supplierProfiles.push({
        userId, shopName: `Shop ${status}`, contactName: `Supplier ${status}`,
        shop: { lat: 7.064, lng: 125.6085, label: `Davao ${status}` },
        pickupAvailable: false, updatedAt: AT,
      });
      store.approvalCases.push({
        id: `case_supplier_${status}`, userId, kind: "supplier", status,
        version: 2, applicationRevision: 1, submittedAt: AT,
        ...(status === "rejected" ? { decidedAt: AT, rejectionReason: "Fix the application" } : {}),
        ...(status === "suspended" ? { decidedAt: AT, suspensionReason: "Account review" } : {}),
        createdAt: AT, updatedAt: AT,
      });
    }
    await saveStore(database, store);
  });

  const instance = await startApi();
  try {
    const noMembership = await request(instance.api, "/auth/me", {
      subject: "clerk_no_membership",
      claims: {
        gridgo_role: "super_admin",
        role: "super_admin",
        approvalStatus: "approved",
        public_metadata: { gridgoRole: "super_admin", status: "approved" },
      },
    });
    assert.equal(noMembership.status, 200, JSON.stringify(noMembership.body));
    assert.deepEqual(noMembership.body.memberships, []);
    assert.deepEqual(noMembership.body.approvalCases, []);
    assert.equal((await request(instance.api, "/auth/me/supplier", { subject: "clerk_no_membership" })).body.error, "supplier_account_not_found");
    const noAdmin = await request(instance.api, "/auth/me/admin", {
      subject: "clerk_no_membership", claims: { gridgo_role: "super_admin" },
    });
    assert.equal(noAdmin.status, 403);
    assert.equal(noAdmin.body.error, "membership_required");
    assert.equal(noAdmin.body.requiredRole, "super_admin");
    assert.equal((await request(instance.api, "/users", { subject: "clerk_no_membership" })).status, 403);

    for (const status of ["pending", "approved", "rejected", "suspended"]) {
      const subject = status === "approved" ? "clerk_supplier" : `clerk_supplier_${status}`;
      const projection = await request(instance.api, "/auth/me/supplier", {
        subject,
        ...(status === "pending" ? {
          claims: { approvalStatus: "approved", public_metadata: { status: "approved" } },
        } : {}),
      });
      assert.equal(projection.status, 200, JSON.stringify(projection.body));
      assert.deepEqual(projection.body.membership, { role: "supplier" });
      assert.equal(Object.hasOwn(projection.body.user, "role"), false);
      assert.equal(Object.hasOwn(projection.body.user, "clerkUserId"), false);
      assert.equal(projection.body.supplierProfile.shopName, status === "approved" ? "Print Shop" : `Shop ${status}`);
      assert.equal(projection.body.approvalCase.status, status);
      assert.equal(projection.body.approvalCase.rejectionReason, status === "rejected" ? "Fix the application" : null);
      assert.equal(projection.body.approvalCase.suspensionReason, status === "suspended" ? "Account review" : null);
      assert.equal(projection.body.capabilities.receiveJobOffers, status === "approved");
      assert.equal(projection.body.capabilities.acceptJobs, status === "approved");
      assert.equal(projection.body.capabilities.editCatalogue, status !== "suspended");
      assert.equal(typeof projection.body.readiness.readyForApproval, "boolean");
      assert.ok(Array.isArray(projection.body.readiness.missing));
    }

    const client = await request(instance.api, "/auth/me/client", { subject: "clerk_client" });
    assert.equal(client.status, 200, JSON.stringify(client.body));
    assert.equal(client.body.clientProfile.clientKind, "personal");
    assert.equal(client.body.approvalCase, null);
    assert.equal(client.body.capabilities.placePersonalOrders, true);
    assert.equal(client.body.capabilities.placeBusinessOrders, false);

    const rider = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider" });
    assert.equal(rider.status, 200, JSON.stringify(rider.body));
    assert.equal(rider.body.riderProfile.vehicleType, "motorcycle");
    assert.equal(rider.body.approvalCase.status, "approved");
    assert.equal(rider.body.documents.length, 1);
    assert.equal(rider.body.documents[0].kind, "drivers_license");
    assert.equal(rider.body.capabilities.receiveDispatchOffers, true);

    assert.equal((await request(instance.api, "/auth/me/ops", { subject: "clerk_ops" })).status, 200);
    assert.equal((await request(instance.api, "/auth/me/admin", { subject: "clerk_super" })).status, 200);
    assert.equal((await request(instance.api, "/auth/me/ops", { subject: "clerk_super" })).status, 403);
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("client account profile routes persist versioned edits and an idempotent business upgrade", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    assert.equal((await request(instance.api, "/me")).status, 401);
    const initial = await request(instance.api, "/me", { subject: "clerk_client" });
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.user.version, 1);
    assert.equal(initial.body.user.accountType, "individual");

    const patched = await request(instance.api, "/me", {
      method: "PATCH",
      subject: "clerk_client",
      body: { expectedVersion: 1, name: "Ana Client", phone: "0918 765 4321" },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.user.name, "Ana Client");
    assert.equal(patched.body.user.phone, "+639187654321");
    assert.equal(patched.body.user.version, 2);

    const stale = await request(instance.api, "/me", {
      method: "PATCH",
      subject: "clerk_client",
      body: { expectedVersion: 1, name: "Stale Client" },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error, "account_version_conflict");
    assert.equal(stale.body.currentVersion, 2);

    const missingBusinessName = await request(instance.api, "/me/business-apply", {
      method: "POST",
      subject: "clerk_client",
      body: { accountType: "business" },
    });
    assert.equal(missingBusinessName.status, 400, JSON.stringify(missingBusinessName.body));
    assert.equal(missingBusinessName.body.error, "invalid_account_profile");
    assert.equal(missingBusinessName.body.field, "businessName");

    const application = {
      accountType: "business",
      businessName: "GRIDGO Business Customer",
      address: {
        label: "Office",
        addressLine: "123 Rizal Street",
        point: { lat: 7.0731, lng: 125.6128 },
        isDefault: true,
      },
    };
    const business = await request(instance.api, "/me/business-apply", {
      method: "POST", subject: "clerk_client", body: application,
    });
    const retry = await request(instance.api, "/me/business-apply", {
      method: "POST", subject: "clerk_client", body: application,
    });
    assert.equal(business.status, 200, JSON.stringify(business.body));
    assert.equal(business.body.user.accountType, "business");
    assert.equal(business.body.user.orgName, "GRIDGO Business Customer");
    assert.equal(business.body.user.version, 3);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.user.version, 3);

    const individual = await request(instance.api, "/me", {
      method: "PATCH",
      subject: "clerk_promote",
      body: { expectedVersion: 1, name: "Personal Client" },
    });
    assert.equal(individual.status, 200, JSON.stringify(individual.body));
    assert.equal(individual.body.user.accountType, "individual");
    assert.equal(Object.hasOwn(individual.body.user, "orgName"), false);

    const persisted = await loadStore(database);
    const account = persisted.users.find(({ id }) => id === "user_client");
    assert.equal(account.name, "Ana Client");
    assert.equal(account.version, 3);
    assert.equal(account.accountType, "business");
    assert.equal(account.orgName, "GRIDGO Business Customer");
    assert.equal(persisted.clientAddresses.filter(({ clientId }) => clientId === account.id).length, 1);
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("legacy verification decisions keep approval cases and fixed projections consistent", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_supplier_applicant", clerkUserId: "clerk_supplier_applicant",
      email: "applicant@gridgo.test", name: "Applicant", role: "supplier",
      verificationStatus: "pending", createdAt: AT,
    });
    store.userRoleMemberships.push({ userId: "user_supplier_applicant", role: "supplier", createdAt: AT });
    store.supplierProfiles.push({
      userId: "user_supplier_applicant", shopName: "Applicant Shop", contactName: "Applicant",
      shop: { lat: 7.064, lng: 125.6085, label: "Davao Applicant" },
      pickupAvailable: false, updatedAt: AT,
    });
    store.approvalCases.push({
      id: "case_supplier_applicant", userId: "user_supplier_applicant", kind: "supplier",
      status: "pending", version: 1, applicationRevision: 1, submittedAt: AT,
      createdAt: AT, updatedAt: AT,
    });
    await saveStore(database, store);
  });

  const instance = await startApi();
  try {
    const before = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier_applicant" });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.approvalCase.status, "pending");
    assert.equal(before.body.capabilities.receiveJobOffers, false);

    const approved = await request(instance.api, "/users/user_supplier_applicant/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "approved" },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.user.verificationStatus, "approved");
    assert.ok(Array.isArray(approved.body.verificationDocuments));

    const approvedProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier_applicant" });
    assert.equal(approvedProjection.body.approvalCase.status, "approved");
    assert.equal(approvedProjection.body.capabilities.receiveJobOffers, true);
    assert.equal(approvedProjection.body.capabilities.acceptJobs, true);

    const suspended = await request(instance.api, "/users/user_supplier/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "suspended", reason: "Quality hold" },
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    const suspendedProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(suspendedProjection.body.approvalCase.status, "suspended");
    assert.equal(suspendedProjection.body.approvalCase.suspensionReason, "Quality hold");
    assert.equal(suspendedProjection.body.capabilities.receiveJobOffers, false);
    assert.equal(suspendedProjection.body.capabilities.editCatalogue, false);

    const riderSuspended = await request(instance.api, "/users/user_rider/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "suspended", reason: "Documents expired" },
    });
    assert.equal(riderSuspended.status, 200, JSON.stringify(riderSuspended.body));
    const riderProjection = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider" });
    assert.equal(riderProjection.body.approvalCase.status, "suspended");
    assert.equal(riderProjection.body.capabilities.receiveDispatchOffers, false);

    const riderRestored = await request(instance.api, "/users/user_rider/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "approved" },
    });
    assert.equal(riderRestored.status, 200, JSON.stringify(riderRestored.body));
    const restoredProjection = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider" });
    assert.equal(restoredProjection.body.approvalCase.status, "approved");
    assert.equal(restoredProjection.body.approvalCase.suspensionReason, null);
    assert.equal(restoredProjection.body.capabilities.receiveDispatchOffers, true);

    const reset = await request(instance.api, "/users/user_supplier_applicant/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "unverified" },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const resetProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier_applicant" });
    assert.equal(resetProjection.body.approvalCase.status, "pending");
    assert.equal(resetProjection.body.approvalCase.decidedAt, null);
    assert.equal(resetProjection.body.capabilities.receiveJobOffers, false);

    assert.equal((await request(instance.api, "/users/user_promote/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "supplier" },
    })).status, 200);
    const promotedDecision = await request(instance.api, "/users/user_promote/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "approved" },
    });
    assert.equal(promotedDecision.status, 200, JSON.stringify(promotedDecision.body));
    const promotedProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_promote" });
    assert.equal(promotedProjection.status, 200, JSON.stringify(promotedProjection.body));
    assert.equal(promotedProjection.body.approvalCase.status, "approved");
    assert.equal(promotedProjection.body.capabilities.receiveJobOffers, true);

    const persisted = await loadStore(database);
    const supplierCase = persisted.approvalCases.find((approvalCase) => approvalCase.id === "case_supplier");
    assert.equal(supplierCase.status, "suspended");
    assert.equal(supplierCase.decidedBy, "user_ops");
    const supplierEvents = persisted.approvalCaseEvents.filter((event) => event.approvalCaseId === "case_supplier");
    assert.equal(supplierEvents.length, 1);
    assert.equal(supplierEvents[0].fromStatus, "approved");
    assert.equal(supplierEvents[0].toStatus, "suspended");
    assert.equal(supplierEvents[0].actorKind, "approver");
    assert.equal(supplierEvents[0].actorUserId, "user_ops");
    const promotedCase = persisted.approvalCases.find(
      (approvalCase) => approvalCase.userId === "user_promote" && approvalCase.kind === "supplier",
    );
    assert.equal(promotedCase.status, "approved");
    assert.equal(promotedCase.decidedBy, "user_ops");
    assert.equal(
      persisted.auditLog.some(
        (entry) => entry.action === "user.verification" && entry.entityId === "user_supplier",
      ),
      true,
    );
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("legacy sync bumps case versions and demoted applicants get an explicit 409", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    const riderSuspended = await request(instance.api, "/users/user_rider/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "suspended", reason: "Documents expired" },
    });
    assert.equal(riderSuspended.status, 200, JSON.stringify(riderSuspended.body));

    const staleRestore = await request(instance.api, "/approval-cases/case_rider/restore", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "restore-stale", note: "Stale restore" },
    });
    assert.equal(staleRestore.status, 409, JSON.stringify(staleRestore.body));
    assert.equal(staleRestore.body.error, "approval_case_stale");

    const freshRestore = await request(instance.api, "/approval-cases/case_rider/restore", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 2, requestId: "restore-fresh", note: "Documents renewed" },
    });
    assert.equal(freshRestore.status, 200, JSON.stringify(freshRestore.body));
    assert.equal(freshRestore.body.approvalCase.version, 3);
    assert.equal(freshRestore.body.approvalCase.status, "approved");

    const demoted = await request(instance.api, "/users/user_supplier/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "client" },
    });
    assert.equal(demoted.status, 200, JSON.stringify(demoted.body));

    const suspendDemoted = await request(instance.api, "/approval-cases/case_supplier/suspend", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "suspend-demoted", reason: "Post-departure review" },
    });
    assert.equal(suspendDemoted.status, 409, JSON.stringify(suspendDemoted.body));
    assert.equal(suspendDemoted.body.error, "approval_case_role_mismatch");

    const repromoted = await request(instance.api, "/users/user_supplier/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "supplier" },
    });
    assert.equal(repromoted.status, 200, JSON.stringify(repromoted.body));
    const repromotedDetail = await request(instance.api, "/approval-cases/case_supplier", { subject: "clerk_ops" });
    assert.equal(repromotedDetail.status, 200, JSON.stringify(repromotedDetail.body));
    assert.equal(repromotedDetail.body.approvalCase.status, "pending");
    assert.equal(repromotedDetail.body.approvalCase.version, 2, JSON.stringify(repromotedDetail.body.approvalCase));

    const staleApprove = await request(instance.api, "/approval-cases/case_supplier/approve", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "approve-stale" },
    });
    assert.equal(staleApprove.status, 409, JSON.stringify(staleApprove.body));
    assert.equal(staleApprove.body.error, "approval_case_stale");

    const persisted = await loadStore(database);
    const supplierCase = persisted.approvalCases.find((candidate) => candidate.id === "case_supplier");
    assert.equal(supplierCase.status, "pending");
    assert.equal(supplierCase.version, 2);
    assert.equal(
      persisted.approvalCaseEvents.some((event) => event.requestId === "suspend-demoted"),
      false,
    );
    assert.equal(persisted.supplierServices.find((candidate) => candidate.id === "svc_banner").state, "live");
    const supplierUser = persisted.users.find((candidate) => candidate.id === "user_supplier");
    assert.equal(supplierUser.role, "supplier");
    assert.equal(supplierUser.verificationStatus, "unverified");
    const riderUser = persisted.users.find((candidate) => candidate.id === "user_rider");
    assert.equal(riderUser.verificationStatus, "approved");
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("approval audit authority follows the selected role and implicit Super Admin precedence", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.userRoleMemberships.push({ userId: "user_ops", role: "super_admin", createdAt: AT });
    await saveStore(database, store);
  });
  const instance = await startApi();
  try {
    const decisions = [
      { action: "suspend", role: "ops_admin", authority: "ops_admin" },
      { action: "restore", role: "super_admin", authority: "super_admin" },
      { action: "suspend", role: undefined, authority: "super_admin" },
    ];
    for (const [index, decision] of decisions.entries()) {
      const requestId = `selected-authority-${index}`;
      const response = await request(instance.api, `/approval-cases/case_rider/${decision.action}`, {
        method: "POST", subject: "clerk_ops",
        headers: decision.role ? { "X-GRIDGO-Role": decision.role } : {},
        body: { expectedVersion: index + 1, requestId, reason: "Review evidence" },
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const persisted = await loadStore(database);
      const audit = persisted.auditLog.find((entry) => entry.detail?.requestId === requestId);
      assert.ok(audit);
      assert.equal(audit.actorId, "user_ops");
      assert.equal(audit.actorRole, decision.authority);
    }
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("canonical rider decisions enforce readiness after replay handling", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    const suspended = await request(instance.api, "/approval-cases/case_rider/suspend", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "rider-readiness-suspend", reason: "Evidence review" },
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

    const restored = await request(instance.api, "/approval-cases/case_rider/restore", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 2, requestId: "rider-readiness-restore", note: "Evidence ready" },
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.approvalCase.status, "approved");

    await database.transaction(async () => {
      const store = await loadStore(database);
      const file = store.files.find((candidate) => candidate.fileId === "file_rider_license_fixture");
      file.state = "delete_pending";
      invalidateRiderDocumentsForFile(store, file, AT);
      markFileDeleted(file, AT);
      await saveStore(database, store);
    });

    const replayed = await request(instance.api, "/approval-cases/case_rider/restore", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 2, requestId: "rider-readiness-restore", note: "Evidence ready" },
    });
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.equal(replayed.body.replayed, true);

    const resuspended = await request(instance.api, "/approval-cases/case_rider/suspend", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 3, requestId: "rider-readiness-resuspend", reason: "Evidence removed" },
    });
    assert.equal(resuspended.status, 200, JSON.stringify(resuspended.body));

    const blockedRestore = await request(instance.api, "/approval-cases/case_rider/restore", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 4, requestId: "rider-readiness-blocked-restore", note: "Try restore" },
    });
    assert.equal(blockedRestore.status, 409, JSON.stringify(blockedRestore.body));
    assert.equal(blockedRestore.body.error, "rider_documents_incomplete");

    const reset = await request(instance.api, "/users/user_rider/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "unverified" },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    const blockedApproval = await request(instance.api, "/approval-cases/case_rider/approve", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 5, requestId: "rider-readiness-blocked-approve" },
    });
    assert.equal(blockedApproval.status, 409, JSON.stringify(blockedApproval.body));
    assert.equal(blockedApproval.body.error, "rider_documents_incomplete");

    const persisted = await loadStore(database);
    const approvalCase = persisted.approvalCases.find((candidate) => candidate.id === "case_rider");
    assert.equal(approvalCase.status, "pending");
    assert.equal(approvalCase.version, 5);
    assert.equal(
      persisted.approvalCaseEvents.some(
        (event) => ["rider-readiness-blocked-restore", "rider-readiness-blocked-approve"].includes(event.requestId),
      ),
      false,
    );
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("approval queue, detail, and supplier decisions follow the settled transactional contract", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await addApprovalDecisionFixtures(database);
  const instance = await startApi();
  try {
    const denied = await request(instance.api, "/approval-cases?status=pending", { subject: "clerk_client" });
    assert.equal(denied.status, 403);

    const queue = await request(instance.api, "/approval-cases?status=pending&kind=supplier", { subject: "clerk_ops" });
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    assert.deepEqual(queue.body.approvalCases.map((approvalCase) => approvalCase.id), [
      "case_supplier_pending",
      "case_supplier_incomplete",
    ]);
    assert.equal(queue.body.nextCursor, null);

    const allPending = await request(instance.api, "/approval-cases?status=pending", { subject: "clerk_super" });
    assert.equal(allPending.status, 200, JSON.stringify(allPending.body));
    assert.equal(allPending.body.approvalCases.some((approvalCase) => approvalCase.id === "case_rider_intake"), false);

    const businessDetail = await request(instance.api, "/approval-cases/case_business_pending", { subject: "clerk_ops" });
    assert.equal(businessDetail.status, 200, JSON.stringify(businessDetail.body));
    assert.equal(businessDetail.body.clientProfile.businessName, "GRIDGO Buyer");
    const riderDetail = await request(instance.api, "/approval-cases/case_rider_intake", { subject: "clerk_ops" });
    assert.equal(riderDetail.status, 200, JSON.stringify(riderDetail.body));
    assert.equal(riderDetail.body.riderProfile.plateNumber, "INTAKE-1");
    assert.deepEqual(riderDetail.body.riderDocuments, []);

    const detail = await request(instance.api, "/approval-cases/case_supplier_pending", { subject: "clerk_ops" });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.applicant.id, "user_supplier_pending");
    assert.equal(detail.body.supplierProfile.shopName, "Ready Prints");
    assert.deepEqual(detail.body.categories, ["marketing_collateral"]);
    assert.deepEqual(detail.body.readiness.publishableServiceIds, ["svc_pending_complete"]);
    assert.equal(JSON.stringify(detail.body).toLowerCase().includes("commission"), false);

    const commissionInput = await request(instance.api, "/approval-cases/case_supplier_pending/approve", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "approval-with-commission", commissionPercent: 10 },
    });
    assert.equal(commissionInput.status, 400);
    assert.equal(commissionInput.body.error, "unexpected_field");

    const incomplete = await request(instance.api, "/approval-cases/case_supplier_incomplete/approve", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "approval-incomplete" },
    });
    assert.equal(incomplete.status, 409, JSON.stringify(incomplete.body));
    assert.equal(incomplete.body.error, "supplier_profile_incomplete");
    assert.deepEqual(incomplete.body.missing, ["review_ready_service_line"]);

    const blankRejection = await request(instance.api, "/approval-cases/case_supplier_incomplete/reject", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "reject-blank", reason: " " },
    });
    assert.equal(blankRejection.status, 400);
    assert.equal(blankRejection.body.error, "reason_required");
    const rejected = await request(instance.api, "/approval-cases/case_supplier_incomplete/reject", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "reject-incomplete", reason: "Add a complete service line" },
    });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.approvalCase.status, "rejected");

    const approved = await request(instance.api, "/approval-cases/case_supplier_pending/approve", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 1, requestId: "approval-winner", note: "Ready for launch" },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.approvalCase.status, "approved");
    assert.equal(approved.body.approvalCase.version, 2);
    assert.deepEqual(approved.body.publishedServiceIds, ["svc_pending_complete"]);
    assert.equal(approved.body.replayed, false);

    const replayed = await request(instance.api, "/approval-cases/case_supplier_pending/approve", {
      method: "POST", subject: "clerk_super",
      body: { expectedVersion: 1, requestId: "approval-winner", note: "Ready for launch" },
    });
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.equal(replayed.body.replayed, true);
    assert.deepEqual(replayed.body.publishedServiceIds, ["svc_pending_complete"]);

    const blankSuspension = await request(instance.api, "/approval-cases/case_supplier_pending/suspend", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 2, requestId: "suspend-blank", reason: "   " },
    });
    assert.equal(blankSuspension.status, 400);
    assert.equal(blankSuspension.body.error, "reason_required");

    const suspended = await request(instance.api, "/approval-cases/case_supplier_pending/suspend", {
      method: "POST", subject: "clerk_ops",
      body: { expectedVersion: 2, requestId: "suspend-account", reason: "Safety review" },
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.approvalCase.status, "suspended");
    assert.deepEqual(suspended.body.suspendedServiceIds, ["svc_pending_complete"]);

    const restored = await request(instance.api, "/approval-cases/case_supplier_pending/restore", {
      method: "POST", subject: "clerk_super",
      body: { expectedVersion: 3, requestId: "restore-account", note: "Account review cleared" },
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.approvalCase.status, "approved");

    const beforeLineReview = (await request(instance.api, "/supplier-services/svc_pending_complete", {
      subject: "clerk_ops",
    })).body.service;
    assert.equal(beforeLineReview.state, "suspended");
    const lineRestored = await request(instance.api, "/supplier-services/svc_pending_complete/verify", {
      method: "POST", subject: "clerk_ops", body: { reason: "Line reviewed" },
    });
    assert.equal(lineRestored.status, 200, JSON.stringify(lineRestored.body));
    assert.equal(lineRestored.body.service.state, "live");

    const persisted = await loadStore(database);
    const caseEvents = persisted.approvalCaseEvents.filter((event) => event.approvalCaseId === "case_supplier_pending");
    const caseNotices = persisted.notifications.filter((notice) => notice.approvalCaseId === "case_supplier_pending");
    const caseAudits = persisted.auditLog.filter((entry) => entry.entityId === "case_supplier_pending");
    assert.equal(caseEvents.length, 3);
    assert.equal(caseNotices.length, 3);
    assert.equal(caseAudits.length, 3);
    assert.deepEqual(caseEvents.map((event) => event.requestId), [
      "approval-winner",
      "suspend-account",
      "restore-account",
    ]);
    const service = persisted.supplierServices.find((candidate) => candidate.id === "svc_pending_complete");
    assert.equal(service.state, "live");
    assert.equal(service.approvalSuspensionPreviousState, undefined);
    assert.equal(persisted.supplierServices.find((candidate) => candidate.id === "svc_pending_incomplete").state, "pending_verification");
    assert.equal(persisted.users.find((candidate) => candidate.id === "user_supplier_pending").verificationStatus, "approved");
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("racing approval decisions have one PostgreSQL winner and one set of side effects", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    const rider = store.users.find((user) => user.id === "user_rider");
    rider.verificationStatus = "pending";
    const approvalCase = store.approvalCases.find((candidate) => candidate.id === "case_rider");
    approvalCase.status = "pending";
    approvalCase.version = 1;
    delete approvalCase.decidedAt;
    delete approvalCase.decidedBy;
    await saveStore(database, store);
  });
  const firstApi = await startApi();
  const secondApi = await startApi();
  try {
    const [approve, reject] = await Promise.all([
      request(firstApi.api, "/approval-cases/case_rider/approve", {
        method: "POST", subject: "clerk_ops",
        body: { expectedVersion: 1, requestId: "race-approve" },
      }),
      request(secondApi.api, "/approval-cases/case_rider/reject", {
        method: "POST", subject: "clerk_super",
        body: { expectedVersion: 1, requestId: "race-reject", reason: "Race rejection" },
      }),
    ]);
    assert.deepEqual([approve.status, reject.status].sort(), [200, 409]);
    const loser = approve.status === 409 ? approve : reject;
    assert.equal(loser.body.error, "approval_already_decided", JSON.stringify(loser.body));

    const persisted = await loadStore(database);
    const events = persisted.approvalCaseEvents.filter((event) => event.approvalCaseId === "case_rider");
    const notices = persisted.notifications.filter((notice) => notice.approvalCaseId === "case_rider");
    const audits = persisted.auditLog.filter((entry) => entry.entityId === "case_rider");
    assert.equal(events.length, 1);
    assert.equal(notices.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(persisted.approvalCases.find((candidate) => candidate.id === "case_rider").version, 2);
  } finally {
    for (const instance of [firstApi, secondApi]) instance.child.kill("SIGTERM");
    await Promise.all([firstApi, secondApi].map(
      (instance) => new Promise((resolve) => instance.child.once("exit", resolve)),
    ));
    await database.close();
  }
});

test("role demotion and re-promotion reset the approval case so a returnee re-earns approval", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    const demoted = await request(instance.api, "/users/user_supplier/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "client", reason: "offboarding" },
    });
    assert.equal(demoted.status, 200, JSON.stringify(demoted.body));
    assert.equal(demoted.body.user.role, "client");
    const demotedProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(demotedProjection.status, 403);
    assert.equal(demotedProjection.body.error, "supplier_account_not_found");

    const repromoted = await request(instance.api, "/users/user_supplier/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "supplier", reason: "returning" },
    });
    assert.equal(repromoted.status, 200, JSON.stringify(repromoted.body));
    assert.equal(repromoted.body.user.verificationStatus, "unverified");
    const repromotedProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(repromotedProjection.status, 200, JSON.stringify(repromotedProjection.body));
    assert.equal(repromotedProjection.body.approvalCase.status, "pending");
    assert.equal(repromotedProjection.body.approvalCase.decidedAt, null);
    assert.equal(repromotedProjection.body.capabilities.receiveJobOffers, false);
    assert.equal(repromotedProjection.body.capabilities.acceptJobs, false);

    assert.equal((await request(instance.api, "/users/user_rider/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "client" },
    })).status, 200);
    const riderBack = await request(instance.api, "/users/user_rider/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "rider" },
    });
    assert.equal(riderBack.status, 200, JSON.stringify(riderBack.body));
    assert.equal(riderBack.body.user.verificationStatus, "unverified");
    const riderProjection = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider" });
    assert.equal(riderProjection.status, 200, JSON.stringify(riderProjection.body));
    assert.equal(riderProjection.body.approvalCase.status, "pending");
    assert.equal(riderProjection.body.capabilities.receiveDispatchOffers, false);

    const blankSuspend = await request(instance.api, "/users/user_supplier/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "suspended", reason: "   " },
    });
    assert.equal(blankSuspend.status, 200, JSON.stringify(blankSuspend.body));
    const suspendedProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(suspendedProjection.body.approvalCase.status, "suspended");
    assert.equal(suspendedProjection.body.approvalCase.suspensionReason, "Verification suspended");

    const blankReject = await request(instance.api, "/users/user_rider/verification", {
      method: "POST", subject: "clerk_ops", body: { status: "rejected", reason: "   " },
    });
    assert.equal(blankReject.status, 200, JSON.stringify(blankReject.body));
    const rejectedProjection = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider" });
    assert.equal(rejectedProjection.body.approvalCase.status, "rejected");
    assert.equal(rejectedProjection.body.approvalCase.rejectionReason, "Verification rejected");

    const persisted = await loadStore(database);
    const supplierCase = persisted.approvalCases.find((approvalCase) => approvalCase.id === "case_supplier");
    assert.equal(supplierCase.status, "suspended");
    const supplierEvents = persisted.approvalCaseEvents.filter((event) => event.approvalCaseId === "case_supplier");
    assert.equal(supplierEvents.length, 2);
    assert.ok(supplierEvents.some((event) => event.fromStatus === "approved" && event.toStatus === "pending"));
    assert.ok(supplierEvents.some((event) => event.fromStatus === "pending" && event.toStatus === "suspended"));
    assert.equal(supplierEvents.every((event) => event.reason == null), true);
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("direct supplier and rider role switches never transfer approval across kinds", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    const switched = await request(instance.api, "/users/user_supplier/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "rider", reason: "kind switch" },
    });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.user.role, "rider");
    assert.equal(switched.body.user.verificationStatus, "unverified");
    assert.equal(Object.hasOwn(switched.body.user, "verifiedAt"), false);
    const supplierGone = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(supplierGone.status, 403);
    assert.equal(supplierGone.body.error, "supplier_account_not_found");
    const asRider = await request(instance.api, "/auth/me/rider", { subject: "clerk_supplier" });
    assert.equal(asRider.status, 200, JSON.stringify(asRider.body));
    assert.deepEqual(asRider.body.membership, { role: "rider" });
    assert.equal(asRider.body.approvalCase, null);
    assert.equal(asRider.body.capabilities.receiveDispatchOffers, false);
    assert.equal(asRider.body.capabilities.acceptAssignments, false);

    const switchedBack = await request(instance.api, "/users/user_supplier/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "supplier", reason: "switch back" },
    });
    assert.equal(switchedBack.status, 200, JSON.stringify(switchedBack.body));
    assert.equal(switchedBack.body.user.verificationStatus, "unverified");
    const backProjection = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(backProjection.status, 200, JSON.stringify(backProjection.body));
    assert.equal(backProjection.body.approvalCase.status, "pending");
    assert.equal(backProjection.body.approvalCase.decidedAt, null);
    assert.equal(backProjection.body.capabilities.receiveJobOffers, false);
    assert.equal(backProjection.body.capabilities.acceptJobs, false);

    const riderSwitch = await request(instance.api, "/users/user_rider/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "supplier" },
    });
    assert.equal(riderSwitch.status, 200, JSON.stringify(riderSwitch.body));
    assert.equal(riderSwitch.body.user.verificationStatus, "unverified");
    const riderAsSupplier = await request(instance.api, "/auth/me/supplier", { subject: "clerk_rider" });
    assert.equal(riderAsSupplier.status, 200, JSON.stringify(riderAsSupplier.body));
    assert.equal(riderAsSupplier.body.approvalCase, null);
    assert.equal(riderAsSupplier.body.capabilities.receiveJobOffers, false);
    assert.equal((await request(instance.api, "/users/user_rider/role", {
      method: "PATCH", subject: "clerk_super", body: { role: "rider" },
    })).status, 200);
    const riderBackProjection = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider" });
    assert.equal(riderBackProjection.status, 200, JSON.stringify(riderBackProjection.body));
    assert.equal(riderBackProjection.body.approvalCase.status, "pending");
    assert.equal(riderBackProjection.body.capabilities.receiveDispatchOffers, false);

    const persisted = await loadStore(database);
    const supplierCase = persisted.approvalCases.find((approvalCase) => approvalCase.id === "case_supplier");
    assert.equal(supplierCase.status, "pending");
    assert.equal(supplierCase.decidedAt, undefined);
    assert.equal(supplierCase.decidedBy, undefined);
    const riderCase = persisted.approvalCases.find((approvalCase) => approvalCase.id === "case_rider");
    assert.equal(riderCase.status, "pending");
    const resetEvents = persisted.approvalCaseEvents.filter(
      (event) => event.fromStatus === "approved" && event.toStatus === "pending",
    );
    assert.deepEqual(
      resetEvents.map((event) => event.approvalCaseId).sort(),
      ["case_rider", "case_supplier"],
    );
    const finalUsers = persisted.users.filter((candidate) => ["user_supplier", "user_rider"].includes(candidate.id));
    for (const candidate of finalUsers) {
      assert.equal(candidate.verificationStatus, "unverified");
      assert.equal(candidate.verifiedAt, undefined);
      assert.equal(candidate.verifiedBy, undefined);
    }
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("PostgreSQL-backed order, payment, role, and payout behavior survives API restart", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  let instance = await startApi();
  try {
    const health = await request(instance.api, "/health");
    assert.equal(health.body.database.status, "available");
    assert.equal(health.body.commit, "api-postgres-test");
    assert.equal((await request(instance.api, "/orders")).status, 401);
    assert.equal((await request(instance.api, "/orders", { method: "POST", subject: "clerk_supplier", body: { productId: "prod_tarpaulin" } })).status, 403);
    assert.equal((await request(instance.api, "/auth/login", { method: "POST", body: { email: "client@gridgo.test", password: "anything" } })).status, 404);
    assert.equal((await request(instance.api, "/auth/signup", { method: "POST", body: {} })).status, 404);

    const promoted = await request(instance.api, "/users/user_promote/role", { method: "PATCH", subject: "clerk_super", body: { role: "supplier", reason: "approved onboarding" } });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.user.role, "supplier");
    assert.equal(promoted.body.user.verificationStatus, "unverified");
    assert.equal(Object.hasOwn(promoted.body.user, "accountType"), false);
    const promotedIdentity = await request(instance.api, "/auth/me", { subject: "clerk_promote" });
    assert.equal(promotedIdentity.body.user.role, "supplier");
    assert.deepEqual(promotedIdentity.body.memberships, [{ role: "supplier" }]);
    const promotedStore = await loadStoreEventually(
      database,
      (store) => store.userRoleMemberships.some(
        (membership) => membership.userId === "user_promote" && membership.role === "supplier",
      ),
    );
    assert.deepEqual(
      promotedStore.userRoleMemberships
        .filter((membership) => membership.userId === "user_promote")
        .map((membership) => membership.role),
      ["supplier"],
    );
    assert.equal(
      promotedStore.auditLog.some(
        (entry) => entry.action === "user.role_change" && entry.entityId === "user_promote",
      ),
      true,
    );

    const demoted = await request(instance.api, "/users/user_super/role", { method: "PATCH", subject: "clerk_super", body: { role: "client" } });
    assert.equal(demoted.status, 409, JSON.stringify(demoted.body));
    assert.equal(demoted.body.error, "last_super_admin");
    assert.equal((await request(instance.api, "/auth/me", { subject: "clerk_super" })).body.user.role, "super_admin");

    const movedShopPoint = { lat: 7.065, lng: 125.609, label: "Updated Davao Shop" };
    const movedShop = await request(instance.api, "/users/user_supplier/shop", {
      method: "PATCH", subject: "clerk_supplier", body: { shop: movedShopPoint },
    });
    assert.equal(movedShop.status, 200, JSON.stringify(movedShop.body));
    assert.deepEqual(movedShop.body.user.shop, movedShopPoint);
    const movedShopStore = await loadStoreEventually(
      database,
      (store) => store.supplierProfiles.some(
        (profile) => profile.userId === "user_supplier" && profile.shop.label === movedShopPoint.label,
      ),
    );
    assert.deepEqual(
      movedShopStore.supplierProfiles.find((profile) => profile.userId === "user_supplier").shop,
      movedShopPoint,
    );
    assert.deepEqual(movedShopStore.orders.find((order) => order.id === "ord_payout").pickup, {
      lat: 7.064, lng: 125.6085, label: "Davao Shop",
    });

    const created = await request(instance.api, "/orders", {
      method: "POST",
      subject: "clerk_client",
      body: {
        productId: "prod_tarpaulin", title: "API banner", quantity: 1,
        size: "2m x 3m", material: "13oz tarpaulin", finish: "hemmed",
        address: "Bajada", zone: "davao_central", submit: true,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.order.id;
    for (const state of ["needs_qa", "approved_for_matching"]) {
      const transitioned = await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state } });
      assert.equal(transitioned.status, 200, JSON.stringify(transitioned.body));
    }
    assert.equal((await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned", supplierId: "user_supplier" } })).status, 200);
    const payoutTerms = await request(instance.api, "/supplier-payment-terms", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { deliveryDownpaymentRateBps: 2500 },
    });
    assert.equal(payoutTerms.status, 200, JSON.stringify(payoutTerms.body));
    for (const supplierSubtotalMinor of [null, "", "100000"]) {
      const invalidSubtotal = await request(instance.api, `/orders/${orderId}/transition`, {
        method: "POST", subject: "clerk_supplier", body: { state: "supplier_accepted", supplierSubtotalMinor },
      });
      assert.equal(invalidSubtotal.status, 400);
      assert.equal(invalidSubtotal.body.error, "invalid_supplier_subtotal");
    }
    const accepted = await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_supplier", body: { state: "supplier_accepted", supplierSubtotalMinor: 100000 } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.order.state, "awaiting_checkout");
    assert.deepEqual(accepted.body.order.pendingQuote.supplierShop, movedShopPoint);
    assert.deepEqual(
      {
        size: accepted.body.order.pendingQuote.orderLines[0].size,
        material: accepted.body.order.pendingQuote.orderLines[0].material,
        finish: accepted.body.order.pendingQuote.orderLines[0].finish,
      },
      { size: "2m x 3m", material: "13oz tarpaulin", finish: "hemmed" },
    );
    const pendingWithoutReason = await request(instance.api, `/orders/${orderId}/transition`, {
      method: "POST",
      subject: "clerk_supplier",
      body: { state: "supplier_accepted", supplierSubtotalMinor: 100000 },
    });
    assert.equal(pendingWithoutReason.status, 400);
    assert.equal(pendingWithoutReason.body.error, "quote_supersession_reason_required");
    const pendingSuperseded = await request(instance.api, `/orders/${orderId}/transition`, {
      method: "POST",
      subject: "clerk_supplier",
      body: { state: "supplier_accepted", supplierSubtotalMinor: 100000, reason: "Corrected quote details" },
    });
    assert.equal(pendingSuperseded.status, 200, JSON.stringify(pendingSuperseded.body));
    assert.equal(pendingSuperseded.body.order.pendingQuote.version, 2);
    const quoteInbox = (await loadStore(database)).notifications;
    for (const [userId, appRole] of [["user_ops", "ops_admin"], ["user_super", "super_admin"]]) {
      const quoteRows = quoteInbox.filter((n) => n.orderId === orderId && n.userId === userId && n.appRole === appRole && n.type === "ops_order_progress" && n.title === `Quote ready · ${orderId}`);
      assert.equal(quoteRows.length, 2);
      assert.notEqual(quoteRows[0].occurrenceKey, quoteRows[1].occurrenceKey);
    }
    const pendingSupersessionStore = await loadStoreEventually(
      database,
      (store) => store.auditLog.some(
        (entry) => entry.action === "order.quote_superseded" && entry.orderId === orderId,
      ),
    );
    assert.equal(
      pendingSupersessionStore.auditLog.some(
        (entry) => entry.action === "order.quote_superseded"
          && entry.orderId === orderId
          && entry.reason === "Corrected quote details"
          && entry.detail.priorQuoteVersion === 1,
      ),
      true,
    );
    const pickupContained = await request(instance.api, `/orders/${orderId}/transition`, {
      method: "POST",
      subject: "clerk_client",
      body: { state: "awaiting_initial_payment", quoteVersion: 2, fulfillmentMode: "pickup", paymentPlan: "pickup_full_online" },
    });
    assert.equal(pickupContained.status, 409);
    assert.equal(pickupContained.body.error, "pickup_fulfillment_not_available");
    const committed = await request(instance.api, `/orders/${orderId}/transition`, {
      method: "POST",
      subject: "clerk_client",
      body: { state: "awaiting_initial_payment", quoteVersion: 2, fulfillmentMode: "delivery", paymentPlan: "delivery_online" },
    });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.order.state, "awaiting_initial_payment");
    assert.equal(committed.body.order.serviceFeeMinor, 10000);
    assert.deepEqual(committed.body.order.acceptedQuote.supplierShop, movedShopPoint);
    assert.equal(committed.body.order.acceptedQuote.orderLines[0].material, "13oz tarpaulin");

    const superseded = await request(instance.api, `/orders/${orderId}/transition`, {
      method: "POST",
      subject: "clerk_supplier",
      body: { state: "supplier_accepted", supplierSubtotalMinor: 120000, reason: "Client requested a revised specification" },
    });
    assert.equal(superseded.status, 200, JSON.stringify(superseded.body));
    assert.equal(superseded.body.order.state, "awaiting_checkout");
    assert.equal(superseded.body.order.pendingQuote.version, 3);
    const staleQuote = await request(instance.api, `/orders/${orderId}/transition`, {
      method: "POST",
      subject: "clerk_client",
      body: { state: "awaiting_initial_payment", quoteVersion: 2, fulfillmentMode: "delivery", paymentPlan: "delivery_online" },
    });
    assert.equal(staleQuote.status, 409);
    assert.equal(staleQuote.body.error, "quote_stale");
    const recommitted = await request(instance.api, `/orders/${orderId}/transition`, {
      method: "POST",
      subject: "clerk_client",
      body: { state: "awaiting_initial_payment", quoteVersion: 3, fulfillmentMode: "delivery", paymentPlan: "delivery_online" },
    });
    assert.equal(recommitted.status, 200, JSON.stringify(recommitted.body));
    assert.equal(recommitted.body.order.serviceFeeMinor, 12000);

    // Legacy route names remain compatibility aliases for the canonical codes.
    assert.equal((await request(instance.api, `/orders/${orderId}/payments/downpayment/submit`, { method: "POST", subject: "clerk_client", body: { method: "qr_manual", reference: "DP-API" } })).status, 200);
    assert.equal((await request(instance.api, `/orders/${orderId}/payments/downpayment/confirm`, { method: "POST", subject: "clerk_supplier", body: {} })).status, 403);
    const confirmed = await request(instance.api, `/orders/${orderId}/payments/downpayment/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.order.state, "payment_authorized");

    assert.equal((await request(instance.api, `/orders/${orderId}/payments/balance/submit`, { method: "POST", subject: "clerk_client", body: { method: "qr_manual", reference: "BAL-API" } })).status, 200);
    assert.equal((await request(instance.api, `/orders/${orderId}/payments/balance/confirm`, { method: "POST", subject: "clerk_ops", body: {} })).status, 200);
    for (const state of ["production", "supplier_self_qc", "ready_for_dispatch"]) {
      const transitioned = await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_supplier", body: { state } });
      assert.equal(transitioned.status, 200, `${JSON.stringify(transitioned.body)}\n${instance.output()}`);
      if (state === "production") {
        // Four stages of the shop's own price, and starting the press pays
        // nobody: every one of them waits for a photograph and a person.
        assert.deepEqual(
          transitioned.body.order.payoutMilestones.map(({ code, amountMinor, status }) => ({ code, amountMinor, status })),
          [
            { code: "printing", amountMinor: 60000, status: "pending_pof" },
            { code: "packaging_qc", amountMinor: 18000, status: "pending_pof" },
            { code: "delivered", amountMinor: 30000, status: "pending_pof" },
            { code: "retention", amountMinor: 12000, status: "pending_pof" },
          ],
        );
      }
    }
    assert.equal((await request(instance.api, `/dispatch/${orderId}/accept`, { method: "POST", subject: "clerk_rider", body: {} })).status, 200);
    const checks = ["quantity_match", "specification_match", "visible_defects", "packaging_integrity", "documentation", "supplier_sign_off"]
      .map((code) => ({ code, passed: true }));
    assert.equal((await request(instance.api, `/dispatch/${orderId}/pickup-checklist`, { method: "POST", subject: "clerk_rider", body: { checks } })).status, 200);
    assert.equal((await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_rider", body: { state: "out_for_delivery" } })).status, 200);

    const released = await request(instance.api, "/orders/ord_payout/milestones/printing/release", { method: "POST", subject: "clerk_ops", body: {} });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.milestone.status, "released");
    const payout = await request(instance.api, "/orders/ord_payout/transition", { method: "POST", subject: "clerk_ops", body: { state: "payout_released" } });
    assert.equal(payout.status, 200, JSON.stringify(payout.body));
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
  }

  instance = await startApi();
  try {
    const persistedPayment = await request(instance.api, "/orders", { subject: "clerk_ops" });
    const lifecycleOrder = persistedPayment.body.orders.find((order) => order.title === "API banner");
    assert.equal(lifecycleOrder.payments.initial.status, "confirmed");
    assert.equal(lifecycleOrder.payments.final_online.status, "confirmed");
    assert.equal(lifecycleOrder.state, "out_for_delivery");
    assert.equal(persistedPayment.body.orders.find((order) => order.id === "ord_payout").state, "payout_released");
    assert.equal(persistedPayment.body.orders.find((order) => order.id === "ord_expired").state, "completed");
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("settings use audited compare-and-swap and suppliers govern supported payment terms", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    const current = await request(instance.api, "/settings", { subject: "clerk_ops" });
    assert.equal(current.status, 200);
    assert.equal(current.body.settings.serviceFeeRateBps, 1000);
    assert.deepEqual(current.body.settings.paymentQr, {
      method: "qr_manual",
      caption: "QR Ph",
    });

    const noReason = await request(instance.api, "/settings", {
      method: "PATCH",
      subject: "clerk_ops",
      body: { expectedVersion: current.body.version, serviceFeeRateBps: 1250 },
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error, "settings_reason_required");

    const stale = await request(instance.api, "/settings", {
      method: "PATCH",
      subject: "clerk_ops",
      body: { expectedVersion: current.body.version - 1, serviceFeeRateBps: 1250, reason: "Pilot fee update" },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "settings_version_conflict");

    const stringRate = await request(instance.api, "/settings", {
      method: "PATCH",
      subject: "clerk_ops",
      body: { expectedVersion: current.body.version, serviceFeeRateBps: "1000", reason: "Invalid string rate" },
    });
    assert.equal(stringRate.status, 400);
    assert.equal(stringRate.body.error, "invalid_service_fee_rate");

    const stringDeliveryFee = await request(instance.api, "/settings", {
      method: "PATCH",
      subject: "clerk_ops",
      body: {
        expectedVersion: current.body.version,
        deliveryFeeBands: [{ maxDistanceMeters: null, feeMinor: "2500" }],
        reason: "Invalid string delivery fee",
      },
    });
    assert.equal(stringDeliveryFee.status, 400);
    assert.equal(stringDeliveryFee.body.error, "invalid_money");

    const updated = await request(instance.api, "/settings", {
      method: "PATCH",
      subject: "clerk_ops",
      body: { expectedVersion: current.body.version, serviceFeeRateBps: 1250, reason: "Pilot fee update" },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.version, current.body.version + 1);
    assert.equal(updated.body.settings.serviceFeeRateBps, 1250);

    const defaults = await request(instance.api, "/supplier-payment-terms", { subject: "clerk_supplier" });
    assert.equal(defaults.status, 200, JSON.stringify(defaults.body));
    assert.equal(defaults.body.terms.deliveryDownpaymentRateBps, 0);

    const terms = await request(instance.api, "/supplier-payment-terms", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: {
        deliveryDownpaymentRateBps: 2500,
        pickupFullOnlineEnabled: false,
        pickupDownpaymentStoreEnabled: true,
        pickupDownpaymentRateBps: 2500,
      },
    });
    assert.equal(terms.status, 200, JSON.stringify(terms.body));
    assert.equal(terms.body.terms.pickupDownpaymentRateBps, 2500);

    const invalid = await request(instance.api, "/supplier-payment-terms", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { pickupDownpaymentStoreEnabled: true, pickupDownpaymentRateBps: 0 },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_pickup_downpayment_rate");
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("ops can replace the public payment QR without changing method or caption", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);
  const instance = await startApi();
  try {
    const missing = await fetch(`${instance.api}/public/payment-qr`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "payment_qr_not_found");

    const clientUpload = new FormData();
    clientUpload.set("purpose", "payment_qr");
    clientUpload.set("file", new Blob([jpeg], { type: "image/jpeg" }), "gcash-qr.jpg");
    const clientDenied = await fetch(`${instance.api}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token("clerk_client")}` },
      body: clientUpload,
    });
    const clientDeniedBody = await clientDenied.json();
    assert.equal(clientDenied.status, 403, JSON.stringify(clientDeniedBody));
    assert.equal(clientDeniedBody.error, "forbidden");

    const current = await request(instance.api, "/settings", { subject: "clerk_ops" });
    assert.equal(current.status, 200);
    assert.equal(Object.hasOwn(current.body.settings.paymentQr, "imageUrl"), false);
    assert.deepEqual(current.body.settings.paymentQr, { method: "qr_manual", caption: "QR Ph" });

    let health = await request(instance.api, "/health");
    for (let attempt = 0; attempt < 50 && health.body.storage?.status === "checking"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      health = await request(instance.api, "/health");
    }
    if (health.body.storage?.status !== "available") {
      const patched = await request(instance.api, "/settings", {
        method: "PATCH",
        subject: "clerk_ops",
        body: { expectedVersion: current.body.version, reason: "Confirm paymentQr survives a band-free patch" },
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.deepEqual(patched.body.settings.paymentQr, { method: "qr_manual", caption: "QR Ph" });
      return;
    }

    const form = new FormData();
    form.set("purpose", "payment_qr");
    form.set("file", new Blob([jpeg], { type: "image/jpeg" }), "gcash-qr.jpg");
    const uploaded = await fetch(`${instance.api}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token("clerk_ops")}` },
      body: form,
    });
    const uploadedBody = await uploaded.json();
    assert.equal(uploaded.status, 201, JSON.stringify(uploadedBody));
    assert.equal(uploadedBody.file.purpose, "payment_qr");
    assert.equal(uploadedBody.file.state, "ready");

    const activated = await request(instance.api, "/settings/payment-qr", {
      method: "POST",
      subject: "clerk_ops",
      body: { fileId: uploadedBody.file.fileId, reason: "Set the GCash plate" },
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.settings.paymentQr.method, "qr_manual");
    assert.equal(activated.body.settings.paymentQr.caption, "QR Ph");
    assert.match(activated.body.settings.paymentQr.imageUrl, /^\/public\/payment-qr\?v=/);
    assert.equal(Object.hasOwn(activated.body.settings, "paymentQrFileId"), false);

    const again = await request(instance.api, "/settings/payment-qr", {
      method: "POST",
      subject: "clerk_ops",
      body: { fileId: uploadedBody.file.fileId, reason: "Same plate again" },
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.version, activated.body.version);

    const publicQr = await fetch(`${instance.api}/public/payment-qr`);
    assert.equal(publicQr.status, 200);
    assert.match(publicQr.headers.get("content-type") || "", /image\/jpeg/);
    const bytes = Buffer.from(await publicQr.arrayBuffer());
    assert.deepEqual(bytes, jpeg);

    const patched = await request(instance.api, "/settings", {
      method: "PATCH",
      subject: "clerk_ops",
      body: {
        expectedVersion: activated.body.version,
        serviceFeeRateBps: 1000,
        reason: "Confirm paymentQr survives compare-and-swap",
      },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.settings.paymentQr.method, "qr_manual");
    assert.equal(patched.body.settings.paymentQr.caption, "QR Ph");
    assert.equal(patched.body.settings.paymentQr.imageUrl, activated.body.settings.paymentQr.imageUrl);
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

/** Serves the Clerk Backend API surface `users.getUser` calls: GET /v1/users/:id. */
function clerkUserJson(subject, email, extras = {}) {
  return {
    object: "user",
    id: subject,
    first_name: extras.firstName ?? "Acti",
    last_name: extras.lastName ?? "Vator",
    username: null,
    image_url: "",
    has_image: false,
    password_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    two_factor_enabled: false,
    banned: false,
    locked: false,
    primary_email_address_id: `idn_${subject}`,
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    email_addresses: [{
      object: "email_address",
      id: `idn_${subject}`,
      email_address: email,
      verification: { object: "verification", status: "verified", strategy: "from_oauth_google" },
      linked_to: [],
    }],
    phone_numbers: [],
    web3_wallets: [],
    external_accounts: [],
    public_metadata: { gridgoRole: "super_admin" },
    private_metadata: {},
    unsafe_metadata: {},
    created_at: 0,
    updated_at: 0,
    last_sign_in_at: null,
  };
}

async function startMockClerkApi(usersBySubject) {
  const server = http.createServer((req, res) => {
    const match = /^\/v1\/users\/([^/?]+)/.exec(req.url || "");
    const user = match ? usersBySubject[decodeURIComponent(match[1])] : null;
    if (!user) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "not found", code: "resource_not_found" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(user));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function startMockObjectStorage() {
  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("Clerk activation provisions only a client through the live API and PostgreSQL", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const clerk = await startMockClerkApi({
    clerk_activate: clerkUserJson("clerk_activate", "Activate@Gridgo.test"),
    clerk_ops: clerkUserJson("clerk_ops", "ops@gridgo.test"),
  });
  let instance = null;
  try {
    instance = await startApi({ CLERK_API_URL: clerk.url });

    assert.equal((await request(instance.api, "/auth/clerk/activate", { method: "POST", body: {} })).status, 401);

    const activated = await request(instance.api, "/auth/clerk/activate", { method: "POST", subject: "clerk_activate", body: {} });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.user.role, "client");
    assert.equal(activated.body.user.accountType, "individual");
    assert.equal(activated.body.user.email, "activate@gridgo.test");
    assert.equal(Object.hasOwn(activated.body.user, "clerkUserId"), false);

    const again = await request(instance.api, "/auth/clerk/activate", { method: "POST", subject: "clerk_activate", body: {} });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.user.id, activated.body.user.id);

    const dotted = await rawRequest(instance.api, "/auth/clerk/x/../activate", { subject: "clerk_activate", body: {} });
    assert.equal(dotted.status, 200, JSON.stringify(dotted.body));
    assert.equal(dotted.body.user.id, activated.body.user.id);

    const me = await request(instance.api, "/auth/me", { subject: "clerk_activate" });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, activated.body.user.id);
    assert.equal(me.body.user.role, "client");
    assert.deepEqual(me.body.memberships, [{ role: "client" }]);

    const privileged = await request(instance.api, "/auth/clerk/activate", { method: "POST", subject: "clerk_ops", body: {} });
    assert.equal(privileged.status, 200, JSON.stringify(privileged.body));
    assert.equal(privileged.body.user.role, "ops_admin");
    const privilegedClient = await request(instance.api, "/auth/me/client", { subject: "clerk_ops" });
    assert.equal(privilegedClient.status, 200, JSON.stringify(privilegedClient.body));
    assert.equal(privilegedClient.body.membership.role, "client");
    assert.equal(privilegedClient.body.clientProfile.clientKind, "personal");
    assert.equal((await request(instance.api, "/auth/me/ops", { subject: "clerk_ops" })).status, 200);
  } finally {
    if (instance) {
      instance.child.kill("SIGTERM");
      await new Promise((resolve) => instance.child.once("exit", resolve));
    }
    await new Promise((resolve) => clerk.server.close(resolve));
    await database.close();
  }
});

test("fixed enrollment and reapplication persist exact role-safe workflows in PostgreSQL", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const clerk = await startMockClerkApi({
    clerk_supplier_new: clerkUserJson("clerk_supplier_new", "supplier-new@gridgo.test"),
    clerk_rider_new: clerkUserJson("clerk_rider_new", "rider-new@gridgo.test"),
    clerk_injected: clerkUserJson("clerk_injected", "injected@gridgo.test"),
  });
  const storage = await startMockObjectStorage();
  let instance = null;
  const supplierBody = {
    profile: {
      shopName: "New Print House",
      contactName: "Acti Vator",
      phone: "+639171234567",
      location: { lat: 7.0731, lng: 125.6128, label: "Bajada, Davao City" },
    },
    serviceCategories: ["marketing_collateral", "apparel_sublimation"],
  };
  const riderBody = {
    profile: {
      phone: "+639181234567",
      vehicleType: "motorcycle",
      plateNumber: "NEW 1234",
      licenseNumber: "N01-23-456789",
    },
  };
  try {
    instance = await startApi({
      CLERK_API_URL: clerk.url,
      CORS_ALLOWED_ORIGINS: "https://app.gridgo.test",
      MINIO_ENDPOINT: storage.url,
      MINIO_BUCKET: "gridgo-enrollment-test",
    });

    const preflight = await fetch(`${instance.api}/auth/clerk/enroll/supplier`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.gridgo.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key",
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") || "", /(?:^|,\s*)Idempotency-Key(?:,|$)/i);

    const missingKey = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_supplier_new", body: supplierBody,
    });
    assert.equal(missingKey.status, 400, JSON.stringify(missingKey.body));
    assert.equal(missingKey.body.error, "idempotency_key_required");

    const supplierKey = "11111111-1111-4111-8111-111111111111";
    const supplier = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_supplier_new", body: supplierBody,
      headers: { "Idempotency-Key": supplierKey },
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    assert.deepEqual(supplier.body.membership, { role: "supplier" });
    assert.equal(supplier.body.supplierProfile.shopName, "New Print House");
    assert.equal(supplier.body.approvalCase.status, "pending");
    assert.notEqual(supplier.body.approvalCase.submittedAt, null);
    assert.equal(supplier.body.supplierServices.length, 2);
    assert.deepEqual(
      supplier.body.supplierServices.map((service) => service.categoryCode),
      ["marketing_collateral", "corporate_event_merch"],
    );
    assert.equal(supplier.body.supplierServices.every((service) => service.state === "draft"), true);
    assert.equal(supplier.body.capabilities.receiveJobOffers, false);

    const supplierRetry = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_supplier_new", body: supplierBody,
      headers: { "Idempotency-Key": supplierKey },
    });
    assert.equal(supplierRetry.status, 200, JSON.stringify(supplierRetry.body));
    assert.equal(supplierRetry.body.approvalCase.id, supplier.body.approvalCase.id);
    assert.deepEqual(
      supplierRetry.body.supplierServices.map((service) => service.id),
      supplier.body.supplierServices.map((service) => service.id),
    );
    const invalidSupplierRetries = [
      [{ ...supplierBody, profile: null }, "profile.shopName"],
      [{ ...supplierBody, profile: { ...supplierBody.profile, phone: "" } }, "profile.phone"],
      [{
        ...supplierBody,
        profile: {
          ...supplierBody.profile,
          location: { ...supplierBody.profile.location, lat: 91 },
        },
      }, "profile.location.lat"],
      [{ ...supplierBody, serviceCategories: [] }, "serviceCategories"],
    ];
    for (const [invalidBody, field] of invalidSupplierRetries) {
      const invalidRetry = await request(instance.api, "/auth/clerk/enroll/supplier", {
        method: "POST", subject: "clerk_supplier_new", body: invalidBody,
        headers: { "Idempotency-Key": supplierKey },
      });
      assert.equal(invalidRetry.status, 400, JSON.stringify(invalidRetry.body));
      assert.equal(invalidRetry.body.error, "invalid_application");
      assert.equal(typeof invalidRetry.body.fields[field], "string");
    }
    const supplierInjectedRetry = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_supplier_new",
      body: { ...supplierBody, role: "super_admin", status: "approved", live: true },
      headers: { "Idempotency-Key": supplierKey },
    });
    assert.equal(supplierInjectedRetry.status, 400, JSON.stringify(supplierInjectedRetry.body));
    assert.equal(supplierInjectedRetry.body.error, "unexpected_field");
    await database.transaction(async () => {
      const store = await loadStore(database);
      store.taxonomy.categories.find(({ code }) => code === "corporate_event_merch").active = false;
      await saveStore(database, store);
    });
    const supplierRetryAfterTaxonomyChange = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_supplier_new", body: supplierBody,
      headers: { "Idempotency-Key": supplierKey },
    });
    assert.equal(supplierRetryAfterTaxonomyChange.status, 200, JSON.stringify(supplierRetryAfterTaxonomyChange.body));
    assert.equal(supplierRetryAfterTaxonomyChange.body.approvalCase.id, supplier.body.approvalCase.id);
    await database.transaction(async () => {
      const store = await loadStore(database);
      store.taxonomy.categories.find(({ code }) => code === "corporate_event_merch").active = true;
      await saveStore(database, store);
    });
    const supplierDuplicate = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_supplier_new", body: supplierBody,
      headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111112" },
    });
    assert.equal(supplierDuplicate.status, 409, JSON.stringify(supplierDuplicate.body));
    assert.equal(supplierDuplicate.body.error, "application_already_exists");

    const supplierInjection = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_injected",
      headers: { "Idempotency-Key": "22222222-2222-4222-8222-222222222222" },
      body: { ...supplierBody, role: "super_admin", status: "approved", live: true },
    });
    assert.equal(supplierInjection.status, 400, JSON.stringify(supplierInjection.body));
    assert.equal(supplierInjection.body.error, "unexpected_field");

    const sameIdentity = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_client", body: {
        ...supplierBody,
        profile: { ...supplierBody.profile, shopName: "Client's Second Hat" },
        serviceCategories: ["marketing_collateral"],
      },
      headers: { "Idempotency-Key": "33333333-3333-4333-8333-333333333333" },
    });
    assert.equal(sameIdentity.status, 201, JSON.stringify(sameIdentity.body));
    assert.equal(sameIdentity.body.user.id, "user_client");
    const sameIdentityMe = await request(instance.api, "/auth/me", { subject: "clerk_client" });
    assert.deepEqual(sameIdentityMe.body.memberships, [{ role: "client" }, { role: "supplier" }]);
    const sameIdentityPersisted = await loadStore(database);
    const legacySupplier = sameIdentityPersisted.users.find(({ id }) => id === "user_client");
    assert.equal(legacySupplier.supplierName, "Client's Second Hat");
    assert.deepEqual(legacySupplier.shop, supplierBody.profile.location);

    const multiRoleSuppliers = [
      { subject: "clerk_rider", userId: "user_rider", label: "Rider" },
      { subject: "clerk_ops", userId: "user_ops", label: "Operations" },
      { subject: "clerk_super", userId: "user_super", label: "Administrator" },
    ];
    const multiRoleSupplierBody = (entry) => ({
      ...supplierBody,
      profile: {
        ...supplierBody.profile,
        shopName: `${entry.label} Supplier Shop`,
        location: { ...supplierBody.profile.location, label: `${entry.label} shop` },
      },
      serviceCategories: ["marketing_collateral"],
    });
    for (const entry of multiRoleSuppliers) {
      const enrolled = await request(instance.api, "/auth/clerk/enroll/supplier", {
        method: "POST",
        subject: entry.subject,
        headers: { "Idempotency-Key": `multi-role-supplier-${entry.userId}` },
        body: multiRoleSupplierBody(entry),
      });
      assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
      assert.equal(enrolled.body.user.id, entry.userId);
      assert.deepEqual(enrolled.body.membership, { role: "supplier" });
    }
    const finalMultiRoleSupplier = multiRoleSuppliers.at(-1);
    const finalMultiRoleRetry = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST",
      subject: finalMultiRoleSupplier.subject,
      headers: { "Idempotency-Key": `multi-role-supplier-${finalMultiRoleSupplier.userId}` },
      body: multiRoleSupplierBody(finalMultiRoleSupplier),
    });
    assert.equal(finalMultiRoleRetry.status, 200, JSON.stringify(finalMultiRoleRetry.body));
    const multiRolePersisted = await loadStore(database);
    for (const entry of multiRoleSuppliers) {
      const legacyUser = multiRolePersisted.users.find(({ id }) => id === entry.userId);
      assert.equal(legacyUser.supplierName, `${entry.label} Supplier Shop`);
      assert.equal(legacyUser.shop.label, `${entry.label} shop`);
      assert.equal(
        multiRolePersisted.userRoleMemberships.some(
          ({ userId, role }) => userId === entry.userId && role === "supplier",
        ),
        true,
      );
    }

    const businessBody = {
      businessName: "Davao Events Co.",
      businessNature: "Events and corporate merchandise",
    };
    const businessKey = "44444444-4444-4444-8444-444444444444";
    const business = await request(instance.api, "/me/business-application", {
      method: "POST", subject: "clerk_promote", body: businessBody,
      headers: { "Idempotency-Key": businessKey },
    });
    assert.equal(business.status, 201, JSON.stringify(business.body));
    assert.deepEqual(business.body.membership, { role: "client" });
    assert.equal(business.body.clientProfile.clientKind, "business");
    assert.equal(business.body.approvalCase.kind, "business_client");
    assert.equal(business.body.approvalCase.status, "pending");
    assert.equal(business.body.capabilities.placePersonalOrders, true);
    assert.equal(business.body.capabilities.placeBusinessOrders, false);
    const businessRetry = await request(instance.api, "/me/business-application", {
      method: "POST", subject: "clerk_promote", body: businessBody,
      headers: { "Idempotency-Key": businessKey },
    });
    assert.equal(businessRetry.status, 200, JSON.stringify(businessRetry.body));
    assert.equal(businessRetry.body.approvalCase.id, business.body.approvalCase.id);
    const businessInjection = await request(instance.api, "/me/business-application", {
      method: "POST", subject: "clerk_promote", body: { ...businessBody, status: "approved" },
      headers: { "Idempotency-Key": "44444444-4444-4444-8444-444444444445" },
    });
    assert.equal(businessInjection.status, 400, JSON.stringify(businessInjection.body));
    assert.equal(businessInjection.body.error, "unexpected_field");

    const riderKey = "55555555-5555-4555-8555-555555555555";
    const rider = await request(instance.api, "/auth/clerk/enroll/rider", {
      method: "POST", subject: "clerk_rider_new", body: riderBody,
      headers: { "Idempotency-Key": riderKey },
    });
    assert.equal(rider.status, 201, JSON.stringify(rider.body));
    assert.deepEqual(rider.body.membership, { role: "rider" });
    assert.equal(rider.body.approvalCase.status, "pending");
    assert.equal(rider.body.approvalCase.submittedAt, null);
    assert.equal(rider.body.onboardingIncomplete, true);
    assert.equal(rider.body.riderProfile.vehicleType, "motorcycle");

    const riderRetry = await request(instance.api, "/auth/clerk/enroll/rider", {
      method: "POST", subject: "clerk_rider_new", body: riderBody,
      headers: { "Idempotency-Key": riderKey },
    });
    assert.equal(riderRetry.status, 200, JSON.stringify(riderRetry.body));
    assert.equal(riderRetry.body.approvalCase.id, rider.body.approvalCase.id);
    assert.equal(riderRetry.body.onboardingIncomplete, true);

    const riderInjection = await request(instance.api, "/auth/clerk/enroll/rider", {
      method: "POST", subject: "clerk_rider_new",
      headers: { "Idempotency-Key": "66666666-6666-4666-8666-666666666666" },
      body: { profile: { ...riderBody.profile, approvalStatus: "approved" } },
    });
    assert.equal(riderInjection.status, 400, JSON.stringify(riderInjection.body));
    assert.equal(riderInjection.body.error, "unexpected_field");

    const nullSubmitResponse = await fetch(`${instance.api}/me/approval-cases/rider/submit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token("clerk_rider_new")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "77777777-7777-4777-8777-777777777774",
      },
      body: "null",
    });
    const nullSubmit = await nullSubmitResponse.json();
    assert.equal(nullSubmitResponse.status, 400, JSON.stringify(nullSubmit));
    assert.equal(nullSubmit.error, "invalid_application");
    assert.equal(nullSubmit.fields.body, "must be a JSON object");

    const missingVersionSubmit = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: {},
      headers: { "Idempotency-Key": "77777777-7777-4777-8777-777777777775" },
    });
    assert.equal(missingVersionSubmit.status, 400, JSON.stringify(missingVersionSubmit.body));
    assert.equal(missingVersionSubmit.body.error, "invalid_application");
    assert.equal(missingVersionSubmit.body.fields.expectedVersion, "must be a positive integer");

    const incompleteSubmit = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: { expectedVersion: 1 },
      headers: { "Idempotency-Key": "77777777-7777-4777-8777-777777777776" },
    });
    assert.equal(incompleteSubmit.status, 409, JSON.stringify(incompleteSubmit.body));
    assert.equal(incompleteSubmit.body.error, "rider_documents_incomplete");

    await database.transaction(async () => {
      const store = await loadStore(database);
      const enrolledRider = store.users.find((candidate) => candidate.clerkUserId === "clerk_rider_new");
      const approvalCase = store.approvalCases.find(
        (candidate) => candidate.userId === enrolledRider.id && candidate.kind === "rider",
      );
      const file = {
        fileId: "file_rider_license_new",
        ownerId: enrolledRider.id,
        purpose: "rider_verification_document",
        originalFilename: "license.png",
        declaredContentType: "image/png",
        detectedContentType: "image/png",
        size: 128,
        state: "ready",
        objectKey: "rider_verification_document/license.png",
        references: [],
        createdAt: AT,
        readyAt: AT,
      };
      store.files.push(file);
      const attached = attachRiderDocument(store, file, {
        type: "rider_document",
        record: enrolledRider,
        kind: "drivers_license",
        expiresOn: LICENSE_EXPIRY,
        replacedDocuments: [],
      }, { documentId: "rdoc_new_license", at: "2026-08-16T02:00:00.000Z" });
      assert.equal(attached.approvalCase.id, approvalCase.id);
      assert.equal(attached.approvalCase.submittedAt, undefined);
      store.riderProfiles.find((profile) => profile.userId === enrolledRider.id).plateNumber =
        "PROFILE-COMPLETION-REQUIRED";
      await saveStore(database, store);
    });

    const resumed = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider_new" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.onboardingIncomplete, true);
    assert.equal(resumed.body.approvalCase.submittedAt, null);
    assert.equal(resumed.body.documents[0].kind, "drivers_license");
    const incompleteProfileSubmit = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: { expectedVersion: 1 },
      headers: { "Idempotency-Key": "rider-submit-incomplete-profile" },
    });
    assert.equal(incompleteProfileSubmit.status, 400, JSON.stringify(incompleteProfileSubmit.body));
    assert.equal(incompleteProfileSubmit.body.error, "invalid_application");
    assert.equal(incompleteProfileSubmit.body.fields["profile.plateNumber"], "is required");
    const incompleteProfileApproval = await request(
      instance.api,
      `/users/${rider.body.user.id}/verification`,
      { method: "POST", subject: "clerk_ops", body: { status: "approved" } },
    );
    assert.equal(incompleteProfileApproval.status, 400, JSON.stringify(incompleteProfileApproval.body));
    assert.equal(incompleteProfileApproval.body.error, "invalid_application");
    assert.equal(incompleteProfileApproval.body.fields["profile.plateNumber"], "is required");
    await database.transaction(async () => {
      const store = await loadStore(database);
      store.riderProfiles.find((profile) => profile.userId === rider.body.user.id).plateNumber = "NEW 1234";
      await saveStore(database, store);
    });
    const unsubmittedApproval = await request(
      instance.api,
      `/users/${rider.body.user.id}/verification`,
      { method: "POST", subject: "clerk_ops", body: { status: "approved" } },
    );
    assert.equal(unsubmittedApproval.status, 409, JSON.stringify(unsubmittedApproval.body));
    assert.equal(unsubmittedApproval.body.error, "approval_state_conflict");
    const afterUnsubmittedApproval = await loadStore(database);
    assert.equal(
      afterUnsubmittedApproval.approvalCases.find(({ id }) => id === rider.body.approvalCase.id).submittedAt,
      undefined,
    );
    assert.equal(
      afterUnsubmittedApproval.users.find(({ id }) => id === rider.body.user.id).verificationStatus,
      "pending",
    );
    const submitted = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: { expectedVersion: 1 },
      headers: { "Idempotency-Key": "77777777-7777-4777-8777-777777777777" },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.notEqual(submitted.body.approvalCase.submittedAt, null);
    const completed = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider_new" });
    assert.equal(completed.body.onboardingIncomplete, false);
    assert.equal(completed.body.approvalCase.submittedAt, submitted.body.approvalCase.submittedAt);
    const duplicateSubmit = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: { expectedVersion: 1 },
      headers: { "Idempotency-Key": "rider-submit-second-key" },
    });
    assert.equal(duplicateSubmit.status, 409, JSON.stringify(duplicateSubmit.body));
    assert.equal(duplicateSubmit.body.error, "approval_state_conflict");

    const licenseDeleted = await request(instance.api, "/files/file_rider_license_new", {
      method: "DELETE", subject: "clerk_rider_new",
    });
    assert.equal(licenseDeleted.status, 200, JSON.stringify(licenseDeleted.body));
    assert.equal(licenseDeleted.body.file.state, "deleted");
    const afterDeletion = await loadStore(database);
    const invalidatedDocument = afterDeletion.riderDocuments.find(
      (document) => document.id === "rdoc_new_license",
    );
    assert.equal(invalidatedDocument.isCurrent, false);
    const incompleteAgain = await request(instance.api, "/auth/me/rider", { subject: "clerk_rider_new" });
    assert.equal(incompleteAgain.status, 200, JSON.stringify(incompleteAgain.body));
    assert.equal(incompleteAgain.body.onboardingIncomplete, true);
    assert.equal(incompleteAgain.body.approvalCase.submittedAt, null);
    assert.deepEqual(incompleteAgain.body.documents, []);
    const deletedResubmit = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: { expectedVersion: 1 },
      headers: { "Idempotency-Key": "77777777-7777-4777-8777-777777777778" },
    });
    assert.equal(deletedResubmit.status, 409, JSON.stringify(deletedResubmit.body));
    assert.equal(deletedResubmit.body.error, "rider_documents_incomplete");

    const approvalWithoutLicense = await request(
      instance.api,
      `/users/${invalidatedDocument.riderId}/verification`,
      { method: "POST", subject: "clerk_ops", body: { status: "approved" } },
    );
    assert.equal(approvalWithoutLicense.status, 409, JSON.stringify(approvalWithoutLicense.body));
    assert.equal(approvalWithoutLicense.body.error, "rider_documents_incomplete");
    const afterFailedApproval = await loadStore(database);
    assert.equal(
      afterFailedApproval.users.find(({ id }) => id === invalidatedDocument.riderId).verificationStatus,
      "pending",
    );
    assert.equal(
      afterFailedApproval.approvalCases.find(({ id }) => id === rider.body.approvalCase.id).submittedAt,
      undefined,
    );

    const riderRejected = await request(instance.api, `/users/${invalidatedDocument.riderId}/verification`, {
      method: "POST", subject: "clerk_ops",
      body: { status: "rejected", reason: "Licence evidence missing" },
    });
    assert.equal(riderRejected.status, 200, JSON.stringify(riderRejected.body));
    assert.equal(riderRejected.body.user.verificationStatus, "rejected");
    const submittedRetryAfterRejection = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: { expectedVersion: 1 },
      headers: { "Idempotency-Key": "77777777-7777-4777-8777-777777777777" },
    });
    assert.equal(submittedRetryAfterRejection.status, 200, JSON.stringify(submittedRetryAfterRejection.body));
    assert.deepEqual(submittedRetryAfterRejection.body, submitted.body);
    const changedSubmitRetry = await request(instance.api, "/me/approval-cases/rider/submit", {
      method: "POST", subject: "clerk_rider_new", body: { expectedVersion: 2 },
      headers: { "Idempotency-Key": "77777777-7777-4777-8777-777777777777" },
    });
    assert.equal(changedSubmitRetry.status, 409, JSON.stringify(changedSubmitRetry.body));
    assert.equal(changedSubmitRetry.body.error, "approval_state_conflict");
    const riderReapplyBody = {
      expectedVersion: 2,
      correctionSummary: "Re-uploaded the driver's licence photo.",
    };
    const reapplyWithoutLicense = await request(instance.api, "/me/approval-cases/rider/reapply", {
      method: "POST", subject: "clerk_rider_new", body: riderReapplyBody,
      headers: { "Idempotency-Key": "99999999-9999-4999-8999-999999999999" },
    });
    assert.equal(reapplyWithoutLicense.status, 409, JSON.stringify(reapplyWithoutLicense.body));
    assert.equal(reapplyWithoutLicense.body.error, "rider_documents_incomplete");

    await database.transaction(async () => {
      const store = await loadStore(database);
      const enrolledRider = store.users.find((candidate) => candidate.clerkUserId === "clerk_rider_new");
      const file = {
        fileId: "file_rider_license_replacement",
        ownerId: enrolledRider.id,
        purpose: "rider_verification_document",
        originalFilename: "license-2.png",
        declaredContentType: "image/png",
        detectedContentType: "image/png",
        size: 128,
        state: "ready",
        objectKey: "rider_verification_document/license-2.png",
        references: [],
        createdAt: AT,
        readyAt: AT,
      };
      store.files.push(file);
      attachRiderDocument(store, file, {
        type: "rider_document",
        record: enrolledRider,
        kind: "drivers_license",
        expiresOn: REPLACEMENT_LICENSE_EXPIRY,
        replacedDocuments: [],
      }, { documentId: "rdoc_replacement_license", at: "2026-08-16T05:00:00.000Z" });
      await saveStore(database, store);
    });
    const riderReapplied = await request(instance.api, "/me/approval-cases/rider/reapply", {
      method: "POST", subject: "clerk_rider_new", body: riderReapplyBody,
      headers: { "Idempotency-Key": "99999999-9999-4999-8999-99999999999a" },
    });
    assert.equal(riderReapplied.status, 200, JSON.stringify(riderReapplied.body));
    assert.equal(riderReapplied.body.approvalCase.status, "pending");
    assert.equal(riderReapplied.body.approvalCase.version, 3);
    assert.equal(riderReapplied.body.approvalCase.applicationRevision, 2);
    assert.notEqual(riderReapplied.body.approvalCase.submittedAt, null);
    const riderReappliedRetry = await request(instance.api, "/me/approval-cases/rider/reapply", {
      method: "POST", subject: "clerk_rider_new", body: riderReapplyBody,
      headers: { "Idempotency-Key": "99999999-9999-4999-8999-99999999999a" },
    });
    assert.equal(riderReappliedRetry.status, 200, JSON.stringify(riderReappliedRetry.body));
    const afterRiderReapply = await loadStore(database);
    const legacyRider = afterRiderReapply.users.find(({ id }) => id === invalidatedDocument.riderId);
    assert.equal(legacyRider.verificationStatus, "pending");
    assert.equal(Object.hasOwn(legacyRider, "verificationNote"), false);
    assert.deepEqual(
      afterRiderReapply.riderDocuments
        .filter((document) => document.riderId === invalidatedDocument.riderId)
        .map((document) => [document.id, document.isCurrent !== false]),
      [["rdoc_new_license", false], ["rdoc_replacement_license", true]],
    );

    const supplierApproved = await request(instance.api, `/users/${supplier.body.user.id}/verification`, {
      method: "POST", subject: "clerk_ops", body: { status: "approved" },
    });
    assert.equal(supplierApproved.status, 200, JSON.stringify(supplierApproved.body));
    const supplierRejected = await request(instance.api, `/users/${supplier.body.user.id}/verification`, {
      method: "POST", subject: "clerk_ops",
      body: { status: "rejected", reason: "Complete the category setup" },
    });
    assert.equal(supplierRejected.status, 200, JSON.stringify(supplierRejected.body));
    assert.equal(supplierRejected.body.user.verificationStatus, "rejected");
    const supplierEnrollmentCommitBarrier = await request(instance.api, "/auth/clerk/enroll/supplier", {
      method: "POST", subject: "clerk_supplier_new", body: supplierBody,
      headers: { "Idempotency-Key": supplierKey },
    });
    assert.equal(supplierEnrollmentCommitBarrier.status, 200, JSON.stringify(supplierEnrollmentCommitBarrier.body));
    const rejectedSupplierState = await loadStore(database);
    const rejectedLegacySupplier = rejectedSupplierState.users.find(({ id }) => id === supplier.body.user.id);
    assert.equal(rejectedLegacySupplier.verificationNote, "Complete the category setup");
    assert.equal(rejectedLegacySupplier.verifiedBy, "user_ops");
    const retainedServiceIds = rejectedSupplierState.supplierServices
      .filter((service) => service.supplierId === supplier.body.user.id)
      .map((service) => service.id);

    const reapplyBody = {
      expectedVersion: 3,
      correctionSummary: "Completed the category setup and reviewed the shop profile.",
    };
    const reapplyKey = "88888888-8888-4888-8888-888888888888";
    const reapplied = await request(instance.api, "/me/approval-cases/supplier/reapply", {
      method: "POST", subject: "clerk_supplier_new", body: reapplyBody,
      headers: { "Idempotency-Key": reapplyKey },
    });
    assert.equal(reapplied.status, 200, JSON.stringify(reapplied.body));
    assert.equal(reapplied.body.approvalCase.status, "pending");
    assert.equal(reapplied.body.approvalCase.version, 4);
    assert.equal(reapplied.body.approvalCase.applicationRevision, 2);
    assert.equal(reapplied.body.approvalCase.rejectionReason, null);
    const reappliedRetry = await request(instance.api, "/me/approval-cases/supplier/reapply", {
      method: "POST", subject: "clerk_supplier_new", body: reapplyBody,
      headers: { "Idempotency-Key": reapplyKey },
    });
    assert.equal(reappliedRetry.status, 200, JSON.stringify(reappliedRetry.body));
    assert.equal(reappliedRetry.body.approvalCase.applicationRevision, 2);

    const persisted = await loadStore(database);
    const enrolledSupplier = persisted.users.find((candidate) => candidate.clerkUserId === "clerk_supplier_new");
    assert.equal(enrolledSupplier.verificationStatus, "pending");
    assert.equal(Object.hasOwn(enrolledSupplier, "verificationNote"), false);
    assert.equal(Object.hasOwn(enrolledSupplier, "verifiedAt"), false);
    assert.equal(Object.hasOwn(enrolledSupplier, "verifiedBy"), false);
    assert.deepEqual(
      persisted.supplierServices
        .filter((service) => service.supplierId === enrolledSupplier.id)
        .map((service) => service.id),
      retainedServiceIds,
    );
    const supplierCase = persisted.approvalCases.find(
      (candidate) => candidate.userId === enrolledSupplier.id && candidate.kind === "supplier",
    );
    const events = persisted.approvalCaseEvents.filter((event) => event.approvalCaseId === supplierCase.id);
    assert.equal(events.length, 4);
    assert.equal(events.at(-1).reason, reapplyBody.correctionSummary);
    assert.equal(events.at(-1).applicationRevision, 2);
    assert.equal(
      persisted.auditLog.some(
        (entry) => entry.action === "approval_case.reapply" && entry.entityId === supplierCase.id,
      ),
      true,
    );
    assert.equal(
      persisted.users.filter((candidate) => candidate.clerkUserId === "clerk_client").length,
      1,
    );
  } finally {
    if (instance) {
      instance.child.kill("SIGTERM");
      await new Promise((resolve) => instance.child.once("exit", resolve));
    }
    await new Promise((resolve) => clerk.server.close(resolve));
    await new Promise((resolve) => storage.server.close(resolve));
    await database.close();
  }
});

test("anonymous device routes stay off the global mutation lock", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  const deviceToken = `anon-lock-proof-${"x".repeat(64)}`;
  const post = (pathname, body, headers = {}) =>
    fetch(`${instance.api}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  try {
    await request(instance.api, "/catalog");
    await database.transaction(async () => {
      const registered = await post("/devices", { token: deviceToken, platform: "android" });
      assert.equal(registered.status, 200);
      assert.deepEqual(await registered.json(), { ok: true });
      const row = await database.query("SELECT user_id FROM device_tokens WHERE token = $1", [deviceToken]);
      assert.equal(row.rowCount, 1);
      assert.equal(row.rows[0].user_id, null);

      const staleBearer = await post("/devices", { token: deviceToken, platform: "android" }, { Authorization: "Bearer not-a-clerk-token" });
      assert.equal(staleBearer.status, 401);

      const unregistered = await post("/devices/unregister", { token: deviceToken });
      assert.equal(unregistered.status, 200);
      assert.deepEqual(await unregistered.json(), { ok: true });
      assert.equal((await database.query("SELECT 1 FROM device_tokens WHERE token = $1", [deviceToken])).rowCount, 0);
    });
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("file upload reaches the storage boundary instead of crashing in request setup", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi({ MINIO_ENDPOINT: "http://127.0.0.1:1" });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const health = await request(instance.api, "/health");
      if (health.body.storage.status === "unavailable") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const form = new FormData();
    form.set("purpose", "artwork");
    form.set("file", new Blob([Buffer.from("%PDF-1.7\n")], { type: "application/pdf" }), "artwork.pdf");
    const response = await fetch(`${instance.api}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token("clerk_client")}` },
      body: form,
    });
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.error, "minio_unavailable");
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("money and reference inputs rejected by PostgreSQL are client errors at HTTP boundaries", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    const fractionalGrant = await request(instance.api, "/credits/grant", {
      method: "POST",
      subject: "clerk_super",
      body: { clientId: "user_client", amountMinor: 100.5 },
    });
    assert.equal(fractionalGrant.status, 400, JSON.stringify(fractionalGrant.body));
    assert.equal(fractionalGrant.body.error, "invalid_grant");

    const fractionalService = await request(instance.api, "/supplier-services", {
      method: "POST",
      subject: "clerk_supplier",
      body: { categoryCode: "marketing_collateral", referenceRateMinor: 12.5 },
    });
    assert.equal(fractionalService.status, 400, JSON.stringify(fractionalService.body));
    assert.equal(fractionalService.body.error, "invalid_service");

    const invalidTurnaround = await request(instance.api, "/supplier-services/svc_banner", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { turnaroundHours: 0 },
    });
    assert.equal(invalidTurnaround.status, 400, JSON.stringify(invalidTurnaround.body));
    assert.equal(invalidTurnaround.body.error, "invalid_service");

    const invalidZone = await request(instance.api, "/orders", {
      method: "POST",
      subject: "clerk_client",
      body: { productId: "prod_tarpaulin", quantity: 1, address: "Davao", zone: "not_a_zone" },
    });
    assert.equal(invalidZone.status, 400, JSON.stringify(invalidZone.body));
    assert.equal(invalidZone.body.error, "invalid_zone");

    for (const quantity of [0, -3, 2.5, "lots", Number.MAX_SAFE_INTEGER + 1]) {
      const invalidQuantity = await request(instance.api, "/orders", {
        method: "POST",
        subject: "clerk_client",
        body: { productId: "prod_tarpaulin", quantity, address: "Davao", zone: "davao_central" },
      });
      assert.equal(invalidQuantity.status, 400, JSON.stringify({ quantity, response: invalidQuantity.body }));
      assert.equal(invalidQuantity.body.error, "invalid_quantity");
    }

    const defaultQuantity = await request(instance.api, "/orders", {
      method: "POST",
      subject: "clerk_client",
      body: { productId: "prod_tarpaulin", address: "Davao", zone: "davao_central" },
    });
    assert.equal(defaultQuantity.status, 201, JSON.stringify(defaultQuantity.body));
    assert.equal(defaultQuantity.body.order.quantity, 1);
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("order creation reports an unseeded catalog explicitly", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.query("DELETE FROM orders");
  await database.query("DELETE FROM catalog_products");
  const instance = await startApi();
  try {
    const response = await request(instance.api, "/orders", {
      method: "POST",
      subject: "clerk_client",
      body: { quantity: 1, address: "Davao", zone: "davao_central" },
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error, "catalog_not_seeded");
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("a deferred commit failure cannot crash the API by sending a second response", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.query(`
    CREATE OR REPLACE FUNCTION gridgo_test_fail_audit_commit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced deferred commit failure'; END $$
  `);
  await database.query(`
    CREATE CONSTRAINT TRIGGER gridgo_test_fail_audit_commit
    AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION gridgo_test_fail_audit_commit()
  `);
  const instance = await startApi();
  try {
    await request(instance.api, "/credits/grant", {
      method: "POST",
      subject: "clerk_super",
      body: { clientId: "user_client", amountMinor: 100 },
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await request(instance.api, "/health");
    assert.equal(health.status, 200, instance.output());
    assert.equal(health.body.database.status, "available");
  } finally {
    instance.child.kill("SIGTERM");
    if (instance.child.exitCode == null) await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.query("DROP TRIGGER IF EXISTS gridgo_test_fail_audit_commit ON audit_log");
    await database.query("DROP FUNCTION IF EXISTS gridgo_test_fail_audit_commit()");
    await database.close();
  }
});

function signClerkWebhook(secretBytes, payload) {
  const id = "msg_clerk_identity_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
  return {
    body,
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
      "Content-Type": "application/json",
    },
  };
}

test("GET /auth/me and the Clerk webhook refresh the person copy only", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const clerk = await startMockClerkApi({
    clerk_supplier: clerkUserJson("clerk_supplier", "supplier-renamed@gridgo.test", {
      firstName: "Quinn",
      lastName: "",
    }),
  });
  const webhookSecretBytes = Buffer.from("gridgo-test-webhook-secret");
  const webhookSecret = `whsec_${webhookSecretBytes.toString("base64")}`;
  let instance = null;
  try {
    instance = await startApi({
      CLERK_API_URL: clerk.url,
      CLERK_WEBHOOK_SIGNING_SECRET: webhookSecret,
    });

    const me = await request(instance.api, "/auth/me", { subject: "clerk_supplier" });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.user.name, "Quinn");
    assert.equal(me.body.user.email, "supplier-renamed@gridgo.test");
    assert.equal(me.body.user.supplierName, "Print Shop");

    const profile = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(profile.body.supplierProfile.contactName, "Supplier");
    assert.equal(profile.body.supplierProfile.shopName, "Print Shop");

    const unsigned = await fetch(`${instance.api}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user.updated", data: { id: "clerk_supplier" } }),
    });
    assert.equal(unsigned.status, 400);
    assert.equal((await unsigned.json()).error, "invalid_webhook");

    const signed = signClerkWebhook(webhookSecretBytes, {
      type: "user.updated",
      data: {
        id: "clerk_supplier",
        first_name: "Quinn",
        last_name: "Reyes",
        primary_email_address_id: "idn_clerk_supplier",
        email_addresses: [{ id: "idn_clerk_supplier", email_address: "quinn@gridgo.test" }],
      },
    });
    const hook = await fetch(`${instance.api}/webhooks/clerk`, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
    assert.equal(hook.status, 200, await hook.text());
    const afterHook = await request(instance.api, "/auth/me/supplier", { subject: "clerk_supplier" });
    assert.equal(afterHook.body.user.name, "Quinn Reyes");
    assert.equal(afterHook.body.supplierProfile.contactName, "Supplier");
  } finally {
    if (instance) {
      instance.child.kill("SIGTERM");
      await new Promise((resolve) => instance.child.once("exit", resolve));
    }
    await new Promise((resolve) => clerk.server.close(resolve));
    await database.close();
  }
});

test("legacy verification can approve a rider who enrolled with a typed licence number", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.users.push({
      id: "user_jaylord",
      clerkUserId: "clerk_jaylord",
      email: "jaylord@gridgo.test",
      name: "Jaylord",
      role: "rider",
      verificationStatus: "pending",
      createdAt: AT,
    });
    store.userRoleMemberships.push({ userId: "user_jaylord", role: "rider", createdAt: AT });
    store.riderProfiles.push({
      userId: "user_jaylord",
      vehicleType: "motorcycle",
      plateNumber: "ABC 1234",
      licenseNumber: "N01-1234",
      updatedAt: AT,
    });
    store.approvalCases.push({
      id: "apc_jaylord",
      userId: "user_jaylord",
      kind: "rider",
      status: "pending",
      version: 1,
      applicationRevision: 1,
      createdAt: AT,
      updatedAt: AT,
    });
    await saveStore(database, store);
  });
  const instance = await startApi();
  try {
    const approved = await request(instance.api, "/users/user_jaylord/verification", {
      method: "POST",
      subject: "clerk_ops",
      body: { status: "approved", note: "Pilot accreditation complete" },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.user.verificationStatus, "approved");
    const persisted = await loadStoreEventually(database, (store) => {
      const approvalCase = store.approvalCases.find((candidate) => candidate.id === "apc_jaylord");
      return approvalCase?.status === "approved" && approvalCase.submittedAt;
    });
    const approvalCase = persisted.approvalCases.find((candidate) => candidate.id === "apc_jaylord");
    assert.equal(approvalCase.status, "approved");
    assert.ok(approvalCase.submittedAt);
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test(
  "event role actor uses database membership and role approval, not legacy primary role",
  { skip: !DATABASE_URL },
  async () => {
    const database = createDatabase({ DATABASE_URL });
    await clearAndFixture(database);
    await database.transaction(async () => {
      const s = await loadStore(database);
      const u = s.users.find((u) => u.id === "user_rider");
      u.role = "client";
      u.accountType = "individual";
      u.verificationStatus = null;
      const supplier = s.users.find((u) => u.id === "user_supplier");
      supplier.role = "client";
      supplier.accountType = "individual";
      supplier.verificationStatus = null;
      s.userRoleMemberships.push({
        userId: supplier.id,
        role: "client",
        createdAt: AT,
      });
      s.clientProfiles.push({
        userId: supplier.id,
        clientKind: "personal",
        updatedAt: AT,
      });
      s.orders.find((o) => o.id === "ord_payout").state = "delivered";
      s.userRoleMemberships.push({
        userId: u.id,
        role: "client",
        createdAt: AT,
      });
      s.clientProfiles.push({
        userId: u.id,
        clientKind: "personal",
        updatedAt: AT,
      });
      await saveStore(database, s);
    });
    const instance = await startApi();
    try {
      const offers = await request(instance.api, "/dispatch/offers", {
        subject: "clerk_rider",
        headers: { "X-GRIDGO-Role": "rider" },
      });
      assert.equal(offers.status, 200, JSON.stringify(offers.body));
      const jobs = await request(instance.api, "/jobs", {
        subject: "clerk_supplier",
        headers: { "X-GRIDGO-Role": "supplier" },
      });
      assert.equal(jobs.status, 200);
      assert.ok(jobs.body.jobs.some((o) => o.id === "ord_payout"));
      const clientJobs = await request(instance.api, "/jobs", {
        subject: "clerk_supplier",
        headers: { "X-GRIDGO-Role": "client" },
      });
      assert.equal(clientJobs.status, 403);
      assert.deepEqual(clientJobs.body, { error: "forbidden" });
      const inferredJobs = await request(instance.api, "/jobs", { subject: "clerk_supplier" });
      assert.equal(inferredJobs.status, 200);
      assert.ok(inferredJobs.body.jobs.some((o) => o.id === "ord_payout"));
      const bypass = await request(
        instance.api,
        "/orders/ord_payout/transition",
        {
          method: "POST",
          subject: "clerk_supplier",
          headers: { "X-GRIDGO-Role": "supplier" },
          body: { state: "issue_window_open" },
        },
      );
      assert.equal(bypass.status, 409);
      assert.equal(bypass.body.error, "transition_not_allowed");
      const forged = await request(instance.api, "/orders", {
        subject: "clerk_client",
        headers: { "X-GRIDGO-Role": "super_admin" },
      });
      assert.equal(forged.status, 403);
      const me = await request(instance.api, "/auth/me", {
        subject: "clerk_rider",
        headers: { "X-GRIDGO-Role": "rider" },
      });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.role, "rider");
      assert.equal(me.body.user.verificationStatus, "approved");
      const original = await loadStore(database);
      assert.equal(
        original.users.find((u) => u.id === "user_rider").role,
        "client",
      );
    } finally {
      instance.child.kill("SIGTERM");
      await new Promise((r) => instance.child.once("exit", r));
      await database.close();
    }
  },
);

test(
  "notification mutations enforce role context and revoked assignment with public responses",
  { skip: !DATABASE_URL },
  async () => {
    const database = createDatabase({ DATABASE_URL });
    await clearAndFixture(database);
    await database.transaction(async () => {
      const s = await loadStore(database);
      s.userRoleMemberships.push({
        userId: "user_rider",
        role: "client",
        createdAt: AT,
      });
      s.clientProfiles.push({
        userId: "user_rider",
        clientKind: "personal",
        updatedAt: AT,
      });
      s.orders.find((o) => o.id === "ord_payout").riderId = "user_rider";
      s.notifications.push({
        id: "scoped_rider_n",
        userId: "user_rider",
        appRole: "rider",
        type: "order_rider_assigned",
        orderId: "ord_payout",
        title: "Assigned trip",
        body: "Safe",
        read: false,
        at: AT,
        occurrenceKey: "internal_occurrence",
      });
      await saveStore(database, s);
    });
    const instance = await startApi();
    try {
      for (const method of ["PATCH", "DELETE"]) {
        const response = await request(
          instance.api,
          "/notifications/scoped_rider_n",
          {
            method,
            subject: "clerk_rider",
            headers: { "X-GRIDGO-Role": "client" },
            ...(method === "PATCH" ? { body: { read: true } } : {}),
          },
        );
        assert.equal(response.status, 403, JSON.stringify(response.body));
      }
      await database.transaction(async () => {
        const s = await loadStore(database);
        s.notifications.push({
          id: "silent_replay_n",
          userId: "user_rider",
          appRole: "rider",
          type: "general",
          title: "Silent own action",
          body: "Safe",
          read: false,
          at: AT,
          push: false,
        });
        await saveStore(database, s);
      });
      const controller = new AbortController();
      const stream = await fetch(
        `${instance.api}/notifications/stream?role=rider`,
        {
          headers: { Authorization: `Bearer ${token("clerk_rider")}` },
          signal: controller.signal,
        },
      );
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader();
      let received = "";
      const stop = setTimeout(() => controller.abort(), 300);
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += new TextDecoder().decode(chunk.value);
        }
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      } finally {
        clearTimeout(stop);
        controller.abort();
      }
      assert.match(received, /scoped_rider_n/);
      assert.doesNotMatch(received, /silent_replay_n/);
      const permitted = await request(
        instance.api,
        "/notifications/scoped_rider_n",
        {
          method: "PATCH",
          subject: "clerk_rider",
          headers: { "X-GRIDGO-Role": "rider" },
          body: { read: true },
        },
      );
      assert.equal(permitted.status, 200);
      assert.equal(permitted.body.notification.occurrenceKey, undefined);
      assert.equal(permitted.body.notification.appRole, undefined);
      assert.equal(permitted.body.notification.orderState, "completed");
      await database.transaction(async () => {
        const s = await loadStore(database);
        s.orders.find((o) => o.id === "ord_payout").riderId = null;
        await saveStore(database, s);
      });
      for (const method of ["PATCH", "DELETE"]) {
        const response = await request(
          instance.api,
          "/notifications/scoped_rider_n",
          {
            method,
            subject: "clerk_rider",
            headers: { "X-GRIDGO-Role": "rider" },
            ...(method === "PATCH" ? { body: { read: false } } : {}),
          },
        );
        assert.equal(response.status, 403, JSON.stringify(response.body));
      }
    } finally {
      instance.child.kill("SIGTERM");
      await new Promise((r) => instance.child.once("exit", r));
      await database.close();
    }
  },
);

 test(
   "directory role filters remain distinct from authenticated app context",
   { skip: !DATABASE_URL },
   async () => {
     const database = createDatabase({ DATABASE_URL });
     await clearAndFixture(database);
     const instance = await startApi();
     try {
       for (const [subject, role] of [
         ["clerk_ops", "ops_admin"],
         ["clerk_super", "super_admin"],
       ]) {
         for (const filter of ["supplier", "rider", "client"]) {
           const response = await request(
             instance.api,
             `/users?role=${filter}`,
             { subject, headers: { "X-GRIDGO-Role": role } },
           );
           assert.equal(response.status, 200, JSON.stringify(response.body));
           assert.ok(response.body.users.length > 0);
           assert.ok(response.body.users.every((u) => u.role === filter));
         }
         const response = await request(
           instance.api,
           "/notifications?role=rider",
           { subject, headers: { "X-GRIDGO-Role": role } },
         );
         assert.equal(response.status, 403);
       }
     } finally {
       instance.child.kill("SIGTERM");
       await new Promise((r) => instance.child.once("exit", r));
       await database.close();
     }
   },
 );

test(
  "supplier service verification and assignment use current membership approval",
  { skip: !DATABASE_URL },
  async () => {
    const database = createDatabase({ DATABASE_URL });
    await clearAndFixture(database);
    await database.transaction(async () => {
      const s = await loadStore(database);
      const rider = s.users.find((u) => u.id === "user_rider");
      rider.role = "client";
      delete rider.verificationStatus;
      s.userRoleMemberships.push({
        userId: rider.id,
        role: "client",
        createdAt: AT,
      });
      s.clientProfiles.push({
        userId: rider.id,
        clientKind: "personal",
        updatedAt: AT,
      });
      const u = s.users.find((u) => u.id === "user_supplier");
      u.role = "client";
      delete u.verificationStatus;
      delete u.shop;
      s.userRoleMemberships.push({
        userId: u.id,
        role: "client",
        createdAt: AT,
      });
      s.clientProfiles.push({
        userId: u.id,
        clientKind: "personal",
        updatedAt: AT,
      });
      s.supplierServices.find((v) => v.id === "svc_banner").state =
        "pending_verification";
      await saveStore(database, s);
    });
    const instance = await startApi();
    try {
      const directory = await request(instance.api, "/users?role=supplier", {
        subject: "clerk_ops",
        headers: { "X-GRIDGO-Role": "ops_admin" },
      });
      assert.equal(directory.status, 200);
      const member = directory.body.users.find((u) => u.id === "user_supplier");
      assert.equal(member?.role, "supplier");
      assert.equal(member.verificationStatus, "approved");
      assert.ok(member.shop);
      const riderDirectory = await request(instance.api, "/users?role=rider", {
        subject: "clerk_ops",
        headers: { "X-GRIDGO-Role": "ops_admin" },
      });
      assert.equal(riderDirectory.status, 200);
      const riderMember = riderDirectory.body.users.find(
        (u) => u.id === "user_rider",
      );
      assert.equal(riderMember?.role, "rider");
      assert.equal(riderMember.verificationStatus, "approved");
      assert.ok(riderMember.riderProfile);
      const verify = await request(
        instance.api,
        "/supplier-services/svc_banner/verify",
        {
          method: "POST",
          subject: "clerk_ops",
          headers: { "X-GRIDGO-Role": "ops_admin" },
          body: {},
        },
      );
      assert.equal(verify.status, 200, JSON.stringify(verify.body));
      assert.equal(verify.body.service.state, "live");
      const created = await request(instance.api, "/orders", {
        method: "POST",
        subject: "clerk_client",
        body: {
          productId: "prod_tarpaulin",
          title: "Membership assignment",
          quantity: 1,
          size: "2m x 3m",
          material: "13oz tarpaulin",
          finish: "hemmed",
          address: "Bajada",
          zone: "davao_central",
          submit: true,
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.order.id;
      for (const state of ["needs_qa", "approved_for_matching"]) {
        const result = await request(instance.api, `/orders/${id}/transition`, {
          method: "POST",
          subject: "clerk_ops",
          body: { state },
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
      const candidates = await request(
        instance.api,
        `/orders/${id}/eligible-suppliers`,
        { subject: "clerk_ops" },
      );
      assert.equal(candidates.status, 200);
      assert.equal(
        candidates.body.candidates.find(
          (c) => c.supplier.id === "user_supplier",
        )?.eligible,
        true,
      );
      const assigned = await request(instance.api, `/orders/${id}/transition`, {
        method: "POST",
        subject: "clerk_ops",
        body: { state: "supplier_assigned", supplierId: "user_supplier" },
      });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      await database.transaction(async () => {
        const s = await loadStore(database);
        s.approvalCases.find((c) => c.id === "case_supplier").status =
          "suspended";
        s.approvalCases.find((c) => c.id === "case_supplier").suspensionReason =
          "Approval hold";
        s.orders.find((o) => o.id === id).state = "approved_for_matching";
        await saveStore(database, s);
      });
      const denied = await request(
        instance.api,
        "/supplier-services/svc_banner/verify",
        { method: "POST", subject: "clerk_ops", body: {} },
      );
      assert.equal(denied.status, 409);
      assert.equal(denied.body.verificationStatus, "suspended");
      const ineligible = await request(
        instance.api,
        `/orders/${id}/eligible-suppliers`,
        { subject: "clerk_ops" },
      );
      assert.equal(
        ineligible.body.candidates.find(
          (c) => c.supplier.id === "user_supplier",
        )?.eligible,
        false,
      );
      const refused = await request(instance.api, `/orders/${id}/transition`, {
        method: "POST",
        subject: "clerk_ops",
        body: { state: "supplier_assigned", supplierId: "user_supplier" },
      });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, "supplier_not_approved");
      const matchedRefused = await request(instance.api, `/orders/${id}/transition`, {
        method: "POST",
        subject: "clerk_ops",
        body: { state: "supplier_assigned" },
      });
      assert.equal(matchedRefused.status, 409);
      assert.equal(matchedRefused.body.error, "supplier_not_approved");
      assert.equal((await loadStore(database)).orders.find((o) => o.id === id).state, "approved_for_matching");
      await database.transaction(async () => {
        const s = await loadStore(database);
        s.userRoleMemberships = s.userRoleMemberships.filter((m) => m.userId !== "user_supplier" || m.role !== "supplier");
        await saveStore(database, s);
      });
      const revoked = await request(instance.api, `/orders/${id}/transition`, {
        method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned" },
      });
      assert.equal(revoked.status, 404);
      assert.equal(revoked.body.error, "supplier_not_found");
      await database.transaction(async () => {
        const s = await loadStore(database);
        s.userRoleMemberships.push({ userId: "user_supplier", role: "supplier", createdAt: AT });
        s.approvalCases.find((c) => c.id === "case_supplier").status = "approved";
        await saveStore(database, s);
      });
      const matched = await request(instance.api, `/orders/${id}/transition`, {
        method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned" },
      });
      assert.equal(matched.status, 200, JSON.stringify(matched.body));

    } finally {
      instance.child.kill("SIGTERM");
      await new Promise((r) => instance.child.once("exit", r));
      await database.close();
    }
  },
);

test("device HTTP registration preserves legacy FCM and honors explicit anonymous APNs", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  const instance = await startApi();
  try {
    for (const subject of [undefined, "clerk_client"]) {
      const prefix = subject || "anonymous";
      const fcmToken = `${prefix}:` + "x".repeat(150);
      const nativeToken = (subject ? "a" : "b").repeat(64);
      for (const [deviceToken, tokenProvider] of [[fcmToken, undefined], [nativeToken, "apns"]]) {
        const response = await request(instance.api, "/devices", {
          method: "POST", subject, body: { platform: "ios", token: deviceToken, ...(tokenProvider ? { tokenProvider } : {}) },
        });
        assert.equal(response.status, subject ? 201 : 200, JSON.stringify(response.body));
        if (!subject) assert.deepEqual(response.body, { ok: true });
        const s = await loadStore(database);
        assert.equal(s.deviceTokens.find((d) => d.token === deviceToken).tokenProvider, tokenProvider || "fcm");
      }
    }
    const invalid = await request(instance.api, "/devices", {
      method: "POST", body: { platform: "android", token: "a".repeat(64), tokenProvider: "apns" },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_token_provider");
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});

test("payment HTTP confirmation emits one QA transition and no repeated delivery lifecycle", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const s = await loadStore(database);
    const order = s.orders.find((o) => o.id === "ord_payout");
    order.moneyModelVersion = 3;
    order.state = "initial_payment_review";
    order.payments.initial.status = "pending_confirmation";
    order.payoutMilestones = [];
    order.timeline = [{ state: "initial_payment_review", at: AT, by: "user_client" }];
    await saveStore(database, s);
  });
  const instance = await startApi();
  try {
    const initial = await request(instance.api, "/orders/ord_payout/payments/initial/confirm", {
      method: "POST", subject: "clerk_ops", body: {},
    });
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.order.state, "needs_qa");
    const qaStore = await loadStore(database);
    assert.equal(qaStore.notifications.filter((n) => n.orderId === "ord_payout" && n.type === "order_needs_qa").length, 1);
    await database.transaction(async () => {
      const s = await loadStore(database);
      const order = s.orders.find((o) => o.id === "ord_payout");
      order.state = "out_for_delivery";
      order.riderId = "user_rider";
      order.payments.final_online.status = "pending_confirmation";
      order.timeline.push({ state: "out_for_delivery", at: AT, by: "user_rider" });
      await saveStore(database, s);
    });
    const final = await request(instance.api, "/orders/ord_payout/payments/final_online/confirm", {
      method: "POST", subject: "clerk_ops", body: {},
    });
    assert.equal(final.status, 200, JSON.stringify(final.body));
    const s = await loadStore(database);
    assert.equal(s.notifications.some((n) => n.orderId === "ord_payout" && n.type === "order_out_for_delivery"), false);
    for (const [userId, appRole] of [["user_ops", "ops_admin"], ["user_super", "super_admin"]]) {
      assert.equal(s.notifications.filter((n) => n.orderId === "ord_payout" && n.type === "ops_payment_confirmed" && n.userId === userId && n.appRole === appRole).length, 2);
    }
    assert.equal(s.notifications.filter((n) => n.type === "rider_delivery_payment_cleared").length, 1);
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await database.close();
  }
});
