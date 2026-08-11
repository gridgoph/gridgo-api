# Hosted pilot deployment

This runbook deploys the current GRIDGO API for the Davao hosted pilot:

- API: `https://gridgo-api.talasora.com`
- Dashboard: `https://gridgo-dash.talasora.com`

This is a single-host, single-process pilot backend. Domain data lives in one JSON file and uploads live in a private MinIO bucket. It is suitable for small, manually operated pilot volumes when the host, store, object bucket, credentials, TLS, and backups are managed as described here. It is not highly available and must not be horizontally replicated.

## Production data boundary

`NODE_ENV=production npm run seed` creates:

- the six fixed pilot identities, with passwords supplied by the deployment environment;
- the platform-owned request catalog, product taxonomy, operational settings, and Davao zones;
- empty sessions, supplier services, orders, files, credits, claims, issues, audit log, notifications, location pings, escalations, and proofs.

The catalog, taxonomy, settings, and zones are reference data needed to accept and price real requests. Supplier services and every transaction/evidence collection are operator- or user-authored data, so production starts without samples.

Local development remains different by design: without `NODE_ENV=production`, `npm run seed` creates all rich demo scenarios and uses the committed local-development password. Never copy `data/store.json` from a development checkout into the hosted pilot.

Production startup checks known scenario record markers before running any load-time migration. If a configured `STORE_PATH` contains the local rich seed, startup refuses without mutating it and directs the operator to a fresh production store. It never deletes demo data to make a file appear safe.

## 1. Host and filesystem

Install Node.js 20 or newer, Caddy, Docker Engine with the Compose plugin, and a current MinIO Client (`mc`) for backup/restore. Use a dedicated unprivileged service account and protected paths:

```bash
sudo useradd --system --home /var/lib/gridgo-api --shell /usr/sbin/nologin gridgo
sudo install -d -o gridgo -g gridgo -m 0700 /var/lib/gridgo-api
sudo install -d -o root -g gridgo -m 0750 /etc/gridgo-api
sudo install -d -o root -g root -m 0755 /opt/gridgo-api
```

Install a reviewed release in `/opt/gridgo-api`, then install locked dependencies:

```bash
cd /opt/gridgo-api
npm ci --omit=dev
```

Do not run the API from a mutable developer checkout. Restrict `/var/lib/gridgo-api/store.json` to the service account because it contains password credentials, session tokens, user details, and operational records.

## 2. Required environment

Create `/etc/gridgo-api/gridgo-api.env`, owned by `root:gridgo` with mode `0640`. Generate unique values with a password manager or `openssl rand -base64 32`; do not copy any committed example secret.

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=18787
STORE_PATH=/var/lib/gridgo-api/store.json

# Exact browser origins only: no wildcard, path, or trailing slash.
CORS_ALLOWED_ORIGINS=https://gridgo-dash.talasora.com

# One distinct secret for each fixed pilot identity; minimum 12 characters.
GRIDGO_CLIENT_PASSWORD=<unique-secret>
GRIDGO_INDIVIDUAL_PASSWORD=<unique-secret>
GRIDGO_SUPPLIER_PASSWORD=<unique-secret>
GRIDGO_RIDER_PASSWORD=<unique-secret>
GRIDGO_OPS_PASSWORD=<unique-secret>
GRIDGO_ADMIN_PASSWORD=<unique-secret>

# API-to-MinIO stays on host loopback. Signed GETs use the public TLS origin.
MINIO_ENDPOINT=http://127.0.0.1:19000
MINIO_PUBLIC_URL=https://gridgo-api.talasora.com
MINIO_ACCESS_KEY=<bucket-scoped-api-user>
MINIO_SECRET_KEY=<bucket-scoped-api-secret>
MINIO_BUCKET=gridgo-uploads
MINIO_REGION=us-east-1
MINIO_DOWNLOAD_URL_TTL_SECONDS=300
UPLOAD_REQUEST_TIMEOUT_MS=900000
```

The dashboard deployment must use:

```dotenv
EXPO_PUBLIC_API_URL=https://gridgo-api.talasora.com
```

Production startup validates all six account passwords, the exact CORS allowlist, a loopback `MINIO_ENDPOINT`, explicit MinIO credentials, and HTTPS for `MINIO_PUBLIC_URL`. It refuses to start with a concrete error and repair instruction instead of falling back to repository defaults. Changing one of the six password variables and restarting rotates that fixed account on the next load.

## 3. Private MinIO

Create a Compose `.env` beside `docker-compose.yml`. Its API user values must match `/etc/gridgo-api/gridgo-api.env`:

```dotenv
MINIO_ROOT_USER=<unique-root-user>
MINIO_ROOT_PASSWORD=<unique-root-secret>
MINIO_ACCESS_KEY=<same-bucket-scoped-api-user>
MINIO_SECRET_KEY=<same-bucket-scoped-api-secret>
MINIO_BIND_ADDRESS=127.0.0.1
MINIO_API_PORT=19000
MINIO_CONSOLE_PORT=19001
MINIO_PUBLIC_URL=https://gridgo-api.talasora.com
```

Start MinIO and its idempotent private-bucket initialization:

```bash
docker compose up -d --wait
```

Confirm both published sockets are loopback-only:

```bash
ss -ltn | grep -E '127\.0\.0\.1:(19000|19001)'
```

Hard boundary: never use a bare Docker port mapping, `0.0.0.0`, a public/LAN bind address, or a cloud security group as the only MinIO control. Docker-published ports bypass host firewall rules. That failure mode previously exposed GRIDGO data to ransomware. The MinIO console on `19001` must never be reverse proxied or reachable from the internet.

## 4. Initialize the real store

Load the protected environment and create the store once as the service user:

```bash
sudo -u gridgo /bin/bash -lc '
  set -a
  source /etc/gridgo-api/gridgo-api.env
  set +a
  cd /opt/gridgo-api
  npm run seed
'
sudo chmod 0600 /var/lib/gridgo-api/store.json
```

Do not use `npm run reset` on a hosted store. `npm run seed` refuses to overwrite an existing file. A missing custom `STORE_PATH` also makes API startup refuse with the initialization command; it is never silently recreated, because an empty file after a path mistake would look like data loss.

Before continuing, inspect the production boundary without printing passwords:

```bash
sudo -u gridgo node -e '
  const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  console.log({users:s.users.length,catalog:s.catalog.length,categories:s.taxonomy.categories.length,orders:s.orders.length,services:s.supplierServices.length,files:s.files.length});
' /var/lib/gridgo-api/store.json
```

`orders`, `services`, and `files` must all be `0` on a fresh deployment.

## 5. Run one API process

Create `/etc/systemd/system/gridgo-api.service`:

```ini
[Unit]
Description=GRIDGO hosted pilot API
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=gridgo
Group=gridgo
WorkingDirectory=/opt/gridgo-api
EnvironmentFile=/etc/gridgo-api/gridgo-api.env
ExecStart=/usr/bin/node /opt/gridgo-api/src/server.js
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/gridgo-api

[Install]
WantedBy=multi-user.target
```

Confirm the Node binary path with `command -v node` and adjust `ExecStart` if necessary. Then start exactly one process:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gridgo-api
sudo systemctl status gridgo-api
curl -fsS http://127.0.0.1:18787/health
```

Never run multiple API workers or replicas against the JSON store. In-process serialization protects one process only; two processes can overwrite each other's mutations.

## 6. Cloudflare Flexible TLS and Caddy routing

Cloudflare owns the public TLS connection for `https://gridgo-api.talasora.com`. The DNS record must be proxied through Cloudflare and its SSL/TLS encryption mode must be **Flexible**. In [Cloudflare Flexible mode](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/), the visitor-to-Cloudflare leg is HTTPS but Cloudflare connects to the server over plain HTTP. There is no origin certificate on the box and Caddy must not redirect HTTP to HTTPS.

This also means the Cloudflare-to-origin leg is not encrypted. Restricting origin port 80 to Cloudflare's proxy ranges prevents direct public bypass but does not add transport encryption. Treat this as a named hosted-pilot limitation; move to Cloudflare Full (strict) before end-to-end encryption becomes a requirement.

The API hostname has two loopback upstreams behind the one HTTP Caddy listener:

- normal routes go to Node on `127.0.0.1:18787`;
- only `/gridgo-uploads/` goes to MinIO on `127.0.0.1:19000`.

Use this site block in `/etc/caddy/Caddyfile`. Per [Caddy's site-address rules](https://caddyserver.com/docs/caddyfile/concepts#addresses), the explicit `http://` address keeps Caddy on plain HTTP and disables automatic HTTPS for this host:

```caddyfile
http://gridgo-api.talasora.com {
    # Signed GET data plane. Preserve the public Host and complete URI;
    # changing the host, path, or query invalidates the MinIO SigV4 signature.
    @signed_downloads path /gridgo-uploads/*
    handle @signed_downloads {
        reverse_proxy 127.0.0.1:19000 {
            header_up Host {http.request.host}
        }
    }

    # API control plane, streamed uploads, JSON routes, and notification SSE.
    handle {
        reverse_proxy 127.0.0.1:18787 {
            header_up Host {http.request.host}
        }
    }
}
```

Validate and reload Caddy, then test the origin route locally with the real Host header:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS -H 'Host: gridgo-api.talasora.com' http://127.0.0.1/health
```

Do not add a certificate, HTTPS listener, or HTTP-to-HTTPS redirect on this server while Cloudflare remains in Flexible mode. The browser-facing API and signed URLs are still HTTPS because clients connect to Cloudflare first, so `MINIO_PUBLIC_URL` remains `https://gridgo-api.talasora.com`.

At the network edge, allow inbound origin HTTP only from Cloudflare's published proxy ranges; do not expose Node `18787`, MinIO `19000`, or the MinIO console `19001`. Configure a Cloudflare Cache Rule to bypass caching for the API hostname so authenticated JSON, SSE, and signed object responses are never served from cache. Never proxy `/minio/`, the console, Docker sockets, the JSON store, backup directories, or host administration interfaces.

## 7. Back up both halves

An empty recreated store is not recovery. A usable recovery point contains both the JSON metadata and the MinIO objects it references. Run a coordinated backup during a short maintenance window; stopping Node prevents new uploads and JSON mutations while MinIO is mirrored.

Configure `mc` once against the loopback API using protected MinIO credentials:

```bash
set -a
source /etc/gridgo-api/gridgo-api.env
set +a
sudo mc alias set gridgo-local http://127.0.0.1:19000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
unset MINIO_ACCESS_KEY MINIO_SECRET_KEY
```

For every backup:

```bash
backup_root=/var/backups/gridgo
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$backup_root/$backup_stamp"
sudo install -d -m 0700 "$backup_dir/minio"

sudo systemctl stop gridgo-api
sudo cp --preserve=mode,ownership,timestamps /var/lib/gridgo-api/store.json "$backup_dir/store.json"
sudo mc mirror --overwrite gridgo-local/gridgo-uploads "$backup_dir/minio/gridgo-uploads"
sudo /bin/bash -c "cd '$backup_dir' && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS"
sudo systemctl start gridgo-api
curl -fsS http://127.0.0.1:18787/health
```

Encrypt backups, copy them off the API host, restrict access, and retain multiple dated recovery points. The JSON contains passwords and sessions; the bucket contains private artwork and identity evidence. Schedule backups according to the maximum data loss the captain accepts, and perform a restore drill on a separate host after setup and after material storage changes.

## 8. Restore and prove recovery

Choose an exact dated backup and verify its checksums before touching the live files:

```bash
restore_dir=/var/backups/gridgo/20260811T120000Z
sudo /bin/bash -c "cd '$restore_dir' && sha256sum -c SHA256SUMS"
sudo node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("store JSON valid")' "$restore_dir/store.json"
```

Then enter a maintenance window, stop the API, retain a safety copy, and restore both halves:

```bash
sudo systemctl stop gridgo-api
sudo cp /var/lib/gridgo-api/store.json /var/lib/gridgo-api/store.json.before-restore
sudo install -o gridgo -g gridgo -m 0600 "$restore_dir/store.json" /var/lib/gridgo-api/store.json.restore
sudo mv /var/lib/gridgo-api/store.json.restore /var/lib/gridgo-api/store.json
sudo mc mirror --overwrite --remove "$restore_dir/minio/gridgo-uploads" gridgo-local/gridgo-uploads
sudo systemctl start gridgo-api
```

Do not use `--remove` against any alias/bucket other than the exact verified `gridgo-local/gridgo-uploads` restore target. Verify `/health`, an account login, a known restored order, and a known restored file download URL before reopening traffic. Remove `store.json.before-restore` only after the captain accepts the recovery.

## 9. Post-deployment checks

Health and storage must both be healthy:

```bash
curl -fsS https://gridgo-api.talasora.com/health
```

The response must contain `"ok":true` and storage status `"available"`. An unavailable storage status means JSON routes are alive but uploads/downloads are not; check the loopback MinIO service and API credentials before onboarding users.

Prove the browser boundary:

```bash
curl -si -H 'Origin: https://gridgo-dash.talasora.com' https://gridgo-api.talasora.com/health
curl -si -H 'Origin: https://not-gridgo.example' https://gridgo-api.talasora.com/health
```

The first response must echo `Access-Control-Allow-Origin: https://gridgo-dash.talasora.com`, never `*`. The second must be `403` with `origin_not_allowed` and no allow-origin header.

Log in without placing the password in shell history:

```bash
read -rsp 'GRIDGO admin password: ' GRIDGO_LOGIN_PASSWORD; echo
curl -fsS https://gridgo-api.talasora.com/auth/login \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg email admin@gridgo.local --arg password "$GRIDGO_LOGIN_PASSWORD" '{email:$email,password:$password}')"
unset GRIDGO_LOGIN_PASSWORD
```

On a fresh store, authenticated `/orders`, `/notifications`, `/claims`, and `/issues` lists must be empty. Complete one controlled end-to-end upload and signed download before accepting real artwork, then confirm the signed URL uses HTTPS on `gridgo-api.talasora.com` and expires.

## 10. Pilot limits and database migration signals

Treat these as operating guardrails, not benchmarked capacity promises:

- Exactly one API process and one writable store file; no replicas or shared-network filesystem.
- One host is a failure domain. Recovery depends on tested off-host JSON plus object backups.
- Every mutation serializes and rewrites the whole JSON document synchronously. Keep `store.json` below 25 MiB during the pilot and alert on growth.
- Keep sustained mutating traffic below 5 requests/second and investigate p95 mutation latency above 500 ms. File bytes go to MinIO, but file metadata still grows the JSON store.
- Keep concurrent notification streams and active users to small pilot cohorts; the process owns all live SSE connections in memory.
- Deploys and coordinated backups may require a brief maintenance window. There is no automatic failover or point-in-time recovery.
- Passwords use the current custom-auth store format rather than a production identity provider; protect the store and backups as secrets and limit pilot access.
- Cloudflare Flexible mode leaves the Cloudflare-to-Caddy origin leg unencrypted; keep the origin restricted to Cloudflare proxy ranges and treat Full (strict) migration as a security milestone.

Move to a transactional database and production identity system before any of these becomes true: a second API instance is needed; zero-downtime deploys or point-in-time recovery are required; the store reaches 25 MiB or routinely takes more than 500 ms to mutate; write contention/errors appear; backup or restore misses the captain's recovery objective; access/audit requirements exceed file permissions; or real platform-processed money/provider webhooks are introduced. Preserve the documented route contracts during that migration.
