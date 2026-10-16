# Exact colours API

A client with brand or school colours can name them exactly at the specs and
artwork step: up to eight colours, each a Pantone code, CMYK percentages or a
hex value, with a label. The shop sees each as text and a swatch, and the
GRIDGO Team comparison and the client's approval proof show them beside the
colours GRIDGO read from the uploaded file. The customer app, the shop app
and the dashboard build against this file.

Everything here is optional. A cart line without colours, and a released app
build that never sends them, work exactly as before: lines return
`colorTargets: []`, and nothing new is required at checkout.

Source: `src/color-targets.js` (targets), `src/artwork-colors.js` (file colours).

## Pantone codes are text

GRIDGO does not ship Pantone colour data: it is licensed. A Pantone target is
checked for shape and kept as text (`PANTONE 185 C`); the API never converts it
to CMYK, RGB or hex and does not check that the code exists. Its swatch is the
client's own approximate hex when they give one, otherwise there is no swatch
and the app shows the code as text only.

CMYK targets get a swatch from the plain screen formula, marked approximate.
Hex targets are screen colours and their swatch is exact on screen.

Screens and printers differ. The app shows a note beside the colours, with a
link to Sample First where the product offers it (the API has no Sample First
flag yet; the link is the app's to place). Colour profiles are not part of
this API.

## A colour target

Input, one of three shapes (exactly one of `pantone`, `cmyk`, `hex`):

```json
{ "label": "School maroon", "pantone": "201 C", "approximateHex": "#9D2235" }
{ "label": "Brand red", "cmyk": "C0 M100 Y65 K34" }
{ "label": "Brand red", "cmyk": { "c": 0, "m": 100, "y": 65, "k": 34 } }
{ "label": "Logo blue", "hex": "#1A5FB4" }
```

What every read returns, normalised:

```json
{
  "label": "School maroon",
  "format": "pantone",
  "value": "PANTONE 201 C",
  "cmyk": null,
  "hex": null,
  "swatchHex": "#9D2235",
  "swatchApproximate": true
}
```

| Field | Pantone | CMYK | Hex |
| --- | --- | --- | --- |
| `format` | `pantone` | `cmyk` | `hex` |
| `value` (show as text) | `PANTONE 201 C` | `C0 M100 Y65 K34` | `#1A5FB4` |
| `cmyk` | `null` | `{ c, m, y, k }` whole percentages | `null` |
| `hex` | `null` | `null` | `#RRGGBB` |
| `swatchHex` | the client's `approximateHex`, or `null` (text only) | formula swatch | the hex |
| `swatchApproximate` | `true` with a swatch, `null` without | `true` | `false` |

### Parsing rules

- **Label**: required text, 1 to 40 characters after trimming, no control
  characters. Contact details are masked like special instructions.
- **Pantone**: an optional `Pantone`, `PMS` or `PANTONE®` prefix, then a code
  of letters, digits, spaces, `-`, `.` and `/`, at most 40 characters. A guide
  suffix run into the number is split (`185C` becomes `185 C`). Guide suffixes
  (`C`, `U`, `M`, `CP`, `UP`, `XGC`, `TCX`, `TPX`, `TPG`, `TN`, `TSX`, `HC`,
  `Q`) are upper case and words are capitalised: `warm red c` becomes
  `PANTONE Warm Red C`; `18-1663tpx` becomes `PANTONE 18-1663 TPX`. A suffix
  alone (`C`) or a six-digit hex value is refused.
- **approximateHex**: Pantone only, in the hex format below.
- **CMYK**: `{ c, m, y, k }` with JSON integers, or text: four numbers
  separated by spaces, commas, `;` or `/` (`0 100 65 34`, `0/100/65/34`),
  optionally with `%` or inside `cmyk(...)`; or lettered in any order
  (`C0 M100 Y65 K34`, `c:0 m:100 y:65 k:34`, `C=0 ...`). Each value is a whole
  number from 0 to 100. Decimals are refused, not rounded.
- **Hex**: `#RGB` or `#RRGGBB`, with or without `#`, any case. Stored as
  `#RRGGBB` upper case. Eight-digit (alpha) values are refused.

The CMYK swatch is `R = 255 × (1 − C) × (1 − K)` (likewise G with M, B with Y),
rounded. It ignores paper, ink and profiles.

### Errors

`400 invalid_color_targets` with `details.field` naming the entry and
`details.reason`:

| `reason` | `field` |
| --- | --- |
| `not_a_list`, `too_many` (more than eight) | `colorTargets` |
| `not_an_object`, `one_format_required` | `colorTargets[i]` |
| `unknown_field` | `colorTargets[i].<key>` |
| `label_required`, `label_too_long`, `label_invalid` | `colorTargets[i].label` |
| `pantone_invalid` | `colorTargets[i].pantone` |
| `cmyk_invalid` | `colorTargets[i].cmyk` |
| `hex_invalid` | `colorTargets[i].hex` or `.approximateHex` |
| `approximate_hex_not_allowed` | `colorTargets[i].approximateHex` |

A refused write changes nothing on the line.

## Client: the cart line

`POST /me/carts/:id/lines` and `PATCH /me/carts/:id/lines/:lineId` accept
`colorTargets`: a list of at most eight targets. On `PATCH` it replaces the
whole list; `[]` or `null` clears it; leaving it out keeps it.

Every cart line (`GET /me/carts/:id` and the compact line `POST`/`PATCH`/`DELETE`
responses) returns:

- `colorTargets`: the normalised list, `[]` when none.
- `artworkColors`: one entry per uploaded artwork file on the line, in the
  shape of [colours read from the file](#colours-read-from-the-file):
  `[{ "fileId": "file_…", "colors": { … } }]`. Design links have no entry.

Checkout never refuses a line for its colours. Colours are a brief for the
shop, not a gate.

## Orders: the agreed spec

Checkout copies the targets onto the order line, immutably (a database trigger
refuses later rewrites, including clearing them):

`order_line_items.color_targets = { "version": 1, "targets": [ … ] }`

Lines without colours store nothing. A later cart edit never reaches the
order.

Every order projection with `productionItems` carries per line:

- `colorTargets`: the agreed targets, `[]` when none and on older orders.
- `artworkColors`: the colours each uploaded file uses, as on the cart line.

Who sees them: the client (order and approval proof), the shop (its job, once
the artwork is released to it, as for every production item) and the GRIDGO
Team (`ops_admin`, `super_admin`: the order reads that feed the comparison).
Riders get `[]` for both.

## Colours read from the file

`POST /files` and `GET /files/:fileId` for artwork return
`file.detected.colors`, read once when the file is uploaded:

```json
{
  "version": 1,
  "status": "partial",
  "reasons": ["embedded_images_not_read"],
  "colors": [
    { "kind": "spot", "name": "PANTONE 185 C", "space": "cmyk", "cmyk": { "c": 0, "m": 91, "y": 76, "k": 6 }, "hex": "#F0163A", "uses": 3, "shareBps": null },
    { "kind": "process", "name": null, "space": "cmyk", "cmyk": { "c": 100, "m": 50, "y": 0, "k": 0 }, "hex": "#0080FF", "uses": 12, "shareBps": null },
    { "kind": "process", "name": null, "space": "rgb", "cmyk": null, "hex": "#1A5FB4", "uses": 2, "shareBps": null }
  ]
}
```

- `status`: `read` (everything the file states was read), `partial` (some of
  it was; `reasons` says what was not), or `unknown` (nothing was read;
  `colors` is `[]`). Show `unknown` as "We could not read the colours in this
  file", never as an empty palette.
- `colors[].kind`:
  - `spot`: a named spot colour the PDF declares (`/Separation`, `/DeviceN`):
    Pantone and other spot inks, and technical separations such as a cut line.
    `cmyk`/`hex` are the file's own alternate for the full tint when it states
    one as plain numbers or as simple arithmetic; otherwise `null` (show the
    name only). `uses` is how often the page selects it, `0` when declared but
    unused. Process separations (`Cyan`, `Magenta`, `Yellow`, `Black`, `All`,
    `None`) are not listed.
  - `process`: an RGB, CMYK or grey value the PDF's pages set, most used
    first. `uses` counts how often it is set, not how much area it covers.
    Paint before any colour is set is black, as PDF defines.
  - `pixels`: one of a PNG's most common colours, most common first.
    `shareBps` is its share of the opaque pixels in basis points (10000 =
    all). Pixels are grouped into 16 levels per channel and each group reports
    its average, so a flat brand colour reads back as itself. Colours under
    0.5% and fully transparent pixels are left out.
- `space`: `cmyk`, `rgb` or `gray`, or `null` for a spot colour whose
  alternate is not stated in a readable form.
- `hex` is always a screen approximation for CMYK and spot colours.
- Lists are capped: 16 spot, 12 process, 8 pixel colours.

`reasons` codes:

| Code | Meaning |
| --- | --- |
| `not_read_for_this_file_type` | JPEG, WebP, Photoshop and Word files: their pixels or pages are not decoded. |
| `not_read_at_upload` | The file was uploaded before colours were read (only in `artworkColors`; the file itself has no `colors`). |
| `embedded_images_not_read` | The PDF places pictures; their pixels are not read. |
| `colour_space_not_read` | The PDF paints with something that is not read: Lab colours, patterns and gradients, or a colour space that cannot be resolved. |
| `stream_filter_not_supported` | Page content is compressed in a way that is not decoded. |
| `content_not_readable` | The file's colour data could not be decoded. |
| `file_larger_than_inspection_window` | Only the first 16 MiB were inspected. |
| `inspection_limit` | The read stopped at its stream, byte or pixel budget (96 MiB of PNG scanlines). |
| `more_colours_than_listed` | More colours than the caps above; only the first are listed. Does not make the read partial. |
| `no_colours_declared` | A PDF whose pages set and name no colour. |
| `no_opaque_pixels`, `no_dominant_colours` | A PNG with no visible pixels, or none common enough to list. |

Files uploaded before this change have no `detected.colors` and are not read
again.

### What is read, per type

| Type | Read | Not read |
| --- | --- | --- |
| PDF | Spot colour names and alternates; RGB/CMYK/grey operators in page and form content, including colour spaces named through page resources and ICC profiles by component count; text-encoded and Flate-compressed streams, compressed object streams. | Placed images; gradients and patterns; Lab colours; LZW and other filters. |
| PNG | Every pixel (on a grid of about four million for larger images): all colour types and bit depths, palettes, transparency, interlaced files. | Colour profiles (`iCCP`, `gAMA`) are not applied. |
| JPEG, WebP, PSD, DOCX | Nothing; `status: "unknown"`. | Decoding these needs an image decoder the API does not carry. |

The read uses `node:zlib` only, adds no dependency, and never renders a page.

## Storage

Migration `1792104000000_color_targets`:

- `client_cart_lines.color_targets jsonb`: one to eight targets, each with a
  text `label` and `value` and a known `format`, or null.
- `order_line_items.color_targets jsonb`: `{ version: 1, targets }` with the
  same check, immutable once the snapshot is finalized.
- File colours live in `files.data` (`detected.colors`); no column.

The migration is forward-only.
