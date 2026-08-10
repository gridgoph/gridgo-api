# gridgo-api

Local **custom** demo backend for all GRIDGO apps.

## MVP

- Custom auth (no Clerk)
- JSON store (no Supabase)
- Pilot Credits grants plus manually confirmed QR installments (no PayMongo, no COD)
- Replaceable: keep route contracts stable
- Platform-governed **service taxonomy** + supplier services (blueprint §4.2)
- Ops/super: users, roles, verification, zones, grants, claims, issues, audit

See `PRD.md` and `README.md` for full route tables and field shapes.

## Geography (map / OSRM)

Orders carry additive map points so apps never geocode at runtime:

- `pickup: { lat, lng, label } | null` — supplier shop; **null** until a supplier is assigned
- `dropoff: { lat, lng, label }` — client delivery point; `label` matches `address`
- Keep existing `address` and `zone` strings unchanged

Supplier users may have `shop: { lat, lng, label }`. Order `pickup` is derived from that shop. Coords are real **Davao City** anchors (centre ~`7.0731, 125.6128`); zone-based dropoffs use a small deterministic offset so pins do not stack.

Rider tracking:

- `POST /dispatch/:id/location` — assigned rider pings while `picked_up` / `out_for_delivery`
- `GET /dispatch/:id/location` — latest ping (`{ ping }` or `{ ping: null }`); no staleness verdict
  - Allowed: assigned rider, order client, assigned supplier, ops/super admin
  - Else `403` `{ error: "forbidden" }`

## Operational model v2

The exact rebuild contract is `docs/OPERATIONAL_MODEL_V2_API.md`; file bytes/attachments remain in `docs/STORAGE_API.md`. V2 uses self-signup, approved-only supplier/rider matching, 10%-on-top commission, configurable distance bands, manually confirmed 75%/25% digital payments, POF-gated supplier milestones, a global expiring issue window, and the six-check rider pickup gate. COD and the supplier-proof approval states are retired.

Money/order visibility must go through the role-aware projection in `src/operational-model.js`: clients never receive supplier price, commission, or supplier milestone amounts. `backfillOperationalModel()` is the load-time migration and must remain idempotent.

## Client account type (branding)

Client users have explicit `accountType`: `"individual"` | `"business"` | `"organization"`. Signup accepts the human label `"personal"` as an alias for stored `"individual"`. Returned via `publicUser` on signup/login, `/auth/me`, and user directory. **Never infer from `orgName`.**

- Missing/legacy clients backfill to `"individual"` (safe default; business is opt-in)
- Self-signup is the write path; business/organization require `orgName`
- Non-client roles: field absent (not null)
- Demo: `client@gridgo.local` = business; `individual@gridgo.local` = individual

## Product category taxonomy

The captain's category chart (4 categories, 17 subcategories) is the product taxonomy. **Exact contract: `docs/TAXONOMY_API.md`** — mobile workers build against that file.

- One rule: every category reference is the category `code`, held on the *referring* record (`subcategory.categoryCode`, `material.categoryCodes[]`, `finish.categoryCodes[]`). Categories never list their children; nothing is nested in the store.
- `GET /taxonomy` also returns `categoryTree`, derived per request from the flat collections and never persisted. Never write it back.
- Pre-chart codes (`large_format`, `offset`, `apparel_sublimation`, `signage`) are retired into `taxonomy.categoryAliases`, not deleted; they still resolve on input. `supplierServices[].categoryCode` keeps whatever it was stored with — resolve through aliases, never rewrite captain-owned service records.
- Definitions, mapping table and `backfillTaxonomy()` all live in `src/taxonomy.js`; `seed.js` and the server share it so a seeded store and a backfilled store match.

## Platform data (ops / super / matching)

- `GET /taxonomy` — categories, subcategories, aliases, materials, finishes (super manages via POST/PATCH)
- `GET|POST|PATCH /supplier-services…` — supplier catalogue; states `draft|pending_verification|live|suspended|withdrawn`
- `GET /orders/:id/eligible-suppliers` — ops matching support (no auto-assign)
- `GET /users?role=` — publicUser only (never passwords)
- `PATCH /users/:id/role` — super_admin; audited
- `POST /users/:id/verification` — ops/super for supplier/rider
- `GET|POST|PATCH /zones` — legacy address-zone records; v2 fees come from global distance bands in `/settings`
- `POST /credits/grant` — super_admin Pilot Credits grant
- `GET|POST /claims…` + hold/release — payout holds; blocks `payout_released` while held
- `POST /orders/:id/issues` — client report in `issue_window_open` → auto claim hold
- `GET /audit` — platform audit log (separate from per-order `timeline`)

**Audit vs timeline:** `order.timeline` is per-order lifecycle; `auditLog` is platform-wide for ops/super (roles, grants, taxonomy, verification, claims).

## Seed, backfill & fixture convergence

Fresh-store fixture definitions live in `src/seed.js`; demo user identities live in `src/demo-fixtures.js` (shared by seed + server). Treat reset as destructive and use load-time migration for existing stores.

**Two different load-time migrations — do not conflate them:**

| | Backfill | Fixture convergence |
|---|---|---|
| Purpose | Fill *missing* fields/collections so old stores keep working | Bring *seed demo accounts* up to their defined state |
| Scope | geography, platform arrays, top-level `files`, parent file-ID arrays, missing client `accountType` → `"individual"`, taxonomy → captain's category chart, and v2 order/settings migration via `backfillOperationalModel()` | only users allowlisted in `DEMO_USERS` (`src/demo-fixtures.js`) |
| Overwrite? | Fill-missing except documented v2 retirement normalization for COD, supplier-proof states, and removal of obsolete zone fees; never overwrite existing valid values/coords | Yes — only on fixture users (e.g. `client@` → `accountType: "business"`) |
| Creates? | empty platform collections if absent | missing demo accounts (e.g. `individual@gridgo.local`) |
| Never touches | existing valid values, coords, file metadata, or legacy `artworkName` | orders, credits, proofs, claims, issues, sessions, pings, non-fixture users |

**Fixture boundary:** match by exact fixture email, else stable seed id — never by role or bare `@gridgo.local` domain. Getting this wrong is how a migration eats captain work.

**Existing live stores:** both run idempotently on every `load()`. Never reset a live/demo store to acquire new fields; reset wipes captain demo orders.

Fresh seed consistency is regression-tested in `tests/seed-consistency.test.js`; keep supplier-authored prices round and derive all order money and delivery bands through `src/operational-model.js`.

## Running your own instance

The captain's demo API owns port **8787** and its store at `data/store.json`. To try anything against real data, copy the store and run your own instance with `STORE_PATH=<copy> PORT=<free high port> node src/server.js` — several lanes run this repo at once, so pick a port only after checking it is free.

**Stop it by the exact PID you captured at start.** Never `pkill -f`/`killall` on `src/server.js`: the pattern matches the captain's demo and every other lane's instance too.

## Constraints

- Plain `node:http` only except the `minio` S3 SDK, approved for streamed object storage and presigned SigV4 URLs so signing is never hand-rolled; add no other direct npm dependencies
- Do not change unrelated QA edges/role rules; payment, POF milestones, checklist, delivery, and issue expiry follow `docs/OPERATIONAL_MODEL_V2_API.md`
- Authorisation on every route; `{ error: "snake_case" }`

## Object storage and fulfilment evidence

- The authoritative mobile contract is `docs/STORAGE_API.md`; the API streams uploads and authorizes short-lived presigned MinIO GETs. `MINIO_ENDPOINT` and fixed `MINIO_PUBLIC_URL` are separate.
- New milestone POF uses purpose `fulfilment_proof`; supplier-proof approval states and new `proof` uploads are retired. Legacy `proofFileIds` remain readable evidence.
- Files use `pending_upload|ready|delete_pending|deleted`; top-level metadata owns the private `objectKey`, while orders/services reference opaque `fileId` values only. Legacy `order.artworkName` stays valid and is never file identity.

## Maintaining this file

Record only durable project knowledge useful to almost every future session. Prefer pointers to authoritative files over copying detail. Keep entries short.
