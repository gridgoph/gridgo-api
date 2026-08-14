# gridgo-api

**Local demo backend for every GRIDGO app** (client, supplier, rider, ops, super admin).

Operational model v2 is implemented. The rebuild contract for every app is [`docs/OPERATIONAL_MODEL_V2_API.md`](docs/OPERATIONAL_MODEL_V2_API.md); it supersedes older order/payment prose below wherever they differ.

Temporary and replaceable. Domain records use the JSON store; private files use local MinIO. Authentication defaults to the existing JSON sessions and has an opt-in Clerk transition mode; there is no Supabase or PayMongo. Swap later by keeping the same route contracts and pointing the apps at a real backend.

For the real-domain, single-host pilot at `gridgo-api.talasora.com`, follow the complete [hosted pilot deployment and recovery runbook](docs/DEPLOYMENT.md). Production mode requires deployment-owned account credentials, creates no scenario transactions, enforces an exact CORS allowlist, and requires HTTPS signed-download URLs.

## Quick start

```bash
npm install
cp .env.example .env
docker compose up -d --wait
set -a; source .env; set +a
npm run dev   # http://127.0.0.1:8787
```

Health: `GET /health` — `ok`, `version`, storage status, push status, plus `commit`/`builtAt` (both `"unknown"` outside a built image; the hosted pipeline uses them to prove a deploy took).

Phone push is off unless `GRIDGO_FCM_SERVICE_ACCOUNT_FILE` points at a Firebase service-account JSON; `/health` then reports `push.status: "disabled"` and notifications are delivered in-app and over SSE only. Contract: `docs/OPERATIONAL_MODEL_V2_API.md` → *Push notifications*; operator install and rotation: `docs/DEPLOYMENT.md` §2a.

Hosted pilot deployment — image, compose file, pipeline, secrets, backup/restore: `docs/DEPLOYMENT.md`.

MinIO API: `http://127.0.0.1:9000`; console: `http://127.0.0.1:9001`. Both bind only to host loopback by default. The one-shot `minio-init` service idempotently creates the private `gridgo-uploads` bucket and a bucket-scoped API user; the API never uses MinIO root credentials.

**Security boundary:** Docker-published ports bypass host `ufw` rules. Never use a bare port mapping or `0.0.0.0`, and never publish this datastore to the internet. Compose accepts only one explicit IPv4 bind address and rejects wildcard/IPv6 forms before starting MinIO. Change the generated development credentials in `.env` before use. The safe default is loopback. Physical-phone testing requires an explicit LAN-only opt-in: bind only to the machine's exact trusted-LAN IPv4 with `MINIO_BIND_ADDRESS`, and set `MINIO_PUBLIC_URL` to that same origin. The console remains loopback-only. See `docs/STORAGE_API.md` for the exact setup and why signed URLs cannot be rewritten.

Stop MinIO without deleting uploaded files:

```bash
docker compose down
```

The named `gridgo_minio_data` volume survives `docker compose down` and restarts. Do not add `--volumes` unless intentionally discarding local uploads.

If MinIO is stopped, the API still starts and serves every non-file route, and `GET /files/:id` can still return authorized JSON metadata. Storage-dependent file operations return `503 minio_unavailable` with the recovery command; during the brief boot recovery gate they return `503 storage_initializing`. See [the exact mobile storage contract](docs/STORAGE_API.md).

## Local development demo accounts

Official Development Client / Supplier / Rider people are the Clerk Development trio. Do not log in as `client@` / `individual@` / `supplier@` / `rider@` `@gridgo.ph` for those roles.

| Email | Password | Role | Notes |
|---|---|---|---|
| `felyciaaa0220@gmail.com` | `Ilovegridgo-0990` | client | Fely Cia — Clerk Development; `accountType: "individual"` |
| `markdavidprado@gmail.com` | `Ilovegridgo-0990` | supplier | Mark David Prado — approved; PrintRight shop pin |
| `mddprado00290@usep.edu.ph` | `Ilovegridgo-0990` | rider | Mark David Prado — approved |
| `ops@gridgo.ph` | `Ilovegridgo-0990` | ops_admin | remaining platform fixture while hosted `AUTH_MODE` is `legacy` |
| `admin@gridgo.ph` | `Ilovegridgo-0990` | super_admin | remaining platform fixture while hosted `AUTH_MODE` is `legacy` |

Login: `POST /auth/login` `{ "email", "password" }` → `{ token, user }`

Send `Authorization: Bearer <token>` on subsequent requests.

### Authentication modes

`AUTH_MODE` controls which bearer-token families the API accepts:

| Value | Accepted bearer tokens | Intended use |
|---|---|---|
| `legacy` (default) | existing JSON-store sessions | current apps and hosted `talasora` pilot |
| `dual` | JSON sessions whose tokens start with `tok_`, plus verified Clerk session JWTs | local transition and per-surface cutover |
| `clerk` | verified Clerk session JWTs only | later completed cutover |

`dual` and `clerk` refuse to start unless all of `CLERK_SECRET_KEY`, `CLERK_ISSUER`, and `CLERK_AUTHORIZED_PARTIES` are set. The issuer is the exact Clerk instance HTTPS origin; authorized parties is a comma-separated allowlist matched against the JWT `azp` claim. `CLERK_JWT_KEY` is optional for networkless verification; without it, the official `@clerk/backend` verifier retrieves the instance JWKS using the secret key.

For local Development-instance work, link and pull keys into the ignored `.env.local`, add the non-secret mode/issuer/authorized-party settings, and explicitly load that file:

```bash
clerk link --app app_3HtBS4XpDN7ArrSaajuXWBMBDpH
clerk env pull --instance dev --file .env.local
node --env-file=.env.local src/server.js
```

Never commit `.env.local` or print `CLERK_SECRET_KEY`. Ordinary authenticated routes resolve a Clerk JWT only through the additive internal `User.clerkUserId` field — there is no email fallback on `/auth/me` or other bearer routes. After Clerk verifies signature, time claims, and `azp`, the API also requires the exact configured issuer and requires session claim `gridgo_role` to equal the local `User.role`. An unmapped identity is `401`; a missing, invalid, or mismatched role is `403`. `clerkUserId` is not exposed by `publicUser`.

A first-time Google / public SSO client has no `clerkUserId` and usually no `gridgo_role` yet. In `dual` or `clerk`, the app calls `POST /auth/clerk/activate` once with the Clerk session JWT. That route loads the Clerk user via the Backend API and may only activate `role=client`: it links `clerkUserId` when exactly one existing client shares that email and has no link, or it creates a client profile. Supplier, rider, and operations emails are refused (`403 invitation_required`). It then writes Clerk `publicMetadata.gridgoRole=client` so later session tokens carry `gridgo_role`. `/auth/me` stays fail-closed until that link exists and the caller presents a fresh token with a matching role claim. The hosted `talasora` pilot stays `AUTH_MODE=legacy`, so this route is `404` there.

Only clients may use public signup while `AUTH_MODE` is `dual` or `clerk`. Supplier and rider signup returns `403 invitation_required`; those roles are invitation-assigned. Legacy mode retains the existing demo signup behavior, and no signup route writes Clerk metadata.

### Client `accountType` (branding)

Client users expose an explicit, authoritative `accountType` on every public user payload (`/auth/login`, `/auth/me`, `GET /users…`):

| Value | App branding |
|---|---|
| `"individual"` | plain **GRIDGO** mark |
| `"business"` | **GRIDGO Business** lockup |
| `"organization"` | organization account (Business lockup unless an app specification overrides it) |

**Do not infer account type from `orgName`.** Apps must read `accountType` only. V2 signup requires `orgName` for business/organization accounts and accepts `personal` as an input alias for stored `individual`.

| Decision | Choice | Why |
|---|---|---|
| Missing type on legacy clients | resolves to `"individual"` | Business branding is opt-in; never leave the field undefined for consumers |
| Mutability this pilot | self-signup only | No profile-edit endpoint yet; never reset a live/demo store |
| Non-client roles | field **absent** | Same pattern as `orgName` / `shop` — suppliers and riders have no client account type |

Idempotent backfill on `load()` sets missing client `accountType` to `"individual"` without wiping other data.

**Demo fixture convergence (separate from backfill):** on every local-development `load()`, advertised accounts in `DEMO_USERS` (the Clerk Development trio plus `ops@` / `admin@`) are created if missing, and the unadvertised hosted six stay on their own ids so scenario orders are not attached to Fely / Mark. Official Clerk rows are new fixture ids (`user_fely_client`, `user_test_supplier`, `user_test_rider`); if another user already holds that email, convergence skips rather than overwriting. The retired shipped password is rotated to `Ilovegridgo-0990`; a password that has already diverged is preserved. In production, only the six `@gridgo.ph` identities are fixtures and each has a deployment-configured password — Gmail/USEP addresses are never `GRIDGO_*_PASSWORD` people. Convergence never rewrites an existing user's `email` — see the domain migration below. Captain-created users and all non-user collections (orders, credits, …) are never touched.

**These six identities used to live on `@gridgo.local`.** `.local` is reserved for multicast DNS and could never address a hosted API, so they moved to the captain's real domain. A store seeded before the move is renamed in place on `load()` by `migrateFixtureEmailDomain()`, keyed to the exact retired address in `RETIRED_FIXTURE_EMAILS` — never a `.local`-wide rule. Renaming preserves everything the account owned, because only login reads `email`; orders, sessions, credits, claims, issues, notifications and device push registrations all reference `user.id`. An account holding a fixture *id* under a diverged address is left alone, and a store where both the old and new address exist makes startup refuse rather than merge two accounts onto one login. Full operator detail: [deployment data boundary](docs/DEPLOYMENT.md#the-pilot-logins-moved-to-gridgoph--no-operator-step-no-reseed).

`Ilovegridgo-0990` is a repository-visible local-development credential, not a secret. Do not reuse it for any hosted account or environment. The hosted `talasora` pilot stays `AUTH_MODE=legacy` and keeps the six `@gridgo.ph` identities with distinct deployment-configured passwords; see [deployment environment](docs/DEPLOYMENT.md#2-required-environment). Those addresses are not the local Client / Supplier / Rider logins.

## Mobile apps

```bash
EXPO_PUBLIC_API_URL=http://127.0.0.1:8787 npm start
```

On a physical phone, use your machine's LAN IP (e.g. `http://192.168.1.10:8787`).

## Design principles

- **One API for all roles** — role from the session, not from which app calls it
- **Money in PHP minor units** (centavos as integers)
- **Pilot payments only** — 75% QR downpayment + 25% QR balance, both manually confirmed by Operations; no COD/provider webhook
- **Order state machine** matches the PRD (simplified transitions for demo)
- **Platform-governed service taxonomy** — suppliers select codes; Super Admin owns codes
- **Replaceable** — apps should only talk through `lib/api.ts`; swapping providers means a new server that honors the same routes

## Main routes

### Auth & session

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | issue token |
| POST | `/auth/signup` | public | client self-signup in dual/Clerk; legacy demo also accepts supplier/rider |
| POST | `/auth/clerk/activate` | Clerk JWT (dual/clerk) | link or create a client profile after Google / public SSO |
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
| POST | `/credits/authorize` | any auth | retired (`410 payment_route_retired`) |
| POST | `/credits/grant` | super_admin | grant Pilot Credits (not a purchase) |
| GET | `/dispatch/offers` | rider / ops / super | open delivery offers |
| POST | `/dispatch/:id/accept` | rider | accept job |
| POST | `/dispatch/:id/location` | assigned rider | location ping (while in transit) |
| GET | `/dispatch/:id/location` | rider / client / supplier / ops | latest ping or `{ ping: null }` |
| POST | `/dispatch/:id/pickup-checklist` | assigned approved rider | six checks; pass or evidence-backed escalation |
| POST | `/dispatch/:id/delivery` | assigned rider | attached photo/signature evidence; confirmed digital balance required |
| POST | `/dispatch/:id/proof` | any auth | retired (`410 dispatch_proof_route_retired`) |
| GET | `/jobs` | supplier | assigned jobs alias |
| GET/PATCH/DELETE | `/notifications…` | owner | list, SSE stream/resume, read/unread, snapshot mark-all, persistent delete |
| GET/POST | `/devices` | owner; POST also anonymous | list caller's push registrations; register this phone's FCM token, or unclaimed with no bearer token |
| POST | `/devices/unregister` | owner; anonymous for unclaimed | stop push to one of the caller's own phones |
| POST | `/announcements` | ops / super | one general message to an audience; `everyone` also reaches phones that never signed in |

### Service taxonomy (platform-governed)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/taxonomy` | any auth | categories, subcategories, aliases, materials, finishes + derived `categoryTree` |
| POST | `/taxonomy/categories` | super_admin | add category |
| PATCH | `/taxonomy/categories/:id` | super_admin | update category (id or code) |
| POST | `/taxonomy/subcategories` | super_admin | add subcategory |
| PATCH | `/taxonomy/subcategories/:id` | super_admin | update subcategory (id or code) |
| POST | `/taxonomy/materials` | super_admin | add material code |
| PATCH | `/taxonomy/materials/:id` | super_admin | update material |
| POST | `/taxonomy/finishes` | super_admin | add finish code |
| PATCH | `/taxonomy/finishes/:id` | super_admin | update finish |

The product category tree is the captain's chart: four categories, seventeen subcategories, each category with a `bestFor` audience line and each subcategory with an `examples` list. One `GET /taxonomy` renders a whole picker. Subcategories are a flat collection referencing their parent by `categoryCode`; `categoryTree` is derived per request and never stored. The pre-chart codes (`large_format`, `offset`, `apparel_sublimation`, `signage`) are retired into `categoryAliases` and still resolve on input. **Exact field shapes: `docs/TAXONOMY_API.md`.**

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

### Zones and v2 delivery fees

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/zones` | any auth | legacy address-zone records (no pricing) |
| POST | `/zones` | super_admin | create zone |
| PATCH | `/zones/:id` | super_admin | update zone (id or code) |

Orders keep `zone` as a compatibility/address string. V2 ignores client/zone flat fees: supplier acceptance derives distance from `pickup` to `dropoff` and snapshots the configured band from `GET|PATCH /settings`.

### Claims & payout holds

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/claims` | ops / super | list; `?orderId=` `?status=` |
| GET | `/claims/:id` | ops / super | detail |
| POST | `/claims` | ops / super | raise claim (`orderId`, `reason`); holds payout by default |
| POST | `/claims/:id/hold` | ops / super | hold payout (`reason` required) |
| POST | `/claims/:id/release` | ops / super | release hold (`reason` required) |

`completed` → `payout_released` returns `409 { error: "payout_held" }` while an active hold exists.

### Issue reports (global configurable window)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/issues` | client (own) / supplier (own orders) / ops / super | list; filters `?orderId=` `?status=` |
| GET | `/issues/:id` | role-scoped | detail |
| POST | `/orders/:id/issues` | client | report material issue while `issue_window_open` |
| POST | `/issues/:id/resolve` | ops / super | resolve/dismiss; optional `releasePayout` |

Client report auto-creates a `payout_held` claim. Without a hold, the order automatically completes when `issueWindowExpiresAt` elapses.

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

With `NODE_ENV=production`, the same seeder writes only configured pilot identities plus the platform request catalog, taxonomy, settings, and Davao zones. Operational collections start empty. Never initialize a hosted pilot from the local rich store; use [the production initialization procedure](docs/DEPLOYMENT.md#4-initialize-the-real-store).

Production startup also refuses a store containing known local scenario records before running backfill or fixture convergence. It reports how to seed a fresh path and leaves the rejected file untouched.

## Existing stores (no reset)

`data/store.json` is gitignored. On every `load()`:

1. **Fixture email domain migration** renames the six shipped pilot identities off the retired `@gridgo.local` addresses onto `@gridgo.ph`, in place, keeping the `user.id` every other record points at. It runs first so later passes read current addresses. Exact-address match only; refuses on collision.
2. **Backfill** migrates taxonomy/geography/files/platform structures and runs `backfillOperationalModel()` for v2 settings, order money, digital installments, milestones, checklist, retired-state/COD normalization, and issue-window expiry **without** wiping captain demo orders.
3. **Fixture convergence** ensures seed demo accounts from `src/demo-fixtures.js` exist and match their defined identity fields (locally: create the official Clerk trio if missing; do not rename `user_client` onto a Gmail address).

Fixture convergence only mutates allowlisted demo users; orders, credits, proofs, claims, issues, sessions, and location pings stay byte-stable.

## Replace later

| Demo today | Production later |
|---|---|
| JSON sessions plus opt-in Clerk verification | Clerk-only session + role claim after cutover |
| `data/store.json` | Supabase Postgres + RLS |
| MinIO + API-controlled streamed uploads + short-lived signed GETs | Managed object storage honoring `docs/STORAGE_API.md` |
| In-process transitions | Edge Functions + idempotency keys |
| Manually confirmed QR installments | Provider adapter/webhook using the same installment records |

Keep route shapes stable so mobile apps do not need a rewrite when you swap.

## Android emulator API URL

From the **Android emulator**, `127.0.0.1` is the emulator itself. Use:

```bash
EXPO_PUBLIC_API_URL=http://10.0.2.2:8787 npm start
```

Physical device / Expo Go on phone: use the host LAN IP (e.g. `http://192.168.1.55:8787`).
