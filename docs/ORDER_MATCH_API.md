# Client order match API

This is the authoritative first-drop contract for client matching and cart checkout. Existing public listing reads remain `GET /catalog/shops` and `GET /catalog/items/:itemId`; this API does not create a second catalog.

All routes require a Clerk bearer mapped to a PostgreSQL `client` membership, except Operations/Super Admin may also read an invoice. Money is integer PHP minor units.

Client-price migration: [staged privacy contract](CLIENT_CATALOG_PRIVACY.md) defines
`POST /me/catalog-quotes`, basket quotes (`cart.clientQuote` and
`GET/POST /me/carts/:id/quote`), invoice client amounts, deprecated fields and the
required release order. Phase 1 remains additive; legacy shop fields still exist.

## Preferences and addresses

```text
GET /me/preferences
PUT /me/preferences
```

`PUT` accepts `{ "ranking": ["quality","speed","cost","distance"] }`. All four values must occur exactly once in any order (`400 invalid_preference_ranking` otherwise). This saved preference is the onboarding/account default. `GET` defaults to quality/speed/cost/distance with `version: 0` until saved; older saved three-factor rankings retain their order with the missing factor appended. Matching uses strict priority, not percentage weights.

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
  "ranking": ["quality", "speed", "cost", "distance"],
  "deadline": "2026-10-10T15:59:59.999Z",
  "units": 100,
  "cartId": "cart_...",
  "excludedSupplierIds": ["user_seen_shop"]
}
```

Send either `addressId` or an inline `dropoff` point (`lat`, `lng`, nonblank `label`). A drop-off is mandatory when distance is ranked first. **Omit `ranking` (or send null) to skip per-order confirmation and use the saved default.** A supplied ranking applies only to this request and never saves the preference. To rematch after a change, POST the same work/drop-off/deadline to `/me/matches` with the new ranking; no preference write or new endpoint is needed. The client's minimum three-second loader is entirely client-side; the API adds no delay.

`deadline` is optional, a date-time parseable by the API (send ISO 8601 with offset); null means no deadline filter. `units` is an optional positive safe integer quantity used for capacity projection. Existing `measurement`, `structuredSpec`, `optionIds`, and `widthFeet` inputs still filter printer capability. `/next` requires at least one `excludedSupplierIds` entry. Optional `cartId` validates ownership, supplies existing lines for printer-width checks, and binds tokens to that cart. It **does not boost the cart's shop**. To choose a different shop from a nonempty cart, start a new cart and rematch without the old cart ID.

Eligibility is fail-closed: active account, approved supplier membership, live covering service, complete public listing, printer capacity, and `isClosed=false`. Project each listing using its turnaround, shop schedule, current queue, supplied units/capacity, and the platform promise allowance. Remove every listing whose **client promise** exceeds the deadline before ranking. If none can make it, return `409 deadline_not_met` with `earliestAvailable`; if there are no eligible listings, return `404 match_not_found`.

### Deterministic Top Pick

Compare each factor in the supplied/saved ranking, stopping at the first different comparison value. Later factors only break ties. Comparison buckets (fixed boundaries, not pairwise differences) make sorting transitive and independent of input order:

| Factor | Comparison value | Better |
| --- | --- | --- |
| `quality` | Floor of today's 0–100 quality score | Higher |
| `speed` | UTC hour containing the padded client promise, `floor(epochMilliseconds / 3600000)` | Earlier |
| `cost` | Listing `fromPriceMinor`, before quantity/options/service fee | Lower; exact centavos, a ₱0.01 difference separates |
| `distance` | Nearby → Away → Long Distance → Out of Zone | Earlier zone; every distance within a zone ties |

Quality is unchanged in kind: with five valid reviews, the unrounded average quality stars × 20; otherwise listing completeness and approved standing (50 standing + 8 name + 10 description + 7 starting price + 7 turnaround + 7 photos + 5 formats + 3 options + 3 preparation steps, capped at 100). Scores in the same whole-point bucket tie; even a small difference crossing its boundary separates. There is no exact-distance boost, same-shop boost, or weighted blend. Missing drop-off ties all distance values (distance-first still requires a pin).

Within each shop choose its best eligible listing by these same comparisons, then listing ID ascending. Rank those representatives with supplier ID ascending as the final tie-break. This avoids combining one listing's price with another's speed. The Top Pick's `listings[]` contains **all its eligible deadline-capable listings**, in the same priority order; index 0 is its recommended listing. Each gains `readyBy` (the padded client promise), `placeInLine` (jobs ahead + 1), and `selectToken`.

The root `matchReason` names the first factor that separates the winner from the runner-up, i.e. the factor deciding between the final contenders after earlier ties. It is `vetted` if there is one candidate or every factor ties and supplier ID decides. Labels are fixed:

| key | label |
| --- | --- |
| `quality` | Matched for Quality |
| `cost` | Matched for Best Value |
| `speed` | Matched for Fastest Turnaround |
| `distance` | Matched for Distance |
| `vetted` | GRIDGO-Vetted Supplier |

`ranking` at the root echoes the effective priority. Legacy `shop`, `listings`, `queue`, `promiseBy`, `distanceZone`, optional `rating`, `reasons`, `alternativesCount`, and `score` remain. `score` is deprecated diagnostics: weights are 1 for the first factor and 0 for the rest; total is that first normalized factor score. It does not determine ordering and may tie even when a later factor decides. `reasons[].weight` has the same 1/0 values. Render the new `matchReason` as the single badge.

Response:

```json
{
  "ranking": ["quality", "speed", "cost", "distance"],
  "matchReason": { "key": "quality", "label": "Matched for Quality" },
  "matchRequestId": "opaque_random_request_id",
  "selectTokenExpiresAt": "2026-10-02T01:15:00.000Z",
  "otherListings": [],
  "shop": { "supplierId": "user_shop", "shopName": "...", "shop": { "lat": 7.0, "lng": 125.6, "label": "..." } },
  "distanceZone": { "key": "nearby", "label": "Nearby" },
  "rating": { "average": 4.8, "count": 12 },
  "queue": { "jobsAhead": 2, "estimatedHours": 36 },
  "reasons": [{ "code": "ranked_quality", "factor": "quality", "rank": 1, "weight": 1, "detail": "..." }],
  "listings": [],
  "alternativesCount": 2,
  "score": { "total": 100, "weights": { "quality": 1, "speed": 0, "cost": 0, "distance": 0 }, "factors": {} }
}
```

### Other listings and token selection

`otherListings[]` contains exactly one representative from **every other eligible shop**, in the same strict priority order, excluding the Top Pick and any excluded shops. No deadline means all eligible shops. It has no reason badge. Fields are an explicit allowlist:

- Card: `id` (listing ID), `name` (product name), `photos`, `fromPriceMinor` (supplier price), `clientFromPriceMinor` (includes GRIDGO service fee), `pricingUnit`, `packageQty`, `distanceZone`, `readyBy`, `placeInLine`, `selectToken`.
- Conditional: `distanceKm` only Out of Zone; `rating: {average,count}` only with at least five valid reviews.
- Configuration for the selection sheet: `categoryCode`, `subcategoryCode`, `basePriceMinor`, `effectivePriceMinor`, `clientEffectivePriceMinor`, `measurementKind`, `measureUnit`, `minimumWidthMilli`, `minimumHeightMilli`, `minimumLengthMilli`, `minimumOrderQuantity`, `printerMaxWidthFeet`, `priceTiers`, `speedTiers`, `pricingBasis`, `turnaroundHours`, `minimumTurnaroundHours`, `rush`, `acceptedFormats`, `optionGroups`, `version`. These retain their catalog semantics. Supply chosen `optionIds`, quantity and any required measurement when adding to cart.

No supplier ID, service ID, shop name, shop point/address, contact, or logo is projected into an alternative. `photos` starts with only `fileId`, `sortOrder`, and metadata `url`; the common catalog decorator adds `downloadUrl` and `downloadUrlExpiresAt` when storage signing succeeds. Photo alt text is omitted. Listing names, option labels and product photos are supplier-authored product content; this projection does not inspect image pixels. Existing Top Pick `shop` and listing supplier fields remain for compatibility as explicitly required by this rollout; the new matching UI must not display those shop fields. Cart and post-order shop projections are unchanged.

Choose either the Top Pick listing or an alternative through the existing add-line endpoint:

```http
POST /me/carts/:cartId/lines
```

```json
{
  "matchRequestId": "opaque_random_request_id",
  "selectToken": "opaque_random_selection_token",
  "optionIds": [],
  "quantity": 100,
  "artworkFileId": "file_..."
}
```

The server resolves the listing/shop; omit `catalogItemId` (if supplied it must match). Tokens contain no encoded identity, expire **15 minutes** after matching, and are bound to the authenticated client, exact `matchRequestId`, selected listing, snapshotted deadline/drop-off, and optional requested cart. A new match creates new tokens without revoking earlier unexpired requests. Tokens may be reused within their lifetime; normal add-line semantics apply, so they are not idempotency keys. They persist in PostgreSQL as SHA-256 digests, survive API restarts, and are issued atomically under the existing mutation transaction/lock.

Token selection copies the match drop-off onto the line and refuses a conflicting drop-off. A null match drop-off leaves existing cart/drop-off behavior intact. The match deadline is saved on the line; selection rechecks current availability, price/options, quantity, printer cap, and promise. Checkout revalidates prices and the full cart's queue/capacity promise against all saved match deadlines, returning `409 deadline_not_met` if it no longer fits. This is a live estimate, not a queue or price reservation. A different shop in an already populated cart still returns `409 cart_belongs_to_another_shop`; start a separate order. QR payment and escrow belong to that cart's one selected shop exactly as before.

Legacy add-line by `catalogItemId` without a token remains supported and does not acquire a match deadline. Both paths use the same existing pricing, drop-off/delivery fee and checkout rules. Use tokens for this redesigned flow to carry the matching deadline through checkout.

| Status | error | Recovery |
| --- | --- | --- |
| 400 | `invalid_select_token` | Missing/malformed/unknown token; match again (omitting the field entirely uses legacy selection) |
| 403 | `foreign_select_token` | Token belongs to another client; match as this client |
| 410 | `select_token_expired` | Match again |
| 409 | `select_token_request_mismatch` | Send the request ID returned with this token |
| 409 | `select_token_cart_mismatch` | Use the original cart, or rematch for a new cart |
| 409 | `select_token_listing_mismatch` | Omit conflicting `catalogItemId` |
| 409 | `select_token_dropoff_mismatch` | Rematch with the new destination |
| 409 | `catalog_item_stale` / `deadline_not_met` | Availability changed; refresh/rematch |

Expired records are retained for at least a day after expiry and pruned during subsequent matches; after cleanup an old token returns `invalid_select_token`. None of these refusals changes the cart or places an order.

### Fulfillment before matching

New requests choose Delivery or Pick-up immediately after the deadline, before calling either match endpoint. Send `fulfillmentMode: "delivery" | "pickup"` on **every** `/me/matches` and `/me/matches/next` request.

- Delivery requires an owned `addressId` or inline `dropoff: {lat,lng,label}`, regardless of preference ranking. This is request input; activation/onboarding needs no address. Matching, listing distance zones, and checkout fees use that destination and the existing delivery band table.
- `GET /settings` exposes `settings.hubPickupEnabled` (boolean, default `false`, including existing settings without the field). Clients hide the new-order pickup choice unless it is `true` and refresh settings on returning to the request screen. Super Admin changes it through `PATCH /settings` with `expectedVersion` and `reason`; other settings writes preserve it. Checkout rechecks the current flag under the mutation transaction and returns `409 hub_pickup_disabled` for pickup while off, including old drafts and multi-shop baskets. Delivery remains available. Already placed pickup orders retain payment, production, recovery and hub handover access, snapshots and money unchanged. Deploying this default disables new pickup; toggling it later needs no app update after the compatible client release.
- Pick-up uses the fixed GRIDGO hub point returned by `GET /settings` at `settings.hubPickup.point`. The API overrides any supplied address for this path. Shop distance ranking is measured to the hub. The client's pickup charge is the configured flat hub fee, not a distance-band delivery charge.

An explicit-choice match adds `requestFulfillment: {fulfillmentMode,dropoff}`; pickup also adds `hubPickup: {point,schedule,feeMinor}`. Every offered listing, including anonymous alternatives, has `deliveryFeeMinor` as its fulfillment-charge preview; pickup listings also have `pickupFeeMinor`, which names the same amount. Existing photo signing and selection-token expiry rules apply.

Create an empty cart (existing `POST /me/carts`), then add a listing with its `selectToken` and `matchRequestId`. The server carries the choice and resolved destination from that token into the cart. The cart's `requestFulfillment` is returned on full and compact reads and persists across API restarts; pickup carts expose the current `hubPickup` settings. Checkout renders this choice read-only. A conflicting fulfillment or destination on cart PATCH, fulfillment/drop-off PUT, line add/PATCH, or checkout returns `409 request_fulfillment_locked`. To change it, rematch and use a new empty cart. Attaching an explicit-choice token to an existing legacy nonempty cart returns `409 request_fulfillment_requires_empty_cart`.

At checkout the order and invoice snapshot `requestFulfillment`; pickup additionally snapshots `hubPickup` and `pickupFeeMinor` from current settings. A draft preview can change when settings change; a placed order's schedule and charge cannot. Shop recovery also matches against this snapshotted request point, including the hub for pickup, and preserves the fulfillment choice and charge when the client accepts a replacement. The fee is once per single-shop order, not per line. A multi-shop basket charges it once and allocates minor units evenly across groups, with remainder in group order; see [basket pickup allocation](MULTI_SHOP_CHECKOUT_API.md#one-hub-pickup-fee). The server-owned `cart.clientQuote` and `GET/POST /me/carts/:id/quote` include the same fee in `deliveryFeeMinor` and the already-inclusive GRIDGO item amount in `clientItemSubtotalMinor`. Use their total rather than computing printing markup or delivery from shop details; conflicting quote-preview overrides also return `409 request_fulfillment_locked`. For compatibility with the existing financial model, `deliveryFeeMinor` remains the total fulfillment-charge slot and its `delivery_pass_through` payment allocation: on a new pickup order it **already includes** `pickupFeeMinor`. Do not add these two values together. Printing subtotal and service-fee calculations exclude the pickup fee; pickup fee earns no supplier payout or rider share. Internal pickup jobs retain their existing zero-charge trip contract. Existing collection/refund accounting handles the fee as platform-owned fulfillment funds.

Compatibility: omitting `fulfillmentMode` from matching preserves released-build behavior, including its optional destination and checkout-time choice. Existing tokens, carts, and orders are not upgraded or locked, and legacy pickup carts keep their zero-charge checkout even after a hub fee is configured. The client follow-up must enable the new step only for new request drafts; resume old drafts/orders through their existing flow.

Hub operating hours are settings for the collection information shown by the client. They do not replace supplier production calendars, change the promised production deadline, or automatically select a collection appointment. `schedule: null` means Super Admin has not configured hours yet; the client must show that state instead of inventing opening days. QR collection and reminder workflows remain separate follow-ups.

### Distance and rating fields

Both match routes return `distanceZone: { key, label }` at the response root (the Top Pick) and on each `listings[]` / `otherListings[]` item. Keys/labels come from the same [four delivery fee bands](OPERATIONAL_MODEL_V2_API.md#delivery-distance-zones): `nearby` / Nearby, `away` / Away, `long_distance` / Long Distance, `out_of_zone` / Out of Zone. Without a drop-off, `distanceZone` is `null`; no zone is guessed. The existing rule requiring a pin when distance is ranked first remains.

Only Out of Zone **listing objects** carry `distanceKm`, a JSON number rounded to one decimal (`16`, for example, represents 16.0 km). The match root never carries `distanceKm`. In the other three zones that field is omitted, not null. Match reasons use the zone label in `ranked_distance.detail`, never metres or kilometres. Distance ranking uses zones, never exact metres. Existing staff/Operations distances, order/job snapshots, and cart shop coordinate inputs are unchanged.

The response root and listings include `rating: { average, count }` only at five or more valid quality-star reviews. `average` is rounded to one decimal; `count` is the valid review count used by `shopRating`. Below five reviews, the **entire field is omitted**. Quality ranking retains its existing minimum-review rule and uses the unrounded average internally.

Full and compact cart listing objects have the same fields, using the line drop-off or the cart default. Generic catalog listings have `distanceZone: null` because those reads have no client drop-off; they include `rating` at the same threshold and never `distanceKm`. Photo signing and compact cart stubs keep their existing behavior.

Client follow-up: render these labels and ratings on the Top Pick and listings; stop computing/displaying raw match distances from shop points or reason text. Before selecting an Out of Zone listing, show the delivery-cost warning. Checkout fee previews must read the four-band settings union: flat `feeMinor` for the first three bands, `baseFeeMinor + perKmMinor * ceil(distanceMeters / 1000)` for the open-ended band. Do not use the rounded display `distanceKm` to calculate a charge. The API does not add a distance rejection or require warning acknowledgement.

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
  "artworkLinks": [{ "formatCode": "canva_link", "url": "https://www.canva.com/design/ABC/edit" }],
  "dropoff": { "lat": 7.0731, "lng": 125.6128, "label": "Recipient" }
}
```

PATCH accepts `quantity`, `optionIds`, `structuredSpec`, `artworkFileId`, `artworkLinks`, and `dropoff`. The server derives the shop from the public listing and revalidates price/options at checkout.

### Artwork design links

Both add-line and patch-line requests accept `artworkLinks`, independently of `artworkFileId`:

```json
{
  "artworkLinks": [
    { "formatCode": "canva_link", "url": "https://www.canva.com/design/ABC/edit" },
    { "formatCode": "google_drive", "url": "https://drive.google.com/file/d/ABC/view" }
  ]
}
```

The array has at most **3** entries. Each entry has `formatCode: "canva_link" | "google_drive" | "dropbox" | "we_transfer" | "other_link"` and a string `url` of at most **2,000 characters**. Stored URLs must be absolute HTTPS URLs without credentials, whitespace, control characters, or backslashes. Provider codes require the matching domain; lookalike domains do not qualify:

| Code | Input hosts |
| --- | --- |
| `canva_link` | `canva.com` and subdomains; `canva.link` short links |
| `google_drive` | `drive.google.com`, `docs.google.com` |
| `dropbox` | `dropbox.com`, `dropboxusercontent.com` and their subdomains |
| `we_transfer` | `wetransfer.com` and subdomains; `we.tl` |
| `other_link` | Any otherwise-valid URL (including these providers for compatibility) |

Canva short links are resolved through the same SSRF-safe checker before the cart mutation transaction, then stored as `canva_link` with the resolved HTTPS `canva.com/design/.../view` or `/edit` URL, including any sharing-token segment and query. This also applies when an older client sends a `canva.link` URL as `other_link`. The listing must therefore accept `canva_link`. A short link without a resolved HTTPS Canva design returns `400 artwork_link_unresolved`; paste the full design URL instead. This resolution shares the checker's per-user rate budget. Direct links need no provider round trip during cart writes. Canonicalization is not a grant of public access: checkout probes every design link again and refuses a private, unavailable, or inconclusive result.

The listing's effective, active `acceptedFormats` must contain that exact code with `inputKind: "url"`. Listing overrides replace inherited service formats. These rules run on add, patch, and checkout, including a format withdrawn since the line was added.

Omitting `artworkLinks` on PATCH preserves it; `[]` clears it; `null` is invalid. Invalid shape/URL returns `400 { "error": "invalid_artwork_links", "message": "..." }`; an unaccepted format returns `400 { "error": "artwork_link_format_not_accepted", "message": "..." }`.

Full and compact cart responses include `cart.lines[].artworkLinks` (an empty array when absent). Checkout copies the links into immutable order-line snapshots and `invoice.lines[].artworkLinks`. Order reads expose `order.productionItems[].artworkLinks` next to `artworkFileId`/`mockupFileId`: owning client and Operations/Super Admin see all lines, assigned suppliers and riders see only their job's lines, as with existing artwork. Top-level `artworkFileIds` and `mockupFileIds` follow the same job scope; metadata and signed downloads enforce it independently. Legacy fallback and combined-delivery rules are in [Storage API](STORAGE_API.md#get-filesfileid--metadata). Changes to a cart, listing, or its format registry cannot rewrite a placed order's links. Provider-hosted content may still change; GRIDGO snapshots the URL, not the remote bytes.

### Artwork checkout gate and Operations handoff

`POST /me/carts/:id/checkout` checks artwork on **every line**. No new client request field or check token is required. Released clients that skip `/artwork/link-check` receive the same explicit checkout errors; a client-supplied verdict never grants permission. The API probes every saved link afresh before taking the domain transaction lock, then verifies the exact line artwork is unchanged in the transaction. All supplied links must pass, even when the line also has an uploaded file. To use an upload instead, clear failed links with `artworkLinks: []`.

| Checkout error | HTTP | Client fix |
| --- | --- | --- |
| `artwork_required` | 409 | Upload artwork or add a publicly viewable design link. |
| `artwork_link_check_failed` | 409 | Show `message` in the Artwork tab. Make the design viewable by anyone with the link and retry, or remove the link and upload the file. Private, missing, unreachable, timed-out, bot-challenged, unreadable and inconclusive links all block. |
| `artwork_file_check_failed` | 409 | Re-export, upload and replace the artwork. Old uploads without a stored verdict require re-upload. |
| `artwork_check_required` | 409 | Artwork changed during the probe; retry checkout against the current cart. |

Errors include `field: "artwork"` and `lineId`; link failures also include `url` and `access`, and file failures include `fileId` and `reason`. Existing unsafe URL, malformed format, not-ready file, and rate-limit errors still apply. A failed checkout commits no order, job, invoice, payment attachment or notification, and the cart stays draft. Link probes share the existing 10-checks-per-minute per-user budget with `/artwork/link-check`; retry after a minute on `429 artwork_link_rate_limited`.

`POST /files` with `purpose=artwork` keeps its multipart request and `{ file }` response. The response and `GET /files/:id` add `file.artworkCheck: { status: "passed" | "failed", checkedAt, reason, message }`. The server checks bytes from its upload spool, independently of the editable/advisory `file.detected` measurements. Failed structural checks may still produce a ready file, so show `artworkCheck.message` and replace the file; **ready means uploaded, not approved for checkout**. PDF checks require readable page structure, a final cross-reference marker and end marker, and refuse encrypted files; PNG checks include chunk bounds and checksums; JPEG checks require a readable frame, scan and end marker; WebP/Photoshop checks require consistent container/image structure. These checks are bounded and cannot prove every decoder or print requirement. Operations opens the file and checks print readiness before handoff. Nothing supplied by a client can set these verdicts.

Successful checkout returns state `initial_payment_review` and `order.fileCheck.status: "pending"`. It writes an immediate durable `ops_job_needs_qa` alert for each Operations and Super Admin membership, alongside the payment alert. Push and realtime enqueue after the same commit. The shop receives no order inbox row or refresh event while held, and `/jobs`, `/orders`, order detail, shop-recovery routes, and artwork metadata/download authorization exclude it. A snapshotted supplier/job ID alone grants no early access. There is no office-hours exception or timer release. The shop acceptance window begins at the staff handoff to `supplier_assigned`, never during the pending file check; its one-opening-hour deadline follows [Shop recovery API](SHOP_RECOVERY_API.md).

Operations uses the existing `POST /orders/:id/payments/initial/confirm`, then `POST /orders/:id/transition`:

| Action / transition | File review | Shop handoff |
| --- | --- | --- |
| Payment confirmed → `needs_qa` | Stays `pending`; wait begins at checkout, not payment confirmation. | Held. |
| Operations/Super Admin: `needs_qa` → `client_correction`, with nonblank `note` | `failed`; reason is the note. Missing note returns `400 file_check_reason_required`. | Held. |
| Owning client: `client_correction` → `needs_qa` (or legacy `submitted`) | Resets to `pending`, with a new `requestedAt`; alerts staff on resubmission. | Held until reviewed again. |
| Operations/Super Admin: `needs_qa` → `supplier_assigned` | `passed`, with reviewer and review time; matched orders need no `supplierId` in the request. | Shop sees the job and receives `shop_job_assigned` after commit. |
| Operations/Super Admin: `needs_qa` → `approved_for_matching` or `proof_approval` | Also records `passed` for the legacy assignment/proof flow. | Assignment notification follows the normal assignment step. |
| Cancel before a pass | `cancelled`; no accumulating review wait. | Held. |

`GET /orders` and `GET /orders/:id` expose `fileCheck: { status, requestedAt, reviewedAt, reviewedBy, reason, waitingSeconds }` to Operations/Super Admin; the owning client receives the same projection without `reviewedBy`. Suppliers/riders omit it. `waitingSeconds` is computed at read time, in elapsed wall-clock seconds while pending, and is zero after a decision/cancellation. The dashboard follow-up should filter pending checks, sort by `requestedAt` and render the elapsed wait on each row, including `initial_payment_review` orders, so out-of-hours backlogs stay visible. Existing production orders without this additive snapshot retain access; existing intake remains hidden until the quality-control handoff.

#### Recorded Operations checklist

The dashboard may send `qaChecklist: { artwork: boolean, spec: boolean, quantity: boolean, address: boolean }`
on a `needs_qa` transition to `supplier_assigned` (including legacy approval edges) or `client_correction`.
These are the existing four portal ticks: artwork opens and has sufficient resolution (including design-link access/matching),
specification matches the order, quantity looks deliberate, and delivery address is reachable (or the client collects at the hub).
A `true` means the reviewer checked that item; `false` means **Not checked**, not a recorded failure verdict.
All four booleans, and no other keys, are required when the field is supplied. Approval requires all four `true`;
invalid payloads return `400 invalid_qa_checklist` without changing the order. Send-back still needs its client-visible reason.

Operations/Super Admin reads `fileCheck.checklist: { version: 1, checks: { artwork, spec, quantity, address } }`,
with the authenticated `reviewedBy` and server `reviewedAt` applying to all four items. The snapshot is committed
in `orders.data` and the `order.file_check` audit event in the same transaction as the decision. Migration
`1791961200000_order_qa_checklist` adds a database constraint; it never fabricates results for old reviews.
Client resubmission clears the current checklist; earlier decisions remain in audit.

During the API-first rollout, old dashboards may omit `qaChecklist`; their decisions remain valid but store `checklist: null`.
Historical/absent checklists also project as `null`: display **Not recorded** for each item, even if the overall review passed.
The owning client's projection omits `checklist` as well as `reviewedBy`; suppliers/riders still omit `fileCheck` entirely.


Client follow-up: show upload/link-check failure guidance on the Artwork tab and route checkout errors to the indicated line; do not treat an `unknown` check as a warning. Dashboard follow-up: render the pending queue/wait and use the transitions above to pass or request correction. Backend delivery alone does not finish the issue's production + client-release acceptance gate.

### POST `/artwork/link-check`

Requires a Clerk session with a GRIDGO **client membership**. This is a read-only check despite using POST. Request:

```json
{
  "url": "https://www.canva.com/design/ABC/view",
  "formatCode": "canva_link"
}
```

`formatCode` is `canva_link | google_drive | dropbox | we_transfer | other_link`, with the same domain and length validation as storage. The checker accepts HTTP or HTTPS, including redirects; **storage accepts HTTPS only**. A valid check returns HTTP **200** with exactly:

```json
{
  "ok": true,
  "reachable": true,
  "httpStatus": 200,
  "provider": "canva",
  "access": "public_view",
  "message": "Anyone with the link can view this Canva design. Edit permission is not verified.",
  "url": "https://www.canva.com/design/ABC/view",
  "formatCode": "canva_link"
}
```

- `ok`: boolean; true only when public access has supporting evidence (`public_view` or `public_edit`), not merely because an HTTP server answered.
- `reachable`: boolean; whether any HTTP response was received. A 404/login/403 can be reachable without being usable.
- `httpStatus`: last received HTTP status number, or `null` if no response arrived.
- `provider`: `canva | google_drive | dropbox | we_transfer | figma | other`, based on exact domain boundaries. Canva short links are classified from their resolved destination.
- `access`: `public_view | public_edit | sign_in_required | not_found | unknown`.
- `message`: plain explanatory string for display. Do not branch on its wording.
- `url`, `formatCode`: additive normalized link fields. A `canva.link` resolving to a Canva design returns its full design URL and `canva_link`; otherwise the input is retained. A login redirect never replaces the design URL with the login page. Clients can save these fields directly, subject to listing acceptance and HTTPS storage rules. Drive links may now use `google_drive` when the listing accepts it; `other_link` remains compatible when that exact code is accepted.

The checker sends HEAD, then GET for a success needing content inspection or a HEAD refusal (403/405/501). Drive file view/preview and `uc` links start with GET so redundant HEAD requests do not consume the deadline before file evidence arrives. It uses one **5-second total deadline** including DNS, at most **3 redirects total**, an **8 KiB header limit**, and a **64 KiB response-body limit**. On overflow it retains only the first 64 KiB for evidence, then destroys the response. Every hop and the GET fallback resolve DNS, refuse any non-public address in the results, and pin the checked address into the socket lookup. Private, loopback, link-local, metadata, multicast, reserved, and IPv4-mapped/transition IPv6 destinations are refused. Credentials and non-HTTP(S) schemes are refused on redirects too. Canva.com requests send a fixed browser user agent and `Accept: text/html`, because the original checker user agent receives a 200 “Unsupported client” page. Other hosts keep `GRIDGO-Artwork-Link-Check/1.0`. No request sends session headers/cookies or executes JavaScript.

Access evidence is deliberately conservative:

- A complete PDF/PNG/JPEG/WebP body with matching Content-Type and a passing structural file check supports `public_view`. Leading magic bytes or a Content-Type header alone do not prove a usable file. Downloadable bodies over the 64 KiB check cap remain `unknown`; upload the file instead. Public provider viewer pages can still pass using the documented anonymous viewer evidence.
- 401, a fetched login/sign-in URL, or an HTML password input gives `sign_in_required`; 404/410 gives `not_found`. A Drive redirect to `accounts.google.com` gives `sign_in_required` after validating the target DNS, without fetching the sign-in page. Drive “You need access” pages also require sharing changes.
- Drive file view/preview HTML with the captured viewer config identifying the requested file and `isItemTrashed: false` supports `public_view`. A matching trashed config or explicit missing/deleted-file page gives `not_found`. Metadata alone is insufficient. Drive download redirects (including `drive.usercontent.google.com`) use the same per-hop DNS checks and redirect budget; their bytes require matching MIME and magic as above.
- A Canva `/design/<id>[/<share-token>]/view` or `/edit` response with status 200 and the captured viewer bootstrap identifying that same design supports `public_view`, including when this evidence is within the retained 64 KiB prefix of a larger page. `/edit` plus viewer evidence establishes viewing only; this implementation never claims `public_edit`.
- Explicit Canva missing-design error copy or a “Page not found” heading gives `not_found`; script translations are ignored. Cloudflare challenge responses remain `unknown`, even if their status or copy resembles a missing page.
- Unsupported-client pages, generic HTML shells, mismatched design IDs, bot challenges/403, timeouts, DNS/transport failures, excess redirects, and capped bodies without recognizable evidence remain `unknown`. A status of 200, title, or Open Graph metadata alone is insufficient to prove public access. No provider account is used. The captured response and fixture provenance are in `tests/fixtures/artwork-links/README.md`.

Clients should check each entered link, show the message, and ask for a corrected sharing link or an upload when it cannot be verified. `unknown` must not be displayed as verified. The result is advisory and transient: it is not stored as a permission grant, and checkout does not refetch links or require a previous check token. Backend persistence validates URL shape and listing compatibility, resolving only short Canva URLs before cart writes; the client owns its progression UX.

Errors use the standard `{ "error": "snake_case", "message": "..." }` envelope: `401 unauthorized`, `403 forbidden`, `400 invalid_artwork_link`, `400 unsafe_artwork_url`, and `429 artwork_link_rate_limited`. Each user may attempt **10 checks per rolling minute per API process**, including invalid/unsafe requests; unauthenticated and wrong-role requests cannot consume another user's budget. Short-link resolution during cart add/patch uses this same budget (one attempt per short link). Retry after a minute. The limiter is process-local and resets on restart, matching the existing API limiter infrastructure.

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

`POST /me/carts/:cartId/lines`, `PATCH /me/carts/:cartId/lines/:lineId`, and `DELETE /me/carts/:cartId/lines/:lineId` keep the standard `{ "cart": ... }` envelope but return compact `line.listing` stubs so add/save/remove do not rebuild or sign every catalog photo. Each stub contains `id`, `name`, `supplierId`, `fromPriceMinor`, `effectivePriceMinor`, `clientFromPriceMinor`, `clientEffectivePriceMinor`, and `selectedOptions: [{ id, label }]`; it deliberately omits `photos`. Cart lines also carry `lineSubtotalMinor` (shop) and `clientLineSubtotalMinor` (GRIDGO). `GET /me/carts/:cartId` continues to return full catalog listing projections. Fulfilment, drop-off, and mockup mutations still return the full projection.

Set line mockup with `{ "fileId": "file_..." }`. Upload it first with `POST /files`, `purpose=mockup`. The ready file must belong to the client. The same opaque ID is snapshotted onto the order line and becomes readable to Operations and that line's job shop.

Set drop-offs in one call with:

```json
{
  "defaultDropoff": { "lat": 7.0731, "lng": 125.6128, "label": "Home" },
  "lines": [{ "lineId": "cline_...", "dropoff": { "lat": 7.08, "lng": 125.62, "label": "Branch" } }]
}
```

## Checkout and invoice

Multi-shop baskets use the additive [multi-shop checkout contract](MULTI_SHOP_CHECKOUT_API.md):
per-line deadlines and one basket fulfillment choice, 100% upfront for multiple groups,
one combined receipt, and independent order ledgers per shop and deadline.
The single-group flow below is unchanged. Field names and compatibility: [per-line deadlines](PER_LINE_DEADLINES_API.md).

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

No other payment method is accepted. Single-shop checkout creates one job, snapshots listings/options/artwork/mockups/drop-offs, and calculates delivery from the shop pin to the job's farthest effective drop-off. Pickup jobs have zero delivery fee. Multi-shop checkout creates independent orders as specified in the linked contract.

Order totals are:

```text
itemSubtotalMinor = sum line amounts
serviceFeeMinor = round(itemSubtotalMinor × snapshotted serviceFeeRateBps / 10,000)
deliveryFeeMinor = sum job delivery fees
totalMinor = itemSubtotalMinor + serviceFeeMinor + deliveryFeeMinor
downpaymentPercent = settings.downpaymentPercent at checkout (100 by default, or 75)
downpaymentMinor = round_bps(totalMinor, downpaymentPercent × 100)
balanceMinor = totalMinor - downpaymentMinor
```

New orders are paid in full up front: at `100`, `downpaymentMinor = totalMinor`, `balanceMinor = 0`, and the balance installment is `not_required`, which every balance gate treats as settled and which cannot be submitted, confirmed or rejected (`409 balance_not_required`). At `75` the order has a 25% balance exactly as before. The split is snapshotted per order; contract: `docs/OPERATIONAL_MODEL_V2_API.md#upfront-checkout`.

Success is `201` with `{ order, invoice }`. The order is `initial_payment_review`; initial QR payment is `pending_confirmation`; the balance is `not_required` (100%) or `not_submitted` (75/25). `order.downpaymentPercent` and `order.paymentPlan` (`method`, `downpaymentPercent`, `downpaymentMinor`, `balanceMinor`, `downpaymentStatus`, `balanceStatus`) describe the split. Jobs are not notified until a later Operations approval slice. Client projections contain job shop/queue/fulfillment and client totals but never supplier payouts or milestones.

```text
GET /orders/:orderId/invoice
```

Returns `{ invoice }` with immutable line snapshots, one delivery line per job, item subtotal, visible service fee, delivery total, grand total, and the QR plan `{ method, downpaymentPercent, downpaymentMinor, balanceMinor }`. Invoices issued before the split was snapshotted report `downpaymentPercent: 75`.

Common errors are `invalid_preference_ranking`, `dropoff_required`, `match_not_found`, `cart_not_found`, `cart_checked_out`, `cart_empty`, `catalog_item_stale`, `file_not_ready`, and `payment_method_not_allowed`.

## Reviews read back

`POST /orders/:id/review` is written up under checkout. Two readers turn those rows into something a person can use (`src/shop-reviews.js`).

### `GET /me/reviews` (supplier)

The shop's own reviews, newest first, with where it stands. The client is never named.

```json
{
  "summary": { "count": 7, "quality": 4.71, "speed": 4.14, "value": 4.43, "overall": 4.43,
               "onTime": { "count": 7, "rate": 0.86 }, "reviewsUntilMatching": 0 },
  "ranking": {
    "position": 2, "of": 9,
    "byCategory": [
      { "categoryCode": "marketing_collateral", "categoryName": "Marketing collateral",
        "position": 1, "of": 6, "count": 5, "quality": 4.8, "speed": 4.2, "value": 4.6, "overall": 4.53 }
    ]
  },
  "reviews": [
    { "id": "rev_…", "orderId": "ord_…", "createdAt": "…",
      "qualityStars": 5, "speedStars": 3, "valueStars": 4, "comment": "Beautiful print, a day late.",
      "categoryCode": "marketing_collateral", "categoryName": "Marketing collateral",
      "subcategoryCode": "flyers", "subcategoryName": "Flyers", "itemName": "A5 flyers" }
  ]
}
```

- `overall` is the plain mean of the three star averages; `position` ranks shops by it, ties broken by review count. A shop with no reviews has `position: null`.
- `reviewsUntilMatching` counts down to `MIN_REVIEWS_FOR_RATING`; below it, matching scores the shop on listing completeness rather than stars.
- Any role other than `supplier` gets 403.

### `GET /admin/shop-rankings?categoryCode=` (ops_admin, super_admin)

Every shop, ranked. Without `categoryCode` the table is overall; with one, only reviews of work in that category count and `fromPriceMinor` is the shop's cheapest listing there.

```json
{
  "categories": [{ "code": "marketing_collateral", "name": "Marketing collateral" }],
  "categoryCode": "marketing_collateral",
  "rankedCount": 6,
  "rows": [
    { "supplierId": "supplier_a", "shopName": "Lovis Print", "position": 1, "count": 5,
      "quality": 4.8, "speed": 4.2, "value": 4.6, "overall": 4.53,
      "onTime": { "count": 7, "rate": 0.86 }, "fromPriceMinor": 10000 }
  ]
}
```

Unranked shops (`count: 0`, `position: null`) follow the ranked ones, alphabetically. An unknown category is `400 invalid_category_code`.


### Recent production lapses

The quality factor subtracts two points per order with a missed ready-by deadline
in the last 30 days, capped at ten of 100. Client factor priority and deadline
feasibility filtering remain unchanged. The public rating is unchanged. See
[late-production penalties](PRODUCTION_PENALTIES_API.md#matching-weight).

### Document page selection

Per-page cart lines derive `measurement.pages` from the uploaded artwork's
server-inspected `detected.pageCount`. Typed counts are ignored, including from
older clients, except for DOCX files without a usable cached page count. A line
may be added before uploading; its subtotal stays `null`
until its file supplies a count. PDF detection includes compressed page trees;
recognized raster uploads with a detected count have one page. DOCX reads the
cached `<Pages>` value in `docProps/app.xml`; it is not rendered. For a ready DOCX
with an unknown count, Add/PATCH accepts a positive safe-integer
`measurement.pages` as the total document count. A detected count always wins.
The manual total is preserved across quantity/range edits and checkout, and
reset when artwork is replaced or removed; enter it again for the new file.
Unknown-count DOCX without an entered total, other unreadable documents, and
design links without a count cannot complete per-page checkout. Other formats'
existing count rules are unchanged.

Add/PATCH accepts `pageRange: null | string`. Null or an empty string selects all
pages. Strings accept one-based inclusive ranges and individual pages separated
by commas (`"1-4, 7"`). Overlaps and duplicates print once per copy; intervals are
sorted and merged. Zero, negative, fractional, reversed, malformed, out-of-file
ranges and strings over 1,000 characters return `400 invalid_page_range`. A range
on another pricing unit returns `400 page_range_not_accepted`. A range without a
readable uploaded count (or entered total for unknown-count DOCX) returns
`409 document_page_count_required`. Omitting the
field preserves the selection; replacing/removing artwork resets it to all pages
unless the same request explicitly selects a range for the new file.

Responses expose `documentPages: { total, range, printed } | null`. This is
server-owned; supplying a `documentPages` object never changes it. `total` is the
detected file count (or entered DOCX total), `range` is the normalized selection
or null for all, and `printed` is
the unique selected count per copy. That count replaces total pages in the
existing price engine: copies, option/duplex multipliers, minimum quantities and
quantity tiers are unchanged. Shop subtotal, payout and client fee use that same
price. Checkout revalidates the count and rejects missing counts with
`409 document_page_count_required` (`field: "artwork"`, `lineId`).

Checkout snapshots `documentPages` into immutable order lines, invoice lines and
role-scoped `productionItems`; the supplier prints those page numbers from the
attached original file. Existing placed orders are unchanged. Clients must show
the detected file count and selection on Artwork, with a manual total input
only for unknown-count DOCX, and never a typed page count on Listing. Deploy this API before releasing the client and supplier changes.

### Uploaded artwork format acceptance

Cart line add, replacement and checkout compare the file's detected MIME with
the listing's approved effective accepted formats. A mismatch is
`409 artwork_file_format_not_accepted` (`field: "artwork"`, `lineId`, `fileId`).
A listing override of exactly `pdf,docx` accepts those uploads and refuses JPEG,
even though JPEG remains uploadable globally. A pending format revision keeps
the previous approved acceptance set until Operations approves it.

## Platform operating hours

[Operating hours](OPERATING_HOURS_API.md) defines the review wait included in new
match/cart promises, the additive `operatingStatus`, listing `review`, cart
`checkoutNotice` and group `readyBy`, and Manila deadline-calendar reasons.
Payment and automatic artwork checks remain available outside office hours;
manual review and dispatch for new orders follow the live platform schedule.
