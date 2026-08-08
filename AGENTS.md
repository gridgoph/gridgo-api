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

## Seed & backfill

Seed via `npm run reset` (`src/seed.js` → `data/store.json`).

**Existing live stores:** `data/store.json` is gitignored. On every `load()`, idempotent backfill fills missing geography, platform collections (`taxonomy`, `zones`, `supplierServices`, `claims`, `issues`, `auditLog`, supplier `verificationStatus`), **and** client `accountType` (default `"individual"`) — it never overwrites existing coords/records and does not require `npm run reset` (which would wipe captain demo orders).

## Constraints

- No npm dependencies; plain `node:http` only
- Do not change order state machine edges/role rules (payout hold is a soft `409` guard only)
- Authorisation on every route; `{ error: "snake_case" }`

## Maintaining this file

Record only durable project knowledge useful to almost every future session. Prefer pointers to authoritative files over copying detail. Keep entries short.
