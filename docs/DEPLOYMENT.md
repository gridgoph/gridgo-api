# Hosted pilot deployment

This runbook deploys the current GRIDGO API for the Davao hosted pilot:

- API: `https://gridgo-api.talasora.com`
- Dashboard: `https://gridgo-dash.talasora.com`

This is a single-host, single-process pilot backend. Domain data lives in one JSON file and uploads live in a private MinIO bucket. It is suitable for small, manually operated pilot volumes when the host, store, object bucket, credentials, TLS, and backups are managed as described here. It is not highly available and must not be horizontally replicated.

Every merge to the default branch builds a container image, publishes it to this repository's private GitHub Container Registry, and asks the server to pull and restart. Nothing is deployed by hand and nothing is built on the server.

| Piece | Lives at |
| --- | --- |
| Production image | `Dockerfile` |
| Server service definition | `deploy/docker-compose.yml` → installed as `~/gridgo/api/docker-compose.yml` |
| Pipeline | `.github/workflows/deploy.yml` |
| Health check | `GET /health` |
| Secrets | two files on the server, never in this repository — §3 |

## How a change reaches users

```
merge to main
  └─ verify      npm ci · npm test
     └─ image    docker build → smoke test the built image → push sha-<12> and latest
        └─ deploy  ssh <deploy key> "api"  (registry token piped on stdin)
           └─ server: docker compose pull && up -d --remove-orphans
              └─ confirm https://gridgo-api.talasora.com/health reports the merged commit
```

Each stage gates the next. A failing test never produces an image; an image that will not start, loses data across a container replacement, or gets the CORS boundary wrong is never pushed; a push the server does not actually pick up fails the run rather than reporting success.

### Which event does what, and why

| Event | Verify | Build | Publish | Deploy |
| --- | --- | --- | --- | --- |
| `pull_request` (from a fork) | yes | yes | **no** | **no** |
| `pull_request` (branch in this repo) | — covered by the `push` run on the same commit — | | | |
| `push` to `fm/**` | yes | yes | `sha-…` + `branch-…` | **no** |
| `push` to `main` | yes | yes | `sha-…` + **`latest`** | yes |
| `workflow_dispatch` | yes | yes | yes | only if run from `main` |

**A pull request must not deploy, and must not publish either.** A proposal is not a decision. The server pulls from this registry, so an image in it is one `docker compose pull` away from being live. GitHub reinforces this: a fork pull request gets a read-only token, so it *cannot* push even if the workflow asked it to. A branch push under `fm/**` does publish, but only under immutable `sha-` / `branch-` tags; it never moves `latest`, which is the only tag `~/gridgo/api/docker-compose.yml` names.

## Production data boundary

`NODE_ENV=production npm run seed` creates:

- the six fixed pilot identities, with passwords supplied by the deployment environment;
- the platform-owned request catalog, product taxonomy, operational settings, and Davao zones;
- empty sessions, supplier services, orders, files, credits, claims, issues, audit log, notifications, location pings, escalations, and proofs.

The catalog, taxonomy, settings, and zones are reference data needed to accept and price real requests. Supplier services and every transaction/evidence collection are operator- or user-authored data, so production starts without samples.

Local development remains different by design: without `NODE_ENV=production`, `npm run seed` creates all rich demo scenarios and uses the committed local-development password. Never copy `data/store.json` from a development checkout into the hosted pilot — and the image cannot carry one across either, because `.dockerignore` keeps `data/` out of the build context.

Production startup checks known scenario record markers before running any load-time migration. If a configured `STORE_PATH` contains the local rich seed, startup refuses without mutating it and directs the operator to a fresh production store. It never deletes demo data to make a file appear safe.

## 1. What the server needs

**Provided by the captain's server** (`~` is the deploy user's home):

- Docker Engine with the Compose plugin.
- `~/gridgo/bin/deploy.sh` — the only command the CI key may run. It accepts exactly `api` or `web`, reads a registry token from stdin, runs `docker compose pull` and `up -d --remove-orphans` in the matching directory, then logs out of the registry.
- The `gridgo-edge` Docker network, created and owned by the Caddy project in `~/gridgo-proxy`. This compose file joins it as `external`, so a `docker compose down` here can never delete the network the portal and the landing site also sit on.
- Caddy routing `gridgo-api.talasora.com` to two upstreams on that network — see §6. The containers **must** keep the names `gridgo-api` and `gridgo-minio`; renaming either takes the API off the internet.

**Installed once by an operator** into `~/gridgo/api/`:

| File | Source | Mode |
| --- | --- | --- |
| `docker-compose.yml` | `deploy/docker-compose.yml` in this repository | 0644 |
| `gridgo-api.env` | written by hand — §3 | **0600** |
| `minio.env` | written by hand — §3 | **0600** |

Nothing else belongs in that directory. There is no checkout on the server, no `node_modules`, no store file on the host filesystem and no `mc` binary to install: everything the deployment needs is in the image or in a container it starts.

**Keep the installed compose file in step with `deploy/docker-compose.yml`.** Nothing synchronises them; CI never writes to the server. After changing the compose file in this repository, an operator must copy it across, or the server keeps running the old definition while the repository suggests otherwise.

## 2. Secrets, and how an operator rotates one

Production refuses to start without a distinct password for each of the six fixed pilot identities. Those values cannot live in this repository or in the compose file, and they are deliberately **not** GitHub secrets either: CI's only capability on that host is "run `deploy.sh api`", so it never sees, carries or writes application configuration. Nothing about a deploy touches these files.

They reach the container as two `env_file` entries read at container start. Generate every value with `openssl rand -base64 24` or a password manager; never reuse a committed example.

`~/gridgo/api/gridgo-api.env` — read by the `api` and `store-init` services:

```dotenv
# One distinct secret for each fixed pilot identity; minimum 12 characters, and
# never the repository's local-development password.
GRIDGO_CLIENT_PASSWORD=<unique-secret>
GRIDGO_INDIVIDUAL_PASSWORD=<unique-secret>
GRIDGO_SUPPLIER_PASSWORD=<unique-secret>
GRIDGO_RIDER_PASSWORD=<unique-secret>
GRIDGO_OPS_PASSWORD=<unique-secret>
GRIDGO_ADMIN_PASSWORD=<unique-secret>

# The bucket-scoped MinIO user the API authenticates as.
MINIO_ACCESS_KEY=<bucket-scoped-api-user>
MINIO_SECRET_KEY=<bucket-scoped-api-secret>
```

`~/gridgo/api/minio.env` — read by the `minio` and `minio-init` services:

```dotenv
MINIO_ROOT_USER=<unique-root-user>
MINIO_ROOT_PASSWORD=<unique-root-secret>

# The same two values as above: this file creates that user, the other one
# authenticates as it. They must match exactly.
MINIO_ACCESS_KEY=<bucket-scoped-api-user>
MINIO_SECRET_KEY=<bucket-scoped-api-secret>
```

The split is the point: the API process never holds MinIO root credentials, and the `mc` container never holds account passwords.

```bash
chmod 600 ~/gridgo/api/gridgo-api.env ~/gridgo/api/minio.env
```

Everything that is configuration rather than secret — `NODE_ENV`, `HOST`, `PORT`, `STORE_PATH`, `CORS_ALLOWED_ORIGINS`, `MINIO_ENDPOINT`, `MINIO_PUBLIC_URL`, the bucket name, region and URL TTL — lives in `environment:` in the version-controlled compose file, where it is reviewable. Compose gives `environment:` precedence over `env_file`, so a secret file cannot quietly widen the CORS allowlist.

**To rotate an account password:**

```bash
cd ~/gridgo/api
# edit the one variable in gridgo-api.env
docker compose up -d --force-recreate api
curl -fsS -H 'Host: gridgo-api.talasora.com' http://127.0.0.1/health
```

The next load applies the new password to that fixed identity. Rotating a password does not touch any other account and does not restart MinIO. Existing sessions for that account remain valid until they expire; revoke them by having the account log out, or accept the window.

**To rotate the MinIO bucket credential**, change `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` in *both* files to the same new pair and run `docker compose up -d --force-recreate`. `minio-init` creates the new user and reattaches the bucket policy; the old user is left in place, so remove it deliberately once the new one is confirmed working:

```bash
docker compose run --rm --entrypoint /bin/sh minio-init -ec \
  'mc alias set l http://gridgo-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
   mc admin user remove l <old-access-key>'
```

**To rotate the MinIO root credential**, change it in `minio.env` and run `docker compose up -d --force-recreate minio minio-init`. MinIO reads root credentials from its environment at start; the bucket user and its policy are stored in the volume and are unaffected.

## 3. Install the deployment

As the deploy user, once:

```bash
mkdir -p ~/gridgo/api
# copy deploy/docker-compose.yml from this repository to ~/gridgo/api/docker-compose.yml
# write gridgo-api.env and minio.env as in §2, then chmod 600 both
cd ~/gridgo/api
docker compose config --quiet          # must print nothing
docker compose config --images         # must include ghcr.io/rqms40/gridgo-api:latest
```

`deploy.sh` refuses while `~/gridgo/api/docker-compose.yml` is missing. Then merge to the default branch and let the pipeline do the first deploy. **Do not `docker compose up` by hand first**: the image is private, and CI is what supplies the pull credential — by design, nothing durable authenticates this host to the registry. A manual pull failing with `unauthorized` before the first CI publish is the expected, correct state, not a fault.

The stack that comes up:

| Service | Container | Role |
| --- | --- | --- |
| `store-init` | `gridgo-api-store-init` | one-shot; creates the production store the first time, exits 0 and changes nothing on every deploy after |
| `api` | `gridgo-api` | the API, on `gridgo-edge` (proxy) and `gridgo-api-storage` (MinIO) |
| `minio` | `gridgo-minio` | private object storage; **no host port at any address** |
| `minio-init` | `gridgo-api-minio-init` | one-shot; creates the private bucket, the bucket-scoped user and its policy |

## 4. Persistence — the part that destroys everything if it is wrong

The entire domain database is one JSON file. If it lives inside the container, **every deploy silently destroys every account, order and payment record**, because a deploy replaces the container.

It does not. `STORE_PATH=/var/lib/gridgo-api/store.json` sits on the named Docker volume `gridgo_api_store`, and object bytes sit on `gridgo_minio_data`. Replacing a container never touches either. The volume names are pinned with an explicit `name:` in the compose file so they do not follow the project name — the backup and restore commands below address them by name, and a renamed volume is a silently empty database.

Ownership needs no host-side `chown`: the image creates `/var/lib/gridgo-api` owned by its own uid 1001 with mode 0700, and Docker seeds a fresh named volume from that directory.

`store-init` is what makes a first deploy — and a rebuilt volume — recover by itself. `src/seed.js` without `--reset` refuses to overwrite an existing store and exits 0, so it is safe on every deploy. **Never run `npm run reset` against the hosted store**; there is no compose service that can, deliberately.

Check the boundary at any time, without printing passwords:

```bash
docker run --rm -v gridgo_api_store:/store:ro node:22-alpine node -e '
  const s = JSON.parse(require("fs").readFileSync("/store/store.json","utf8"));
  console.log({users:s.users.length, catalog:s.catalog.length,
               categories:s.taxonomy.categories.length, orders:s.orders.length,
               services:s.supplierServices.length, files:s.files.length});
'
```

`orders`, `services` and `files` must all be `0` on a fresh deployment.

## 5. Private object storage

The MinIO service publishes **no host port at any address**. That is stricter than a loopback binding and it is deliberate: a Docker port publication inserts its own `DOCKER-USER` rules and bypasses host firewall rules, so "published to 127.0.0.1 and firewalled" is not a control that can be relied on. An exposed datastore is how the previous GRIDGO was ransomwared. The API reaches MinIO by container name over the `internal: true` network `gridgo-api-storage`, which has no gateway at all, so bucket credentials on that network cannot reach anything off the host.

The console is bound to the container's own loopback *and* `MINIO_BROWSER=off` switches the browser UI off outright, so it is unreachable even from a sibling container. It is never given a proxy route. Never reverse proxy `/minio/`, the console, the Docker socket, or any host administration interface.

Because the API is a container, `MINIO_ENDPOINT` is `http://gridgo-minio:9000` rather than a loopback URL. Production startup still enforces that this endpoint cannot leave the host: it accepts a loopback origin **or** a single-label container name, and refuses anything dotted, because a name with no dot cannot resolve in public DNS. `MINIO_PUBLIC_URL` is unchanged and separate — it is the exact origin embedded in signed URLs, and rewriting a signed URL afterwards invalidates the SigV4 signature.

Confirm nothing is published:

```bash
cd ~/gridgo/api && docker compose ps --format '{{.Name}}\t{{.Ports}}'
```

`gridgo-minio` must show only `9000/tcp` — an exposed port with no host binding in front of it. `gridgo-api` must show nothing at all.

## 6. Cloudflare Flexible TLS and proxy routing

Cloudflare owns the public TLS connection for `https://gridgo-api.talasora.com`. The DNS record must be proxied through Cloudflare and its SSL/TLS encryption mode must be **Flexible**. In [Cloudflare Flexible mode](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/), the visitor-to-Cloudflare leg is HTTPS but Cloudflare connects to the server over plain HTTP. There is no origin certificate on the box; Caddy and the container both serve plain HTTP, and **nothing may redirect HTTP to HTTPS** — behind Flexible mode that redirect returns to Cloudflare, which forwards it as HTTP again, forever.

This also means the Cloudflare-to-origin leg is not encrypted. Restricting origin port 80 to Cloudflare's proxy ranges prevents direct public bypass but does not add transport encryption. Treat this as a named hosted-pilot limitation; move to Cloudflare Full (strict) before end-to-end encryption becomes a requirement.

The API hostname has two upstreams on `gridgo-edge`:

- normal routes go to the API container, `gridgo-api:8787`;
- only `/gridgo-uploads/` goes to MinIO, `gridgo-minio:9000`.

In `~/gridgo-proxy`'s Caddyfile. Per [Caddy's site-address rules](https://caddyserver.com/docs/caddyfile/concepts#addresses), the explicit `http://` address keeps Caddy on plain HTTP and disables automatic HTTPS for this host:

```caddyfile
http://gridgo-api.talasora.com {
    # Signed GET data plane. Preserve the public Host and complete URI;
    # changing the host, path, or query invalidates the MinIO SigV4 signature.
    @signed_downloads path /gridgo-uploads/*
    handle @signed_downloads {
        reverse_proxy gridgo-minio:9000 {
            header_up Host {http.request.host}
        }
    }

    # API control plane, streamed uploads, JSON routes, and notification SSE.
    handle {
        reverse_proxy gridgo-api:8787 {
            header_up Host {http.request.host}
        }
    }
}
```

**Without the `/gridgo-uploads/*` route the JSON API works perfectly and every file download 404s**, because the API hands clients a presigned URL on `https://gridgo-api.talasora.com/gridgo-uploads/…` and MinIO — not the API — serves those bytes.

At the network edge, allow inbound origin HTTP only from Cloudflare's published proxy ranges. Configure a Cloudflare Cache Rule to bypass caching for the API hostname so authenticated JSON, SSE, and signed object responses are never served from cache.

## 7. Back up both halves

An empty recreated store is not recovery. A usable recovery point contains both the JSON metadata and the MinIO objects it references. Run a coordinated backup during a short maintenance window; stopping the API prevents new uploads and JSON mutations while the bucket is mirrored.

No `mc` on the host: it runs in a throwaway container on the private storage network, reading credentials from the same protected file the services use. `MC_HOST_…` avoids writing an alias config anywhere.

```bash
cd ~/gridgo/api
backup_root=~/gridgo/backups
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$backup_root/$backup_stamp"
mkdir -p "$backup_dir/minio"

docker compose stop api

# The store is mode 0600 owned by the container's uid 1001, so the copy runs as
# root inside the container; ownership is handed back afterwards.
docker run --rm -v gridgo_api_store:/store:ro -v "$backup_dir":/backup alpine:3.20 \
  cp -p /store/store.json /backup/store.json

docker run --rm --network gridgo-api-storage --env-file ./minio.env \
  -v "$backup_dir/minio":/backup --entrypoint /bin/sh \
  minio/mc:RELEASE.2025-07-21T05-28-08Z -ec '
    export MC_HOST_gridgo="http://$MINIO_ACCESS_KEY:$MINIO_SECRET_KEY@gridgo-minio:9000"
    mc mirror --overwrite gridgo/gridgo-uploads /backup/gridgo-uploads'

docker run --rm -v "$backup_dir":/backup -e OWNER="$(id -u):$(id -g)" alpine:3.20 \
  sh -ec 'chown -R "$OWNER" /backup'

( cd "$backup_dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z \
    | xargs -0 sha256sum > SHA256SUMS )

docker compose start api
curl -fsS -H 'Host: gridgo-api.talasora.com' http://127.0.0.1/health
```

Encrypt backups, copy them off the API host, restrict access, and retain multiple dated recovery points. The JSON contains passwords and sessions; the bucket contains private artwork and identity evidence. Schedule backups according to the maximum data loss the captain accepts, and perform a restore drill after setup and after material storage changes.

## 8. Restore and prove recovery

Choose an exact dated backup and verify it before touching the live data:

```bash
restore_dir=~/gridgo/backups/20260811T120000Z
( cd "$restore_dir" && sha256sum -c SHA256SUMS )
docker run --rm -v "$restore_dir":/backup:ro node:22-alpine node -e \
  'JSON.parse(require("fs").readFileSync("/backup/store.json","utf8")); console.log("store JSON valid")'
```

Then enter a maintenance window, stop the API, retain a safety copy, and restore both halves:

```bash
cd ~/gridgo/api
docker compose stop api

docker run --rm -v gridgo_api_store:/store alpine:3.20 \
  cp -p /store/store.json /store/store.json.before-restore

# Written under a temporary name and moved into place, so an interrupted copy
# can never leave a half-written store where the API expects a whole one. The
# 1001:1001 ownership and 0600 mode are what the API user needs to read it.
docker run --rm -v gridgo_api_store:/store -v "$restore_dir":/backup:ro alpine:3.20 \
  sh -ec 'cp /backup/store.json /store/store.json.restore
          chown 1001:1001 /store/store.json.restore
          chmod 600 /store/store.json.restore
          mv /store/store.json.restore /store/store.json'

docker run --rm --network gridgo-api-storage --env-file ./minio.env \
  -v "$restore_dir/minio":/backup:ro --entrypoint /bin/sh \
  minio/mc:RELEASE.2025-07-21T05-28-08Z -ec '
    export MC_HOST_gridgo="http://$MINIO_ACCESS_KEY:$MINIO_SECRET_KEY@gridgo-minio:9000"
    mc mirror --overwrite --remove /backup/gridgo-uploads gridgo/gridgo-uploads'

docker compose start api
```

`--remove` deletes objects in the bucket that the backup does not contain. Never point it at any alias/bucket other than the exact verified `gridgo/gridgo-uploads` restore target.

Verify `/health`, an account login, a known restored order, and a known restored file download URL before reopening traffic. Delete `store.json.before-restore` — with `docker run --rm -v gridgo_api_store:/store alpine:3.20 rm /store/store.json.before-restore` — only after the captain accepts the recovery.

## 9. Post-deployment checks

The pipeline already performs the first two and fails the run if it cannot: `/health` reports the commit the image was built from, so a stale container answering `ok` is otherwise indistinguishable from a deploy that never happened.

```bash
curl -fsS https://gridgo-api.talasora.com/health
# {"ok":true,"service":"gridgo-api","version":2,"commit":"<merged sha>",
#  "builtAt":"2026-08-11T00:38:09Z",
#  "storage":{"provider":"minio","bucket":"gridgo-uploads","status":"available",...}}
```

Check, in order:

1. `ok` is `true` and `commit` matches the commit you expect. A stale `commit` means the restart did not take the new image.
2. Storage status is `available`. `unavailable` means JSON routes are alive but uploads and downloads are not; check `docker compose ps` and the bucket credential match between the two env files.

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

On a fresh store, authenticated `/orders`, `/notifications`, `/claims`, and `/issues` lists must be empty. Complete one controlled end-to-end upload and signed download before accepting real artwork, then confirm the signed URL uses HTTPS on `gridgo-api.talasora.com` and expires. That last step is also what proves the proxy's `/gridgo-uploads/*` route (§6) is in place.

On the server:

```bash
cd ~/gridgo/api
docker compose ps            # gridgo-api and gridgo-minio Up and (healthy)
docker compose logs --tail 50 api
```

## 10. Rollback

Every successful build leaves an immutable `sha-<12 chars>` tag in the registry, so rolling back is pinning the tag the compose file resolves. `image:` reads `${GRIDGO_API_TAG:-latest}`, and Compose reads `.env` from the compose directory.

```bash
cd ~/gridgo/api
echo 'GRIDGO_API_TAG=sha-0123456789ab' > .env     # a known-good tag
docker compose pull && docker compose up -d --wait
curl -fsS https://gridgo-api.talasora.com/health  # commit must be the older one
```

A rollback replaces the container, not the volumes: **no data is lost by rolling back**. It does not undo a data migration, though — the load-time backfills are additive and idempotent, but an older image is not guaranteed to understand a newer store shape. Check `docs/OPERATIONAL_MODEL_V2_API.md` before rolling back across a migration.

While `.env` pins a tag, **CI deploys stop having any effect** — `deploy.sh` pulls and restarts, but the pinned tag never moves. That is the point during an incident, and a trap afterwards. To hand control back:

```bash
cd ~/gridgo/api && rm .env && docker compose pull && docker compose up -d --wait
```

If the registry pull itself fails (`no basic auth credentials`), the server is not logged in — that credential is supplied per-run by CI and removed on exit, by design. Re-run the workflow rather than storing a token on the box.

Rolling forward from a bad commit is usually better than pinning: revert on the default branch and let the pipeline ship it.

## 11. Pilot limits and database migration signals

Treat these as operating guardrails, not benchmarked capacity promises:

- Exactly one API process and one writable store file; no replicas or shared-network filesystem. Never scale the `api` service above one replica: in-process serialization protects one process only, and two would overwrite each other's mutations.
- One host is a failure domain. Recovery depends on tested off-host JSON plus object backups.
- Every mutation serializes and rewrites the whole JSON document synchronously. Keep `store.json` below 25 MiB during the pilot and alert on growth.
- Keep sustained mutating traffic below 5 requests/second and investigate p95 mutation latency above 500 ms. File bytes go to MinIO, but file metadata still grows the JSON store.
- Keep concurrent notification streams and active users to small pilot cohorts; the process owns all live SSE connections in memory.
- A deploy replaces the container, so there is a short gap where requests fail; coordinated backups need a brief maintenance window. There is no automatic failover or point-in-time recovery.
- Passwords use the current custom-auth store format rather than a production identity provider; protect the store and backups as secrets and limit pilot access.
- Cloudflare Flexible mode leaves the Cloudflare-to-origin leg unencrypted; keep the origin restricted to Cloudflare proxy ranges and treat Full (strict) migration as a security milestone.

Move to a transactional database and production identity system before any of these becomes true: a second API instance is needed; zero-downtime deploys or point-in-time recovery are required; the store reaches 25 MiB or routinely takes more than 500 ms to mutate; write contention/errors appear; backup or restore misses the captain's recovery objective; access/audit requirements exceed file permissions; or real platform-processed money/provider webhooks are introduced. Preserve the documented route contracts during that migration.

## Related

- Portal deployment and its own pipeline: `docs/DEPLOYMENT.md` in `gridgo-web`. The portal and this API share the `gridgo-edge` network and the same restricted deploy key.
- File, upload and signed-download contracts: `docs/STORAGE_API.md`.
