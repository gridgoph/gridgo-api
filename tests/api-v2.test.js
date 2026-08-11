import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { defaultTaxonomy } from "../src/taxonomy.js";
import { DEMO_PASSWORD } from "../src/demo-fixtures.js";

const LEGACY_DEMO_PASSWORD = "de" + "mo";
const CUSTOM_FIXTURE_PASSWORD = "captain-custom-password";

let api;
let child;
let tempDir;
let storePath;
let secondClientToken;
let secondSupplierToken;
let secondSupplierId;

async function freeHighPort() {
  while (true) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const selected = server.address().port;
        server.close((error) => (error ? reject(error) : resolve(selected)));
      });
    });
    if (port > 10_000 && ![30_000].includes(port)) return port;
  }
}

function fixtureStore() {
  const at = "2026-08-10T00:00:00.000Z";
  return {
    version: 2,
    // Deliberately a pre-migration store: these five carry the retired
    // @gridgo.local addresses the hosted pilot was seeded with, so the whole
    // suite below runs against a store the load-time rename has migrated.
    users: [
      { id: "user_ops", email: "ops@gridgo.local", password: LEGACY_DEMO_PASSWORD, name: "Dina Ops", role: "ops_admin" },
      { id: "user_admin", email: "admin@gridgo.local", password: LEGACY_DEMO_PASSWORD, name: "Eli Admin", role: "super_admin" },
      { id: "user_client", email: "client@gridgo.local", password: CUSTOM_FIXTURE_PASSWORD, name: "Ana Client", role: "client", accountType: "individual" },
      { id: "client-existing", email: "existing@example.test", password: "secret123", name: "Existing", role: "client", accountType: "individual" },
      {
        id: "user_supplier",
        email: "supplier@gridgo.local",
        password: LEGACY_DEMO_PASSWORD,
        name: "Ben Supplier",
        role: "supplier",
        supplierName: "PrintRight Davao",
        shop: { lat: 7.064, lng: 125.6085, label: "PrintRight" },
        categoryRanks: [{ categoryCode: "marketing_collateral", rank: 1 }],
        verificationStatus: "approved",
        verificationDocumentFileIds: ["file-verification-id"],
      },
    ],
    sessions: {},
    catalog: [{ id: "prod_flyer", name: "Flyers", family: "flyer", basePriceMinor: 25_000, unit: "pack" }],
    taxonomy: defaultTaxonomy(),
    zones: [{ id: "zone-c", code: "davao_central", name: "Central", deliveryFeeMinor: 15_000, active: true }],
    supplierServices: [],
    orders: [
      {
        id: "ord-match",
        clientId: "client-existing",
        supplierId: null,
        riderId: null,
        state: "approved_for_matching",
        productId: "prod_flyer",
        title: "Match test flyers",
        quantity: 100,
        material: "matte 150gsm",
        zone: "davao_central",
        address: "Bajada, Davao City",
        pickup: null,
        dropoff: { lat: 7.0865, lng: 125.6135, label: "Bajada, Davao City" },
        totalMinor: 25_000,
        deliveryFeeMinor: 15_000,
        timeline: [{ at, state: "approved_for_matching", by: "user_ops", note: "QA approved" }],
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "ord-offer",
        clientId: "client-existing",
        supplierId: "user_supplier",
        riderId: null,
        state: "ready_for_dispatch",
        productId: "prod_flyer",
        title: "Dispatch test",
        quantity: 100,
        material: "matte 150gsm",
        zone: "davao_central",
        address: "Bajada, Davao City",
        pickup: { lat: 7.064, lng: 125.6085, label: "PrintRight" },
        dropoff: { lat: 7.0865, lng: 125.6135, label: "Bajada, Davao City" },
        totalMinor: 25_000,
        deliveryFeeMinor: 15_000,
        timeline: [],
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "ord-legacy-pay",
        clientId: "client-existing",
        supplierId: "user_supplier",
        riderId: null,
        state: "awaiting_payment",
        productId: "prod_flyer",
        title: "Legacy COD risk path",
        quantity: 100,
        material: "matte 150gsm",
        zone: "davao_central",
        address: "Bajada, Davao City",
        pickup: { lat: 7.064, lng: 125.6085, label: "PrintRight" },
        dropoff: { lat: 7.0865, lng: 125.6135, label: "Bajada, Davao City" },
        totalMinor: 25_000,
        deliveryFeeMinor: 15_000,
        paymentMethod: null,
        paymentStatus: "unpaid",
        codEligible: true,
        timeline: [],
        createdAt: at,
        updatedAt: at,
      },
    ],
    files: [
      {
        fileId: "file-verification-id",
        objectKey: "verification_document/test/private-id.pdf",
        ownerId: "user_supplier",
        purpose: "verification_document",
        verificationDocumentType: "valid_id",
        originalFilename: "supplier-id.pdf",
        declaredContentType: "application/pdf",
        detectedContentType: "application/pdf",
        size: 64,
        state: "ready",
        createdAt: at,
        readyAt: at,
        deleteRequestedAt: null,
        deletedAt: null,
        references: [
          {
            type: "user",
            id: "user_supplier",
            field: "verificationDocumentFileIds",
            documentType: "valid_id",
          },
        ],
      },
    ],
    credits: {},
    claims: [],
    issues: [],
    auditLog: [],
    notifications: [
      { id: "ntf_client_old", userId: "client-existing", title: "Old", body: "Old client notification", read: false, at: "2026-08-10T01:00:00.000Z" },
      { id: "ntf_ops_private", userId: "user_ops", title: "Ops", body: "Ops-only notification", read: false, at: "2026-08-10T02:00:00.000Z" },
      { id: "ntf_client_new", userId: "client-existing", title: "New", body: "New client notification", read: false, at: "2026-08-10T03:00:00.000Z" },
    ],
    locationPings: [],
    proofs: [],
  };
}

async function request(pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

async function login(email, password = DEMO_PASSWORD) {
  const response = await request("/auth/login", { method: "POST", body: { email, password } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token;
}

async function openNotificationStream(token, lastEventId) {
  const controller = new AbortController();
  const response = await fetch(`${api}/notifications/stream`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  async function nextFrame(timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        return frame;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SSE frame timeout");
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SSE frame timeout")), remaining)),
      ]);
      if (result.done) throw new Error("SSE stream closed");
      buffered += decoder.decode(result.value, { stream: true });
    }
  }

  async function nextNotification(timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const frame = await nextFrame(deadline - Date.now());
      if (!frame.includes("event: notification")) continue;
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      return { frame, notification: JSON.parse(data) };
    }
  }

  return {
    close() {
      controller.abort();
    },
    nextFrame,
    nextNotification,
  };
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gridgo-v2-api-test-"));
  storePath = path.join(tempDir, "store.json");
  await fs.writeFile(storePath, JSON.stringify(fixtureStore(), null, 2));
  const port = await freeHighPort();
  api = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      STORE_PATH: storePath,
      PORT: String(port),
      HOST: "127.0.0.1",
      NOTIFICATION_HEARTBEAT_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`API exited during test startup:\n${output}`);
    try {
      const response = await fetch(`${api}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`API did not start:\n${output}`);
});

after(async () => {
  if (child?.exitCode == null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test("load renames the retired gridgo.local pilot logins without renumbering ids", async () => {
  const migrated = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.deepEqual(
    migrated.users.filter(({ email }) => String(email).endsWith("@gridgo.local")),
    [],
    "a retired .local address survived load()",
  );
  for (const [id, email] of [
    ["user_ops", "ops@gridgo.ph"],
    ["user_admin", "admin@gridgo.ph"],
    ["user_client", "client@gridgo.ph"],
    ["user_supplier", "supplier@gridgo.ph"],
  ]) {
    assert.equal(migrated.users.find((user) => user.id === id)?.email, email);
  }
  // The one non-fixture account in this store keeps its own address.
  assert.equal(migrated.users.find(({ id }) => id === "client-existing")?.email, "existing@example.test");
});

test("fixture convergence rotates only the retired demo credential and is idempotent", async () => {
  const migrated = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(migrated.users.find(({ email }) => email === "ops@gridgo.ph")?.password, DEMO_PASSWORD);
  assert.equal(migrated.users.find(({ email }) => email === "supplier@gridgo.ph")?.password, DEMO_PASSWORD);
  assert.equal(migrated.users.find(({ email }) => email === "client@gridgo.ph")?.password, CUSTOM_FIXTURE_PASSWORD);

  const beforeSecondLoad = await fs.readFile(storePath, "utf8");
  const health = await fetch(`${api}/health`);
  assert.equal(health.status, 200);
  assert.equal(await fs.readFile(storePath, "utf8"), beforeSecondLoad, "second load changed the store");

  const oldLogin = await request("/auth/login", {
    method: "POST",
    body: { email: "ops@gridgo.ph", password: LEGACY_DEMO_PASSWORD },
  });
  assert.equal(oldLogin.status, 401);
  assert.equal(oldLogin.body.error, "invalid_credentials");
});

test("all three roles self-sign up with exact profiles and pending approval gates", async () => {
  const client = await request("/auth/signup", {
    method: "POST",
    body: {
      role: "client",
      email: "new-client@example.test",
      password: "strong-pass",
      name: "New Client",
      phone: "+639171111111",
      accountType: "personal",
    },
  });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  secondClientToken = client.body.token;
  assert.equal(client.body.user.accountType, "individual");
  assert.equal("password" in client.body.user, false);
  assert.match(client.body.token, /^tok_/);

  const supplier = await request("/auth/signup", {
    method: "POST",
    body: {
      role: "supplier",
      email: "new-supplier@example.test",
      password: "strong-pass",
      name: "Sam Supplier",
      phone: "+639172222222",
      supplierName: "Sam's Print Shop",
      shop: { lat: 7.064, lng: 125.6085, label: "C.M. Recto St, Davao City" },
      categoryRanks: [
        { categoryCode: "marketing_collateral", rank: 1 },
        { categoryCode: "corporate_event_merch", rank: 2 },
      ],
    },
  });
  assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
  secondSupplierToken = supplier.body.token;
  secondSupplierId = supplier.body.user.id;
  assert.equal(supplier.body.user.verificationStatus, "pending");
  assert.deepEqual(supplier.body.user.categoryRanks.map((item) => item.rank), [1, 2]);

  const rider = await request("/auth/signup", {
    method: "POST",
    body: {
      role: "rider",
      email: "new-rider@example.test",
      password: "strong-pass",
      name: "Rae Rider",
      phone: "+639173333333",
      riderProfile: { vehicleType: "motorcycle", vehiclePlate: "ABC 1234", licenseNumber: "N01-23-456789" },
    },
  });
  assert.equal(rider.status, 201, JSON.stringify(rider.body));
  assert.equal(rider.body.user.verificationStatus, "pending");

  const duplicate = await request("/auth/signup", {
    method: "POST",
    body: {
      role: "client",
      email: "new-client@example.test",
      password: "another-pass",
      name: "Duplicate",
      phone: "+639174444444",
      accountType: "individual",
    },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "email_already_registered");

  const badRanks = await request("/auth/signup", {
    method: "POST",
    body: {
      role: "supplier",
      email: "bad-ranks@example.test",
      password: "strong-pass",
      name: "Bad Ranks",
      phone: "+639175555555",
      supplierName: "Bad Ranks Shop",
      shop: { lat: 7.064, lng: 125.6085, label: "Davao City" },
      categoryRanks: [{ categoryCode: "marketing_collateral", rank: 2 }],
    },
  });
  assert.equal(badRanks.status, 400);
  assert.equal(badRanks.body.error, "invalid_category_ranks");

  const opsToken = await login("ops@gridgo.ph");
  const candidatesBefore = await request("/orders/ord-match/eligible-suppliers", { token: opsToken });
  const pendingCandidate = candidatesBefore.body.candidates.find((item) => item.supplier.id === supplier.body.user.id);
  assert.equal(pendingCandidate.eligible, false);
  assert.deepEqual(pendingCandidate.reasons, ["verification_status:pending"]);

  const pendingSupplierAssignment = await request("/orders/ord-match/transition", {
    method: "POST",
    token: opsToken,
    body: { state: "supplier_assigned", supplierId: supplier.body.user.id },
  });
  assert.equal(pendingSupplierAssignment.status, 409);
  assert.equal(pendingSupplierAssignment.body.error, "supplier_not_approved");

  const offersBefore = await request("/dispatch/offers", { token: rider.body.token });
  assert.equal(offersBefore.status, 403);
  assert.equal(offersBefore.body.error, "rider_not_approved");

  const pendingRiderTransition = await request("/orders/ord-offer/transition", {
    method: "POST",
    token: rider.body.token,
    body: { state: "rider_assigned" },
  });
  assert.equal(pendingRiderTransition.status, 403);
  assert.equal(pendingRiderTransition.body.error, "rider_not_approved");

  const approveSupplier = await request(`/users/${supplier.body.user.id}/verification`, {
    method: "POST",
    token: opsToken,
    body: { status: "approved", reason: "Profile and equipment verified" },
  });
  assert.equal(approveSupplier.status, 200);

  const approveRider = await request(`/users/${rider.body.user.id}/verification`, {
    method: "POST",
    token: opsToken,
    body: { status: "approved", reason: "License and vehicle verified" },
  });
  assert.equal(approveRider.status, 200);

  const offersAfter = await request("/dispatch/offers", { token: rider.body.token });
  assert.equal(offersAfter.status, 200);
  assert.equal(offersAfter.body.offers.some((order) => order.id === "ord-offer"), true);
});

test("supplier verification documents stay private and appear on the Operations approval surface", async () => {
  const ownerToken = await login("supplier@gridgo.ph");
  const opsToken = await login("ops@gridgo.ph");
  const superToken = await login("admin@gridgo.ph");
  const riderToken = await login("rider@gridgo.ph");

  const ownDocuments = await request("/users/user_supplier/verification-documents", { token: ownerToken });
  assert.equal(ownDocuments.status, 200, JSON.stringify(ownDocuments.body));
  assert.equal(ownDocuments.body.verificationDocuments.length, 1);
  assert.equal(ownDocuments.body.verificationDocuments[0].verificationDocumentType, "valid_id");

  const approvalSurface = await request("/users/user_supplier", { token: opsToken });
  assert.equal(approvalSurface.status, 200);
  assert.equal(approvalSurface.body.verificationDocuments[0].fileId, "file-verification-id");
  assert.equal("verificationDocumentFileIds" in approvalSurface.body.user, false);

  for (const token of [opsToken, superToken]) {
    const response = await request("/files/file-verification-id", { token });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  for (const token of [secondSupplierToken, secondClientToken, riderToken]) {
    const metadata = await request("/files/file-verification-id", { token });
    assert.equal(metadata.status, 403, JSON.stringify(metadata.body));
    assert.equal(metadata.body.error, "forbidden");
    const documents = await request("/users/user_supplier/verification-documents", { token });
    assert.equal(documents.status, 403, JSON.stringify(documents.body));
    assert.equal(documents.body.error, "forbidden");
  }
  const anotherSupplierDownload = await request("/files/file-verification-id/download-url", {
    token: secondSupplierToken,
  });
  assert.equal(anotherSupplierDownload.status, 403);
  assert.equal(anotherSupplierDownload.body.error, "forbidden");
});

test("notification read, unread, mark-all snapshot, deletion, and ownership are server-persisted", async () => {
  const clientToken = await login("existing@example.test", "secret123");
  const initial = await request("/notifications", { token: clientToken });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.notifications.some((notification) => notification.userId !== "client-existing"), false);
  assert.equal(initial.body.notifications.some((notification) => notification.id === "ntf_client_new"), true);
  assert.equal(initial.body.notifications.some((notification) => notification.id === "ntf_client_old"), true);
  assert.equal(typeof initial.body.snapshot, "string");
  const initiallyUnreadIds = initial.body.notifications
    .filter((notification) => !notification.read)
    .map((notification) => notification.id);

  const marked = await request("/notifications/ntf_client_old", {
    method: "PATCH",
    token: clientToken,
    body: { read: true },
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.notification.read, true);

  const unread = await request("/notifications/ntf_client_old", {
    method: "PATCH",
    token: clientToken,
    body: { read: false },
  });
  assert.equal(unread.status, 200);
  assert.equal(unread.body.notification.read, false);

  const invalidRead = await request("/notifications/ntf_client_old", {
    method: "PATCH",
    token: clientToken,
    body: { read: "yes" },
  });
  assert.equal(invalidRead.status, 400);
  assert.equal(invalidRead.body.error, "notification_read_required");

  const beforeArrival = JSON.parse(await fs.readFile(storePath, "utf8"));
  beforeArrival.notifications.push({
    id: "ntf_client_after_snapshot",
    userId: "client-existing",
    title: "Later",
    body: "Arrived after the list snapshot",
    read: false,
    at: "2026-08-10T04:00:00.000Z",
  });
  await fs.writeFile(storePath, JSON.stringify(beforeArrival, null, 2));

  const markedAll = await request("/notifications/read-all", {
    method: "PATCH",
    token: clientToken,
    body: { snapshot: initial.body.snapshot },
  });
  assert.equal(markedAll.status, 200);
  assert.equal(markedAll.body.updatedCount, initiallyUnreadIds.length);
  const afterMarkAll = await request("/notifications", { token: clientToken });
  for (const notificationId of initiallyUnreadIds) {
    assert.equal(afterMarkAll.body.notifications.find((item) => item.id === notificationId).read, true);
  }
  assert.equal(afterMarkAll.body.notifications.find((item) => item.id === "ntf_client_after_snapshot").read, false);

  for (const method of ["PATCH", "DELETE"]) {
    const refusal = await request("/notifications/ntf_ops_private", {
      method,
      token: clientToken,
      ...(method === "PATCH" ? { body: { read: true } } : {}),
    });
    assert.equal(refusal.status, 403);
    assert.equal(refusal.body.error, "forbidden");
  }
  const bulkRefusal = await request("/notifications/read-all", {
    method: "PATCH",
    token: clientToken,
    body: { snapshot: "ntf_ops_private" },
  });
  assert.equal(bulkRefusal.status, 403);
  assert.equal(bulkRefusal.body.error, "forbidden");

  const deleted = await request("/notifications/ntf_client_old", { method: "DELETE", token: clientToken });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.id, "ntf_client_old");
  assert.match(deleted.body.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
  const deletedAgain = await request("/notifications/ntf_client_old", { method: "DELETE", token: clientToken });
  assert.deepEqual(deletedAgain.body, deleted.body, "delete retries must be idempotent");

  const afterDelete = await request("/notifications", { token: clientToken });
  assert.equal(afterDelete.body.notifications.some((item) => item.id === "ntf_client_old"), false);
  const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(
    persisted.notifications.find((item) => item.id === "ntf_client_old").deletedAt,
    deleted.body.deletedAt,
    "soft deletion must retain internal notification evidence",
  );
});

test("notification stream rejects unauthenticated and foreign resume attempts", async () => {
  const unauthenticated = await request("/notifications/stream");
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error, "unauthorized");

  const clientToken = await login("existing@example.test", "secret123");
  const foreignResume = await fetch(`${api}/notifications/stream`, {
    headers: {
      Authorization: `Bearer ${clientToken}`,
      "Last-Event-ID": "ntf_ops_private",
    },
  });
  assert.equal(foreignResume.status, 403);
  assert.deepEqual(await foreignResume.json(), { error: "forbidden" });

  const unknownResume = await fetch(`${api}/notifications/stream`, {
    headers: {
      Authorization: `Bearer ${clientToken}`,
      "Last-Event-ID": "ntf_missing",
    },
  });
  assert.equal(unknownResume.status, 409);
  assert.deepEqual(await unknownResume.json(), { error: "notification_resume_unavailable" });

  const emptyList = await request("/notifications", { token: secondClientToken });
  assert.equal(emptyList.body.snapshot, null);
  const secondClient = await request("/auth/me", { token: secondClientToken });
  const afterEmptySnapshot = JSON.parse(await fs.readFile(storePath, "utf8"));
  afterEmptySnapshot.notifications.push({
    id: "ntf_after_empty_snapshot",
    userId: secondClient.body.user.id,
    title: "First notification",
    body: "Arrived between the empty list and stream connection",
    read: false,
    at: "2026-08-10T05:00:00.000Z",
  });
  await fs.writeFile(storePath, JSON.stringify(afterEmptySnapshot, null, 2));
  const firstStream = await openNotificationStream(secondClientToken);
  assert.match(await firstStream.nextFrame(), /^retry: 5000$/);
  const firstEvent = await firstStream.nextNotification();
  assert.equal(firstEvent.notification.id, "ntf_after_empty_snapshot");
  firstStream.close();
});

test("assignment calculates final price, notifies the client, and never leaks commission to clients", async () => {
  const clientToken = await login("existing@example.test", "secret123");
  const supplierToken = await login("supplier@gridgo.ph");
  const opsToken = await login("ops@gridgo.ph");

  const created = await request("/orders", {
    method: "POST",
    token: clientToken,
    body: {
      productId: "prod_flyer",
      quantity: 2,
      title: "Range before assignment",
      address: "Bajada, Davao City",
      zone: "davao_central",
      deliveryFeeMinor: 1,
      submit: true,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(Number.isInteger(created.body.order.priceRange.subtotalMinMinor), true);
  assert.equal(Number.isInteger(created.body.order.priceRange.subtotalMaxMinor), true);
  assert.equal(created.body.order.priceRange.deliveryFeeStatus, "pending_supplier_assignment");
  assert.equal(JSON.stringify(created.body).includes("commissionMinor"), false);
  assert.equal(JSON.stringify(created.body).includes("supplierPriceMinor"), false);

  const ownerDraft = await request("/orders", {
    method: "POST",
    token: clientToken,
    body: { productId: "prod_flyer", quantity: 1, title: "Ownership boundary", submit: false },
  });
  const otherClientTransition = await request(`/orders/${ownerDraft.body.order.id}/transition`, {
    method: "POST",
    token: secondClientToken,
    body: { state: "submitted" },
  });
  assert.equal(otherClientTransition.status, 403);
  assert.equal(otherClientTransition.body.error, "forbidden");

  const assigned = await request("/orders/ord-match/transition", {
    method: "POST",
    token: opsToken,
    body: { state: "supplier_assigned", supplierId: "user_supplier" },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));

  const beforeAcceptance = await request("/notifications", { token: clientToken });
  const opsBeforeAcceptance = await request("/notifications", { token: opsToken });
  const clientStream = await openNotificationStream(clientToken, beforeAcceptance.body.snapshot);
  const opsStream = await openNotificationStream(opsToken, opsBeforeAcceptance.body.snapshot);
  assert.match(await clientStream.nextFrame(), /^retry: 5000$/);
  assert.match(await clientStream.nextFrame(), /^: heartbeat /);
  assert.match(await opsStream.nextFrame(), /^retry: 5000$/);

  const accepted = await request("/orders/ord-match/transition", {
    method: "POST",
    token: supplierToken,
    body: { state: "supplier_accepted", supplierPriceMinor: 100_000, promisedDate: "2026-08-12T09:00:00.000Z" },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.order.state, "awaiting_downpayment");
  assert.equal(accepted.body.order.supplierPriceMinor, 100_000);
  assert.equal("commissionMinor" in accepted.body.order, false);
  assert.equal(accepted.body.order.subtotalMinor, 110_000);
  assert.equal(accepted.body.order.deliveryFeeMinor, 2_500);
  assert.equal(accepted.body.order.totalMinor, 112_500);
  assert.equal(accepted.body.order.downpaymentMinor, 84_375);
  assert.equal(accepted.body.order.balanceMinor, 28_125);
  assert.match(accepted.body.order.assignmentNotificationId, /^ntf_/);

  const liveEvent = await clientStream.nextNotification();
  assert.match(liveEvent.frame, new RegExp(`^id: ${accepted.body.order.assignmentNotificationId}\\n`));
  assert.equal(liveEvent.notification.id, accepted.body.order.assignmentNotificationId);
  assert.equal(liveEvent.notification.userId, "client-existing");
  await assert.rejects(opsStream.nextNotification(150), /SSE frame timeout/);
  clientStream.close();
  opsStream.close();

  const resumedStream = await openNotificationStream(clientToken, beforeAcceptance.body.snapshot);
  assert.match(await resumedStream.nextFrame(), /^retry: 5000$/);
  const replayedEvent = await resumedStream.nextNotification();
  assert.equal(replayedEvent.notification.id, accepted.body.order.assignmentNotificationId);
  resumedStream.close();

  const otherSupplierJobs = await request("/jobs", { token: secondSupplierToken });
  assert.equal(otherSupplierJobs.status, 200);
  assert.equal(otherSupplierJobs.body.jobs.some((order) => order.id === "ord-match"), false);

  const clientOrder = await request("/orders/ord-match", { token: clientToken });
  assert.equal(clientOrder.status, 200);
  const clientJson = JSON.stringify(clientOrder.body);
  assert.equal(clientJson.includes("supplierPriceMinor"), false);
  assert.equal(clientJson.includes("commissionMinor"), false);
  assert.equal(clientJson.includes("commissionRatePercent"), false);
  assert.equal(clientOrder.body.order.payoutMilestones.every((milestone) => !("amountMinor" in milestone)), true);
  assert.equal(clientOrder.body.order.payments.downpayment.amountMinor, 84_375);
  assert.equal(clientOrder.body.order.subtotalMinor, 110_000);

  const opsOrder = await request("/orders/ord-match", { token: opsToken });
  assert.equal(opsOrder.body.order.supplierPriceMinor, 100_000);
  assert.equal(opsOrder.body.order.commissionMinor, 10_000);
  assert.equal(opsOrder.body.order.commissionRatePercent, 10);

  const notifications = await request("/notifications", { token: clientToken });
  assert.equal(
    notifications.body.notifications.some(
      (notification) => notification.id === accepted.body.order.assignmentNotificationId && notification.orderId === "ord-match",
    ),
    true,
  );
});

test("suppliers move only their own shop, Operations can move any, and in-flight orders keep agreed pricing", async () => {
  const opsToken = await login("ops@gridgo.ph");
  const superToken = await login("admin@gridgo.ph");
  const demoSupplierToken = await login("supplier@gridgo.ph");

  const ownMove = await request(`/users/${secondSupplierId}/shop`, {
    method: "PATCH",
    token: secondSupplierToken,
    body: { shop: { lat: 7.0701, lng: 125.6202, label: "New supplier building" } },
  });
  assert.equal(ownMove.status, 200, JSON.stringify(ownMove.body));
  assert.deepEqual(ownMove.body.user.shop, { lat: 7.0701, lng: 125.6202, label: "New supplier building" });

  const otherMove = await request("/users/user_supplier/shop", {
    method: "PATCH",
    token: secondSupplierToken,
    body: { shop: { lat: 7.071, lng: 125.621, label: "Not my shop" } },
  });
  assert.equal(otherMove.status, 403);
  assert.equal(otherMove.body.error, "forbidden");
  const clientMove = await request(`/users/${secondSupplierId}/shop`, {
    method: "PATCH",
    token: secondClientToken,
    body: { shop: { lat: 7.071, lng: 125.621, label: "Clients cannot move supplier pins" } },
  });
  assert.equal(clientMove.status, 403);

  for (const shop of [
    { lat: "7.07", lng: 125.62, label: "Numeric strings are not coordinates" },
    { lat: 91, lng: 125.62, label: "Outside Earth" },
    { lat: 7.07, lng: 181, label: "Outside Earth" },
    { lat: null, lng: 125.62, label: "Missing latitude" },
  ]) {
    const invalid = await request(`/users/${secondSupplierId}/shop`, {
      method: "PATCH",
      token: secondSupplierToken,
      body: { shop },
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.equal(invalid.body.error, "invalid_shop_coordinates");
  }
  const blankLabel = await request(`/users/${secondSupplierId}/shop`, {
    method: "PATCH",
    token: secondSupplierToken,
    body: { shop: { lat: 7.07, lng: 125.62, label: "   " } },
  });
  assert.equal(blankLabel.status, 400);
  assert.equal(blankLabel.body.error, "shop_label_required");

  const before = await request("/orders/ord-match", { token: opsToken });
  const agreedSnapshot = {
    pickup: before.body.order.pickup,
    deliveryDistanceMeters: before.body.order.deliveryDistanceMeters,
    deliveryFeeMinor: before.body.order.deliveryFeeMinor,
    totalMinor: before.body.order.totalMinor,
    downpaymentMinor: before.body.order.downpaymentMinor,
    balanceMinor: before.body.order.balanceMinor,
  };
  const operationsMove = await request("/users/user_supplier/shop", {
    method: "PATCH",
    token: opsToken,
    body: { shop: { lat: 7.1901, lng: 125.4102, label: "Relocated PrintRight" } },
  });
  assert.equal(operationsMove.status, 200, JSON.stringify(operationsMove.body));
  const afterMove = await request("/orders/ord-match", { token: opsToken });
  assert.deepEqual(
    {
      pickup: afterMove.body.order.pickup,
      deliveryDistanceMeters: afterMove.body.order.deliveryDistanceMeters,
      deliveryFeeMinor: afterMove.body.order.deliveryFeeMinor,
      totalMinor: afterMove.body.order.totalMinor,
      downpaymentMinor: afterMove.body.order.downpaymentMinor,
      balanceMinor: afterMove.body.order.balanceMinor,
    },
    agreedSnapshot,
  );

  const superMove = await request(`/users/${secondSupplierId}/shop`, {
    method: "PATCH",
    token: superToken,
    body: { shop: { lat: 7.072, lng: 125.622, label: "Supervised supplier pin" } },
  });
  assert.equal(superMove.status, 200, JSON.stringify(superMove.body));

  const demoSupplierCannotMoveAnother = await request(`/users/${secondSupplierId}/shop`, {
    method: "PATCH",
    token: demoSupplierToken,
    body: { shop: { lat: 7.08, lng: 125.63, label: "Still not my shop" } },
  });
  assert.equal(demoSupplierCannotMoveAnother.status, 403);
});

test("Operations and Super Admin can change the one global issue window and provisional distance bands", async () => {
  const clientToken = await login("existing@example.test", "secret123");
  const opsToken = await login("ops@gridgo.ph");
  const settings = await request("/settings", { token: clientToken });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.settings.issueWindowHours, 24);
  assert.deepEqual(settings.body.settings.deliveryFeeBands, [
    { maxDistanceMeters: 4_999, feeMinor: 2_500 },
    { maxDistanceMeters: 10_000, feeMinor: 5_000 },
    { maxDistanceMeters: null, feeMinor: 7_500 },
  ]);

  const updated = await request("/settings", {
    method: "PATCH",
    token: opsToken,
    body: {
      issueWindowHours: 48,
      deliveryFeeBands: [
        { maxDistanceMeters: 4_999, feeMinor: 3_000 },
        { maxDistanceMeters: 10_000, feeMinor: 6_000 },
        { maxDistanceMeters: null, feeMinor: 9_000 },
      ],
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.settings.issueWindowHours, 48);
  assert.equal(updated.body.settings.deliveryFeeBands[0].feeMinor, 3_000);

  const forbidden = await request("/settings", {
    method: "PATCH",
    token: clientToken,
    body: { issueWindowHours: 12 },
  });
  assert.equal(forbidden.status, 403);
});

test("manual Operations payment review supports rejection, resubmission, confirmation, and no COD", async () => {
  const clientToken = await login("existing@example.test", "secret123");
  const opsToken = await login("ops@gridgo.ph");
  const superToken = await login("admin@gridgo.ph");

  const clientOrders = await request("/orders", { token: clientToken });
  const unassigned = clientOrders.body.orders.find((order) => order.title === "Range before assignment");
  const tooEarly = await request(`/orders/${unassigned.id}/payments/downpayment/submit`, {
    method: "POST",
    token: clientToken,
    body: { method: "qr_manual", reference: "GCASH-EARLY" },
  });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error, "assignment_notification_required");

  const codBalance = await request("/orders/ord-match/payments/balance/submit", {
    method: "POST",
    token: clientToken,
    body: { method: "cod", reference: "CASH" },
  });
  assert.equal(codBalance.status, 400);
  assert.equal(codBalance.body.error, "payment_method_not_allowed");

  const downpayment = await request("/orders/ord-match/payments/downpayment/submit", {
    method: "POST",
    token: clientToken,
    body: { method: "qr_manual", reference: "GCASH-DOWN-1125" },
  });
  assert.equal(downpayment.status, 200, JSON.stringify(downpayment.body));
  assert.equal(downpayment.body.order.state, "downpayment_review");
  assert.equal(downpayment.body.order.payments.downpayment.status, "pending_confirmation");
  assert.equal(downpayment.body.order.payments.downpayment.amountMinor, 84_375);

  const clientReject = await request("/orders/ord-match/payments/downpayment/reject", {
    method: "POST",
    token: clientToken,
    body: { reason: "The reference does not match the Operations wallet. Check it and submit the correct e-wallet reference." },
  });
  assert.equal(clientReject.status, 403);

  const missingReason = await request("/orders/ord-match/payments/downpayment/reject", {
    method: "POST",
    token: opsToken,
    body: { reason: "   " },
  });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.error, "payment_rejection_reason_required");
  assert.match(missingReason.body.message, /what is wrong.*correct/i);

  const rejectionReason = "The submitted GCash reference does not match the Operations wallet. Check the reference and submit it again.";
  const rejectedDownpayment = await request("/orders/ord-match/payments/downpayment/reject", {
    method: "POST",
    token: opsToken,
    body: { reason: `  ${rejectionReason}  ` },
  });
  assert.equal(rejectedDownpayment.status, 200, JSON.stringify(rejectedDownpayment.body));
  assert.equal(rejectedDownpayment.body.order.state, "awaiting_downpayment");
  assert.equal(rejectedDownpayment.body.order.paymentStatus, "unpaid");
  assert.equal(rejectedDownpayment.body.order.payments.downpayment.status, "not_submitted");
  assert.equal(rejectedDownpayment.body.order.payments.downpayment.reference, null);
  assert.equal(rejectedDownpayment.body.order.payments.downpayment.submittedAt, null);
  assert.equal(rejectedDownpayment.body.order.payments.downpayment.rejectedBy, "user_ops");
  assert.match(rejectedDownpayment.body.order.payments.downpayment.rejectedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(rejectedDownpayment.body.order.payments.downpayment.rejectionReason, rejectionReason);
  assert.equal(rejectedDownpayment.body.order.timeline.at(-1).by, "user_ops");
  assert.match(rejectedDownpayment.body.order.timeline.at(-1).note, new RegExp(rejectionReason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const rejectedClientOrder = await request("/orders/ord-match", { token: clientToken });
  assert.equal(rejectedClientOrder.status, 200);
  assert.equal(rejectedClientOrder.body.order.payments.downpayment.rejectionReason, rejectionReason);
  assert.equal(rejectedClientOrder.body.order.payments.downpayment.rejectedBy, "user_ops");

  const rejectionAudit = await request("/audit?action=payment.downpayment_reject&orderId=ord-match", { token: opsToken });
  assert.equal(rejectionAudit.status, 200);
  assert.equal(rejectionAudit.body.audit.at(-1).action, "payment.downpayment_reject");
  assert.equal(rejectionAudit.body.audit.at(-1).actorId, "user_ops");
  assert.equal(rejectionAudit.body.audit.at(-1).reason, rejectionReason);

  const resubmittedDownpayment = await request("/orders/ord-match/payments/downpayment/submit", {
    method: "POST",
    token: clientToken,
    body: { method: "qr_manual", reference: "GCASH-DOWN-CORRECTED-1125" },
  });
  assert.equal(resubmittedDownpayment.status, 200, JSON.stringify(resubmittedDownpayment.body));
  assert.equal(resubmittedDownpayment.body.order.payments.downpayment.status, "pending_confirmation");
  assert.equal(resubmittedDownpayment.body.order.payments.downpayment.reference, "GCASH-DOWN-CORRECTED-1125");
  assert.equal(resubmittedDownpayment.body.order.payments.downpayment.rejectedAt, null);
  assert.equal(resubmittedDownpayment.body.order.payments.downpayment.rejectedBy, null);
  assert.equal(resubmittedDownpayment.body.order.payments.downpayment.rejectionReason, null);

  const clientConfirm = await request("/orders/ord-match/payments/downpayment/confirm", {
    method: "POST",
    token: clientToken,
    body: { note: "self confirm" },
  });
  assert.equal(clientConfirm.status, 403);

  const confirmedDownpayment = await request("/orders/ord-match/payments/downpayment/confirm", {
    method: "POST",
    token: opsToken,
    body: { note: "QR reference matched Operations wallet" },
  });
  assert.equal(confirmedDownpayment.status, 200, JSON.stringify(confirmedDownpayment.body));
  assert.equal(confirmedDownpayment.body.order.state, "payment_authorized");
  assert.equal(confirmedDownpayment.body.order.payments.downpayment.status, "confirmed");
  assert.equal(confirmedDownpayment.body.order.payments.downpayment.confirmationSource, "manual_ops");

  const confirmedReject = await request("/orders/ord-match/payments/downpayment/reject", {
    method: "POST",
    token: superToken,
    body: { reason: "This accepted payment must remain accepted." },
  });
  assert.equal(confirmedReject.status, 409);
  assert.equal(confirmedReject.body.error, "payment_already_confirmed");
  assert.match(confirmedReject.body.message, /accepted.*cannot be rejected/i);

  const balance = await request("/orders/ord-match/payments/balance/submit", {
    method: "POST",
    token: clientToken,
    body: { method: "qr_manual", reference: "MAYA-BALANCE-1125" },
  });
  assert.equal(balance.status, 200, JSON.stringify(balance.body));
  assert.equal(balance.body.order.payments.balance.status, "pending_confirmation");
  assert.equal(balance.body.order.payments.balance.amountMinor, 28_125);

  const rejectedBalance = await request("/orders/ord-match/payments/balance/reject", {
    method: "POST",
    token: superToken,
    body: { reason: "The Maya reference is missing one digit. Check the receipt and submit the complete reference." },
  });
  assert.equal(rejectedBalance.status, 200, JSON.stringify(rejectedBalance.body));
  assert.equal(rejectedBalance.body.order.payments.balance.status, "not_submitted");
  assert.equal(rejectedBalance.body.order.paymentStatus, "downpayment_confirmed");

  const resubmittedBalance = await request("/orders/ord-match/payments/balance/submit", {
    method: "POST",
    token: clientToken,
    body: { method: "qr_manual", reference: "MAYA-BALANCE-CORRECTED-1125" },
  });
  assert.equal(resubmittedBalance.status, 200, JSON.stringify(resubmittedBalance.body));
  assert.equal(resubmittedBalance.body.order.payments.balance.status, "pending_confirmation");

  const confirmedBalance = await request("/orders/ord-match/payments/balance/confirm", {
    method: "POST",
    token: opsToken,
    body: { note: "Balance reference matched Operations wallet" },
  });
  assert.equal(confirmedBalance.status, 200, JSON.stringify(confirmedBalance.body));
  assert.equal(confirmedBalance.body.order.payments.balance.status, "confirmed");

  const otherSupplierProduction = await request("/orders/ord-match/transition", {
    method: "POST",
    token: secondSupplierToken,
    body: { state: "production" },
  });
  assert.equal(otherSupplierProduction.status, 403);
  assert.equal(otherSupplierProduction.body.error, "forbidden");

  const legacyCod = await request("/orders/ord-legacy-pay/transition", {
    method: "POST",
    token: clientToken,
    body: { state: "payment_authorized", paymentMethod: "COD" },
  });
  assert.equal(legacyCod.status, 400);
  assert.equal(legacyCod.body.error, "payment_method_not_allowed");

  const retiredCredits = await request("/credits/authorize", {
    method: "POST",
    token: clientToken,
    body: { orderId: "ord-legacy-pay" },
  });
  assert.equal(retiredCredits.status, 410);
  assert.equal(retiredCredits.body.error, "payment_route_retired");

  const riderToken = await login("new-rider@example.test", "strong-pass");
  const acceptedDispatch = await request("/dispatch/ord-offer/accept", { method: "POST", token: riderToken, body: {} });
  assert.equal(acceptedDispatch.status, 200, JSON.stringify(acceptedDispatch.body));
  const riderCashPath = await request("/dispatch/ord-offer/proof", {
    method: "POST",
    token: riderToken,
    body: { kind: "cod", note: "must never collect cash" },
  });
  assert.equal(riderCashPath.status, 410);
  assert.equal(riderCashPath.body.error, "dispatch_proof_route_retired");
});

test("milestone release requires POF and the global issue window actually expires", async () => {
  const clientToken = await login("existing@example.test", "secret123");
  const supplierToken = await login("supplier@gridgo.ph");
  const opsToken = await login("ops@gridgo.ph");

  const withoutPof = await request("/orders/ord-match/milestones/printing/release", {
    method: "POST",
    token: opsToken,
    body: { note: "Printing verified" },
  });
  assert.equal(withoutPof.status, 409);
  assert.equal(withoutPof.body.error, "pof_required");

  const production = await request("/orders/ord-match/transition", {
    method: "POST",
    token: supplierToken,
    body: { state: "production" },
  });
  assert.equal(production.status, 200, JSON.stringify(production.body));

  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  const paidOrder = store.orders.find((order) => order.id === "ord-match");
  const printing = paidOrder.payoutMilestones.find((milestone) => milestone.code === "printing");
  printing.pofFileIds.push("file-printing-test");
  printing.status = "pof_attached";
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));

  const released = await request("/orders/ord-match/milestones/printing/release", {
    method: "POST",
    token: opsToken,
    body: { note: "Printing POF reviewed" },
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(
    released.body.order.payoutMilestones.find((milestone) => milestone.code === "printing").status,
    "released",
  );

  const afterRelease = JSON.parse(await fs.readFile(storePath, "utf8"));
  const source = afterRelease.orders.find((order) => order.id === "ord-match");
  const expired = structuredClone(source);
  expired.id = "ord-expired-window";
  expired.state = "issue_window_open";
  expired.issueWindowOpenedAt = "2026-08-01T00:00:00.000Z";
  expired.issueWindowExpiresAt = "2026-08-02T00:00:00.000Z";
  expired.payoutHold = false;
  expired.timeline = [];
  for (const milestone of expired.payoutMilestones) {
    milestone.pofFileIds = milestone.pofFileIds.length ? milestone.pofFileIds : ["file-delivered-test"];
    if (milestone.code !== "retention") {
      milestone.status = "released";
      milestone.releasedAt = "2026-08-01T00:00:00.000Z";
      milestone.releasedBy = "user_ops";
    } else {
      milestone.status = "pof_attached";
      milestone.releasedAt = null;
      milestone.releasedBy = null;
    }
  }
  afterRelease.orders.push(expired);
  await fs.writeFile(storePath, JSON.stringify(afterRelease, null, 2));

  const expiredRead = await request("/orders/ord-expired-window", { token: clientToken });
  assert.equal(expiredRead.status, 200, JSON.stringify(expiredRead.body));
  assert.equal(expiredRead.body.order.state, "completed");
  assert.equal(
    expiredRead.body.order.payoutMilestones.find((milestone) => milestone.code === "retention").status,
    "released",
  );

  const lateIssue = await request("/orders/ord-expired-window/issues", {
    method: "POST",
    token: clientToken,
    body: { description: "Submitted after the deadline" },
  });
  assert.equal(lateIssue.status, 409);
  assert.equal(lateIssue.body.error, "issue_window_closed");
});

test("rider pickup checklist blocks transport, records evidence escalation, and gates delivery", async () => {
  const riderToken = await login("new-rider@example.test", "strong-pass");
  const opsToken = await login("ops@gridgo.ph");
  const checks = [
    "quantity_match",
    "specification_match",
    "visible_defects",
    "packaging_integrity",
    "documentation",
    "supplier_sign_off",
  ];

  const incomplete = await request("/dispatch/ord-offer/pickup-checklist", {
    method: "POST",
    token: riderToken,
    body: { checks: checks.slice(0, 5).map((code) => ({ code, passed: true })) },
  });
  assert.equal(incomplete.status, 400);
  assert.equal(incomplete.body.error, "invalid_pickup_checklist");

  const failedChecks = checks.map((code) => ({ code, passed: code !== "visible_defects" }));
  const noEvidence = await request("/dispatch/ord-offer/pickup-checklist", {
    method: "POST",
    token: riderToken,
    body: { checks: failedChecks, failureNote: "Colour shift on the first batch", evidenceFileIds: [] },
  });
  assert.equal(noEvidence.status, 400);
  assert.equal(noEvidence.body.error, "checklist_evidence_required");

  const beforeFailure = JSON.parse(await fs.readFile(storePath, "utf8"));
  const offer = beforeFailure.orders.find((order) => order.id === "ord-offer");
  offer.deliveryPhotoFileIds.push("file-checklist-failure", "file-delivery-evidence");
  beforeFailure.files.push(
    {
      fileId: "file-checklist-failure",
      ownerId: offer.riderId,
      purpose: "delivery_photo",
      originalFilename: "colour-shift.jpg",
      declaredContentType: "image/jpeg",
      detectedContentType: "image/jpeg",
      size: 100,
      state: "ready",
      objectKey: "delivery_photo/test/colour-shift.jpg",
      references: [{ type: "order", id: offer.id, field: "deliveryPhotoFileIds" }],
      createdAt: "2026-08-10T00:00:00.000Z",
      readyAt: "2026-08-10T00:00:00.000Z",
    },
    {
      fileId: "file-delivery-evidence",
      ownerId: offer.riderId,
      purpose: "delivery_photo",
      originalFilename: "delivery.jpg",
      declaredContentType: "image/jpeg",
      detectedContentType: "image/jpeg",
      size: 100,
      state: "ready",
      objectKey: "delivery_photo/test/delivery.jpg",
      references: [{ type: "order", id: offer.id, field: "deliveryPhotoFileIds" }],
      createdAt: "2026-08-10T00:00:00.000Z",
      readyAt: "2026-08-10T00:00:00.000Z",
    },
  );
  await fs.writeFile(storePath, JSON.stringify(beforeFailure, null, 2));

  const failed = await request("/dispatch/ord-offer/pickup-checklist", {
    method: "POST",
    token: riderToken,
    body: {
      checks: failedChecks,
      failureNote: "Colour shift on the first batch",
      evidenceFileIds: ["file-checklist-failure"],
    },
  });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.order.state, "rider_assigned");
  assert.equal(failed.body.order.pickupChecklist.status, "failed_escalated");
  assert.match(failed.body.escalation.id, /^esc_/);

  const blockedPass = await request("/dispatch/ord-offer/pickup-checklist", {
    method: "POST",
    token: riderToken,
    body: { checks: checks.map((code) => ({ code, passed: true })) },
  });
  assert.equal(blockedPass.status, 409);
  assert.equal(blockedPass.body.error, "pickup_escalation_open");

  const escalationList = await request("/escalations?status=open", { token: opsToken });
  assert.equal(escalationList.status, 200);
  assert.equal(escalationList.body.escalations.some((item) => item.id === failed.body.escalation.id), true);

  const resolved = await request(`/escalations/${failed.body.escalation.id}/resolve`, {
    method: "POST",
    token: opsToken,
    body: { resolution: "Supplier replaced the affected batch; rider must repeat all checks" },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.escalation.status, "resolved");

  const passed = await request("/dispatch/ord-offer/pickup-checklist", {
    method: "POST",
    token: riderToken,
    body: { checks: checks.map((code) => ({ code, passed: true })) },
  });
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  assert.equal(passed.body.order.state, "picked_up");
  assert.equal(passed.body.order.pickupChecklist.status, "passed");
  assert.equal(passed.body.signOffPrompt, "GRIDGO partner! Quality check, done! Salamat po!");

  const otherRiderToken = await login("rider@gridgo.ph");
  const otherRiderTransport = await request("/orders/ord-offer/transition", {
    method: "POST",
    token: otherRiderToken,
    body: { state: "out_for_delivery" },
  });
  assert.equal(otherRiderTransport.status, 403);
  assert.equal(otherRiderTransport.body.error, "forbidden");

  const beforeDelivery = JSON.parse(await fs.readFile(storePath, "utf8"));
  const deliveryOrder = beforeDelivery.orders.find((order) => order.id === "ord-offer");
  const deliveredMilestone = deliveryOrder.payoutMilestones.find((milestone) => milestone.code === "delivered");
  const retentionMilestone = deliveryOrder.payoutMilestones.find((milestone) => milestone.code === "retention");
  deliveredMilestone.pofFileIds = ["file-delivery-pof"];
  deliveredMilestone.status = "pof_attached";
  retentionMilestone.pofFileIds = ["file-delivery-pof"];
  retentionMilestone.status = "pof_attached";
  deliveryOrder.fulfilmentProofFileIds.push("file-delivery-pof");
  beforeDelivery.files.push({
    fileId: "file-delivery-pof",
    ownerId: deliveryOrder.riderId,
    purpose: "fulfilment_proof",
    originalFilename: "delivered-pof.jpg",
    declaredContentType: "image/jpeg",
    detectedContentType: "image/jpeg",
    size: 100,
    state: "ready",
    objectKey: "fulfilment_proof/test/delivered-pof.jpg",
    references: [{ type: "order", id: deliveryOrder.id, field: "fulfilmentProofFileIds", milestoneCode: "delivered" }],
    createdAt: "2026-08-10T00:00:00.000Z",
    readyAt: "2026-08-10T00:00:00.000Z",
  });
  await fs.writeFile(storePath, JSON.stringify(beforeDelivery, null, 2));

  const delivered = await request("/dispatch/ord-offer/delivery", {
    method: "POST",
    token: riderToken,
    body: { evidenceFileId: "file-delivery-evidence", evidenceType: "photo" },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.order.state, "issue_window_open");
  assert.match(delivered.body.order.issueWindowExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(delivered.body.order.deliveryEvidence.fileId, "file-delivery-evidence");

  const earlyClose = await request("/orders/ord-offer/transition", {
    method: "POST",
    token: opsToken,
    body: { state: "completed" },
  });
  assert.equal(earlyClose.status, 409);
  assert.equal(earlyClose.body.error, "transition_not_allowed");

  const retiredProofRoute = await request("/dispatch/ord-offer/proof", {
    method: "POST",
    token: riderToken,
    body: { kind: "delivery", photoName: "bypass.jpg" },
  });
  assert.equal(retiredProofRoute.status, 410);
  assert.equal(retiredProofRoute.body.error, "dispatch_proof_route_retired");
});
