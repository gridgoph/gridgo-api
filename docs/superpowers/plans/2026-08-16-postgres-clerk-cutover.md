# PostgreSQL and Clerk-Only Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all JSON persistence with transactional PostgreSQL 17 storage and make verified Clerk identities the API's only authentication mechanism.

**Architecture:** Keep route contracts and plain-object domain helpers stable behind a direct-`pg` unit of work. A normalized PostgreSQL schema owns identity, relationships, lifecycle state, money, and query keys; bounded composite API documents use JSONB. Every mutation materializes a baseline, changes it through existing route logic, and persists its row diff under one transaction-scoped advisory lock.

**Tech Stack:** Node.js 22 ESM, `node:http`, `pg`, `node-pg-migrate`, Clerk Backend SDK, PostgreSQL 17, Docker Compose, Node test runner.

## Global Constraints

- Do not preserve or import any JSON data; no JSON-to-PostgreSQL importer or fallback may exist.
- Money uses PostgreSQL `BIGINT` integer minor units and must remain JavaScript safe integers at the HTTP boundary.
- Plain latitude/longitude columns are intentional; do not add PostGIS without a database-side spatial query.
- Clerk configuration is mandatory, GRIDGO roles are authoritative in PostgreSQL, and public activation can create only clients.
- Object bytes remain in MinIO; PostgreSQL stores metadata only.
- A fresh seed inserts only taxonomy, catalog, zones, and settings and creates no users.
- Production PostgreSQL publishes no host port and production commands must not be executed from this worktree.

---

### Task 1: Versioned relational schema and database runtime

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `migrations/001_initial_schema.js`
- Create: `src/database.js`
- Test: `tests/database.test.js`

**Interfaces:**
- Produces: `createDatabase(env)`, returning `{ transaction(fn), query(text, values), health(), assertReady(), close(), afterCommit(fn) }`.
- Produces: schema tables for all domain collections, with `BIGINT` minor-unit columns and indexed foreign/query keys.

- [ ] **Step 1: Write the failing database test**

Create a real-PostgreSQL test that runs migrations, asserts `assertReady()` succeeds, verifies a transaction rollback removes inserted catalog rows, and verifies two transactions updating the same credit account through the advisory lock produce the expected final integer balance.

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test node --test tests/database.test.js`

Expected: FAIL because `src/database.js` and the migration do not exist.

- [ ] **Step 3: Implement the migration and database unit of work**

Add `pg` and `node-pg-migrate`, define ordered forward migration `001`, parse timestamps as ISO strings and int8 as checked numbers, require `DATABASE_URL`, and use `BEGIN`, `pg_advisory_xact_lock(hashtext('gridgo-domain-mutation'))`, `COMMIT`/`ROLLBACK`. Queue `afterCommit` callbacks in async transaction context so notifications cannot publish before durability.

- [ ] **Step 4: Run the database test**

Run the command from Step 2. Expected: PASS with a real PostgreSQL connection.

### Task 2: Route-compatible relational store adapter and reference seed

**Files:**
- Create: `src/postgres-store.js`
- Create: `src/reference-data.js`
- Replace: `src/seed.js`
- Test: `tests/postgres-store.test.js`
- Test: `tests/seed-consistency.test.js`

**Interfaces:**
- Consumes: database query/transaction interface from Task 1.
- Produces: `emptyStore()`, `loadStore(database)`, `saveStore(database, store)`, and `seedReferenceData(database)`.
- Produces route-facing keys: `version`, `users`, `catalog`, `taxonomy`, `settings`, `zones`, `supplierServices`, `orders`, `files`, `credits`, `claims`, `issues`, `auditLog`, `notifications`, `locationPings`, `escalations`, `proofs`, and `deviceTokens` (no `sessions`).

- [ ] **Step 1: Write failing round-trip and seed tests**

Insert a client, supplier, order, two installments, payout milestone, claim, issue, notification, file metadata/reference, credit ledger movement, ping, and device registration through `saveStore`; reload and assert the public object graph and integer money values exactly match. Seed twice and assert reference rows are stable and every user/transactional table remains empty.

- [ ] **Step 2: Run the tests to verify failure**

Run: `DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test node --test tests/postgres-store.test.js tests/seed-consistency.test.js`

Expected: FAIL because the adapter/reference seed do not exist.

- [ ] **Step 3: Implement row mapping and diff persistence**

Map typed columns independently from JSONB extension data, reconstruct nested installments/milestones/file references/credit ledgers, retain array position, and compare canonical row values to the load baseline. Delete missing dependent rows in reverse dependency order; upsert changed parent/dependent rows in forward order. Reject unsafe integer money before SQL execution.

- [ ] **Step 4: Implement idempotent reference-only seed**

Move catalog/zones definitions into `reference-data.js`, reuse `defaultTaxonomy()` and `defaultOperationalSettings()`, load the current graph, replace only reference collections/settings, and save inside one transaction. `--reset` is removed because the seed is non-destructive and user-free.

- [ ] **Step 5: Run both tests**

Run the command from Step 2. Expected: PASS.

### Task 3: Clerk-only authentication and one-time administrator bootstrap

**Files:**
- Modify: `src/auth.js`
- Delete: `src/demo-fixtures.js`
- Create: `src/bootstrap-admin.js`
- Replace: `tests/auth-mode.test.js`
- Delete: `tests/official-dev-accounts.test.js`
- Delete: `tests/fixture-email-migration.test.js`

**Interfaces:**
- Produces: `authConfiguration(env)` with mandatory Clerk values and explicit refusal when `AUTH_MODE` is present.
- Produces: `authenticateBearerToken(token, store, config)` resolving only a verified Clerk `sub` to one database user, with database role authority.
- Produces: `activateClerkClientProfile(...)` creating/linking only a `client`, without passwords or Clerk role metadata.
- Produces CLI: `npm run bootstrap-admin -- --clerk-user-id <id>`.

- [ ] **Step 1: Write failing Clerk-only behavior tests**

Use a generated RSA key and `CLERK_JWT_KEY` to verify: startup refuses every missing Clerk variable and any `AUTH_MODE`; malformed/unmapped JWTs return 401; a mapped client token succeeds without a role claim; a supplier token is forbidden from a client-only money route; activation creates only a client; no login/signup route issues a local token.

- [ ] **Step 2: Verify the tests fail against legacy/dual behavior**

Run: `DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test node --test tests/auth-mode.test.js`

Expected: FAIL because legacy is still the default and local login exists.

- [ ] **Step 3: Remove legacy authentication and fixtures**

Delete session lookup, token-prefix dispatch, password fields, role-claim comparison, metadata role writes, fixture convergence, and fixture imports. Make authenticated lookup depend only on verified Clerk subject plus the database role.

- [ ] **Step 4: Implement bootstrap command and test its permanent closure**

Fetch the requested Clerk user, derive email/name/phone, and in a database transaction refuse when any ops/super user exists; otherwise insert one `super_admin` plus an audit row. Test with a local fake Clerk API that the first run inserts and the second refuses without changing rows.

- [ ] **Step 5: Run authentication tests**

Run the command from Step 2. Expected: PASS.

### Task 4: Connect the HTTP server to PostgreSQL transactions

**Files:**
- Modify: `src/server.js`
- Modify: `src/notifications.js`
- Test: `tests/api-postgres.test.js`
- Delete: `tests/api-v2.test.js`
- Delete: `tests/push-api.test.js`
- Modify: `tests/attachments.test.js`
- Modify: `tests/push.test.js`

**Interfaces:**
- Consumes: `loadStore`, `saveStore`, database transaction and after-commit hooks.
- Preserves existing non-auth route request/response shapes.
- `/health` adds `database.status` while retaining build commit/time, storage, and push.

- [ ] **Step 1: Write the failing end-to-end acceptance test**

Against migrated PostgreSQL and signed Clerk JWTs, create mapped client/supplier/rider/ops users, then exercise an order from submission through supplier assignment/acceptance, downpayment submit/confirm, production milestones, rider pickup/delivery, balance confirmation, issue window completion, milestone releases, and payout release. Assert the installment and payout changes are durable after API restart. Also assert an unauthenticated request returns 401 and a wrong-role payment confirmation returns 403.

- [ ] **Step 2: Run the end-to-end test to verify failure**

Run: `DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test node --test tests/api-postgres.test.js`

Expected: FAIL because the server still reads `store.json`.

- [ ] **Step 3: Replace load/save and mutation queuing**

Remove `fs`, `STORE_PATH`, `DEFAULT_STORE`, JSON boot seeding, production demo guard, migration/backfill/fixture convergence, and session routes. Make `load()`/`save()` asynchronous PostgreSQL adapter calls. Run every POST/PATCH/DELETE handler inside `database.transaction`, including each short file metadata phase; keep MinIO transfers outside transactions.

- [ ] **Step 4: Move notification side effects after commit**

Detect new notification IDs from the adapter baseline, register SSE/push delivery with `database.afterCommit`, and keep dead-token pruning in a separate short transaction. Confirm a forced rollback produces no SSE/push event.

- [ ] **Step 5: Add database health and async startup checks**

Require successful `database.assertReady()` before `listen`; report `database: { status: "available" }` from a live `SELECT 1`. Keep storage/push degradation independent and retain build metadata.

- [ ] **Step 6: Run end-to-end and retained unit tests**

Run: `DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test npm test`

Expected: PASS with no JSON store files created.

### Task 5: Compose, image, CI, and database-volume survival

**Files:**
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.yml`
- Modify: `Dockerfile`
- Modify: `.github/workflows/deploy.yml`
- Test: workflow smoke script executed by GitHub Actions

**Interfaces:**
- Local compose: PostgreSQL 17 healthcheck, named volume, loopback-only high port, API/migrate/seed services.
- Production compose: PostgreSQL 17 only on `gridgo-api-storage`, no published database port, named `gridgo_postgres_data` volume.

- [ ] **Step 1: Add PostgreSQL and migration ordering to compose/image**

Copy migrations into the image, add `postgres:17-alpine`, use `pg_isready`, make API depend on healthy PostgreSQL and successful migration/seed jobs, and remove the JSON store volume/mount and `STORE_PATH`.

- [ ] **Step 2: Provision real PostgreSQL in CI tests**

Add a PostgreSQL 17 service to the check job, set only throwaway CI `DATABASE_URL`/Clerk test values, run migrations, then run tests. Do not mock PostgreSQL.

- [ ] **Step 3: Rewrite image smoke test around database volume survival**

Start PostgreSQL on the smoke network with a named volume, migrate/seed, insert a pre-redeploy marker through an authenticated API operation or SQL fixture plus API read, remove and recreate only the API container, and prove the row and MinIO file metadata remain. Then recreate PostgreSQL with the same volume and prove the row remains again. Remove only the exact smoke containers/network/volumes in `if: always()` cleanup.

- [ ] **Step 4: Validate declarative configuration**

Run: `docker compose config` and `docker compose -f deploy/docker-compose.yml config`

Expected: both parse; production PostgreSQL has no `ports` entry and both database volumes have explicit names.

### Task 6: Configuration, deployment runbook, API documentation, and durable project memory

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/OPERATIONAL_MODEL_V2_API.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Documents exact required variables: `DATABASE_URL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `CLERK_SECRET_KEY`, `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`; optional test/local overrides remain clearly labeled.

- [ ] **Step 1: Replace JSON/password deployment guidance**

Document PostgreSQL migration/seed/bootstrap/cutover, private networking, named-volume backup/restore, credential rotation, health interpretation, and rollback. Remove JSON backup/restore, fixture password, `AUTH_MODE`, and local login guidance.

- [ ] **Step 2: Document identity and client contract changes**

State the cutover behavior: login/signup token issuance is gone, Google/Clerk activation remains `{ user }`, ordinary mapped Clerk requests need no GRIDGO role claim, logout only releases a device, roles live in PostgreSQL, and supplier/rider/ops users were activated then promoted by a super administrator. The later fixed supplier/rider enrollment contract is owned by `docs/OPERATIONAL_MODEL_V2_API.md`.

- [ ] **Step 3: Record the five PR decisions**

Ensure README/deployment notes plainly state: `BIGINT` minor units, no PostGIS, explicit client-only JIT activation plus database-authoritative roles, one-time CLI administrator bootstrap, and auth response/endpoint changes requiring app/dashboard follow-up.

- [ ] **Step 4: Run documentation/configuration consistency checks**

Run: `rg -n "store\.json|STORE_PATH|AUTH_MODE|DEMO_PASSWORD|GRIDGO_.*_PASSWORD|auth/login" --glob '!docs/superpowers/**' .`

Expected: no active code/config path or current operational instruction remains; historical API changelog wording, if retained, is explicitly labeled retired.

### Task 7: Full verification, commit, and no-mistakes delivery

**Files:** all task files

**Interfaces:** produces a committed feature branch ready for the no-mistakes pipeline.

- [ ] **Step 1: Run fresh migration, seed, and behavioral suite**

Run: `npm run migrate && npm run seed && npm test` with the real local PostgreSQL URL and mandatory Clerk test configuration.

Expected: migrations succeed from an empty database, seed is idempotent/user-free, and all tests pass.

- [ ] **Step 2: Run image and compose verification**

Run: `docker compose config`, production compose config, and `docker build` with local tags only. Start the local stack, verify `/health` reports database/storage/push/build fields, then stop only the exact task-owned processes/containers.

- [ ] **Step 3: Inspect requirements and repository state**

Run `git diff --check`, inspect every changed file, verify no secret or JSON data file is tracked, and check all acceptance criteria against fresh command output.

- [ ] **Step 4: Commit task changes**

Commit only task-owned files on `fm/gridgo-api-postgres-clerk` with a message describing the PostgreSQL and Clerk-only cutover.

- [ ] **Step 5: Drive no-mistakes**

Run `no-mistakes axi`, then start `no-mistakes axi run --intent '<complete current launch-brief requirements and implementation decisions>'`. At each gate, let the pipeline apply auto-fixes; escalate every `ask-user` finding to Firstmate exactly as required. Stop at `checks-passed` with the PR URL.
