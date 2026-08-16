# Supplier catalog API

Supplier catalog items are sellable offers beneath one taxonomy-governed supplier service. They do not replace the platform product catalog or make a non-live service matchable. PostgreSQL stores all prices and modifiers as safe integer PHP minor units.

## Public browse

- `GET /catalog/shops?categoryCode=&cursor=` lists approved suppliers that currently have at least one complete active item under a live service. `categoryCode` accepts an active canonical code or retired input alias and is resolved canonically; invalid values return `invalid_category_code`. `cursor` is opaque.
- `GET /catalog/shops/:supplierId` composes the approved shop profile, identity media references, live service lines, and complete active items.
- `GET /catalog/items/:itemId` returns one eligible item. Optional repeated or comma-separated `optionIds` query values calculate `effectivePriceMinor`; every required group must have exactly one selected option and an optional group may have zero or one.

Public items expose both `version` and `serviceVersion`. Checkout must return both as `expectedVersion` and `expectedServiceVersion` so service-derived pricing basis, turnaround, rush terms, and accepted formats cannot change behind a still-current item version.

An item publishes only when its owner still has a current database `supplier` membership, its supplier approval case is `approved`, its service is complete and `live`, it is active, it has a ready photo, every option group has an active option, and its effective accepted-format set is nonempty. Checkout rechecks the same membership and publication boundary. Effective price is `max(0, base price + selected modifiers)` using checked integer arithmetic.

Media records expose opaque API URLs and never MinIO object keys. Task F owns the `catalog_item_photo` and `supplier_shop_image` upload/attach authorization, replacement, MIME/size checks, and serving of `/catalog/media/:fileId`.

## Supplier editor

These routes require the caller's database `supplier` membership and resource ownership. Pending and rejected suppliers may edit; a suspended supplier may not.

```text
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
```

Mutations of an existing service, item, or group require `expectedVersion` in JSON or an `If-Match` header. A mismatch returns `409` with `supplier_service_stale`, `catalog_item_stale`, or `catalog_group_stale`. Changing option rows advances both the group version and owning item version. Item format inheritance changes are atomic through the item file-formats endpoint.

The compatibility `/supplier-services/:id` PATCH, submit, verify, suspend, and withdraw writers use the same service version and precondition. Responses expose the resulting `version`; a write through either route family invalidates stale writes through the other.

Attaching a `service_image` is also a service mutation. `POST /files/:fileId/attach` therefore requires the owning service's `expectedVersion` in JSON or an `If-Match` header and returns the advanced service version.

Creating an option group includes a nonempty `options` array because the deferred database invariant requires every persisted group to have an active option. Bounds are six groups per item, twenty options per group, and eight photos per item. Deleting an item referenced by an order snapshot archives it as inactive; an unreferenced item may be removed.

Turnaround, quantity, and unbounded sort-order inputs must fit PostgreSQL `integer` (`0` through `2147483647` where the field permits zero). Minor-unit prices and modifiers instead use the full signed JavaScript-safe range supported by `money_minor`, subject to each field's nonnegative constraint.

Service lines use `draft` while incomplete and `pending_verification` when review-ready. Both self-service state changes and compatibility submit/verify actions reject incomplete lines with `service_not_review_ready`. Suspended and withdrawn complete lines may be resubmitted to `pending_verification`; suppliers cannot make a line live. A live line returns to `pending_verification` when the supplier expands its governed category or accepted formats. Routine catalog, price, and option edits remain immediately derived from approval + live-service eligibility.

Readiness-owning edits must leave `pending_verification`, `live`, and `suspended` lines complete. In particular, replacing service formats with an empty effective set returns `service_not_review_ready` without changing formats, state, or version. A supplier must first move the line to `draft` or `withdrawn` before making it incomplete, then complete and resubmit it for approval.

## Format inheritance and readiness

`accepted_file_formats` is the governed registry. Service formats are defaults. An item in `inherit` mode stores no item-format rows; an item in `override` mode stores at least one active format. The seeded codes are `pdf`, `png`, `jpeg`, `psd`, `canva_link`, `3mf`, and `stl`; Canva is a URL input kind.

`GET /me/supplier-readiness` and `/auth/me/supplier` return the same catalog readiness projection. It identifies profile, payment-term integration, review-ready service, complete active item, item-specific, shop-media, and pickup-mode blockers, plus the service IDs eligible for the next approval-driven publish or restore. Supplier payment terms are owned by task H; until that schema is integrated, `supplier_payment_terms` remains an explicit blocker.

An already-approved supplier remains grandfathered ready. The full projection applies again when its approval is reopened or an approver reviews a new or resubmitted line, so the next approval-relevant transition consumes the new requirements without retroactively invalidating an existing approval. Account suspension does not run readiness; restore republishes only complete lines suspended by that account case and does not clear an independent line suspension.

## Immutable checkout snapshots

`src/supplier-catalog.js` exports `createOrderLineSnapshot` and `appendOrderLineSnapshot` for the later quote/order integration. The helper requires the selected item and service versions, revalidates current approval, service, item, formats, option cardinality, modifier arithmetic, and specification bindings, then writes the unchanged section-7 line and option snapshot shape. Database triggers recheck line math and prevent mutation of snapshot values while allowing source foreign keys to become null if catalog records are retired.
