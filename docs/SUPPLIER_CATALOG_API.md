# Supplier catalog API

See [client catalogue privacy](CLIENT_CATALOG_PRIVACY.md) for additive GRIDGO
price fields, signed-in `/ops/catalog/*` and `/me/catalog-preview` reads, and the
staged removal of legacy public shop prices/identity. Phase 1 keeps existing
responses compatible; new clients should use the client fields and quotes.

Supplier catalog items are shop-owned listings under one taxonomy-governed service line. They do not replace `GET /catalog` platform products or make a non-live service matchable. Prices and modifiers are safe integer PHP minor units.

Effective unit price is `max(0, basePriceMinor + selected modifiers)`. Matching stays on the service line.

## Public browse

Signed-in optional, same as `GET /catalog`. Invalid bearer tokens still return `401`.

- `GET /accepted-file-formats?q=` returns the platform registry a listing may tick (`code`, `displayName`, `inputKind`, `extensions`, `mimeTypes`, `aliases`, `uploadable`). `uploadable` is true only for file types `POST /files` purpose=artwork can sniff (JPEG, PNG, WebP, PDF, Photoshop). 3MF/STL stay in the registry with `uploadable: false`. Optional `q` (1–40 characters) adds `resolution`: `matched` ticks that code, `link_only` / `unknown` tell the shop to tick Any other https link. A shop cannot invent a code.
- `GET /catalog/shops?categoryCode=&cursor=` lists approved shops that currently have at least one complete active item under a live service.
- `GET /catalog/shops/:supplierId` returns the shop, live service lines, and complete active items.
- `GET /catalog/items/:itemId?optionIds=` returns one public item. `fromPriceMinor` is `basePriceMinor` plus the cheapest active option in each **required spec** group. Add-on groups are not included until selected via `optionIds`. `optionIds` (repeat or comma-separated) computes `effectivePriceMinor` as `max(0, base + selected modifiers)`. `fromPriceMinor` / `effectivePriceMinor` stay the shop amounts. Client-facing GRIDGO amounts (shop + live `serviceFeeRateBps`) are additive: `clientFromPriceMinor`, `clientEffectivePriceMinor`. Supplier `/me/catalog-items` is unchanged. Accepted formats include `inputKind` (`file` or `url`). `prepSteps` is the ordered before-they-order guide.
- `GET /catalog/media/:fileId` returns metadata for a photo or shop image that is already public.

A listing is public only when the owner has a current `supplier` membership, the supplier case is `approved`, the service is `live`, the item is active, it has a ready photo, every option group has an active option, the effective accepted-format set is nonempty, and a `tarpaulins_outdoor_banners` listing has `printerMaxWidthFeet`.

## Shop self-service

Requires a database `supplier` membership. Pending and rejected suppliers may edit. Nothing is public until approval + live service + complete active item.

```text
GET                    /accepted-file-formats?q=
GET                    /listing-starters?subcategoryCode=
GET, PATCH             /me/supplier-profile
GET, PATCH             /me/supplier-payment-terms
GET, POST              /me/supplier-services
GET, PATCH, DELETE     /me/supplier-services/:id
PUT                    /me/supplier-services/:id/file-formats
GET, PUT               /me/supplier-services/:id/pricing
GET, POST              /me/catalog-items
GET, PATCH, DELETE     /me/catalog-items/:id
PUT                    /me/catalog-items/:id/file-formats
POST                   /me/catalog-items/:id/option-groups
PATCH, DELETE          /me/catalog-items/:id/option-groups/:groupId
POST                   /me/catalog-option-groups/:groupId/options
PATCH, DELETE          /me/catalog-option-groups/:groupId/options/:optionId
POST                   /me/catalog-items/:id/photos/reorder
GET, POST              /me/catalog-items/:id/prep-steps
PATCH, DELETE          /me/catalog-items/:id/prep-steps/:stepId
POST                   /me/catalog-items/:id/prep-steps/reorder
GET                    /me/supplier-readiness
POST /files            purpose=catalog_item_photo | supplier_shop_image
POST /files/:fileId/attach
```

`GET /me/supplier-profile` returns `{ profile }` with `userId`, `shopName`, `contactName`, `shop`, `pickupAvailable`, `phone`, `email`, `version`, `updatedAt`, and `media[]`. `phone` and `email` are the signed-in account's, not the shop record's; `phone` is `null` until a number is stored.

`PATCH /me/supplier-profile` accepts `shopName`, `contactName`, `shop`, `pickupAvailable`, and `phone`, and answers with the same shape as the read. Saving `shopName` also writes `users.supplierName`, which is the field `GET /auth/me` → `publicUser` already exposes to Account. A shop-name-only or phone-only edit still bumps `version` and `updatedAt`. Phone accepts `09XXXXXXXXX`, `639XXXXXXXXX`, and `+639XXXXXXXXX`, tolerating spaces, dashes, and parentheses, and is stored canonically as `+639XXXXXXXXX`. Anything else, including a blank number, is `400 invalid_supplier_profile` with `field: "phone"` and persists nothing. Numbers captured at enrollment are left exactly as they were stored. Email belongs to the GRIDGO sign-in, so sending `email` is `400 email_not_editable`. Clerk identity copy may refresh the account email from Clerk's primary address and will not steal an address already on another GRIDGO user.

`GET /me/catalog-items` lists **this shop’s** listings only. Hunt does not make a listing matchable and does not change `GET /catalog` or `GET /catalog/shops`. Matching stays on the live service line.

Query params:

| Param | Meaning |
|---|---|
| `q` | Optional hunt string. Trimmed; blank/whitespace is the same as omitting it. 1–80 characters. Longer values or a NUL byte are `400 invalid_catalog_query`. |
| `subcategoryCode` | Standing kind-of-work filter. Intersects `q`. |
| `active` | `true` or `false`. On-the-board vs hidden. Intersects `q`. Other values are `400 invalid_catalog_item`. |
| `sort` | `board` (default, `sort_order, id`), `name` (`lower(name), id`), `price_low`, `price_high`, `fastest` (override hours then inherited service hours). Invalid `sort` is `400 invalid_catalog_query`. With `q`, rank is applied first, then this sort, then `id`. |
| `limit` | Page size. Default 20, max 50. |
| `cursor` | Opaque `base64url(JSON.stringify({ k, id }))` from a previous `nextCursor`. Invalid cursors are `400 invalid_cursor`. |

`q` is ranked in PostgreSQL (`websearch_to_tsquery('simple')` on `search_tsv`, then `pg_trgm` / `ILIKE` fallback for prefixes such as `tarp`). The search document is the listing name, description, subcategory label, option labels, and prep-step titles. It is shop-scoped: another shop’s listings never appear.

Response (additive):

```json
{
  "items": [ /* privateCatalogItem[] */ ],
  "nextCursor": "… omitted when this is the last page",
  "total": 12
}
```

`total` is the filtered count (same predicates as the page, no rank). `GET /catalog/shops` does not accept `q` in this slice.

`POST /me/catalog-items` accepts `starterId?`, `subcategoryCode`, `pricingUnit` (`per_unit` | `per_package`), `packageQty?`, `turnaroundMode` (`inherit` | `override`), `turnaroundHours?`, `minimumTurnaroundHours?`, `printerMaxWidthFeet?`. A starter is copied into catalog rows at create time and is never referenced after. `minimumTurnaroundHours` is the soonest the listing can be ready; `turnaroundHours` is the promised ready-in. On inherit both are null. A soonest later than the promise is `400 invalid_catalog_item`.

`POST /me/catalog-items/:id/photos/reorder` takes `fileIds` of the samples that stay, in board order. A shorter list drops the missing photos and unreferences those files. Every sent id must already be on the listing; an unknown id is `409 catalog_item_stale`.

### Printer max width (`printerMaxWidthFeet`)

Integer feet, 1–20 inclusive. SQL column `printer_max_width_feet` on `supplier_catalog_items`. This is the shop's printing-machine cap, not `minimumWidthMilli` (the smallest billable size).

- Required on create, and on any mutation that would put a `tarpaulins_outdoor_banners` listing on the board. Missing, null, non-integer, or out of range is `400 printer_cap_required` with `field: "printerMaxWidthFeet"`.
- On every other subcategory the field must be `null`. Sending a non-null value is `400 printer_cap_not_applicable`.
- Private and public listing projections include `printerMaxWidthFeet` (`null` when the listing is not tarpaulin).
- A tarpaulin listing is not complete and not public without it.
- Matching and cart: if the request or line has a width in feet (structured spec, selected size option, measurement, or an existing size field already on the line), the listing is ineligible when requested width > `printerMaxWidthFeet`. If no width is present, the line is not newly failed.

Existing-record mutations require `expectedVersion` or `If-Match`. DELETE may send `If-Match` with no JSON body. Caps: 8 photos, 6 option groups, 20 options per group, 8 prep steps. Option groups have `kind` `spec` | `addon` and optional `helpText`. A group may be created with zero options; it cannot go on the board until it has an active option. Addon groups are optional. Options use integer `priceModifierMinor` and optional `specBinding` to governed fields only; a custom label with no binding is valid. Deleting an item referenced by an order snapshot archives it (`active=false`); a never-ordered item is removed.

`GET /me/catalog-items/:id` always returns `{ item }` with `item.id` and `photos[]` of `{ fileId, sortOrder, altText }` (private photos may also include a short-lived `downloadUrl`). `prepSteps` is `[{ id, sortOrder, title, body }]`.

## Supplier readiness diagnostics

`GET /me/supplier-readiness` is supplier-only and reads the caller's shop. It does not change approval, listing publication or matching eligibility. The original `readyForApproval`, string `missing[]`, and `publishableServiceIds` fields retain their exact setup-check semantics. `/auth/me/supplier` and Operations approval readiness are unchanged.

Use **`operational.ready`** for whether at least one listing passes the shop and public-listing gates. Use each `operational.listings[].ready` for that listing's standing. Do not label a matchable shop “Not ready” using `readyForApproval` or `profileCompletion.complete`: setup requirements include a shop image and service-default formats, while matching permits listing-format overrides and does not require a shop image.

```json
{
  "readyForApproval": false,
  "missing": ["review_ready_service_line", "shop_identity_image"],
  "publishableServiceIds": [],
  "operational": {
    "ready": true,
    "missing": [],
    "listings": [{ "catalogItemId": "item_example", "ready": true, "missing": [] }]
  },
  "profileCompletion": {
    "complete": false,
    "missing": [
      { "code": "review_ready_service_line", "message": "Complete at least one live or submitted service line with pricing, turnaround and default artwork formats.", "action": "edit_services" },
      { "code": "shop_identity_image", "message": "Upload a shop identity image to complete your shop setup.", "action": "upload_shop_image" }
    ],
    "services": [{ "supplierServiceId": "service_example", "missing": [
      { "code": "service_default_formats", "message": "Choose default artwork formats for this service line to complete setup. Listings may use their own formats for matching.", "action": "edit_service_formats" }
    ] }]
  },
  "requestEligibility": { "evaluated": false, "input": null, "listings": [] }
}
```

All new `missing[]` entries have `{code,message,action}`. Render every entry; `action` is a stable app navigation/action key, not an API URL. An `option_group` entry also has `optionGroupId`. Listing entries include shop blockers as well as their own blockers. The shop-level list includes `no_matchable_listing` if no listing passes; inspect the listing entries for all concrete fixes. An empty board also returns this code. Other incomplete/hidden listings do not block a shop with at least one eligible listing. `profileCompletion.services[]` explains every service's setup gaps, including optional unfinished lines even when another line already satisfies the setup checklist.

### Request-specific checks

Optional query parameters: `deadline` (ISO date/time with offset), `units` (positive safe integer), `widthFeet` (positive finite number). For example:

```text
GET /me/supplier-readiness?deadline=2026-11-10T15:59:59Z&units=100&widthFeet=6
```

With any of these supplied, `requestEligibility` has `evaluated:true`, normalized `input`, and one result per owned listing. Operationally blocked listings have `{catalogItemId,evaluated:false,eligible:null,missing:[]}`; their blockers remain in `operational`. Checked listings have `{catalogItemId,evaluated:true,eligible,missing}` and, when scheduling succeeds, `projection:{startsAt,readyBy,limitedBy,capacityDays,jobsAhead}`. `readyBy` is the shop's own ready time; the padded client promise is never returned to the supplier. `limitedBy` is `capacity | turnaround`.

Request checks reuse matching's printer-width and queue/calendar projection, including default opening hours, closures, live-service daily capacity, turnaround and platform allowance. A missed deadline is a request failure, never a setup failure. Quantity capacity can delay a promise; it is not a new standalone maximum-quantity gate. A bounded calendar that cannot fit the work returns `shop_never_open` on that listing, without hiding diagnostics for other listings. Without a deadline there is no deadline filter; without a width there is no width filter.

This is a supplier diagnostic preview, not a match or reservation. `operational.ready` means the static shop/public-listing gates pass, not that every request will match. The client's selected active subcategory, width (including structured specs/options), deadline, exclusions, and ranking still determine actual results. Zone remains a ranking/pricing input, not a new readiness gate. Neither endpoint writes state. Invalid numeric input returns `400 invalid_readiness_request` with `field`; invalid deadline returns `400 invalid_deadline`. Existing authentication/account holds still apply before the route.

### Missing-step codes

The following is the complete new structured-code vocabulary. The legacy top-level `missing` remains strings.

| Code | Plain-English message | Action |
|---|---|---|
| `account_inactive` | Your account is not active. | `contact_operations` |
| `supplier_profile` | Complete your shop profile. | `edit_profile` |
| `shop_name` | Add your shop name. | `edit_profile` |
| `contact_name` | Add your shop contact name. | `edit_profile` |
| `shop_location` | Set your shop pickup location. | `edit_profile` |
| `shop_closed` | Your shop is marked closed for new work. | `open_shop` |
| `supplier_membership` | This account has no supplier membership. | `contact_operations` |
| `supplier_not_approved` | Your shop needs Operations approval before clients can match with it. | `view_approval` |
| `no_matchable_listing` | No listing is eligible for matching. Complete the steps listed for your listings, or add a listing. | `edit_listings` |
| `owning_service` | This listing needs a service line belonging to your shop. | `edit_listing` |
| `name` | Add a listing name. | `edit_listing` |
| `base_price` | Set a valid non-negative listing price. | `edit_listing` |
| `subcategory` | Choose a listing subcategory. | `edit_listing` |
| `printer_max_width_feet` | Set the printer maximum width to a whole number from 1 to 20 feet. | `edit_listing` |
| `accepted_file_formats` | Choose accepted artwork formats on this listing or its service line. | `edit_listing_formats` |
| `photo` | Attach at least one fully uploaded listing photo. | `upload_listing_photo` |
| `option_group` | Add or enable at least one option in this option group, or remove the group. | `edit_listing_options` |
| `item_inactive` | This listing is hidden. Make it active to offer it to clients. | `activate_listing` |
| `service_not_live` | The parent service line is not live. Operations must approve or restore it before this listing can match. | `view_service` |
| `pickup_payment_terms` | Enable an available pickup payment option. | `edit_payment_terms` |
| `review_ready_service_line` | Complete at least one live or submitted service line with pricing, turnaround and default artwork formats. | `edit_services` |
| `complete_catalog_item` | Complete and activate at least one listing. | `edit_listings` |
| `shop_identity_image` | Upload a shop identity image to complete your shop setup. | `upload_shop_image` |
| `service_not_submitted` | Submit this service line for review or ask Operations about its status. | `view_service` |
| `pricing_basis` | Set the pricing basis for this service line. | `edit_service` |
| `turnaround` | Set a positive whole-number turnaround for this service line. | `edit_service` |
| `service_default_formats` | Choose default artwork formats for this service line to complete setup. Listings may use their own formats for matching. | `edit_service_formats` |
| `printer_capacity_exceeded` | The requested width exceeds this listing's printer maximum width. | `choose_smaller_width` |
| `deadline_not_met` | This listing cannot meet the selected deadline with the current queue, opening hours, turnaround and quantity capacity. | `choose_later_deadline` |
| `shop_never_open` | The schedule cannot fit this work within the scheduling horizon. Review opening hours, closures and requested quantity. | `review_schedule` |

Shop gates use `account_inactive`, `supplier_profile`, `shop_location`, `shop_closed`, `supplier_membership`, `supplier_not_approved`, and the aggregate `no_matchable_listing`. Listing gates use `owning_service` through `service_not_live` in the table, plus inherited shop gates. Profile completion uses the legacy setup codes plus `shop_name`, `contact_name`, and `shop_location`; per-service setup uses `service_not_submitted`, `pricing_basis`, `turnaround`, and `service_default_formats`. Only request results use `printer_capacity_exceeded`, `deadline_not_met`, and `shop_never_open`.

## Formats and snapshots

Seeded file codes: `pdf`, `png`, `jpeg`, `webp`, `psd`, `3mf`, `stl` (`inputKind: "file"`). Seeded URL codes: `canva_link`, `google_drive`, `dropbox`, `we_transfer`, `other_link` (`inputKind: "url"`). Service formats are defaults. Item `fileFormatMode=inherit` stores no item-format rows; `override` stores at least one active format. A plus-finder query resolves against this registry and its aliases; it never stores a shop-invented type.

`src/supplier-catalog.js` exports `createOrderLineSnapshot` and `appendOrderLineSnapshot`. They write the immutable line/option snapshot shape, including pricing unit, package qty, ready-in hours, and group kind. Checkout is not wired in this slice.

## Staff listing index and take-down

`GET /ops/catalog-items` and `GET /ops/catalog-items/:id` are readable only by Operations and Super Admin. The index returns `{ items: [{ shop: { supplierId, shopName }, item }], shops, total, nextCursor? }`; the detail returns `{ shop, item }`. Each private item includes prices and units, specs, photos, the shop's `active` switch, version and timestamps. These staff projections are never exposed to clients.

The index accepts `q` (trimmed, at most 80 characters), `subcategoryCode`, `supplierId`, `minPriceMinor`, `maxPriceMinor`, `limit` (1–50, default 50) and an opaque `cursor`. Prices are integer PHP minor units; invalid filters return `400 invalid_catalog_query`. Missing detail items return `404 catalog_item_not_found`. Photos use the same signed download decoration as the supplier catalogue.

Only Super Admin may call either action; Operations, suppliers, riders and clients receive `403 forbidden`:

- `POST /catalog-items/:id/suspend` with `{ "reason": "Correct the listing sample" }` takes one listing off the client board. The trimmed reason is required (`400 reason_required`) and capped at 2,000 characters (`400 reason_too_long`). It sets `active=false`, records the reason, timestamp and actor, and bumps the version. Repeating a take-down returns `409 listing_suspended` without replacing the reason, changing the version, or sending another notice. Sibling listings and the service line are unchanged.
- `POST /catalog-items/:id/restore` clears the take-down fields and bumps the version, but **leaves `active=false`**. The shop decides when to put it back on the board using its ordinary versioned `PATCH /me/catalog-items/:id`. A listing without a take-down returns `409 listing_not_suspended`.

Private listing detail, the staff index, and `GET /me/catalog-items` (including PostgreSQL search and pagination) carry `suspendReason` and `suspendedAt`, both null when there is no take-down. While a reason is set, the shop cannot PATCH `active=true`: the API returns `409 listing_suspended` with the reason. Taken-down listings cannot appear on the client board or in matching.

Each successful action commits the item, audit (`catalog_item.suspend` or `catalog_item.restore`, entity type `supplier_catalog_item`) and shop inbox notice together. `listing_suspended` tells the owning shop the reason. `listing_restored` tells it the take-down is lifted and the listing remains hidden until the shop turns it on. Both notices carry `catalogItemId`, use the supplier role, and invalidate the shop's notifications and catalogue after commit. Push data retains its existing privacy allowlist.
