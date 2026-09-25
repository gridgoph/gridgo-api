# GRIDGO API production deployment

This runbook is authoritative for the PostgreSQL 17 and Clerk-only production service at `gridgo-api.talasora.com`. CI builds and smoke-tests the image on every ref, but publishes to `ghcr.io/gridgoph/gridgo-api` (immutable `sha-...` plus `latest`) and invokes the server's restricted `api` deploy command only after a default-branch merge; feature-branch builds never push an image. CI never writes compose or secret files to the server.

The PostgreSQL/Clerk cutover starts from the captain-authorized empty state. Do not restore `store.json`, write a JSON importer, recreate demo users, or copy development Clerk credentials into production.

## 1. Services and private networks

`deploy/docker-compose.yml` defines:

- `gridgo-api` on `gridgo-edge` and private `gridgo-api-storage`;
- `gridgo-postgres` on `gridgo-api-storage` only, with no `ports` entry;
- `gridgo-minio` on the storage/edge networks, also with no host port;
- one-shot `migrate`, `seed`, and `minio-init` services.

The database files live only on the explicitly named volume `gridgo_postgres_data`. Replacing the API or PostgreSQL container does not replace the volume. PostgreSQL must never join `gridgo-edge` or receive a public/host port.

MinIO bytes remain on `gridgo_minio_data`. The database stores file metadata and private object keys, never blobs.

## 2. Required environment and secret files

Install four files beside the production compose file and set mode `0600`. Values below are placeholders, not deployable secrets.

`postgres.env` is read only by PostgreSQL:

```dotenv
POSTGRES_DB=gridgo
POSTGRES_USER=gridgo_api
POSTGRES_PASSWORD=<unique high-entropy database password>
```

`gridgo-api.env` is read by API/migrate/seed:

```dotenv
# Complete private container-network URL. URL-encode special password characters.
DATABASE_URL=postgresql://gridgo_api:<url-encoded-password>@gridgo-postgres:5432/gridgo

# Clerk Production instance. All are mandatory; never use Development sk_test_ here.
CLERK_SECRET_KEY=<production sk_live_ secret>
CLERK_ISSUER=https://<production-instance>.clerk.accounts.dev
CLERK_AUTHORIZED_PARTIES=https://<production-instance>.clerk.accounts.dev,https://gridgo-dash.talasora.com,<landing origin for the support desk>,<exact mobile parties>
# Signing secret for POST /webhooks/clerk (Svix). Required for dashboard name/email edits to reach GRIDGO without a shop opening the app.
CLERK_WEBHOOK_SIGNING_SECRET=whsec_<production signing secret>

# Bucket-scoped MinIO identity; must match minio.env.
MINIO_ACCESS_KEY=<bucket user>
MINIO_SECRET_KEY=<bucket secret>

# Optional public support desk (landing /support). Firstmate installs these
# after the API merge; they are not required to boot. Never put EMAIL_* in a
# VITE_* or public payload. The desk signs in with Clerk: the landing origin
# must be in CLERK_AUTHORIZED_PARTIES, and only these verified primary emails
# may read tickets and issue reports (empty = desk answers 503).
# EMAIL_USER=<gmail address>
# EMAIL_PASSWORD=<gmail app password>
# SUPPORT_DESK_ALLOWED_EMAILS=<comma-separated desk emails>
```

`minio.env` is read by MinIO and its initializer:

```dotenv
MINIO_ROOT_USER=<root user>
MINIO_ROOT_PASSWORD=<root password>
MINIO_ACCESS_KEY=<same bucket user as gridgo-api.env>
MINIO_SECRET_KEY=<same bucket secret as gridgo-api.env>
```

`fcm-service-account.json` is the Firebase service account for project `gridgo-c2ce9`. The compose file mounts it read-only at `/run/secrets/fcm-service-account.json`. It must be readable by uid/gid 1001 and must never be committed or printed.

Native APNs is optional and separate from the Firebase credential. To enable it, install a private `.p8` file readable by uid 1001, mount it read-only into the API container, and set `GRIDGO_APNS_KEY_FILE` to that container path in `gridgo-api.env`. Set `GRIDGO_APNS_KEY_ID` and `GRIDGO_APNS_TEAM_ID`, plus the bundle topics `GRIDGO_APNS_CLIENT_TOPIC`, `GRIDGO_APNS_SUPPLIER_TOPIC`, and `GRIDGO_APNS_RIDER_TOPIC` for the apps being served. `GRIDGO_APNS_TOPIC` is the fallback for registrations without a matching app role; a fresh anonymous registration has no app role. Without a matching/fallback topic, delivery reports `apns_topic_missing`. Set `GRIDGO_APNS_SANDBOX=true` only for development APNs tokens; the default is production. The committed compose file does not mount an APNs key automatically. Device provider selection is defined in [Operational Model v2](OPERATIONAL_MODEL_V2_API.md#device-registration-model).

`/health` keeps the FCM report at `push` and adds the separate APNs report at `push.apns`. Each may report `configured`, `disabled`, or `misconfigured`; FCM also reports `available` after successful delivery or `unavailable` after provider/transport failures. `configured` therefore means "credential parsed, nothing sent by this process yet"; FCM spells that out with `sentSinceBoot: false`, `bootedAt`, per-process `sinceBoot: {accepted, pruned, failed}` counters, `lastAcceptedAt`, `lastFailureAt`/`lastFailureCode`, and `lastValidatedAt` (the stale-token sweep's last accepted dry run, which proves the credential before any real push). These reset on every deploy; the durable history is [`GET /ops/push/stats`](OPERATIONAL_MODEL_V2_API.md#get-opspushstats). The top-level push status is not an aggregate: FCM can be disabled while APNs is configured. APNs `configured` confirms key parsing, not topic validity or physical delivery. Runtime topic/provider errors are recorded on claimed-device outbox attempts; see [Realtime events](REALTIME_EVENTS.md#delivery-durability-and-scope) for retry and expiry behavior.

Configuration fixed in compose includes `NODE_ENV`, `HOST`, `PORT`, exact dashboard CORS origin, private/public MinIO origins, bucket, region, TTL, and upload timeout. Optional runtime tuning variables belong in `gridgo-api.env` only when needed:

```dotenv
DATABASE_POOL_MAX=10
DATABASE_CONNECT_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
# Stale push-token sweep cadence; 0 disables it.
GRIDGO_PUSH_TOKEN_CHECK_INTERVAL_MS=3600000
```

Local `.env` also uses `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, and a loopback `DATABASE_URL`. `POSTGRES_PORT` is intentionally local-only; production has no database port mapping.

There is no `AUTH_MODE`, `STORE_PATH`, demo password, `GRIDGO_*_PASSWORD`, or local session configuration. Leaving one of the required Clerk/database values out makes the process refuse before listening; errors name variable names but never values.

## 3. Clean cutover procedure

Firstmate supplies production values and performs these steps during the cutover window. This repository task does not execute them.

1. Copy the reviewed `deploy/docker-compose.yml` to `~/gridgo/api/docker-compose.yml`. A merge does not copy it.
2. Install the four secret files above with correct ownership/mode.
3. Pull the reviewed image and PostgreSQL 17 image. The MinIO and `mc` images are GRIDGO's own private `ghcr.io/gridgoph/{minio,mc}` packages pinned by digest (`docs/STORAGE_API.md#minio-images`); they need the same GHCR login as the API image.
4. Start only PostgreSQL and wait for its healthcheck.
5. Run all ordered forward migrations.
6. Run the idempotent reference seed.
7. Create/sign into the first identity in the Clerk Production instance and bootstrap it once as Super Admin.
8. Start MinIO/init and the API, then verify health and browser boundaries.

Representative operator commands from `~/gridgo/api`:

```bash
docker compose pull api migrate seed postgres
docker compose up -d postgres
docker compose run --rm migrate
docker compose run --rm seed
docker compose run --rm --no-deps api npm run bootstrap-admin -- --clerk-user-id user_...
docker compose up -d --remove-orphans
```

The seed inserts only catalog, the four-category taxonomy, zones, and operational settings. It creates no user, supplier service, order, file, payment, credit, claim, issue, audit, notification, ping, escalation, proof, or device registration.

Do not run bootstrap until the Clerk user ID and instance are independently checked. The command succeeds only while no `ops_admin` or `super_admin` exists, records an audit entry plus an immutable completion row, and then closes permanently even if roles later change. This one-time CLI bootstrap is the only first-administrator path: there is no HTTP bootstrap route and no redeemable bootstrap token.

## 4. Identity and role operations

Every authenticated request verifies a Clerk session JWT against the configured secret/JWK, exact issuer, and authorized-party allowlist. `users.clerk_user_id` is unique. Ordinary routes return `401` for a verified but unmapped Clerk subject.

`POST /auth/clerk/activate` is the client-only first-use provisioning path. It loads the Clerk user and creates `role=client`; its body cannot choose a role and it never merges identities by email. Fixed supplier and rider enrollment routes are the only self-service role-application paths, hard-code the membership selected by their URL, and require `Idempotency-Key`. The database role is authoritative and no `gridgo_role` token/public-metadata value grants access. Exact enrollment methods and bodies are owned by `docs/OPERATIONAL_MODEL_V2_API.md`.

Identity onboarding is:

1. create or invite the identity through Clerk;
2. have a client call `/auth/clerk/activate`, or have a supplier/rider call the matching fixed enrollment route; an already-mapped identity keeps its existing memberships;
3. have a rider attach a current driver's licence and explicitly submit the pending case;
4. Operations completes supplier/rider verification before matching or dispatch; apart from the first-administrator CLI bootstrap, Operations and administrator memberships still require audited assignment through `PATCH /users/:id/role`.

`POST /auth/login` and `/auth/signup` are gone. Mobile/dashboard clients must send their Clerk JWT directly. `POST /auth/logout` only releases a named phone registration; the client terminates its Clerk session using the Clerk SDK.

## 5. Migrations and releases

Migrations are ordered files under `migrations/` and run through `node-pg-migrate`:

```bash
npm run migrate
```

The API never executes DDL at boot. It checks database connectivity and the migrated `platform_settings` table before listening. A missing schema produces a specific instruction to run migrations.

Every deployment runs `migrate` and `seed` before API start through compose dependencies. Forward migrations must be compatible with the image being deployed. Roll back application code by pinning `GRIDGO_API_TAG` to a prior immutable `sha-...` tag only when that image understands the already-forward database schema; database rollback requires a tested backup restore, not a down migration guess.

## 6. Durability and transaction model

All HTTP mutations run in PostgreSQL transactions. A transaction-scoped advisory lock serializes route-compatible object-graph mutations across API processes. Order transitions, payment confirmation/rejection, payout milestone movement, final payout release, credits, claims, and issue-created holds commit with their audit/notification rows or roll back together.

Push/SSE durability and after-commit delivery follow [Realtime events](REALTIME_EVENTS.md#delivery-durability-and-scope). Apply the notification outbox and `device_token_checks` forward migrations before starting this version; startup never creates them.

CI's image smoke test creates a named PostgreSQL volume, migrates/seeds it, writes a marker, replaces the API container, proves the marker through the API, recreates the PostgreSQL container on the same volume, and proves the marker again. Do not weaken or remove this test.

## 7. Health verification

```bash
curl -fsS https://gridgo-api.talasora.com/health | jq
```

Required fields:

- `ok: true`;
- `commit` equals the merged Git SHA and `builtAt` is present;
- `database.status: "available"`;
- `storage.status: "available"` after MinIO initialization;
- inspect FCM and APNs health independently as described in §2; neither report certifies physical handset delivery.

The database failure state is visible even when SQL-backed route loading is impossible because `/health` checks it independently. The container healthcheck fails when `ok` is false.

Verify exact CORS behavior:

```bash
curl -si -H 'Origin: https://gridgo-dash.talasora.com' https://gridgo-api.talasora.com/health
curl -si -H 'Origin: https://not-gridgo.example' https://gridgo-api.talasora.com/health
```

The first response echoes the dashboard origin; the second is `403 origin_not_allowed`.

## 8. PostgreSQL backup

Back up PostgreSQL and MinIO together closely enough to meet the captain's recovery-point objective. A database file-metadata record without its matching object (or vice versa) requires reconciliation.

Create a custom-format logical backup without printing credentials:

```bash
install -m 700 -d ~/gridgo/backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$HOME/gridgo/backups/gridgo-${stamp}.dump"
docker exec gridgo-postgres pg_dump -U gridgo_api -d gridgo -Fc > "$backup_path"
chmod 600 "$backup_path"
```

Back up the MinIO volume using the coordinated procedure for that host, encrypt both artifacts, copy them off-host, and retain multiple dated sets. Test restores regularly.

For a volume-level PostgreSQL backup, stop API writers and PostgreSQL cleanly first. Never archive live PostgreSQL data files from a running container as though they were ordinary files.

## 9. Restore drill

Restore only into an empty isolated PostgreSQL 17 database first:

1. create a new empty database/volume;
2. run `pg_restore --clean --if-exists --no-owner` against it;
3. restore the matching MinIO backup;
4. point an isolated API container at the restored database;
5. verify `/health`, authenticated role boundaries, a known order/payment/payout, and a signed file download;
6. promote the restored volume only after captain approval.

Example inside an isolated PostgreSQL container:

```bash
pg_restore -U gridgo_api -d gridgo --clean --if-exists --no-owner /backup/gridgo.dump
```

A production restore is destructive. Confirm the exact target container/database and retain the pre-restore backup before proceeding.

## 10. Credential rotation

- Database password: schedule downtime, update `postgres.env` and the complete URL-encoded `DATABASE_URL` in `gridgo-api.env`, rotate the PostgreSQL role password, then recreate migrate/seed/API. Never log the URL.
- Clerk secret: rotate in the matching Clerk Production instance, replace only `CLERK_SECRET_KEY`, and recreate API/migrate/seed as applicable. Issuer/authorized parties must remain matched to the same instance.
- MinIO bucket credentials: create/attach the new bucket user first, update both env files, recreate API, verify file operations, then revoke the old user.
- FCM service account: replace the mode-0600 file atomically and recreate API; missing/broken push configuration does not block database/API startup.

## 11. Capacity and future geography

Money is `BIGINT` minor units and application writes are checked against JavaScript's safe integer range. Location/pickup/dropoff columns are `DOUBLE PRECISION` with coordinate constraints. Current SQL queries filter pings by `order_id` and time; no spatial index is justified. Introduce PostGIS only with a forward migration when matching requires database-side radius/nearest-neighbor queries.
