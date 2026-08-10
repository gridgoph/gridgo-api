# Operational Model v2 Design

## Purpose

This design implements the captain's 2026-08-10 operational model while preserving the JSON-store and `node:http` architecture. It supersedes the supplier-proof, flat-zone-fee, one-shot payment, single-payout, and COD flows.

## Boundaries

- `src/operational-model.js` owns deterministic domain behavior: signup validation helpers, distance pricing, commission and installment arithmetic, role-aware order projection, milestone construction/release, issue-window expiry, defaults, and load-time migration.
- `src/attachments.js` remains the only upload/attachment implementation. The retired `proof` upload purpose becomes read-only legacy metadata; new Proof of Fulfilment files use `fulfilment_proof`, while rider delivery/checklist evidence continues to use `delivery_photo`.
- `src/server.js` owns authentication, authorization, routes, persistence, notifications, audits, and calls into the domain module.
- `src/seed.js` creates v2-shaped fresh fixtures through the same defaults/backfill used by `load()`.

## Accounts

`POST /auth/signup` creates and signs in a `client`, `supplier`, or `rider`. Common required fields are `role`, `email`, `password`, `name`, and `phone`.

- Client: `accountType` is `individual`, `business`, or `organization`; `personal` is accepted as an input alias and stored as `individual` to preserve the existing contract. `orgName` is required for business and organization accounts.
- Supplier: `supplierName`, `shop: {lat,lng,label}`, and `categoryRanks: [{categoryCode,rank}]` are required. Categories resolve through taxonomy aliases, are unique, and ranks are contiguous from 1. The account starts with `verificationStatus: "pending"`.
- Rider: `riderProfile: {vehicleType,vehiclePlate,licenseNumber}` is required. The account starts with `verificationStatus: "pending"`.

Only approved suppliers appear as eligible and only approved riders can see/accept dispatch offers. The existing Operations/Super Admin verification route remains authoritative.

## Pricing and visibility

Order creation returns a client-safe `priceRange` with `subtotalMinMinor` and `subtotalMaxMinor`, derived from current catalogue/service reference prices with commission already included. Supplier/commission components are never included in a client response.

Supplier acceptance requires `supplierPriceMinor`. The server calculates:

```text
commissionMinor = round(supplierPriceMinor * 10 / 100)
subtotalMinor = supplierPriceMinor + commissionMinor
deliveryDistanceMeters = haversine(pickup, dropoff)
deliveryFeeMinor = configured distance band fee
totalMinor = subtotalMinor + deliveryFeeMinor
downpaymentMinor = round(totalMinor * 75 / 100)
balanceMinor = totalMinor - downpaymentMinor
```

The initial provisional bands are `< 5000m => 2500`, `5000..10000m => 5000`, and `> 10000m => 7500`. They live in `settings.deliveryFeeBands` and Operations/Super Admin can replace them with `PATCH /settings`.

`publicOrder(order, user)` is role-aware. Clients receive subtotal, delivery, total, installment amounts, and redacted milestone amounts. The assigned supplier receives its own asking price and milestone amounts but not the commission. Only Operations/Super Admin receive the full supplier-price and commission breakdown. This is enforced at every order-returning route, including order lists, individual reads, payment responses, and dispatch lists.

## Assignment and payment

Supplier acceptance atomically calculates final money, creates the client assignment notification, stores `assignmentNotificationId`/`assignmentNotifiedAt`, and moves to `awaiting_downpayment`. No payment route accepts an order unless that notification record exists.

Payments are stored as `payments.downpayment` and `payments.balance`, each with amount, method `qr_manual`, status (`not_submitted`, `pending_confirmation`, `confirmed`, or migrated `legacy_confirmed`), client reference/timestamps, and confirmer fields.

- `POST /orders/:id/payments/downpayment/submit` — owning client submits a QR/e-wallet reference; order moves to `downpayment_review`.
- `POST /orders/:id/payments/balance/submit` — owning client submits the remaining digital payment after downpayment confirmation.
- `POST /orders/:id/payments/:installment/confirm` — Operations/Super Admin manually confirms a pending payment. Downpayment confirmation moves the order to `payment_authorized`; balance confirmation does not skip production/delivery states.

COD is absent from allowed methods. The legacy transition payment path, COD ceiling, one-active-COD guard, `codEligible`, cash proof kind, and cash collection mutations are removed. Migration converts legacy COD records to `digital_manual_legacy` and coherent confirmed/pending installment records according to their progress without fabricating cash custody.

## Production and milestone payouts

Each order has `payoutMilestones`:

| code | share | POF actor | additional release gate |
|---|---:|---|---|
| `printing` | 50 | assigned supplier | none |
| `packaging_qc` | 15 | assigned supplier | none |
| `delivered` | 25 | assigned rider | delivery recorded and balance confirmed |
| `retention` | 10 | reuses delivered POF | issue window expired with no payout hold |

Amounts are integer shares of `supplierPriceMinor`; retention receives the rounding remainder so the four amounts sum exactly to what the supplier earns.

`fulfilment_proof` attachment accepts `{orderId,milestoneCode}` and records the file under both `order.fulfilmentProofFileIds` and the selected milestone. A ready delivered POF is also linked to retention. `POST /orders/:id/milestones/:code/release` is Operations/Super Admin only and returns a concrete `pof_required`, payment/delivery gate, issue-window, or payout-hold error when blocked. Retention normally releases automatically during issue-window expiry.

## Issue window

`settings.issueWindowHours` is one platform-wide integer, defaulting to 24, and is editable by Operations/Super Admin through `PATCH /settings`. Delivery snapshots `issueWindowOpenedAt` and `issueWindowExpiresAt`. Every `load()` runs deterministic expiry: an elapsed, unheld order moves from `issue_window_open` to `completed` and releases retention when its delivered POF exists. Issue creation compares the current timestamp to `issueWindowExpiresAt`, so an expired window cannot accept a late claim even before another read triggers persistence.

## Rider pickup and delivery evidence

`POST /dispatch/:id/pickup-checklist` accepts all six exact check codes. Passing all six moves the order to `picked_up` and returns `signOffPrompt: "GRIDGO partner! Quality check, done! Salamat po!"`. Any failure keeps transport blocked, requires `evidenceFileIds` referencing attached rider `delivery_photo` files plus `failureNote`, stores `failed_escalated`, creates an escalation record, and notifies Operations/Super Admin.

The old generic rider proof body is replaced by `POST /dispatch/:id/delivery` with `evidenceFileId` and `evidenceType: "photo" | "signature"`. It requires an attached ready file, confirmed digital balance, and active transport state; it opens the configured issue window. No direct filename or cash proof path remains.

## Migration

`backfillOperationalModel(store, at)` is additive/idempotent and runs from `load()` after existing structural backfills. It adds settings/collections and complete v2 fields to every order. Legacy client-visible totals are grandfathered: existing `totalMinor` remains the new subtotal snapshot, supplier price is derived by reversing 10% and commission is the exact remainder. This avoids raising prices on the captain's seven demo orders while producing non-null coherent components.

Orders in `supplier_proof_review`, `supplier_proof_changes_requested`, or `supplier_proof_approved` migrate to `awaiting_downpayment`; an assignment notification is created once. Legacy `proofFileIds` and file metadata are retained for audit/read access but no longer drive state. Existing progressed/paid orders receive coherent legacy-confirmed installments and milestone statuses based on lifecycle position. No orders, files, credits, claims, issues, sessions, pings, or user-entered metadata are deleted.

Migration verification runs twice on a copied live store. A collection-level SHA-256 report records the first-run changes and proves the second run byte-stable. The source store is never started or modified.

## Error copy

Error payloads keep `{error: "snake_case"}` and add plain-language `message` text that identifies the concrete problem and recovery. Internal state identifiers remain API contract values; user-facing apps map them to the copy specified in the v2 contract.
