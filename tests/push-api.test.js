/**
 * End-to-end push behaviour against a spawned API and a fake Firebase.
 *
 * The fake stands in for both Google endpoints the real client talks to: the
 * OAuth2 token exchange and the FCM v1 send. It verifies the service-account
 * assertion with a throwaway public key, so the RS256 signing path is exercised
 * for real — the captain's service account is never involved, read, or copied.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { DEMO_PASSWORD } from "../src/demo-fixtures.js";
import { defaultTaxonomy } from "../src/taxonomy.js";

const FORBIDDEN_PORTS = new Set([3000, 8081, 8082, 8083, 8787, 9000]);
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const PROJECT_ID = "gridgo-push-test";

let api;
let child;
let firebase;
let tempDir;
let storePath;
let clientToken;
let supplierToken;
let riderToken;

async function freeHighPort() {
  while (true) {
    const port = await new Promise((resolve, reject) => {
      const candidate = net.createServer();
      candidate.once("error", reject);
      candidate.listen(0, "127.0.0.1", () => {
        const selected = candidate.address().port;
        candidate.close((error) => (error ? reject(error) : resolve(selected)));
      });
    });
    if (port > 10_000 && !FORBIDDEN_PORTS.has(port)) return port;
  }
}

function order(id, state, extra = {}) {
  const at = "2026-08-10T00:00:00.000Z";
  return {
    id,
    clientId: "user_client",
    supplierId: "user_supplier",
    riderId: null,
    state,
    productId: "prod_flyer",
    title: `Push test ${id}`,
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
    ...extra,
  };
}

function fixtureStore() {
  return {
    version: 2,
    users: [
      { id: "user_client", email: "client@gridgo.ph", password: DEMO_PASSWORD, name: "Ana Client", role: "client", accountType: "business", orgName: "Ana Prints" },
      {
        id: "user_supplier",
        email: "supplier@gridgo.ph",
        password: DEMO_PASSWORD,
        name: "Ben Supplier",
        role: "supplier",
        supplierName: "PrintRight Davao",
        shop: { lat: 7.064, lng: 125.6085, label: "PrintRight" },
        categoryRanks: [{ categoryCode: "marketing_collateral", rank: 1 }],
        verificationStatus: "approved",
        verificationDocumentFileIds: [],
      },
      { id: "user_rider", email: "rider@gridgo.ph", password: DEMO_PASSWORD, name: "Rio Rider", role: "rider", verificationStatus: "approved" },
    ],
    sessions: {},
    catalog: [{ id: "prod_flyer", name: "Flyers", family: "flyer", basePriceMinor: 25_000, unit: "pack" }],
    taxonomy: defaultTaxonomy(),
    zones: [{ id: "zone-c", code: "davao_central", name: "Central", active: true }],
    supplierServices: [],
    orders: [
      order("ord-fanout", "supplier_assigned"),
      order("ord-prune", "supplier_assigned"),
      order("ord-fcm-down", "supplier_assigned"),
    ],
    files: [],
    credits: {},
    claims: [],
    issues: [],
    auditLog: [],
    notifications: [],
    locationPings: [],
    escalations: [],
    proofs: [],
  };
}

// ---------------------------------------------------------------------------
// Fake Firebase: OAuth2 token exchange + FCM v1 send
// ---------------------------------------------------------------------------

async function startFakeFirebase() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const port = await freeHighPort();
  const origin = `http://127.0.0.1:${port}`;

  const state = {
    mints: 0,
    assertions: [],
    sends: [],
    accessToken: null,
    /** Per-device-token verdict; default is delivered. */
    verdictFor: () => ({ status: 200, body: { name: "projects/test/messages/1" } }),
  };

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => resolve(raw));
    });
  }

  function reply(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
  }

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);

    if (req.url === "/token") {
      const assertion = new URLSearchParams(raw).get("assertion") || "";
      const [header, claims, signature] = assertion.split(".");
      const verified =
        Boolean(signature) &&
        crypto
          .createVerify("RSA-SHA256")
          .update(`${header}.${claims}`)
          .verify(publicKey, Buffer.from(signature, "base64url"));
      if (!verified) return reply(res, 400, { error: "invalid_grant" });
      const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
      if (decoded.scope !== FCM_SCOPE || decoded.aud !== `${origin}/token`) {
        return reply(res, 400, { error: "invalid_scope" });
      }
      state.mints += 1;
      state.assertions.push(decoded);
      state.accessToken = `fake-access-${state.mints}`;
      return reply(res, 200, { access_token: state.accessToken, expires_in: 3600, token_type: "Bearer" });
    }

    if (req.url === `/v1/projects/${PROJECT_ID}/messages:send`) {
      if (req.headers.authorization !== `Bearer ${state.accessToken}`) {
        return reply(res, 401, { error: { status: "UNAUTHENTICATED" } });
      }
      const body = JSON.parse(raw);
      state.sends.push(body.message);
      const verdict = state.verdictFor(body.message.token);
      return reply(res, verdict.status, verdict.body);
    }

    return reply(res, 404, { error: { status: "NOT_FOUND" } });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const serviceAccountPath = path.join(tempDir, "fake-service-account.json");
  await fs.writeFile(
    serviceAccountPath,
    JSON.stringify({
      type: "service_account",
      project_id: PROJECT_ID,
      private_key_id: "fake-key-id",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: `push-test@${PROJECT_ID}.iam.gserviceaccount.com`,
      client_id: "000000000000000000000",
      token_uri: `${origin}/token`,
    }),
    { mode: 0o600 },
  );

  return {
    origin,
    serviceAccountPath,
    state,
    reset() {
      state.sends.length = 0;
      state.verdictFor = () => ({ status: 200, body: { name: "projects/test/messages/1" } });
    },
    async waitForSends(count, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (state.sends.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`expected ${count} FCM sends, saw ${state.sends.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // A short settle window so an unexpected extra send is caught, not missed.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return state.sends;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// API harness
// ---------------------------------------------------------------------------

async function request(pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function login(email) {
  const response = await request("/auth/login", { method: "POST", body: { email, password: DEMO_PASSWORD } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token;
}

async function acceptOrder(orderId, supplierPriceMinor = 250_000) {
  return request(`/orders/${orderId}/transition`, {
    method: "POST",
    token: supplierToken,
    body: { state: "supplier_accepted", supplierPriceMinor, promisedDate: "2026-08-20" },
  });
}

async function startApi(env) {
  const port = await freeHighPort();
  const base = `http://127.0.0.1:${port}`;
  const process_ = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  process_.stdout.on("data", (chunk) => { output += chunk.toString(); });
  process_.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { base, child: process_, output: () => output };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  process_.kill("SIGTERM");
  throw new Error(`API did not start: ${output}`);
}

/** Stop only the PID captured here — never a pattern kill. */
async function stopApi(process_) {
  if (!process_ || process_.exitCode != null) return;
  const exited = new Promise((resolve) => process_.once("exit", resolve));
  process_.kill("SIGTERM");
  await exited;
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gridgo-push-api-test-"));
  storePath = path.join(tempDir, "store.json");
  await fs.writeFile(storePath, JSON.stringify(fixtureStore(), null, 2));
  firebase = await startFakeFirebase();
  const started = await startApi({
    STORE_PATH: storePath,
    GRIDGO_FCM_SERVICE_ACCOUNT_FILE: firebase.serviceAccountPath,
    GRIDGO_FCM_BASE_URL: firebase.origin,
  });
  api = started.base;
  child = started.child;
  clientToken = await login("client@gridgo.ph");
  supplierToken = await login("supplier@gridgo.ph");
  riderToken = await login("rider@gridgo.ph");
});

after(async () => {
  await stopApi(child);
  await firebase?.close();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registration and ownership
// ---------------------------------------------------------------------------

test("registering a device is authenticated, validated, and idempotent", async () => {
  const anonymous = await request("/devices", {
    method: "POST",
    body: { token: "fcm-anonymous", platform: "android" },
  });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, "unauthorized");

  const missingToken = await request("/devices", { method: "POST", token: clientToken, body: { platform: "android" } });
  assert.equal(missingToken.status, 400);
  assert.equal(missingToken.body.error, "device_token_required");

  const badPlatform = await request("/devices", {
    method: "POST",
    token: clientToken,
    body: { token: "fcm-client-1", platform: "symbian" },
  });
  assert.equal(badPlatform.status, 400);
  assert.equal(badPlatform.body.error, "invalid_device_platform");
  assert.deepEqual(badPlatform.body.allowed, ["android", "ios", "web"]);

  const created = await request("/devices", {
    method: "POST",
    token: clientToken,
    body: { token: "fcm-client-1", platform: "android" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
  assert.equal(created.body.device.tokenTail, "client-1");
  assert.equal(JSON.stringify(created.body).includes("fcm-client-1"), false, "response echoed the raw token");

  const again = await request("/devices", {
    method: "POST",
    token: clientToken,
    body: { token: "fcm-client-1", platform: "android" },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.device.id, created.body.device.id);

  const listed = await request("/devices", { token: clientToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.devices.length, 1, "re-registration duplicated the device");
});

test("a device list is caller-scoped and a foreign token cannot be unregistered", async () => {
  await request("/devices", { method: "POST", token: riderToken, body: { token: "fcm-rider-1", platform: "android" } });

  const clientDevices = await request("/devices", { token: clientToken });
  assert.deepEqual(clientDevices.body.devices.map(({ tokenTail }) => tokenTail), ["client-1"]);
  const riderDevices = await request("/devices", { token: riderToken });
  assert.deepEqual(riderDevices.body.devices.map(({ tokenTail }) => tokenTail), ["-rider-1"]);
  for (const device of clientDevices.body.devices) assert.equal(device.userId, "user_client");

  const stealing = await request("/devices/unregister", {
    method: "POST",
    token: clientToken,
    body: { token: "fcm-rider-1" },
  });
  assert.equal(stealing.status, 404);
  assert.equal(stealing.body.error, "device_token_not_found");

  const stillThere = await request("/devices", { token: riderToken });
  assert.equal(stillThere.body.devices.length, 1, "another account unregistered the rider's phone");
});

test("a token re-registered by another account changes hands instead of being shared", async () => {
  const moved = await request("/devices", {
    method: "POST",
    token: riderToken,
    body: { token: "fcm-client-1", platform: "android" },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.reassigned, true);
  assert.equal(moved.body.device.userId, "user_rider");

  const clientDevices = await request("/devices", { token: clientToken });
  assert.equal(clientDevices.body.devices.length, 0, "the previous owner still holds the moved token");
  const riderDevices = await request("/devices", { token: riderToken });
  assert.equal(riderDevices.body.devices.length, 2);

  // Hand it back so later tests start from a clean client inbox.
  const returned = await request("/devices/unregister", {
    method: "POST",
    token: riderToken,
    body: { token: "fcm-client-1" },
  });
  assert.equal(returned.status, 200);
  const rider = await request("/devices/unregister", {
    method: "POST",
    token: riderToken,
    body: { token: "fcm-rider-1" },
  });
  assert.equal(rider.status, 200);
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test("one notification reaches every phone the owner has, and carries no money detail", async () => {
  firebase.reset();
  for (const token of ["fcm-client-phone", "fcm-client-tablet"]) {
    const registered = await request("/devices", {
      method: "POST",
      token: clientToken,
      body: { token, platform: "android" },
    });
    assert.equal(registered.status, 201);
  }

  const accepted = await acceptOrder("ord-fanout", 250_000);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  const sends = await firebase.waitForSends(2);
  assert.equal(sends.length, 2, "one notification produced more or fewer sends than the owner has phones");
  assert.deepEqual(
    sends.map(({ token }) => token).sort(),
    ["fcm-client-phone", "fcm-client-tablet"],
  );

  const [message] = sends;
  assert.equal(message.notification.title, "Supplier assigned and final price ready");
  assert.equal(message.data.type, "supplier_assignment_final_price");
  assert.equal(message.data.orderId, "ord-fanout");
  assert.deepEqual(Object.keys(message.data).sort(), ["at", "notificationId", "orderId", "type"]);

  // The supplier price is 250000, the 10% commission 25000, and the client may
  // see neither on a lock screen.
  const serialized = JSON.stringify(sends);
  for (const forbidden of ["250000", "25000", "commission", "supplierPrice", "Minor"]) {
    assert.equal(serialized.includes(forbidden), false, `push leaked ${forbidden}`);
  }

  // Every push corresponds to exactly one readable in-app notification.
  const inbox = await request("/notifications", { token: clientToken });
  const matching = inbox.body.notifications.filter((item) => item.orderId === "ord-fanout");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].id, message.data.notificationId);

  // The rider owns no device and is not the notification's owner: no send.
  assert.equal(sends.some(({ token }) => token === "fcm-rider-1"), false);

  const health = await request("/health");
  assert.equal(health.body.push.status, "available");
});

test("a token FCM reports unregistered is pruned; the healthy phone is untouched", async () => {
  firebase.reset();
  firebase.state.verdictFor = (token) =>
    token === "fcm-client-tablet"
      ? {
          status: 404,
          body: {
            error: {
              code: 404,
              status: "NOT_FOUND",
              details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
            },
          },
        }
      : { status: 200, body: { name: "projects/test/messages/2" } };

  const accepted = await acceptOrder("ord-prune", 300_000);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  await firebase.waitForSends(2);

  const deadline = Date.now() + 3_000;
  let devices;
  while (Date.now() < deadline) {
    devices = (await request("/devices", { token: clientToken })).body.devices;
    if (devices.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(devices.map(({ tokenTail }) => tokenTail), ["nt-phone"], "the dead token was not pruned");
});

test("an FCM outage cannot break the action that created the notification", async () => {
  firebase.reset();
  firebase.state.verdictFor = () => ({ status: 500, body: { error: { status: "INTERNAL" } } });

  const accepted = await acceptOrder("ord-fcm-down", 400_000);
  assert.equal(accepted.status, 200, "the transition failed because a push failed");
  assert.equal(accepted.body.order.state, "awaiting_downpayment");
  await firebase.waitForSends(1);

  // The state change is durable, the in-app notification exists, and the phone
  // that merely could not be reached is still registered.
  const reloaded = await request("/orders/ord-fcm-down", { token: supplierToken });
  assert.equal(reloaded.body.order.state, "awaiting_downpayment");
  const inbox = await request("/notifications", { token: clientToken });
  assert.equal(inbox.body.notifications.some((item) => item.orderId === "ord-fcm-down"), true);
  const devices = await request("/devices", { token: clientToken });
  assert.equal(devices.body.devices.length, 1, "a transient FCM failure pruned a live token");
});

test("signing out unregisters the phone in the same call", async () => {
  firebase.reset();
  const sessionToken = await login("client@gridgo.ph");
  await request("/devices", {
    method: "POST",
    token: sessionToken,
    body: { token: "fcm-signout", platform: "ios" },
  });

  const loggedOut = await request("/auth/logout", {
    method: "POST",
    token: sessionToken,
    body: { deviceToken: "fcm-signout" },
  });
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOut.body.deviceUnregistered, true);

  const remaining = await request("/devices", { token: clientToken });
  assert.equal(remaining.body.devices.some(({ tokenTail }) => tokenTail === "-signout"), false);
  assert.equal((await request("/auth/me", { token: sessionToken })).status, 401);
});

test("a sign-out that names another account's phone leaves it registered", async () => {
  await request("/devices", { method: "POST", token: riderToken, body: { token: "fcm-rider-keep", platform: "android" } });
  const sessionToken = await login("client@gridgo.ph");

  const loggedOut = await request("/auth/logout", {
    method: "POST",
    token: sessionToken,
    body: { deviceToken: "fcm-rider-keep" },
  });
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOut.body.deviceUnregistered, false);

  const riderDevices = await request("/devices", { token: riderToken });
  assert.equal(riderDevices.body.devices.some(({ tokenTail }) => tokenTail === "der-keep"), true);
});

test("health names the configured Firebase project and its last verdict", async () => {
  const health = await request("/health");
  assert.equal(health.body.push.provider, "fcm");
  assert.equal(health.body.push.projectId, PROJECT_ID);
  // The preceding test simulated an FCM outage, so the verdict here is
  // `unavailable`; what matters is that a configured deployment never reports
  // `disabled` and always carries a checked-at stamp an operator can read.
  assert.equal(["available", "unavailable"].includes(health.body.push.status), true, health.body.push.status);
  assert.equal(typeof health.body.push.checkedAt, "string");
});

test("one access token serves every send in the run", async () => {
  // Google rate-limits a backend that mints a token per message; the cache is
  // the only thing preventing that once the pilot has real traffic.
  assert.equal(firebase.state.mints, 1, `minted ${firebase.state.mints} access tokens`);
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("a store written before push backfills once and then byte-identically", async () => {
  const legacyPath = path.join(tempDir, "legacy-store.json");
  const legacy = fixtureStore();
  delete legacy.deviceTokens;
  await fs.writeFile(legacyPath, JSON.stringify(legacy, null, 2));

  const first = await startApi({ STORE_PATH: legacyPath });
  try {
    const health = await fetch(`${first.base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).push, {
      provider: "fcm",
      projectId: null,
      status: "disabled",
      detail: null,
      checkedAt: null,
    });
  } finally {
    await stopApi(first.child);
  }
  const afterFirst = await fs.readFile(legacyPath, "utf8");
  assert.deepEqual(JSON.parse(afterFirst).deviceTokens, []);

  const second = await startApi({ STORE_PATH: legacyPath });
  try {
    assert.equal((await fetch(`${second.base}/health`)).status, 200);
  } finally {
    await stopApi(second.child);
  }
  assert.equal(await fs.readFile(legacyPath, "utf8"), afterFirst, "the second load changed the store");
});
