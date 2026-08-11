import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { DEMO_PASSWORD } from "../src/demo-fixtures.js";

const FORBIDDEN_PORTS = new Set([3000, 8081, 8082, 8083, 8787, 9000]);
const ALLOWED_ORIGIN = "https://gridgo-dash.talasora.com";
const PASSWORD_ENV = {
  GRIDGO_CLIENT_PASSWORD: "client-hosted-secret",
  GRIDGO_INDIVIDUAL_PASSWORD: "individual-hosted-secret",
  GRIDGO_SUPPLIER_PASSWORD: "supplier-hosted-secret",
  GRIDGO_RIDER_PASSWORD: "rider-hosted-secret",
  GRIDGO_OPS_PASSWORD: "operations-hosted-secret",
  GRIDGO_ADMIN_PASSWORD: "administrator-hosted-secret",
};

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(PASSWORD_ENV)) delete env[key];
  delete env.CORS_ALLOWED_ORIGINS;
  delete env.MINIO_ENDPOINT;
  delete env.MINIO_PUBLIC_URL;
  delete env.MINIO_ACCESS_KEY;
  delete env.MINIO_SECRET_KEY;
  delete env.NODE_ENV;
  return { ...env, ...overrides };
}

function productionEnvironment(overrides = {}) {
  return cleanEnvironment({
    NODE_ENV: "production",
    ...PASSWORD_ENV,
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    MINIO_ENDPOINT: "http://127.0.0.1:49199",
    MINIO_PUBLIC_URL: "https://gridgo-api.talasora.com",
    MINIO_ACCESS_KEY: "gridgo-hosted-api",
    MINIO_SECRET_KEY: "gridgo-hosted-storage-secret",
    ...overrides,
  });
}

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

function seed(storePath, env) {
  return spawnSync(process.execPath, ["src/seed.js", "--reset"], {
    cwd: path.resolve("."),
    env: { ...env, STORE_PATH: storePath },
    encoding: "utf8",
  });
}

async function startServer(storePath, env) {
  const port = await freeHighPort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: { ...env, STORE_PATH: storePath, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) return { api, child, output: () => output, started: false };
    try {
      const response = await fetch(`${api}/health`);
      if (response.ok) return { api, child, output: () => output, started: true };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (child.exitCode == null) child.kill("SIGTERM");
  await new Promise((resolve) => child.exitCode == null ? child.once("exit", resolve) : resolve());
  throw new Error(`API neither started nor exited:\n${output}`);
}

async function stopServer(instance) {
  if (instance.child.exitCode == null) {
    instance.child.kill("SIGTERM");
    await new Promise((resolve) => instance.child.once("exit", resolve));
  }
}

async function withTempStore(run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gridgo-hosted-pilot-"));
  const storePath = path.join(tempDir, "store.json");
  try {
    return await run(storePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("production refuses startup when configured account credentials are missing", async () => {
  await withTempStore(async (storePath) => {
    const seeded = seed(storePath, cleanEnvironment());
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);

    const instance = await startServer(storePath, cleanEnvironment({
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      MINIO_ENDPOINT: "http://127.0.0.1:49199",
      MINIO_PUBLIC_URL: "https://gridgo-api.talasora.com",
      MINIO_ACCESS_KEY: "gridgo-hosted-api",
      MINIO_SECRET_KEY: "gridgo-hosted-storage-secret",
    }));
    try {
      assert.equal(instance.started, false, "production server accepted missing account credentials");
      assert.match(instance.output(), /GRIDGO_CLIENT_PASSWORD/);
      assert.match(instance.output(), /Set GRIDGO_CLIENT_PASSWORD/);
    } finally {
      await stopServer(instance);
    }
  });
});

test("production refuses a password reused across fixed pilot identities", async () => {
  await withTempStore(async (storePath) => {
    const reusedPassword = "one-reused-hosted-secret";
    const reusedEnvironment = Object.fromEntries(
      Object.keys(PASSWORD_ENV).map((key) => [key, reusedPassword]),
    );
    const result = seed(storePath, productionEnvironment(reusedEnvironment));
    assert.notEqual(result.status, 0, "production seed accepted one password for every privileged identity");
    assert.match(result.stderr, /GRIDGO_INDIVIDUAL_PASSWORD/);
    assert.match(result.stderr, /GRIDGO_CLIENT_PASSWORD/);
    assert.match(result.stderr, /unique password/);
  });
});

test("production refuses a non-loopback internal MinIO endpoint", async () => {
  await withTempStore(async (storePath) => {
    const seeded = seed(storePath, productionEnvironment());
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);

    const instance = await startServer(
      storePath,
      productionEnvironment({ MINIO_ENDPOINT: "https://storage.example" }),
    );
    try {
      assert.equal(instance.started, false, "production server accepted a public internal MinIO endpoint");
      assert.match(instance.output(), /MINIO_ENDPOINT must use host loopback/);
      assert.match(instance.output(), /Set MINIO_ENDPOINT to a loopback origin/);
    } finally {
      await stopServer(instance);
    }
  });
});

test("production seed contains reference data and configured accounts but no operational fixtures", async () => {
  await withTempStore(async (storePath) => {
    const result = seed(storePath, productionEnvironment());
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const store = JSON.parse(await fs.readFile(storePath, "utf8"));

    assert.ok(store.catalog.length > 0, "the client request catalog is required reference data");
    assert.ok(store.taxonomy.categories.length > 0, "the platform taxonomy is required reference data");
    assert.ok(store.settings.deliveryFeeBands.length > 0, "operational settings are required reference data");
    assert.ok(store.zones.length > 0, "Davao zones are required reference data");
    assert.equal(store.users.length, 6);
    for (const user of store.users) {
      assert.equal(user.password, PASSWORD_ENV[
        user.email === "client@gridgo.local" ? "GRIDGO_CLIENT_PASSWORD"
          : user.email === "individual@gridgo.local" ? "GRIDGO_INDIVIDUAL_PASSWORD"
            : user.email === "supplier@gridgo.local" ? "GRIDGO_SUPPLIER_PASSWORD"
              : user.email === "rider@gridgo.local" ? "GRIDGO_RIDER_PASSWORD"
                : user.email === "ops@gridgo.local" ? "GRIDGO_OPS_PASSWORD"
                  : "GRIDGO_ADMIN_PASSWORD"
      ]);
      assert.notEqual(user.password, DEMO_PASSWORD);
    }

    for (const collection of [
      "supplierServices", "orders", "files", "claims", "issues", "auditLog",
      "notifications", "locationPings", "escalations", "proofs",
    ]) {
      assert.deepEqual(store[collection], [], `${collection} must start empty`);
    }
    assert.deepEqual(store.sessions, {});
    assert.deepEqual(store.credits, {});
  });
});

test("production refuses a local rich store instead of exposing demo transactions", async () => {
  await withTempStore(async (storePath) => {
    const seeded = seed(storePath, cleanEnvironment());
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const beforeStartup = await fs.readFile(storePath, "utf8");

    const instance = await startServer(storePath, productionEnvironment());
    try {
      assert.equal(instance.started, false, "production server accepted a store containing known demo orders");
      assert.match(instance.output(), /contains local demo operational data/);
      assert.match(instance.output(), /fresh production store/);
      assert.equal(await fs.readFile(storePath, "utf8"), beforeStartup, "refusal mutated the demo store");
    } finally {
      await stopServer(instance);
    }
  });
});

test("local development keeps the rich scenario seed and development credential", async () => {
  await withTempStore(async (storePath) => {
    const result = seed(storePath, cleanEnvironment());
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const store = JSON.parse(await fs.readFile(storePath, "utf8"));

    assert.deepEqual(
      store.orders.map(({ id }) => id),
      ["ord_demo_1", "ord_demo_2", "ord_demo_issue", "ord_demo_claim"],
    );
    assert.ok(store.claims.length > 0);
    assert.ok(store.issues.length > 0);
    assert.ok(store.notifications.length > 0);
    assert.ok(store.users.every(({ password }) => password === DEMO_PASSWORD));
  });
});

test("origin allowlist accepts the configured dashboard and rejects another origin", async () => {
  await withTempStore(async (storePath) => {
    const seeded = seed(storePath, cleanEnvironment());
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const instance = await startServer(storePath, cleanEnvironment({ CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN }));
    assert.equal(instance.started, true, instance.output());
    try {
      const allowed = await fetch(`${instance.api}/health`, { headers: { Origin: ALLOWED_ORIGIN } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
      assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
      assert.match(allowed.headers.get("vary") || "", /Origin/i);

      const preflight = await fetch(`${instance.api}/auth/login`, {
        method: "OPTIONS",
        headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);

      const rejected = await fetch(`${instance.api}/health`, {
        headers: { Origin: "https://attacker.example" },
      });
      assert.equal(rejected.status, 403);
      assert.deepEqual(await rejected.json(), {
        error: "origin_not_allowed",
        message: "Origin https://attacker.example is not allowed. Add its exact origin to CORS_ALLOWED_ORIGINS and restart the API.",
      });
      assert.equal(rejected.headers.get("access-control-allow-origin"), null);
    } finally {
      await stopServer(instance);
    }
  });
});

test("configured production server starts empty and a second load is byte-idempotent", async () => {
  await withTempStore(async (storePath) => {
    const env = productionEnvironment();
    const seeded = seed(storePath, env);
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);

    const first = await startServer(storePath, env);
    assert.equal(first.started, true, first.output());
    try {
      const login = await fetch(`${first.api}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ email: "admin@gridgo.local", password: PASSWORD_ENV.GRIDGO_ADMIN_PASSWORD }),
      });
      assert.equal(login.status, 200);
      const { token } = await login.json();
      const orders = await fetch(`${first.api}/orders`, { headers: { Authorization: `Bearer ${token}` } });
      assert.deepEqual((await orders.json()).orders, []);
      const notifications = await fetch(`${first.api}/notifications`, { headers: { Authorization: `Bearer ${token}` } });
      assert.deepEqual((await notifications.json()).notifications, []);
    } finally {
      await stopServer(first);
    }

    const afterFirstLoad = await fs.readFile(storePath, "utf8");
    const second = await startServer(storePath, env);
    assert.equal(second.started, true, second.output());
    await stopServer(second);
    assert.equal(await fs.readFile(storePath, "utf8"), afterFirstLoad, "second production load changed the store");
  });
});
