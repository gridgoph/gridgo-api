# Special instructions and shared order change requests

Report F9FCD485. Apply migration `1792056000000_order_change_requests` before deploying. Client, supplier and dashboard screens are follow-ups; this release provides the shared backend for special instructions and future consultation flows.

## Notes and shop acceptance

`POST /me/carts/:id/lines` and `PATCH /me/carts/:id/lines/:lineId` accept optional `specialInstructions`, a trimmed string of at most **300 Unicode characters**. Null or empty clears a draft note; omission on PATCH preserves it. Each item has its own note, including multi-shop/deadline baskets. Cart reads and compact line-mutation responses include it. Legacy `POST /orders` also accepts an order-level note.

Show “Notes cannot change the price” beside the input. A note never changes quantity, configured options, fees or matching. The server normalizes compatibility characters/invisible separators and masks recognizable phone numbers, email addresses, social `@handles`, platform-prefixed handles, domains and URLs as `[masked]` **before persistence**. Normal print sizes and short quantities remain. Deliberately written-out or disguised contact details are not a semantic moderation service. Validate both original and masked text against the limit; do not truncate silently.

Checkout freezes each masked note on its order line and original invoice. Notes cannot be edited on a committed order. `productionItems[].specialInstructions` appears for the owning client, scoped shop and Operations/Super Admin; rider projections omit it. `specialInstructionLines: [{lineItemId,text}]` also supplies the notes for the shop's acceptance screen. Legacy notes use `order.specialInstructions`.

A shop accepting `supplier_assigned` through `POST /orders/:id/transition` with `state: "payment_authorized"` (or legacy `supplier_accepted`) must include `specialInstructionsRead: true` when any of its notes is nonempty. Otherwise: `409 special_instructions_acknowledgement_required`. The server stores the shop ID, timestamp and exact masked notes in `specialInstructionsAcknowledgement`, and writes an append-only audit entry. Existing no-note orders need no new field. Replacement shops must acknowledge again.

If the shop cannot fulfil the note, the existing `/orders/:id/decline` accepts `{ "reason": "Special instructions not possible" }`. After acceptance, use the existing shop-cancel recovery flow. Do not silently reinterpret the note or adjust money.

## Shared request routes

All routes require Clerk authentication. Only the assigned, approved supplier creates a request; only the owning client answers or submits payment; only Operations/Super Admin confirms/rejects payment. Reads are owning-client, assigned-approved-supplier and staff only. Historical multi-shop orders require Operations reconciliation; new independent basket groups each use their own order.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/orders/:id/change-requests` | `{changeRequests: [...]}` |
| GET | `/orders/:id/change-requests/:changeId` | `{changeRequest}` |
| POST | `/orders/:id/change-requests` | Create; `201 {changeRequest}` |
| POST | `/orders/:id/change-requests/:changeId/answer` | Accept or decline |
| POST | `/orders/:id/change-requests/:changeId/payment` | Submit supplemental QR proof |
| POST | `/orders/:id/change-requests/:changeId/payment/confirm` | Verify exact collection and apply atomically |
| POST | `/orders/:id/change-requests/:changeId/payment/reject` | Reject unverified transfer, retain evidence |

Every mutation requires a nonblank `Idempotency-Key` of at most 120 characters. Actions on an existing request also require its `expectedVersion`. Exact actor/key/route/body retries return the original response. Different reuse returns `409 change_request_idempotency_conflict`; stale versions return `409 change_request_stale`.

Create body:

```json
{
  "lineItemId": "line_id",
  "reason": "The requested staple needs additional finishing",
  "proposedSpec": "Staple on the left; retain the original paper and print settings",
  "extraPrincipalMinor": 1000,
  "proposedReadyBy": "2026-11-01T08:00:00+08:00"
}
```

`reason` is required (1–2,000 characters). `lineItemId` must belong to the order; omit only for legacy orders without lines. `proposedSpec` is a masked textual specification amendment, maximum 300 characters. It does not overwrite original item/option/quantity/artwork snapshots. Omit it for a time-only request. `extraPrincipalMinor` is nonnegative safe-integer PHP centavos, default zero; negative prices and reductions are not supported by this route. Existing refund/recovery procedures remain the path for reductions/cancellation. At least a specification or time change is required.

A proposed ready time must be a future ISO timestamp with timezone. The server preserves the order's original ready-to-client-promise allowance and returns `proposedPromiseBy`. The client should see the **client promise**, not just the internal shop-ready time. A changed underlying deadline, expired proposal date or applied production deduction requires reconciliation. The legacy deadline-request endpoint remains supported; one pending general change and a pending legacy deadline request cannot overlap.

Requests require an already committed order and the production window before first `ready_for_dispatch` (assignment, acceptance, production or supplier self-QC). Returning to an earlier state does not reopen a recorded readiness window. One request may await a decision/payment at a time; up to 50 requests may be retained per order. Existing claim/refund/recovery payout and work holds remain independent.

Answer:

```json
{"expectedVersion":1,"answer":"accept"}
```

`answer` is `accept | decline`. Zero-price acceptance applies immediately. Priced acceptance becomes `pending_payment`; **approval is not payment**. Decline becomes `declined`, preserving the original order. A client can also decline an accepted-but-unpaid request before proof submission. Unanswered or unpaid requests leave the originally agreed work and money in effect; they do not authorize changed work. Once readiness closes the window, acceptance/payment submission returns `409 change_request_window_closed`; the client can still decline an unpaid request. Normal readiness, recovery or reassignment closes unresolved, unsubmitted proposals as `closed`, with an audited reason; they never follow an order to a replacement shop.

## Supplemental QR collection

The supplement is **extra shop principal + incremental GRIDGO fee**. Use the order's frozen fee schedule, not current settings:

```text
fee(original principal + earlier paid extras + this extra)
  - fee(original principal + earlier paid extras)
```

Each fee uses the existing once-per-group half-up integer rounding. Earlier paid extras are included so repeated changes cannot restart the brackets. Legacy flat-rate orders retain their frozen rate. **Vouchers and organization discounts are not re-applied**; no discount is granted on a supplement. The entire supplement is collected up front, even on a legacy 75/25 order.

Original checkout totals, installments, allocations, basket receipt, invoice, and published payout shares stay unchanged. New collections are append-only relational `order_change_payments`; request money is PostgreSQL `money_minor` (safe BIGINT). Client/staff order projections add `supplementalTotalMinor` and `totalIncludingSupplementsMinor` (original checkout plus supplements; delivery-pin adjustments remain separately reported). Clients receive each request's total; shop principal, fee working, internal dates and supplemental payout records stay private. Suppliers receive their additional principal but no client proof or client total. Staff receive the complete terms/history.

After sending the full supplement to the existing platform receiving QR:

```json
{"expectedVersion":2,"proofFileId":"file_payment","reference":"WALLET-123"}
```

The file must be an unused, own, ready `payment_proof`. It becomes private order evidence. State becomes `pending_confirmation`. A submitted transfer must be resolved before readiness/closure, reassignment, shop cancellation or refund intake can strand that money (`409 change_payment_pending`). Work on the original spec can continue. Acceptance timeout processing defers an assignment with a submitted supplemental transfer until it is reconciled.

Operations confirms:

```json
{"expectedVersion":3,"amountMinor":1100,"reason":"Exact transfer verified"}
```

Confirmation verifies the exact total, records the collection, applies the specification/time change, audits and notifies in one transaction. Wrong amounts return `409 change_payment_mismatch`; already-used collection references return `409 change_payment_reference_used`. The server does not call a payment gateway or assert a transfer solely from an uploaded image.

Reject with `{expectedVersion,reason}` at `/payment/reject`. The request returns to `pending_payment`; proof history and file references remain durable. A replacement proof must be a new upload. Rejection means staff did not verify the claimed transfer; it is not a refund of real money. Reject remains available during an independent work hold. Refresh after conflicts.

## Agreed specification, quality review and dispute evidence

Only applied changes appear as `productionItems[].agreedChange: {id,proposedSpec,appliedAt}`. Display the latest applied amendment alongside the original note/options, and keep the full `changeRequests` history available as evidence. An unpaid proposal must never replace the production specification. A time-only amendment archives unapplied lateness warnings and updates effective `readyBy`/`promiseBy`, preserving the original dates in its immutable request terms. App QC and Operations quality-review screens must show the original note, shop acknowledgement, latest agreed amendment and decision history.

Staff can search `GET /ops/special-instructions?q=staple&offset=0`. It returns `{orders,nextOffset}`, at most 100 results, containing original notes, per-line notes, acknowledgements and requests. Search is case-insensitive over notes and request descriptions/reasons. Only Operations/Super Admin may access it. Normal client/supplier order authorization remains unchanged.

## Final shop payout and refunds

The added principal is a **separate supplemental shop obligation**, released with the order's final payout stage (`issue_window` for plan 2, `retention` for plan 1). Published stage shares and amounts never change. Staff see pending supplement obligations in `changeRequests[].payout`; the supplier settlement includes supplemental principal, releases and outstanding amounts. Claims, refund settlements, recovery and existing stage prerequisites still block release.

When supplements exist, the final `/orders/:id/milestones/:code/release` additionally requires a `reference`, own unused `payout_receipt` `receiptFileId`, and **`amountMinor` equal to original final-stage amount plus all pending supplemental principal**. This records one combined transfer with separate immutable `order_change_payouts` rows. Wrong totals return `409 supplement_payout_amount_mismatch`; missing evidence returns `400 supplement_payout_receipt_required`. Replays cannot release a supplement twice. Legacy automatic retention closure is disabled only on orders with paid supplements so staff can record the combined transfer.

Refund accounting includes verified supplemental principal and fees, and protects released supplemental payouts. Existing available-funds policy, cumulative proportional fee refund rounding, immutable settlement and manual transfer reservation controls apply to the combined obligation. A refund settlement supersedes unpaid supplemental obligations along with unpaid original stages; do not pay them through the final milestone after a settlement. Paid supplements prevent automatic shop replacement; Operations must reconcile that exceptional recovery rather than assign the supplement to another shop.

Every request, answer, proof decision and supplemental release uses append-only audit records. Current Operations **and** Super Admin memberships receive durable inbox events together with the client and assigned shop. `orders`, `jobs` and `notifications` invalidations are queued before commit; delivery runs after commit. Push payloads contain only the existing allowlisted identifiers, never notes or payment details.
