# Document and construction printing: colour detection and pricing

Report **0BE07331**. Backend contract version 1. Apply migration
`1792166400000_colour_pricing` before deploying. Client, Supplier mobile/web and
Admin UI are separate follow-ups. Existing listings and orders remain fixed-price
unless their shop explicitly enables this feature and GRIDGO approves the revision.

## Supplier setup

The existing `POST /me/catalog-items` and `PATCH /me/catalog-items/:id` accept:

```json
{
  "expectedVersion": 3,
  "pricingUnit": "per_page",
  "printLayouts": ["fit_to_paper", "actual_size_centered", "actual_size_original_position"],
  "pricedByColour": true,
  "oneColour": false,
  "colourPricing": {
    "sizes": [
      {"paperSize":"20x30", "tierSet":"large_format", "prices":{
        "none":3000, "up_to_25":6000, "up_to_50":10000, "above_50":20000
      }},
      {"paperSize":"A3", "tierSet":"a3", "prices":{
        "monochrome":1000, "full_colour":2500
      }}
    ]
  }
}
```

All prices are **shop-set per-sheet PHP centavos**, nonnegative safe integers.
Zero is an explicit offered free price. Omitted/null prices are **not offered**;
GRIDGO never substitutes a base price, another size/tier or a platform estimate.
`colourPricing.sizes` replaces the whole set (maximum 32 sizes); omit the field on
PATCH to retain it. Recognized paper names and dimensions use the existing
[print layout size parser](PRINT_LAYOUT_API.md); bare dimensions are inches.
Returned sizes include canonical `widthMilli`, `heightMilli` (thousandths of mm)
and `pageSize`. Duplicate physical sizes are refused, including rotated aliases.
A3 paper uses the A3 tier set; other sizes use large-format tiers. Size options must have the existing `specBinding`
with a paper `size`/`paper_size`/`item_size`/`dimensions` value. Their selected
physical size selects the price table; a size with no table needs a price check.

Colour pricing requires `per_page` and at least one supported print layout.
Prices in this table are the complete sheet rate for the configured listing;
legacy base prices, option modifiers/multipliers, quantity tiers and speed prices
are not applied on top. Configure separate listings when other specifications
change those rates. Existing required option selection and minimum quantity gates
still apply. Public `fromPriceMinor` and `clientFromPriceMinor` are the lowest
explicitly offered sheet rate with the client service fee included;
`effectivePriceMinor` is null until artwork can be quoted. Public colour listings
return null base-price fields; those fields are not a colour checkout price.

These fields participate in the existing listing review: supplier drafts never
change approved client prices, matching, carts or checkout. New colour listings
must be approved. The standard listing version handshake remains mandatory.
Only the owning shop can set these rates; staff review does not invent prices.

Fixed-price CAD plotting, blueprint and photo-paper listings keep
`pricedByColour:false`. Mark a blueprint/monochrome listing `oneColour:true` to
show the colour warning. The two flags cannot both be true. No service name is
used to infer a flag. Private supplier/staff listing projections include the flags
and shop price table. Public, match and compact cart listing projections include
the flags and size metadata, replacing each size's `prices` with `offeredTiers`
(for example `["none","up_to_25"]`); they never expose shop tier rates.
Compact stubs omit these fields on legacy,
unconfigured listings (absence means false/null). Per-page listings also return:

```json
{"prepareFile":{"recommendedDpi":{"min":300,"max":600},"resolutionAffectsPrice":false}}
```

Use this in the M4.08 “Prepare your file” guide. Resolution never changes prices.

## Super Admin thresholds

`GET /settings` includes `settings.colourDetection`:

```json
{"minSaturationBps":2500,"minLightnessBps":500,"maxLightnessBps":8500,"a3MonochromeMaxBps":1000}
```

Only Super Admin can replace this complete object using existing
`PATCH /settings` with **expectedVersion** and a nonempty **reason**. Invalid
values return `400 invalid_colour_settings`; a stale version returns
`409 settings_version_conflict`. The usual append-only audit and settings event
apply. Each field is integer 0–10,000. Saturation must be positive; minimum
lightness must be below maximum; maximum must be below 10,000.

The version-1 estimate decodes RGB, composites transparency onto white, and
counts a pixel when HSV saturation `(max-min)/max` meets `minSaturationBps` and
HSL lightness `(max+min)/510` lies between the inclusive lightness limits. Neutral
black/white/greys do not count; dark near-black and pale colours fall outside the
lightness limits. Saturated orange/red/green/blue count. This is an RGB rendering
estimate, not an ink-separation, press-profile or exact toner measurement.

`strongColourBps` is strong pixels / **whole paper area** × 10,000, rounded upward;
`strongColourPercent` is that number / 100. White margins count in the denominator.
Tier boundaries:

| Tier set | Code | Coverage |
| --- | --- | --- |
| large_format | none | exactly 0 |
| large_format | up_to_25 | >0 to 25%, inclusive |
| large_format | up_to_50 | >25% to 50%, inclusive |
| large_format | above_50 | >50% |
| a3 | monochrome | <= a3MonochromeMaxBps (default 10%) |
| a3 | full_colour | > a3MonochromeMaxBps |

Changed settings affect fresh cart analysis requests. They never rewrite an
accepted order or its original invoice/evidence. After changing settings, clients
can request the current analysis using the endpoint below.

## Upload, asynchronous analysis and cart configuration

`POST /files` keeps its `purpose=artwork` multipart contract. Once the original
bytes and ready metadata commit, it queues a durable source-page analysis of
PDF, PNG, JPEG or WebP. Detection runs outside the HTTP/domain transaction and
cannot fail the upload. `GET /files/:id` uses existing file authorization and
adds `colourAnalysis:{status,version,thresholds,completedAt,pages?,error?}` for
source analysis. It contains no image bytes or private object key.

Paper-specific analysis is automatically queued when a cart line is added or
patched with artwork, a selected paper option and a supported `printLayout`.
Use existing cart line routes with:

```json
{
  "catalogItemId":"sci_document",
  "optionIds":["opt_20x30"],
  "artworkFileId":"file_pdf",
  "printLayout":"fit_to_paper",
  "quantityMode":"document_sets",
  "quantity":3
}
```

`quantityMode` is `copies_each_page | document_sets`; null clears it. Both mean
**selected pages × quantity** sheets and sum of selected page sheet prices ×
quantity money. Their collating instructions differ. The colour checkout
requires an explicit mode. Fixed-price per-page orders may send it too; old
fixed-price clients may omit it. Display “3 sets × 12 pages = 36 sheets” or the
corresponding copies label; never multiply twice.

`POST /me/carts/:id/colour-analysis` with `{}` ensures the current paper/layout/
threshold request exists; `{retry:true}` retries a failed request after 30 seconds.
It returns `202 {quote}` and authorizes every artwork against the owning client.
Other clients cannot operate this cart. `GET /me/carts/:id` and
`GET|POST /me/carts/:id/quote` return the current result without running a renderer.
Poll those reads or refetch on the `carts` realtime invalidation.

Cart lines return `quantityMode`, `totalSheets`, `colourPricing`; cart quotes
include `colourPricing:[{lineId,...result}]`. `/me/catalog-quotes` also accepts
artwork, layout and quantity mode to read an already-completed analysis; use the
cart endpoint to queue work. Example owning-client result with a 45% fee allocated
to this line (all money is integer PHP centavos):

```json
{
  "version":1,"status":"priced","pricedByColour":true,"estimate":true,
  "quantityMode":"document_sets","quantity":3,"totalSheets":6,
  "paperSize":"20x30","tierSet":"large_format","clientLineSubtotalMinor":39150,
  "pagePriceBasis":"per_sheet_all_in",
  "warning":null,
  "pages":[
    {"fileId":"file_pdf","page":1,"strongColourBps":0,"strongColourPercent":0,"tier":"none","sheetPriceMinor":4350,"clientSheetPriceMinor":4350,"clientPageTotalMinor":13050,"clientPageRoundingMinor":0,"status":"priced"},
    {"fileId":"file_pdf","page":2,"strongColourBps":1800,"strongColourPercent":18,"tier":"up_to_25","sheetPriceMinor":8700,"clientSheetPriceMinor":8700,"clientPageTotalMinor":26100,"clientPageRoundingMinor":0,"status":"priced"}
  ]
}
```

Client projections never expose the shop `lineSubtotalMinor`. Their
`sheetPriceMinor` is an alias of the all-in `clientSheetPriceMinor`; display that
per-sheet amount with the colour level (for example “Page 2: 18% strong colour,
₱87”). `clientPageTotalMinor` covers **all** copies/sets of that page and sums
exactly to `clientLineSubtotalMinor`. Fees use the existing shop/deadline group
allocation, including other cart lines, rather than marking up pages separately.
These item amounts are before separately shown organization/voucher discounts
and fulfillment charges, matching the existing client line/invoice amounts.

For rounding, use `clientPageTotalMinor` as the exact payable page allocation.
The display sheet rate is rounded half up to a centavo; signed
`clientPageRoundingMinor` reconciles
`clientSheetPriceMinor × quantity + clientPageRoundingMinor = clientPageTotalMinor`.
For example, three copies allocated five centavos display two centavos per sheet
and a minus-one-centavo rounding adjustment. Do not reconstruct the quote by
multiplying rounded display rates without that adjustment.

Supplier projections preserve shop `sheetPriceMinor` and `lineSubtotalMinor`
(3000/6000 and 27000 in this example). Staff projections retain those original
shop fields and add the client fields above. Client cart reads/mutations, quote
responses, checkout errors, order production items and invoices all use the
client projection; supplier/staff evidence remains unchanged in storage.

Results also include `request:{version,layout,paper,thresholds}`. Ready pages keep
`analysisKey`, `detectedAt`, source physical dimensions and sampled/strong pixel
counts. Multiple uploaded files are concatenated in attachment order, with each
page identified by `(fileId,page)` (one-based within that file). Source images
are one page. Existing `pageRange` selects pages within the primary file; a range
with multiple uploaded documents is refused for colour pricing rather than
silently skipping other files. Links and unsupported artwork require a supported
upload for colour pricing. Word originals remain usable for fixed-price services.

Statuses before a colour price can be accepted:

| Status | Meaning/action |
| --- | --- |
| configuration_required | Select a paper option and layout |
| artwork_upload_required | Upload supported artwork; links cannot be measured |
| pending | Analysis is queued/not yet requested; wait or ensure it via POST |
| failed | Read/render failed; retry or replace the file |
| analysis_limit | This file has 32 variants; upload a fresh original |
| unsupported | Replace unsupported/deleted artwork |
| quantity_mode_required | Choose copies or sets |
| multiple_file_page_range_unsupported | Use one document for a range, or separate cart lines |
| duplicate_artwork_unsupported | Attach a file once and choose the number of copies/sets |
| needs_price_check | At least one selected page lacks a shop rate |
| priced | Complete colour price ready for checkout |
| fixed_price | Analysis is advisory for a one-colour fixed-price listing |

On an unpriced page, `sheetPriceMinor:null`, `status:"needs_price_check"` and
`message:"This page needs a price check"`. The line/checkout total stays null.
Clients receive null page amounts until all lines in the shop/deadline group can
be priced, since a group fee cannot yet be allocated. Supplier/staff evidence
retains any other pages' available shop rates. Checkout refuses
`409 colour_price_check_required`; other incomplete colour evidence refuses
`409 colour_analysis_required`. The existing service-fee brackets, discounts,
vouchers, payment and basket boundaries operate on the **sum of shop page prices**,
once per shop/deadline group. Use existing all-in client amount fields. Never
sum individually fee-marked page display amounts to manufacture a quote.

A one-colour service returns the non-blocking `warning`:

> Your file has colour, but this service prints in one colour. Choose a colour service if you need the colours.

It has no effect on the fixed price or checkout gates. Without a paper/layout
choice the source-page analysis supplies this warning; once configured the printed
page analysis supplies it. Pending advisory detection does not block fixed-price
checkout.

## Operations, order evidence and corrections

`GET /ops/colour-price-checks` is Operations/Super Admin only. It returns
`{checks:[{cartId,lineId,clientId,supplierId,catalogItemId,colourPricing}]}` for draft
cart pages missing shop prices (up to 100). Analysis completion writes durable
`colour_price_check` inbox rows to **both** current Ops and Super Admin memberships
and queues notification/cart refreshes before save. Resolve pricing with the shop;
only its approved listing prices can unlock checkout.

Checkout snapshots `quantityMode` and the complete `colourPricing` result on the
order line. `productionItems[].colourPricing`, `quantityMode`, `totalSheets` expose
these for the owning client, its shop and staff. Ops Quality Check should show
**each page's coverage, tier and sheet price** beside the original file. Supplier
artwork release and multi-shop scoping retain their existing gates; riders receive
no colour evidence. The original invoice also keeps the snapshot. The database
protects finalized order evidence and quantity mode from rewrites, and verifies
colour page rates × quantity against the BIGINT line subtotal. Later threshold,
listing and file-analysis changes do not alter dispute evidence.

A clearly wrong estimate must be proposed using the existing
[change-request workflow](ORDER_CHANGES_API.md), never printed at a different price:

```json
{
  "lineItemId":"oli_document",
  "reason":"Page 1 has substantial orange fill when inspected at print size",
  "colourCorrection":{"pages":[
    {"fileId":"file_pdf","page":1,"strongColourBps":1800,"sheetPriceMinor":6000},
    {"fileId":"file_pdf","page":2,"strongColourBps":1800,"sheetPriceMinor":6000}
  ]}
}
```

Every selected original page must appear exactly once. The server derives tiers
using the original thresholds, sums the shop's corrected rates and original
quantity, and derives the extra principal against the latest **applied** correction
(or original line). A supplied `extraPrincipalMinor` must match; do not calculate
an independent supplement in an app. Equal-price corrections still need client
approval. Increases require approval and separately verified QR collection before
application; existing incremental frozen fee/payout/refund controls apply. Applied
terms appear at `productionItems[].agreedColourCorrection` (with request ID and
application time), alongside any independently agreed specification, and the full
request/decision history stays available. Original evidence is never overwritten.
Client correction/history projections remove shop `originalLineSubtotalMinor`
and `correctedLineSubtotalMinor`, replacing them with
`originalClientLineSubtotalMinor` and `correctedClientLineSubtotalMinor`. Corrected
pages use the same all-in sheet/extended-total/rounding fields as client quotes,
including the frozen original line fee and subsequent incremental correction
fees. Supplier corrections retain shop amounts; staff sees both sets of fields.
As with existing change requests, reductions use the Operations refund procedure;
this endpoint returns `409 colour_correction_refund_required` rather than creating
a negative supplement or silently marking a refund paid.

## Runtime and limits

The production Docker image includes Poppler, ImageMagick and `prlimit`.
PDFs are rendered page by page using CropBox/rotation; images are auto-oriented
and composited on white. `fit_to_paper` preserves aspect ratio and centers;
actual-size modes center or retain top-left placement and clip. Paper feed
orientation follows the existing print-layout contract. Actual-size image analysis
requires trustworthy physical dimensions/DPI; otherwise it fails with
`colour_physical_size_unknown`. Fit-to-paper does not need image DPI.

Source limit: 64 MiB, 200 PDF pages. Source rasters are bounded to 1200 pixels on
the long side and paper measurement to 800; this is explicitly an estimate.
Subprocesses have fixed arguments, no service secrets, resource limits, timeouts,
and no image delegates/network coders. Temporary raster bytes are removed after
each job; originals stay private in MinIO. PostgreSQL stores metadata/evidence,
never file/raster blobs. At most 32 analysis variants per file; upload a new
original after exhausting this bound. A failed/partial document never produces a
partial payable quote. Each native command times out at 25 seconds; an overall
job stops after about 90 seconds plus its active command. Excessive/complex files
may require splitting into separate uploads.

One durable job runs at a time across replicas under a separate renderer advisory
lock; orders/payments are not locked while rendering. Startup and the lifecycle
tick resume pending jobs after a crash, and saves kick the worker after commit.
Results are saved under the domain lock only after reloading and checking the
file is still ready and unchanged. Failed jobs require an explicit retry; no
renderer/error log contains source document content or private paths.

Validation: `npm test -- --maxWorkers=2`. This accepts the worker cap while keeping
the shared isolated PostgreSQL test database serial. The new pure, native-renderer,
worker, HTTP and PostgreSQL tests cover thresholds, inclusive tiers, missing
prices, copies/sets, layout margins, fees, privacy and immutable evidence.
