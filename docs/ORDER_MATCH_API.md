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

Canva short links are resolved through the same SSRF-safe checker before the cart mutation transaction, then stored as `canva_link` with the resolved HTTPS `canva.com/design/.../view` or `/edit` URL, including any sharing-token segment and query. This also applies when an older client sends a `canva.link` URL as `other_link`. The listing must therefore accept `canva_link`. A short link without a resolved HTTPS Canva design returns `400 artwork_link_unresolved`; paste the full design URL instead. This resolution shares the checker's per-user rate budget. Direct links need no provider round trip during cart writes. Canonicalization is not a grant of public access: a resolved private or unavailable design still requires the client's check UX.

The listing's effective, active `acceptedFormats` must contain that exact code with `inputKind: "url"`. Listing overrides replace inherited service formats. These rules run on add, patch, and checkout, including a format withdrawn since the line was added.

Omitting `artworkLinks` on PATCH preserves it; `[]` clears it; `null` is invalid. Invalid shape/URL returns `400 { "error": "invalid_artwork_links", "message": "..." }`; an unaccepted format returns `400 { "error": "artwork_link_format_not_accepted", "message": "..." }`.

Full and compact cart responses include `cart.lines[].artworkLinks` (an empty array when absent). Checkout copies the links into immutable order-line snapshots and `invoice.lines[].artworkLinks`. Order reads expose `order.productionItems[].artworkLinks` next to `artworkFileId`/`mockupFileId`: owning client and Operations/Super Admin see all lines, assigned suppliers and riders see only their job's lines, as with existing artwork. Changes to a cart, listing, or its format registry cannot rewrite a placed order's links. Provider-hosted content may still change; GRIDGO snapshots the URL, not the remote bytes.

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

- Recognizable leading PDF/PNG/JPEG/WebP bytes with the matching Content-Type served successfully without authentication (including files larger than the cap) support `public_view` and “Anyone with the link can view this artwork.” A Content-Type header alone does not.
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
