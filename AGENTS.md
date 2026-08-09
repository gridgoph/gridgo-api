# gridgo-api

Local **custom** demo backend for all GRIDGO apps.

## MVP

- Custom auth (no Clerk)
- JSON store (no Supabase)
- Pilot Credits + COD only (no PayMongo)
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

## Client account type (branding)

Client users have explicit `accountType`: `"individual"` | `"business"`. Returned via `publicUser` on login, `/auth/me`, and user directory. **Never infer from `orgName`.**

- Missing/legacy clients backfill to `"individual"` (safe default; business is opt-in)
- Pilot: seed/store only — no write API for `accountType`
- Non-client roles: field absent (not null)
- Demo: `client@gridgo.local` = business; `individual@gridgo.local` = individual

## Platform data (ops / super / matching)

- `GET /taxonomy` — capability categories, materials, finishes (super manages via POST/PATCH)
- `GET|POST|PATCH /supplier-services…` — supplier catalogue; states `draft|pending_verification|live|suspended|withdrawn`
- `GET /orders/:id/eligible-suppliers` — ops matching support (no auto-assign)
- `GET /users?role=` — publicUser only (never passwords)
- `PATCH /users/:id/role` — super_admin; audited
- `POST /users/:id/verification` — ops/super for supplier/rider
- `GET|POST|PATCH /zones` — delivery fees by zone code
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
| Scope | geography, platform arrays, top-level `files`, parent file-ID arrays, missing client `accountType` → `"individual"` | only users allowlisted in `DEMO_USERS` (`src/demo-fixtures.js`) |
| Overwrite? | No — never overwrites existing valid values/coords | Yes — only on fixture users (e.g. `client@` → `accountType: "business"`) |
| Creates? | empty platform collections if absent | missing demo accounts (e.g. `individual@gridgo.local`) |
| Never touches | existing valid values, coords, file metadata, or legacy `artworkName` | orders, credits, proofs, claims, issues, sessions, pings, non-fixture users |

**Fixture boundary:** match by exact fixture email, else stable seed id — never by role or bare `@gridgo.local` domain. Getting this wrong is how a migration eats captain work.

**Existing live stores:** both run idempotently on every `load()`. Never reset a live/demo store to acquire new fields; reset wipes captain demo orders.

## Constraints

- Plain `node:http` only except the `minio` S3 SDK, approved for streamed object storage and presigned SigV4 URLs so signing is never hand-rolled; add no other direct npm dependencies
- Do not change unrelated order state edges/role rules; the proof path in `docs/STORAGE_API.md` replaces direct `supplier_accepted -> awaiting_payment` (payout hold remains a soft `409` guard only)
- Authorisation on every route; `{ error: "snake_case" }`

## Object storage and supplier proofs

- The authoritative mobile contract is `docs/STORAGE_API.md`; the API streams uploads and authorizes short-lived presigned MinIO GETs. `MINIO_ENDPOINT` and fixed `MINIO_PUBLIC_URL` are separate.
- Supplier proof states are `supplier_proof_review`, `supplier_proof_changes_requested`, and `supplier_proof_approved`; attaching a ready proof file enters/re-enters review.
- Files use `pending_upload|ready|delete_pending|deleted`; top-level metadata owns the private `objectKey`, while orders/services reference opaque `fileId` values only. Legacy `order.artworkName` stays valid and is never file identity.

## Maintaining this file

Record only durable project knowledge useful to almost every future session. Prefer pointers to authoritative files over copying detail. Keep entries short.
