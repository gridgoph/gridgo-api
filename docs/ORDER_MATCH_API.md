# Client order match API

This is the authoritative first-drop contract for client matching and cart checkout. Existing public listing reads remain `GET /catalog/shops` and `GET /catalog/items/:itemId`; this API does not create a second catalog.

All routes require a Clerk bearer mapped to a PostgreSQL `client` membership, except Operations/Super Admin may also read an invoice. Money is integer PHP minor units.

## Preferences and addresses

```text
GET /me/preferences
PUT /me/preferences
```

`PUT` accepts `{ "ranking": ["quality","speed","distance"] }`. The array must contain those three values exactly once in any order. Rank weights are 50%, 30%, and 20%. `GET` defaults to quality/speed/distance with `version: 0` until saved.

```text
GET /me/addresses
POST /me/addresses
```

Create body:

```json
{
  "label": "Home",
  "addressLine": "Bajada, Davao City",
  "point": { "lat": 7.0731, "lng": 125.6128 },
  "isDefault": true
}
```

## Match

```text
POST /me/matches
POST /me/matches/next
```

Body:

```json
{
  "subcategoryCode": "flyers",
  "addressId": "addr_...",
  "cartId": "cart_...",
  "excludedSupplierIds": ["user_seen_shop"]
}
```

Send either `addressId` or an inline `dropoff` point. A drop-off is mandatory when distance is ranked first. `ranking` may override saved preferences for one call. `/next` requires at least one excluded shop ID. `cartId` enables same-shop preference when that cart's existing shop has a public listing in the requested subcategory.

Eligibility is fail-closed: approved supplier membership, live covering service, complete public listing, and `isClosed=false`. Speed includes current open jobs in that shop's print queue. Stable ties sort by supplier ID.

Response:

```json
{
  "shop": { "supplierId": "user_shop", "shopName": "...", "shop": { "lat": 7.0, "lng": 125.6, "label": "..." } },
  "queue": { "jobsAhead": 2, "estimatedHours": 36 },
  "reasons": [{ "code": "ranked_quality", "factor": "quality", "rank": 1, "weight": 0.5, "detail": "..." }],
  "listings": [],
  "alternativesCount": 2,
  "score": { "total": 84.5, "weights": { "quality": 0.5, "speed": 0.3, "distance": 0.2 }, "factors": {} }
}
```

## Cart

```text
POST   /me/carts
GET    /me/carts/:cartId
PATCH  /me/carts/:cartId
PUT    /me/carts/:cartId/fulfillment
PUT    /me/carts/:cartId/dropoffs
POST   /me/carts/:cartId/lines
PATCH  /me/carts/:cartId/lines/:lineId
DELETE /me/carts/:cartId/lines/:lineId
PUT    /me/carts/:cartId/lines/:lineId/mockup
```

Create/PATCH/fulfillment fields are:

```json
{
  "fulfillmentMode": "delivery",
  "serviceLevel": "standard",
  "scheduledFor": null,
  "defaultDropoff": { "lat": 7.0731, "lng": 125.6128, "label": "Home" }
}
```

Values are `fulfillmentMode: delivery | pickup` and `serviceLevel: standard | scheduled`. Scheduled requires an ISO `scheduledFor`; Standard clears it. Pickup clears the default drop-off.

Add-line body:

```json
{
  "catalogItemId": "sci_...",
  "optionIds": ["cop_..."],
  "quantity": 100,
  "structuredSpec": { "size": "A5" },
  "artworkFileId": "file_...",
  "dropoff": { "lat": 7.0731, "lng": 125.6128, "label": "Recipient" }
}
```

PATCH accepts `quantity`, `optionIds`, `structuredSpec`, `artworkFileId`, and `dropoff`. The server derives the shop from the public listing and revalidates price/options at checkout.

Every cart payload includes one counter location per selected supplier:

```json
{
  "shops": [
    {
      "supplierId": "user_shop",
      "shopName": "Print Shop",
      "shop": { "lat": 7.064, "lng": 125.6085, "label": "Store counter" }
    }
  ]
}
```

`POST /me/carts/:cartId/lines`, `PATCH /me/carts/:cartId/lines/:lineId`, and `DELETE /me/carts/:cartId/lines/:lineId` keep the standard `{ "cart": ... }` envelope but return compact `line.listing` stubs so add/save/remove do not rebuild or sign every catalog photo. Each stub contains `id`, `name`, `supplierId`, `fromPriceMinor`, `effectivePriceMinor`, and `selectedOptions: [{ id, label }]`; it deliberately omits `photos`. `GET /me/carts/:cartId` continues to return full catalog listing projections. Fulfilment, drop-off, and mockup mutations still return the full projection.

Set line mockup with `{ "fileId": "file_..." }`. Upload it first with `POST /files`, `purpose=mockup`. The ready file must belong to the client. The same opaque ID is snapshotted onto the order line and becomes readable to Operations and that line's job shop.

Set drop-offs in one call with:

```json
{
  "defaultDropoff": { "lat": 7.0731, "lng": 125.6128, "label": "Home" },
  "lines": [{ "lineId": "cline_...", "dropoff": { "lat": 7.08, "lng": 125.62, "label": "Branch" } }]
}
```

## Checkout and invoice

Upload the QR Ph screenshot with `POST /files`, `purpose=payment_proof`, then:

```text
POST /me/carts/:cartId/checkout
```

```json
{
  "payment": {
    "method": "qr_manual",
    "proofFileId": "file_...",
    "reference": "QR-123"
  }
}
```

No other payment method is accepted. Checkout groups lines by shop into one job per shop, snapshots listings/options/artwork/mockups/drop-offs, and calculates each delivery line independently from that shop pin to the job's farthest effective drop-off. Pickup jobs have zero delivery fee.

Order totals are:

```text
itemSubtotalMinor = sum line amounts
serviceFeeMinor = round(itemSubtotalMinor × snapshotted serviceFeeRateBps / 10,000)
deliveryFeeMinor = sum job delivery fees
totalMinor = itemSubtotalMinor + serviceFeeMinor + deliveryFeeMinor
downpaymentMinor = rounded 75% of totalMinor
balanceMinor = totalMinor - downpaymentMinor
```

Success is `201` with `{ order, invoice }`. The order is `needs_qa`; initial QR payment is `pending_confirmation`; the 25% balance is `not_submitted`. Jobs are not notified until a later Operations approval slice. Client projections contain job shop/queue/fulfillment and client totals but never supplier payouts or milestones.

```text
GET /orders/:orderId/invoice
```

Returns `{ invoice }` with immutable line snapshots, one delivery line per job, item subtotal, visible service fee, delivery total, grand total, and 75/25 QR plan.

Common errors are `invalid_preference_ranking`, `dropoff_required`, `match_not_found`, `cart_not_found`, `cart_checked_out`, `cart_empty`, `catalog_item_stale`, `file_not_ready`, and `payment_method_not_allowed`.
