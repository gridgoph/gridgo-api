# Artwork guidance API

Resolution and colour mode are **warnings, never blocks**. A file that cannot
be read (truncated, encrypted, corrupt) is still refused at checkout with
`409 artwork_file_check_failed`, unchanged from the structural check in
[STORAGE_API.md](STORAGE_API.md). Every other file goes through. When it is
softer than the product type recommends or RGB where the product type expects
CMYK, the client either uploads a better file or accepts the warning. The
acceptance is stored with the order line, and the GRIDGO Team quality check and
the client's proof screen both read it.

Source: `src/artwork-guidance.js`. Colour detection: `src/artwork-inspection.js`.

## Before this change

No API path refused an upload or an order for resolution or colour mode. The
API read pixels and declared density (`file.detected`), the structural check
refused only unreadable files, and checkout accepted any file that passed that
check. The reported 300 DPI block was not in the API.

## Per product type targets (settings)

`GET /settings` (any signed-in role) now includes `settings.artworkGuidance`:

```json
{
  "version": 1,
  "default": { "minimumDpi": 300, "acceptsRgb": false },
  "subcategories": {
    "flyers": { "minimumDpi": 300, "acceptsRgb": false },
    "posters_standees": { "minimumDpi": 200, "acceptsRgb": false },
    "custom_apparel": { "minimumDpi": 150, "acceptsRgb": true },
    "tarpaulins_outdoor_banners": { "minimumDpi": 100, "acceptsRgb": false },
    "three_d_printing_scale_models": { "minimumDpi": null, "acceptsRgb": true }
  }
}
```

(The real value has one entry for each shipped product type; see the mapping below.)

- Keys are taxonomy **subcategory** codes, the same as `listing.subcategoryCode`.
  A product type without an entry uses `default`.
- `minimumDpi` is the recommended resolution **at the ordered size**: a whole
  number from 50 to 1200, or `null` for no resolution check.
- `acceptsRgb: false` means the product type expects CMYK and an RGB file gets a
  warning. `true` means RGB is fine.

Super Admin edits it through the existing handshake:
`PATCH /settings { "expectedVersion": n, "reason": "…", "artworkGuidance": {…} }`.
Send the whole value. A GRIDGO Team (`ops_admin`) account gets `403 forbidden`, a stale version gets
`409 settings_version_conflict`, and the change is audited as
`settings.operational_update` and bumps `version`. Errors:
`400 invalid_artwork_guidance` (bad shape or range, `field` names the entry) and
`400 unknown_artwork_guidance_subcategory` (the code is not in the taxonomy).
A settings write that omits `artworkGuidance` keeps the current value.
A print job that is named in `artworkGuidance.subcategories` cannot be deleted
(`409 catalog_entry_in_use`, `usage.artworkGuidance`). Remove its entry first.

### Starting values and mapping

Migration `1792093000000_artwork_guidance` writes these values (and bumps the
settings version) when no value is stored yet:

| Issue group | Subcategory codes | `minimumDpi` | `acceptsRgb` |
| --- | --- | --- | --- |
| Documents and flyers | `document_printing`, `booklets`, `risograph`, `binding_hardbound`, `id_photos`, `flyers`, `brochures`, `business_cards` | 300 | false |
| Posters | `posters_standees` | 200 | false |
| Apparel | `custom_apparel` | 150 | **true** |
| Tarpaulins and large format | `tarpaulins_outdoor_banners`, `business_store_signages`, `blueprint_cad_plotting` | 100 | false |
| Paper, stickers and keepsakes (default) | `stickers_packaging_labels`, `certificates_diplomas`, `corporate_giveaways`, `drinkware`, `lanyards_id_accessories`, `plaques_trophies`, `medals_ribbons`, `packaging_box_production` | 300 | false |
| 3D model files | `three_d_printing_scale_models` | null | true |
| Anything added later | `default` | 300 | false |

Apparel accepts RGB until the apparel partner shops say otherwise. Super Admin
can change that with `acceptsRgb: false`.

## Detected colour mode on the file read

`POST /files` and `GET /files/:fileId` return the file's `detected` block for
artwork. It has a new `colorMode` field:

| `colorMode` | Meaning |
| --- | --- |
| `rgb` | PNG (any colour type except grey), JPEG with 3 components, WebP, PSD RGB/indexed, a PDF that names only RGB colour spaces |
| `cmyk` | JPEG with 4 components, PSD CMYK, a PDF that names only CMYK colour spaces (or a 4-component ICC profile) |
| `grayscale` | Grey PNG/JPEG/PSD, a PDF that names only grey |
| `mixed` | A PDF that names both RGB and CMYK colour spaces |
| `null` | Not stated: Word documents, and PDFs that name no colour space |

WebP and PSD artwork now also reports `pixelWidth`/`pixelHeight` (and PSD its
declared density), so their resolution can be judged as well.

The file read does not know the ordered size, so effective DPI is on the cart
line and the order line, not on the file.

## Cart line evaluation

Every cart line in `GET /me/carts/:id` (and in the compact responses of the line
`POST`/`PATCH`/`DELETE`) carries `artworkGuidance`:

```json
{
  "subcategoryCode": "tarpaulins_outdoor_banners",
  "minimumDpi": 100,
  "acceptsRgb": false,
  "expectedColorMode": "cmyk",
  "orderedSize": { "widthMilli": 914400, "heightMilli": 1828800 },
  "files": [{
    "fileId": "file_…",
    "colorMode": "rgb",
    "pixelWidth": 1200,
    "pixelHeight": 2400,
    "effectiveDpi": 33,
    "warnings": [
      { "code": "low_resolution", "effectiveDpi": 33, "minimumDpi": 100, "acceptedAt": null },
      { "code": "color_mode", "colorMode": "rgb", "expectedColorMode": "cmyk", "acceptedAt": null }
    ]
  }],
  "openWarningCount": 2
}
```

- `orderedSize` is in thousandths of a millimetre. It comes, in order, from a
  measured line (`measurement.width`/`height` in the listing's `measureUnit`),
  then a selected size option (its size spec binding or its label, for example
  `A5`, `90x50 mm`, `3 x 6 ft`, or `Standard` for business cards), then
  `structuredSpec.size`/`dimensions`. `null` when none of these gives a size.
- `effectiveDpi` uses the limiting side (long side against long side). It is
  never the density the file declares. It is `null` without pixels (PDF, Word)
  or without an ordered size, and then there is no resolution warning.
- `low_resolution` appears when `effectiveDpi < minimumDpi`. `color_mode`
  appears when `acceptsRgb` is false and `colorMode` is `rgb` or `mixed`.
- Only uploaded files are judged. Design links are not in `files`.
- The app can show the guidance before any upload by reading
  `settings.artworkGuidance` for the listing's `subcategoryCode`.

### Accepting warnings

`PUT /me/carts/:cartId/lines/:lineId/artwork-warnings` (the owning client):

```json
{ "accept": [{ "fileId": "file_…", "code": "low_resolution" }, { "fileId": "file_…", "code": "color_mode" }] }
```

- Replaces the line's acceptances. `{ "accept": [] }` withdraws them all.
- Every entry must name a warning the line has **now**. Otherwise the API
  returns `409 artwork_warning_not_found` and the app should refresh.
  Unknown codes or a bad body return `400 invalid_artwork_warning_acceptance`.
- The server stores the figures it showed (`effectiveDpi`/`minimumDpi`, or
  `colorMode`/`expectedColorMode`) and `acceptedAt`. Sending the same
  acceptance again keeps the first `acceptedAt`.
- An acceptance covers a warning only while the file and the figure are the
  same. If the client picks a larger size so the DPI drops, or replaces the
  file, that warning shows again with `acceptedAt: null`.
- Responds `200 { cart }` with the compact line projection.

Checkout never refuses a line for an open warning. Released app builds that do
not ask still place orders, and the order record shows the warning as not
accepted.

## Order line record (QA check and proof)

At checkout each order line with uploaded files stores an immutable
`artworkGuidance` record. It has the cart evaluation at that moment plus
`version: 1` and `evaluatedAt`, and each warning keeps its `acceptedAt` (or
`null`). A database trigger refuses any later change. Later settings edits
never rewrite it. Orders placed before this change have `null`.

It is returned as `productionItems[].artworkGuidance` on every order read for:

- **GRIDGO Team** (ops/Super Admin): the quality check reads the order with
  `fileCheck` and these records.
- **Client**: the same order read the proof approval screen uses.
- **Shop**: once the artwork is released to it, as for every production item.

Riders get `null`.

## Fault and reprints

The API has no automatic reprint or supplier-fault logic. Claims, issues and
refund fault (`clientCaused`) are decided by staff. The stored acceptance is the
evidence for that decision. A print that is blurry or off-colour because of an
accepted warning is not a supplier fault and is not covered by the free reprint
promise. This API adds no new refund rule.
