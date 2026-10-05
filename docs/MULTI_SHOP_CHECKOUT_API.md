# Multi-shop checkout

Implements the 4–5 October 2026 decisions in [#117](https://github.com/gridgoph/gridgo-api/issues/117).
All amounts are safe integer PHP minor units. Use the existing [cart and matching](ORDER_MATCH_API.md),
[fulfillment/payout](OPERATIONAL_MODEL_V2_API.md), and [available_funds_v1 refund](REFUNDS_API.md) contracts.

## Cart and matching

Existing endpoints remain. `POST /me/carts`, `PATCH /me/carts/:id`, and
`PUT /me/carts/:id/fulfillment` additionally accept `deadline`, an ISO date-time.
The cart has one deadline and one `fulfillmentMode: delivery | pickup` for every
shop group. A match selection can initialize an unset cart deadline. A multi-shop
checkout requires a deadline (`400 basket_deadline_required`). Changing it on the
cart causes checkout to revalidate every group's full quantity against the new date.

Call `POST /me/matches` with `cartId` for each product. The server uses the cart's
deadline; a conflicting explicit deadline returns `409 basket_deadline_mismatch`.
Only feasible listings are returned. At checkout every group's queue/calendar is
rechecked independently, including combined quantities from the same shop. If any
one group misses the date, `409 deadline_not_met` rolls back the entire checkout.

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

Several items in the same shop still incur one delivery fee, calculated to that
group's farthest effective drop-off using the existing distance bands. Pickup
has zero delivery fee. An unavailable price or missing delivery point makes the
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

Single-shop checkout remains `{order, invoice}`, uses the existing setting of
75% or 100%, and keeps all existing payment endpoints and states.

Multi-shop checkout returns **201 `{order, basket, invoice}`**. The compatibility
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
immutable `basketDeadline`. Clients get anonymous labels and GRIDGO-inclusive amounts with no supplier ID or
supplier-price breakdown on the new basket/group responses;
Operations gets the supplier identity and that group's existing money/payout/refund
projections. Supplier and rider access remains scoped to their assigned order.

Multi-shop payment is always **100% upfront**, even when the setting is 75. Each
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

Service-fee rounding is per group. Each order snapshots the current delivery split
(default 85% rider / 15% GRIDGO) and existing payout plan. No new commission tiers,
organization discounts, payout shares, or cross-group subsidies are introduced.

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
additive `basketId` and `groups: [{orderId,label,lines,clientItemSubtotalMinor,
deliveryFeeMinor,totalMinor}]`. Operations also receives each group's
`itemSubtotalMinor` and `serviceFeeMinor`. Single-shop legacy invoice fields stay unchanged. Delivery labels are Shop A, Shop B,
etc. Client receipts expose `clientItemSubtotalMinor` and line
`clientUnitPriceMinor` / `clientAmountMinor`; they omit supplier amounts and
service-fee decomposition. Operations retains the original amount fields.
The receipt contains no shop identity or payout amounts. One receipt-ready
notification is written, linked to `receiptOrderId`.

The migration adds relational basket/group records and a cart deadline; no data
backfill changes existing orders. Deferred database constraints require group
allocations to equal the basket total, share the transfer reference/proof/status,
and have no remaining balance. Committed grouping and receipt ownership are
immutable. Existing per-order ledger and refund constraints remain in force.
