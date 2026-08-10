# GRIDGO Demo API — PRD (MVP)

> Source: GRIDGO Product Requirements Document (tinker), Supplier presentation (2026-08-04), captain MVP direction, blueprint PR (service catalogue / taxonomy).
>
> Captain's operational model v2 supersedes the original payment/fulfilment flow. The exact implemented contract is `docs/OPERATIONAL_MODEL_V2_API.md`.

## Purpose

Temporary, **replaceable** local backend used by every GRIDGO surface (client, supplier, rider, ops/admin web) for demonstration and local development. Not production.

## Non-goals (MVP)

- Clerk, Supabase Auth/DB, PayMongo live collection
- Real card vaulting, provider sub-accounts, or KYC
- Google Maps billing / Navigation SDK server side (client apps may use OSM + OSRM with API coords)
- Multi-region HA
- Runtime geocoding of free-text addresses on the server
- Auto-matcher that assigns suppliers without Operations

## Goals

1. One process all mobile apps and the web portal can call (`http://127.0.0.1:8787` or LAN IP).
2. Custom auth with self-signup for clients, suppliers, and riders plus role claims.
3. Order lifecycle transitions aligned with operational model v2.
4. Manually confirmed digital QR payment: 75% downpayment and 25% balance; no COD.
5. Dispatch offers, location pings, six-check pickup gate, evidence-backed escalation, and file-backed delivery evidence.
6. Stable route shapes so mobile `lib/api.ts` and the web portal survive a future cloud swap.
7. Order geography for maps: `pickup` / `dropoff` coords (Davao pilot) so apps do not geocode at runtime.
8. **Platform-governed supplier service catalogue** and matching eligibility for Operations.
9. **Ops / Super Admin surface**: users, roles, verification, zones/fees, credit grants, claims/holds, issues, audit.
10. Private MinIO files for artwork, milestone POFs, delivery/checklist photos, and supplier-service images: streamed API uploads, explicit file-ID attach, and authorized short-lived presigned GETs.

## Roles served

| Role | Demo login | App |
|---|---|---|
| client (business) | client@gridgo.local / Ilovegridgo-0990 | gridgo-client — `accountType: "business"` |
| client (individual) | individual@gridgo.local / Ilovegridgo-0990 | gridgo-client — `accountType: "individual"` |
| supplier | supplier@gridgo.local / Ilovegridgo-0990 | gridgo-supplier + portal catalogue |
| rider | rider@gridgo.local / Ilovegridgo-0990 | gridgo-rider |
| ops_admin | ops@gridgo.local / Ilovegridgo-0990 | web Operations |
| super_admin | admin@gridgo.local / Ilovegridgo-0990 | web Super Admin |

## Client account type

Authoritative field on **client** users for logo lockup (plain **GRIDGO** vs **GRIDGO Business**). Exposed through `publicUser` on login, `/auth/me`, and user list/detail.

| Field | Values | Notes |
|---|---|---|
| `accountType` | `"individual"` \| `"business"` \| `"organization"` | **Not** inferred from `orgName`; signup accepts `personal` as alias for `individual` |

| Decision | Choice | Rationale |
|---|---|---|
| Default when missing | `"individual"` | Business branding is opt-in; consumers never see `undefined` |
| API write this pilot | `POST /auth/signup` | Business/organization accounts require `orgName` |
| Non-client roles | field omitted | Same role-specific pattern as `orgName` / `shop` |

Backfill on `load()`: any client without a valid `accountType` gets `"individual"`; existing valid values are never overwritten.

## Ecosystem (from supplier presentation)

GRIDGO is a **centralized digital printing platform**: market (users/businesses) ↔ platform ↔ print suppliers (signage, apparel, trophies, …) with a **rider system** for logistics.

Simplified fulfilment: **Order → Print → Deliver**.

Surfaces: **mobile apps + website portal**. User types: Admin, Supplier, Business (client), Rider.

## Supplier value props to support in API/data

1. **Client acquisition** — orders routed to accredited suppliers via live service catalogue eligibility.
2. **Guaranteed payout model** — four POF-gated supplier milestones; claims/holds gate release.
3. **QA & centralized communication** — single order inbox / timeline + platform audit log.
4. **Service listing** — taxonomy-backed supplier services (not free-form marketing blurbs).

Onboarding path: Apply → Get accredited / list shop + service catalogue → Start receiving GRIDGO orders.

## Product categories (catalog)

Marketing & promo: flyers, brochures, posters/standees, business cards, stickers/labels, tarpaulins/banners.  
Corporate/event merch: lanyards/IDs, custom apparel, drinkware, giveaways.

Client catalog (`/catalog`) is what clients request. **Service taxonomy** is what suppliers declare they can produce (capability categories, materials, finishes, product-family links). Super Admin owns taxonomy codes; suppliers select only.

## Supplier service catalogue (blueprint §4.2)

| Concern | Source | Editable by |
|---|---|---|
| Category / material / finish codes | Super Admin taxonomy | Super Admin only |
| Size/qty ranges, pricing basis, rates (minor), turnaround, capacity, zones, notes | Supplier service line | Supplier (portal) |
| Live for matching | Verification gate | Ops/super verify; supplier submits |

States: `draft` | `pending_verification` | `live` | `suspended` | `withdrawn`.

Rules:

- First publish and new capability/material claims require verification before `live`.
- Routine price/turnaround/capacity edits within a verified envelope stay live (audited).
- Withdraw/suspend removes **new** matching only; accepted in-flight orders stay assigned.
- Unverified suppliers have no live services and are not matchable.

### Matching support

`GET /orders/:id/eligible-suppliers` (ops/super) returns explainable candidates. Assignment remains manual via transition `supplier_assigned` with `supplierId` (optional `matchingServiceIds` recorded on the order).

Eligibility basis:

1. Supplier `verificationStatus === "approved"`
2. At least one **live** service covering product family, material (when set), quantity band, and delivery zone
3. Ranking inputs exposed (turnaround, capacity, service counts) — not auto-applied

## Order geography

Additive fields on every order (do not remove `address` / `zone`):

| Field | Shape | Notes |
|---|---|---|
| `pickup` | `{ lat, lng, label } \| null` | Supplier shop; null if no supplier yet |
| `dropoff` | `{ lat, lng, label }` | Delivery point; `label` = order `address` |
| `matchingServiceIds` | `string[] \| null` | Service lines that justified assignment |
| `payoutHold` | `boolean` | True while claim hold active |
| `finish` | `string` | Optional finish note/code on order |

Supplier user may include `shop: { lat, lng, label }` and `verificationStatus`.

## Zones and v2 distance fees

`GET /zones` retains compatibility/address zones. V2 snapshots a configurable distance-band fee from supplier `pickup` to client `dropoff`; Operations/Super Admin manage the global bands through `GET|PATCH /settings`.

## Pilot Credits granting

`POST /credits/grant` (super_admin): `{ clientId, amountMinor, reason }` appends a `grant` ledger entry. Not a purchase; non-cash, non-transferable pilot instrument.

Clients only read their own balance; ops/super may pass `?clientId=`.

## Claims & payout holds

Operations raises claims on orders and holds/releases payout with reasons. Active hold blocks `completed` → `payout_released` with `409 payout_held` (transition edges themselves unchanged).

## Issue reports

While `issue_window_open`, the order client may `POST /orders/:id/issues`. Consequence: auto payout hold claim. Ops resolves via `POST /issues/:id/resolve` (optional `releasePayout`).

## Audit trail

**Separate** platform `auditLog` (`GET /audit`) vs per-order `timeline`:

| Store | Scope | Audience |
|---|---|---|
| `order.timeline` | State/notes on one order | Client, supplier, rider, ops on that order |
| `auditLog` | Platform actions across users, credits, taxonomy, services, claims, issues, roles | Ops / Super Admin only |

Role changes, credit grants, verification, taxonomy edits, and matching assignments write audit entries.

## Rider location read

| Method | Path | Who | Response |
|---|---|---|---|
| GET | `/dispatch/:id/location` | assigned rider, order client, assigned supplier, ops/super | `{ ping }` latest or `{ ping: null }` if none |
| POST | `/dispatch/:id/location` | assigned rider (active tracking states) | `{ ping }` created |

No server-side staleness flag — callers use `ping.at`.

## Backfill (existing live stores)

`data/store.json` is gitignored. On every `load()`, idempotent backfill fills missing:

- geography: `shop` / `dropoff` / `pickup` (never overwrite existing coords)
- platform: `taxonomy`, `zones`, `supplierServices`, `claims`, `issues`, `auditLog`
- supplier `verificationStatus` (demo supplier → approved when missing)
- empty services → seed PrintRight live lines for demo supplier
- client `accountType` → `"individual"` when missing/invalid (never overwrite valid value)
- top-level `files: []`, order file-ID arrays, and supplier-service `imageFileIds: []` when missing (never synthesize an object from legacy `artworkName`)

Never requires `npm run reset` (which would wipe captain demo orders).

## Acceptance (API)

- [x] Health endpoint
- [x] Login issues token; role on user
- [x] Role-scoped order/job/offer lists
- [x] Transitions refuse illegal role/state pairs
- [x] 75%/25% QR installments with manual Operations confirmation; COD paths retired
- [x] Rider accept + six-check pickup + attached delivery evidence advances job
- [x] Order pickup/dropoff Davao coords; new orders get dropoff
- [x] GET latest rider location (role-gated; empty = `{ ping: null }`)
- [x] Service taxonomy CRUD (super) + read (auth)
- [x] Supplier services lifecycle + isolation
- [x] Eligible suppliers for matching (explainable)
- [x] User directory + role change + verification
- [x] Zones/fees read + super write
- [x] Pilot Credits grant (super)
- [x] Claims hold/release
- [x] Client issue report in global configured window + real load-time expiry
- [x] Platform audit log
- [x] Idempotent backfill without data loss
- [x] Client `accountType` (`individual` \| `business` \| `organization`) via publicUser; backfill default individual
- [ ] Idempotency keys on writes
- [x] Persistent private MinIO storage + streamed file/attach/presigned-GET contract (`docs/STORAGE_API.md`)
- [ ] Webhook-shaped payment events for future PayMongo

## Replace map

| Today | Later |
|---|---|
| Bearer token JSON sessions | Clerk session + role claim |
| `data/store.json` | Supabase Postgres + RLS |
| In-process transitions | Edge Functions + idempotency |
| Manually confirmed QR installments | Provider adapter/webhook on the same installment records |
