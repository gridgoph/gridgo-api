# GRIDGO Demo API — PRD (MVP)

> Source: GRIDGO Product Requirements Document (tinker), Supplier presentation (2026-08-04), captain MVP direction.

## Purpose

Temporary, **replaceable** local backend used by every GRIDGO surface (client, supplier, rider; later ops/admin) for demonstration and local development. Not production.

## Non-goals (MVP)

- Clerk, Supabase Auth/DB, PayMongo live collection
- Real card vaulting, provider sub-accounts, or KYC
- Google Maps billing / Navigation SDK server side (client apps may use OSM + OSRM with API coords)
- Multi-region HA
- Runtime geocoding of free-text addresses on the server

## Goals

1. One process all mobile apps can call (`http://127.0.0.1:8787` or LAN IP).
2. Custom auth with fixed demo users and role claims.
3. Order lifecycle transitions aligned with the pilot state machine (simplified).
4. Pilot Credits ledger + COD eligibility (≤ ₱1,500, one active COD).
5. Dispatch offers, location pings (write + latest read), pickup/delivery/COD proofs for riders.
6. Stable route shapes so mobile `lib/api.ts` survives a future cloud swap.
7. Order geography for maps: `pickup` / `dropoff` coords (Davao pilot) so apps do not geocode at runtime.

## Roles served

| Role | Demo login | App |
|---|---|---|
| client | client@gridgo.local / demo | gridgo-client |
| supplier | supplier@gridgo.local / demo | gridgo-supplier |
| rider | rider@gridgo.local / demo | gridgo-rider |
| ops_admin | ops@gridgo.local / demo | future web |
| super_admin | admin@gridgo.local / demo | future web |

## Ecosystem (from supplier presentation)

GRIDGO is a **centralized digital printing platform**: market (users/businesses) ↔ platform ↔ print suppliers (signage, apparel, trophies, …) with a **rider system** for logistics.

Simplified fulfilment: **Order → Print → Deliver**.

Surfaces: **mobile apps + website portal**. User types: Admin, Supplier, Business (client), Rider.

## Supplier value props to support in API/data

From the suppliers presentation:

1. **Client acquisition** — orders routed to accredited suppliers (not only walk-ins).
2. **Guaranteed payout model** — pilot uses credits/COD; production later holds/release (escrow-like provider settlement — not built live yet).
3. **QA & centralized communication** — single order inbox / timeline (replacing Messenger/Viber chaos).
4. **Inventory visibility** — placeholder fields ok in MVP; full tracker later.

Onboarding path presented: Apply → Get accredited / list shop → Start receiving GRIDGO orders.

## Product categories (catalog)

Marketing & promo: flyers, brochures, posters/standees, business cards, stickers/labels, tarpaulins/banners.  
Corporate/event merch: lanyards/IDs, custom apparel, drinkware, giveaways.

## Order geography

Additive fields on every order (do not remove `address` / `zone`):

| Field | Shape | Notes |
|---|---|---|
| `pickup` | `{ lat, lng, label } \| null` | Supplier shop; null if no supplier yet |
| `dropoff` | `{ lat, lng, label }` | Delivery point; `label` = order `address` |

Supplier user record may include fixed `shop: { lat, lng, label }`. New orders get `dropoff` from delivery `zone` + deterministic address offset (Davao neighbourhood anchors).

## Rider location read

| Method | Path | Who | Response |
|---|---|---|---|
| GET | `/dispatch/:id/location` | assigned rider, order client, assigned supplier, ops/super | `{ ping }` latest or `{ ping: null }` if none |
| POST | `/dispatch/:id/location` | assigned rider (active tracking states) | `{ ping }` created |

No server-side staleness flag — callers use `ping.at`.

## Acceptance (API)

- [x] Health endpoint
- [x] Login issues token; role on user
- [x] Role-scoped order/job/offer lists
- [x] Transitions refuse illegal role/state pairs
- [x] Credits authorize spend; COD gate ≤ 150000 minor
- [x] Rider accept + proof advances job
- [x] Order pickup/dropoff Davao coords; new orders get dropoff
- [x] GET latest rider location (role-gated; empty = `{ ping: null }`)
- [ ] Idempotency keys on writes
- [ ] Persistent file/artwork storage adapter
- [ ] Webhook-shaped payment events for future PayMongo

## Replace map

| Today | Later |
|---|---|
| Bearer token JSON sessions | Clerk session + role claim |
| `data/store.json` | Supabase Postgres + RLS |
| In-process transitions | Edge Functions + idempotency |
| Simulated COD/credits | Real ledger + PayMongo adapter |
