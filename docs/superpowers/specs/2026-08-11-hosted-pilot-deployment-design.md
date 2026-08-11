# Hosted Pilot Deployment Design

## Goal and boundary

GRIDGO will support an explicit hosted-pilot mode selected by `NODE_ENV=production`. It remains a single-process Node API with a JSON file store and private MinIO object storage. The mode is safe for a small, manually operated Davao pilot; it is not presented as a fully redundant production architecture.

The production fresh-store boundary is deliberate:

- Platform reference data is retained: the request catalog, product taxonomy, operational settings, and Davao zones.
- The six fixed pilot/demo identities are retained because the captain requires them, but each identity receives a distinct deployment-configured password.
- Operational data starts empty: supplier services, orders, files, credits, claims, issues, audit entries, notifications, location pings, escalations, proofs, and sessions.

Local development continues to use the existing rich seed, including its repository-visible development password and all scenario fixtures. Production never falls back to that password.

## Considered approaches

### Recommended: environment-aware configuration and seed profiles

A focused runtime-configuration module owns production detection, password resolution, production storage checks, and CORS allowlist parsing. The existing seeder chooses either its unchanged rich local store or a minimal production store. Server load-time convergence uses configured fixture users in production and retains its existing local behavior.

This keeps one authoritative identity definition and one authoritative set of reference data while making the environment difference explicit and testable.

### Rejected: seed rich data and scrub it afterward

Deleting demo collections after constructing or loading them risks omissions as new fixture collections are added. It also creates an unsafe interval and makes the intended production contents difficult to audit.

### Rejected: duplicate production seeder

A second independent seed script would initially be simple, but taxonomy, settings, zones, identity fields, and collection shapes would drift. The existing seed-consistency requirement favors shared definitions with two explicit output profiles.

## Configuration and startup

Production requires all six password variables: `GRIDGO_CLIENT_PASSWORD`, `GRIDGO_INDIVIDUAL_PASSWORD`, `GRIDGO_SUPPLIER_PASSWORD`, `GRIDGO_RIDER_PASSWORD`, `GRIDGO_OPS_PASSWORD`, and `GRIDGO_ADMIN_PASSWORD`. Every value must be at least 12 characters and must not equal the committed local-development password. Missing or unsafe credentials stop the process with a message naming the variable and the exact repair.

Production server startup also requires a non-wildcard `CORS_ALLOWED_ORIGINS`, a loopback `MINIO_ENDPOINT`, explicit MinIO API credentials, and an HTTPS `MINIO_PUBLIC_URL`. Seeding needs only the configured account credentials, so operators can create the store before bringing storage or TLS online.

An explicit custom `STORE_PATH` is never silently created by server startup. Operators run the production seed command once; a missing path produces a startup error that gives that command. This prevents a typo from looking like a successful but empty recovery.

## Fixture convergence and migration safety

In local development, fixture convergence retains its existing behavior: create missing allowlisted fixture identities and rotate only the retired shipped credential.

In production, the configured password for each allowlisted fixture identity is authoritative on every load. Changing an environment password therefore rotates that identity on the next restart. Production backfill does not fabricate the two demo supplier services. Backfills remain additive and idempotent for all real operational records; production mode never deletes data to manufacture a clean store.

Operators must create a fresh production store rather than reuse a development store. This is documented as a deployment invariant and verified by the clean-seed test.

## Cross-origin behavior

`CORS_ALLOWED_ORIGINS` is a comma-separated list of exact HTTP(S) origins. Startup rejects wildcard, credential-bearing, path-bearing, query-bearing, fragment-bearing, or malformed entries. Requests without an `Origin` header remain valid for mobile apps, command-line health checks, and same-origin server calls.

When a browser sends an allowed origin, normal responses, preflight responses, errors, and notification SSE responses echo that exact origin and include `Vary: Origin` plus credential support. A browser request from any other origin receives `403` with `origin_not_allowed` and a concrete configuration fix. No response emits `Access-Control-Allow-Origin: *`.

## Object storage and TLS

The API remains the upload/control plane. Signed downloads use the Cloudflare-provided HTTPS public origin. Caddy accepts Cloudflare Flexible TLS traffic over plain origin HTTP, serves Node routes for `gridgo-api.talasora.com`, and forwards only the private bucket path to loopback-bound MinIO while preserving the public host and request URI required by SigV4. The server has no certificate or HTTPS redirect, and the MinIO console stays loopback-only and is never reverse proxied.

The dashboard uses `https://gridgo-api.talasora.com` as its API base, while the API allowlists exactly `https://gridgo-dash.talasora.com`. Cloudflare terminates visitor TLS and connects to Caddy over HTTP; Node and MinIO listen only on loopback high ports.

## Recovery and operational limits

The deployment guide defines a coordinated backup of both `store.json` and the MinIO bucket, plus a restore drill that validates JSON, restores both halves, starts the service, and verifies health, authentication, and a known file. Creating a new empty store is explicitly not recovery.

The guide names the pilot limits: one API writer/process, no horizontal replicas, brief write stalls during synchronous snapshots, no database constraints or query indexes, plaintext custom-auth passwords in the protected store, and operator-managed failover. Sustained latency, growing store size/write duration, concurrent usage, need for zero-downtime deploys, multi-instance requirements, or recovery objectives beyond the tested backup procedure are migration signals.

## Verification

Automated tests cover production startup refusal without configured credentials, a clean production seed, unchanged rich development seed, allowed and rejected origins, successful production startup, and two-load byte stability. Manual verification uses a temporary store and free high port, captures and stops only its exact child PID, confirms health and empty collections with configured credentials, and confirms startup refusal without them.
