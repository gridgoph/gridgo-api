# gridgo-api

**Local demo backend for every GRIDGO app** (client, supplier, rider, ops, super admin).

Temporary and replaceable. No Clerk, Supabase, PayMongo, or cloud accounts. Domain records use the JSON store; private files use local MinIO. Swap later by keeping the same route contracts and pointing the apps at a real backend.

## Quick start

```bash
npm install
cp .env.example .env
docker compose up -d --wait
set -a; source .env; set +a
npm run dev   # http://127.0.0.1:8787
```

Health: `GET /health`

MinIO API: `http://127.0.0.1:9000`; console: `http://127.0.0.1:9001`. Both bind only to host loopback by default. The one-shot `minio-init` service idempotently creates the private `gridgo-uploads` bucket and a bucket-scoped API user; the API never uses MinIO root credentials.

**Security boundary:** Docker-published ports bypass host `ufw` rules. Never use a bare port mapping or `0.0.0.0`, and never publish this datastore to the internet. Compose accepts only one explicit IPv4 bind address and rejects wildcard/IPv6 forms before starting MinIO. Change the generated development credentials in `.env` before use. The safe default is loopback. Physical-phone testing requires an explicit LAN-only opt-in: bind only to the machine's exact trusted-LAN IPv4 with `MINIO_BIND_ADDRESS`, and set `MINIO_PUBLIC_URL` to that same origin. The console remains loopback-only. See `docs/STORAGE_API.md` for the exact setup and why signed URLs cannot be rewritten.

Stop MinIO without deleting uploaded files:

```bash
docker compose down
```

The named `gridgo_minio_data` volume survives `docker compose down` and restarts. Do not add `--volumes` unless intentionally discarding local uploads.

If MinIO is stopped, the API still starts and serves every non-file route, and `GET /files/:id` can still return authorized JSON metadata. Storage-dependent file operations return `503 minio_unavailable` with the recovery command; during the brief boot recovery gate they return `503 storage_initializing`. See [the exact mobile storage contract](docs/STORAGE_API.md).

## Demo accounts

| Email | Password | Role | Notes |
|---|---|---|---|
| `client@gridgo.local` | `demo` | client | **business** — GRIDGO Business lockup (`accountType: "business"`, orgName set) |
| `individual@gridgo.local` | `demo` | client | **individual** — plain GRIDGO lockup (`accountType: "individual"`) |
| `supplier@gridgo.local` | `demo` | supplier | verification: approved |
| `rider@gridgo.local` | `demo` | rider | verification: approved |
| `ops@gridgo.local` | `demo` | ops_admin | |
| `admin@gridgo.local` | `demo` | super_admin | |

Login: `POST /auth/login` `{ "email", "password" }` → `{ token, user }`

Send `Authorization: Bearer <token>` on subsequent requests.

### Client `accountType` (branding)

Client users expose an explicit, authoritative `accountType` on every public user payload (`/auth/login`, `/auth/me`, `GET /users…`):

| Value | App branding |
|---|---|
| `"individual"` | plain **GRIDGO** mark |
| `"business"` | **GRIDGO Business** lockup |

**Do not infer business-ness from `orgName`.** An individual may set an organisation label; a business may leave it blank. Apps must read `accountType` only.

| Decision | Choice | Why |
|---|---|---|
| Missing type on legacy clients | resolves to `"individual"` | Business branding is opt-in; never leave the field undefined for consumers |
| Mutability this pilot | **seed / store only** (no write API) | Demo accounts are fixed; avoids a half-finished admin surface. Change fixture definitions for future fresh stores; never reset a live/demo store |
| Non-client roles | field **absent** | Same pattern as `orgName` / `shop` — suppliers and riders have no client account type |

Idempotent backfill on `load()` sets missing client `accountType` to `"individual"` without wiping other data.

**Demo fixture convergence (separate from backfill):** on every `load()`, seed demo accounts (`*@gridgo.local` listed in `src/demo-fixtures.js`) are created if missing and their fixture fields (including `client@` → `accountType: "business"`) are brought up to the seed definition. Captain-created users and all non-user collections (orders, credits, …) are never touched. Password for every demo account remains `demo`.

## Mobile apps

```bash
EXPO_PUBLIC_API_URL=http://127.0.0.1:8787 npm start
```

On a physical phone, use your machine's LAN IP (e.g. `http://192.168.1.10:8787`).

## Design principles

- **One API for all roles** — role from the session, not from which app calls it
- **Money in PHP minor units** (centavos as integers)
- **Pilot payments only** — Pilot Credits + COD ≤ ₱1,500; no live PayMongo
- **Order state machine** matches the PRD (simplified transitions for demo)
- **Platform-governed service taxonomy** — suppliers select codes; Super Admin owns codes
- **Replaceable** — apps should only talk through `lib/api.ts`; swapping providers means a new server that honors the same routes

## Main routes

### Auth & session

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | issue token |
| GET | `/auth/me` | any | current user + role |
| POST | `/auth/logout` | any | revoke token |

### Catalog, orders, credits, dispatch (existing)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/catalog` | public | product catalog |
| GET | `/orders` | role-scoped | list orders/jobs |
| GET | `/orders/:id` | role-scoped | order detail |
| POST | `/orders` | client | create draft/submit request |
| POST | `/orders/:id/transition` | role-gated | advance state |
| POST | `/files` | purpose role | stream one multipart upload into the private file registry |
| POST | `/files/:id/attach` | file owner + parent owner | revalidate and attach a ready `fileId` |
| GET | `/files/:id` | owner/parent-scoped | authorized file metadata |
| GET | `/files/:id/download-url` | owner/parent-scoped | short-lived MinIO presigned GET |
| DELETE | `/files/:id` | owner / ops, unreferenced only | durable two-phase deletion |
| GET | `/credits/balance` | client (own) / ops / super | pilot credit balance + ledger |
| POST | `/credits/authorize` | client | reserve/spend for order |
| POST | `/credits/grant` | super_admin | grant Pilot Credits (not a purchase) |
| GET | `/dispatch/offers` | rider / ops / super | open delivery offers |
| POST | `/dispatch/:id/accept` | rider | accept job |
| POST | `/dispatch/:id/location` | assigned rider | location ping (while in transit) |
| GET | `/dispatch/:id/location` | rider / client / supplier / ops | latest ping or `{ ping: null }` |
| POST | `/dispatch/:id/proof` | rider | pickup/delivery/COD proof |
| GET | `/jobs` | supplier | assigned jobs alias |
| GET | `/notifications` | any | in-app alerts |

### Service taxonomy (platform-governed)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/taxonomy` | any auth | categories, materials, finishes |
| POST | `/taxonomy/categories` | super_admin | add capability category |
| PATCH | `/taxonomy/categories/:id` | super_admin | update category (id or code) |
| POST | `/taxonomy/materials` | super_admin | add material code |
| PATCH | `/taxonomy/materials/:id` | super_admin | update material |
| POST | `/taxonomy/finishes` | super_admin | add finish code |
| PATCH | `/taxonomy/finishes/:id` | super_admin | update finish |

### Supplier services (catalogue)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/supplier-services` | supplier (own) / ops / super | list; ops may `?supplierId=` `?state=` |
| GET | `/supplier-services/:id` | owner supplier / ops / super | detail |
| POST | `/supplier-services` | supplier | create **draft** |
| PATCH | `/supplier-services/:id` | owner supplier | edit parameters; capability expansion on live → `pending_verification` |
| POST | `/supplier-services/:id/submit` | owner supplier | request verification (`pending_verification`) |
| POST | `/supplier-services/:id/verify` | ops / super | set `live` (supplier must be verification-approved) |
| POST | `/supplier-services/:id/suspend` | ops / super | suspend for quality risk (`reason` required) |
| POST | `/supplier-services/:id/withdraw` | owner supplier | withdraw from **new** matching only |

Lifecycle: `draft` → `pending_verification` → `live` | `suspended` | `withdrawn`. Withdrawal never cancels in-flight orders.

### Matching support

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/orders/:id/eligible-suppliers` | ops / super | explainable eligibility (no auto-assign) |

Returns candidates with `eligible`, `reasons`, `matchingServiceIds`, and ranking inputs. Assign still uses `POST /orders/:id/transition` `{ "state": "supplier_assigned", "supplierId" }` (optional `matchingServiceIds`).

### Users, roles, verification

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/users` | ops / super | directory; optional `?role=` |
| GET | `/users/:id` | ops / super | public user (never password) |
| PATCH | `/users/:id/role` | super_admin | change platform role (`reason` audited) |
| POST | `/users/:id/verification` | ops / super | set supplier/rider verification status |

Verification statuses: `unverified` | `pending` | `approved` | `suspended` | `rejected`. Suspending a supplier suspends their live services for new matching.

### Zones & fees

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/zones` | any auth | delivery zones + `deliveryFeeMinor` |
| POST | `/zones` | super_admin | create zone |
| PATCH | `/zones/:id` | super_admin | update zone (id or code) |

Orders still store `zone` (code string) and `deliveryFeeMinor` snapshot. New orders default fee from the zone record when body omits it.

### Claims & payout holds

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/claims` | ops / super | list; `?orderId=` `?status=` |
| GET | `/claims/:id` | ops / super | detail |
| POST | `/claims` | ops / super | raise claim (`orderId`, `reason`); holds payout by default |
| POST | `/claims/:id/hold` | ops / super | hold payout (`reason` required) |
| POST | `/claims/:id/release` | ops / super | release hold (`reason` required) |

`completed` → `payout_released` returns `409 { error: "payout_held" }` while an active hold exists.

### Issue reports (24h window)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/issues` | client (own) / supplier (own orders) / ops / super | list; filters `?orderId=` `?status=` |
| GET | `/issues/:id` | role-scoped | detail |
| POST | `/orders/:id/issues` | client | report material issue while `issue_window_open` |
| POST | `/issues/:id/resolve` | ops / super | resolve/dismiss; optional `releasePayout` |

Client report auto-creates a `payout_held` claim. Order stays in `issue_window_open` (state machine unchanged).

### Audit trail

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/audit` | ops / super | platform audit log; filters `entityType`, `entityId`, `orderId`, `actorId`, `action`, `limit` |

**Why separate from `order.timeline`:** per-order timeline is the lifecycle history every party sees on that order. `auditLog` is the platform-wide immutable record (role changes, credit grants, taxonomy, verification, claims, matching) that Operations and Super Admin need across entities.

## Money & geography

- All PHP values are **minor units** (centavos).
- Orders include map points: `pickup` (supplier shop or `null`) and `dropoff` (`{ lat, lng, label }`). Coords are Davao City; `address` / `zone` stay as text.

## Seed data highlights

`src/seed.js` defines the fresh-store fixtures: taxonomy, Davao zones, PrintRight live services, a credit grant ledger, issue/claim samples, and audit entries. The checked-out `data/store.json` may be live demo data; do not replace it just to pick up new fields.

## Existing stores (no reset)

`data/store.json` is gitignored. On every `load()`:

1. **Backfill** adds missing `taxonomy`, `zones`, `supplierServices`, `claims`, `issues`, `auditLog`, supplier `verificationStatus`, geography fields, the top-level `files` registry, parent file-ID arrays, and client `accountType` (default `"individual"` only when missing/invalid) **without** wiping captain demo orders.
2. **Fixture convergence** ensures seed demo accounts from `src/demo-fixtures.js` exist and match their defined identity fields (so a live store that predated `individual@gridgo.local` or still has `client@` as `individual` is fixed without `npm run reset`).

Fixture convergence only mutates allowlisted demo users; orders, credits, proofs, claims, issues, sessions, and location pings stay byte-stable.

## Replace later

| Demo today | Production later |
|---|---|
| Bearer token in JSON store | Clerk session + role claim |
| `data/store.json` | Supabase Postgres + RLS |
| MinIO + API-controlled streamed uploads + short-lived signed GETs | Managed object storage honoring `docs/STORAGE_API.md` |
| In-process transitions | Edge Functions + idempotency keys |
| Simulated COD/credits | Pilot credits ledger + PayMongo adapter |

Keep route shapes stable so mobile apps do not need a rewrite when you swap.

## Android emulator API URL

From the **Android emulator**, `127.0.0.1` is the emulator itself. Use:

```bash
EXPO_PUBLIC_API_URL=http://10.0.2.2:8787 npm start
```

Physical device / Expo Go on phone: use the host LAN IP (e.g. `http://192.168.1.55:8787`).
