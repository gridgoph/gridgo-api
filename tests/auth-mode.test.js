import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
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

async function waitForStorageStatus(api, expected) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await fetch(`${api}/health`);
    const health = await response.json();
    if (health.storage?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`storage did not reach ${expected}`);
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

test("default legacy signup token survives the upload store recheck", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);
    const unavailableStoragePort = await freeHighPort();
    const instance = await startServer(storePath, {
      MINIO_ENDPOINT: `http://127.0.0.1:${unavailableStoragePort}`,
      MINIO_PUBLIC_URL: `http://127.0.0.1:${unavailableStoragePort}`,
    });
    try {
      assert.equal(instance.started, true, instance.output());
      await waitForStorageStatus(instance.api, "unavailable");

      const signup = await request(instance.api, "/auth/signup", {
        method: "POST",
        body: {
          role: "client",
          email: "legacy-upload@example.com",
          password: "legacy-upload-password",
          name: "Legacy Upload",
          phone: "+63 917 000 0000",
          accountType: "individual",
        },
      });
      assert.equal(signup.status, 201, JSON.stringify(signup.body));
      assert.match(signup.body.token, /^tok_/);

      const form = new FormData();
      form.append("purpose", "artwork");
      form.append("file", new Blob([Buffer.from("%PDF-1.4\n%%EOF\n")], { type: "application/pdf" }), "smoke.pdf");
      const upload = await fetch(`${instance.api}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signup.body.token}` },
        body: form,
      });
      const uploadBody = await upload.json();

      assert.equal(upload.status, 503, JSON.stringify(uploadBody));
      assert.equal(uploadBody.error, "minio_unavailable");
    } finally {
      await stopServer(instance);
    }
  });
});

function clerkUserPayload({
  id,
  email,
  firstName = "Google",
  lastName = "User",
  phone = null,
  publicMetadata = {},
} = {}) {
  const emailId = "idn_email_1";
  const phoneId = phone ? "idn_phone_1" : null;
  return {
    object: "user",
    id,
    username: null,
    first_name: firstName,
    last_name: lastName,
    image_url: "https://img.clerk.com/test",
    has_image: false,
    primary_email_address_id: emailId,
    primary_phone_number_id: phoneId,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: [{
      object: "email_address",
      id: emailId,
      email_address: email,
      verification: null,
      linked_to: [],
    }],
    phone_numbers: phone
      ? [{
        object: "phone_number",
        id: phoneId,
        phone_number: phone,
        reserved_for_second_factor: false,
        default_second_factor: false,
        verification: null,
        linked_to: [],
      }]
      : [],
    web3_wallets: [],
    organization_memberships: null,
    external_accounts: [],
    enterprise_accounts: [],
    password_last_updated_at: null,
    public_metadata: publicMetadata,
    private_metadata: {},
    unsafe_metadata: {},
    external_id: null,
    last_sign_in_at: Date.now(),
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    last_active_at: Date.now(),
    create_organization_enabled: false,
    create_organizations_limit: null,
    delete_self_enabled: true,
    legal_accepted_at: null,
    locale: "en-US",
  };
}

async function startClerkBackend(usersById) {
  const patches = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const sendJson = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const userMatch = url.pathname.match(/^\/v1\/users\/([^/]+)$/);
    const metaMatch = url.pathname.match(/^\/v1\/users\/([^/]+)\/metadata$/);
    if (req.method === "GET" && userMatch) {
      const user = usersById[decodeURIComponent(userMatch[1])];
      if (!user) return sendJson(404, { errors: [{ code: "resource_not_found", message: "not found" }] });
      return sendJson(200, user);
    }
    if (req.method === "PATCH" && metaMatch) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const userId = decodeURIComponent(metaMatch[1]);
        patches.push({ userId, body });
        const user = usersById[userId];
        if (user) {
          user.public_metadata = { ...(user.public_metadata || {}), ...(body.public_metadata || {}) };
          return sendJson(200, user);
        }
        sendJson(200, clerkUserPayload({ id: userId, email: "patched@example.com" }));
      });
      return;
    }
    sendJson(404, { errors: [{ code: "not_found", message: url.pathname }] });
  });

  const port = await freeHighPort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    patches,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("unmapped Clerk JWT stays unauthorized on /auth/me until activate", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);
    const clerkId = "user_google_new";
    const backend = await startClerkBackend({
      [clerkId]: clerkUserPayload({ id: clerkId, email: "new.google@example.com" }),
    });
    const instance = await startServer(storePath, {
      ...CLERK_ENV,
      CLERK_JWT_KEY: JWT_KEY,
      CLERK_API_URL: backend.url,
    });
    try {
      assert.equal(instance.started, true, instance.output());
      const token = signToken({ sub: clerkId, gridgo_role: undefined });
      const me = await request(instance.api, "/auth/me", { token });
      assert.equal(me.status, 401, JSON.stringify(me.body));
      assert.equal(me.body.error, "unauthorized");
    } finally {
      await stopServer(instance);
      await backend.close();
    }
  });
});

test("activate creates a client from a first-time Google Clerk user", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);
    const before = JSON.parse(await fs.readFile(storePath, "utf8"));
    const userCountBefore = before.users.length;
    const clerkId = "user_google_new";
    const backend = await startClerkBackend({
      [clerkId]: clerkUserPayload({
        id: clerkId,
        email: "new.google@example.com",
        firstName: "Nico",
        lastName: "Google",
        phone: "+639171111111",
      }),
    });
    const instance = await startServer(storePath, {
      ...CLERK_ENV,
      CLERK_JWT_KEY: JWT_KEY,
      CLERK_API_URL: backend.url,
    });
    try {
      assert.equal(instance.started, true, instance.output());
      const firstToken = signToken({ sub: clerkId, gridgo_role: undefined });
      assert.equal((await request(instance.api, "/auth/me", { token: firstToken })).status, 401);

      const activated = await request(instance.api, "/auth/clerk/activate", {
        method: "POST",
        token: firstToken,
      });
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      assert.equal(activated.body.user.email, "new.google@example.com");
      assert.equal(activated.body.user.role, "client");
      assert.equal(activated.body.user.name, "Nico Google");
      assert.equal(activated.body.user.phone, "+639171111111");
      assert.equal(activated.body.user.accountType, "individual");
      assert.equal(activated.body.user.clerkUserId, undefined);
      assert.equal(activated.body.user.password, undefined);

      const store = JSON.parse(await fs.readFile(storePath, "utf8"));
      assert.equal(store.users.length, userCountBefore + 1);
      const created = store.users.find((user) => user.clerkUserId === clerkId);
      assert.ok(created, "activate did not persist clerkUserId");
      assert.equal(created.role, "client");
      assert.equal(created.email, "new.google@example.com");
      assert.notEqual(created.accountType, "business");
      assert.notEqual(created.accountType, "organization");
      assert.match(created.password, /^clerk_/);

      assert.equal(backend.patches.length, 1);
      assert.equal(backend.patches[0].userId, clerkId);
      assert.equal(backend.patches[0].body.public_metadata.gridgoRole, "client");

      const fresh = signToken({ sub: clerkId, gridgo_role: "client" });
      const me = await request(instance.api, "/auth/me", { token: fresh });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.user.email, "new.google@example.com");
      assert.equal(me.body.user.id, created.id);
      assert.equal(me.body.user.clerkUserId, undefined);
    } finally {
      await stopServer(instance);
      await backend.close();
    }
  });
});

test("activate links a Google identity to the existing client with the same email", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);
    const clerkId = "user_google_ana";
    const backend = await startClerkBackend({
      [clerkId]: clerkUserPayload({
        id: clerkId,
        email: "client@gridgo.ph",
        firstName: "Ana",
        lastName: "Client",
      }),
    });
    const instance = await startServer(storePath, {
      ...CLERK_ENV,
      CLERK_JWT_KEY: JWT_KEY,
      CLERK_API_URL: backend.url,
    });
    try {
      assert.equal(instance.started, true, instance.output());
      const firstToken = signToken({ sub: clerkId, gridgo_role: undefined });
      const activated = await request(instance.api, "/auth/clerk/activate", {
        method: "POST",
        token: firstToken,
      });
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      assert.equal(activated.body.user.id, "user_client");
      assert.equal(activated.body.user.email, "client@gridgo.ph");
      assert.equal(activated.body.user.accountType, "business");
      assert.equal(activated.body.user.clerkUserId, undefined);

      const store = JSON.parse(await fs.readFile(storePath, "utf8"));
      const client = store.users.find((user) => user.id === "user_client");
      assert.equal(client.clerkUserId, clerkId);
      assert.equal(store.users.filter((user) => user.email === "client@gridgo.ph").length, 1);

      const me = await request(instance.api, "/auth/me", {
        token: signToken({ sub: clerkId, gridgo_role: "client" }),
      });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.user.id, "user_client");
    } finally {
      await stopServer(instance);
      await backend.close();
    }
  });
});

test("activate refuses to link a supplier or rider email to a Google client", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);
    for (const [role, email, clerkId] of [
      ["supplier", "supplier@gridgo.ph", "user_google_supplier"],
      ["rider", "rider@gridgo.ph", "user_google_rider"],
    ]) {
      const backend = await startClerkBackend({
        [clerkId]: clerkUserPayload({ id: clerkId, email }),
      });
      const instance = await startServer(storePath, {
        ...CLERK_ENV,
        CLERK_JWT_KEY: JWT_KEY,
        CLERK_API_URL: backend.url,
      });
      try {
        assert.equal(instance.started, true, instance.output());
        const response = await request(instance.api, "/auth/clerk/activate", {
          method: "POST",
          token: signToken({ sub: clerkId, gridgo_role: undefined }),
        });
        assert.equal(response.status, 403, `${role}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.error, "invitation_required");

        const store = JSON.parse(await fs.readFile(storePath, "utf8"));
        const existing = store.users.find((user) => user.email === email);
        assert.equal(existing.role, role);
        assert.equal(existing.clerkUserId, undefined);
        assert.equal(store.users.some((user) => user.clerkUserId === clerkId), false);
        assert.equal(backend.patches.length, 0);
      } finally {
        await stopServer(instance);
        await backend.close();
      }
    }
  });
});

test("dual mode still accepts a legacy tok_ session after Clerk activate exists", async () => {
  await withTempStore(async (storePath) => {
    seed(storePath);
    const clerkId = "user_google_other";
    const backend = await startClerkBackend({
      [clerkId]: clerkUserPayload({ id: clerkId, email: "other.google@example.com" }),
    });
    const instance = await startServer(storePath, {
      ...CLERK_ENV,
      CLERK_JWT_KEY: JWT_KEY,
      CLERK_API_URL: backend.url,
    });
    try {
      assert.equal(instance.started, true, instance.output());
      const login = await request(instance.api, "/auth/login", {
        method: "POST",
        body: { email: "client@gridgo.ph", password: DEMO_PASSWORD },
      });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.match(login.body.token, /^tok_/);
      const me = await request(instance.api, "/auth/me", { token: login.body.token });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.user.email, "client@gridgo.ph");

      const activated = await request(instance.api, "/auth/clerk/activate", {
        method: "POST",
        token: signToken({ sub: clerkId, gridgo_role: undefined }),
      });
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      const after = await request(instance.api, "/auth/me", { token: login.body.token });
      assert.equal(after.status, 200, JSON.stringify(after.body));
      assert.equal(after.body.user.email, "client@gridgo.ph");
    } finally {
      await stopServer(instance);
      await backend.close();
    }
  });
});
