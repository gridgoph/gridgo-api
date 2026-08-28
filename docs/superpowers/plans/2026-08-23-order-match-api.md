# Client Order Match API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to execute this plan task-by-task. This checkout must stay on `dev`; do not commit, push, branch, or open a PR.

**Goal:** Add client preferences, saved addresses, explainable shop matching, relational cart checkout, per-shop jobs, invoice snapshots, and mockup attachment.

**Architecture:** An additive forward migration introduces the new relational boundaries without removing legacy order columns. Pure order-match helpers own validation, scoring, totals, and projections; a focused route dispatcher owns authenticated HTTP contracts; `postgres-store.js` maps all new rows through the existing transaction-scoped review adapter.

**Tech Stack:** Node.js 20+, plain `node:http`, PostgreSQL 17, `pg`, `node-pg-migrate`, Node test runner.

**Spec:** `/home/kali/firstmate/data/gridgo-api-order-match/brief.md`

## Global Constraints

- Stay on local branch `dev`; do not commit, push, create a branch, or open a PR.
- PostgreSQL is the only domain store, and every HTTP mutation commits in one advisory-locked transaction.
- Money is signed PostgreSQL `BIGINT` PHP minor units within JavaScript's safe-integer range; never use floats.
- Clerk JWT identity and PostgreSQL client membership fail closed on every `/me/*` route.
- File bytes remain in MinIO; PostgreSQL stores only opaque file references.
- Checkout accepts `qr_manual` only and creates `needs_qa` work without notifying shops.
- Production `npm run seed` remains user-free; only `seed:dev` creates operational fixtures from existing Clerk identities.

---

### Task 1: Matching and preference domain behavior

**Files:**
- Create: `src/order-match.js`
- Create: `tests/order-match.test.js`

**Interfaces:**
- Produces: `validatePreferenceRanking(value)`, `matchShop(store, input)`, `calculateCartTotals(store, cart)`, and projections used by the route layer.

- [ ] Write tests with literal expected ranking weights, stable shop-id tie breaking, distance-first drop-off validation, queue-adjusted speed, same-shop preference, and invalid permutations.
- [ ] Run `node --test tests/order-match.test.js` and confirm failures are caused by missing exports.
- [ ] Implement the minimum pure validation/scoring helpers; quality uses public-listing completeness plus approved standing, speed uses effective turnaround plus open jobs, and distance uses haversine metres.
- [ ] Re-run the focused test until it passes, then refactor only while it stays green.

### Task 2: Relational schema and PostgreSQL adapter

**Files:**
- Create: `migrations/1786896000000_client_order_match.js`
- Modify: `src/postgres-store.js`
- Modify: `tests/migrations.test.js`
- Modify: `tests/postgres-store.test.js`

**Interfaces:**
- Produces store arrays: `clientPreferences`, `clientAddresses`, `carts`, `cartLines`, `orderJobs`, `jobQaChecklist`, and `orderInvoices`; extends order-line snapshots with `jobId`, artwork/mockup references, and optional line drop-off.

- [ ] Add migration assertions for tables, foreign keys, constrained points/states, invoice uniqueness, payment method constraints, and clean reversal.
- [ ] Run the migration/store tests and confirm the new schema assertions fail.
- [ ] Add the ordered forward migration and adapter table mappings, preserving legacy order columns and old records.
- [ ] Re-run focused migration/store tests until they pass.

### Task 3: Authenticated HTTP contract

**Files:**
- Create: `src/order-match-routes.js`
- Modify: `src/server.js`
- Create: `tests/order-match-api.test.js`

**Interfaces:**
- Consumes domain functions and store arrays from Tasks 1–2.
- Produces `GET/PUT /me/preferences`, `GET/POST /me/addresses`, `POST /me/matches`, `POST /me/matches/next`, cart create/read/update/line/remove/fulfilment/drop-off/mockup routes, `POST /me/carts/:id/checkout`, and `GET /orders/:id/invoice`.

- [ ] Add real HTTP tests proving client-only authorization, preference validation, follow-up exclusions, same-shop matching, cart ownership, mockup readiness/ownership, QR-only checkout, per-job delivery fees, invoice persistence, `needs_qa`, and no supplier notification.
- [ ] Run `node --test tests/order-match-api.test.js` and confirm the missing routes fail with the expected `404`/contract mismatch.
- [ ] Implement the route dispatcher and wire it before legacy order routing; validate every body field and return snake-case errors.
- [ ] Re-run the HTTP test until green; preserve role-aware legacy order responses and avoid parallel public catalog routes.

### Task 4: Three-shop local fixture seed

**Files:**
- Modify: `src/seed-dev.js`
- Modify: `tests/seed-dev.test.js`
- Modify: `README.md`

**Interfaces:**
- Produces three approved Davao fixture shops mapped to real development Clerk subjects, each with live Flyers and at least one additional public listing.

- [ ] Extend the seed test's Clerk fixture to three existing identities and assert idempotent users/services/listings for all three shops.
- [ ] Run `node --test tests/seed-dev.test.js` and confirm it fails because only Lovis exists.
- [ ] Generalize local shop seeding while keeping `seedReferenceData` user-free and retaining Lovis's fixed email/name.
- [ ] Re-run the seed test until green and update the local-development README wording.

### Task 5: Client contract and verification

**Files:**
- Create: `docs/ORDER_MATCH_API.md`
- Modify: `AGENTS.md` only if the new authoritative contract is durable project memory.

**Interfaces:**
- Produces the concise request/response/error contract consumed by the client implementation.

- [ ] Document exact route methods, bodies, response projections, money semantics, matching explanation, and checkout state.
- [ ] Run the full test suite against the isolated test database.
- [ ] Load `.env` and `.env.local`, run `npm run migrate` on the local development database, and run `npm run seed:dev` without starting another API on port 8787.
- [ ] Verify `/health`, append the required terminal status line, and leave all work uncommitted on `dev`.
