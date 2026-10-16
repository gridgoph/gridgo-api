# Print layout API

How a document or drawing is placed on the paper, for products whose shop
offers the choice. The customer app, the shop app and the dashboard build
against this file.

A shop marks which layouts a listing prints. A client ordering that listing
must choose one before checkout, and nothing is preselected. The API also
tells the app what it needs to warn and preview: the file's page size, whether
it is bigger than the chosen paper, and the smallest paper the listing offers
that would take it. Warnings never block an order; only a missing or
unsupported layout does.

Products whose shop marked no layout work exactly as before: every new field
is `[]` or `null`, and nothing new is required.

## Layout codes

| Code | Show as | Meaning |
| --- | --- | --- |
| `fit_to_paper` | Fit to paper | Scaled up or down to fill the paper. The drawing scale changes unless the page is already the paper's size. |
| `actual_size_centered` | Actual size, centred | Printed at 100%, centred on the paper. A larger page loses its edges. |
| `actual_size_original_position` | Actual size, in its original position | Printed at 100% from the page's own origin. A larger page loses its far edges. |

Lists are always in this order, deduplicated. The codes are stable; the
labels are the suggested copy.

## Shop: marking layouts on a listing

`POST /me/catalog-items` and `PATCH /me/catalog-items/:id` accept
`printLayouts`: an array of layout codes, `[]` to offer none. It is replaced as
a whole, like `priceTiers`, under the usual `expectedVersion`. Omitting it
leaves the current value (new listings start with `[]`).

- Anything that is not an array of the three codes is
  `400 invalid_print_layouts` with `field: "printLayouts"` and `allowed`.
- Changing the set is a listing change like any option edit: it opens listing
  review, and clients keep seeing the approved version's layouts until it is
  approved. A text-only edit of a listing saved before this field existed does
  not open a review.
- `GET /me/catalog-items/:id` and the shop's listing list return
  `item.printLayouts`.

Any listing may offer layouts; they matter for documents and drawings
(document printing, blueprint/CAD plotting, posters) but are not restricted by
product type. The fit check below needs a paper-size option to compare
against: an option whose `specBinding.fieldCode` is `size`, `paper_size`,
`item_size` or `dimensions` (the document and plotting starters already bind
their size options this way).

## Listing reads

Every client listing projection carries `printLayouts` (codes, canonical
order, `[]` when the product has no layout choice):

- The catalogue listing reads, match results, anonymous alternatives
  (`otherListings`) and cart group listings. (The featured prints carousel keeps
  its short allowlist and does not carry it.)
- Cart lines: `lines[].listing.printLayouts`, on both the full cart read and the
  compact stubs returned by `POST`/`PATCH`/`DELETE /me/carts/:id/lines`.

Show the Layout choice only when `printLayouts` is non-empty, offer only those
codes, and preselect nothing.

## File page size

`POST /files` (purpose `artwork`) and `GET /files/:id` return `file.detected`
from the upload inspection. For layout purposes:

- `widthMilli`, `heightMilli` (thousandths of a millimetre), `pageSize` (`A4`,
  `Letter`, ... or `null`) and `orientation` describe the **first page**.
- `pageEnvelope: { shortSideMilli, longSideMilli, mixed }` covers **every
  page**: the largest short side and largest long side, either way round, and
  whether the pages differ in size. `null` when the page size is unknown.

How each accepted type is read:

| Type | Page size | Reliability |
| --- | --- | --- |
| PDF | Each page's `/MediaBox` in points, including page trees inside compressed object streams. A box on a page-tree node counts only for pages that state none. | The page size every PDF must declare. A file over the 16 MiB inspection window, or one whose page tree cannot be found, reads as unknown. `/CropBox` and `/Rotate` are not applied; rotation does not matter because the check allows either orientation. |
| DOCX | Each section's `<w:pgSz>` in twips. | The page Word lays the document out on. A file with no declared section size reads as unknown. |
| PNG, JPEG, PSD | Pixels divided by the declared density (PNG `pHYs`, JFIF, Photoshop resolution resource). | Only when the file declares a density; a raster without one has no physical size and reads as unknown rather than being guessed at 72 or 96 DPI. |
| WebP | Pixels only; WebP declares no density. | Unknown. |

Files uploaded before this change keep the first-page size they already
stored (PDF) and have no `pageEnvelope`; the check falls back to the first
page. DOCX files uploaded earlier have no size until uploaded again.

## The fit check

The same object appears on cart lines and in the pre-cart probe, and is
snapshotted onto the order:

```json
{
  "supportedLayouts": ["fit_to_paper", "actual_size_centered"],
  "layout": "actual_size_centered",
  "paper": { "optionId": "opt_a4", "label": "A4", "widthMilli": 210000, "heightMilli": 297000, "pageSize": "A4" },
  "files": [{
    "fileId": "file_1",
    "page": {
      "widthMilli": 297000, "heightMilli": 420000, "pageSize": "A3", "orientation": "portrait",
      "largestShortSideMilli": 297000, "largestLongSideMilli": 420000, "mixedPageSizes": false
    },
    "exceedsPaper": true
  }],
  "exceedsPaper": true,
  "cutOff": true,
  "scaleChanges": false,
  "suggestedPaper": { "optionId": "opt_a3", "label": "A3", "widthMilli": 297000, "heightMilli": 420000, "pageSize": "A3" },
  "unknown": []
}
```

- `paper`: the selected option that names a paper size, or `null` when none is
  selected or the size cannot be read. Paper sizes come from the option's spec
  binding value, then its label: names (`A0`–`A6`, `B4`, `B5`, `Short`/`Letter`
  8.5 x 11 in, `Long`/`Folio` 8.5 x 13 in, `Legal`, `Tabloid`/`Ledger`) or
  `W x H` with an optional unit (`mm`, `cm`, `in`, `ft`); a bare `24x36` is
  inches.
- `exceedsPaper`: any page is larger than the paper. A page fits when its
  largest short and long sides are each within 1 mm of the paper's, either way
  round. `null` when the paper or any file's page size is unknown and no known
  page already exceeds it.
- `cutOff`: `true` only for an actual-size layout on a page that exceeds the
  paper. Always `false` for `fit_to_paper`; `null` while no layout is chosen.
- `scaleChanges`: for `fit_to_paper`, whether the page differs from the paper
  (so the drawing scale changes); `false` for actual-size layouts; `null` while
  no layout is chosen or a size is unknown.
- `suggestedPaper`: when `exceedsPaper` is true, the smallest-area paper option
  in the same choice group that every measured page fits. `null` when no
  offered paper fits — keep the cut-off warning, with no suggestion.
- `unknown`: why parts of the check are missing: `paper_size_unknown`,
  `no_artwork_file`, or `page_size_unknown` with its `fileId`.
- The whole object is `null` for a product with no layouts.

Suggested copy:

- Under Fit to paper, always (non-blocking): "The drawing scale will change to
  fit the paper."
- `cutOff: true`: "Parts of your page will be cut off on {paper.label}." plus,
  with a suggestion, "Choose {suggestedPaper.label} to print it whole."

### Preview

Draw `paper` as the frame (its `widthMilli` x `heightMilli`, turned to match
the page's orientation) and the file's first page (`files[i].page`) on it:

- `fit_to_paper`: scale the page to fit inside the paper, keeping its aspect
  ratio, centred.
- `actual_size_centered`: the page at its real size, centred; anything outside
  the frame is what gets cut off.
- `actual_size_original_position`: the page at its real size from the paper's
  top-left corner.

`artworkPreviewFileId` on the cart line, when present, is the rendered first
page to fill that rectangle.

## Client: before the item is in the cart

`GET /me/print-layout-check?catalogItemId=...&optionIds=a,b&fileIds=f1,f2&layout=...`

Signed-in client only. Read-only; no lock or audit. `optionIds` and `fileIds`
may repeat or be comma-separated; `fileIds` are the client's own ready artwork
uploads, at most ten. `layout` is optional.

- `200 { check }` — the object above; `check: null` for a product without
  layouts.
- `409 catalog_item_stale` — the listing is not public.
- `409 file_not_ready` — a file is not the caller's ready artwork.
- `409 print_layout_not_supported` — the layout is not one the listing offers
  (`details.supported` lists the ones it does).
- `400 invalid_print_layout` — not a layout code.

## Client: the cart line

`POST /me/carts/:id/lines` and `PATCH /me/carts/:id/lines/:lineId` accept
`printLayout`: a layout code, or `null` to clear it.

- It is optional on these writes so a cart can be filled in steps, and so
  released app builds that never send it keep working.
- A code the listing does not offer, or any code on a listing with no layouts,
  is `409 print_layout_not_supported` with `field: "printLayout"` and
  `supported`. A non-code is `400 invalid_print_layout`.
- Every cart line returns `printLayout` (`null` until chosen) and
  `printLayoutCheck` (the check object, or `null` for products without layouts).
  The compact line-mutation responses include both.

Checkout (`POST /me/carts/:id/checkout`) refuses, per line:

- `409 print_layout_required` with `lineId`, `field: "printLayout"` and
  `supported` when the listing offers layouts and none was chosen.
- `409 print_layout_not_supported` when the chosen layout is no longer offered,
  or the listing no longer offers layouts at all. `PATCH` the line with an
  offered code (or `null`) and retry.

A released app build cannot send `printLayout`, so it cannot check out a
product whose shop offers layouts and gets `print_layout_required` instead;
products without layouts are unaffected.

## Orders: the agreed spec

Checkout snapshots the layout onto the order line, immutably (a database
trigger refuses later rewrites):

`order_line_items.print_layout = { "version": 1, "code": "...", "check": { ... } }`

`check` is the fit check exactly as the client saw it at checkout, so a later
listing or file change never alters what was agreed.

Every order projection with `productionItems` — the supplier job read, the
client's order, and the GRIDGO Team's order reads that feed the dashboard's
job ticket and comparison — carries per line:

- `printLayout`: the code, or `null` for products without layouts and older
  orders.
- `printLayoutCheck`: the snapshotted check, or `null`.

The checkout invoice lines carry `printLayout` (code or `null`).

## Storage

Migration `1792097000000_print_layouts`:

- `supplier_catalog_items.print_layouts text[] NOT NULL DEFAULT '{}'`, limited
  to the three codes.
- `client_cart_lines.print_layout text`, one of the codes or null.
- `order_line_items.print_layout jsonb`, version 1 with a valid code, immutable
  once the snapshot is finalized.

The migration is forward-only.
