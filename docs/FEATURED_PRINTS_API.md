# Featured Prints

The client Home row is **FEATURED PRINTS**: GRIDGO-curated catalogue products,
never live/recent orders or customer artwork. This API supplies the dashboard
setting and client Home follow-ups for gridgoph/gridgo-client issue 239.

## Public Home read

`GET /featured-prints` requires no session and returns `Cache-Control: no-store`:

```json
{
  "title": "FEATURED PRINTS",
  "items": [{
    "id": "sci_flyer",
    "name": "Flyers",
    "categoryCode": "marketing_collateral",
    "subcategoryCode": "flyers",
    "clientFromPriceMinor": 1100,
    "pricingUnit": "per_unit",
    "packageQty": null,
    "measureUnit": null,
    "minimumOrderQuantity": null,
    "photos": [{
      "fileId": "file_sample",
      "sortOrder": 0,
      "url": "/catalog/media/file_sample",
      "downloadUrl": "https://storage.example/signed-sample",
      "downloadUrlExpiresAt": "2026-10-15T00:05:00.000Z"
    }]
  }],
  "emptyState": null
}
```

Render `clientFromPriceMinor` as the PHP starting price, in integer centavos,
with the appropriate unit/package label. It is the approved catalogue starting
amount with GRIDGO's current service fee included, using the existing catalogue
arithmetic. Delivery, selections, dimensions, quantity and any account discount
are resolved by the normal authenticated quote/checkout flow. Do not add another
service fee to this figure or treat it as a complete order quote.

Display the first photo's `downloadUrl`; `url` is metadata, not image bytes.
Refetch when the signed URL expires. If signing is temporarily unavailable,
`downloadUrl` and its expiry are omitted: show a neutral sample placeholder.
Only a ready, approved catalogue sample can appear; no order photo is consulted.

Cards deliberately omit shop ID/name/logo, supplier/service identity, contact or
location, ratings, descriptions, photo alt text/filename, raw supplier prices,
review metadata and order details. Both the outer card and nested photo use an
allowlist. Product names and sample image content remain staff-reviewed catalogue
content: curators must avoid branded samples or names that identify the shop.
The catalogue item ID is for product selection, not for revealing a shop on Home;
use the normal authenticated catalogue/matching flow after the user chooses to
start a print. Do not fetch shop profiles to decorate these cards.

Items retain staff order, with unavailable selections omitted on every read.
Eligibility uses the approved catalogue view (including the last approved
snapshot while a sensitive revision is pending/rejected), catalogue public
checks, and the shared supplier availability gates. Hidden/taken-down listings,
non-live services, unapproved suppliers, inactive accounts, closed shops,
missing profiles/locations, missing ready samples, and deleted/unapproved
products do not appear. This is discovery, not a deadline/capacity promise.

If nothing is configured or no configured product is currently eligible:

```json
{
  "title": "FEATURED PRINTS",
  "items": [],
  "emptyState": {
    "action": "browse_catalog",
    "message": "Explore print products to start your first print."
  }
}
```

The client should show that neutral prompt linking to its catalogue (or omit the
empty carousel while retaining its existing first-print action). Never fall back
to recent orders, a live feed or automatically ranked shops. An API failure also
uses a neutral placeholder/prompt, not orders. Refresh on Home focus and catalogue
invalidations; no anonymous realtime subscription is required.

## Dashboard curation

Operations and Super Admin memberships may read and replace this catalogue
configuration. Other memberships receive `403`; no session receives `401`.
This exception is scoped to these endpoints: `PATCH /settings` remains Super
Admin only and cannot write this configuration.

`GET /admin/featured-prints`:

```json
{
  "version": 1,
  "catalogItemIds": [],
  "items": []
}
```

For configured selections `items` contains ordered rows
`{catalogItemId, available, item}`. `item` is the same anonymous card as the Home
read, or `null` if unavailable. The original IDs/order remain so staff can remove
stale selections. Both read and write responses sign available sample photos.

Use the existing staff `GET /ops/catalog-items` search/pagination to find candidates
(see [supplier catalogue](SUPPLIER_CATALOG_API.md#staff-listing-index-and-take-down)).
The staff index includes private draft values and shop metadata. Use its IDs
for search, and authenticated `GET /catalog/items/:id` for the approved product
preview and `client*` prices (a 404 means no publicly available approved item).
Render only product details, client prices and sample photos in this setting;
do not render the index’s shop metadata or draft prices. Save-time
eligibility is authoritative; drafts without an approved snapshot cannot be
selected. Unsaved reorder changes stay local until Save.

`PUT /admin/featured-prints` replaces the entire ordered list:

```json
{
  "expectedVersion": 1,
  "catalogItemIds": ["sci_flyer", "sci_card"],
  "reason": "Refresh Home samples for the new season"
}
```

The list allows 0–20 distinct string IDs; an empty list clears it. A trimmed
reason of 1–2000 characters and positive integer `expectedVersion` are required.
Success is `200` with the same shape as the staff GET and an incremented version.
Every accepted save, including an identical list, increments the version and
records `catalog.featured_prints_update` with actor, reason, previous and current
configuration. Current Operations and Super Admin memberships receive a durable
inbox notice (no push); catalogue invalidations are queued before save.

| Error | Meaning |
| --- | --- |
| `400 featured_prints_version_required` | Missing/invalid `expectedVersion`; load the setting first. |
| `409 featured_prints_version_conflict` | Another save won; response includes current `version`. Reload and reconcile; do not blindly retry. |
| `400 invalid_featured_prints` | Invalid, duplicate or over-limit IDs. |
| `400 featured_prints_reason_required` | Missing/blank/overlong reason. |
| `409 featured_prints_item_unavailable` | Response `catalogItemIds` identifies ineligible selections. Refresh/remove them before saving. |

Persistence uses the existing PostgreSQL `platform_settings.settings.featuredPrints`
composite `{version,catalogItemIds}`. Its independent version does not change the
global operational settings version. This private selection is omitted from
`GET /settings`. No migration or boot-time schema change is needed; absence means
version 1 with an empty list. Reference seeding preserves the staff selection.
The normal domain transaction/advisory lock covers selection validation, settings,
audit and notifications atomically, so competing writes cannot silently overwrite.
A product becoming unavailable never silently edits the stored configuration.

## Follow-up acceptance

Dashboard: load the current version, choose approved samples, reorder, supply a
reason, save, and handle conflicts/unavailable selections. Client: use the public
read, heading **FEATURED PRINTS** styled like **START YOUR FIRST PRINT**, greeting
line “Choose what you need and GRIDGO finds the printer.”, fee-inclusive prices,
signed samples and the empty fallback. Verify light/dark, mobile/web and refresh
behavior. No API change to historic orders or customer artwork is involved.
