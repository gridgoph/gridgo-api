# Multi-shop checkout

Implements the 4–5 October 2026 decisions in [#117](https://github.com/gridgoph/gridgo-api/issues/117).
All amounts are safe integer PHP minor units. Use the existing [cart and matching](ORDER_MATCH_API.md),
[fulfillment/payout](OPERATIONAL_MODEL_V2_API.md), and [available_funds_v1 refund](REFUNDS_API.md) contracts.

## Cart and matching

Existing endpoints remain. `POST /me/carts`, `PATCH /me/carts/:id`, and
`PUT /me/carts/:id/fulfillment` additionally accept `deadline`, an ISO date-time.
Each product keeps its own deadline; see [per-line deadline fields](PER_LINE_DEADLINES_API.md).
The cart keeps one `fulfillmentMode: delivery | pickup`. Cart-level `deadline`
is a legacy default, while explicit line deadlines win. Checkout groups by shop
and normalized deadline. Multiple groups require a date on every line
(`400 basket_deadline_required`). Matching accepts each product's explicit date;
`groupId` scopes its shop and supplies that group's date only when no date is sent.
Checkout rechecks every group, reserving earlier dates first. Any infeasible
group returns `409 deadline_not_met` and rolls back the entire checkout.

Cart responses add `deadline` and `groups`:

```json
{
  "cart": {
    "id": "cart_...",
    "deadline": "2026-11-01T08:00:00.000Z",
    "fulfillmentMode": "delivery",
    "groups": [
      {
        "id": "cline_first_in_group",
        "label": "Shop A",
        "lineIds": ["cline_first_in_group", "cline_another"],
        "clientItemSubtotalMinor": 110000,
        "deliveryFeeMinor": 8900,
        "totalMinor": 118900
      }
    ]
  }
}
```

Groups follow first appearance in the cart. A draft group's opaque `id` is its
first line ID; refresh it after deletion/reordering. To add more from that group,
pass `{cartId, groupId, subcategoryCode, ...}` to `/me/matches`, then add a returned
`selectToken` with its `matchRequestId` through the existing cart-line endpoint.
This restricts matching to that group without accepting a supplier identity from
the client. New products use matching without `groupId`.

Several items in the same shop with the same deadline incur one delivery fee, calculated to that
group's farthest effective drop-off using the existing distance bands. Legacy pickup
remains free. Explicit pre-match hub pickup includes the allocated fee described below. An unavailable price or missing delivery point makes the
corresponding preview total `null`; checkout refuses invalid lines. Previews are
live estimates, not payment reservations.

Multi-shop cart lines have `groupId`; their `supplierId` and listing supplier/service
IDs are omitted. `shops` becomes `[{id,label}]`, without names or coordinates.
Matches against a multi-shop cart (or with `groupId`) also omit shop identity.
Single-shop legacy responses retain their existing fields. New group summaries
use `clientItemSubtotalMinor` inclusive of the GRIDGO service fee; do not add it again. Full cart reads keep
signed listing photos; line mutations remain compact as before.

## Checkout response and payment

`POST /me/carts/:id/checkout` keeps the same body:

```json
{"payment":{"method":"qr_manual","proofFileId":"file_...","reference":"TRANSFER-123"}}
```

Single-group checkout remains `{order, invoice}`, uses the existing setting of
75% or 100%, and keeps all existing payment endpoints and states.

Multi-group checkout returns **201 `{order, basket, invoice}`**. The compatibility
`order` is the first shop group's ordinary order, not the basket total. New apps
must use `basket.totalMinor` and `basket.payment` for the combined charge. The
cart's existing `checkedOutOrderId` points to that first order; checked-out cart
reads additionally return `basketId`.

```json
{
  "basket": {
    "id": "bsk_...",
    "receiptOrderId": "ord_a",
    "deadline": "2026-11-01T08:00:00.000Z",
    "fulfillmentMode": "delivery",
    "totalMinor": 356700,
    "payment": {
      "method": "qr_manual",
      "amountMinor": 356700,
      "status": "pending_confirmation",
      "reference": "TRANSFER-123",
      "proofFileId": "file_..."
    },
    "groups": [
      {
        "orderId": "ord_a",
        "label": "Shop A",
        "state": "initial_payment_review",
        "clientItemSubtotalMinor": 110000,
        "deliveryFeeMinor": 8900,
        "totalMinor": 118900,
        "order": {"id":"ord_a","basketId":"bsk_...","groupLabel":"Shop A"}
      },
      {
        "orderId": "ord_b",
        "label": "Shop B",
        "state": "initial_payment_review",
        "clientItemSubtotalMinor": 220000,
        "deliveryFeeMinor": 17800,
        "totalMinor": 237800,
        "order": {"id":"ord_b","basketId":"bsk_...","groupLabel":"Shop B"}
      }
    ]
  }
}
```

The example abbreviates nested orders and timestamps. Nested orders use the
role-aware projection; use the existing order detail endpoint for signed progress
galleries. Each group order additionally has `basketId`, `groupLabel`, and the
immutable `basketDeadline` (that group's original requested date), plus `deadline`. Groups and combined receipt sections expose `deadline`; the parent date is null for mixed dates. Clients get anonymous labels and GRIDGO-inclusive amounts with no supplier ID or
supplier-price breakdown on the new basket/group responses;
Operations gets the supplier identity and that group's existing money/payout/refund
projections. Supplier and rider access remains scoped to their assigned order.

Multi-group payment is always **100% upfront**, even when the setting is 75, including multiple dates at one shop. The API exposes `upfrontReason: "multiple_fulfillment_groups"`; one group uses `"platform_setting"` on the cart quote. Each
group has an `initial` allocation equal to its own total and a zero `final_online`
with `not_required`. The single basket transfer funds those group allocations;
they are not additional transfers. Never add basket totals to group order totals
in finance reporting.

Per group:

```text
serviceFeeMinor = round_bps(group item subtotal, current service fee bps)
totalMinor = item subtotal + service fee + group delivery fee
basket.totalMinor = sum(group.totalMinor)
```

Service-fee rounding is per group. Delivery orders snapshot the current delivery
split (default 85% rider / 15% GRIDGO) and existing payout plan. No new commission
tiers, organization discounts, or supplier payout shares are introduced.

### One hub pickup fee

For the explicit pre-match pickup flow, charge the configured hub fee **once per
basket**. Divide integer minor units equally among groups in their stable order;
assign one extra minor unit to each earliest group until the remainder is exhausted.
For example, a fee of 2501 allocates as `[1251, 1250]` for two groups or
`[834, 834, 833]` for three. A fee of 1 across three groups allocates `[1, 0, 0]`.

`cart.clientQuote.pickupFeeMinor`, `basket.pickupFeeMinor`, and the combined
`invoice.pickupFeeMinor` are the full fee. Each cart/basket/invoice group's
`pickupFeeMinor` is its allocation. Each underlying order snapshots that allocation
in `pickupFeeMinor` and `hubPickup.feeMinor`; the basket and combined receipt's
`hubPickup.feeMinor` are the full snapshotted fee. Point and schedule remain the
shared hub snapshot. These amounts already occupy `deliveryFeeMinor`; do not add
the pickup fee to the total again.

Allocated pickup funds are platform-owned, with zero rider share and zero-charge
internal delivery jobs, as in the existing hub pickup model. Each group's
`available_funds_v1` settlement refunds only its allocated funds; it never
redistributes fees to remaining groups or changes the immutable receipt. Later
settings changes do not change any placed allocation. Single-shop explicit pickup
retains the full configured fee, and legacy pickup retains its zero-charge flow.

Checkout checks artwork on every line before any group is committed. Each group
gets its own pending `fileCheck` and immediate Operations QA alert. Shops remain
held until Operations passes that group's artwork, even after the shared payment
is confirmed; see [artwork checkout and handoff](ORDER_MATCH_API.md#artwork-checkout-gate-and-operations-handoff).

## Basket endpoints

All require Clerk and a current client or Operations/Super Admin membership.
Clients see only their own baskets. Other clients receive `404 basket_not_found`;
suppliers/riders receive `403 forbidden` on basket routes.

| Method | Endpoint | Result / body |
| --- | --- | --- |
| GET | `/baskets` | `{baskets:[Basket]}`; owning client only, Operations all |
| GET | `/baskets/:id` | `{basket:Basket}` with live group states |
| GET | `/baskets/:id/invoice` | `{invoice:Invoice}` immutable combined receipt |
| POST | `/baskets/:id/payment/confirm` | Operations; `{}`; confirms every group allocation atomically |
| POST | `/baskets/:id/payment/reject` | Operations; `{reason}`; rejects the one transfer for all groups |
| POST | `/baskets/:id/payment/submit` | Owning client; `{method:"qr_manual",proofFileId,reference}` after rejection |

Payment mutation responses are `{basket}`. Confirmation moves active groups to
`needs_qa` and marks their payment paid. Rejection moves them to
`awaiting_initial_payment`; resubmission moves them to `initial_payment_review`.
Payment reconciliation never restarts an already-cancelled group. Repeated
confirm/reject without a pending payment returns `409 payment_not_pending`;
repeated submission returns `409 payment_already_submitted`. Every action commits
all group allocations, audit and notifications in one locked transaction.

For a multi-shop group, **all** old `/orders/:id/payments/...` mutations return
`409 {error:"basket_payment_required",basketId}`. The dashboard must navigate to
the basket payment desk instead of confirming group payments separately. Single-shop
orders continue using those routes unchanged.

## Fulfillment, payouts, and refunds

Each group is an ordinary order with one job. Existing QA, supplier acceptance,
production, dispatch, rider assignment, issue windows, claims, payout proofs and
release endpoints use **that group's `orderId`**. One group's state or hold never
gates its siblings. Operations can tag orders with a `basketId` as multi-shop;
orders without it remain single-shop/legacy. `/baskets/:id` supplies the parent
view; `/orders` continues listing the independently actionable orders.

To cancel/refund one paid group, file `/orders/:groupOrderId/refund-requests` and
follow the existing reviewed settlement and reserved transfer flow. The
`available_funds_v1` calculation uses only that group's confirmed allocations,
released payouts and rider obligations. Settling it stops that group's job,
supersedes its unpaid stages, and reserves only its refundable funds. Sibling
jobs, holds, payout stages and money remain unchanged. Transfers and settlement
payouts continue through the existing refund endpoints. The original combined
receipt remains immutable; refund records describe the subsequent adjustment.

## Combined receipt

There is exactly one `order_invoices` row and invoice number per basket. Both
`/baskets/:id/invoice` and `/orders/:anyGroupOrderId/invoice` return the same snapshot.
The flat `lines`, `deliveryLines`, customer totals and `paymentPlan` remain, with
additive `basketId` and `groups: [{orderId,label,deadline,lines,clientItemSubtotalMinor,
deliveryFeeMinor,totalMinor}]`. Operations also receives each group's
`itemSubtotalMinor` and `serviceFeeMinor`. Single-shop legacy invoice fields stay unchanged. Delivery labels are Shop A, Shop B,
etc.; different dates at the same shop share a label and carry distinct deadlines and order IDs. Client receipts expose `clientItemSubtotalMinor` and line
`clientUnitPriceMinor` / `clientAmountMinor`; they omit supplier amounts and
service-fee decomposition. Operations retains the original amount fields.
The receipt contains no shop identity or payout amounts. One receipt-ready
notification is written, linked to `receiptOrderId`.

The migration adds relational basket/group records and a cart deadline; no data
backfill changes existing orders. Deferred database constraints require group
allocations to equal the basket total, share the transfer reference/proof/status,
and have no remaining balance. Committed grouping and receipt ownership are
immutable. Existing per-order ledger and refund constraints remain in force.
