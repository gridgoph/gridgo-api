/**
 * The six shipped pilot identities moved off the reserved `.local` mDNS domain
 * onto @gridgo.ph. The hosted pilot store already held them under the old
 * address, so `load()` renames in place rather than reseeding.
 *
 * What these tests hold the migration to:
 * - all six rename, and an account keeps everything it owned;
 * - a second load leaves the store byte-identical;
 * - an account whose address diverged from the shipped fixture is untouched
 *   (that address belongs to a real person now);
 * - a store where both the retired and replacement address exist makes startup
 *   refuse, naming both accounts, without mutating the file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { DEMO_FIXTURE_EMAILS, DEMO_PASSWORD, RETIRED_FIXTURE_EMAILS } from "../src/demo-fixtures.js";

// The captain's live demo owns these; a test must never bind one.
const FORBIDDEN_PORTS = new Set([3000, 8081, 8082, 8083, 8787, 9000]);

function freeHighPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => {
        if (error) return reject(error);
        if (port > 10_000 && !FORBIDDEN_PORTS.has(port)) return resolve(port);
        resolve(freeHighPort());
      });
    });
  });
}

const PRE_MIGRATION_USERS = [
  { id: "user_client", email: "client@gridgo.local", role: "client", accountType: "business", orgName: "Davao Events Co." },
  { id: "user_client_individual", email: "individual@gridgo.local", role: "client", accountType: "individual" },
  {
    id: "user_supplier",
    email: "supplier@gridgo.local",
    role: "supplier",
    supplierName: "PrintRight Davao",
    shop: { lat: 7.064, lng: 125.6085, label: "PrintRight Davao, C.M. Recto St" },
    verificationStatus: "approved",
    verifiedBy: "user_admin",
    verifiedAt: "2026-08-01T00:00:00.000Z",
  },
  { id: "user_rider", email: "rider@gridgo.local", role: "rider", verificationStatus: "approved", verifiedBy: "user_admin", verifiedAt: "2026-08-01T00:00:00.000Z" },
  { id: "user_ops", email: "ops@gridgo.local", role: "ops_admin" },
  { id: "user_admin", email: "admin@gridgo.local", role: "super_admin" },
];

/**
 * A store shaped like the hosted pilot before the domain move: six identities on
 * the retired addresses, each owning records that reference it by `user.id`.
 */
function preMigrationStore(overrides = {}) {
  const at = "2026-08-05T00:00:00.000Z";
  return {
    version: 2,
    users: PRE_MIGRATION_USERS.map((user) => ({ ...user, password: DEMO_PASSWORD, name: user.id, createdAt: at })),
    // A live session issued before the rename: keyed by token, holding userId.
    sessions: { "tok-pilot-client": { userId: "user_client", createdAt: at } },
    catalog: [],
    orders: [
      {
        id: "ord-pilot",
        clientId: "user_client",
        supplierId: "user_supplier",
        riderId: "user_rider",
        state: "delivered",
        productId: "prod_flyer",
        title: "Pilot flyers",
        quantity: 100,
        zone: "davao_central",
        address: "Bajada, Davao City",
        createdAt: at,
      },
    ],
    credits: { user_client: { balanceMinor: 500_000, history: [] } },
    claims: [{ id: "clm-pilot", supplierId: "user_supplier", orderId: "ord-pilot", state: "held", createdAt: at }],
    issues: [{ id: "iss-pilot", orderId: "ord-pilot", reportedBy: "user_client", createdAt: at }],
    notifications: [
      { id: "ntf-pilot", userId: "user_client", type: "order_delivered", orderId: "ord-pilot", readAt: null, createdAt: at },
    ],
    locationPings: [{ id: "png-pilot", orderId: "ord-pilot", riderId: "user_rider", lat: 7.07, lng: 125.61, at }],
    auditLog: [{ id: "aud-pilot", actorId: "user_admin", action: "user.role_changed", at }],
    ...overrides,
  };
}

function writeStore(store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridgo-email-migration-"));
  const storePath = path.join(dir, "store.json");
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  return { dir, storePath };
}

/** Run the server just long enough for one `load()`, then stop the exact PID. */
async function loadOnce(storePath) {
  const port = await freeHighPort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: { ...process.env, STORE_PATH: storePath, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode != null) return { started: false, output, api: null };
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) return { started: true, output, api: `http://127.0.0.1:${port}` };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`API did not start:\n${output}`);
  } finally {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

/** Start, run `body` against the live API, then stop that exact child. */
async function withServer(storePath, body) {
  const port = await freeHighPort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: { ...process.env, STORE_PATH: storePath, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const api = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode != null) throw new Error(`API exited during startup:\n${output}`);
      try {
        if ((await fetch(`${api}/health`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return await body(api);
  } finally {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

async function login(api, email, password = DEMO_PASSWORD) {
  const response = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.json() };
}

test("every retired pilot address is renamed and the rename is byte-idempotent", async (t) => {
  const { dir, storePath } = writeStore(preMigrationStore());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await loadOnce(storePath)).started, true);
  const afterFirst = fs.readFileSync(storePath, "utf8");
  const migrated = JSON.parse(afterFirst);

  for (const [retired, replacement] of RETIRED_FIXTURE_EMAILS) {
    assert.equal(
      migrated.users.some((user) => user.email === retired),
      false,
      `${retired} survived the migration`,
    );
    assert.equal(
      migrated.users.filter((user) => user.email === replacement).length,
      1,
      `${replacement} should exist exactly once`,
    );
  }

  // Ids are what every other record points at, so they must be identical.
  assert.deepEqual(
    migrated.users.map((user) => user.id).sort(),
    PRE_MIGRATION_USERS.map((user) => user.id).sort(),
  );

  assert.equal((await loadOnce(storePath)).started, true);
  assert.equal(fs.readFileSync(storePath, "utf8"), afterFirst, "second load rewrote the store");
});

test("a renamed account keeps every record it owned", async (t) => {
  const { dir, storePath } = writeStore(preMigrationStore());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await loadOnce(storePath)).started, true);
  const migrated = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const byEmail = (email) => migrated.users.find((user) => user.email === email);

  const client = byEmail("client@gridgo.ph");
  const supplier = byEmail("supplier@gridgo.ph");
  const rider = byEmail("rider@gridgo.ph");
  assert.ok(client && supplier && rider);

  const order = migrated.orders.find(({ id }) => id === "ord-pilot");
  assert.equal(order.clientId, client.id);
  assert.equal(order.supplierId, supplier.id);
  assert.equal(order.riderId, rider.id);

  assert.equal(migrated.sessions["tok-pilot-client"].userId, client.id);
  assert.ok(Object.hasOwn(migrated.credits, client.id));
  assert.equal(migrated.credits[client.id].balanceMinor, 500_000);
  assert.equal(migrated.claims.find(({ id }) => id === "clm-pilot").supplierId, supplier.id);
  assert.equal(migrated.issues.find(({ id }) => id === "iss-pilot").reportedBy, client.id);
  assert.equal(migrated.notifications.find(({ id }) => id === "ntf-pilot").userId, client.id);
  assert.equal(migrated.locationPings.find(({ id }) => id === "png-pilot").riderId, rider.id);
  assert.equal(migrated.auditLog.find(({ id }) => id === "aud-pilot").actorId, byEmail("admin@gridgo.ph").id);

  // The pre-rename session token still authenticates, now as the new address.
  await withServer(storePath, async (api) => {
    const me = await fetch(`${api}/auth/me`, { headers: { authorization: "Bearer tok-pilot-client" } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, "client@gridgo.ph");

    const orders = await fetch(`${api}/orders`, { headers: { authorization: "Bearer tok-pilot-client" } });
    assert.equal(orders.status, 200);
    assert.equal((await orders.json()).orders.some(({ id }) => id === "ord-pilot"), true);
  });
});

test("all six renamed identities sign in at the new domain", async (t) => {
  const { dir, storePath } = writeStore(preMigrationStore());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await withServer(storePath, async (api) => {
    for (const replacement of RETIRED_FIXTURE_EMAILS.values()) {
      const result = await login(api, replacement);
      assert.equal(result.status, 200, `${replacement}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.user.email, replacement);
    }
    for (const retired of RETIRED_FIXTURE_EMAILS.keys()) {
      assert.equal((await login(api, retired)).status, 401, `${retired} still authenticates`);
    }
  });
});

test("an account whose address diverged from the fixture is never renamed", async (t) => {
  // user_ops is a fixture *id*, but this address belongs to a real person: the
  // migration matches the retired address only, and convergence must not
  // rewrite email back to the fixture either.
  const store = preMigrationStore();
  store.users.find((user) => user.id === "user_ops").email = "dina@realcompany.ph";
  const { dir, storePath } = writeStore(store);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await loadOnce(storePath)).started, true);
  const migrated = JSON.parse(fs.readFileSync(storePath, "utf8"));

  assert.equal(migrated.users.find((user) => user.id === "user_ops").email, "dina@realcompany.ph");
  // Convergence may create the missing fixture, but it must not steal the id.
  const opsAtFixtureAddress = migrated.users.filter((user) => user.email === "ops@gridgo.ph");
  assert.equal(opsAtFixtureAddress.length <= 1, true);
  for (const user of opsAtFixtureAddress) assert.notEqual(user.id, "user_ops");

  await withServer(storePath, async (api) => {
    const result = await login(api, "dina@realcompany.ph");
    assert.equal(result.status, 200);
    assert.equal(result.body.user.id, "user_ops");
  });
});

test("startup refuses rather than colliding two accounts onto one login", async (t) => {
  const store = preMigrationStore();
  store.users.push({
    id: "user_admin_new",
    email: "admin@gridgo.ph",
    password: "another-password",
    name: "Someone Else",
    role: "super_admin",
    createdAt: "2026-08-06T00:00:00.000Z",
  });
  const { dir, storePath } = writeStore(store);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const before = fs.readFileSync(storePath, "utf8");
  const attempt = await loadOnce(storePath);

  assert.equal(attempt.started, false, "startup should have refused the collision");
  assert.match(attempt.output, /admin@gridgo\.local/);
  assert.match(attempt.output, /user_admin/);
  assert.match(attempt.output, /user_admin_new/);
  assert.equal(fs.readFileSync(storePath, "utf8"), before, "a refused migration mutated the store");
});

test("the same retired address held twice refuses instead of guessing", async (t) => {
  const store = preMigrationStore();
  store.users.push({
    id: "user_rider_duplicate",
    email: "rider@gridgo.local",
    password: "another-password",
    name: "Duplicate Rider",
    role: "rider",
    createdAt: "2026-08-06T00:00:00.000Z",
  });
  const { dir, storePath } = writeStore(store);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const before = fs.readFileSync(storePath, "utf8");
  const attempt = await loadOnce(storePath);

  assert.equal(attempt.started, false, "startup should have refused the duplicate");
  assert.match(attempt.output, /rider@gridgo\.local is held by 2 accounts/);
  assert.equal(fs.readFileSync(storePath, "utf8"), before, "a refused migration mutated the store");
});

test("a fresh seed needs no rename and every retirement target is a live fixture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridgo-email-migration-seed-"));
  const storePath = path.join(dir, "store.json");
  try {
    const seeded = spawnSync(process.execPath, ["src/seed.js", "--reset"], {
      cwd: path.resolve("."),
      env: { ...process.env, STORE_PATH: storePath },
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const raw = fs.readFileSync(storePath, "utf8");
    assert.equal(raw.includes("gridgo.local"), false, "a fresh seed still carries the retired domain");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Drift guard: a rename may only ever land on an address the repository still
  // ships, and a retired address may never also be a live one.
  for (const [retired, replacement] of RETIRED_FIXTURE_EMAILS) {
    assert.equal(DEMO_FIXTURE_EMAILS.has(replacement), true, `${replacement} is not a shipped fixture`);
    assert.equal(DEMO_FIXTURE_EMAILS.has(retired), false, `${retired} is both retired and shipped`);
  }
  assert.equal(RETIRED_FIXTURE_EMAILS.size, DEMO_FIXTURE_EMAILS.size);
});
