# gridgo-api

Custom backend for all GRIDGO apps. Read `PRD.md` for product intent, `README.md` for local operation, and `docs/DEPLOYMENT.md` for production.

## Persistence

- PostgreSQL 17 is the only domain store. `src/database.js` owns connections/transactions; `src/postgres-store.js` is the reviewable route compatibility adapter.
- Ordered forward migrations live in `migrations/` and run with `npm run migrate`. Never create or repair schema at application boot.
- Money is signed PostgreSQL `BIGINT` integer PHP minor units and must remain within JavaScript safe-integer range. Never use floats.
- Every HTTP mutation runs in one transaction with a transaction-scoped advisory lock. Money/order/credit/claim/issue changes, audit rows, and notifications commit atomically.
- MinIO owns file bytes. PostgreSQL stores metadata, private object keys, and opaque file references only.
- Fresh `npm run seed` is idempotent reference data only: catalog, taxonomy, zones, settings, formats, starters. It must never create users or operational records and has no destructive reset.
- Local development only: `npm run seed:dev` (and local compose) additionally seeds three Davao shops against real development Clerk users, including Lovis Printshop for `felyciaaa0220@gmail.com`. Production compose must keep `npm run seed`.

## Clerk-only identity

- `src/auth.js` verifies Clerk session JWTs. `CLERK_SECRET_KEY`, `CLERK_ISSUER`, and `CLERK_AUTHORIZED_PARTIES` are mandatory; issuer must match exactly. Do not pass `authorizedParties` into `verifyToken` (Clerk rejects a missing `azp`). Present `azp` values must be on the allowlist; Expo session tokens that omit `azp` are accepted after signature/expiry/issuer checks.
- There is no `AUTH_MODE`, password login, local signup/session, or demo password. `/auth/login` and `/auth/signup` remain `404`. The Lovis Printshop row is local `seed:dev` only and still maps a real Clerk subject.
- `POST /auth/clerk/activate` is the explicit first-use Google/public SSO path. It only creates an `individual` client or idempotently adds a personal client membership to an already-mapped identity; it never links by email or grants another role.
- `users.clerk_user_id` maps the Clerk subject. PostgreSQL membership rows are the authorization source; ignore Clerk role/status claims and metadata for authorization.
- Supplier/rider memberships come only from their fixed enrollment endpoints or an audited database role assignment; Operations and Super Admin remain assignment-only. Supplier/rider work also requires Operations approval.
- Migration `1786843800000` adds `user_role_memberships`, role profile, approval-case, and `rider_documents` tables backfilled from legacy `users` columns. Auth context resolution, the fixed `/auth/me` projections, admin bootstrap, role management, and verification-decision sync now consume memberships and approval cases. Legacy `users.role` and its related columns remain authoritative only for untouched consumers during the one-release compatibility window — do not drop them.
- First administrator bootstrap is the direct CLI `npm run bootstrap-admin -- --clerk-user-id user_...`. It works only while no ops/super row exists, writes audit plus an immutable completion marker, and then refuses permanently. Never add an HTTP bootstrap path.
- `publicUser` never exposes `clerkUserId` or verification document IDs.

## Operational model

The exact contract is `docs/OPERATIONAL_MODEL_V2_API.md`.

Client preference ranking, shop matching, carts, multi-supplier jobs, QR 75/25 checkout, QA, and invoices are defined in `docs/ORDER_MATCH_API.md`.

- Match and cart responses must run through `decorateCatalogPhotoUrls` (`src/catalog-photo-urls.js`) the same way catalog does. `publicPhotos` only sets metadata `url` (`/catalog/media/:fileId`); the client needs signed `downloadUrl` on `body.listings` and `body.cart.lines[].listing`. Skipping the decorator is the empty match thumbnail. `POST`/`PATCH`/`DELETE` `/me/carts/:id/lines` return compact listing stubs without photos so add/save does not wait on MinIO signing; `GET /me/carts/:id` stays the full projection.
- The client service fee is seeded at 1,000 bps on the supplier subtotal; accepted quotes snapshot the rate, amount, fulfillment, and generalized online/direct allocation plan. COD and supplier-proof approval states are retired.
- Clients receive the item subtotal, service fee, delivery pass-through, total, and their payment plan, but never supplier payout or milestone amounts. All order responses go through the role-aware projection in `src/operational-model.js`. `publicOrderFor` is a deny-list, so any new field on `orders.data` is visible to every party until it is stripped there — `physicalInvoiceRequest` is owning-client and ops/super only.
- Rider delivery split settings, immutable order/job snapshots, legacy pass-through preservation, and earnings fields: `docs/OPERATIONAL_MODEL_V2_API.md#rider-delivery-split`.
- Claims/issue holds block payout. Confirmed supplier-principal collection caps automatic supplier payout. Rider pickup uses the six-check gate, and six passes move nothing on their own: `POST /dispatch/:id/pickup-checklist` needs `signature.fileId` naming a `handoff_signature` file the rider attached, else `409 handoff_signature_required`. Contract, refusal codes and projection rules: `docs/OPERATIONAL_MODEL_V2_API.md#supplier-handoff-signature`. New purposes and order fields ride in `files.purpose` (free text) and `orders.data` jsonb, so this needed no migration.
- Client `accountType` is `individual | business | organization`; activation defaults to `individual`. Never infer it from `orgName`; non-client roles omit it. `POST /me/business-application` (and legacy `POST /me/business-apply`) opens a pending `business_client` case — do not flip `accountType` until Operations approves it. A pending application lives on its approval-case snapshot, never on the profile: `client_profiles_check` forbids business fields on a personal row and stays, because nothing clears them on reject.

## Geography

Orders snapshot `pickup` and `dropoff`; supplier users may have a shop point. Existing order pickup/money never changes when a shop moves. Rider pings are authorized to the assigned/related parties. Rider location and Operations map contracts: `docs/OPERATIONAL_MODEL_V2_API.md#rider-location`.

Coordinates use constrained latitude/longitude columns. Current database queries select an order point or the latest ping by order/time, so PostGIS is intentionally absent. Add it only with a forward migration when radius/nearest-neighbor SQL exists.

## Taxonomy and supplier services

`docs/TAXONOMY_API.md` is authoritative. The store is flat: references hold category codes and `categoryTree` is derived per request. Retired input aliases still resolve, but supplier service records are not silently rewritten.

A category or subcategory can be deleted (`DELETE /taxonomy/{categories,subcategories}/:idOrCode`, `src/taxonomy-delete.js`) only when nothing stands on it and the build does not seed it; everything else is a `409` with a usage breakdown, never a cascade. The seed appends missing taxonomy rows, so a shipped entry is retired with `active: false`, never deleted.

Supplier service states are `draft | pending_verification | live | suspended | withdrawn`. Only approved suppliers with eligible live services can be matched; assignment remains manual.

Shop listings live under a service line (`docs/SUPPLIER_CATALOG_API.md`). They never create matchable capability. Additive fields are `subcategoryCode`, `pricingUnit`, `packageQty`, and inherit/override turnaround. Tarpaulin listings (`tarpaulins_outdoor_banners`) require integer `printerMaxWidthFeet` (1–20); other families store null. Starters are copied at create time. Shop-board hunt is `GET /me/catalog-items?q=` (PostgreSQL `search_tsv` + `pg_trgm` on `supplier_catalog_items`); it does not affect matching and is not a second search product.

## Files and push

`docs/STORAGE_API.md` is authoritative. File states are `pending_upload | ready | delete_pending | deleted`. Supplier and rider verification documents stay private to their respective owner and ops/super.

- `save()` is the notification/outbox and realtime enqueue boundary; delivery occurs after commit. Do not send at individual notification append sites. Queue invalidates with `queueInvalidate` / `queueOrderInvalidate` before `save()`; delivery contract: `docs/REALTIME_EVENTS.md`.
- Push failure must never fail its trigger. FCM v1 stays on `node:crypto` + `fetch`; do not add `firebase-admin`.
- One token belongs to one `user.id`. Anonymous registration is hostile input and exposes only a fixed `{ok:true}` body.
- Unclaimed handsets may receive only `everyone` announcements with `data` exactly `{type:"announcement"}`.
- Prune `INVALID_ARGUMENT` only when the violation identifies `message.token`.
- Push payload data is allowlisted to `notificationId`, `type`, `orderId`, and `at`.
- Every implemented domain event writes a durable inbox row to each current `ops_admin` and `super_admin` membership (`privilegedAdminMemberships` in `src/notifications.js`). Super Admin is never invalidate-only. Contract: `docs/REALTIME_EVENTS.md`.

## Deployment

`deploy/docker-compose.yml` is the server copy but CI never installs it. PostgreSQL uses named volume `gridgo_postgres_data` and private network `gridgo-api-storage`; it has no production host port. API and MinIO container names are proxy addresses and must remain stable.

Every merge to the default branch builds/tests/publishes and invokes the restricted deploy command. CI must keep proving the named PostgreSQL volume survives both API replacement and database-container recreation.

MinIO and `mc` images are the pinned `quay.io/minio/...` release tags in compose and CI smoke; Docker Hub `minio/minio` is withdrawn.

Uploads spool to `$PWD/.tmp/uploads`; the image must keep it writable by uid 1001. `/health` reports database, storage, push, `commit`, and `builtAt`.

## Constraints

- Plain `node:http`; approved direct dependencies are `pg`, `node-pg-migrate`, `minio`, `@clerk/backend`, and `nodemailer`.
- Authorization on every non-public route; errors use `{ error: "snake_case" }`.
- Public landing support tickets live in `support_admins` / `support_tickets` (`src/support-desk.js`). They use `DATABASE_URL` through `database.query` / transactions, not a second Pool. Desk login is username/password hashed at boot from `SUPPORT_DESK_*`; session tokens use `SUPPORT_DESK_JWT_SECRET` (not Clerk). Gmail replies are optional via `EMAIL_USER` / `EMAIL_PASSWORD`.
- Public issue reports from the landing `/report` page live in `issue_reports` / `issue_report_screenshots` (`src/issue-reports.js`, contract `docs/ISSUE_REPORTS_API.md`). Filing is public; reading and marking use the support desk token.
- Do not add JSON persistence, a JSON importer, local auth fallback, seeded users, or file blobs in PostgreSQL.
- For local live-data experiments, use an isolated database and free high API port. Never target another lane or use broad process-kill commands.

## Maintaining this file

Record only durable project knowledge useful to almost every future session. Prefer pointers to authoritative files over duplicated detail, and keep entries short.
