# Supplier catalog API

Supplier catalog items are shop-owned listings under one taxonomy-governed service line. They do not replace `GET /catalog` platform products or make a non-live service matchable. Prices and modifiers are safe integer PHP minor units.

Effective unit price is `max(0, basePriceMinor + selected modifiers)`. Matching stays on the service line.

## Public browse

Signed-in optional, same as `GET /catalog`. Invalid bearer tokens still return `401`.

- `GET /catalog/shops?categoryCode=&cursor=` lists approved shops that currently have at least one complete active item under a live service.
- `GET /catalog/shops/:supplierId` returns the shop, live service lines, and complete active items.
- `GET /catalog/items/:itemId?optionIds=` returns one public item. `fromPriceMinor` is `basePriceMinor` plus the cheapest active option in each **required spec** group. Add-on groups are not included until selected via `optionIds`. `optionIds` (repeat or comma-separated) computes `effectivePriceMinor` as `max(0, base + selected modifiers)`. Accepted formats include `inputKind` (`file` or `url`). `prepSteps` is the ordered before-they-order guide.
- `GET /catalog/media/:fileId` returns metadata for a photo or shop image that is already public.

A listing is public only when the owner has a current `supplier` membership, the supplier case is `approved`, the service is `live`, the item is active, it has a ready photo, every option group has an active option, and the effective accepted-format set is nonempty.

## Shop self-service

Requires a database `supplier` membership. Pending and rejected suppliers may edit. Nothing is public until approval + live service + complete active item.

```text
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

`POST /me/catalog-items` accepts `starterId?`, `subcategoryCode`, `pricingUnit` (`per_unit` | `per_package`), `packageQty?`, `turnaroundMode` (`inherit` | `override`), `turnaroundHours?`. A starter is copied into catalog rows at create time and is never referenced after.

Existing-record mutations require `expectedVersion` or `If-Match`. DELETE may send `If-Match` with no JSON body. Caps: 8 photos, 6 option groups, 20 options per group, 8 prep steps. Option groups have `kind` `spec` | `addon` and optional `helpText`. A group may be created with zero options; it cannot go on the board until it has an active option. Addon groups are optional. Options use integer `priceModifierMinor` and optional `specBinding` to governed fields only; a custom label with no binding is valid. Deleting an item referenced by an order snapshot archives it (`active=false`); a never-ordered item is removed.

`GET /me/catalog-items/:id` always returns `{ item }` with `item.id` and `photos[]` of `{ fileId, sortOrder, altText }` (private photos may also include a short-lived `downloadUrl`). `prepSteps` is `[{ id, sortOrder, title, body }]`.

## Formats and snapshots

Seeded file codes: `pdf`, `png`, `jpeg`, `psd`, `3mf`, `stl` (`inputKind: "file"`). Seeded URL codes: `canva_link`, `google_drive`, `dropbox`, `we_transfer`, `other_link` (`inputKind: "url"`). Service formats are defaults. Item `fileFormatMode=inherit` stores no item-format rows; `override` stores at least one active format.

`src/supplier-catalog.js` exports `createOrderLineSnapshot` and `appendOrderLineSnapshot`. They write the immutable line/option snapshot shape, including pricing unit, package qty, ready-in hours, and group kind. Checkout is not wired in this slice.
