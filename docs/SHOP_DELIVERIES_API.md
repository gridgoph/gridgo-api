# Shop deliveries: earliest deadline and "deliver separately"

Implements [gridgo-api#275](https://github.com/gridgoph/gridgo-api/issues/275) (decided 2 Nov 2026: build now).
It extends [per-line deadlines](PER_LINE_DEADLINES_API.md) and the
[multi-shop checkout](MULTI_SHOP_CHECKOUT_API.md). All amounts are safe integer PHP minor units.

## The rule

- Every product line keeps its own `deadline` (`cart.lines[].deadline`, unchanged).
- A cart **group** is one **delivery** from one shop. By default all of a shop's
  products are one delivery.
- A delivery's `deadline` is the **earliest** deadline among its lines. Matching,
  the group's `readyBy`/`scheduling`, checkout's deadline check, the order's
  `deadline`, the job's `deadline` and the order's `promiseBy` all use that date.
- The client may split one shop into **separate deliveries**. Each delivery is
  its own group, so it gets its own delivery fee from the existing distance bands
  (to that delivery's farthest drop-off), its own order, job, rider dispatch,
  handover, payout milestones, issue window and refund settlement. Nothing about
  dispatch, handover or payouts is new: each delivery reuses the ordinary
  one-order-one-job model.
- Splitting exists only on a draft cart. A paid order is never split or re-planned.
- More than one group (including two deliveries from one shop) is a basket and
  pays 100% upfront (`upfrontReason: "multiple_fulfillment_groups"`), as before.
- In hub pickup mode, separate groups share the one basket hub fee (allocated as
  in the multi-shop contract); there is no per-group delivery fee.

Before this change groups were "shop + date", so one shop on two dates was
always two orders. Migration `1793630000000` keeps every existing cart exactly
as it was grouped (each later date of a shop becomes its own delivery), so open
carts quote and check out unchanged and checked-out carts read back as paid.
New carts follow the rule above.

## Cart reads

`GET /me/carts/:id` (and every cart mutation response):

```json
{
  "groups": [
    {
      "id": "cline_1", "label": "Shop A", "deadline": "2026-09-10T00:00:00.000Z",
      "lineIds": ["cline_1"], "deliveryNumber": 1, "shopDeliveryCount": 2,
      "separateDelivery": true, "canDeliverSeparately": true,
      "readyBy": "...", "deliveryFeeMinor": 8900, "totalMinor": 118900
    },
    {
      "id": "cline_2", "label": "Shop A", "deadline": "2026-09-12T00:00:00.000Z",
      "lineIds": ["cline_2", "cline_3"], "deliveryNumber": 2, "shopDeliveryCount": 2,
      "separateDelivery": true, "canDeliverSeparately": true,
      "deliveryFeeMinor": 17800, "totalMinor": 237800
    }
  ],
  "clientQuote": {
    "deliveryLines": [
      { "groupId": "cline_1", "label": "Shop A", "deliveryNumber": 1, "shopDeliveryCount": 2,
        "lineIds": ["cline_1"], "deadline": "2026-09-10T00:00:00.000Z", "deliveryFeeMinor": 8900 },
      { "groupId": "cline_2", "label": "Shop A", "deliveryNumber": 2, "shopDeliveryCount": 2,
        "lineIds": ["cline_2", "cline_3"], "deadline": "2026-09-12T00:00:00.000Z", "deliveryFeeMinor": 17800 }
    ],
    "deliveryFeeMinor": 26700
  }
}
```

New, additive fields:

| Field | Meaning |
| --- | --- |
| `groups[].deliveryNumber` | 1-based position among this shop's deliveries |
| `groups[].shopDeliveryCount` | how many deliveries this shop has in the cart |
| `groups[].separateDelivery` | `shopDeliveryCount > 1` |
| `groups[].canDeliverSeparately` | the shop has two or more products, so a split is possible |
| `clientQuote.deliveryLines[].groupId`, `label`, `deliveryNumber`, `shopDeliveryCount` | ties each fee shown before payment to its group |

Groups from one shop share their anonymous `label`. Clients never receive a
supplier ID on split carts (two or more groups), as for any multi-group cart.

## Choosing deliveries

`PUT /me/carts/:id/groups/:groupId/deliveries` (owning client, draft cart).
`groupId` is any current group of the shop. Send exactly one of:

| Body | Effect |
| --- | --- |
| `{ "split": "by_deadline" }` | one delivery per distinct product date at this shop, earliest first. Every line of the shop needs a date (`400 basket_deadline_required`) |
| `{ "split": "none" }` | combine all of this shop's products into one delivery |
| `{ "deliveries": [["cline_1"], ["cline_2", "cline_3"]] }` | explicit choice: every line of this shop in exactly one non-empty delivery |

Response: `200 {cart}` (full projection with signed photos). The first delivery
(in cart order) is the shop's main delivery; products added later join it unless
matched for another delivery. Sending the current choice again is a no-op.

Refusals: `400 invalid_delivery_split` (malformed body, missing/duplicated/foreign
line, empty delivery, both `split` and `deliveries`), `404 cart_group_not_found`,
`409 deadline_not_met` with `{lineIds, deadline}` when a resulting delivery could
not be ready by its earliest date (typically combining a slow product with an
earlier one), and the ordinary cart ownership/draft errors.

Each effective change writes audit `cart.deliveries_set` (entity `cart`) with
`{supplierId, split: "by_deadline"|"none"|"custom", before, after, deliveryCount}`
where `before`/`after` are line-ID partitions. Checkout writes
`basket.separate_deliveries` with each split delivery's `orderId`, `deliveryNumber`,
`deadline`, `lineIds` and `deliveryFeeMinor`.

## Matching and adding products

- `POST /me/matches` with `cartId`: a product is evaluated as joining the shop's
  main delivery, so a listing is offered only if the whole delivery can be ready
  by `min(product deadline, delivery deadline)`, counting the shop's earlier
  deliveries as work ahead.
- `groupId` restricts to that group's shop and evaluates joining **that delivery**;
  with no `deadline` the delivery's earliest date is used. The selection token
  remembers the delivery, and adding it joins that delivery.
- `separateDelivery: true` (boolean, optional, needs `cartId`) evaluates the
  product as a **new** delivery; the token remembers this and the added line
  starts its own delivery. Combine with `groupId` for "another delivery from this shop".
- `POST /me/carts/:id/lines` without a token accepts `separateDelivery: true`.
  With a token, a conflicting `separateDelivery` is `409 select_token_delivery_mismatch`.
  `400 invalid_separate_delivery` for a non-boolean.
- Adding a product (without a still-valid offer) or `PATCH`ing a line `deadline`
  rechecks the product **within its delivery** at the delivery's earliest date;
  a miss is `409 deadline_not_met` (choose a later date or deliver separately).
  A date edit never moves a line between deliveries.
- `GET /me/carts/:id/groups/:groupId/listings` uses that delivery's earliest date.

## Checkout, orders, baskets and receipts

Checkout is unchanged in shape. Each delivery becomes one group order. Orders
of a split shop additionally carry, in every role's projection:

| Field | Where |
| --- | --- |
| `deliveryNumber`, `shopDeliveryCount` | order projections (client, shop, rider, Operations) when `shopDeliveryCount > 1`; `basket.groups[]`; `invoice.groups[]` |

The order's `deadline` and immutable `basketDeadline` are the delivery's
earliest date. Operations sees each delivery as its own order in `/orders` and
`/baskets/:id`; dispatch, rider assignment, handover, payout release and refunds
use that delivery's `orderId` exactly as for any group order.
