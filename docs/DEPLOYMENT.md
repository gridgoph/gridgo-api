# GRIDGO API production deployment

This runbook is authoritative for the PostgreSQL 17 and Clerk-only production service at `gridgo-api.talasora.com`. CI builds and smoke-tests the image, publishes it to `ghcr.io/gridgoph/gridgo-api`, and invokes the server's restricted `api` deploy command after a default-branch merge. CI never writes compose or secret files to the server.

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
CLERK_AUTHORIZED_PARTIES=https://<production-instance>.clerk.accounts.dev,https://gridgo-dash.talasora.com,<exact mobile parties>

# Bucket-scoped MinIO identity; must match minio.env.
MINIO_ACCESS_KEY=<bucket user>
MINIO_SECRET_KEY=<bucket secret>
```

`minio.env` is read by MinIO and its initializer:

```dotenv
MINIO_ROOT_USER=<root user>
MINIO_ROOT_PASSWORD=<root password>
MINIO_ACCESS_KEY=<same bucket user as gridgo-api.env>
MINIO_SECRET_KEY=<same bucket secret as gridgo-api.env>
```

`fcm-service-account.json` is the Firebase service account for project `gridgo-c2ce9`. The compose file mounts it read-only at `/run/secrets/fcm-service-account.json`. It must be readable by uid/gid 1001 and must never be committed or printed.

Configuration fixed in compose includes `NODE_ENV`, `HOST`, `PORT`, exact dashboard CORS origin, private/public MinIO origins, bucket, region, TTL, and upload timeout. Optional runtime tuning variables belong in `gridgo-api.env` only when needed:

```dotenv
DATABASE_POOL_MAX=10
DATABASE_CONNECT_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
```

Local `.env` also uses `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, and a loopback `DATABASE_URL`. `POSTGRES_PORT` is intentionally local-only; production has no database port mapping.

There is no `AUTH_MODE`, `STORE_PATH`, demo password, `GRIDGO_*_PASSWORD`, or local session configuration. Leaving one of the required Clerk/database values out makes the process refuse before listening; errors name variable names but never values.

## 3. Clean cutover procedure

Firstmate supplies production values and performs these steps during the cutover window. This repository task does not execute them.

1. Copy the reviewed `deploy/docker-compose.yml` to `~/gridgo/api/docker-compose.yml`. A merge does not copy it.
2. Install the four secret files above with correct ownership/mode.
3. Pull the reviewed image and PostgreSQL 17 image.
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

Do not run bootstrap until the Clerk user ID and instance are independently checked. The command succeeds only while no `ops_admin` or `super_admin` exists, records an audit entry plus an immutable completion row, and then closes permanently even if roles later change. There is no HTTP bootstrap route.

## 4. Identity and role operations

Every authenticated request verifies a Clerk session JWT against the configured secret/JWK, exact issuer, and authorized-party allowlist. `users.clerk_user_id` is unique. Ordinary routes return `401` for a verified but unmapped Clerk subject.

`POST /auth/clerk/activate` is the only public first-use provisioning path. It loads the Clerk user and creates `role=client`; its body cannot choose a role and it never merges identities by email. The database role is authoritative and no `gridgo_role` token/public-metadata value grants access.

Supplier/rider/Operations onboarding is:

1. create or invite the identity through Clerk;
2. have the person sign in and call `/auth/clerk/activate` once;
3. a Super Admin changes the database role through `PATCH /users/:id/role`;
4. Operations completes supplier/rider verification before matching.

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

Push/SSE publication is registered after commit. Failed push delivery cannot fail or undo a completed money/order mutation.

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
- push is `available`, `disabled`, or `misconfigured` with a non-secret reason.

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
