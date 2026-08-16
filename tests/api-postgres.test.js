import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { loadStore, saveStore } from "../src/postgres-store.js";
import { seedReferenceData } from "../src/seed.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });
const AT = "2026-08-16T00:00:00.000Z";

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
    administrator_bootstrap, device_tokens, proofs, escalations, location_pings, notifications, audit_log,
    issues, claims, credit_ledger, credit_accounts, file_references, files,
    payout_milestones, order_payments, orders, supplier_services, zones,
    taxonomy_finishes, taxonomy_materials, taxonomy_subcategories,
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
    assert.deepEqual(rider.body.documents, []);
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
        assert.deepEqual(
          transitioned.body.order.payoutMilestones.map(({ code, amountMinor, status }) => ({ code, amountMinor, status })),
          [
            { code: "initial", amountMinor: 30000, status: "released" },
            { code: "completion", amountMinor: 90000, status: "pending" },
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

/** Serves the Clerk Backend API surface `users.getUser` calls: GET /v1/users/:id. */
function clerkUserJson(subject, email) {
  return {
    object: "user",
    id: subject,
    first_name: "Acti",
    last_name: "Vator",
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

test("service image attachment checks and advances the service version", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    store.files.push({
      fileId: "file_service_image", ownerId: "user_supplier", purpose: "service_image",
      originalFilename: "service.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg",
      size: 100, state: "ready", objectKey: "service_image/service.jpg", references: [], createdAt: AT,
    }, {
      fileId: "file_service_image_stale", ownerId: "user_supplier", purpose: "service_image",
      originalFilename: "stale.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg",
      size: 100, state: "ready", objectKey: "service_image/stale.jpg", references: [], createdAt: AT,
    });
    await saveStore(database, store);
  });
  const storagePort = await freePort();
  const storageServer = http.createServer((req, res) => {
    if (req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    res.setHeader("Content-Length", req.url.includes("service_image/") ? "100" : "0");
    res.setHeader("Last-Modified", new Date(AT).toUTCString());
    res.setHeader("ETag", '"gridgo-test-etag"');
    res.writeHead(200).end();
  });
  await new Promise((resolve, reject) => {
    storageServer.once("error", reject);
    storageServer.listen(storagePort, "127.0.0.1", resolve);
  });
  const storageEndpoint = `http://127.0.0.1:${storagePort}`;
  const instance = await startApi({ MINIO_ENDPOINT: storageEndpoint, MINIO_PUBLIC_URL: storageEndpoint });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const health = await request(instance.api, "/health");
      if (health.body.storage.status === "available") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const missing = await request(instance.api, "/files/file_service_image/attach", {
      method: "POST", subject: "clerk_supplier", body: { supplierServiceId: "svc_banner" },
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error, "expected_version_required");

    const attached = await request(instance.api, "/files/file_service_image/attach", {
      method: "POST", subject: "clerk_supplier", body: { supplierServiceId: "svc_banner" },
      headers: { "If-Match": '"1"' },
    });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.equal(attached.body.supplierService.version, 2);
    assert.deepEqual(attached.body.supplierService.imageFileIds, ["file_service_image"]);

    const stale = await request(instance.api, "/files/file_service_image_stale/attach", {
      method: "POST", subject: "clerk_supplier", body: { supplierServiceId: "svc_banner" },
      headers: { "If-Match": '"1"' },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error, "supplier_service_stale");
    assert.deepEqual((await database.query(`
      SELECT version, data->'imageFileIds' AS image_file_ids
        FROM supplier_services WHERE id = 'svc_banner'
    `)).rows[0], { version: 2, image_file_ids: ["file_service_image"] });
  } finally {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
    await new Promise((resolve) => storageServer.close(resolve));
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

test("pending suppliers can edit catalog while public browse requires approval and rejects stale versions", { skip: !DATABASE_URL }, async () => {
  const database = createDatabase({ DATABASE_URL });
  await clearAndFixture(database);
  await database.transaction(async () => {
    const store = await loadStore(database);
    const approvalCase = store.approvalCases.find((candidate) => candidate.id === "case_supplier");
    approvalCase.status = "pending";
    delete approvalCase.decidedAt;
    delete approvalCase.decidedBy;
    store.supplierServiceFileFormats.push({ supplierServiceId: "svc_banner", formatCode: "pdf" });
    store.files.push({
      fileId: "catalog_photo", ownerId: "user_supplier", purpose: "catalog_item_photo",
      originalFilename: "poster.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg",
      size: 100, state: "ready", objectKey: "catalog/poster.jpg", references: [], createdAt: AT,
    }, {
      fileId: "catalog_photo_two", ownerId: "user_supplier", purpose: "catalog_item_photo",
      originalFilename: "poster-two.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg",
      size: 100, state: "ready", objectKey: "catalog/poster-two.jpg", references: [], createdAt: AT,
    });
    store.catalogItems.push({
      id: "catalog_poster", supplierId: "user_supplier", supplierServiceId: "svc_banner",
      name: "Poster", description: "Photo poster", basePriceMinor: 10000,
      fileFormatMode: "inherit", active: true, sortOrder: 0, version: 1,
      createdAt: AT, updatedAt: AT,
    });
    store.catalogItemPhotos.push({
      catalogItemId: "catalog_poster", fileId: "catalog_photo", sortOrder: 0, createdAt: AT,
    }, {
      catalogItemId: "catalog_poster", fileId: "catalog_photo_two", sortOrder: 1, createdAt: AT,
    });
    await saveStore(database, store);
  });
  await database.transaction(async () => {
    await database.query("ALTER TABLE supplier_services DROP CONSTRAINT supplier_services_category_fk");
    await database.query(`
      INSERT INTO supplier_services
        (id, supplier_id, category_code, state, reference_rate_minor, turnaround_hours,
         pricing_basis, standard_turnaround_hours, version, created_at, updated_at, position, data)
      VALUES ('svc_legacy_alias', 'user_supplier', 'large_format', 'draft', 0, 24,
        'per_unit', 24, 1, $1, $1, 1, '{}')
    `, [AT]);
    await database.query(`
      ALTER TABLE supplier_services
        ADD CONSTRAINT supplier_services_category_fk FOREIGN KEY (category_code)
          REFERENCES taxonomy_categories(code) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID
    `);
  });

  const instance = await startApi();
  try {
    const anonymousPrivate = await request(instance.api, "/me/supplier-services");
    assert.equal(anonymousPrivate.status, 401, JSON.stringify(anonymousPrivate.body));
    assert.equal(anonymousPrivate.body.error, "unauthorized");
    const invalidPrivateResponse = await fetch(`${instance.api}/me/catalog-items`, {
      headers: { Authorization: "Bearer invalid-session" },
    });
    assert.equal(invalidPrivateResponse.status, 401);
    assert.equal((await invalidPrivateResponse.json()).error, "unauthorized");

    const hidden = await request(instance.api, "/catalog/items/catalog_poster");
    assert.equal(hidden.status, 404, JSON.stringify(hidden.body));

    const updated = await request(instance.api, "/me/catalog-items/catalog_poster", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { expectedVersion: 1, name: "Updated Poster" },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.item.version, 2);

    const stale = await request(instance.api, "/me/catalog-items/catalog_poster", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { expectedVersion: 1, name: "Lost update" },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error, "catalog_item_stale");
    assert.equal(stale.body.currentVersion, 2);

    const reordered = await request(instance.api, "/me/catalog-items/catalog_poster/photos/reorder", {
      method: "POST",
      subject: "clerk_supplier",
      body: { expectedVersion: 2, fileIds: ["catalog_photo_two", "catalog_photo"] },
    });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    assert.equal(reordered.body.item.version, 3);
    assert.deepEqual(reordered.body.item.photos.map((photo) => photo.fileId), ["catalog_photo_two", "catalog_photo"]);

    const legacyUpdate = await request(instance.api, "/supplier-services/svc_banner", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { expectedVersion: 1, turnaroundHours: 12 },
    });
    assert.equal(legacyUpdate.status, 200, JSON.stringify(legacyUpdate.body));
    assert.equal(legacyUpdate.body.service.version, 2);
    assert.equal(legacyUpdate.body.service.turnaroundHours, 12);
    assert.equal(legacyUpdate.body.service.standardTurnaroundHours, 12);

    const staleService = await request(instance.api, "/me/supplier-services/svc_banner", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { expectedVersion: 1, pricingBasis: "per_piece" },
    });
    assert.equal(staleService.status, 409, JSON.stringify(staleService.body));
    assert.equal(staleService.body.error, "supplier_service_stale");
    assert.equal(staleService.body.currentVersion, 2);

    const canonicalAliasUpdate = await request(instance.api, "/supplier-services/svc_banner", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { expectedVersion: 2, categoryCode: "large_format" },
    });
    assert.equal(canonicalAliasUpdate.status, 200, JSON.stringify(canonicalAliasUpdate.body));
    assert.equal(canonicalAliasUpdate.body.service.categoryCode, "marketing_collateral");
    assert.equal(canonicalAliasUpdate.body.service.state, "live");
    assert.equal(canonicalAliasUpdate.body.service.version, 3);

    const legacyAliasUpdate = await request(instance.api, "/me/supplier-services/svc_legacy_alias", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { expectedVersion: 1, pricingBasis: "per_piece" },
    });
    assert.equal(legacyAliasUpdate.status, 200, JSON.stringify(legacyAliasUpdate.body));
    assert.equal(legacyAliasUpdate.body.service.categoryCode, "large_format");
    assert.equal((await database.query(
      "SELECT category_code FROM supplier_services WHERE id = 'svc_legacy_alias'",
    )).rows[0].category_code, "large_format");

    const privateIncompleteSubmit = await request(instance.api, "/me/supplier-services/svc_legacy_alias", {
      method: "PATCH",
      subject: "clerk_supplier",
      body: { expectedVersion: 2, state: "pending_verification" },
    });
    assert.equal(privateIncompleteSubmit.status, 409, JSON.stringify(privateIncompleteSubmit.body));
    assert.equal(privateIncompleteSubmit.body.error, "service_not_review_ready");
    assert.ok(privateIncompleteSubmit.body.blockers.includes("accepted_file_formats"));

    const legacyIncompleteSubmit = await request(instance.api, "/supplier-services/svc_legacy_alias/submit", {
      method: "POST", subject: "clerk_supplier", body: { expectedVersion: 2 },
    });
    assert.equal(legacyIncompleteSubmit.status, 409, JSON.stringify(legacyIncompleteSubmit.body));
    assert.equal(legacyIncompleteSubmit.body.error, "service_not_review_ready");

    const incompleteVerify = await request(instance.api, "/supplier-services/svc_legacy_alias/verify", {
      method: "POST", subject: "clerk_ops", body: { expectedVersion: 2 },
    });
    assert.equal(incompleteVerify.status, 409, JSON.stringify(incompleteVerify.body));
    assert.equal(incompleteVerify.body.error, "service_not_review_ready");

    const suspended = await request(instance.api, "/supplier-services/svc_banner/suspend", {
      method: "POST", subject: "clerk_ops", body: { expectedVersion: 3, reason: "Catalog review" },
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.service.version, 4);
    const resubmitted = await request(instance.api, "/supplier-services/svc_banner/submit", {
      method: "POST", subject: "clerk_supplier", body: { expectedVersion: 4 },
    });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    assert.equal(resubmitted.body.service.state, "pending_verification");
    assert.equal(resubmitted.body.service.version, 5);
    const reverified = await request(instance.api, "/supplier-services/svc_banner/verify", {
      method: "POST", subject: "clerk_ops", body: { expectedVersion: 5 },
    });
    assert.equal(reverified.status, 200, JSON.stringify(reverified.body));
    assert.equal(reverified.body.service.state, "live");
    assert.equal(reverified.body.service.version, 6);
    const withdrawn = await request(instance.api, "/supplier-services/svc_banner/withdraw", {
      method: "POST", subject: "clerk_supplier", body: { expectedVersion: 6 },
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.service.version, 7);
    const withdrawnResubmitted = await request(instance.api, "/supplier-services/svc_banner/submit", {
      method: "POST", subject: "clerk_supplier", body: { expectedVersion: 7 },
    });
    assert.equal(withdrawnResubmitted.status, 200, JSON.stringify(withdrawnResubmitted.body));
    assert.equal(withdrawnResubmitted.body.service.state, "pending_verification");
    assert.equal(withdrawnResubmitted.body.service.version, 8);
    const withdrawnReverified = await request(instance.api, "/supplier-services/svc_banner/verify", {
      method: "POST", subject: "clerk_ops", body: { expectedVersion: 8 },
    });
    assert.equal(withdrawnReverified.status, 200, JSON.stringify(withdrawnReverified.body));
    assert.equal(withdrawnReverified.body.service.state, "live");
    assert.equal(withdrawnReverified.body.service.version, 9);

    await database.transaction(async () => {
      const store = await loadStore(database);
      const approvalCase = store.approvalCases.find((candidate) => candidate.id === "case_supplier");
      approvalCase.status = "approved";
      approvalCase.decidedAt = AT;
      approvalCase.decidedBy = "user_ops";
      approvalCase.updatedAt = AT;
      await saveStore(database, store);
    });

    const visible = await request(instance.api, "/catalog/items/catalog_poster");
    assert.equal(visible.status, 200, JSON.stringify(visible.body));
    assert.equal(visible.body.item.name, "Updated Poster");
    assert.equal(visible.body.item.serviceVersion, 9);
    assert.deepEqual(visible.body.item.acceptedFormats.map((format) => format.code), ["pdf"]);

    const shops = await request(instance.api, "/catalog/shops?categoryCode=marketing_collateral");
    assert.equal(shops.status, 200, JSON.stringify(shops.body));
    assert.equal(shops.body.shops.length, 1);
    assert.equal(shops.body.shops[0].supplierId, "user_supplier");

    const override = await request(instance.api, "/me/catalog-items/catalog_poster/file-formats", {
      method: "PUT",
      subject: "clerk_supplier",
      body: { expectedVersion: 3, mode: "override", formatCodes: ["png"] },
    });
    assert.equal(override.status, 200, JSON.stringify(override.body));
    assert.equal(override.body.item.version, 4);
    assert.deepEqual(override.body.item.acceptedFormats.map((format) => format.code), ["png"]);

    const overriddenPublic = await request(instance.api, "/catalog/items/catalog_poster");
    assert.equal(overriddenPublic.status, 200, JSON.stringify(overriddenPublic.body));
    assert.deepEqual(overriddenPublic.body.item.acceptedFormats.map((format) => format.code), ["png"]);

    const aliasService = await request(instance.api, "/me/supplier-services", {
      method: "POST",
      subject: "clerk_supplier",
      body: {
        categoryCode: "large_format",
        pricingBasis: "per_sqm",
        standardTurnaroundHours: 24,
        formatCodes: ["pdf"],
      },
    });
    assert.equal(aliasService.status, 201, JSON.stringify(aliasService.body));
    assert.equal(aliasService.body.service.categoryCode, "marketing_collateral");
    assert.deepEqual((await database.query(`
      SELECT turnaround_hours, standard_turnaround_hours
        FROM supplier_services WHERE id = $1
    `, [aliasService.body.service.id])).rows[0], {
      turnaround_hours: 24,
      standard_turnaround_hours: 24,
    });
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
