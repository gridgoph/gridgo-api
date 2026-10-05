# Shop acceptance and recovery

Refs gridgoph/gridgo-supplier#102. All endpoints require a Clerk session and the
specified database membership. Mutations use the domain transaction lock; the
order, event history, audit and notification outbox commit together.

## Supplier app

`GET /jobs` and `GET /orders/:id` include `shopAcceptance` for the assigned shop:

```json
{"supplierId":"supplier_id","assignedAt":"2026-10-10T09:30:30.000Z","deadlineAt":"2026-10-12T00:30:30.000Z","workingMinutes":60,"status":"pending"}
```

The window counts exactly **60 opening minutes**, using the assignment-time
snapshot of the shop schedule (including closures, split shifts and UTC offset).
Schedule edits do not extend an existing assignment. Existing assignments receive
a fresh window on the first lifecycle sweep after deployment. Accept with the
existing `POST /orders/:id/transition` and `{"state":"payment_authorized"}`
(or the existing legacy quote acceptance action). The server checks expiry even
when its lifecycle sweep has not yet run. At the deadline, an unanswered
assignment records `timed_out` once and enters recovery. Normal lifecycle cadence
is 30 seconds; the deadline itself is exact. Countdown UI must account for closed
time; `deadlineAt` is the absolute expiration, not 60 wall-clock minutes.

- `POST /orders/:id/decline` — initial assignment only.
- `POST /orders/:id/shop-cancel` — any assigned-shop stage before rider pickup,
  including accepted, production, self-QC, packed and rider-assigned.
- Both require `{"reason":"Unable to complete this run"}` (1–2,000 trimmed
  characters); only the assigned approved supplier can call them. The legacy
  transition to `approved_for_matching` uses this same decline flow and reason.
- `GET /me/shop-failures` — own durable failure history, including `orderId`,
  `supplierId`, `kind` (`timed_out|declined|cancelled`), `stage`, `reason`, `at` and
  actor. Repeated cancellation returns `409 shop_recovery_pending`.

The order retains its original state/assignment while awaiting a choice.
`shopRecovery.status` is an independent fulfillment and payout hold, including
Operations transitions, dispatch acceptance and file attachment. Releasing a claim
cannot remove it. Held orders are absent from dispatch offers.

## Client app

`GET /orders/:id/shop-recovery` returns `{recovery}` (also embedded in the order).
Only the owning client, original assigned supplier and Operations can read it.
The client projection is:

```json
{"id":"shop_event_id","status":"awaiting_client","createdAt":"2026-10-05T00:00:00.000Z","refundRequestId":null,"replacement":{"promiseBy":"2026-10-06T08:00:00.000Z"},"canAccept":true,"canRefund":true}
```

Show: “The original shop could not fulfil your order. A vetted replacement is
available. Accept the revised date or choose a full refund.” `promiseBy` is the
client-ready date including the existing platform allowance. Internal `readyBy`,
shop identity/address, matching selections, original penalties and payouts stay
private. When no compatible replacement exists, `replacement` is null and the
refund choice remains available.

- `POST /orders/:id/shop-recovery/accept` with `{"recoveryId":"shop_event_id"}`.
  Revalidates the proposed shop, exact line selections, price and promised date.
  Offers reserve a 15-minute scheduling allowance. If the offer expired or changed,
  returns `409 shop_recovery_offer_changed` **and commits a refreshed offer** in
  `recovery`; show it for fresh consent. Never automatically accept a changed date.
  Success updates assignment, pickup and job ownership, resets unpaid proof stages,
  preserves original line/artwork/money snapshots and starts a new acceptance hour.
  The former shop loses order/artwork access through the job assignment. Replaying
  acceptance for the same recovery returns success without assigning again.
- `POST /orders/:id/shop-recovery/refund` with `{"recoveryId":"shop_event_id"}`
  and an `Idempotency-Key` header. Optional `destination` uses the receiving-QR
  schema in [Refunds](REFUNDS_API.md). Opens the existing refund workflow and
  returns its `refundRequestId`. It does **not** claim a transfer happened.
  Operations verifies the QR, settles, reserves and records the transfer through
  the existing refund endpoints. Settlement must return **all verified collected
  principal, fee and unused delivery**, with zero shop/rider entitlement; partial
  settlement is refused. A 75% paid order refunds all collected money, not its
  unpaid balance. If nothing was collected, cancellation completes with no cash
  refund; pending payment proofs require reconciliation first. Ordinary refund intake
  during recovery records the same full-refund choice. Withdrawal returns the
  order to `awaiting_client`; rejection flags `ops_review`; a recorded transfer
  sets `refunded`. These statuses never release the recovery work hold.

Other errors: `shop_recovery_stale` for a different recovery ID;
`shop_recovery_not_available` for a resolved or unavailable choice;
`shop_acceptance_expired` for a late acceptance;
`shop_cancel_not_available` after pickup;
`shop_recovery_full_refund_required` for a partial settlement.

## Dashboard and recovery policy

`GET /ops/shop-failures?supplierId=...` (Operations/Super Admin only) returns all
failure events, optionally scoped to a shop, with order ID, original stage and
current full recovery record. `GET /orders/:id/shop-recovery` includes the proposed
supplier, pickup, internal and client dates, expiry and line selection mapping for
these roles. Every failure and client choice produces an audit event and durable
inbox rows for the client, original supplier and every Operations/Super Admin
membership; accepting also notifies the replacement.

Automatic matching uses the existing client priority and eligibility gates. Every
line must have a live, approved replacement listing in the same subcategory with
the same normalized product name, pricing unit/package/measurement unit, supported
formats and selected option group/label values. Measured size, quantity and printer
width limits are checked, and the actual selection price must fit each original
line price. Unrepresented free-form size/material/finish specifications cannot be
assumed equivalent: no automatic candidate is offered. Failed shops are excluded.
All original committed money and delivery fees remain unchanged. Revised dates
require client consent; the replacement receives the original committed shop price.

Any already released shop milestone or refund settlement payout produces
`ops_review` and no automatic replacement. The client may still file the full-refund
request, but existing available-funds controls prohibit recovering paid shares or
pretending funding exists. Operations must resolve that exception; this API never
reverses a transfer. Historical multi-shop orders also require Operations review.

Failure history records the exact stage without introducing a cancellation fine.
Existing production-lateness settings apply only to actual lateness under their
existing rules. Recovery stops further assessment until a replacement is accepted.
Migration `1791244800000` lets each shop retain its own immutable lapse ledger when
an order changes hands; a replacement does not inherit the former shop's deduction.
Unpaid original stages are archived with the recovery history before resetting.

No application boot DDL or new file storage is needed. Acceptance and recovery
snapshots/history live in `orders.data`; money and original line snapshots stay in
the existing relational tables. This is backend support; app/dashboard releases
must implement the choice UI before enabling this workflow for users.
