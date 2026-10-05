# Production deadline requests

Backend contract for supplier issue 101. All routes require a Clerk bearer and current database membership. Dual-role callers should send `X-Gridgo-Role`. Mutations, request history, audit, notifications and money/work holds commit under the domain transaction lock.

## App and dashboard endpoints

| Caller | Method and path | JSON body / query |
| --- | --- | --- |
| Assigned, approved supplier | `POST /orders/:id/reschedule-request` | `{ "reason": "Equipment repair", "proposedReadyBy": "2026-11-12T08:00:00+08:00" }` |
| Owning client, requesting supplier, Operations/Super Admin | `GET /orders/:id/reschedule-request` | No body; `{request:null}` before a request exists |
| Owning client | `POST /orders/:id/reschedule-request/answer` | `{ "requestId": "resched_…", "answer": "accept" }` or `"decline"` |
| Owning client | `POST /orders/:id/reschedule-request/rematch` | `{ "requestId": "resched_…", "action": "refresh" }` or `{ "requestId": "resched_…", "action": "accept", "offerId": "rematch_…" }` |
| Owning client | `POST /orders/:id/reschedule-request/refund` | `{ "requestId": "resched_…", "destination": {…} }`; destination optional, follows [refund API](REFUNDS_API.md). Requires `Idempotency-Key`. |
| Operations/Super Admin | `GET /ops/reschedule-requests` | Optional `status` and `supplierId` filters |
| Supplier | `GET /me/reschedule-requests` | Optional `status`; own historical requests only |
| Operations/Super Admin | `POST /orders/:id/reschedule-request/resolve` | `{ "requestId": "resched_…", "reason": "Client and shop agreed to continue under the original deadline." }` |

Creation returns `201 {request}`; reads and actions return `200 {request}`. Queues return `{totalRequests, requests}` ordered newest first. `totalRequests` is the supplier-filtered lifetime count before the status filter, so expired, declined and accepted requests all remain on the shop's record. A replacement supplier cannot submit a second request on the same order. Queue history remains readable by the requesting supplier after reassignment, without access to the replacement's order or files.

The same role-safe `rescheduleRequest` summary appears in order/job projections. Common fields are `id`, `orderId`, `reason`, `status`, `requestedAt`, `expiresAt`, `answeredAt`, `resolution`, `refundRequestId`, and `workHeld`. Status is `pending | accepted | declined | expired | operations_required`. Resolution is null or `rematch_offered | no_match | operations_required | rematched | refund_requested | resolved`.

- Supplier: `originalReadyBy`, `proposedReadyBy`; no padded promise.
- Client: `originalPromiseBy`, `proposedPromiseBy`, `canRequestRefund`, and `rematch`; no shop deadline, payout amount, internal evidence or shop identity in the offer.
- Operations/Super Admin: both dates, internal offer selection, applied deduction amount, archived warning and resolution reason/timestamp.
- Rider/unrelated parties: no request details.

## Request and acceptance

Only `production` or `supplier_self_qc`, before `readyAt`, can request a deadline. The reason is required, at most 2,000 characters. The proposed shop-ready timestamp must include a timezone, be in the future, and be later than the current shop deadline. Existing refund work stops still apply. Orders without reconcilable original dates must go to Operations.

Exactly one request is allowed per order for its lifetime. Original request facts are protected by migration `1791255600000`; no deletion, replacement, renewed request or second answer can clear its history. The request does not change any dates until acceptance. An unanswered request expires at **requestedAt + 24 hours**, including the exact boundary. The lifecycle worker and late-answer route both record expiration once, notify Operations and Super Admin, and retain the original deadline. Ordinary expired requests do not stop work.

Acceptance changes `readyBy` and moves `promiseBy` by the same interval, preserving the snapshotted gap between the two dates. Effective `promisedDate` in order projections follows the renewed date for the caller (shop-ready for suppliers, client promise for clients); immutable original quote/invoice snapshots remain historical. Future production penalties measure the renewed `readyBy`. An unapplied warning is archived on the request, with its existing audits/notifications retained; a later renewed-date breach starts a new warning and assessment. Pending/declined/expired requests never rebase lateness. Requests count on the shop record regardless of outcome.

The issue window is **actual handover + the configured issue-window duration**, not a timer starting at the promised date. Acceptance does not prematurely open, shorten or expire that window. Subsequent handover opens it normally; payout gates remain tied to actual production/delivery/window events. Inactivity reminders remain tied to actual shop progress, not the proposed date.

### Already-applied production deduction

An applied deduction routes the request to `resolution: operations_required` and holds work/payout. Operations sees `appliedDeductionMinor`. The client can still answer: acceptance becomes `status: operations_required` with dates unchanged; decline remains declined with Operations resolution required. This guard is rechecked at answer and rematch acceptance. No automatic extension, reassignment, ledger reversal or deduction forgiveness occurs. Original money, stage snapshots and applied ledger rows remain intact.

## Decline and replacement consent

Decline holds fulfillment and payout independently of claims/refunds. Releasing a claim cannot release this hold. No released shop share means matching can offer a replacement; any released stage or settlement payout routes to Operations instead. The client can choose a full refund after declining, including when a replacement is available but unwanted.

Matching uses the client's ranking, live approved/open supplier gates, capacity/calendar projection and original client deadline. It excludes the original and previously declining shops. Every original line must have a compatible replacement in one shop. Compatibility is deliberately conservative: same product family, item name/description, pricing unit/package/measurement unit, selected option group/label, format support and printer width. Structured specs must have equal governed bindings on selected replacement options. Unsupported or incomplete historical specs produce no automatic match. Replacement pricing for the **whole original selection** must fit the original supplier subtotal; using a listing's floor price is insufficient.

`rematch` is `{id, promiseBy, expiresAt, sameProductAndSpecs:true, priceUnchanged:true}`. An offer lasts 15 minutes, grants no assignment or file access, and is rechecked for eligibility, original specs, listing/service versions, price, pickup and promised date at acceptance. `refresh` produces a fresh offer or `no_match`. It cannot silently accept a changed selection.

Client consent changes the assigned supplier and associated jobs/pickup, returns the order to `supplier_assigned`, and clears the original supplier's active proof/stage attachments. Their previous proof/stages and any unapplied warning remain historical on the request. The replacement accepts the job through the existing supplier transition to `payment_authorized`. Original finalized product/spec/quantity/artwork lines, client total, collection, delivery fee/split and payout-plan shares remain unchanged. Job ownership moves with assignment so the old supplier loses artwork access and the new supplier sees the same production instructions.

No eligible match produces `resolution: no_match`. The order stays held; the client can refresh, request a full refund, or await Operations. There is no automatic supplier change or client charge.

## Refund and Operations resolution

`/refund` atomically opens an ordinary cancellation refund request, records `requestedRefund: full`, returns its `refundRequestId`, and changes resolution to `refund_requested`. Replays return the same request. The client can provide the receiving destination now or later through the refund endpoints. This is a full-refund **request**, not an invented transfer: Operations reviews and settles through the existing available-funds ledger, destination review and reserved manual payment workflow. Released obligations require Operations/Super Admin reconciliation; this endpoint cannot recover a paid share or bypass the available-funds cap. A zero-entitlement order supports refunding all verified principal, fee and unused delivery funds.

`/resolve` records the Operations decision and releases only the reschedule hold, preserving the current assignment, original dates, money and independent claim/refund holds. It requires a reason and cannot bypass an active or settled refund. It is for an agreed continuation under existing terms; refunds use the refund workflow. It never retrospectively applies the proposed extension or automatically reallocates a paid order.

## Errors and events

Errors use `{error:"snake_case"}`. Main conflicts: `reschedule_already_requested`, `reschedule_not_available`, `reschedule_dates_missing`, `reschedule_stale`, `reschedule_already_answered`, `reschedule_expired`, `reschedule_rematch_unavailable`, `reschedule_offer_expired`, `reschedule_offer_stale`, `reschedule_operations_required`, `reschedule_refund_unavailable`, `reschedule_resolution_unavailable`. Invalid input: `invalid_reschedule_reason`, `invalid_reschedule_date`, `invalid_reschedule_answer`, `invalid_rematch_action`. Held fulfillment returns `reschedule_fulfillment_stopped`; payout release remains blocked independently.

Durable `order_reschedule_{requested,accepted,declined,expired,operations_required,rematch_refreshed,rematched,refund_requested,resolved}` inbox rows go to the client, requesting shop and every current Operations/Super Admin membership. A replacement receives the accepted-replacement event. `save()` owns after-commit outbox/realtime delivery. Push data keeps the existing allowlist; dates, reasons, shop identity and money are not added to push data. Order/job/payout invalidations accompany mutations.

Backend only: supplier/client screens and dashboard rendering must consume these endpoints in their own releases.

## Basket groups and shop recovery

Use each basket group’s `orderId` for these endpoints. The one-request limit, changed dates, holds and replacement apply only to that group; sibling orders and the immutable basket deadline, payment and receipt stay unchanged. Basket responses expose the group’s effective date through its role-safe order projection.

An unresolved shop recovery blocks deadline answers and replacement acceptance. A declined deadline hold blocks shop cancellation and shop-recovery acceptance, so neither workflow bypasses the other. A consented reschedule replacement starts a fresh shop-acceptance window. Earlier shops’ lapse history is retained.
