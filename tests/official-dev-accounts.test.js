/**
 * Official Development Client / Supplier / Rider people are new Clerk
 * fixture rows. Hosted seed ids (user_client, …) must keep their
 * @gridgo.ph addresses so Ana Client's orders are never attached to Fely.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  DEMO_PASSWORD,
  DEMO_USERS,
  HOSTED_LEGACY_USERS,
  OFFICIAL_DEV_USERS,
} from "../src/demo-fixtures.js";
import { configuredDemoUsers } from "../src/runtime-config.js";

const FORBIDDEN_PORTS = new Set([3000, 8081, 8082, 8083, 8787, 9000]);

const PRODUCTION_PASSWORDS = {
  GRIDGO_CLIENT_PASSWORD: "client-hosted-secret",
  GRIDGO_INDIVIDUAL_PASSWORD: "individual-hosted-secret",
  GRIDGO_SUPPLIER_PASSWORD: "supplier-hosted-secret",
  GRIDGO_RIDER_PASSWORD: "rider-hosted-secret",
  GRIDGO_OPS_PASSWORD: "operations-hosted-secret",
  GRIDGO_ADMIN_PASSWORD: "administrator-hosted-secret",
};

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

function writeStore(store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridgo-official-dev-"));
  const storePath = path.join(dir, "store.json");
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  return { dir, storePath };
}

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
      if (child.exitCode != null) return { started: false, output };
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) return { started: true, output };
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

function sixOnlyStore() {
  return {
    version: 2,
    users: HOSTED_LEGACY_USERS.map((user) => ({ ...user })),
    sessions: {},
    catalog: [],
    taxonomy: { categories: [], subcategories: [], categoryAliases: {}, materials: [], finishes: [] },
    settings: { deliveryFeeBands: [{ maxDistanceMeters: null, feeMinor: 15000 }] },
    zones: [],
    supplierServices: [{ id: "svc_keep", supplierId: "user_supplier" }],
    orders: [],
    files: [],
    credits: {},
    claims: [],
    issues: [],
    auditLog: [],
    notifications: [],
    locationPings: [],
    escalations: [],
    proofs: [],
    deviceTokens: [],
  };
}

test("local configuredDemoUsers include the Clerk trio without renaming hosted ids", () => {
  const users = configuredDemoUsers({ NODE_ENV: "development" });
  for (const fixture of OFFICIAL_DEV_USERS) {
    const user = users.find((candidate) => candidate.id === fixture.id);
    assert.equal(user?.email, fixture.email);
    assert.equal(user?.clerkUserId, fixture.clerkUserId);
    assert.equal(user?.password, DEMO_PASSWORD);
  }
  assert.equal(users.find((user) => user.id === "user_client")?.email, "client@gridgo.ph");
  assert.equal(users.find((user) => user.id === "user_supplier")?.email, "supplier@gridgo.ph");
  assert.equal(users.find((user) => user.id === "user_rider")?.email, "rider@gridgo.ph");
});

test("production configuredDemoUsers stay on the six hosted identities", () => {
  const users = configuredDemoUsers({ NODE_ENV: "production", ...PRODUCTION_PASSWORDS });
  assert.deepEqual(
    users.map((user) => user.email).sort(),
    HOSTED_LEGACY_USERS.map((user) => user.email).sort(),
  );
  assert.equal(users.some((user) => OFFICIAL_DEV_USERS.some((fixture) => fixture.email === user.email)), false);
  assert.equal(users.some((user) => user.clerkUserId), false);
});

test("local seed creates official rows and advertises them, not client@ / supplier@ / rider@", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridgo-official-seed-"));
  const storePath = path.join(dir, "store.json");
  try {
    const seeded = spawnSync(process.execPath, ["src/seed.js", "--reset"], {
      cwd: path.resolve("."),
      env: { ...process.env, STORE_PATH: storePath },
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    for (const user of DEMO_USERS) {
      assert.match(seeded.stdout, new RegExp(`${user.email}\\s+${user.role}`));
    }
    assert.equal(seeded.stdout.includes("client@gridgo.ph"), false);
    assert.equal(seeded.stdout.includes("supplier@gridgo.ph"), false);
    assert.equal(seeded.stdout.includes("rider@gridgo.ph"), false);
    assert.equal(seeded.stdout.includes("individual@gridgo.ph"), false);

    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    for (const fixture of OFFICIAL_DEV_USERS) {
      const user = store.users.find((candidate) => candidate.id === fixture.id);
      assert.equal(user?.email, fixture.email);
      assert.equal(user?.clerkUserId, fixture.clerkUserId);
      assert.equal(user?.name, fixture.name);
      assert.equal(user?.role, fixture.role);
    }
    const supplier = store.users.find((user) => user.id === "user_test_supplier");
    assert.equal(supplier.verificationStatus, "approved");
    assert.deepEqual(supplier.shop, OFFICIAL_DEV_USERS.find((user) => user.id === "user_test_supplier").shop);
    assert.equal(store.users.find((user) => user.id === "user_test_rider")?.verificationStatus, "approved");
    assert.equal(store.users.find((user) => user.id === "user_client")?.email, "client@gridgo.ph");
    assert.equal(store.orders[0].clientId, "user_client");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("convergence creates the official trio without stealing hosted identities", async (t) => {
  const { dir, storePath } = writeStore(sixOnlyStore());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await loadOnce(storePath)).started, true);
  const afterFirst = fs.readFileSync(storePath, "utf8");
  const store = JSON.parse(afterFirst);

  for (const fixture of OFFICIAL_DEV_USERS) {
    const matches = store.users.filter((user) => user.email === fixture.email);
    assert.equal(matches.length, 1, fixture.email);
    assert.equal(matches[0].id, fixture.id);
    assert.equal(matches[0].clerkUserId, fixture.clerkUserId);
  }
  assert.equal(store.users.find((user) => user.id === "user_client")?.email, "client@gridgo.ph");

  assert.equal((await loadOnce(storePath)).started, true);
  assert.equal(fs.readFileSync(storePath, "utf8"), afterFirst, "second load rewrote the store");
});

test("convergence does not overwrite a different user who already holds an official email", async (t) => {
  const store = sixOnlyStore();
  store.users.push({
    id: "user_someone_else",
    email: "felyciaaa0220@gmail.com",
    password: "already-here",
    name: "Existing Occupant",
    role: "client",
    accountType: "business",
  });
  const { dir, storePath } = writeStore(store);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal((await loadOnce(storePath)).started, true);
  const loaded = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const occupant = loaded.users.find((user) => user.email === "felyciaaa0220@gmail.com");
  assert.equal(occupant.id, "user_someone_else");
  assert.equal(occupant.name, "Existing Occupant");
  assert.equal(occupant.password, "already-here");
  assert.equal(occupant.clerkUserId, undefined);
  assert.equal(loaded.users.some((user) => user.id === "user_fely_client"), false);
  assert.equal(loaded.users.find((user) => user.id === "user_client")?.email, "client@gridgo.ph");
});
