# GRIDGO API — Product Requirements

> The exact mobile/API state contract is `docs/OPERATIONAL_MODEL_V2_API.md`. File and taxonomy contracts are `docs/STORAGE_API.md` and `docs/TAXONOMY_API.md`.

## Purpose

GRIDGO is a centralized Davao printing platform connecting clients, accredited print suppliers, riders, Operations, and Super Admin. The API supports the Order → Print → Deliver lifecycle while keeping platform governance and money movement under server control.

## Platform foundations

- PostgreSQL 17 is the only domain persistence system. MinIO stores private file bytes; PostgreSQL stores metadata only.
- Clerk is the only identity/session provider, including Google sign-in. GRIDGO roles remain authoritative in PostgreSQL.
- Money uses integer PHP minor units. A client service fee is added to the supplier subtotal and collected in the initial online installment; later online/direct-at-store amounts follow the accepted payment plan. COD is unavailable.
- Fresh seed creates catalog, taxonomy, zones, and settings only. It creates no accounts or operational data.

## Roles and onboarding

| Role | Provisioning | Operational gate |
|---|---|---|
| client | Clerk sign-in then `POST /auth/clerk/activate`; optional fixed business application | personal access is immediate; business capabilities require approval |
| supplier | Clerk sign-in then fixed supplier enrollment; an existing identity keeps its other memberships | Operations approval required for live services and matching |
| rider | Clerk sign-in then fixed rider enrollment, document intake, and explicit submit | Operations approval required for dispatch |
| ops_admin | Super Admin role assignment | database role is authoritative |
| super_admin | one-time CLI bootstrap for the first admin; later audited role assignment | database role is authoritative |

The API stores no passwords and issues no sessions. `/auth/login` and `/auth/signup` are removed. Client-settable Clerk metadata never grants a GRIDGO role.

Client users have explicit `accountType: individual | business | organization`. Activation defaults to `individual`; a business application explicitly creates the business profile, and the type is never inferred from `orgName`. Non-client roles omit the field.

## Product and supplier catalogue

The platform-governed taxonomy contains four categories and seventeen subcategories. Materials and finishes reference flat category codes. `GET /taxonomy` derives `categoryTree` per response and never persists it.

Supplier service states are `draft | pending_verification | live | suspended | withdrawn`. Operations/Super Admin verifies live capability. Matching remains explainable and manual: an approved supplier needs at least one live service covering product family, material, quantity, and zone.

## Orders, money, and fulfilment

- Orders snapshot client dropoff, assigned supplier pickup, distance band, delivery fee, and accepted price.
- The service fee is seeded at 1,000 bps on the supplier subtotal and snapshotted with the accepted quote; delivery is a separate pass-through.
- Generalized online installments, component allocations, and supplier payout milestones have independent relational records.
- Supplier payout never exceeds confirmed supplier-principal collection: 25% or 50% terms release that initial share at production, while 0% waits and the remaining principal releases at fulfilment.
- Claims hold payout. Client issues during the global issue window create an automatic claim hold.
- Rider pickup requires all six checks; failures create an Operations escalation.
- Delivery requires file-backed photo or signature evidence and opens the issue window.
- Order/payment/payout/credit/claim/issue changes commit atomically with audit and notification records.

Clients receive item subtotal, service fee, delivery, total, and their accepted installment plan, but never supplier payout or milestone amounts. Use the role-aware projection in `src/operational-model.js` for every order response.

## Geography

Orders carry `pickup` and `dropoff` map points; suppliers carry a shop point; rider pings retain timestamped coordinates. Current queries retrieve a point or the latest ping for one order, so constrained latitude/longitude columns are sufficient. Introduce PostGIS only when SQL radius or nearest-neighbor matching becomes a real query.

## Files and notifications

Artwork, fulfilment proof, delivery evidence, supplier images, and verification documents remain private MinIO objects. API records use opaque file IDs and authorize short-lived signed downloads.

Notifications are durable, caller-scoped PostgreSQL inbox rows. Event coverage, silent refresh, push privacy, and delivery guarantees are defined in [Realtime events](docs/REALTIME_EVENTS.md).

## Non-goals

- live PayMongo/card collection, provider sub-accounts, or cash custody;
- automatic supplier assignment;
- runtime geocoding;
- PostGIS before spatial database queries exist;
- storing file blobs in PostgreSQL;
- local passwords, demo users, JSON persistence, or data import from the retired store.

## Acceptance

- Real PostgreSQL constraints, foreign keys, indexes, ordered migrations, and transactional multi-row mutations.
- Clerk JWT verification with exact issuer and authorized-party checks; unauthenticated and wrong-role requests fail closed.
- Complete v2 lifecycle for order, QR payment, collection-capped payout, dispatch, issue, claim, audit, and notification behavior.
- Compose starts PostgreSQL, migrates, seeds reference data, initializes MinIO, and serves healthy API responses.
- CI tests against PostgreSQL 17 and proves the named database volume survives API replacement and PostgreSQL container recreation.
- Deployment requirements and first-administrator bootstrap are unambiguous in `docs/DEPLOYMENT.md`.
