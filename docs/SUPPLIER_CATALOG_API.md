# Supplier catalog API

Supplier catalog items are shop-owned listings under one taxonomy-governed service line. They do not replace `GET /catalog` platform products or make a non-live service matchable. Prices and modifiers are safe integer PHP minor units.

Effective unit price is `max(0, basePriceMinor + selected modifiers)`. Matching stays on the service line.

## Public browse

Signed-in optional, same as `GET /catalog`. Invalid bearer tokens still return `401`.

- `GET /catalog/shops?categoryCode=&cursor=` lists approved shops that currently have at least one complete active item under a live service.
- `GET /catalog/shops/:supplierId` returns the shop, live service lines, and complete active items.
- `GET /catalog/items/:itemId?optionIds=` returns one public item. `fromPriceMinor` is the cheapest valid selection. `optionIds` (repeat or comma-separated) computes `effectivePriceMinor`.
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
GET                    /me/supplier-readiness
POST /files            purpose=catalog_item_photo | supplier_shop_image
POST /files/:fileId/attach
```

`GET /me/catalog-items` accepts `?subcategoryCode=` and `?active=true|false`.

`POST /me/catalog-items` accepts `starterId?`, `subcategoryCode`, `pricingUnit` (`per_unit` | `per_package`), `packageQty?`, `turnaroundMode` (`inherit` | `override`), `turnaroundHours?`. A starter is copied into catalog rows at create time and is never referenced after.

Existing-record mutations require `expectedVersion` or `If-Match`. Caps: 8 photos, 6 option groups, 20 options per group. Option groups have `kind` `spec` | `addon` and optional `helpText`. Addon groups are optional. Options use integer `priceModifierMinor` and optional `specBinding` to governed fields only; a custom label with no binding is valid. Deleting an item referenced by an order snapshot archives it (`active=false`).

## Formats and snapshots

Seeded codes: `pdf`, `png`, `jpeg`, `psd`, `canva_link`, `3mf`, `stl`. Service formats are defaults. Item `fileFormatMode=inherit` stores no item-format rows; `override` stores at least one active format.

`src/supplier-catalog.js` exports `createOrderLineSnapshot` and `appendOrderLineSnapshot`. They write the immutable line/option snapshot shape, including pricing unit, package qty, ready-in hours, and group kind. Checkout is not wired in this slice.
