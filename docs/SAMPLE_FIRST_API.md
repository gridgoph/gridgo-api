# Sample First

A client can order one paid sample of a listing before committing to the full
batch, approve or reject what arrives, and then order the batch at the price list
that stood when the sample was ordered. This is the API contract for the separate
client, shop and dashboard releases (gridgo-api#222; issue reports 77B52CCC and
4D659BDC). Code: `src/sample-first.js` (drafts, decisions, reads) and the cart
and checkout paths in `src/order-match-routes.js`.

## The rules

- **A sample is an ordinary order.** It is one piece at the shop's sample price,
  matched, paid, file-checked, produced, delivered, escrowed, reviewed and
  refunded through the existing order paths. It pays the normal service fee and
  delivery fee. The sample price is never credited to the batch.
- **The intended batch is kept as a draft** linked to the sample order and to the
  same shop: quantity, options, measurement, structured specs, artwork (file ids
  and design links), document pages/layout and instructions, plus the batch speed
  the client picked.
- **The held price is the price list, not a total.** At sample checkout the API
  copies the listing's batch pricing rules privately and immutably: base rate,
  the chosen options' price effects, every bulk (volume) tier, the minimums and
  the chosen speed tier. The batch is priced from that copy through the ordinary
  pricing engine, so a changed quantity lands in whichever held bulk tier applies
  (decided 18 Oct 2026, option A). Later listing changes do not touch it.
- **The hold runs `sampleBatchHoldDays` (default 14) from sample delivery.** The
  clock starts when the sample reached the client (the issue window opening, else
  the delivered timeline step) and is copied onto the draft when the client
  decides. A draft snapshots the setting at sample checkout; changing the setting
  never moves an existing hold.
- **Held price needs an approved sample, inside the hold, from the same shop.**
  An expired hold cannot be used, but the client can still order the same batch at
  today's price.
- **Changed specs are a new sample.** A batch line keeps the sample's specs; only
  quantity, drop-off and deadline can change. To change anything else the client
  rejects the sample with `next: "resample"` and orders another sample.
- **The approval is the batch standard.** It is copied onto the sample and the
  batch orders as `sampleDecision`, so Operations sees what was approved when a
  batch dispute is raised.

Not offered, by design in this release:

- Colour-priced listings (`pricedByColour`) cannot offer a sample: their price
  comes from the artwork's pages, which a price list cannot hold. Private quote
  listings ([QUOTE_REQUESTS_API.md](QUOTE_REQUESTS_API.md)) never offer one either.
- A sample is made at the shop's standard speed; the speed the client picks is
  kept for the batch only.
- A sample or a batch-from-sample is ordered in its own cart (one line).

## Settings

`GET /settings` returns `sampleBatchHoldDays` (integer days, default `14`).
Super Admin changes it through the existing `PATCH /settings` `expectedVersion`
handshake. Anything other than a whole number from 1 to 90 is
`400 invalid_sample_batch_hold_days` with `field: "sampleBatchHoldDays"`.

## Shop listing fields

`POST /me/catalog-items` and `PATCH /me/catalog-items/:id` accept:

| Field | Type | Notes |
| --- | --- | --- |
| `sampleAvailable` | boolean | Offer a sample. Default `false`. |
| `samplePriceMinor` | integer centavos ≥ 1, or `null` | The shop's own price for one sample piece. Kept while the offer is off. |

Both apply at once, like price and availability, without listing review. Errors:
`400 invalid_catalog_item` (wrong type, with `field`), `400 sample_price_required`
(offering without a price), `409 sample_not_supported` (colour-priced listing).
Changes are audited on the listing's create/update audit row (`detail.sample`).

The shop's own listing reads (`GET /me/catalog-items...`) return the raw
`sampleAvailable` and `samplePriceMinor`.

## Client catalogue and match reads

Public listing projections (catalogue, match cards, anonymous alternatives, cart
listing stubs) add:

| Field | Meaning |
| --- | --- |
| `sampleAvailable` | The listing offers a sample now. |
| `samplePriceMinor` | Shop sample price (item money, before the service fee). `null` when not offered. |
| `clientSamplePriceMinor` | The sample price in client money, the way listing prices are shown. `null` when not offered. |

The client still pays the normal service fee and delivery on the sample order;
show the checkout quote, not `clientSamplePriceMinor`, as the amount due.

## Ordering a sample

Add a line to an empty draft cart with `sample: true`:

```http
POST /me/carts/:cartId/lines
{ "selectionToken": "...", "catalogItemId": "...", "optionIds": [...],
  "quantity": 500, "artworkFileId": "...", "specialInstructions": "...",
  "speedTierId": "...", "sample": true }
```

All the ordinary add-line fields and validation apply. On a sample line:

- `quantity` and `speedTierId` describe the **intended batch**. The line itself
  becomes one piece (`quantity: 1`) at standard speed, priced at the sample price.
- The cart line returns `sample: { batchQuantity, replacesSampleBatchId }`.
  `sampleBatch` is `null`.
- `PATCH .../lines/:lineId` with `quantity` changes `sample.batchQuantity`; the
  sample stays one piece. `speedTierId` is `409 sample_speed_fixed`.
- `replacesSampleBatchId` (with `sample: true`) orders the replacement for a
  sample rejected with `next: "resample"`.

Errors: `400 invalid_sample`, `409 sample_unavailable` (the listing does not
offer one, or stopped before checkout), `409 sample_cart_exclusive` (the cart
already has lines, or a sample/batch is already in it),
`409 sample_batch_not_resampleable`, `409 sample_batch_already_resampled`.

Checkout is the ordinary `POST /me/carts/:cartId/checkout`. In the same
transaction it creates the batch draft (status `awaiting_sample`) and tags the
order:

| Order field | Value |
| --- | --- |
| `orderTags` | `["sample"]` |
| `sampleBatchDraftId` | the draft id |
| `batchOrderId` | set once the batch is ordered |
| `sampleDecision` | set once the client approves or rejects (see below) |

## Sample batch drafts

```http
GET /me/sample-batches                 → { sampleBatches: SampleBatch[] }
GET /me/sample-batches/:id?quantity=N  → { sampleBatch: SampleBatch }
```

Client-only; another client's draft is `403 forbidden`, an unknown one
`404 sample_batch_not_found`. `?quantity=` previews both prices for another
batch quantity.

`SampleBatch`:

| Field | Meaning |
| --- | --- |
| `id`, `status` | `awaiting_sample` → `approved` → `ordered`; or `rejected` (resample) / `cancelled`. |
| `tags` | `["sample_batch"]` |
| `catalogItemId`, `itemName` | The sampled listing. |
| `sampleOrderId`, `sampleOrderState` | The sample order and its current state. |
| `batchOrderId` | The batch order, once ordered. |
| `previousDraftId`, `replacedByDraftId` | Resample chain. |
| `batch` | The intended batch: `quantity`, `optionIds`, `measurement`, `structuredSpec`, `speedTierId`, `artworkFileId`, `artworkLinks`, `artworkAttachments`, `documentPages`, `printLayout`, `coverSpine`, `colorTargets`, `specialInstructions`. |
| `holdDays` | Hold length snapshotted at sample checkout. |
| `sampleDeliveredAt`, `heldUntil` | `null` until the sample is delivered. |
| `holdActive`, `holdExpired` | Clock state now. |
| `heldPrice`, `currentPrice` | `{ quantity, clientItemMinor }` for the batch at the held rules and at today's listing; `null` when it cannot be priced (e.g. below the minimum, or the listing is gone). |
| `canOrderAtHeldPrice`, `heldPriceBlocker` | Whether the held price can be used now, else the error code it would return. |
| `canOrderAtCurrentPrice` | Approved and today's listing can price the batch. |
| `approval` | `{ version, method: "tick", accepted, samplePhotoFileId, note, at, by }` or `null`. |
| `rejection` | `{ version, reason, next: "resample" \| "cancel", at, by }` or `null`. |
| `version`, `createdAt`, `updatedAt` | |

`clientItemMinor` is the item money (client price before service fee and
delivery); the batch checkout quote is still authoritative.

### Deciding on the sample

Only while `awaiting_sample` and once the sample order is delivered
(`delivered`, `issue_window_open`, `completed` or `payout_released`). Otherwise
`409 sample_not_delivered` or `409 sample_batch_decided`.

```http
POST /me/sample-batches/:id/approve
{ "accepted": true, "method": "tick", "samplePhotoFileId": "...", "note": "optional" }
```

The photo is the client's own ready upload with purpose `approval_sample_photo`
(`POST /files/uploads`), not attached elsewhere. It is attached to the sample
order (`field: "sample:approval"`) so the shop and Operations can read it through
the ordinary order file access. Errors: `400 invalid_sample_approval`,
`400 invalid_approval_file`, `409 file_not_ready`.

```http
POST /me/sample-batches/:id/reject
{ "reason": "Too dark", "next": "resample" | "cancel" }
```

`next: "resample"` leaves the draft `rejected` so a new sample can replace it
(`replacesSampleBatchId`); `next: "cancel"` closes it. Errors:
`400 reason_required`, `400 invalid_sample_rejection`.

```http
POST /me/sample-batches/:id/cancel   { "reason": "optional" }
```

Cancels a draft that is `awaiting_sample`, `approved` or `rejected`
(`409 sample_batch_decided` otherwise). The sample order itself is unaffected:
cancel or refund it through the ordinary order paths.

Approving or rejecting copies the decision onto the sample order as
`sampleDecision` (`{ draftId, decision, method, at, samplePhotoFileId, note }`
or `{ draftId, decision: "rejected", at, reason, next }`) and persists
`sampleDeliveredAt`/`heldUntil` on the draft.

**Signed approval later.** The tick is the lean version. A signed approval (for
example an [APPROVAL_PROOF_API](APPROVAL_PROOF_API.md) drawn signature) will arrive
as another `approval.method` with its own evidence fields on the same versioned
record; clients must treat an unknown `method` as approved-with-evidence and show
`samplePhotoFileId` when present.

## Ordering the batch

```http
POST /me/sample-batches/:id/cart
{ "pricing": "held" | "current", "quantity": 250,
  "fulfillmentMode": "...", "defaultDropoff": {...}, "deadline": "..." }
→ 201 { cart }
```

Creates a new draft cart holding one batch line with the draft's specs, the same
shop and listing. Every field is optional: `pricing` defaults to `held`,
`quantity` to the sampled batch quantity, and fulfillment to how the sample was
delivered. Check out with the ordinary `POST /me/carts/:cartId/checkout` (normal
service fee, delivery, payment, file check and escrow).

The batch line returns `sampleBatch: { draftId, pricing, sampleOrderId, heldUntil }`
and is priced from the held rules (`held`) or today's listing (`current`).
`PATCH .../lines/:lineId` accepts only `quantity`, `dropoff` and `deadline`;
anything else is `409 sample_batch_specs_locked` with `fields`.

Held-price errors, at cart creation and again at checkout:
`409 sample_batch_not_approved`, `409 sample_hold_expired` (`details.heldUntil`;
offer `pricing: "current"`), `409 sample_shop_changed` (another shop made the
sample after a recovery), `409 sample_batch_ordered`. Both pricings:
`400 invalid_sample_batch_pricing`, `409 catalog_item_stale` (the listing is no
longer public from that shop).

The batch order is tagged and linked:

| Order field | Value |
| --- | --- |
| `orderTags` | `["batch_from_sample"]` |
| `sampleOrderId` | the sample order |
| `sampleBatchDraftId` | the draft (now `ordered`, with `batchOrderId`) |
| `sampleBatchPricing` | `{ pricing: "held" \| "current", heldUntil, heldPricingCapturedAt }` |
| `sampleDecision` | the approval the batch is held to |

The batch order's line snapshot records the held base rate, option effects and
speed, so it reproduces the promised price exactly. One draft yields at most one
batch order.

`sampleDecision` and `sampleBatchPricing` are visible to the owning client, the
assigned shop, Operations and Super Admin, and stripped for riders and staff
profiles.

## Operations and dashboard

```http
GET /ops/sample-batches?status=&supplierId=&clientId=   → { sampleBatches }   (latest 200)
GET /ops/sample-batches/:id?quantity=N                  → { sampleBatch }
```

Operations / Super Admin only. The staff projection adds `clientId`,
`supplierId`, the full private `heldPricing` copy, and engine detail on
`heldPrice`/`currentPrice` (`lineSubtotalMinor`, `unitRateMinor`,
`volumeTierApplied`). Disputes on a batch order read its `sampleDecision` and
open the approval photo through the sample order.

## Shop app

The shop sees a sample as an ordinary one-piece order (`orderTags: ["sample"]`,
priced at its sample price) and a batch as an ordinary order tagged
`batch_from_sample` with `sampleOrderId` and `sampleDecision`, including the
approved photo reference. The held pricing rules themselves are never returned
to the shop or the client.

## Inbox, realtime and audit

| Event | Recipients | Inbox type |
| --- | --- | --- |
| Sample approved | assigned shop; Operations + Super Admin | `shop_sample_approved`; `sample_approved` |
| Sample rejected | assigned shop; Operations + Super Admin | `shop_sample_rejected`; `sample_rejected` |
| Draft cancelled | Operations + Super Admin | `sample_batch_cancelled` |
| Batch ordered | Operations + Super Admin (plus the ordinary new-order events) | `sample_batch_ordered` |

Decisions and batch checkout invalidate the sample order (`orders`, `jobs`).

Audit actions (entity type `sample_batch`): `sample_batch.create`,
`sample_batch.approve`, `sample_batch.reject`, `sample_batch.cancel`,
`sample_batch.cart_created`, `sample_batch.batch_ordered`.

## Storage

Migration `1793650000000_sample_first` adds:

- `supplier_catalog_items.sample_available`, `sample_price_minor` (BIGINT).
- `sample_batch_drafts`: relational keys, links, status and hold clock; JSON
  `batch`, `held_pricing`, `approval`, `rejection`. A trigger keeps the held
  pricing, intended batch, links and hold length immutable, and the hold start,
  approval and batch link write-once.
- `client_cart_lines.sample`, `sample_batch_draft_id`, `sample_batch_pricing`.

Nothing existing is backfilled: every listing starts without a sample offer.
Cart reads load only the drafts the cart's lines reference
([TARGETED_READS.md](TARGETED_READS.md)).
