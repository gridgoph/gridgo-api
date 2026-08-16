# Product category taxonomy — API contract

Authoritative contract for the client and supplier apps. Field names here are exact;
build against this file, not against the source.

Content comes from the captain's "Product Category Mapping & Chart": **four
categories, seventeen subcategories**, one "best for" audience line per category and
one examples line per subcategory.

---

## 1. The model in one rule

> Every reference to a category is the category's **`code`**, held on the
> **referring** record. Categories never list their children. Nothing is nested in
> the store.

| Referring record | Field | Points at |
|---|---|---|
| subcategory | `categoryCode` (string) | exactly one category |
| material | `categoryCodes` (string[]) | zero or more categories |
| finish | `categoryCodes` (string[]) | zero or more categories |
| category alias | `categoryCode` (string) | the category a retired code now means |
| supplier service | `categoryCode` (string) | one category **or a retired alias code** |

Subcategories are therefore a **separate flat collection**, not nested inside
categories — the same shape `materials` and `finishes` already use. There is exactly
one stored way to express "X belongs to category Y".

The nested `categoryTree` that `GET /taxonomy` returns is a **derived projection**,
recomputed on every request and never persisted. Do not write it back.

---

## 2. `GET /taxonomy`

Auth: any signed-in user. One request returns everything a category picker needs —
there is no second call and no per-category fetch.

```
GET /taxonomy
Authorization: Bearer <token>
```

```jsonc
{
  "taxonomy": {
    "categories":      [ /* 4  */ ],
    "materials":       [ /* 6  */ ],
    "finishes":        [ /* 4  */ ],
    "subcategories":   [ /* 17 */ ],
    "categoryAliases": [ /* 4  */ ]
  },
  "categoryTree": [ /* derived: 4 categories, each with its subcategories nested */ ]
}
```

`taxonomy.*` is the stored, flat truth. `categoryTree` is the convenience shape.

### category

```jsonc
{
  "id": "taxc_marketing_collateral",
  "code": "marketing_collateral",
  "name": "Marketing & Promotional Collateral",
  "bestFor": "Businesses, startups, and events looking to promote services or distribute physical marketing material.",
  "sortOrder": 1,
  "productFamilyIds": ["flyer", "card", "sticker", "banner"],
  "active": true
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | stable record id, `taxc_<code>` for platform categories |
| `code` | string | **stable identity used by every reference**; snake_case |
| `name` | string | display name, chart wording |
| `bestFor` | string | the chart's audience line, **without** the `Best for:` prefix — render it yourself |
| `sortOrder` | number | chart order, 1-based |
| `productFamilyIds` | string[] | links to `/catalog` families; display/filtering metadata only |
| `active` | boolean | `false` hides it from pickers; absent means active |

### subcategory

```jsonc
{
  "id": "taxs_business_store_signages",
  "code": "business_store_signages",
  "name": "Business & Store Signages",
  "categoryCode": "recognition_awards_signage",
  "examples": ["Acrylic build-up letters", "Panaflex lightboxes", "LED neon flex"],
  "sortOrder": 4,
  "active": true
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | `taxs_<code>` for platform subcategories |
| `code` | string | stable identity, unique across all subcategories |
| `name` | string | display name, chart wording |
| `categoryCode` | string | the one category it belongs to; **never** `categoryCodes` |
| `examples` | string[] | the chart's examples line, split into items. Render as chips, or `examples.join(", ")` for the original line |
| `sortOrder` | number | 1-based **within its category**, not globally |
| `active` | boolean | `false` hides it from pickers |

### categoryTree (derived)

Each node is a category object **plus** a `subcategories` array:

```jsonc
[
  {
    "id": "taxc_marketing_collateral",
    "code": "marketing_collateral",
    "name": "Marketing & Promotional Collateral",
    "bestFor": "Businesses, startups, and events …",
    "sortOrder": 1,
    "productFamilyIds": ["flyer", "card", "sticker", "banner"],
    "active": true,
    "subcategories": [ { "code": "flyers", "…": "…" } ]
  }
]
```

- Only `active` categories and `active` subcategories appear. The flat arrays still
  carry inactive records, so an ops surface that must show them reads `taxonomy.*`.
- Sorted by `sortOrder`, then `code`. Do not rely on array position anywhere else.
- Aliases never appear in the tree.

### material / finish (unchanged shape)

```jsonc
{ "id": "taxm_13oz", "code": "tarpaulin_13oz", "name": "13oz tarpaulin",
  "categoryCodes": ["marketing_collateral", "recognition_awards_signage"], "active": true }
```

The values in `categoryCodes` use the canonical chart codes described in §4.

### categoryAlias

```jsonc
{
  "code": "large_format",
  "name": "Large format",
  "categoryCode": "marketing_collateral",
  "ambiguous": true,
  "note": "Pre-chart production-capability code. Work under it now spans …",
  "active": true
}
```

| Field | Type | Notes |
|---|---|---|
| `code` | string | the retired pre-chart code, still accepted on input |
| `categoryCode` | string | the category it resolves to |
| `ambiguous` | boolean | `true` = the legacy code spans several chart categories and `categoryCode` is only its dominant home |
| `note` | string | why it maps where it does; safe to show in an ops surface |
| `active` | boolean | `false` stops the code resolving |

Aliases have **no `id`** — the retired `code` is the identity.

---

## 3. The four categories and seventeen subcategories

| # | Category (`code`) | Subcategories (`code`) |
|---|---|---|
| 1 | Marketing & Promotional Collateral (`marketing_collateral`) | `flyers`, `brochures`, `posters_standees`, `business_cards`, `stickers_packaging_labels`, `tarpaulins_outdoor_banners` |
| 2 | Corporate & Event Merchandise (`corporate_event_merch`) | `lanyards_id_accessories`, `custom_apparel`, `drinkware`, `corporate_giveaways` |
| 3 | Recognition, Awards & Signage (`recognition_awards_signage`) | `certificates_diplomas`, `plaques_trophies`, `medals_ribbons`, `business_store_signages` |
| 4 | Specialized & Prototyping Services (`specialized_prototyping`) | `three_d_printing_scale_models`, `blueprint_cad_plotting`, `packaging_box_production` |

`3D Printing & Scale Models` is coded `three_d_printing_scale_models` because codes
do not start with a digit.

---

## 4. Retired pre-chart codes

The old taxonomy was production-capability shaped (`large_format`, `offset`,
`apparel_sublimation`, `signage`) and cross-cuts the captain's audience-shaped chart.
Those four codes are **retired out of `categories` into `categoryAliases`**, never
deleted, so nothing that already references them becomes an orphan.

| Retired code | Resolves to | Ambiguous? |
|---|---|---|
| `large_format` | `marketing_collateral` | **yes** — also spans `recognition_awards_signage` (store signage) and `specialized_prototyping` (CAD plotting) |
| `offset` | `marketing_collateral` | **yes** — also spans `recognition_awards_signage` (certificates) |
| `apparel_sublimation` | `corporate_event_merch` | no |
| `signage` | `recognition_awards_signage` | no |

**What accepts a retired code:** anywhere the API takes a `categoryCode`
(`POST /supplier-services`, `PATCH /supplier-services/:id`,
`POST /me/supplier-services`, `PATCH /me/supplier-services/:id`, and the
subcategory writers). It resolves through the alias. The canonical code is
stored on new subcategories and on new or explicitly updated supplier services.
An unknown code is still `400 {"error":"invalid_category_code"}`.

**What was rewritten:** `materials[].categoryCodes` and `finishes[].categoryCodes`
only.

| Record | Before | After |
|---|---|---|
| `tarpaulin_13oz` | `large_format`, `signage` | `marketing_collateral`, `recognition_awards_signage` |
| `mesh_banner` | `large_format` | `marketing_collateral` |
| `vinyl_sticker` | `offset`, `signage` | `marketing_collateral`, `recognition_awards_signage` |
| `matte_150gsm` | `offset` | `marketing_collateral` |
| `gloss_cardstock` | `offset` | `marketing_collateral` |
| `cotton_tee` | `apparel_sublimation` | `corporate_event_merch` |
| `hem_grommet` | `large_format`, `signage` | `marketing_collateral`, `recognition_awards_signage` |
| `lamination` | `offset`, `signage` | `marketing_collateral`, `recognition_awards_signage` |
| `none` | all four | all four new categories |
| `kiss_cut` | `offset`, `signage` | `marketing_collateral`, `recognition_awards_signage` |

`none` is a documented record-level override: it applies to every category including
`specialized_prototyping`, which no legacy code can reach.

**What was NOT rewritten:** `supplierServices[].categoryCode`. Existing services keep
whatever they were stored with — resolve it through `categoryAliases` before grouping
a service under a category heading.

Orders never referenced category codes and are untouched.

---

## 5. Ops write routes (super_admin)

Same pattern and audit behaviour as the existing category/material/finish routes.

| Method | Path | Body |
|---|---|---|
| POST | `/taxonomy/subcategories` | `code`, `name`, `categoryCode` required; `examples`, `sortOrder`, `active` optional |
| PATCH | `/taxonomy/subcategories/:idOrCode` | any of `name`, `categoryCode`, `examples`, `sortOrder`, `active` |

`POST`/`PATCH /taxonomy/categories` additionally accept `bestFor` and `sortOrder`.

Responses: `201 {"subcategory": …}` / `200 {"subcategory": …}`.

Errors: `403 forbidden`, `400 invalid_subcategory` (`need: "code, name, categoryCode"`),
`409 code_exists`, `400 invalid_category_code`, `404 subcategory_not_found`.
Creating a category whose `code` is a retired alias is `409 code_is_alias`.

Audit actions: `taxonomy.subcategory_create`, `taxonomy.subcategory_update`.

---

## 6. PostgreSQL seed

The ordered schema migration creates the flat taxonomy tables. `npm run seed` idempotently writes the platform reference definitions from `src/taxonomy.js`; it creates no users or operational records. Runtime boot performs no schema or taxonomy backfill.

Ops-created categories and subcategories remain ordinary PostgreSQL rows. Retired aliases are seeded reference records so older category input remains resolvable without an import path.
