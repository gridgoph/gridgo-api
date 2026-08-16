import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { createDatabase } from "../src/database.js";
import { createPayoutMilestones } from "../src/operational-model.js";
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

async function request(api, pathname, { method = "GET", subject, claims, body } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(subject ? { Authorization: `Bearer ${token(subject, claims)}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
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
    const milestones = createPayoutMilestones(100000);
    for (const milestone of milestones) {
      milestone.status = "released";
      milestone.pofFileIds = ["file_pof"];
      milestone.releasedAt = AT;
      milestone.releasedBy = "user_ops";
    }
    milestones[0].status = "pof_attached";
    milestones[0].releasedAt = null;
    milestones[0].releasedBy = null;
    store.orders.push({
      id: "ord_payout", clientId: "user_client", supplierId: "user_supplier", riderId: null,
      productId: "prod_tarpaulin", state: "completed", zone: "davao_central",
      supplierPriceMinor: 100000, commissionMinor: 10000, subtotalMinor: 110000,
      deliveryFeeMinor: 2500, totalMinor: 112500, downpaymentMinor: 84375, balanceMinor: 28125,
      payoutHold: false, pickup: { lat: 7.064, lng: 125.6085, label: "Davao Shop" },
      dropoff: { lat: 7.08, lng: 125.62, label: "Client" }, payments: {
        downpayment: { amountMinor: 84375, method: "qr_manual", status: "confirmed" },
        balance: { amountMinor: 28125, method: "qr_manual", status: "confirmed" },
      }, payoutMilestones: milestones, timeline: [], createdAt: AT, updatedAt: AT,
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
    const promotedStore = await loadStore(database);
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

    const created = await request(instance.api, "/orders", { method: "POST", subject: "clerk_client", body: { productId: "prod_tarpaulin", title: "API banner", quantity: 1, address: "Bajada", zone: "davao_central", submit: true } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.order.id;
    for (const state of ["needs_qa", "approved_for_matching"]) {
      const transitioned = await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state } });
      assert.equal(transitioned.status, 200, JSON.stringify(transitioned.body));
    }
    assert.equal((await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_ops", body: { state: "supplier_assigned", supplierId: "user_supplier" } })).status, 200);
    const accepted = await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_supplier", body: { state: "supplier_accepted", supplierPriceMinor: 100000 } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.order.state, "awaiting_downpayment");

    assert.equal((await request(instance.api, `/orders/${orderId}/payments/downpayment/submit`, { method: "POST", subject: "clerk_client", body: { method: "qr_manual", reference: "DP-API" } })).status, 200);
    assert.equal((await request(instance.api, `/orders/${orderId}/payments/downpayment/confirm`, { method: "POST", subject: "clerk_supplier", body: {} })).status, 403);
    const confirmed = await request(instance.api, `/orders/${orderId}/payments/downpayment/confirm`, { method: "POST", subject: "clerk_ops", body: {} });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.order.state, "payment_authorized");

    assert.equal((await request(instance.api, `/orders/${orderId}/payments/balance/submit`, { method: "POST", subject: "clerk_client", body: { method: "qr_manual", reference: "BAL-API" } })).status, 200);
    assert.equal((await request(instance.api, `/orders/${orderId}/payments/balance/confirm`, { method: "POST", subject: "clerk_ops", body: {} })).status, 200);
    for (const state of ["production", "supplier_self_qc", "ready_for_dispatch"]) {
      const transitioned = await request(instance.api, `/orders/${orderId}/transition`, { method: "POST", subject: "clerk_supplier", body: { state } });
      assert.equal(transitioned.status, 200, JSON.stringify(transitioned.body));
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
    assert.equal(lifecycleOrder.payments.downpayment.status, "confirmed");
    assert.equal(lifecycleOrder.payments.balance.status, "confirmed");
    assert.equal(lifecycleOrder.state, "out_for_delivery");
    assert.equal(persistedPayment.body.orders.find((order) => order.id === "ord_payout").state, "payout_released");
    assert.equal(persistedPayment.body.orders.find((order) => order.id === "ord_expired").state, "completed");
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
