# Product templates

API support for supplier issue 268. Supplier mobile, supplier web (My shop →
Products), and admin screens are separate releases. No checkout, matching,
service-capability, custom-product review, or accepted-order arithmetic changes.
All money below is integer PHP minor units.

## Recommended first catalogue

`npm run seed` appends 25 recommended templates in eight groups and preserves
team edits. This is a **first list the team can edit**, not a fixed final list.
`src/product-template-data.js` derives complete option combinations from the
existing product starters; A3 document choices are included. A shop selects the
combinations it actually offers and prices each selected combination in full.
Unselected combinations are unavailable; a selected row with an empty, zero,
negative, fractional, string, or unsafe price is rejected.

| Group | First templates |
| --- | --- |
| `documents` | Document printing, photocopies, ID photos, photo prints, PVC cards, risograph |
| `books_binding` | Booklets, hardbound & binding, lamination |
| `marketing` | Flyers, brochures, business cards |
| `large_format` | Tarpaulin, posters & standees, blueprint plotting |
| `stickers_labels` | Stickers & labels |
| `wearables` | Custom apparel, lanyards, tote bags |
| `gifts` | Drinkware, giveaways, notebooks |
| `recognition` | Certificates, plaques & trophies, medals |

Specialized quote-only work, 3D work, and custom signage remain in the existing
custom builder and full review. No final decision on that list is implied.

Each template carries `id`, `version`, `active`, name, description, canonical
category/subcategory, group, `unit: page | sheet | sq_ft | piece`, complete
`options: [{key,label,specBinding?}]`, descriptive `optionLists`, `fileTypes`,
`clientTips`, `express`, `machinesNeeded`, `stockPhotos`, and advisory
`priceRange: {minMinor,maxMinor}`. The initial broad ranges are launch review
hints, not surveyed market prices, caps, or a promise to the client. Team edits
can refine them. Machines are advisory: pass a shop-declared machine code list
for the picker; existing category service lines remain the capability boundary.

Stock photographs are shipped reference assets copied into MinIO by the seed
CLI when `MINIO_ENDPOINT` is configured (as in production). Existing object keys
are retained. Re-run `npm run seed` with the normal storage environment before
releasing the companion screens. Tests and database-only seeds can omit storage.
There is no upload or schema repair at API boot. Metadata stores governed photo
references; catalogue, match and cart responses receive signed `downloadUrl`
values through the existing photo decorator. The stock `url` also redirects to
a signed MinIO read. Photograph bytes are never stored in PostgreSQL.

## Supplier app and supplier web calls

Both clients use the same calls with their current Clerk session and selected
shop headers. Existing shop-team owner restrictions apply.

1. **Choose products:** `GET /me/product-templates?q=&group=&machines=`. Search is
   case-insensitive, up to 120 characters. `machines` is a comma-separated list;
   absent machines produce `machineMatch:null`, not an inferred capability.
   Response: `{templates,readyTimes,checkYourProducts}`. Each template adds
   `addedItemIds` (including hidden products) for the “Added” state and an
   advisory `machineMatch`. The picker never creates a service line.
2. **Prices and ready time:** `POST /me/template-products` with the body below.
   Returns `201 {item}` in the existing private catalogue shape, plus `template`.
   Duplicate additions return `409 template_already_added`; edit the existing
   product instead. Up to 200 chosen combinations fit in the existing single
   required option group. The server chooses the smallest full price as base and
   subtracts it from every row; it never approximates a cross-product price table.
3. **Edit/resume:** `GET /me/template-products/:id` returns `{item,prices}`;
   `PUT /me/template-products/:id` replaces the complete selected price table,
   ready time and bulk/rush fields with `expectedVersion`. Omitted bulk/rush
   arrays clear those offers. Repricing an unpriced migrated item may select its
   template explicitly. `item.template` carries confirmation, review flags,
   chosen ready-time code and template version.
4. **Ready-by example before saving:** `POST /me/template-products/preview` with
   the complete proposed creation body (or `itemId` for an owned product being
   edited). Returns `{item,prices,scheduling,calendar,productionTime}` without
   saving a product, audit, inbox row or review submission. This is the final
   screen's dated example and “client sees” preview. After creation, `POST
   /me/template-products/:id/ready-preview` with `{readyTime}` gives the same
   scheduling/calendar projection for just a chip change. Choices: `same_day`
   (two hours of effort), `next_day` (one working day), `2_3_days`, `4_7_days`.
   Display server scheduling timestamps, not “today” inferred from the chip.
   Queue, capacity, opening hours and platform allowance still apply.
5. **Client sees:** use the template's name, stock photo, chosen unit, complete
   selected row labels and full prices for the three-step preview. After saving,
   use the returned item and the existing catalogue preview. Client fee quotes
   continue to use the existing quote endpoint, not a sum of marked-up components.
6. **More options:** send `minimumOrderQuantity`, `clientTips` (a string),
   `priceTiers` and `speedTiers` using their existing catalogue contracts. Bulk
   rates and explicit rush prices must be positive. Rush surcharges retain the
   existing nonnegative-money validation. Extras use existing option-group and
   option endpoints; own photographs use `POST /files` with
   `purpose=catalog_item_photo`, then the existing attach endpoint. Template
   photo projections mark actual shop photos `realPhoto:true`, stock photos
   `realPhoto:false`. Photo/spec/extra edits through the legacy builder retain
   its full review and photo attestation.
7. **Hide instantly:** existing versioned `PATCH /me/catalog-items/:id` with
   `{expectedVersion,active:false}`. Pending price review never prevents hiding.
   Publishing uses `active:true`; an unpriced, unconfirmed or taken-down product
   cannot bypass its hold. A hidden product stays hidden when repriced until the
   shop turns it on.

```json
{
  "templateId": "tpl_flyers",
  "supplierServiceId": "existing_service_id",
  "readyTime": "next_day",
  "prices": [{ "optionKey": "standard", "priceMinor": 1200 }],
  "minimumOrderQuantity": 10,
  "priceTiers": [],
  "speedTiers": [],
  "clientTips": "Send a print-ready file."
}
```

Use keys and full labels from the current template catalogue, never invent option
keys. Tarpaulin creation also requires `printerMaxWidthFeet` (integer 1–20).
The unit adapter uses existing `per_page`, `per_area` with feet, or `per_unit`
(sheet/piece) pricing. Prices are supplier principal; existing client service
fees are calculated by checkout as before.

## Template requests and assisted setup

- `POST /me/product-setup-requests` with
  `{kind:"template",requestedName,message}` requests a template, with a shop
  notice allowing about one working day. This does not invent taxonomy or grant
  capabilities. Existing custom-product creation remains available.
- For “Let GRIDGO set it up”, upload price-list images/PDFs or voice notes using
  `POST /files` with `purpose=product_setup`, then send
  `{kind:"setup",message?,fileIds?}` to that same request endpoint. At least a
  message or file is required. Up to ten ready, owned files are accepted. Upload
  maximum: 20 MiB; JPEG, PNG, WebP, PDF, M4A (`audio/mp4`), MP3, Ogg, WAV. Filename,
  declared type and byte signature must agree. These files are owner and
  Operations/Super Admin only; use existing `/files/:id` signed reads.
- `GET /me/product-setup-requests?status=` returns `{requests}` scoped to the shop.
  The initial queue returns the last 100 matching rows.
- Prepared items arrive with `template.shopConfirmed:false` and `active:false`.
  Show all full prices, then `POST /me/template-products/:id/confirm` with
  `{expectedVersion}`. Confirmation enables the product's switch and queues the
  price check; it does not approve it. Saving a corrected complete price table
  through the owning shop's PUT also records its confirmation. A later staff
  edit requires a fresh shop confirmation and version. Review and legacy
  active/submit routes cannot bypass this gate.

## Admin review screens

| Screen/action | Call |
| --- | --- |
| Template catalogue/editor | `GET /ops/product-templates?q=&group=`; `PUT /ops/product-templates/:id` with `{expectedVersion,template}` (version omitted only for a new ID). Full definition required. Stock photos choose existing governed `/product-template-photos/lst_….jpg` URLs. Disabling a template affects new additions; copied products keep their own facts. |
| Price-check queue | Existing `GET /ops/catalog-reviews?status=pending&after=`. `item.template.managed && item.template.priceOnly` identifies price-only template products. Show full prices, `template.priceCheck.flags`, submission timestamp and Manila `targetBy` day for same-day triage; show confirmation status. |
| Price-check decision | Existing `POST /ops/catalog-reviews/:id/decision` with `{expectedVersion,status:"approved"}` or `{expectedVersion,status:"needs_revision",reason}`. Untouched template stock photos need no repeated `photosUnbranded` attestation. Own photos and legacy spec/extra edits keep existing full-review attestation. Flags require a human price check, not automatic rejection. Approval clears no service/account/take-down holds. |
| Requests inbox | `GET /ops/product-setup-requests?status=pending`; `POST /ops/product-setup-requests/:id/decision` with `{expectedVersion,status:"completed"|"needs_revision",reason,templateId?}`. Completing a template request requires an available template ID. |
| Prepare products | `POST /ops/shops/:supplierId/template-products` with the supplier creation body; revise using `PUT /ops/shops/:supplierId/template-products/:id` plus `expectedVersion`. Never publish directly. |
| Resolve existing A3/product-type requests | `POST /ops/product-templates/:id/resolve-requests` with `{requests:[{id,expectedVersion}]}`. Select pending requests in the same category; resolves them against the existing template subcategory and notifies each shop. This is explicit admin work, not seed behavior. Newly requested template names can also be resolved when a matching template is saved. |
| Migration preview/apply | `POST /ops/shops/:supplierId/template-migration`, described below. |

Approval writes the durable `template_product_live` supplier inbox event when
the product is publicly eligible (`template_product_price_checked` while hidden or held), and
copies each current Operations and Super Admin membership. Submission,
preparation, confirmation and request decisions use the same save/outbox and
catalogue invalidation boundary. Existing push privacy allowlists remain intact.
A price check can be completed immediately; the server does not automatically
approve prices or guarantee a staffing SLA.

Existing approved composites remain the client price until a replacement is
approved. Accepted order-line money, options, promises and invoices stay
immutable. New selections use the approved replacement and existing version
checks. Custom-product approval behavior is unchanged.

## Explicit existing-product migration

No migration file, boot or seed matches, hides or merges operational listings.
The admin operation defaults to a read-only dry run:

```json
{
  "dryRun": true,
  "templateMatches": { "existing_item_id": "tpl_flyers" },
  "mergeGroups": [{
    "keepId": "a4_item_id",
    "sourceIds": ["a3_item_id"],
    "labels": { "a4_item_id": "A4 flyer", "a3_item_id": "A3 flyer" }
  }]
}
```

Response: `{supplierId,dryRun,actions,manual}`. By default, unique subcategory
matches are suggested, exactly identical pricing/configuration duplicates are
merged, and zero-effective-price products are hidden. Ambiguous families require
`templateMatches` or manual work. Explicit variant merges accept simple flat
listings with identical service, pricing unit, turnaround, formats and other
pricing rules, distinct variant labels, and positive full prices. Complex option
or differing pricing configurations are reported for manual work, never guessed.

Review the preview, then repeat it with `dryRun:false` and
`expectedVersions:{itemId:version,...}` for every action and every variant source.
The operation recomputes the plan under the normal transaction lock; stale
versions return `409 catalog_item_stale`. Applied sources remain as hidden rows
with `template.mergedInto`, all photos and order references intact. The survivor
retains all explicit variant prices as normal options. Nothing is deleted.
Repeated runs report previously matched records rather than rewriting them.

**Open orders are a hard guard:** any listing referenced by a nonterminal order,
including delivered work still being closed, is manual-only. Missing order
context is treated as open. Legacy open shop work without attributable line
references conservatively blocks the shop's listings. If any explicit merge
member has open work, the entire group is reported as `merge_has_open_orders` and
left unchanged. Review/suspension holds are also manual-only. Staff must resolve
these cases separately before retrying; this operation offers no override.

## Storage and compatibility

The additive migration creates the reference/workflow tables and a nullable
`template_data` composite on listings. It relaxes only the existing option
ordering bound to 200 so complete apparel tables fit; legacy callers retain their
existing editor limits. It expands the existing file-reference type allowlist.
It does not impose a new CHECK that a historical catalogue upsert can violate.
Historical mappings omit `template_data`, so their updates preserve it. No domain
row is rewritten by DDL. Rollback is forward-only to preserve team work and shop
confirmations.
