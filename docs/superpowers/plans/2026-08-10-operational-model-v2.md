# Operational Model v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pilot order flow with the captain's self-signup, commission, distance-band, split-payment, POF-milestone, expiring issue-window, and rider-checklist model.

**Architecture:** Put deterministic calculations, projections, expiry, and migration in a pure `operational-model` module, leaving `server.js` responsible for authenticated HTTP orchestration and atomic JSON persistence. Extend the existing file registry for POF/checklist evidence so object storage remains single-path.

**Tech Stack:** Node.js 24, ESM, `node:http`, `node:test`, JSON store, existing MinIO SDK only.

## Global Constraints

- Never reset or start the captain's store/API; test only a copied store on a free high port and stop only the captured PID.
- All money is integer PHP minor units; commission is 10% on top and is never exposed to clients.
- Delivery bands are configurable and initially provisional: `<5km=2500`, `5-10km=5000`, `>10km=7500`.
- COD must not be accepted by any endpoint or rider proof path.
- Manual Operations/Super Admin confirmation is the pilot QR-payment adapter seam.
- Existing orders and files migrate through idempotent `load()` backfill without deletion.
- No new direct dependency; every route is authorized and every error keeps a snake-case code plus actionable copy.

---

### Task 1: Pure v2 model and migration

**Files:**
- Create: `src/operational-model.js`
- Create: `tests/operational-model.test.js`

**Interfaces:**
- Produces: `defaultOperationalSettings()`, `calculateFinalPrice()`, `estimatePriceRange()`, `createPayoutMilestones()`, `publicOrderFor()`, `releaseMilestone()`, `expireIssueWindows()`, and `backfillOperationalModel()`.

- [ ] **Step 1: Write failing pure tests**

Cover literal arithmetic for `100000 + 10000 + 2500 = 112500`, client projection absence of `supplierPriceMinor`/`commissionMinor`, exact milestone shares, POF release rejection, elapsed issue-window completion, COD migration, supplier-proof state migration, and second-run deep equality.

- [ ] **Step 2: Run RED**

Run: `node --test tests/operational-model.test.js`

Expected: failure because `src/operational-model.js` does not exist.

- [ ] **Step 3: Implement the pure module**

Use integer arithmetic and literal milestone codes. Make retention the rounding remainder. Backfill only missing v2 fields except deliberate retired-state/COD normalization, and ensure repeated calls with the same `at` return `false` and preserve byte equality.

- [ ] **Step 4: Run GREEN**

Run: `node --test tests/operational-model.test.js`

Expected: all pure model tests pass.

### Task 2: Replace supplier proof with POF in storage

**Files:**
- Modify: `src/attachments.js`
- Modify: `tests/attachments.test.js`
- Modify: `docs/STORAGE_API.md`

**Interfaces:**
- Produces: upload purpose `fulfilment_proof`; attach target `{orderId,milestoneCode}`; legacy `proof` remains readable but cannot be uploaded or attached.

- [ ] **Step 1: Write failing attachment tests**

Prove assigned supplier can attach printing/packaging POF, assigned rider can attach delivered POF, wrong actor/milestone fails, attachment records the milestone file ID, and old `proof` upload authorization fails.

- [ ] **Step 2: Run RED**

Run: `node --test tests/attachments.test.js`

Expected: failures for missing `fulfilment_proof` policy and legacy proof still being accepted.

- [ ] **Step 3: Implement minimal POF attachment behavior**

Remove supplier-proof transition helpers. Extend target validation to accept exactly `orderId` and `milestoneCode`, authorize milestone actor/state, attach to `fulfilmentProofFileIds`, and link the same delivered file to retention.

- [ ] **Step 4: Run GREEN**

Run: `node --test tests/attachments.test.js`

Expected: all attachment tests pass.

### Task 3: Signup and approval gates

**Files:**
- Modify: `src/server.js`
- Create: `tests/api-v2.test.js`

**Interfaces:**
- Produces: `POST /auth/signup`; approved-only supplier matching and rider offer/accept behavior.

- [ ] **Step 1: Write failing integration tests**

Start the API against a temporary seeded store. Assert client/supplier/rider signup shapes, duplicate/invalid profiles, supplier category rank validation, pending verification defaults, pending supplier ineligibility, and pending rider dispatch denial before approval.

- [ ] **Step 2: Run RED**

Run: `node --test tests/api-v2.test.js --test-name-pattern='signup|approval'`

Expected: signup returns 401/404 and rider offers lack the approval guard.

- [ ] **Step 3: Implement signup and gates**

Validate role-specific fields against the active taxonomy, issue a normal JSON session, reuse `verificationStatus`, and add explicit `rider_not_approved` errors on offer and accept routes.

- [ ] **Step 4: Run GREEN**

Run the same command; expected PASS.

### Task 4: Assignment pricing, settings, and role-safe projections

**Files:**
- Modify: `src/server.js`
- Modify: `tests/api-v2.test.js`

**Interfaces:**
- Produces: `GET /settings`, `PATCH /settings`, order `priceRange`, acceptance `supplierPriceMinor`, assignment notification, and role-filtered order responses.

- [ ] **Step 1: Write failing route tests**

Assert creation returns a range, supplier acceptance computes exact worked-example values, assignment notification exists, client JSON recursively contains neither `commissionMinor` nor `supplierPriceMinor`, ops sees both, and Operations can replace valid bands/issue hours.

- [ ] **Step 2: Run RED**

Run matching tests and confirm expected missing-field/leak failures.

- [ ] **Step 3: Implement settings/pricing/projection routes**

Ignore client-supplied delivery fees, derive distance from server-held coordinates, snapshot the selected band, atomically notify on acceptance, and route every order response through `publicOrderFor(order,user)`.

- [ ] **Step 4: Run GREEN**

Run matching tests; expected PASS.

### Task 5: Manual split payments and complete COD retirement

**Files:**
- Modify: `src/server.js`
- Modify: `tests/api-v2.test.js`
- Modify: `src/seed.js`

**Interfaces:**
- Produces: `POST /orders/:id/payments/:installment/submit` and `/confirm`; accepts only `qr_manual`.

- [ ] **Step 1: Write failing payment tests**

Prove payment is blocked before a stored assignment notification, client can submit the exact downpayment/balance references, only ops/super confirms, production waits for downpayment confirmation, delivery waits for balance confirmation, and `cod` is rejected through transition/payment/rider endpoints.

- [ ] **Step 2: Run RED**

Run matching tests; expected failures because the split routes do not exist and COD still authorizes.

- [ ] **Step 3: Implement split payments and remove COD branches**

Use one helper-backed installment route pair with an explicit adapter source `manual_ops`. Remove the legacy COD state mutation, ceiling, one-active check, `codEligible`, and rider `kind: cod` behavior. Converge fresh seed through v2 backfill.

- [ ] **Step 4: Run GREEN and search**

Run tests, then `rg -n 'codEligible|cod_limit|cod_one_active|kind.*cod|paymentMethod.*cod' src tests` and verify only migration fixtures/explicit rejection tests remain.

### Task 6: POF milestone release and issue expiry

**Files:**
- Modify: `src/server.js`
- Modify: `tests/api-v2.test.js`

**Interfaces:**
- Produces: `POST /orders/:id/milestones/:code/release`; automatic retention expiry/release.

- [ ] **Step 1: Write failing integration tests**

Assert release without attached POF is `409 pof_required`, release succeeds with the correct attached ready file, holds block retention, and an expired unheld order becomes completed with retention released on the next request.

- [ ] **Step 2: Run RED**

Run matching tests; expected missing-route and non-expiring-window failures.

- [ ] **Step 3: Implement milestone route and load-time expiry**

Audit each release. Re-check `issueWindowExpiresAt` during issue creation. Ensure no manual `payout_released` edge can bypass individual milestone gates.

- [ ] **Step 4: Run GREEN**

Run matching tests; expected PASS.

### Task 7: Rider checklist, escalation, and delivery evidence

**Files:**
- Modify: `src/server.js`
- Modify: `tests/api-v2.test.js`

**Interfaces:**
- Produces: `POST /dispatch/:id/pickup-checklist`, `GET /escalations`, and `POST /dispatch/:id/delivery`.

- [ ] **Step 1: Write failing checklist tests**

Assert exactly six named checks are required, any failure requires attached photo evidence and records escalation without transport, all-pass advances to picked up and returns the exact spoken prompt, and delivery requires an attached photo/signature plus confirmed balance.

- [ ] **Step 2: Run RED**

Run matching tests; expected 404s for new routes.

- [ ] **Step 3: Implement checklist/escalation/delivery routes**

Validate evidence through the existing file registry, notify every ops/super account on failure, retire the generic proof mutation route, and snapshot the global issue-window expiry on delivery.

- [ ] **Step 4: Run GREEN**

Run matching tests; expected PASS.

### Task 8: Contract docs, live-copy migration proof, and completion

**Files:**
- Create: `docs/OPERATIONAL_MODEL_V2_API.md`
- Modify: `README.md`
- Modify: `PRD.md`
- Modify: `AGENTS.md`
- Create: `docs/V2_MIGRATION_CHECKSUMS.md`

**Interfaces:**
- Produces: exact mobile/web contract and reproducible collection checksum evidence.

- [ ] **Step 1: Document every route/state/authorization/field**

Include the exact ₱1,000/₱100/₱25/₱1,125 example; downpayment `84375`, balance `28125`; POF/checklist contracts; provisional bands; manual confirmation; COD removal; and migration mapping.

- [ ] **Step 2: Run all automated tests**

Run: `npm test`

Expected: zero failures and no warnings from tests.

- [ ] **Step 3: Verify copied-store migration twice**

Copy the discovered captain store into a temporary directory, start only that copy on a checked free high port, stop the captured PID, and hash each top-level collection before/after first load/after second load. Record changed and unchanged collections; second-load hashes must all match first-load hashes.

- [ ] **Step 4: Review and commit**

Run `git diff --check`, focused forbidden-COD/proof-state searches, and `git status --short`; commit all implementation/docs, push only `fm/gridgo-api-model-v2`, open the PR with `gh-axi`, and report the required provisional-band/rider-screen notes.
