# GRIDGO API

Custom backend for GRIDGO clients, suppliers, riders, Operations, and Super Admin. The API uses PostgreSQL 17 for all domain data, MinIO for private file bytes, Clerk for every authenticated request, and optional push delivery. Notification delivery and privacy rules are in [Realtime events](docs/REALTIME_EVENTS.md).

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

Apps obtain a Clerk session JWT (including Google sign-in) and send it as `Authorization: Bearer <Clerk session JWT>`. GRIDGO memberships and approval cases are authoritative in PostgreSQL, not in a client-settable Clerk claim or metadata value.

- `GET /auth/me` returns the mapped identity plus all database memberships and approval-case summaries. A verified Clerk subject with no GRIDGO user is `401 unmapped_identity`; an invalid token is `401 unauthorized`.
- Each app uses its fixed database projection: `/auth/me/client`, `/auth/me/supplier`, `/auth/me/rider`, `/auth/me/ops`, or `/auth/me/admin`. The URL selects the required membership; request JSON cannot select or grant one.
- `POST /auth/clerk/activate` is the explicit client-only Google/public SSO path. It creates a new personal client identity, or adds a personal client membership to an already-mapped identity, and returns `{ "user": ... }`; it never merges by email or grants another membership.
- Fixed supplier/rider enrollment routes add only the membership named by the URL; `/me/business-application` submits a case for an existing client membership. All three require `Idempotency-Key`; supplier/business submit immediately, while rider sign-in resumes document intake followed by explicit submission after a current licence is attached.
- Supplier/rider memberships come only from their fixed enrollment routes or the audited GRIDGO role route; Operations and administrator memberships are assignment-only. An activation request can never choose or inherit one of those memberships.
- `POST /auth/logout` releases the optional push device token to the anonymous app-update pool. The app terminates its Clerk session with Clerk; the API has no local session to revoke.

This preserves the existing Google activation response shape. Follow-up app/dashboard work must remove calls expecting `{token,user}` from API login/signup, use Clerk JWTs directly, and call authenticated `POST /devices` after sign-in to claim a phone.

## First administrator

After creating the first identity in the correct Clerk instance, run:

```bash
npm run bootstrap-admin -- --clerk-user-id user_...
```

The command loads the identity from Clerk and inserts/promotes it with a `super_admin` membership only while no Operations or Super Admin membership exists. It writes an audit record and an immutable database completion marker. Once completed, the command refuses even if memberships later change. This one-time CLI bootstrap is the only first-administrator path: there is no bootstrap HTTP route and no redeemable bootstrap token.

## Local start

Copy `.env.example` to `.env`, replace all template database and Clerk values, then run:

```bash
docker compose up --build
```

Compose interpolates that same `.env`. Host `npm run dev`, `npm start`, migrate, seed, and bootstrap-admin load it with Node `--env-file-if-exists=.env`, so a missing file in the production image is fine and Compose-injected variables still win. The API has no `.env.local`.

The MinIO and `mc` images are GRIDGO's own private GHCR packages ([why](docs/STORAGE_API.md#minio-images)), so run `docker login ghcr.io` once with a GitHub token that has `read:packages` and access to this repository.

Compose starts PostgreSQL 17, runs forward migrations, idempotently seeds reference data, initializes MinIO, and starts the API on `127.0.0.1:18787` by default. PostgreSQL is published only on loopback (`127.0.0.1:55439`) for local tools.

For host-run commands against local compose (optional `DATABASE_URL` export overrides `.env`):

```bash
npm run migrate
npm run seed
npm run seed:dev
npm run dev
```

Create a separate test database once, then migrate and test only that database.
The tests intentionally truncate their target between cases and must never use
the development database served by the local API:

```bash
docker compose exec postgres createdb -U gridgo gridgo_test
DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test npm run migrate
DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test npm test
```

`npm run seed` creates only catalog, taxonomy, zones, file-format registry, listing starters, and global operational settings. It never creates users or operational records and has no destructive reset mode.

Local compose and `npm run seed:dev` seed three approved Davao fixture shops from existing development Clerk users. **Lovis Printshop** remains fixed to `felyciaaa0220@gmail.com`; two other real Clerk email identities receive local-only Davao Quickprint and Matina Creative Hub fixtures. All three publish Flyers plus another listing for matching and same-shop bundling. Production `deploy/docker-compose.yml` still runs `npm run seed` only.

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
  "emailConfigured": false,
  "at": "<current server time>"
}
```

Missing Clerk or database configuration refuses startup with the variable name only. Push remains optional; storage can degrade independently after startup.

## Main route groups

All routes except `/health`, `/catalog`, public support-ticket and issue-report submit, and the documented anonymous device registration calls require a verified Clerk bearer. The support desk (ticket list/reply/delete, `/issue-reports` read/mark) additionally requires the Clerk account's verified primary email to be on `SUPPORT_DESK_ALLOWED_EMAILS`. `POST /admin/login` is retired (`404`).

- Identity: `/auth/me`, fixed `/auth/me/*` role projections, fixed enrollment/reapply routes, `/auth/clerk/activate`, `/auth/logout`
- Reference/platform: `/catalog`, `/taxonomy`, `/settings`, `/zones`, `/users`, `/approval-cases`, `/audit`
- Supplier matching: `/supplier-services`, `/orders/:id/eligible-suppliers`
- Supplier payout account: `/me/payout-account` (where a shop wants to be paid, with its receiving-QR file) and the Operations read `/users/:id/payout-account`
- Orders/money: `/orders`, transitions, manual QR installments, payout milestones, credits, claims, issues
- Client matching/cart: `/me/preferences`, `/me/addresses`, `/me/matches`, `/me/carts`, checkout, and invoice; see [Client order match API](docs/ORDER_MATCH_API.md)
- Dispatch: `/dispatch/offers`, pickup checks, delivery, rider location
- Files: `/files` metadata/control plane with private MinIO bytes
- Notifications: `/notifications`, SSE stream, `/devices`, `/announcements`
- Public support tickets: `POST /support-tickets` and `POST /api/support-tickets`; Clerk desk `GET /admin/me` (returns `{ email }`), list/get/reply/delete under `/support-tickets` and the same paths under `/api`

See the authoritative contract documents for exact methods, roles, bodies, states, and error codes.
