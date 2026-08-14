# gridgo-api

Local **custom** demo backend for all GRIDGO apps.

## MVP

- Legacy JSON sessions plus opt-in Clerk session verification (default `AUTH_MODE=legacy`)
- JSON store (no Supabase)
- Pilot Credits grants plus manually confirmed QR installments (no PayMongo, no COD)
- Replaceable: keep route contracts stable
- Platform-governed **service taxonomy** + supplier services (blueprint §4.2)
- Ops/super: users, roles, verification, zones, grants, claims, issues, audit

See `PRD.md` and `README.md` for full route tables and field shapes.

## Clerk authentication transition

`src/auth.js` owns `AUTH_MODE=legacy|dual|clerk` and all Clerk session verification. Dual mode accepts only the existing `tok_*` family as legacy; every other bearer is sent to `@clerk/backend` and can never fall back to the JSON session store after verification fails. Clerk identity maps only by additive `User.clerkUserId`; issuer and `azp` must match environment allowlists, and `gridgo_role` must exactly match local `User.role`. `publicUser` never exposes the link.

`dual` and `clerk` refuse startup without `CLERK_SECRET_KEY`, `CLERK_ISSUER`, and `CLERK_AUTHORIZED_PARTIES`. The hosted `talasora` deployment stays `legacy` until a separate cutover. In dual/Clerk modes, public signup is client-only; supplier/rider roles remain Operations-assigned and no signup route writes Clerk metadata.

## Geography (map / OSRM)

Orders carry additive map points so apps never geocode at runtime:

- `pickup: { lat, lng, label } | null` — supplier shop; **null** until a supplier is assigned
- `dropoff: { lat, lng, label }` — client delivery point; `label` matches `address`
- Keep existing `address` and `zone` strings unchanged

Supplier users may have `shop: { lat, lng, label }`. Order `pickup` is derived from that shop. Coords are real **Davao City** anchors (centre ~`7.0731, 125.6128`); zone-based dropoffs use a small deterministic offset so pins do not stack.

`PATCH /users/:id/shop` lets a supplier correct only their own pin; ops/super may correct any supplier. Existing order pickup/money fields are snapshots and are never repriced by a profile move.

Rider tracking:

- `POST /dispatch/:id/location` — assigned rider pings while `picked_up` / `out_for_delivery`
- `GET /dispatch/:id/location` — latest ping (`{ ping }` or `{ ping: null }`); no staleness verdict
  - Allowed: assigned rider, order client, assigned supplier, ops/super admin
  - Else `403` `{ error: "forbidden" }`

## Operational model v2

The exact rebuild contract is `docs/OPERATIONAL_MODEL_V2_API.md`; file bytes/attachments remain in `docs/STORAGE_API.md`. V2 uses self-signup, approved-only supplier/rider matching, 10%-on-top commission, configurable distance bands, manually confirmed 75%/25% digital payments, POF-gated supplier milestones, a global expiring issue window, and the six-check rider pickup gate. COD and the supplier-proof approval states are retired.

Money/order visibility must go through the role-aware projection in `src/operational-model.js`: clients never receive supplier price, commission, or supplier milestone amounts. `backfillOperationalModel()` is the load-time migration and must remain idempotent.

## Client account type (branding)

Client users have explicit `accountType`: `"individual"` | `"business"` | `"organization"`. Signup accepts the human label `"personal"` as an alias for stored `"individual"`. Returned via `publicUser` on signup/login, `/auth/me`, and user directory. **Never infer from `orgName`.**

- Missing/legacy clients backfill to `"individual"` (safe default; business is opt-in)
- Self-signup is the write path; business/organization require `orgName`
- Non-client roles: field absent (not null)
- Demo: `client@gridgo.ph` = business; `individual@gridgo.ph` = individual

## Product category taxonomy

The captain's category chart (4 categories, 17 subcategories) is the product taxonomy. **Exact contract: `docs/TAXONOMY_API.md`** — mobile workers build against that file.

- One rule: every category reference is the category `code`, held on the *referring* record (`subcategory.categoryCode`, `material.categoryCodes[]`, `finish.categoryCodes[]`). Categories never list their children; nothing is nested in the store.
- `GET /taxonomy` also returns `categoryTree`, derived per request from the flat collections and never persisted. Never write it back.
- Pre-chart codes (`large_format`, `offset`, `apparel_sublimation`, `signage`) are retired into `taxonomy.categoryAliases`, not deleted; they still resolve on input. `supplierServices[].categoryCode` keeps whatever it was stored with — resolve through aliases, never rewrite captain-owned service records.
- Definitions, mapping table and `backfillTaxonomy()` all live in `src/taxonomy.js`; `seed.js` and the server share it so a seeded store and a backfilled store match.

## Phone push (Firebase Cloud Messaging)

Notifications reach phones three ways: `GET /notifications`, the SSE stream, and FCM push. Contract for the apps is `docs/OPERATIONAL_MODEL_V2_API.md` → *Push notifications*; operator install/rotation is `docs/DEPLOYMENT.md` §2a. Firebase project `gridgo-c2ce9`; `src/push.js` holds both the device-token store rules and the FCM v1 client.

- **`save()` is the only place a *notification* push fires.** It already computes which notifications are new (for SSE), so hooking there is what makes every push correspond to exactly one readable notification, emitted once, with no call site able to forget it. Never add a send at a `store.notifications.push(...)` site. The one non-notification push — the anonymous half of an `everyone` announcement — has no record to hook and exactly one call site (`deliverAnnouncementPush`, `POST /announcements`).
- **A failed push may never fail its trigger.** `deliverPush` is fire-and-forget and cannot reject; the payout/payment/transition is already on disk when it runs.
- **FCM v1 with no new dependency**: `node:crypto` signs the RS256 service-account assertion, the OAuth2 access token is cached for its lifetime and shares one in-flight mint. `firebase-admin` stays out (see Constraints).
- **One token belongs to one user.** Re-registration under a second account moves it; two rows for one token puts one person's orders on another's lock screen. A foreign token on unregister returns `404`, not `403` — the value is caller-suppliable, so `403` would be an ownership oracle.
- **A registration keys on `user.id`, never on the login.** That is why the fixture email domain migration renames an account without orphaning its phone, and `migrateFixtureEmailDomain()` refuses at startup if a `deviceTokens` record is ever found holding an address instead. See *Email is a login key, never a foreign key* below.
- **A registration may have no user.** `userId: null` is an *unclaimed* handset — installed but never signed in, or signed out. Signing in claims it, signing out releases it back (never deletes: that would kill the app-update channel exactly when a phone needs it). Sole purpose: `POST /announcements` with `audience: "everyone"` is the only thing that reaches these devices; a role-targeted audience never can, because an unclaimed device has no role.
- **The stranger boundary is enforced at the wire, not by convention.** `pushDelivery.send()` refuses any batch containing an unclaimed device unless the message is `announcementPushMessage(...)` (`data` exactly `{type:"announcement"}`); `deviceTokensFor()` returns `[]` for a null/empty caller so a personal fan-out can never resolve to "every anonymous phone". Both are regression-tested — a comment would not survive.
- **`POST /devices` is the platform's only unauthenticated write**, so it is treated as hostile input: FCM token *shape* required, fixed `{ok:true}` body that reveals nothing about what was stored, a claimed row never mutated by an anonymous call, and a bounded unclaimed pool that evicts least-recently-seen rather than refusing (a refusal would let one script close the channel to every genuine install). No per-IP limit — behind Cloudflare and the proxy every request shares one source address. Rationale in `src/push.js`; contract in `docs/OPERATIONAL_MODEL_V2_API.md`.
- **`INVALID_ARGUMENT` is not "dead token".** FCM returns it for a malformed *message* too; prune only when the field violation names `message.token`, or the whole fleet disappears the first time a payload bug ships.
- **Push payload `data` is an allowlist** (`notificationId`, `type`, `orderId`, `at`), so money added to a notification record can never reach a lock screen.
- **Push never blocks startup.** A missing or broken credential disables it and reports the reason on `/health` (`disabled` / `misconfigured`), because every merge auto-deploys and Docker turns an uninstalled bind-mounted secret into a directory.

## Platform data (ops / super / matching)

- Notification state and caller-scoped SSE delivery are server-owned; exact contracts are in `docs/OPERATIONAL_MODEL_V2_API.md`. Notification creation stays append-only because list snapshots/SSE resume use append order; atomic `save()` emits new records. Deletes retain lifecycle evidence with `deletedAt`.
- `GET|POST /devices`, `POST /devices/unregister` — caller-owned FCM registrations, or unclaimed when called with no bearer token; `POST /auth/login` accepts `{deviceToken}` to claim and `POST /auth/logout` to release, so neither sign-in nor sign-out can strand a phone.
- `POST /announcements` — ops/super; one general message to `everyone | clients | suppliers | riders | ops`, audited. `everyone` is the app-update channel and the only audience that reaches unclaimed handsets.
- `GET /taxonomy` — categories, subcategories, aliases, materials, finishes (super manages via POST/PATCH)
- `GET|POST|PATCH /supplier-services…` — supplier catalogue; states `draft|pending_verification|live|suspended|withdrawn`
- `GET /orders/:id/eligible-suppliers` — ops matching support (no auto-assign)
- `GET /users?role=` — publicUser only (never passwords)
- `PATCH /users/:id/role` — super_admin; audited
- `POST /users/:id/verification` — ops/super for supplier/rider
- `GET|POST|PATCH /zones` — legacy address-zone records; v2 fees come from global distance bands in `/settings`
- `POST /credits/grant` — super_admin Pilot Credits grant
- `GET|POST /claims…` + hold/release — payout holds; blocks `payout_released` while held
- `POST /orders/:id/issues` — client report in `issue_window_open` → auto claim hold
- `GET /audit` — platform audit log (separate from per-order `timeline`)

**Audit vs timeline:** `order.timeline` is per-order lifecycle; `auditLog` is platform-wide for ops/super (roles, grants, taxonomy, verification, claims).

## Seed, backfill & fixture convergence

Fresh-store fixture definitions live in `src/seed.js`; demo user identities live in `src/demo-fixtures.js` (shared by seed + server). Treat reset as destructive and use load-time migration for existing stores.

**Three different load-time migrations — do not conflate them.** They run in this order in `load()`:

| | Fixture email domain migration | Backfill | Fixture convergence |
|---|---|---|---|
| Purpose | Rename the six shipped identities off the retired `@gridgo.local` addresses | Fill *missing* fields/collections so old stores keep working | Bring *seed demo accounts* up to their defined state |
| Scope | only `user.email`, only for an exact address in `RETIRED_FIXTURE_EMAILS` (`src/demo-fixtures.js`) | geography, platform arrays, top-level `files` and `deviceTokens`, parent file-ID arrays, missing client `accountType` → `"individual"`, taxonomy → captain's category chart, and v2 order/settings migration via `backfillOperationalModel()` | only users allowlisted in `DEMO_USERS` (`src/demo-fixtures.js`) |
| Overwrite? | Yes — the retired address only; validates every identity before mutating any | Fill-missing except documented v2 retirement normalization for COD, supplier-proof states, and removal of obsolete zone fees; never overwrite existing valid values/coords | Yes — only on fixture users (e.g. `client@` → `accountType: "business"`); password rotates only from the exact retired shipped credential and preserves diverged values. **Never `email`** — that is this migration's job alone |
| Creates? | nothing | empty platform collections if absent | missing demo accounts (e.g. `individual@gridgo.ph`) |
| Never touches | `user.id`, any account whose address diverged from the shipped fixture, any other collection | existing valid values, coords, file metadata, or legacy `artworkName` | orders, credits, proofs, claims, issues, sessions, pings, non-fixture users |

**Fixture boundary:** match by exact fixture email, else stable seed id — never by role or bare `@gridgo.ph` domain. Getting this wrong is how a migration eats captain work.

**The identity domain is `@gridgo.ph`.** `@gridgo.local` is retired: `.local` is reserved for multicast DNS and cannot address the hosted API. The client/rider/supplier apps and `gridgo-web` hardcode these logins in their own login screens and tests — this repo's rename does not reach them, so treat a `.local` login there as a separate, still-open change.

**Email is a login key, never a foreign key.** `user.email` is read in exactly two places — login lookup and signup duplicate detection. Orders, sessions, credits, claims, issues, notifications, device push registrations and pings all reference `user.id`. That is what makes an in-place rename safe and a reseed unnecessary; keep it true, and never denormalise an email into another record.

**A migration that cannot proceed safely must refuse, not improvise.** `migrateFixtureEmailDomain()` throws (naming both account ids, mutating nothing) when the retired and replacement addresses both exist, because two accounts on one login breaks auth and orphans whatever the loser owned. Same precedent as `assertProductionStoreHasNoDemoOperationalData()`: a loud startup refusal is recoverable by hand; silent data merging is not.

**Existing live stores:** all three run idempotently on every `load()` — a second run must leave the store byte-identical. Never reset a live/demo store to acquire new fields; reset wipes captain demo orders.

Fresh seed consistency is regression-tested in `tests/seed-consistency.test.js`; keep supplier-authored prices round and derive all order money and delivery bands through `src/operational-model.js`.

## Running your own instance

The captain's demo API owns port **8787** and its store at `data/store.json`. To try anything against real data, copy the store and run your own instance with `STORE_PATH=<copy> PORT=<free high port> node src/server.js` — several lanes run this repo at once, so pick a port only after checking it is free.

**Stop it by the exact PID you captured at start.** Never `pkill -f`/`killall` on `src/server.js`: the pattern matches the captain's demo and every other lane's instance too.

## Hosted pilot deployment

The production environment, clean-seed boundary, dashboard-only CORS policy, Cloudflare Flexible TLS/proxy topology, unpublished MinIO, secret files and rotation, coordinated backup/restore, rollback, and JSON-store migration signals are authoritative in `docs/DEPLOYMENT.md`. `NODE_ENV=production` requires distinct environment-owned passwords for all six fixed pilot identities, never falls back to the committed local-development credential, and refuses known rich-demo operational records before mutating the store.

Every merge to the default branch ships: `.github/workflows/deploy.yml` builds `Dockerfile`, smoke tests the image, publishes to GHCR, then runs the one restricted command the deploy key allows (`ssh … api`, registry token on stdin). Pull requests build but never publish and never deploy. `deploy/docker-compose.yml` is the server's copy at `~/gridgo/api/docker-compose.yml`; **CI never writes to the server**, so changing it here requires an operator to copy it across.

Four things about this deployment are load-bearing and easy to break:

- **The store is on the `gridgo_api_store` volume, not in the container.** A deploy replaces the container. Anything that moves `STORE_PATH` into the image layer destroys every account, order and payment record on the next merge.
- **Container names are addresses.** The proxy resolves `gridgo-api:8787`, and `/gridgo-uploads/*` resolves `gridgo-minio:9000` for signed GETs. Renaming either takes the API — or every file download — off the internet.
- **MinIO publishes no host port at all**, and `MINIO_ENDPOINT` is a container name. Production startup accepts loopback *or* a single-label host (undotted names cannot resolve in public DNS) and refuses anything routable; see `requireStorageOrigin` in `src/runtime-config.js`.
- **Uploads spool to `$PWD/.tmp/uploads` before streaming to MinIO**, so the image must create that directory writable by its own uid. Miss it and `/health` stays green while every upload 500s.

`/health` carries `commit`/`builtAt` from image build args purely so a deploy can be proven to have taken; a stale container answering `ok` is otherwise indistinguishable from no deploy at all.

## Constraints

- Plain `node:http` only except the `minio` S3 SDK and the approved `@clerk/backend` verifier; do not hand-roll JWT crypto or add other direct npm dependencies. FCM push remains deliberately hand-rolled on `node:crypto` + `fetch` rather than `firebase-admin`
- Do not change unrelated QA edges/role rules; payment, POF milestones, checklist, delivery, and issue expiry follow `docs/OPERATIONAL_MODEL_V2_API.md`
- Authorisation on every route; `{ error: "snake_case" }`

## Object storage and fulfilment evidence

- The authoritative mobile contract is `docs/STORAGE_API.md`; the API streams uploads and authorizes short-lived presigned MinIO GETs. `MINIO_ENDPOINT` and fixed `MINIO_PUBLIC_URL` are separate.
- New milestone POF uses purpose `fulfilment_proof`; supplier-proof approval states and new `proof` uploads are retired. Legacy `proofFileIds` remain readable evidence.
- Files use `pending_upload|ready|delete_pending|deleted`; top-level metadata owns the private `objectKey`, while orders/services reference opaque `fileId` values only. Legacy `order.artworkName` stays valid and is never file identity.
- Supplier identity evidence uses private `verification_document` files attached to the uploader's own `verificationDocumentFileIds`; exact types, replacement behavior, and strict owner/ops/super reads are in `docs/STORAGE_API.md`. Never expose those IDs through general `publicUser` projections.

## Maintaining this file

Record only durable project knowledge useful to almost every future session. Prefer pointers to authoritative files over copying detail. Keep entries short.
