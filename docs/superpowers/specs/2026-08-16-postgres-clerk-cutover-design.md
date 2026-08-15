# PostgreSQL and Clerk-Only Cutover Design

## Scope and decisions

GRIDGO will cut over from the JSON document store and local sessions in one release. There is no data migration: both Clerk environments, both object stores, and both JSON stores were deliberately emptied before this work. The release creates a clean PostgreSQL schema, seeds platform reference data only, and requires Clerk configuration at every startup.

Three persistence approaches were considered:

1. Rewrite every route around an ORM. This gives strongly modeled queries but turns the persistence cutover into a route rewrite and makes the 4,000-line compatibility surface difficult to review.
2. Store one JSON document in PostgreSQL. This is mechanically small but fails the integrity, indexing, and concurrent money-movement goals that motivated PostgreSQL.
3. Use `pg` directly behind a relational unit-of-work adapter. Identity, ownership, lifecycle state, money, and commonly filtered fields become typed columns with foreign keys and indexes. Complex API-owned documents such as timelines, pickup checklists, and small configuration arrays remain JSONB. The adapter materializes the existing route-facing object graph and writes only changed rows in one transaction.

The implementation uses option 3. It preserves route behavior while making the database boundary explicit and independently testable. It also avoids an ORM abstraction across a codebase whose routes currently operate on plain JavaScript records.

`node-pg-migrate` provides ordered, forward-only migrations checked into `migrations/`. It is mature, SQL-visible in review, works directly with `pg`, and does not require a generated model layer. Migrations are an operator/CI step and never run implicitly at API boot.

## Relational model

PostgreSQL 17 is the only domain store. Tables cover platform settings, users, catalog and taxonomy, zones, supplier services, orders, installments, payout milestones, file metadata and references, credit accounts and ledger entries, claims, issues, audit entries, notifications, rider location pings, escalations, proofs, and device registrations. Sessions do not exist.

Primary domain identifiers remain text because public route contracts already expose prefixed opaque IDs. User ownership and order/service relationships use foreign keys. Required states, timestamps, and query keys are `NOT NULL`; role/state/type columns use check constraints; Clerk user IDs, normalized email addresses, taxonomy codes, zone codes, and FCM tokens are unique where the domain requires it. Indexes cover role and verification filters, order participant/state queries, supplier-service matching, notification snapshots, claims/issues by order and status, pings by order/time, and file ownership/state.

Money is stored as signed `BIGINT` minor units (centavos). Route code continues to expose JavaScript numbers and the adapter rejects values outside JavaScript's safe-integer range. No money value is stored as floating point. Installments, payout milestones, credit balances, and ledger movements have their own relational rows so constraints and locking apply to each movement.

JSONB is reserved for bounded composite fields whose internal shape is returned and replaced as a unit: order timelines/checklists/evidence, supplier capability arrays, audit detail, settings bands, and equivalent presentation metadata. Identity, authorization, money, ownership, and fields used in SQL filters are never authoritative only inside JSONB.

## Transactions and concurrency

Every HTTP mutation executes inside one PostgreSQL transaction. The transaction obtains a transaction-scoped advisory lock before loading its object graph; this preserves the current mutation semantics across multiple API processes rather than only within one Node process. The repository captures a baseline and upserts/deletes only changed records. Order transitions, installment confirmations/rejections, payout milestone releases, credit grants, claims, issue-created holds, device ownership moves, and their audit/notification rows commit atomically.

File bytes continue to stream to MinIO. The database stores metadata and opaque references only. File upload and deletion keep their existing compensation pattern: short database transactions create or change durable metadata around the external object operation. Push and SSE publication run only after the database commit that created the notification, and push failure never rolls back the triggering transaction.

Database startup configuration requires `DATABASE_URL`. The API does not create tables or seed at boot. It checks connectivity and migration presence before listening. `/health` retains `commit` and `builtAt` and adds `database: { status }` alongside storage and push.

## Geography

The schema uses constrained `DOUBLE PRECISION` latitude/longitude columns and ordinary B-tree indexes on order/rider query keys. PostGIS is not enabled. Existing route patterns fetch an order's stored pickup/dropoff, calculate one distance in application code, or fetch the latest ping for one order; none performs radius, containment, nearest-neighbor, or large fleet spatial searches in SQL. PostGIS would add operational cost without serving an actual query. If matching later introduces database-side radius search, a forward migration can add geography columns and GiST indexes.

## Clerk identity and role authority

Clerk JWT verification is mandatory. `AUTH_MODE` is removed rather than retained with one valid value. Startup requires `CLERK_SECRET_KEY`, `CLERK_ISSUER`, and `CLERK_AUTHORIZED_PARTIES`; configuration errors name only missing variable names and never values. Optional `CLERK_JWT_KEY` and test-only `CLERK_API_URL` retain their current purposes.

GRIDGO roles are authoritative in PostgreSQL and are not accepted from JWT claims or Clerk client-settable metadata. A verified bearer resolves strictly by unique `users.clerk_user_id`; unmapped identities receive `401` from ordinary routes. `POST /auth/clerk/activate` remains the explicit just-in-time provisioning path for Google/public SSO: it loads the verified Clerk user through the Backend API and creates a `client` row only. It never accepts a requested role and never grants supplier, rider, operations, or administrator access. An existing super administrator promotes an activated identity through the existing audited role-management route. This preserves the mobile Google-sign-in activation response `{ user }` and removes the old need to refresh a token for a `gridgo_role` metadata claim.

`POST /auth/signup` and `POST /auth/login` are removed (they return the normal `404 not_found`), and no API response issues a token. `POST /auth/logout` remains only as an authenticated device-release endpoint; Clerk clients continue to terminate their Clerk session themselves. This response stays `{ ok, deviceUnregistered, deviceUnclaimed }`.

## First-administrator bootstrap

There is no HTTP bootstrap route. An operator first creates/signs into one Clerk identity, then runs `npm run bootstrap-admin -- --clerk-user-id user_...` in the deployment environment. The command requires the normal Clerk and database secrets, loads the identity from Clerk, and transactionally inserts it as `super_admin` only when no privileged GRIDGO user exists. It records an audit entry. Once an operations or super-admin row exists, every later invocation refuses. Because the code is a direct database administration command, not a remotely reachable route, and its one-time database precondition closes permanently, it is not a surviving authentication backdoor.

## Deployment, local development, and testing

Local and production compose add PostgreSQL 17 with a named data volume and healthcheck. Production publishes no database port and attaches PostgreSQL only to the internal `gridgo-api-storage` network. The API and one-shot migration/seed services wait for database health. Local compose may bind PostgreSQL to an explicit loopback-only high port for host-run tools.

The seed command is idempotent and inserts only catalog, taxonomy, zones, and settings. It creates no users, supplier services, orders, files, payments, credits, claims, issues, notifications, pings, or device rows.

Node behavioral tests connect to a real PostgreSQL service, run migrations, isolate cases with database resets, and sign test Clerk JWTs using an injected public key. They cover the order lifecycle, manual installment confirmation and payout movement, unauthenticated rejection, wrong-role rejection, JIT client activation, and bootstrap refusal after the first administrator. GitHub Actions provisions PostgreSQL 17 for tests. Image smoke testing uses a named PostgreSQL volume, writes a marker through the database/API, replaces the API container while keeping the database volume, and proves the marker and file metadata remain. No production SSH or deploy action is executed during this task.

## Error handling and cutover

Database constraint conflicts are translated to stable snake-case API errors where callers can cause them; unexpected database failures return the existing generic `server_error` without SQL, credentials, or secret values. Startup refuses before listening when database or Clerk configuration is absent, migrations are missing, or the database cannot be reached.

The production cutover is destructive by prior authorization: Firstmate supplies a new `DATABASE_URL`, Clerk production values, and PostgreSQL password, starts PostgreSQL, runs forward migrations and the reference seed, bootstraps the first administrator, and only then replaces the API. There is no JSON import, compatibility mode, or fallback.
