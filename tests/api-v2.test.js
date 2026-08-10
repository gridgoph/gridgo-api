import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { defaultTaxonomy } from "../src/taxonomy.js";

let api;
let child;
let tempDir;
let storePath;

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
    users: [
      { id: "user_ops", email: "ops@gridgo.local", password: "demo", name: "Dina Ops", role: "ops_admin" },
      { id: "user_admin", email: "admin@gridgo.local", password: "demo", name: "Eli Admin", role: "super_admin" },
      { id: "client-existing", email: "existing@example.test", password: "secret123", name: "Existing", role: "client", accountType: "individual" },
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
    ],
    files: [],
    credits: {},
    claims: [],
    issues: [],
    auditLog: [],
    notifications: [],
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

async function login(email, password = "demo") {
  const response = await request("/auth/login", { method: "POST", body: { email, password } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token;
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gridgo-v2-api-test-"));
  storePath = path.join(tempDir, "store.json");
  await fs.writeFile(storePath, JSON.stringify(fixtureStore(), null, 2));
  const port = await freeHighPort();
  api = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: { ...process.env, STORE_PATH: storePath, PORT: String(port), HOST: "127.0.0.1" },
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

  const opsToken = await login("ops@gridgo.local");
  const candidatesBefore = await request("/orders/ord-match/eligible-suppliers", { token: opsToken });
  const pendingCandidate = candidatesBefore.body.candidates.find((item) => item.supplier.id === supplier.body.user.id);
  assert.equal(pendingCandidate.eligible, false);
  assert.deepEqual(pendingCandidate.reasons, ["verification_status:pending"]);

  const offersBefore = await request("/dispatch/offers", { token: rider.body.token });
  assert.equal(offersBefore.status, 403);
  assert.equal(offersBefore.body.error, "rider_not_approved");

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
