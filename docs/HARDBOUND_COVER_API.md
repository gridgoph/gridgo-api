# Hardbound cover and spine API

How a client tells the shop how a hardbound or bound book's cover is made and
what is lettered on its spine. The customer app, the shop app and the
dashboard build against this file.

A client ordering a hardbound or binding product chooses one cover:

| Code | Show as | Meaning |
| --- | --- | --- |
| `first_page` | Use the first page of my file | The shop prints the cover from the first page of the uploaded file. |
| `separate_file` | Upload a separate cover page | The cover is its own uploaded file, attached to the same item. |
| `text_only` | Plain cover, text only | No printed design: the cover is lettered with the spine details below. |

and fills in the spine:

| Field | Required | Limit |
| --- | --- | --- |
| `institutionCode` | No | 24 characters |
| `title` | Yes | 200 characters |
| `author` | Yes | 160 characters |
| `month` | Yes | Whole number, 1–12 |
| `year` | Yes | Whole number, 1950–2100 |

The codes are stable; the labels are suggested copy. Limits count
characters, not bytes. Text is one line: line breaks, tabs and other control
characters are refused. Leading and trailing spaces are trimmed and runs of
spaces become one. An empty `institutionCode` is stored as `null`.

The shop works out the cover and spine dimensions itself. GRIDGO offers no
template download and no spine-width calculator.

## Which products ask

The catalogue decides, not the shop. A listing asks for the form when its
**approved** product type (`subcategoryCode`) is one of:

| Code | Product type |
| --- | --- |
| `binding_hardbound` | Binding & hardbound (document and publication printing) |

This is the only binding product type in the taxonomy today. A shop's pending
listing revision that changes the product type has no effect until it is
approved, like every other listing change. Another binding product type would
be added to `COVER_SPINE_SUBCATEGORIES` in `src/hardbound-cover.js`.

Every client listing projection carries `coverSpineForm: true | false`:

- The catalogue listing reads, match results, anonymous alternatives
  (`otherListings`) and cart group listings. (The featured prints carousel
  keeps its short allowlist and does not carry it.)
- Cart lines: `lines[].listing.coverSpineForm`, on both the full cart read and
  the compact stubs returned by `POST`/`PATCH`/`DELETE /me/carts/:id/lines`.
- The shop's own listing reads (`GET /me/catalog-items`, `/:id`).

Show the cover choice and spine form only when `coverSpineForm` is true.

## Client: the cart line

`POST /me/carts/:id/lines` and `PATCH /me/carts/:id/lines/:lineId` accept
`coverSpine`, or `null` to clear it:

```json
{
  "coverSpine": {
    "cover": "separate_file",
    "coverFileId": "file_cover",
    "spine": {
      "institutionCode": "ABC-CS",
      "title": "Flood Risk Mapping of a River Basin",
      "author": "Sample Author",
      "month": 10,
      "year": 2026
    }
  }
}
```

- The form is sent whole and replaces what the line had. Keep a half-typed
  form in the app for the live preview and send it once it is complete.
- `coverFileId` is required for `separate_file` and refused for the other two.
- Optional on these writes, so a cart can be filled in steps, and so released
  app builds that never send it keep working.

### The separate cover page

Upload the cover page like any artwork (`POST /files`, purpose `artwork`) and
attach it to the same line in `artworkAttachments`, for example with the label
`Cover`. Then name it in `coverSpine.coverFileId`. Because it is one of the
line's own artwork files it goes through the usual upload checks, checkout
file check, GRIDGO Team file check and release to the shop, with no separate
path.

`409 cover_file_not_attached` (`field: "coverSpine.coverFileId"`, `fileId`)
when the named file is not one of the line's artwork files, whether the form
or the artwork changed. To remove the cover page, choose another cover in the
same `PATCH` or first.

### Errors

- `400 invalid_cover_spine` with `field` (for example
  `coverSpine.spine.title`) and `reason`:

  | `reason` | When |
  | --- | --- |
  | `not_object` | `coverSpine` is not an object. |
  | `unknown_field` | A key other than those listed above. |
  | `unknown_cover` | `cover` is not one of the three codes (`allowed` lists them). |
  | `required` | A required field is missing or blank, or `coverFileId` is missing for `separate_file`. |
  | `not_separate_file` | `coverFileId` was sent with another cover. |
  | `not_text` | A text field is not a string. |
  | `not_one_line` | A text field has a line break or other control character. |
  | `too_long` | A text field is over its limit. |
  | `out_of_range` | `month` or `year` is not a whole number in range. |

- `409 cover_spine_not_applicable` (`field: "coverSpine"`) when the listing
  does not ask for the form. Clear it with `null`.

### What the line returns

Every cart line, on the full read and the compact line-mutation responses:

- `coverSpine`: `null` until given, otherwise:

  ```json
  {
    "status": "given",
    "cover": "separate_file",
    "coverFileId": "file_cover",
    "spine": { "institutionCode": "ABC-CS", "title": "Flood Risk Mapping of a River Basin", "author": "Sample Author", "month": 10, "year": 2026 },
    "spineDate": "October 2026",
    "spineSummary": "ABC-CS | Flood Risk Mapping of a River Basin | Sample Author | October 2026"
  }
  ```

- `coverSpineRequired`: `true` when checkout will refuse this line without
  the form (see below).

### Live preview

The app draws the preview from what the client is typing; the server is not
called for it. Draw the spine top to bottom in this order, skipping an empty
institution code: institution code, title, author, then the month name and
year (`October 2026`). `spineSummary` is the same text on one line, for lists
and tickets where a drawn spine does not fit. For a `text_only` cover, show
the same details on the front.

## Checkout

`POST /me/carts/:id/checkout` checks, per line:

- On a product that asks, a line without the form is refused with
  `409 cover_spine_required` (`lineId`, `field: "coverSpine"`) **only while the
  `coverSpineRequired` setting is on**. While it is off, the order is placed
  and the line is agreed as "not given"; the shop asks the client as before.
- `409 cover_spine_not_applicable` (`lineId`) when the line has a form but the
  approved listing no longer asks for it. `PATCH` the line with
  `coverSpine: null` and retry.
- `409 cover_file_not_attached` (`lineId`) when the separate cover page is no
  longer one of the line's artwork files.

### The `coverSpineRequired` switch

`GET /settings` returns `settings.coverSpineRequired` (default `false`).
Super Admin changes it with the usual version handshake:

`PATCH /settings { "expectedVersion": n, "reason": "…", "coverSpineRequired": true }`

- A JSON boolean, or `400 invalid_cover_spine_required`.
- Version checked (`409 settings_version_conflict`), audited as
  `settings.operational_update`, and kept by settings writes that omit it.
- It is off because released client builds cannot send the form. **Turn it on
  after the client release with the spine form reaches coverage.** Until then
  every released build keeps checking out hardbound products unchanged.
- It affects new checkouts only; agreed orders keep what they were placed with.

## Orders: the agreed spec

Checkout snapshots the form onto each order line of a product that asks,
immutably (a database trigger refuses later rewrites):

```json
order_line_items.cover_spine = { "version": 1, "status": "given", "cover": "...", "coverFileId": "... or null", "spine": { ... } }
order_line_items.cover_spine = { "version": 1, "status": "not_given" }
```

Lines of other products, and orders placed before this change, have no
snapshot (`null`). Later listing, product type or cart changes never alter
what was agreed.

Every order projection with `productionItems` carries per line `coverSpine`,
for the client's order, the shop's job once its artwork is released, and the
GRIDGO Team's order reads that feed the dashboard's job ticket and comparison:

- `null`: the product does not ask, or the order is older than this change.
- `{ "status": "given", "cover", "coverFileId", "spine", "spineDate", "spineSummary" }`:
  the same shape as the cart line.
- `{ "status": "not_given", "cover": null, "coverFileId": null, "spine": null, "spineDate": null, "spineSummary": null }`:
  the product asks and the client gave nothing. Show "Not given".

Riders always get `null`. The separate cover page is the
`artworkAttachments` entry with the same `fileId`, signed the same way as the
other artwork. The checkout invoice lines carry the same `coverSpine` value.

## Storage

Migration `1792112000000_cover_spine`:

- `cover_spine_form_valid(jsonb)`: the shape and limits above.
- `client_cart_lines.cover_spine jsonb`, a valid form or null.
- `order_line_items.cover_spine jsonb`: version 1, either `given` with a valid
  form or `not_given` with none; immutable once the snapshot is finalized.
- `coverSpineRequired` lives in the settings row and reads as off while
  absent, so the migration does not change settings.

The migration is forward-only.
