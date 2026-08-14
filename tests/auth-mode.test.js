import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { DEMO_PASSWORD } from "../src/demo-fixtures.js";

const FORBIDDEN_PORTS = new Set([3000, 8081, 8082, 8083, 8787, 9000]);
const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const CLERK_ENV = {
  AUTH_MODE: "dual",
  CLERK_SECRET_KEY: "test-only-placeholder",
  CLERK_ISSUER: ISSUER,
  CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
};

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "AUTH_MODE",
    "CLERK_SECRET_KEY",
    "CLERK_ISSUER",
    "CLERK_AUTHORIZED_PARTIES",
    "CLERK_JWT_KEY",
  ]) delete env[key];
  return { ...env, ...overrides };
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

function seed(storePath) {
  const result = spawnSync(process.execPath, ["src/seed.js", "--reset"], {
    cwd: path.resolve("."),
    env: { ...cleanEnvironment(), STORE_PATH: storePath },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function linkedStore(storePath) {
  seed(storePath);
  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  const client = store.users.find((user) => user.email === "client@gridgo.ph");
  assert.ok(client, "seeded client fixture is missing");
  client.clerkUserId = "user_clerk_client";
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
  return { store, client };
}

async function startServer(storePath, overrides = {}) {
  const port = await freeHighPort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...cleanEnvironment(),
      STORE_PATH: storePath,
      HOST: "127.0.0.1",
      PORT: String(port),
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  for (let attempt = 0; attempt < 160; attempt += 1) {
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gridgo-auth-mode-"));
  const storePath = path.join(tempDir, "store.json");
  try {
    return await run(storePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function signToken(overrides = {}) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: "user_clerk_client",
    sid: "sess_gridgo_test",
    azp: AUTHORIZED_PARTY,
    iat: current - 5,
    nbf: current - 5,
    exp: current + 300,
    gridgo_role: "client",
    ...overrides,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

function tamperPayload(token) {
  const [header, rawPayload, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8"));
  payload.sub = "user_tampered_after_signing";
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
}

async function request(api, pathname, { method = "GET", token, body } = {}) {
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

test("legacy is the default and dual mode refuses incomplete Clerk configuration", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);

    const legacy = await startServer(storePath);
    try {
      assert.equal(legacy.started, true, legacy.output());
    } finally {
      await stopServer(legacy);
    }

    for (const [missing, expected] of [
      ["CLERK_SECRET_KEY", /CLERK_SECRET_KEY is required when AUTH_MODE=dual/],
      ["CLERK_ISSUER", /CLERK_ISSUER is required when AUTH_MODE=dual/],
      ["CLERK_AUTHORIZED_PARTIES", /CLERK_AUTHORIZED_PARTIES is required when AUTH_MODE=dual/],
    ]) {
      const env = { ...CLERK_ENV };
      delete env[missing];
      const instance = await startServer(storePath, env);
      try {
        assert.equal(instance.started, false, `${missing} was optional:\n${instance.output()}`);
        assert.match(instance.output(), expected);
      } finally {
        await stopServer(instance);
      }
    }

    const invalid = await startServer(storePath, { AUTH_MODE: "mixed" });
    try {
      assert.equal(invalid.started, false, invalid.output());
      assert.match(invalid.output(), /AUTH_MODE must be legacy, dual, or clerk/);
    } finally {
      await stopServer(invalid);
    }

    const clerkMissingSecret = await startServer(storePath, {
      AUTH_MODE: "clerk",
      CLERK_ISSUER: ISSUER,
      CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
    });
    try {
      assert.equal(clerkMissingSecret.started, false, clerkMissingSecret.output());
      assert.match(clerkMissingSecret.output(), /CLERK_SECRET_KEY is required when AUTH_MODE=clerk/);
    } finally {
      await stopServer(clerkMissingSecret);
    }
  });
});

test("dual accepts both token families while clerk mode accepts only Clerk JWTs", async () => {
  await withTempStore(async (storePath) => {
    await linkedStore(storePath);
    let legacyToken;
    const instance = await startServer(storePath, { ...CLERK_ENV, CLERK_JWT_KEY: JWT_KEY });
    try {
      assert.equal(instance.started, true, instance.output());

      const login = await request(instance.api, "/auth/login", {
        method: "POST",
        body: { email: "client@gridgo.ph", password: DEMO_PASSWORD },
      });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.match(login.body.token, /^tok_/);
      legacyToken = login.body.token;
      assert.equal((await request(instance.api, "/auth/me", { token: login.body.token })).status, 200);
      assert.equal((await request(instance.api, "/orders", { token: login.body.token })).status, 200);

      const clerkToken = signToken();
      const me = await request(instance.api, "/auth/me", { token: clerkToken });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.user.email, "client@gridgo.ph");
      assert.equal(me.body.user.clerkUserId, undefined, "internal identity link leaked through publicUser");
      assert.equal((await request(instance.api, "/orders", { token: clerkToken })).status, 200);
    } finally {
      await stopServer(instance);
    }

    const clerkOnly = await startServer(storePath, {
      ...CLERK_ENV,
      AUTH_MODE: "clerk",
      CLERK_JWT_KEY: JWT_KEY,
    });
    try {
      assert.equal(clerkOnly.started, true, clerkOnly.output());
      assert.equal((await request(clerkOnly.api, "/auth/me", { token: legacyToken })).status, 401);
      assert.equal((await request(clerkOnly.api, "/auth/me", { token: signToken() })).status, 200);
    } finally {
      await stopServer(clerkOnly);
    }
  });
});

test("dual mode never falls a Clerk-shaped JWT back to the legacy session store", async () => {
  await withTempStore(async (storePath) => {
    const { store, client } = await linkedStore(storePath);
    const valid = signToken();
    const tampered = tamperPayload(valid);
    store.sessions[tampered] = { userId: client.id, createdAt: new Date().toISOString() };
    store.sessions["opaque-legacy-token"] = { userId: client.id, createdAt: new Date().toISOString() };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2));

    const instance = await startServer(storePath, { ...CLERK_ENV, CLERK_JWT_KEY: JWT_KEY });
    try {
      assert.equal(instance.started, true, instance.output());
      const invalidTokens = [
        tampered,
        signToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
        signToken({ iss: "https://wrong-instance.clerk.accounts.dev" }),
        signToken({ azp: "https://wrong-party.example" }),
        signToken({ sub: "user_unmapped" }),
        "opaque-legacy-token",
      ];
      for (const token of invalidTokens) {
        const response = await request(instance.api, "/auth/me", { token });
        assert.equal(response.status, 401, JSON.stringify(response.body));
        assert.equal(response.body.error, "unauthorized");
      }
    } finally {
      await stopServer(instance);
    }
  });
});

test("valid Clerk identity with an absent, invalid, or mismatched role claim is forbidden", async () => {
  await withTempStore(async (storePath) => {
    await linkedStore(storePath);
    const instance = await startServer(storePath, { ...CLERK_ENV, CLERK_JWT_KEY: JWT_KEY });
    try {
      assert.equal(instance.started, true, instance.output());
      for (const token of [
        signToken({ gridgo_role: undefined }),
        signToken({ gridgo_role: "owner" }),
        signToken({ gridgo_role: "supplier" }),
      ]) {
        const response = await request(instance.api, "/auth/me", { token });
        assert.equal(response.status, 403, JSON.stringify(response.body));
        assert.equal(response.body.error, "forbidden");
      }
    } finally {
      await stopServer(instance);
    }
  });
});

test("dual mode blocks public supplier and rider signup while legacy keeps fixture signup", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);
    const dual = await startServer(storePath, { ...CLERK_ENV, CLERK_JWT_KEY: JWT_KEY });
    try {
      assert.equal(dual.started, true, dual.output());
      for (const role of ["supplier", "rider"]) {
        const response = await request(dual.api, "/auth/signup", {
          method: "POST",
          body: { role },
        });
        assert.equal(response.status, 403, JSON.stringify(response.body));
        assert.equal(response.body.error, "invitation_required");
      }
    } finally {
      await stopServer(dual);
    }

    const legacy = await startServer(storePath);
    try {
      assert.equal(legacy.started, true, legacy.output());
      const response = await request(legacy.api, "/auth/signup", { method: "POST", body: { role: "supplier" } });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.notEqual(response.body.error, "invitation_required");
    } finally {
      await stopServer(legacy);
    }
  });
});
