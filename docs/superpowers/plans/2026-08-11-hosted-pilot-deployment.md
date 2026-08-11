# Hosted Pilot Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GRIDGO deployable as an honest, production-configured hosted pilot without changing its JSON-store architecture or local demo experience.

**Architecture:** Add a small environment/configuration boundary shared by the seeder and server. Keep the rich local fixture as-is, produce a minimal production store from shared reference definitions, apply an exact-origin CORS policy at the HTTP response boundary, and document a loopback-only reverse-proxy deployment and coordinated recovery procedure.

**Tech Stack:** Node.js 20+ ESM, `node:http`, built-in `node:test`, JSON file store, MinIO SDK, Docker Compose, nginx/systemd deployment examples.

## Global Constraints

- Production is a hosted pilot with the JSON file store; do not introduce a database.
- The committed password is development-only; production must require six environment-supplied credentials and refuse unsafe startup.
- Preserve route contracts and plain `node:http`; add no direct npm dependency.
- CORS uses exact configured origins and never a wildcard.
- Production operational collections start empty; local development retains the rich seed.
- MinIO stays private and loopback-bound; the console is never exposed.
- Never use ports 8081, 8082, 8083, 8787, 3000, or 9000 during verification.

---

### Task 1: Hosted-pilot behavior tests

**Files:**
- Create: `tests/hosted-pilot.test.js`
- Modify: `tests/seed-consistency.test.js`

**Interfaces:**
- Consumes: `node src/seed.js --reset`, `node src/server.js`, and `GET /health`.
- Produces: regression coverage for production credential refusal, production seed contents, local rich seed, exact-origin CORS, startup success, and load idempotence.

- [ ] **Step 1: Write subprocess test helpers and failing production credential test**

```js
const PASSWORD_ENV = {
  GRIDGO_CLIENT_PASSWORD: "client-hosted-secret",
  GRIDGO_INDIVIDUAL_PASSWORD: "individual-hosted-secret",
  GRIDGO_SUPPLIER_PASSWORD: "supplier-hosted-secret",
  GRIDGO_RIDER_PASSWORD: "rider-hosted-secret",
  GRIDGO_OPS_PASSWORD: "operations-hosted-secret",
  GRIDGO_ADMIN_PASSWORD: "administrator-hosted-secret",
};

test("production refuses startup when configured account credentials are missing", () => {
  const result = spawnSync(process.execPath, ["src/server.js"], {
    env: { ...cleanEnvironment, NODE_ENV: "production" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GRIDGO_CLIENT_PASSWORD/);
  assert.match(result.stderr, /Set GRIDGO_CLIENT_PASSWORD/);
});
```

- [ ] **Step 2: Run the new credential test and verify RED**

Run: `node --test --test-name-pattern='production refuses startup' tests/hosted-pilot.test.js`

Expected: FAIL because current startup does not validate deployment credentials.

- [ ] **Step 3: Add failing seed, local regression, CORS, startup, and idempotence tests**

```js
assert.equal(productionStore.orders.length, 0);
assert.equal(productionStore.supplierServices.length, 0);
assert.ok(productionStore.taxonomy.categories.length > 0);
assert.ok(productionStore.catalog.length > 0);
assert.ok(localStore.orders.length > 0);
assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
assert.equal(rejected.status, 403);
assert.equal(rejectedBody.error, "origin_not_allowed");
assert.equal(afterSecondHealth, afterFirstHealth);
```

- [ ] **Step 4: Run the hosted-pilot tests and verify RED**

Run: `node --test tests/hosted-pilot.test.js`

Expected: FAIL on clean production seeding and wildcard CORS behavior.

### Task 2: Runtime configuration and production credentials

**Files:**
- Create: `src/runtime-config.js`
- Modify: `src/demo-fixtures.js`
- Test: `tests/hosted-pilot.test.js`

**Interfaces:**
- Produces: `isProduction(env)`, `configuredDemoUsers(env)`, `parseAllowedOrigins(env)`, and `validateProductionServerEnvironment(env)`.
- Consumes: the exact fixture identities and committed `DEMO_PASSWORD` from `src/demo-fixtures.js`.

- [ ] **Step 1: Implement exact password mapping and validation**

```js
export const DEMO_PASSWORD_ENV_BY_EMAIL = new Map([
  ["client@gridgo.local", "GRIDGO_CLIENT_PASSWORD"],
  ["individual@gridgo.local", "GRIDGO_INDIVIDUAL_PASSWORD"],
  ["supplier@gridgo.local", "GRIDGO_SUPPLIER_PASSWORD"],
  ["rider@gridgo.local", "GRIDGO_RIDER_PASSWORD"],
  ["ops@gridgo.local", "GRIDGO_OPS_PASSWORD"],
  ["admin@gridgo.local", "GRIDGO_ADMIN_PASSWORD"],
]);
```

For production, clone every fixture and replace its password from the mapped variable. Throw a concrete error when missing, shorter than 12 characters, or equal to `DEMO_PASSWORD`.

- [ ] **Step 2: Implement exact-origin parsing and production server validation**

Normalize comma-separated HTTP(S) origins through `new URL(value).origin`, require the input to equal that origin, and reject `*`. In production require at least one origin, a loopback `MINIO_ENDPOINT`, HTTPS `MINIO_PUBLIC_URL`, `MINIO_ACCESS_KEY`, and `MINIO_SECRET_KEY`; every error names the variable and fix.

- [ ] **Step 3: Run the credential-focused tests and verify GREEN**

Run: `node --test --test-name-pattern='production refuses startup|production seed' tests/hosted-pilot.test.js`

Expected: PASS.

### Task 3: Explicit clean production seed and load behavior

**Files:**
- Modify: `src/seed.js`
- Modify: `src/server.js`
- Test: `tests/hosted-pilot.test.js`
- Test: `tests/seed-consistency.test.js`

**Interfaces:**
- Consumes: `configuredDemoUsers(process.env)` and `isProduction(process.env)`.
- Produces: production store with populated `users`, `catalog`, `taxonomy`, `settings`, and `zones`; all operational collections empty.

- [ ] **Step 1: Select a production store at the seed write boundary**

```js
const store = production
  ? {
      version: 2,
      users: configuredUsers,
      sessions: {},
      catalog,
      taxonomy,
      settings,
      zones,
      supplierServices: [],
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
    }
  : demoStore;
```

- [ ] **Step 2: Make production fixture convergence authoritative and non-demo**

Pass the environment-resolved fixture list into convergence. Production overwrites only those fixture passwords from configuration, while local mode preserves the retired-password-only rotation. Skip demo supplier-service fabrication in production.

- [ ] **Step 3: Improve missing custom store startup recovery**

The error must name the missing path and instruct the operator to run `NODE_ENV=production STORE_PATH=<path> npm run seed` before restart.

- [ ] **Step 4: Run seed and idempotence tests and verify GREEN**

Run: `node --test tests/hosted-pilot.test.js tests/seed-consistency.test.js tests/api-v2.test.js`

Expected: PASS with the local seed assertions unchanged and a byte-identical store after a second production load.

### Task 4: Exact-origin HTTP and SSE CORS

**Files:**
- Modify: `src/server.js`
- Test: `tests/hosted-pilot.test.js`

**Interfaces:**
- Consumes: the `Set<string>` from `parseAllowedOrigins(process.env)`.
- Produces: per-response headers stored on `res`, plus `403 origin_not_allowed` for unlisted browser origins.

- [ ] **Step 1: Add request-origin policy before routing or store mutation**

```js
const origin = req.headers.origin;
if (origin && !allowedOrigins.has(origin)) {
  return send(res, 403, {
    error: "origin_not_allowed",
    message: `Origin ${origin} is not allowed. Add its exact origin to CORS_ALLOWED_ORIGINS and restart the API.`,
  });
}
```

- [ ] **Step 2: Replace wildcard headers in JSON and SSE responses**

Allowed origins receive the exact `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`. Preflight additionally receives the existing allowed headers and methods. Originless requests receive no allow-origin header.

- [ ] **Step 3: Run CORS tests and verify GREEN**

Run: `node --test --test-name-pattern='origin allowlist' tests/hosted-pilot.test.js`

Expected: PASS and repository search finds no wildcard allow-origin header.

### Task 5: Operator deployment and project memory

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/STORAGE_API.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: environment names and runtime behavior from Tasks 2–4.
- Produces: complete operator runbook for `gridgo-api.talasora.com` and `gridgo.talasora.com`.

- [ ] **Step 1: Document environment and initialization**

Include all six password variables, `CORS_ALLOWED_ORIGINS=https://gridgo.talasora.com`, `STORE_PATH`, loopback Node port, MinIO internal and HTTPS public origins, API-scoped credentials, and portal API base.

- [ ] **Step 2: Document TLS and private MinIO routing**

Provide an nginx example that terminates TLS, proxies Node routes, forwards only `/gridgo-uploads/` to loopback MinIO with the original host/URI, and never proxies the console. Warn that Docker-published ports bypass host firewall rules.

- [ ] **Step 3: Document backup, restore, health verification, and limits**

Use a maintenance window for a coordinated JSON plus bucket backup. Restore both components, validate JSON before replacement, and verify health/login/upload/download. State that empty recreation is not recovery and name scale/migration signals.

- [ ] **Step 4: Record durable project knowledge**

Point `AGENTS.md` at `docs/DEPLOYMENT.md` and record the production/local seed boundary, credential authority, exact-origin CORS requirement, and private storage rule without duplicating the runbook.

### Task 6: Full verification and delivery

**Files:**
- Modify only files required by findings.

**Interfaces:**
- Consumes: completed implementation and documentation.
- Produces: passing tests, manual proof logs, committed branch, and direct PR.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all tests pass with no unexpected warnings or failures.

- [ ] **Step 2: Prove configured production startup and empty data**

Choose a free high port outside the forbidden list, seed a temporary production store with all six credentials, start the server with complete production configuration, capture its PID, query health and authenticated empty order/notification endpoints, stop exactly that PID, and retain command output for the PR.

- [ ] **Step 3: Prove missing-credential refusal**

Start against the temporary store with `NODE_ENV=production` and the credential variables removed. Verify nonzero exit and a concrete message naming the missing variable and fix.

- [ ] **Step 4: Prove backfill idempotence**

Start the configured server twice against the same temporary store and compare the complete store bytes before and after the second load.

- [ ] **Step 5: Review, commit, push, and open PR**

Run the verification-before-completion, requesting-code-review, and finishing-a-development-branch skill checklists; inspect `git diff --check` and the final diff; commit on `fm/gridgo-api-production`; push only that branch; open a PR with `gh-axi`; append the final `done: PR <url>` status.
