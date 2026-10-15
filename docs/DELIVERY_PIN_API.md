# Delivery pin confirmation and one change

Report 6C8DE953. Apply migration `1792044400000_delivery_pin_adjustments` before deploying. This backend contract requires companion client, rider and dashboard releases.

## Timing and compatibility

For door delivery, the first successful `POST /orders/:id/production-finished` creates a `deliveryPin` record and durable `delivery_pin_requested` inbox/push notification. Legacy production transitions to `supplier_self_qc` or `ready_for_dispatch` do the same. Ask: **“Will you be at this pin?”**, with **“Yes, I'll be here”** and **“Change pin”**. QA rejection/rework does not reset the prompt or the one-change allowance. Pickup orders never enter this flow.

Confirming attests that the client (or their named receiver) will receive the order at the effective pin. It does not mean delivery occurred, release money, or close the complaint window. Confirmation and changes are optional; an unanswered prompt uses the original pin with a `pending` badge. Confirmation alone does not use the one change. Presence confirmation remains available during an active assigned/picked-up/out-for-delivery trip, until delivery closes; it never reopens the pin-change window.

The change window ends at the **first rider assignment**, including rider acceptance and staff assignment. Unassignment cannot reopen it. Exactly one **applied** change is allowed. Unpaid proposals and rejected proofs do not use the allowance. All routes serialize under the domain transaction/advisory lock. An accepted change confirms presence at that new pin.

Orders already in a trip and orders with the previous `dropoffConfirmation` record retain [the legacy flow](OPERATIONAL_MODEL_V2_API.md#out-for-delivery-drop-off-confirmation). No migration retroactively prompts or edits an order. For a new `deliveryPin` order, the old `/dropoff-confirmation` route refuses changes; it cannot bypass the first-dispatch lock. At out-for-delivery, new-flow notifications show the saved destination without inviting another change.

## Prices and protected money

All amounts are safe integer PHP centavos. Distances use the shared shop-to-pin great-circle calculation rounded to whole metres and the existing **inclusive** delivery bands. The shop pickup snapshot and a pricing settings snapshot taken at the prompt govern the quote; subsequent shop moves/settings edits do not reprice it.

- Moves within the same **flat-price** zone retain the order's paid fee, including historical prices.
- Cross-zone moves use the saved band's fee minus the original order delivery fee.
- **Out of Zone is an explicit exception to same-zone-no-change:** whenever the new pin is Out of Zone, recompute `baseFeeMinor + perKmMinor * ceil(distanceMeters / 1000)`, even when the original pin was also Out of Zone. Either a surcharge or a refund may result.
- **There is no geographic service-area maximum in this release.** Out of Zone remains unlimited under the existing contract. Only invalid coordinates are rejected. Do not display an invented city/radius restriction. This resolves the report's outside-service-area wording.
- Split the absolute difference with the order's `riderCommissionBps` (legacy missing = 10000), using existing half-up integer rounding, then apply its sign. Rider and GRIDGO differences sum exactly to the delivery difference. Original gross shares and all shop money remain unchanged.
- Original `dropoff`, `deliveryDistanceMeters`, checkout fee/total, installments, allocations, invoice and job snapshots stay immutable. Applied changes carry separate effective amounts. A supplemental collection is an append-only `delivery_pin_payments` row, never a replacement checkout installment or basket confirmation.

A lower fee reserves the exact cash difference as a `delivery_pin` refund immediately and applies the new pin. The refund uses the existing available-funds and manual wallet protections. It cannot exceed verified delivery collection, convert Pilot Credits to cash, or recover earned/released shop or rider money. Pending original payment proofs, historical direct-store amounts, existing refund settlements/active requests, or insufficient verified delivery collection require Operations reconciliation (`409 delivery_pin_money_reconciliation_required`). Legacy 75% orders can change when their already verified delivery allocation covers any credit; unconfirmed installments remain independently payable.

## Routes

All reads/writes require Clerk authentication and owning-client membership, except Operations/Super Admin payment confirmation/rejection. Staff and rider reads use normal order responses. Every mutation below requires `Idempotency-Key` (1–120 nonblank characters) and `expectedVersion`. Exact actor/key/route/body retries return the original response without another audit or transfer. Reusing a key for a different command returns `409 delivery_pin_idempotency_conflict`; stale versions return `409 delivery_pin_stale`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/orders/:id/delivery-pin` | Owning client: `{deliveryPin}` or null for a legacy/pickup order |
| POST | `/orders/:id/delivery-pin/preview` | Owning client: read-only, no idempotency key/version needed |
| POST | `/orders/:id/delivery-pin/confirm` | Confirm presence at the effective pin |
| POST | `/orders/:id/delivery-pin/change` | Accept one change and its exact previewed price |
| POST | `/orders/:id/delivery-pin/payment` | Submit a client surcharge transfer proof |
| POST | `/orders/:id/delivery-pin/payment/confirm` | Operations verifies the exact surcharge and applies the pin atomically |
| POST | `/orders/:id/delivery-pin/payment/reject` | Operations rejects a proof with a reason; original pin stays |

Point input: `{lat:number,lng:number,label:string}`. Coordinates must be finite JSON numbers within ±90/±180; label is 1–240 trimmed characters. No client-supplied zone or fee is trusted.

Preview body:

```json
{"point":{"lat":7.13,"lng":125.6,"label":"Main entrance"}}
```

Response: `{preview:{point,zone,distanceMeters,deliveryFeeMinor,feeDifferenceMinor}}`. Display the signed difference and preview before saving. Same-zone flat changes show zero. The preview does not reserve the window or modify the order.

Confirm body:

```json
{"expectedVersion":1,"notes":"Blue gate beside the pharmacy","receiverName":"Alex"}
```

`notes` is optional, at most 500 trimmed characters. `receiverName` is optional, at most 120. An empty receiver means the client. No receiver-phone field is accepted or exposed; existing contact masking remains in force. Omitted fields on confirm retain the current values. Confirmation targets the original/current effective pin, never an unpaid proposed destination.

Change body:

```json
{
  "expectedVersion":2,
  "point":{"lat":7.13,"lng":125.6,"label":"Main entrance"},
  "notes":"Blue gate","receiverName":"Alex",
  "feeDifferenceMinor":6000,"acknowledgeOneChange":true
}
```

Before this request, display a clear warning that this is the one saved change and it is unavailable after rider dispatch. Missing acknowledgement returns `400 delivery_pin_warning_required`; an outdated/unaccepted amount returns `409 delivery_pin_fee_changed`. A zero/negative difference applies immediately; a positive difference becomes `pending_payment`. A new proposal can replace an unpaid proposal before dispatch, with a new version/key; submitted proofs must first be resolved by staff. Proposals are audited but do not change the effective point, notes or receiver.

Submit a surcharge after sending the exact amount to the existing platform receiving QR:

```json
{"expectedVersion":3,"proofFileId":"file_payment","reference":"WALLET-123"}
```

Upload an unused, own, ready `payment_proof` first. The proof stays private to the client and staff and is retained with the order even after rejection. The change becomes `pending_confirmation`. **This submitted transfer blocks dispatch until Operations verifies or rejects it**, so acceptance cannot race payment verification and strand money on a changed trip. An unpaid proposal without a submitted proof does not block dispatch. Operations may still confirm/reject an already-submitted surcharge during a later independent work hold; reconciliation does not release that hold. Resolve screenshots promptly; rejection is an assertion that the requested transfer was not verified, not a refund of an actual transfer.

Operations confirmation and rejection:

```json
{"expectedVersion":4,"amountMinor":6000,"reason":"Exact wallet transfer verified"}
```

```json
{"expectedVersion":4,"reason":"No matching transfer found"}
```

Confirmation stores one immutable collection and applies the pin in the same transaction. Wrong amounts return `409 delivery_pin_payment_mismatch`; concurrent/replayed commands cannot collect twice. Rejection returns to `pending_payment`, retaining evidence/audit history. A replacement proof must be a new upload. All successful mutations reply `200 {deliveryPin}`.

## Non-cancelling delivery credit

A negative applied difference exposes `deliveryPin.change.refundRequestId`. Read it through `/refund-requests/:id`. It has `kind:"delivery_pin"`, a reserved immutable settlement with `disposition:"delivery_adjustment"`, zero principal/service-fee return, and the exact delivery credit. It starts at `destination_review` without a receiving account.

Use the existing [manual refund endpoints and request bodies](REFUNDS_API.md): owning client sets `/destination`; Operations `/review` verifies the destination; `/payment-attempts` reserves one payer/amount/destination; `/reconcile` records unknown or explicitly failed transfers; `/payments` records that same transfer with reference and `refund_receipt`. Unknown transfers cannot be sent again. Shared unique wallet/reference and evidence constraints protect both ordinary refunds and pin credits. Approval/reservation is not payment.

Do **not** call `/settle` for this credit: its amount was reserved when the pin was applied. It cannot be rejected/withdrawn to erase the obligation or converted into a cancellation. It introduces no refund work hold, does not supersede supplier stages, and does not block dispatch or shop payments. Only paid credits reduce recognized platform revenue by the reserved GRIDGO difference. A later ordinary refund counts this reserved/paid credit and verified surcharges, so delivery collection cannot be refunded twice. Finish this credit before opening another refund on the same order (the existing one-active-request rule).

## Role projections and app follow-ups

Normal order responses add:

```text
deliveryPin = {
  version, status: "pending" | "confirmed", requestedAt, confirmedAt,
  point: {lat,lng,label}, zone, notes, receiverName, changeUsed, canConfirm, canChange,
  original?, change?
}
change = {
  id, status: "pending_payment" | "pending_confirmation" | "applied",
  point, zone, distanceMeters, deliveryFeeMinor, feeDifferenceMinor,
  createdAt, appliedAt?, refundRequestId?, payment?, rejectionReason?
}
payment = {proofFileId, reference, submittedAt, amountMinor?, confirmedAt?, confirmedBy?}
```

The owning client and staff receive original/proposed/applied point, timestamps, fee difference and payment/refund linkage. Staff additionally receive `riderDifferenceMinor` and `platformDifferenceMinor`. Internal frozen settings are never projected. Supplier responses omit `deliveryPin`. Rider responses contain **only the final effective point**, confirmation status, notes and receiver, with no original/proposed points, surcharge proofs, refund linkage or billing history.

Projected order `dropoff`/`address`/`deliveryDistanceMeters` and Operations rider-map `dropoff` use the effective destination, so the address check/navigation follows the latest applied pin. `effectiveDeliveryFeeMinor` reports its current charge; client/staff `effectiveTotalMinor` reports the checkout total plus the applied difference. Keep original checkout fields labelled as the original amounts. Rider/staff `riderPayoutMinor` and `platformDeliveryShareMinor` include the signed split difference; staff delivery settlement/revenue reporting includes supplemental verified collection and paid credits. Supplier amounts never change.

Client: render the pin section and prompt, preview/warning, QR surcharge status, one-change lock and manual credit progress. Rider: use projected `dropoff`, show confirmed/not-confirmed plus notes/receiver, and use effective delivery earnings. Dashboard: original vs final/proposed map, confirmation time, fee/split difference, surcharge verification and linked refund queue. Use `deliveryPin.canChange` for changing the pin and `canConfirm` for confirming presence and handle server conflicts after reload.

Every prompt, confirmation, proposal, proof decision and applied change is recorded through the append-only audit log. Durable notifications go to the client and every Operations/Super Admin membership; assigned riders receive applicable updates. Reload on `orders`, `dispatch`, and `notifications` invalidations. Push payloads retain the existing allowlist; file bytes, receiver names and map coordinates are not added to push data.
