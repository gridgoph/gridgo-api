# Cash on delivery and rider wallets

API contract for [cash orders](https://github.com/gridgoph/gridgo-api/issues/360), building on exclusive dispatch and the evidence decisions in [refunds and fault](REFUNDS_AND_FAULT_API.md). Client, rider and Operations/dashboard screens are separate follow-ups. Automated top-ups remain deferred to [payment integration](https://github.com/gridgoph/gridgo-api/issues/67).

Cash ships **OFF**. Deploying or migrating does not enable it. Online orders retain their checkout, dispatch, split and available-funds refund behavior. All amounts below are safe-integer PHP centavos. Routes require a current Clerk/database membership; riders must be approved.

## Settings and checkout

The existing `GET /settings` and Super Admin `PATCH /settings` document includes:

```json
{"expectedVersion":12,"reason":"Reviewed cash rollout","cash":{"enabled":false,"limitMinor":150000,"noShowWaitSeconds":600}}
```

Settings changes use the existing version check and audit. Operations cannot change cash settings. Partial cash updates preserve the other cash settings. `limitMinor` must be a positive safe integer; `noShowWaitSeconds` is an integer from 60 through 7,200. Defaults are PHP 1,500 and ten minutes. Disabling cash blocks new checkouts and new top-up submissions with `cash_disabled`. Existing balances stay readable, pending top-ups can still be confirmed/rejected, and existing cash orders can settle. Successful idempotent retries return their original response without moving money again.

The existing cart checkout accepts `payment: {"method":"cash"}` only for individual clients, delivery fulfillment, and a whole-cart printing subtotal plus service fee **strictly below** the limit, before delivery and voucher discounts. Business/organization accounts and unpaid no-show debt are refused. Multi-shop/delivery groups collect independently; the whole-cart eligibility limit still applies. A fully voucher-funded sale uses the existing voucher checkout instead.

Cash orders snapshot `paymentPlan: "cash_delivery"`, the cash limit/wait, rider commission 8,000 basis points, and payout plan 3 with one `cash_shop` stage. They enter file QA without pretending any payment was collected. Existing service-fee, quote, voucher and production snapshots remain authoritative. Digital checkout invoices retain `paymentPlan.method: "cash"`; retrieve invoices through the existing order invoice route. Each basket group has its own collection and Cash AR. No QR proof is required at checkout.

Ordinary order projections expose `cash` with `method`, `status` and the cash progress `version`. Client projections exclude shop payouts, wallet movements, fee splits and private progress. Operations and eligible riders see `cashAmounts`: `shopMinor`, `collectMinor`, `gridgoMinor`, `riderMinor`, and applicable deduction/voucher fields. Suppliers and Operations see `cashSettlement` with actual paid, returned, net paid and current shop obligation. Accepted cash terms freeze the payable shop amount; subsequent lateness can record warnings without changing the rider's commitment.

## Transactions and evidence

Every cash monetary POST, cash dispatch accept and cash delivery requires a nonblank `Idempotency-Key` of at most 120 characters. Retrying the same actor/key/path/body returns its committed response. A different request with that key returns `cash_idempotency_conflict`. Cash-specific order POSTs also require `expectedVersion` equal to `cash.version`; stale versions return `cash_stale`. Use the new version returned by each mutation. `incidentVersion` is informational and does not replace the cash version.

Upload evidence through the existing private storage flow, with the purpose listed below. It must be ready, JPEG/PNG/WebP, owned by the indicated actor, and previously unbound. The cash route binds it atomically. File bytes remain in MinIO. Cash financial evidence has five-year retention; pending top-ups and open incidents hold their evidence. Cash evidence reads are private/no-store, owner/Operations scoped, with explicitly bound shop receipts/returns and reprint receipts also readable by their shop. Client refund receipts are readable only by the owning client and Operations. Rider wallet activity excludes private client-remedy data.

## Manual top-ups

| Route | Role | Body/result |
|---|---|---|
| `GET /me/rider-wallet` | Rider | `wallet`, latest 100 `activity` rows and outstanding `incidents` |
| `POST /me/rider-wallet/topups` | Rider | `amountMinor` 20,000 / 50,000 / 100,000, `reference`, optional `screenshotFileId` (`cash_topup_proof`) |
| `GET /ops/cash/topups` | Operations/Super Admin | Latest 100 pending submissions with decision when present |
| `POST /ops/cash/topups/:id/confirm` | Operations/Super Admin | `reason`; bank verification credits the rider exactly once |
| `POST /ops/cash/topups/:id/reject` | Operations/Super Admin | `reason`; closes pending movement without wallet credit |

`wallet` contains `balanceMinor`, `reservedMinor`, `availableMinor`, `lowBalance` (available below PHP 100), and `topupAmountsMinor`. Activity includes `balanceDeltaMinor`, `availableDeltaMinor`, `reservedDeltaMinor`, type, order/time and top-up reference where appropriate. Pending top-ups do not increase spendable funds. References are trimmed/uppercase and confirmed incoming references cannot be reused across top-ups, repayments or redelivery payments. Confirm/reject is audited and notifies the rider and every current Operations/Super Admin membership.

## Offer, shop payment and signed client delivery

Wallet coverage is one extra check **inside the existing fair exclusive-offer rotation**, for cash only. It uses available funds, including reservations for other orders. It introduces no proximity, presence or active-trip filter. Offers show the exact shop payment, exact client collection, GRIDGO share and rider earnings. A rider with insufficient funds receives no cash offer.

1. Existing `POST /dispatch/:id/accept` adds `{ "offerId":"offer_...", "shopCashConfirmed":true }`. The rider confirms having physical cash for the shop. Accept reserves the existing snapshotted service fee plus GRIDGO's 20% delivery share, including any already-applied shop deduction. Database constraints prevent negative available or held balances. Concurrent accepts and retries reserve once.
2. `POST /dispatch/:id/cash/shop-payment` takes `expectedVersion`, exact `amountMinor` and rider-owned `receiptFileId` (`cash_shop_receipt`). It records the actual cash advance and releases the cash shop stage. This is required before pickup. Existing counter counts, six checks, QA, packing photo and signed shop pickup remain required; the receipt cannot bypass them.
3. Use the ordinary rider progress routes: `POST /dispatch/:id/milestones` for `heading_to_shop`, `at_shop` and `arrived`, and the shared `POST /orders/:id/transition` to `out_for_delivery` after signed pickup. After arrival, attach the existing `delivery_photo`. `POST /dispatch/:id/cash/collect` takes `expectedVersion`, `cashReceived:true`, exact `amountReceivedMinor`, and attached `evidenceFileId`. It records actual collection, automatically consumes the reserved GRIDGO share, credits any existing voucher subsidy, and issues the immutable AR marked **Cash**. It returns `receipt.arNumber` for the signature.
4. Complete existing `POST /dispatch/:id/delivery` with the existing delivery/OTP evidence plus `receiptMode:"digital"` and `acknowledgementSignature:{"fileId":"...","signerName":"...","arNumber":"..."}`. A client signature is mandatory. A retry returns the original response and cannot settle twice. Collection and the final signed handover are distinct facts; recording actual cash does not fabricate a signature.

`GET /orders/:id/cash` is owning-client, assigned-rider and Operations scoped. Operations receives private `progress`; client/rider projections are minimized. Ordinary online payment, manual rider reassignment, repricing, online refund and direct transition shortcuts reject cash orders with `cash_route_required` or a cash handover error. Cash orders have no change-of-mind cancellation quote/refund.

## No-show or refusal

| Route | Role | Body/condition |
|---|---|---|
| `POST /dispatch/:id/cash/no-show-start` | Assigned rider | `expectedVersion`, `contactMethod:"call"` or `"message"`; must have arrived after shop payment |
| `POST /dispatch/:id/cash/no-show-report` | Assigned rider | `expectedVersion`, `reason`, `photoFileId` (`cash_no_show_photo`), after the server-measured snapshotted wait |
| `POST /ops/cash/orders/:id/approve-no-show` | Operations/Super Admin | `expectedVersion`, `reason`, own `returnPhotoFileId` (`cash_return_photo`), proving return to GRIDGO |
| `POST /ops/cash/orders/:id/reject-no-show` | Operations/Super Admin | `expectedVersion`, `reason`; retains rejected report history and permits a new report |

Approval credits the **actual net shop advance** to the original rider wallet, releases the unused GRIDGO-share reservation and records a client receivable. It does not mark the sale collected. The parcel becomes `awaiting_collection`; the client cannot place another cash order until online repayment is confirmed. Repeated approval cannot reimburse twice. No-show after actual client collection is refused.

The owning client submits `POST /orders/:id/cash/repayment` with `expectedVersion`, exact `amountMinor` equal to the original sale total, `reference`, and `proofFileId` (`cash_repayment_proof`). Operations uses `/ops/cash/orders/:id/confirm-repayment` or `/reject-repayment` (reason required on rejection). Confirmation records bank receipt, clears the receivable, credits the original rider's fare and recognizes GRIDGO/voucher shares. Original cash sale amounts and payment method remain unchanged; `confirmationSource` distinguishes the online debt repayment.

For paid redelivery:

1. Client `POST /orders/:id/cash/redelivery-quote` with `expectedVersion` quotes GRIDGO Office to the original destination using shared current zone pricing and the current online rider split. Quote expires in 15 minutes.
2. Client `/redelivery-payment` takes `expectedVersion`, `redeliveryId`, `acceptCost:true`, exact `amountMinor`, `reference`, and `proofFileId` (`cash_repayment_proof`). Zero-fare quotes require no transfer proof.
3. Operations `/ops/cash/orders/:id/confirm-redelivery` with `expectedVersion` confirms actual payment, snapshots a separate digital redelivery invoice and reopens normal fair dispatch. `/reject-redelivery` requires `expectedVersion` and `reason`, retains the submitted evidence and makes no monetary entry; the client can submit new proof or refresh an expired quote. No second shop advance or cash-share reservation is required.
4. Riders use `activeTrip.pickup/dropoff` and active leg amounts; the original pickup, total, fare and OTP snapshots remain unchanged. Existing signed delivery settles the prepaid redelivery fare into rider wallet and GRIDGO revenue once. The delivery AR lists the original online repayment and the additional online redelivery fare.

## Shop cannot fulfill before client collection

Operations may `POST /ops/cash/orders/:id/cancel-unpaid` with `expectedVersion`, `reasonCode:"supplier_failure"` or `"artwork_unproducible"`, `noCashAdvancedConfirmed:true`, `shopObligationMinor:0`, and `photoFileId` (`cash_incident_photo`, assigned-rider owned, or Operations owned before assignment). This is available only before any actual shop advance/client collection. It releases any unused reservation, supersedes unpaid stages without rewriting their amounts, restores eligible vouchers and cancels without barring the client.

After an actual shop advance, Operations instead opens `/ops/cash/orders/:id/incident-open` with `expectedVersion`, `reason` and own `photoFileId` (`cash_incident_photo`). This creates a visible **outstanding rider claim linked to order and shop**, blocks further handover/collection and moves no GRIDGO money. `GET /ops/cash/incidents?status=outstanding|resolved` and the rider wallet expose these incidents.

The enabled resolution is `/ops/cash/orders/:id/incident-return`: `expectedVersion`, `resolutionType:"supplier_cash_return"`, exact actual `amountMinor`, `riderReceiptConfirmed:true`, and rider-owned `receiptFileId` (`cash_shop_return`). Partial returns remain outstanding. Once the whole actual advance is returned, the API releases the unused reservation and cancels without barring the client. It preserves the original paid stage and separately records counter returns. A zero-value advance requires `amountMinor:0` and `noTransferRequired:true` with evidence and confirmation.

**Open policy point:** a GRIDGO-funded advance to reimburse a rider when the shop cannot return cash is not enabled. The claim stays outstanding for Operations. `gridgo_advance` resolution is rejected. A later captain decision can add a distinct resolution type to this incident model without rewriting prior cash facts.

## Evidence-backed remedies after collection

Use the existing gathered issue evidence, `POST /issues/:id/decision` and Super Admin approval above PHP 1,000 of GRIDGO funding. Cash change-of-mind refunds are unavailable. These cash-only payment routes implement the approved fault decision; the existing online available-funds calculator is unchanged.

For client partial/full refunds, the owning client sets `/orders/:id/cash/remedy-destination` with `expectedVersion`, `ownershipConfirmed:true`, `accountName` and own `qrFileId` (`cash_remedy_qr`). Reprint/replacement uses the shop's existing verified payout destination instead.

Operations reserves `/ops/cash/orders/:id/remedy-reserve` with `expectedVersion`, `issueId`, `decisionId`, `destinationVerified:true`, `sourceWallet`, `provider`, and either `destinationRevision` (refund) or `supplierDestinationVersion` (reprint/replacement). Only an approved, evidence-citing non-client-fault decision can reserve. Amounts come from that decision. Client refunds cannot cumulatively exceed verified collection; any non-advance funding must fit actual retained service fees/deductions. Reprint/replacement is GRIDGO funded. One manual payer is reserved with an immutable destination/decision snapshot.

Operations manually transfers outside GRIDGO, then records `/remedy-pay` with `expectedVersion`, exact `amountMinor`, `reference` and own `receiptFileId` (`cash_remedy_receipt` for client refunds; `cash_reprint_receipt` for shop remedies). Only the reserved payer or Super Admin can finish. The ledger records the actual GRIDGO advance and fee funding separately. Shop-fault advances create a separate shop receivable; they never debit protected rider earnings, rewrite released payouts or create a negative shop wallet. Recovery is recorded as a receivable only; no automatic cross-order deduction ships here.

Uncertain transfers use `/remedy-reconcile` with `expectedVersion`, `outcome:"unknown"`, `reason`; no second payer may reserve. Confirmed non-transfer uses `outcome:"not_sent"`, `noTransferConfirmed:true`, `reason` before retrying. Decision edits and receiving-QR changes are held while a manual attempt is reserved/unknown. For reprint/replacement, supplier `PATCH` and `DELETE /me/payout-account` return `cash_remedy_destination_locked`, including account-name changes, QR replacement and QR removal. GET remains available; confirmed non-transfer or recorded payment releases the lock and preserves the original attempt snapshot. Paid decision IDs and provider/source/reference combinations are unique. Reprint receipt access is restricted to the shop/Operations, not the client/rider.

## Ledger and reconciliation

`cash_journals`/`cash_entries` are double-entry, append-only PostgreSQL records, with evidence and immutable event keys/fingerprints. Signed debits are positive and credits negative. Rider wallet and held accounts are liabilities displayed as positive balances; external cash custody, bank, receivables, revenue, voucher and remedy expense accounts keep explicit counterparties. Pending top-ups have clearing entries and no spendable credit. Account balances derive only from journal inserts; checks forbid negative wallet/held balances, unsafe integers, unbalanced journals, later entry insertion, mutation or truncation.

`GET /ops/cash/reconciliation?orderId=...&riderId=...` returns `ok`, journal checks, derived account balances, invalid reservations and per-order expected-movement checks/net account vectors. Omit filters for the complete ledger. It checks actual snapshot amounts and authorized remedies as well as double-entry equality; a balanced journal for the wrong shop amount fails. Outstanding incidents and no-show debt reconcile as explicitly open external claims/receivables. They are not fabricated cash receipts or cleared liabilities.

Operations should require `ok:true` and examine any outstanding incidents before cash rollout. The migration retains cash disabled; enabling production requires the companion client, rider and dashboard releases and an explicit Super Admin setting change.
