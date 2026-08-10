# GRIDGO Operational Model v2 API

This is the rebuild contract for the three mobile apps and Operations web portal. Field names, enum values, money units, authorization, and state transitions are case-sensitive. `docs/STORAGE_API.md` and `docs/TAXONOMY_API.md` remain authoritative for file bytes and taxonomy structure.

## Conventions

- Bearer auth: `Authorization: Bearer <token>` except `/health`, `/catalog`, `/auth/signup`, and `/auth/login`.
- Money: integer PHP minor units. Never send formatted peso strings as amounts.
- Errors: `{ "error": "snake_case", "message": "concrete problem and recovery", ...details }`.
- Roles: `client`, `supplier`, `rider`, `ops_admin`, `super_admin`.
- Verification: `unverified | pending | approved | suspended | rejected`. Supplier/rider signup starts `pending`; only `approved` accounts can receive work.
- Client `accountType`: `individual | business | organization`. Signup accepts `personal` as an alias and stores/returns `individual` so existing branding contracts remain stable.

## Complete route index

| Method | Path | Authorization | Contract |
|---|---|---|---|
| GET | `/health` | public | service/storage health |
| GET | `/catalog` | public | demo product catalogue |
| POST | `/auth/signup` | public | self-signup for client/supplier/rider |
| POST | `/auth/login` | public | `{email,password}` → `{token,user}` |
| GET | `/auth/me` | authenticated | `{user}` without password |
| POST | `/auth/logout` | authenticated/token optional | invalidates current token |
| POST | `/files` | purpose role | streamed upload; see storage contract |
| GET | `/files/:fileId` | file owner/related order or service/ops/super | public metadata |
| GET | `/files/:fileId/download-url` | same as file read | five-minute signed GET |
| POST | `/files/:fileId/attach` | file owner + parent owner/assignee | attach opaque file ID |
| DELETE | `/files/:fileId` | owner/ops/super; unreferenced only | safe delete lifecycle |
| GET | `/notifications` | authenticated | caller's notifications, newest first |
| GET | `/settings` | authenticated | global issue window and delivery bands |
| PATCH | `/settings` | ops/super | replace either/both operational settings |
| GET | `/credits/balance` | client own; ops/super any `?clientId=` | pilot grant ledger only |
| POST | `/credits/authorize` | authenticated | retired: always `410 payment_route_retired` |
| POST | `/credits/grant` | super | non-cash pilot grant; audited |
| GET | `/users[?role=]` | ops/super | public-user directory |
| GET | `/users/:id` | ops/super | one public user |
| PATCH | `/users/:id/role` | super | role change; audited |
| POST | `/users/:id/verification` | ops/super | supplier/rider approval decision |
| GET | `/zones` | authenticated | legacy address-zone records; fees are not used for v2 pricing |
| POST | `/zones` | super | create zone |
| PATCH | `/zones/:idOrCode` | super | update zone |
| GET | `/taxonomy` | authenticated | flat taxonomy plus derived `categoryTree` |
| POST | `/taxonomy/categories` | super | create category |
| PATCH | `/taxonomy/categories/:idOrCode` | super | update category |
| POST | `/taxonomy/subcategories` | super | create subcategory |
| PATCH | `/taxonomy/subcategories/:idOrCode` | super | update subcategory |
| POST | `/taxonomy/materials` | super | create material |
| PATCH | `/taxonomy/materials/:idOrCode` | super | update material |
| POST | `/taxonomy/finishes` | super | create finish |
| PATCH | `/taxonomy/finishes/:idOrCode` | super | update finish |
| GET | `/supplier-services[?supplierId=&state=]` | supplier own; ops/super any | service catalogue |
| POST | `/supplier-services` | supplier | create `draft` service |
| GET/PATCH | `/supplier-services/:id` | owner supplier; ops/super read, limited edit | service detail/edit |
| POST | `/supplier-services/:id/submit` | owner supplier | request verification |
| POST | `/supplier-services/:id/verify` | ops/super | make service `live`; owner must be approved |
| POST | `/supplier-services/:id/suspend` | ops/super | suspend; reason required |
| POST | `/supplier-services/:id/withdraw` | owner supplier | withdraw from new matching |
| GET | `/orders/:id/eligible-suppliers` | ops/super | explainable approved/live matches |
| GET | `/orders` | role-scoped | caller-visible order list |
| GET | `/orders/:id` | related party/ops/super | role-filtered order detail |
| POST | `/orders` | client | draft/submit order and return estimate range |
| POST | `/orders/:id/transition` | edge-specific role | unchanged QA/production edges below |
| POST | `/orders/:id/payments/:installment/submit` | owning client | submit QR reference |
| POST | `/orders/:id/payments/:installment/confirm` | ops/super | manual confirmation |
| POST | `/orders/:id/milestones/:code/release` | ops/super | POF-gated supplier payout release |
| GET | `/claims` | ops/super | list claims; filters `orderId`, `status` |
| POST | `/claims` | ops/super | raise claim; holds unless `hold:false` |
| GET | `/claims/:id` | ops/super | claim detail |
| POST | `/claims/:id/hold` | ops/super | hold payout; reason required |
| POST | `/claims/:id/release` | ops/super | release hold; reason required |
| GET | `/issues[?orderId=&status=]` | client own/supplier own orders/ops/super | issue list |
| GET | `/issues/:id` | related client/supplier/ops/super | issue detail |
| POST | `/orders/:id/issues` | owning client, within window | issue + automatic payout-hold claim |
| POST | `/issues/:id/resolve` | ops/super | resolve/dismiss, optionally release claim |
| GET | `/escalations[?status=&orderId=]` | ops/super | pickup escalations |
| POST | `/escalations/:id/resolve` | ops/super | instruction/resolution; rider must recheck |
| GET | `/audit` | ops/super | platform audit with existing filters |
| GET | `/dispatch/offers` | approved rider/ops/super | available/assigned dispatches |
| POST | `/dispatch/:id/accept` | approved rider | assign self to ready dispatch |
| POST | `/dispatch/:id/pickup-checklist` | assigned approved rider | pass or escalate all six checks |
| POST/GET | `/dispatch/:id/location` | POST assigned rider; GET related parties/ops/super | live location ping/latest ping |
| POST | `/dispatch/:id/delivery` | assigned rider | file-backed delivery evidence; opens issue window |
| POST | `/dispatch/:id/proof` | authenticated | retired: always `410 dispatch_proof_route_retired` |
| GET | `/jobs` | supplier | only the caller's assigned supplier jobs |

## Signup

### `POST /auth/signup`

Common required request fields:

```json
{
  "role": "client",
  "email": "ana@example.com",
  "password": "at-least-8-characters",
  "name": "Ana Santos",
  "phone": "+639171234567"
}
```

Client adds:

```json
{
  "accountType": "individual",
  "orgName": "required for business or organization"
}
```

Supplier adds:

```json
{
  "supplierName": "PrintRight Davao",
  "shop": { "lat": 7.064, "lng": 125.6085, "label": "C.M. Recto St, Davao City" },
  "categoryRanks": [
    { "categoryCode": "marketing_collateral", "rank": 1 },
    { "categoryCode": "corporate_event_merch", "rank": 2 }
  ]
}
```

`categoryCode` accepts a live canonical category or retired alias and stores the canonical code. Entries are unique and ranks must be exactly `1..n` with no gaps. The response user has `verificationStatus: "pending"`.

Rider adds:

```json
{
  "riderProfile": {
    "vehicleType": "motorcycle",
    "vehiclePlate": "ABC 1234",
    "licenseNumber": "N01-23-456789"
  }
}
```

The response user has `verificationStatus: "pending"`. Success for every role is `201 {token,user}`. Duplicate email is `409 email_already_registered`.

Approval is the existing `POST /users/:id/verification` body `{ "status": "approved", "reason": "..." }`. Pending suppliers cannot be assigned by the transition endpoint; pending riders cannot list, accept, or transition into dispatch assignment.

## Settings and distance fee

Default `GET /settings` response:

```json
{
  "settings": {
    "issueWindowHours": 24,
    "deliveryFeeBands": [
      { "maxDistanceMeters": 4999, "feeMinor": 2500 },
      { "maxDistanceMeters": 10000, "feeMinor": 5000 },
      { "maxDistanceMeters": null, "feeMinor": 7500 }
    ]
  }
}
```

These band figures are provisional Firstmate values, not captain-specified prices. Operations/Super Admin can change them without a release:

```http
PATCH /settings
```

```json
{
  "issueWindowHours": 48,
  "deliveryFeeBands": [
    { "maxDistanceMeters": 4999, "feeMinor": 3000 },
    { "maxDistanceMeters": 10000, "feeMinor": 6000 },
    { "maxDistanceMeters": null, "feeMinor": 9000 }
  ],
  "reason": "Pilot pricing update"
}
```

`issueWindowHours` is a whole number from 1 to 720. Band maxima increase strictly; the final maximum is `null`. The API derives `deliveryDistanceMeters` with a Haversine distance between the assigned supplier's `shop`/order `pickup` and order `dropoff`. Client-supplied `deliveryFeeMinor` is ignored.

## Price estimate and exact money

At `POST /orders`, `priceRange` is client-safe and commission-inclusive:

```json
{
  "priceRange": {
    "subtotalMinMinor": 49500,
    "subtotalMaxMinor": 55000,
    "deliveryFeeStatus": "pending_supplier_assignment"
  }
}
```

It is derived from current product and live-service reference prices. No supplier or delivery point is selected yet, so delivery is pending. It is an estimate, not an authorization.

Supplier acceptance uses the existing transition endpoint with a new exact field:

```http
POST /orders/:id/transition
```

```json
{
  "state": "supplier_accepted",
  "supplierPriceMinor": 100000,
  "promisedDate": "2026-08-12T09:00:00.000Z"
}
```

The assigned, approved supplier is the only allowed caller. This atomically computes money, creates a `supplier_assignment_final_price` client notification, stores `assignmentNotificationId`/`assignmentNotifiedAt`, and returns order state `awaiting_downpayment`.

### Worked example

| Field | Minor units | Peso meaning | Client receives field? |
|---|---:|---:|---|
| `supplierPriceMinor` | 100000 | ₱1,000 | no |
| `commissionRatePercent` | 10 | 10% | no |
| `commissionMinor` | 10000 | ₱100 | no |
| `subtotalMinor` | 110000 | ₱1,100 | yes |
| `deliveryFeeMinor` | 2500 | ₱25 | yes |
| `totalMinor` | 112500 | ₱1,125 | yes |
| `downpaymentMinor` | 84375 | ₱843.75 | yes |
| `balanceMinor` | 28125 | ₱281.25 | yes |

`commissionMinor = round(supplierPriceMinor * 10 / 100)`. `subtotalMinor = supplierPriceMinor + commissionMinor`. `totalMinor = subtotalMinor + deliveryFeeMinor`. `downpaymentMinor = round(totalMinor * 75 / 100)` and `balanceMinor` receives the exact remainder.

### Visibility authorization

- Client: subtotal, delivery, total, downpayment/balance, payment status, its submitted payment references, and milestone codes/status/POF IDs. Never supplier price, commission rate/amount, or milestone amounts.
- Assigned supplier: client-visible totals plus its `supplierPriceMinor` and milestone `amountMinor`. Never commission or client payment references.
- Rider: client-safe order money; no supplier price, commission, payout amounts, or client payment references.
- Operations/Super Admin: full supplier price, commission, client totals, installment amounts, and milestone amounts.

All order-returning endpoints use this projection. Commission secrecy is an API authorization rule.

## Digital payment split

`installment` is `downpayment` or `balance`. COD is not an enum and is rejected with `400 payment_method_not_allowed` on legacy transition attempts. The old credit authorization route is `410` and the old rider proof/cash route is `410`.

Order payment shape:

```json
{
  "payments": {
    "downpayment": {
      "amountMinor": 84375,
      "method": "qr_manual",
      "status": "not_submitted",
      "reference": null,
      "submittedAt": null,
      "confirmedAt": null,
      "confirmedBy": null,
      "confirmationSource": null
    },
    "balance": {
      "amountMinor": 28125,
      "method": "qr_manual",
      "status": "not_submitted",
      "reference": null,
      "submittedAt": null,
      "confirmedAt": null,
      "confirmedBy": null,
      "confirmationSource": null
    }
  }
}
```

Statuses: `not_submitted | pending_confirmation | confirmed | legacy_confirmed`. `legacy_confirmed` appears only on migrated progressed orders.

Client submission:

```http
POST /orders/:id/payments/downpayment/submit
POST /orders/:id/payments/balance/submit
```

```json
{ "method": "qr_manual", "reference": "GCASH-ABC123" }
```

Payment is `409 assignment_notification_required` until the persisted assignment notification exists. Downpayment submission changes order state to `downpayment_review`. Balance submission requires confirmed downpayment.

Manual confirmation:

```http
POST /orders/:id/payments/downpayment/confirm
POST /orders/:id/payments/balance/confirm
```

```json
{ "note": "Reference matched Operations wallet" }
```

Only Operations/Super Admin. Confirmation sets `status: "confirmed"`, actor/timestamp, and `confirmationSource: "manual_ops"`. Downpayment confirmation changes order state to `payment_authorized`; balance confirmation sets legacy summary `paymentStatus: "paid"`. Delivery is blocked until balance is confirmed.

## Payout milestones and POF

```json
{
  "payoutMilestones": [
    { "code": "printing", "sharePercent": 50, "amountMinor": 50000, "status": "pending_pof", "pofFileIds": [] },
    { "code": "packaging_qc", "sharePercent": 15, "amountMinor": 15000, "status": "pending_pof", "pofFileIds": [] },
    { "code": "delivered", "sharePercent": 25, "amountMinor": 25000, "status": "pending_pof", "pofFileIds": [] },
    { "code": "retention", "sharePercent": 10, "amountMinor": 10000, "status": "pending_pof", "pofFileIds": [] }
  ]
}
```

Statuses: `pending_pof | pof_attached | released`. Amounts split `supplierPriceMinor`, not client total. Retention receives any integer-rounding remainder so amounts sum exactly to supplier earnings.

POF uses the existing file flow with `purpose=fulfilment_proof`, then:

```http
POST /files/:fileId/attach
```

```json
{ "orderId": "ord_123", "milestoneCode": "printing" }
```

Uploader authorization: assigned supplier for `printing`/`packaging_qc`; assigned rider for `delivered`. Direct retention upload is invalid; delivered POF links to both delivered and retention.

Release:

```http
POST /orders/:id/milestones/:code/release
```

```json
{ "note": "POF reviewed" }
```

Only Operations/Super Admin. Missing POF is `409 pof_required`; an early production-stage release is `409 milestone_not_reached`; active claim is `409 payout_held`; delivered share additionally needs recorded delivery and confirmed balance; retention needs completed issue-window expiry. `completed -> payout_released` is permitted only after every milestone is released.

## Order states and transitions

The transition endpoint accepts only these role edges. A role label means the related account only: the owning client, assigned supplier, or assigned rider; another account with the same role receives `403 forbidden`. Endpoint-owned atomic steps are listed separately.

| From | To | Actor | Notes |
|---|---|---|---|
| `draft` | `submitted` | owning client | submit request |
| `submitted` | `needs_qa` | ops/super | start QA |
| `needs_qa` | `client_correction` | ops/super | correction required |
| `needs_qa` | `proof_approval` | ops/super | client artwork/QA decision; not supplier proof |
| `needs_qa` | `approved_for_matching` | ops/super | ready to match |
| `client_correction` | `submitted` | owning client | resubmit |
| `proof_approval` | `approved_for_matching` | owning client | approve artwork/QA |
| `proof_approval` | `client_correction` | owning client | request artwork correction |
| `approved_for_matching` | `supplier_assigned` | ops/super | supplier must be approved and eligible |
| `supplier_assigned` | `approved_for_matching` | assigned supplier | decline/rematch |
| `supplier_assigned` | `awaiting_downpayment` | assigned approved supplier | request says `supplier_accepted`; acceptance + price + notification are atomic |
| `payment_authorized` | `production` | assigned supplier | after confirmed downpayment |
| `production` | `supplier_self_qc` | assigned supplier | production complete |
| `supplier_self_qc` | `ready_for_dispatch` | assigned supplier | ready for pickup |
| `ready_for_dispatch` | `rider_assigned` | approved rider/ops/super | normally dispatch accept; rider must be approved |
| `picked_up` | `out_for_delivery` | assigned rider | checklist already passed |
| `completed` | `payout_released` | ops/super | only when all milestones released/no hold |

Endpoint-owned steps:

- `awaiting_downpayment -> downpayment_review`: client submits downpayment.
- `downpayment_review -> payment_authorized`: Operations/Super Admin confirms downpayment.
- `rider_assigned -> picked_up`: all six pickup checks pass; no direct transition bypass.
- `picked_up|out_for_delivery -> delivered -> issue_window_open`: delivery evidence route atomically records delivery and opens window; no direct transition bypass.
- `issue_window_open -> completed`: system only, when `issueWindowExpiresAt` has elapsed and no active hold. No actor can close it early.

Retired states are never accepted: `supplier_proof_review`, `supplier_proof_changes_requested`, `supplier_proof_approved`, `awaiting_payment`. Migration maps them to `awaiting_downpayment` without deleting legacy proof files.

## Rider pickup checklist and escalation

```http
POST /dispatch/:id/pickup-checklist
```

```json
{
  "checks": [
    { "code": "quantity_match", "passed": true },
    { "code": "specification_match", "passed": true },
    { "code": "visible_defects", "passed": true },
    { "code": "packaging_integrity", "passed": true },
    { "code": "documentation", "passed": true },
    { "code": "supplier_sign_off", "passed": true }
  ]
}
```

Each code appears exactly once with boolean `passed`. All pass moves to `picked_up` and returns:

```json
{ "signOffPrompt": "GRIDGO partner! Quality check, done! Salamat po!" }
```

Any failure must include `failureNote` and one or more `evidenceFileIds` already attached to the order as rider-owned `delivery_photo` files. The order remains `rider_assigned`; `pickupChecklist.status` becomes `failed_escalated`; an `open` escalation and ops/super notifications are created. Until Operations resolves it, another checklist returns `409 pickup_escalation_open`.

Operations resolves with:

```http
POST /escalations/:id/resolve
```

```json
{ "resolution": "Supplier replaced the affected batch; repeat all six checks." }
```

The rider is notified and must resubmit all six checks.

## Delivery and issue window

Upload/attach rider `delivery_photo` evidence and delivered `fulfilment_proof`, then:

```http
POST /dispatch/:id/delivery
```

```json
{ "evidenceFileId": "file_123", "evidenceType": "photo" }
```

`evidenceType` is `photo | signature`; signature is allowed when the camera cannot be used. The assigned rider, passed checklist/active transport, confirmed digital balance, attached ready evidence, and delivered POF are required. Success stores `deliveryEvidence`, appends delivered history, then opens:

```json
{
  "state": "issue_window_open",
  "issueWindowOpenedAt": "2026-08-10T10:00:00.000Z",
  "issueWindowExpiresAt": "2026-08-11T10:00:00.000Z"
}
```

The hours snapshot comes from the one global setting. Every store load expires elapsed windows. A timely client issue auto-creates a held claim; a late issue returns `409 issue_window_closed`. With no active hold, expiry sets `completed` and automatically releases retention when delivered POF is present.

## Migration contract

Load-time `backfillOperationalModel()` is idempotent:

- adds `settings` and `escalations` collections;
- removes retired `zones[].deliveryFeeMinor`; delivery pricing comes only from `settings.deliveryFeeBands`;
- fills complete v2 order money, split payment, milestone, checklist, and issue-window fields;
- preserves legacy client-visible subtotal: old `totalMinor` becomes `subtotalMinor`; supplier price is reverse-derived and commission is the exact remainder; delivery is then added to new `totalMinor`;
- maps old COD payment records to `digital_manual_legacy`, removes `codEligible`, and creates coherent installment status from lifecycle progress;
- maps supplier-proof/old payment entry states to `awaiting_downpayment` and creates the assignment notification once;
- preserves `proofFileIds`, file objects, uploaded object metadata, artwork names, and every unrelated collection.

See `docs/V2_MIGRATION_CHECKSUMS.md` for the copied-live-store proof and exact hashes.
