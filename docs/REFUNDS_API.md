# Client refunds: available-funds settlement

This is the contract for the pilot policy decided on 28 September 2026 in [#74](https://github.com/gridgoph/gridgo-api/issues/74), implementing [#89](https://github.com/gridgoph/gridgo-api/issues/89). Policy version: `available_funds_v1`. Implementation: `src/refunds.js`, `src/refund-policy.js`; relational ledger: `src/refund-records.js` and migration `1790553600000_client_refunds`.

All money is **integer PHP centavos**, bounded by the JavaScript safe-integer range. Approval reserves funds; **it never sends money**. Operations transfers manually in a wallet app. Pilot Credits cannot be refunded as cash. No PayMongo or automatic recovery is involved.

## Policy and lifecycle

Before production, including an accepted order in `payment_authorized` and an order with no replacement shop in `approved_for_matching`, refund the entire verified collection. Filing immediately holds work and supplier payouts under the same transaction lock used by production start. Operations must confirm work stopped and zero shop/rider obligation before approval.

After production, Operations reviews a cancellation or substantiated complaint, documents the shop's agreed **total final entitlement**, and records any rider earnings. Released stages, released settlement payouts and previously recorded rider earnings are protected. The request cannot override this protection, even when the caller is Super Admin.

The calculation uses the order's original allocations and snapshots, not today's settings:

- Principal ceiling = verified principal − earlier approved principal refunds (including unpaid reservations) − actual released shop payouts − agreed remaining shop obligation.
- After production, service-fee return = the rounded cumulative share of the **original** service fee attributable to refunded principal, minus prior fee refunds, bounded by the unrefunded fee actually collected. BigInt half-up calculation and cumulative allocation give the final refund the exact centavo remainder. Before production, return all collected fee.
- Return collected, unrefunded delivery less the recorded rider entitlement if the trip was unused/aborted. A completed trip retains its delivery charge. A trip to GRIDGO Office is completed delivery service even while the parcel awaits client collection; it does not by itself start the client's complaint deadline.
- Earned rider amounts above remaining verified delivery collection require reconciliation, not an implicit GRIDGO-funded exception. Completed trips protect the immutable rider split (legacy missing split remains 100% pass-through).
- Pending payment screenshots must be confirmed/rejected before settlement. While a refund is open, Operations may still confirm/reject an already-submitted final installment, but no new installment can be submitted. A settlement prevents further collection.
- Historical direct-store plans require `directStoreCollectedMinor: 0` plus documented reconciliation. Paid or unknown direct-store amounts are referred to Super Admin; the API never recovers money held by the shop.

After client handover, filing must precede the recorded `issueWindowExpiresAt` and the client's early “everything is fine” confirmation. Equality with the deadline is late. A timely request remains actionable after expiry. Super Admin can file late cases on behalf of the client and must review/settle/reject them. The owning client still supplies their own QR. Late approval has the same available-funds ceiling; it does not authorize extra funding. A previous refund settlement does not itself constitute an early client confirmation.

Only one active request exists per order. A paid/rejected/withdrawn request remains immutable history; another eligible request aggregates earlier reservations and refunds. The request records its policy version, filing deadline, order state, late flag and before-production flag.

```text
requested -> reviewed -> approved -> payment_in_progress -> paid
    |            |          |                |
    +-> rejected/withdrawn  |                +-> payment_unknown
                            |                         |
                            +-> destination_review    +-> paid (same transfer)
                                  |                   +-> approved (confirmed no transfer)
                                  +-> approved
```

A failed attempt returns the request to `approved` only after the payer/Super Admin explicitly confirms no transfer occurred. `payment_unknown` pins the amount, destination and payer. If money was sent but recording failed, record that same transfer; do not send again. One completed client payout is allowed per approved request.

Before handover, settlement sets the order and its jobs to `cancelled`, cancels the unpaid balance obligation and stops fulfillment permanently. After handover, it sets them to `completed` with `refundDisposition: "fulfilled_with_refund"`. Original checkout amounts, payment confirmations, installment allocations, invoice and published milestone amounts remain unchanged. `unpaidBalanceCancelled` tells screens when the original unpaid installment is historical rather than collectible.

Claims and issues remain independent: releasing/dismissing one never removes the refund hold. A refund never silently resolves another claim. Active intake blocks expiry/early confirmation and every original milestone release. Original stages cannot be revived after settlement.

## Supplier settlement payout

Firstmate authorized this extension on 28 September 2026: on settlement, every still-unreleased original milestone is marked `superseded`, with `supersededAt` and `supersededBySettlementId`. It is neither released nor deleted. Amounts/shares and already released milestones are preserved and the closure is audited.

The agreed **remaining** shop obligation becomes one separate `supplierSettlementPayouts` item. For example, original shop cost 100000, actual release 40000, agreed final entitlement 60000 produces **one 20000 payout**, while the old 35000/25000 stages are superseded. Operations/Super Admin records this exact payment manually against the shop's current receiving QR with a reference and `payout_receipt` screenshot. Claims/open issues/pending refund reviews block it. A later settlement may supersede an unpaid settlement item; already paid items count toward protected releases.

The new item is exposed beside `payoutMilestones` in every role-aware order projection for Operations and the owning supplier. Clients/riders never receive its amounts, references or receipts. Client refund QR/receipts never appear in supplier/rider order projections.

## Routes and concurrency

Every route requires a Clerk session with current PostgreSQL membership. Client access is owning-order only. Operations means `ops_admin` or `super_admin` unless noted. A supplier/rider, other client, anonymous caller or support-desk-only session cannot access refund records or private refund files.

Every **mutation** requires `Idempotency-Key: <unique opaque string, 1–120 characters>`. Every mutation on an existing request requires `expectedVersion` equal to the current version. Successful retries with the same actor, key, route and JSON body return the saved response, without another event/payment. Reusing a key for another body/route returns `409 refund_idempotency_conflict`. Stale versions return `409 refund_stale` with `currentVersion`. A key is not a wallet reference.

| Method | Route | Access / result |
|---|---|---|
| GET | `/refund-requests?status=approved` | Client's own requests; Operations all requests. Optional exact status filter. `{refunds: Refund[]}` |
| GET | `/orders/:orderId/refund-requests` | Owning client/Operations. `{refunds: Refund[]}` |
| GET | `/refund-requests/:id` | Owning client/Operations. `{refund: Refund}` |
| POST | `/orders/:orderId/refund-requests` | Owning client/Operations; late filing Super Admin only. `201 {refund}` |
| PATCH | `/refund-requests/:id/destination` | Owning client only. `200 {refund}` |
| POST | `/refund-requests/:id/review` | Operations; late review Super Admin. `200 {refund}` |
| POST | `/refund-requests/:id/settlement-preview` | Operations, read-only calculation for requested/reviewed requests; no idempotency key needed. `200 {amounts, availableTotalMinor, canSettle}` |
| POST | `/refund-requests/:id/settle` | Operations; late settlement Super Admin. `200 {refund}` |
| POST | `/refund-requests/:id/reject` | Operations; late rejection Super Admin. `200 {refund}` |
| POST | `/refund-requests/:id/withdraw` | Owning client, before settlement. `200 {refund}` |
| POST | `/refund-requests/:id/payment-attempts` | Operations reserves one payer **before** sending. `200 {refund}` |
| POST | `/refund-requests/:id/reconcile` | Reserved payer or Super Admin. `200 {refund}` |
| POST | `/refund-requests/:id/payments` | Reserved payer or Super Admin records the external transfer. `200 {refund}` |
| POST | `/refund-requests/:id/supplier-payout` | Operations records the separate shop settlement payment. `200 {refund}` |

### Exact request bodies

Request (`destination` optional until review; `evidenceFileIds` optional, at most ten distinct uploads):

```json
{
  "kind": "cancellation",
  "reason": "The shop cannot fulfill this order.",
  "evidenceFileIds": ["file_evidence"],
  "destination": {
    "qrFileId": "file_client_qr",
    "provider": "gcash",
    "accountName": "Client Wallet Name",
    "ownershipConfirmed": true
  }
}
```

`kind`: `cancellation | complaint`. Destination `provider`: `gcash | maya | bank | other`. The client attests account ownership; uploading a QR alone is not verification. Operations creating a request on the client's behalf omits `destination`; only the client can set it.

Destination replacement:

```json
{"expectedVersion":1,"qrFileId":"file_new_qr","provider":"maya","accountName":"Client Wallet Name","ownershipConfirmed":true}
```

The server increments `destination.revision`. A change invalidates review/approval, preserves earlier QR evidence, and requires another review. It is refused during an active/unknown/completed transfer.

Review (`substantiated: true` required for complaints):

```json
{"expectedVersion":2,"reason":"Complaint evidence verified; receiving account checked.","destinationVerified":true,"substantiated":true}
```

Settlement preview, with optional `principalMinor` to propose a partial refund; omit it for the maximum. A historical direct-store plan also requires `directStoreCollectedMinor: 0`:

```json
{"expectedVersion":3,"shopEntitlementMinor":40000,"riderEntitlementMinor":0,"principalMinor":60000}
```

Preview response for the report's 40%-released example:

```json
{
  "amounts": {
    "principalMinor":60000,"feeMinor":6000,"deliveryMinor":5000,"totalMinor":71000,
    "collected":{"principalMinor":100000,"feeMinor":10000,"deliveryMinor":5000},
    "previous":{"principalMinor":0,"feeMinor":0,"deliveryMinor":0},
    "releasedMinor":40000,"remainingShopMinor":0,"shopEntitlementMinor":40000,
    "riderEntitlementMinor":0,"availablePrincipalMinor":60000
  },
  "availableTotalMinor":71000,
  "canSettle":true
}
```

Settlement (same calculation fields plus the exact previewed total, explicit stop confirmation and documented agreement):

```json
{
  "expectedVersion":3,"reason":"Agreed partial cancellation refund.","workStopped":true,
  "shopAgreement":"The shop agrees to retain the 40000 already received and waive the rest.",
  "deliveryEvidence":"No trip started; no rider earnings incurred.",
  "shopEntitlementMinor":40000,"riderEntitlementMinor":0,"principalMinor":60000,"totalMinor":71000
}
```

`reason` is **client-visible**. `shopAgreement`, `deliveryEvidence`, internal collections/releases and obligations are staff-only. Maximum reason/agreement/evidence-text length is 2000 characters. Approval is immutable: after settlement, reject/withdraw is refused. Only destination re-review and payment reconciliation remain available.

Reject or withdraw:

```json
{"expectedVersion":2,"reason":"The client chose to keep the order after the replacement was confirmed."}
```

Reserve a client transfer:

```json
{
  "expectedVersion":4,"reason":"Ready to pay the verified receiving account.",
  "destinationRevision":1,"destinationVerified":true,"provider":"gcash","sourceWallet":"ops-wallet-1"
}
```

`provider` and `sourceWallet` identify the **sending** wallet, are normalized to lowercase, and freeze with the destination/amount. Use a stable wallet identifier, never a password or secret. Open the returned frozen `attempt.destination` and check the receiving name in the wallet before sending.

Record the external transfer (`paidAt` must be an ISO timestamp no later than recording time):

```json
{
  "expectedVersion":5,"reason":"Original transfer verified in wallet history.",
  "attemptId":"rattempt_id","amountMinor":71000,"reference":"WALLET-123",
  "receiptFileId":"file_refund_receipt","paidAt":"2026-09-28T04:30:00.000Z"
}
```

Reference is normalized to uppercase (maximum 120 characters). `(provider, sourceWallet, reference)` is unique across completed client refunds; duplicate transfers return `409 refund_duplicate_transfer`. One ready `refund_receipt` upload owned by the recording operator is bound once. Label it **Wallet transfer evidence**, never an official receipt.

Reconcile a timeout, or confirm no debit before retry:

```json
{"expectedVersion":5,"reason":"Wallet timed out; debit is not yet known.","outcome":"unknown"}
```

```json
{"expectedVersion":6,"reason":"Wallet history confirms no debit occurred.","outcome":"failed","noTransferConfirmed":true}
```

For a successful unknown transfer, use `/payments` with the existing attempt ID. Do not reserve/send again. Only the reserved payer or Super Admin can reconcile/record it.

Record the shop's separate settlement payout:

```json
{
  "expectedVersion":4,"reason":"Agreed remaining shop payment sent.","amountMinor":20000,
  "payoutAccountVersion":1,"destinationVerified":true,"reference":"SHOP-200",
  "receiptFileId":"file_payout_receipt"
}
```

The amount must equal the pending item exactly. `/refund-requests/:id` supplies `supplierPayoutAccount` to staff (same private supplier QR contract as ordinary stages). A ready `payout_receipt` owned by the operator and a reference (maximum 80 characters) are mandatory. The supplier can read this transfer evidence; the client cannot. Idempotency/version checks prevent recording it twice. As with existing stage releases, the actual supplier wallet transfer occurs outside the API; coordinate that payment in Operations before sending.

### Exact client projection

```json
{
  "id":"refund_id","orderId":"order_id","status":"paid","version":6,
  "policyVersion":"available_funds_v1","kind":"cancellation","reason":"The shop cannot fulfill this order.",
  "evidenceFileIds":["file_evidence"],
  "destination":{"provider":"gcash","accountName":"Client Wallet Name","qrFileId":"file_client_qr","ownershipConfirmed":true,"revision":1},
  "beforeProduction":false,"late":false,"filingDeadlineAt":null,
  "createdAt":"2026-09-28T04:00:00.000Z","updatedAt":"2026-09-28T04:31:00.000Z",
  "history":[{"kind":"paid","reason":"Original transfer verified in wallet history.","at":"2026-09-28T04:31:00.000Z"}],
  "settlement":{"id":"rsettle_id","principalMinor":60000,"feeMinor":6000,"deliveryMinor":5000,"totalMinor":71000,"disposition":"cancelled","reason":"Agreed partial cancellation refund.","approvedAt":"2026-09-28T04:20:00.000Z"},
  "payment":{"id":"rpay_id","reference":"WALLET-123","receiptFileId":"file_refund_receipt","amountMinor":71000,"paidAt":"2026-09-28T04:30:00.000Z","evidenceLabel":"Wallet transfer evidence"}
}
```

`destination`, `settlement`, `payment` are nullable until set. `history` contains all client-visible events in request-version order; internal supplier-payment events are omitted. Status values are exactly those in the lifecycle diagram, plus `rejected` and `withdrawn`.

Staff get the same request fields, plus:

```text
clientId: string
collections: {principalMinor, feeMinor, deliveryMinor}
releasedShopMinor: integer
previousRefunds: Settlement[]
supplierSettlementPayouts: SupplierSettlementPayout[]
supplierPayoutAccount: existing private supplier payout-account projection | null
settlement: Settlement | null
attempt: Attempt | null
payment: Payment | null (plus evidenceLabel)

Settlement = {id, requestId, orderId, sequence, createdBy, createdAt, reason,
  shopAgreement, deliveryEvidence, disposition, shopEntitlementMinor,
  riderEntitlementMinor, principalMinor, feeMinor, deliveryMinor,
  platformDeliveryMinor, totalMinor, snapshot: PreviewAmounts}
// A historical direct-store snapshot additionally records directStoreDueMinor and directStoreCollectedMinor:0.
Attempt = {id, requestId, settlementId, payerId, status, destination,
  amountMinor, provider, sourceWallet, createdAt, updatedAt}
// status: in_progress | unknown | failed | paid; active attempt is null after confirmed failure.
Payment = {id, requestId, attemptId, provider, sourceWallet, reference,
  receiptFileId, amountMinor, paidAt, recordedBy, createdAt}
SupplierSettlementPayout = {id, settlementId, orderId, supplierId, amountMinor,
  status, reference, receiptFileId, releasedAt, releasedBy, createdAt,
  code:"refund_settlement", label:"Agreed refund settlement payout", releaseRequires:string}
// status: pending | released | superseded; transfer fields null until released.
```

All `*Minor` fields above are safe integer centavos; times are ISO strings. Staff `history` also includes internal supplier-payment events. The order JSON adds `refundHold`, `refundDisposition` and `unpaidBalanceCancelled`. Staff/supplier order JSON adds `supplierSettlementPayouts`; `supplierSettlement` reporting uses the final agreed entitlement and both kinds of actual releases. Staff additionally get `refundFinance: {approvedMinor, paidMinor, refundedPrincipalMinor, reservedMinor}`. Staff/rider get `refundDeliverySettlement: {riderEntitlementMinor, settlementId}` when settled; original rider split fields remain unchanged snapshots.

Only actual paid refunds append negative platform revenue adjustments, for returned service fee and returned GRIDGO delivery share. Shop principal is never subtracted from platform revenue. Gross confirmed collection remains separately visible from approved/reserved/paid refund totals.

## Files, privacy and retention

Upload through `POST /files` using the existing multipart contract:

| Purpose | Uploader | Images / limit | Bound by |
|---|---|---|---|
| `refund_qr` | Client | JPEG/PNG/WebP, 5 MiB | request or destination update |
| `refund_evidence` | Client/Operations/Super Admin | JPEG/PNG/WebP, 15 MiB | request |
| `refund_receipt` | Operations/Super Admin | JPEG/PNG/WebP, 15 MiB | client refund `/payments` |
| `payout_receipt` | Operations/Super Admin | Existing 15 MiB policy | supplier `/supplier-payout` |

Magic-byte/MIME/size checks are shared with ordinary uploads. Refund purposes cannot be bound through `/files/:id/attach`, public media or supplier payout-account routes. Cross-owner binding and receipt reuse are refused. Only the owning client and Operations/Super Admin can read bound refund images, metadata and short-lived download URLs. Unbound staff-uploaded evidence/receipts are staff-only. Ordinary `payout_receipt` remains supplier/staff-only.

The API never decodes or follows a QR URL. Object metadata and signed-response overrides set `Cache-Control: private, no-store, max-age=0`; refund JSON and file metadata/signing responses also use no-store. Signed URLs are still bearer credentials until expiry. Deployment must verify the production proxy/CDN respects these headers and denies expired signed links (existing infrastructure follow-up); local HTTP tests verify authorization and signed cache/expiry parameters.

Bound QR revisions, evidence and receipts remain referenced/pinned, including after destination replacement and terminal requests. Early deletion and scheduled expiry follow the [file retention policy](STORAGE_API.md#retention-and-daily-cleanup); an open refund always blocks deletion. The investigation's proposed 7/90-day retention periods were **not adopted** by this policy; the separately approved file policy keeps financial evidence for five years after order closure, with automatic deletion off by default. Notifications and audit records contain IDs/revisions, not QR contents or account names.

## Refusals

| Error | Meaning / next action |
|---|---|
| `refund_window_closed` | Client/Operations filing is late; contact Super Admin. |
| `refund_super_admin_required` | A late decision needs Super Admin. |
| `refund_requires_super_admin` | Proposed obligation would recover protected shop/rider funds or lacks verified delivery backing. No override endpoint. |
| `refund_exceeds_available_funds` | Requested amount exceeds the ceiling; `escalateTo:"super_admin"`, with available amount when applicable. |
| `refund_no_available_funds` | No available cash refund; escalate the remedy. |
| `refund_amount_mismatch` | Re-preview and confirm the exact computed total. |
| `refund_collection_reconciliation_required` | Reconcile pending/mismatched/non-cash/direct-store collection. |
| `refund_payment_not_verified` | No confirmed cash installment exists. |
| `refund_fulfillment_stopped` | Refund hold or terminal settlement prevents work/collection. |
| `refund_already_open` | Resolve the existing request. |
| `refund_stale` / `refund_idempotency_conflict` | Reload version / use the correct retry key/body. |
| `refund_destination_locked` / `refund_destination_stale` | Resolve an attempt or re-review the destination. |
| `refund_payment_reserved` / `refund_payer_required` | Another operator owns the attempt; do not transfer again. |
| `refund_duplicate_transfer` / `refund_payment_mismatch` | Reconcile the original transfer, not a second payment. |
| `payout_held` | Claims/issues/pending refund review still hold the shop payment. |
| `refund_supplier_payout_amount_mismatch` | Pay exactly the settlement item. |
| `refund_supplier_destination_verification_required` | Reload and verify the current shop QR/version. |

Malformed bodies return `400`, missing authentication `401`, forbidden roles/ownership `403`, missing records `404`, and state/financial conflicts `409`. Reasons explain recovery; no error grants authority to claw back or fund beyond available amounts.

## Notifications and screen follow-ups

Request/review/settlement/destination/attempt/reconciliation/payment/rejection/withdrawal events create durable inbox rows for the client, assigned shop and every current Operations/Super Admin membership. Supplier settlement-payment events go to that shop and staff. Invalidations use `orders`, `payouts` and `claims`; reload refund details on those events. Delivery remains the existing after-commit outbox boundary.

- **Client app:** own-order request/reason/evidence; receiving-QR ownership confirmation and replacement; complaint deadline/early-confirmation explanation; full vs partial approved breakdown; status/history, rejection reason, unknown-transfer state, paid transfer evidence; suppress collection actions when `unpaidBalanceCancelled`; distinguish approval from payment.
- **Dashboard:** refund inbox/order linkage, independent claims, verified/previous/reserved amounts, shop agreement and rider entitlement; server preview then settlement; stop-work confirmation; late Super Admin handling; QR name/revision verification; reserve one payer before transfer; unknown/failed reconciliation and same-transfer recording; client-visible decision reason; no extra-funds override.
- **Dashboard and supplier payout screens:** show superseded stages without calling them paid, and render the separately labelled settlement item beside them. Record the exact shop remainder using current shop QR/version plus mandatory reference and receipt; show holds and include these releases in settlement totals. Never expose this item to the client's order screen.
