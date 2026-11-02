# Shop acceptance and recovery

New orders use the prospective [shop-hours clock](SHOP_HOURS_API.md) for acceptance. Orders from the earlier platform-hours release retain their platform calendar; older orders retain the original shop-calendar behavior.

Refs gridgoph/gridgo-supplier#102. All endpoints require a Clerk session and the
specified database membership. Mutations use the domain transaction lock; the
order, event history, audit and notification outbox commit together.

## Supplier app

`GET /jobs` and `GET /orders/:id` include `shopAcceptance` for the assigned shop:

```json
{"supplierId":"supplier_id","assignedAt":"2026-10-10T09:30:30.000Z","deadlineAt":"2026-10-12T00:30:30.000Z","workingMinutes":60,"status":"pending"}
```

The window counts exactly **60 opening minutes**. Orders created after the
[operating-hours rollout](OPERATING_HOURS_API.md) use their creation-time platform
calendar snapshot. Older orders retain the assignment-time snapshot of the shop
schedule (including closures, split shifts and UTC offset).
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
formats and selected option group/label values. Measured size and quantity and printer
width limits are checked. Unrepresented free-form size/material/finish specifications cannot be
assumed equivalent: no automatic candidate is offered. Failed shops are excluded.
All original committed money and delivery fees remain unchanged. Revised dates
require client consent. A shop- or GRIDGO-caused move prices the substitute by the
[substitute-shop price rule](#substitute-shop-price-rule); a client-caused move keeps
the earlier rule (each line must fit its original price and the replacement receives
the original committed shop price).

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

## Substitute-shop price rule

Refs gridgoph/gridgo-api#225 (report 4E2F86FA). Apply migration
`1793620000000_substitute_shop_pricing` before deploying. Client choice screens and the
dashboard money panel are follow-up releases that use the fields below.

### Causes

Every recovery records `kind` and `fault`:

| How it starts | `kind` | `fault` |
| --- | --- | --- |
| Shop timeout, decline, `shop-cancel` | `timed_out`, `declined`, `cancelled` | `shop` |
| `POST /orders/:id/shop-recovery/start` `{"cause":"late","reason":"..."}` | `late` | `shop` |
| `POST /orders/:id/shop-recovery/start` `{"cause":"gridgo","reason":"..."}` | `gridgo` | `gridgo` |
| `POST /orders/:id/shop-recovery/start` `{"cause":"client","reason":"..."}` | `client` | `client` |

`/start` is Operations/Super Admin only. `reason` is 1–2,000 trimmed characters
(`400 shop_recovery_reason_required`); an unknown cause is `400 invalid_shop_recovery_cause`.
`late` needs a production-stage order whose deadline has passed or that a severe lapse
made reassignment-eligible (`409 shop_late_not_eligible`). All other recovery rules
above apply: it never moves the order, any released shop payout goes to `ops_review`,
and the client chooses. `late`, `gridgo` and `client` recoveries are not shop declines:
supplier performance ignores them and `GET /me/shop-failures` lists only the shop's own
`timed_out|declined|cancelled|late` events (Operations still sees all).

### Pricing

The rule applies only when `fault` is `shop` or `gridgo`. Each offer carries `pricing`,
computed against the committed item price `O` (`supplierSubtotalMinor`) and the
substitute's own price `S` for the same lines:

- `S < O` — `rule: "cheaper"`, `refundMinor = O − S`.
- `S = O` — `rule: "same"`.
- `S > O` and `S − O ≤ cap` — `rule: "covered"`, `gridgoCoverMinor = S − O`; the client pays nothing extra.
- `S − O > cap` — `rule: "above_cap"`, `gridgoCoverMinor = cap`, `clientPaysMinor = S − O − cap`.

`cap = min(round_half_up(serviceFeeMinor × shopMoveCoverBps / 10000), service fee actually
collected)`, where collected means confirmed `service_fee` allocations plus supplement
fees, less fees already refunded and covers already applied on the order. GRIDGO's cover
therefore never exceeds the fee it holds; an unpaid or voucher-funded fee lowers the cap
(`capLimitedByCollection: true` for staff). `shopMoveCoverBps` is a Super Admin setting
(default `5000`, i.e. 50% of the original service fee; whole number 0–10,000, otherwise
`400 invalid_shop_move_cover`) on `PATCH /settings` with the usual `expectedVersion`
handshake; `GET /settings` returns it. Open offers re-price
on acceptance; an accepted move keeps its snapshot.

A `client` fault keeps the legacy match (no dearer line) and `pricing.ruleApplies: false`:
no refund, no cover, and the replacement receives the original committed price.

### Client projection

`GET /orders/:id/shop-recovery` (and `order.shopRecovery`) for the owning client:

```json
{"id":"shop_event_id","status":"awaiting_client","fault":"shop","createdAt":"...","refundRequestId":null,
 "replacement":{"optionId":"option_1","promiseBy":"...","pricing":{"ruleApplies":true,"rule":"above_cap",
   "originalPriceMinor":10000,"newPriceMinor":11000,"differenceMinor":1000,"gridgoCoverMinor":500,"clientPaysMinor":500,"refundMinor":0}},
 "alternatives":[{"optionId":"option_2","promiseBy":"...","pricing":{"rule":"covered","...":"..."}}],
 "canAccept":false,"canPickAlternative":true,"canPayDifference":true,"canRefund":true,"topUp":null}
```

Show the original price, the new price and GRIDGO's cover before the client confirms.
`replacement` is the best-ranked compatible shop; `alternatives` are up to three more
anonymous compatible matches in rank order, each with its own `pricing` and date. Shop
identity, pickup, cap policy and collections stay private. `canAccept` stays the
released-build flag: true only when the primary offer needs no extra payment, so older
builds never accept an above-cap offer.

### Client choices

- **Accept** — `POST /orders/:id/shop-recovery/accept` `{"recoveryId","optionId"?}`.
  Omit `optionId` for `replacement`, or send an alternative's `optionId` to **pick
  another shop** (`400 invalid_shop_recovery_option` otherwise). The chosen shop, date
  and price are revalidated; a change returns `409 shop_recovery_offer_changed` with a
  refreshed offer (also when the cap setting or collected fee changed).
- **Pay the rest** — the same call with `"acceptTopUpMinor": <clientPaysMinor>` for an
  `above_cap` option. Missing or different consent is `409 shop_move_top_up_consent_required`.
  The order moves and `recovery.status` becomes `awaiting_payment` (still a full work and
  payout hold; the new shop's acceptance hour has not started). `recovery.topUp` carries
  `changeRequestId` and `amountMinor`. The client pays it through the existing
  [order change payment](ORDER_CHANGES_API.md) route
  (`POST /orders/:id/change-requests/:changeId/payment`) and Operations confirms or rejects
  it there. The supplement has `feeMinor: 0` (frozen zero-rate schedule) and the shop
  receives it at its final stage like any supplement. Confirmation sets the recovery to
  `accepted` and starts the new shop's acceptance hour. Answering the supplement is
  refused (`409 shop_move_top_up_use_recovery`).
- **Cancel for a full refund** — `POST /orders/:id/shop-recovery/refund` as above, also
  available from `awaiting_payment` (the unpaid supplement then closes). Withdrawing that
  refund returns the client to `awaiting_payment`.

### Money effects of an accepted move

Committed order money (totals, installments, allocations, line snapshots) never changes.

- The substitute is paid on its own price: every unpaid payout stage stores a signed
  `priceAdjustmentMinor` and a net `amountMinor` (`−(O − S)` for a cheaper shop, `+cover`
  for a dearer one; the client's top-up arrives as a supplement). Published shares stay
  gross; `validate_order_payout_stages` checks `amount + productionDeduction − priceAdjustment`.
  Clients never see stage amounts or adjustments.
- Cheaper: the exact difference is reserved as a refund request with `kind: "shop_move"`
  and a settlement with `disposition: "price_adjustment"` (principal only), starting at
  `destination_review`. An optional `destination` (receiving-QR body) on accept attaches the
  client's QR. Operations verifies, reserves and records the transfer through the existing
  [refund](REFUNDS_API.md) endpoints. Like the delivery-pin credit it never stops work,
  holds payouts, supersedes stages or restores vouchers. If verified refundable principal
  is short, or another refund is already active, no request is created and the move
  records `refundStatus: "reconciliation_required"` for Operations.
- Dearer: GRIDGO's cover comes out of its service fee.

Every accepted move appends to `order.shopMoves` (staff: complete record with
`fromSupplierId`, `toSupplierId`, `choice` `replacement|alternative`, `paysDifference`,
`status` `applied|awaiting_payment|refund_requested`, full `pricing`, `refundRequestId`,
`refundStatus`, `topUpChangeRequestId`; owning client: prices, cover, choice and refund/top-up
references; everyone else: omitted). Operations order reads add to the money panel
`supplierSettlement.shopMovePriceAdjustmentMinor` and `platformRevenue.shopMoveCoverMinor`,
`shopMoveClientRefundMinor` and `shopMoveClientTopUpMinor`; `netServiceFeeMinor` and
`recognizedMinor` are net of the cover and `totalSupplierEarningsMinor` is the substitute's price.

Audit rows: `order.shop_<kind>` (with the offered shops' pricing), `order.shop_move_applied`
(the move record), `refund.shop_move_credit_reserved` or
`order.shop_move_refund_reconciliation_required`, `order.shop_recovery_accept|refund`
(choice, option and consented top-up) and the existing change-payment rows for the top-up.

A second recovery after a priced move goes to `ops_review`. The deadline-request re-match
([Order reschedule](ORDER_RESCHEDULE_API.md)) keeps its earlier same-or-cheaper rule.
