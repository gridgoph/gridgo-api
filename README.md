# GRIDGO API

Custom backend for GRIDGO clients, suppliers, riders, Operations, and Super Admin. The API uses PostgreSQL 17 for all domain data, MinIO for private file bytes, Clerk for every authenticated request, and Firebase Cloud Messaging as an optional notification delivery leg.

The authoritative mobile contracts are [Operational Model v2](docs/OPERATIONAL_MODEL_V2_API.md), [Storage API](docs/STORAGE_API.md), and [Taxonomy API](docs/TAXONOMY_API.md). Production setup, cutover, backup, and recovery are in [Deployment](docs/DEPLOYMENT.md).

## Architecture decisions

- Money is PostgreSQL `BIGINT` integer minor units (centavos). The HTTP API exposes safe JavaScript integers; no money is stored as floating point.
- Geography uses constrained `DOUBLE PRECISION` latitude/longitude columns. Current queries fetch an order point or the latest ping for one order; they do not perform SQL radius/nearest-neighbor searches, so PostGIS would add cost without serving an actual query.
- `pg` is used directly behind `src/postgres-store.js`. Identity, relationships, lifecycle state, money, and filtered fields are relational columns with constraints/indexes. JSONB is limited to bounded composites such as timelines and pickup checklists.
- `node-pg-migrate` owns ordered forward migrations in `migrations/`. The API never creates schema at boot.
- Every mutation runs in one database transaction with a transaction-scoped advisory lock. Order/payment/payout/credit/claim/issue changes and their audit/notification rows commit atomically across API processes; read graphs use repeatable-read snapshots.
- Object bytes stay in MinIO. PostgreSQL contains only file metadata and opaque references.

## Clerk-only identity

There is no `AUTH_MODE`, password login, local signup, local session table, demo password, or demo user seed. `POST /auth/login` and `POST /auth/signup` return `404 not_found`; the API never issues an access token.

Apps obtain a Clerk session JWT (including Google sign-in) and send it as `Authorization: Bearer <Clerk session JWT>`. GRIDGO roles are authoritative in PostgreSQL, not in a client-settable Clerk claim.

- `GET /auth/me` resolves an already-mapped Clerk subject or returns `401 unauthorized`.
- `POST /auth/clerk/activate` is the explicit first-use Google/public SSO path. It creates a `client` only and returns `{ "user": ... }`; it never merges by email.
- Supplier, rider, Operations, and administrator roles are assigned through the audited GRIDGO role route after activation. An activation request can never choose or inherit one of those roles.
- `POST /auth/logout` releases the optional FCM device token to the anonymous app-update pool. The app terminates its Clerk session with Clerk; the API has no local session to revoke.

This preserves the existing Google activation response shape. Follow-up app/dashboard work must remove calls expecting `{token,user}` from API login/signup, use Clerk JWTs directly, and call authenticated `POST /devices` after sign-in to claim a phone.

## First administrator

After creating the first identity in the correct Clerk instance, run:

```bash
npm run bootstrap-admin -- --clerk-user-id user_...
```

The command loads the identity from Clerk and inserts/promotes it as `super_admin` only while no Operations or Super Admin row exists. It writes an audit record and an immutable database completion marker. Once completed, the command refuses even if roles later change. There is no bootstrap HTTP route.

## Local start

Copy `.env.example` to `.env`, replace all template database and Clerk values, then run:

```bash
docker compose up --build
```

Compose starts PostgreSQL 17, runs forward migrations, idempotently seeds reference data, initializes MinIO, and starts the API on `127.0.0.1:18787` by default. PostgreSQL is published only on loopback (`127.0.0.1:55439`) for local tools.

For host-run commands against local compose:

```bash
export DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo
npm run migrate
npm run seed
npm test
```

The seed creates only catalog, taxonomy, zones, and global operational settings. It never creates users or operational records and has no destructive reset mode.

## Health

`GET /health` is public and reports:

```json
{
  "ok": true,
  "service": "gridgo-api",
  "version": 3,
  "commit": "<image build SHA>",
  "builtAt": "<image build time>",
  "database": { "status": "available" },
  "storage": { "status": "available" },
  "push": { "status": "disabled" },
  "at": "<current server time>"
}
```

Missing Clerk or database configuration refuses startup with the variable name only. Push remains optional; storage can degrade independently after startup.

## Main route groups

All routes except `/health`, `/catalog`, and the documented anonymous device registration calls require a verified Clerk bearer.

- Identity: `/auth/me`, `/auth/clerk/activate`, `/auth/logout`
- Reference/platform: `/catalog`, `/taxonomy`, `/settings`, `/zones`, `/users`, `/audit`
- Supplier matching: `/supplier-services`, `/orders/:id/eligible-suppliers`
- Orders/money: `/orders`, transitions, manual QR installments, payout milestones, credits, claims, issues
- Dispatch: `/dispatch/offers`, pickup checks, delivery, rider location
- Files: `/files` metadata/control plane with private MinIO bytes
- Notifications: `/notifications`, SSE stream, `/devices`, `/announcements`

See the authoritative contract documents for exact methods, roles, bodies, states, and error codes.
