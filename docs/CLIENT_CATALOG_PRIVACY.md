# Client catalogue privacy: staged release

Refs gridgoph/gridgo-api#132. Decision: 4 October 2026.

The final contract exposes GRIDGO client prices, distance zones and ratings,
without supplier prices, shop names, shop addresses or exact shop coordinates.
**This is phase 1: additive API preparation. It does not remove legacy fields or
claim that existing public responses are private.** No database migration is
needed. Existing supplier, dashboard and client builds retain their responses.

## Release order

1. Deploy this API to provide the additive amounts, quotes and authenticated
   catalogue reads below. Keep all existing fields and routes compatible.
2. Release the client using these amounts and quotes, and the dashboard using
   `/ops/catalog/*`. Confirm the installed supplier build uses its signed-in
   endpoints; migrate any public preview reads to `/me/catalog-preview` or
   `/me/catalog-items/:id`. Source inspection cannot establish which binary is
   installed on a handset.
3. Only after the compatible client release is live and the update prompt covers
   older builds, schedule removal of the deprecated fields below. Test anonymous,
   client, supplier, Operations and Super Admin responses again. Preserve staff
   and owning-supplier detail and original stored order/invoice snapshots.

Do not merge phase 3 into the phase 1 deployment. Firstmate owns the release gate.

## Client price fields

All amounts are safe-integer PHP minor units, inclusive of GRIDGO's service fee.
They are ready to display: **never add the service fee again**.

| Response location | Client field | Deprecated supplier amount retained in phase 1 |
| --- | --- | --- |
| Full listing (public board, detail, match, cart read) | `clientBasePriceMinor` | `basePriceMinor` |
| Listing, including compact cart mutation stubs | `clientFromPriceMinor`, `clientEffectivePriceMinor` | `fromPriceMinor`, `effectivePriceMinor` |
| `optionGroups[].options[]` | `clientPriceModifierMinor` | `priceModifierMinor` |
| `priceTiers[]` | `clientUnitPriceMinor` | `unitPriceMinor` |
| `speedTiers[]` | `clientPriceMinor`, `clientSurchargeMinor` | `priceMinor`, `surchargeMinor` |
| `rush` | `clientPriceMinor` | `priceMinor` |
| `cart.lines[]` | `clientLineSubtotalMinor` | `lineSubtotalMinor` |
| Checkout invoice and `GET /orders/:id/invoice` | `clientItemSubtotalMinor` | `itemSubtotalMinor` plus `serviceFeeMinor` |
| Invoice `lines[]` | `clientUnitPriceMinor`, `clientAmountMinor` | `unitPriceMinor`, `amountMinor` |

Starting/effective listing and cart-line client fields already existed; this
phase completes their coverage and supplies authoritative quotes. Compact cart
mutation listing stubs still omit option groups, tiers and photos. Match Top
Pick and anonymous alternative listings carry the same applicable client fields.
Rating and zone fields are unchanged.

Option discounts preserve their sign: round the absolute fee half-up, then
restore the sign. Null speed/rush fields remain null. These display components
must **not** be summed or multiplied to compute the amount due: tier replacement,
option multipliers, minimum measurements, clamping and rounding happen before
the service fee is applied. Use the quote endpoint for the configured line.
Current checkout supports standard/scheduled service, not speed-tier selection;
speed and rush client fields are display metadata, not a newly enabled purchase.

Invoice client fields are projected from the stored invoice amounts and fee
rate, never today's settings. Stored invoices are unchanged. Per-line rounded
client amounts may differ by centavos from the aggregate; use the invoice or
basket aggregate for the total.

## Configured listing quote

`POST /me/catalog-quotes` requires a signed-in client membership. It is a read-only
calculation, returning `200 { "quote": ... }`; it creates no cart, reservation,
order or price lock.

```json
{
  "catalogItemId": "item_...",
  "quantity": 3,
  "optionIds": ["option_..."],
  "measurement": { "width": 1500, "height": 1000 },
  "structuredSpec": {}
}
```

Quantity is a positive integer. `optionIds` defaults to `[]`; required groups
must be satisfied. Measurement uses the existing cart contract (integer
thousandths in the listing's unit, or integer pages); omit it for unmeasured
listings. `structuredSpec` supports the existing printer-cap check.

The response is allowlisted and contains only:

```json
{
  "quote": {
    "catalogItemId": "item_...",
    "version": 1,
    "serviceVersion": 1,
    "quantity": 3,
    "clientUnitRateMinor": 116,
    "clientLineSubtotalMinor": 520,
    "billableMilliUnits": 4500,
    "minimumMeasurementApplied": false
  }
}
```

This example is a measured 1.5 × 1.0 listing, quantity three. The line total is
calculated before markup, so it is not `clientUnitRateMinor × billable units`.
A missing/unpublished listing is `404 catalog_item_not_found`; selection,
quantity, measurement, minimum and printer-width refusals use the existing cart
error codes. `speedTier`/`speedTierId` are refused with `400 invalid_service_level`
because checkout does not yet persist those selections. A price quote is not a
promise of stock, deadline, artwork validity or checkout eligibility.

## Basket and destination quote

Every draft cart response now includes `cart.clientQuote`, including compact
line mutations. It is null on checked-out carts; use the saved invoice there.
Use the draft quote instead of downloading shop pins and calculating delivery.

- `GET /me/carts/:id/quote` reads the owning client's draft basket quote only.
- `POST /me/carts/:id/quote` previews optional `fulfillmentMode`, `serviceLevel`,
  `scheduledFor`, `defaultDropoff`, and `lines: [{lineId, dropoff}]` overrides.
  These use the existing fulfillment/dropoff validators, including nonblank
  point labels. A null line dropoff falls back to the default. Overrides are
  **not saved**, and do not increment the cart version; save them with the
  existing cart endpoints before checkout.
- Both return `200 { "quote": ... }`. Anonymous requests are `401`; non-client
  requests and another client's basket are `403`. Non-draft quote requests
  are `409 cart_checked_out`; read the invoice after checkout.

The quote contains:

| Field | Meaning |
| --- | --- |
| `status` | `priced` or `incomplete` |
| `reasons[]` | `{code, lineId? , lineIds?}`; `cart_empty`, `catalog_item_stale`, `line_unpriced`, `shop_unavailable`, `dropoff_required` |
| `clientItemSubtotalMinor` | GRIDGO amount, fee rounded **once on the aggregate**; null if a line cannot be priced |
| `deliveryLines[]` | `{lineIds, distanceZone, deliveryFeeMinor, distanceKm?}`; no supplier identity, origin pin, address or exact metres |
| `deliveryFeeMinor` | Sum of delivery legs, null if any leg is unknown; new pre-match pickup includes the configured hub fee (legacy pickup stays zero) |
| `pickupFeeMinor` | On a pre-match pickup cart only: the hub fee already included in `deliveryFeeMinor`; never add it again |
| `totalMinor` | GRIDGO items plus delivery; null for incomplete quotes |
| `downpaymentPercent` | Current 75/100 setting for a new order |
| `downpaymentMinor`, `balanceMinor` | Checkout's half-up installment amounts; null if total is unknown |

Delivery shares checkout's distance and inclusive zone-band lookup: group lines
by supplier and charge for the farthest line/default destination once per group.
Out of Zone alone includes `distanceKm`, rounded to one decimal. Pickup has no
client delivery legs. The existing one-shop-per-cart restriction is unchanged.
On carts selected through the pre-match fulfillment flow, quotes preserve the locked choice and destination; conflicting preview overrides return `409 request_fulfillment_locked`.
The quote uses current listings/settings; checkout validates and snapshots them
again. A quote is not a reservation, QA decision, or payment confirmation.

## Signed-in catalogue reads

| Endpoint | Access and result |
| --- | --- |
| `GET /ops/catalog/shops?categoryCode=...&cursor=...` | Operations/Super Admin; same published-board pagination/filter and full summaries as legacy `/catalog/shops` |
| `GET /ops/catalog/shops/:supplierId` | Operations/Super Admin; full published board, shop identity, address/pin and supplier prices |
| `GET /ops/catalog/items/:itemId?optionIds=...` | Operations/Super Admin; full published listing and selection figures |
| `GET /me/catalog-preview` | Supplier membership; own published board only, caller ID taken from authentication, never a query parameter |
| Existing `GET /me/catalog-items`, `GET /me/catalog-items/:id`, `GET /me/supplier-profile` | Own supplier management reads, including unpublished listings/profile; unchanged |

New signed reads return `401` anonymously and `403` for the wrong membership;
`Cache-Control: private, no-store, max-age=0`. Published-board reads retain the
existing publication filters and 404s; they are not draft-management endpoints.
Listing sample URLs use the same signing decorator as existing catalogue reads.
Keep these authenticated projections full when public projections are reduced.

## Phase 3 removal inventory

All entries below are **deprecated on public/client projections only**, not in
PostgreSQL, accepted money snapshots, or authorized supplier/staff responses.

| Surface | Fields to remove or replace on client/public reads |
| --- | --- |
| `/catalog/shops`, `/catalog/shops/:id`, match `shop`, cart `shops[]`, checkout `jobs[].shop` | `shopName`, `shop` (`label`, `lat`, `lng`), shop identity `media` (logos/cover images must not serve as an identity-directory bypass) |
| Any nested listing in public boards, item detail, match `listings[]`/`otherListings[]`, cart, checkout job boards | `basePriceMinor`, `fromPriceMinor`, `effectivePriceMinor`, `optionGroups[].options[].priceModifierMinor`, `priceTiers[].unitPriceMinor`, `speedTiers[].priceMinor`, `speedTiers[].surchargeMinor`, `rush.priceMinor` |
| Match diagnostics | `reasons[].detail` for `factor: "cost"` currently embeds the supplier starting amount in prose; retire or replace it with client-safe wording. The supported client badge is `matchReason` |
| Cart | `lines[].lineSubtotalMinor`; consume `clientLineSubtotalMinor` and `clientQuote` |
| Checkout result | `itemSubtotalMinor`, `serviceFeeMinor`, `serviceFeeRateBps`; consume `totalMinor - deliveryFeeMinor`. Remove `jobs[].deliveryDistanceMeters`; use zones, Out of Zone kilometres only |
| Invoice (checkout and read) | `itemSubtotalMinor`, `serviceFeeMinor`, `serviceFeeRateBps`, `lines[].unitPriceMinor`, `lines[].amountMinor`, `deliveryLines[].shopName`; consume additive client fields |
| Client order list/detail and mutation responses through `publicOrderFor` | `subtotalMinor` and supplier-principal component fields; `serviceFeeMinor`/`serviceFeeRateBps` where they reveal the pre-fee price; money and shop-origin fields inside `acceptedQuote`, `pendingQuote`, `quoteHistory`, `payments.*.componentLines` as well as top level. Explicitly cover `supplierSubtotalMinor`, `supplierPriceMinor`, `supplierPlatformPayoutMinor`, `supplierEarningsMinor`, `initialSupplierPrincipalMinor`, `supplierRemainderMinor`, `supplierDownpaymentRateBps`, `paymentAllocations`, quote `paymentTerms`, shop `pickup`/`supplierName`, and `deliveryDistanceMeters` if present. Existing top-level payout denials must remain |

The legacy public `GET /catalog` exposes platform reference products (including
`basePriceMinor`), not supplier listings. Its client product-card consumers still
need migration before retiring/renaming that reference-price contract; do not
confuse it with a supplier quote. `/users`, `/supplier-services`,
`/orders/:id/eligible-suppliers` and `/admin/shop-rankings` are already restricted
to the appropriate supplier/staff roles and are not public shop directories.

In particular, legacy quote snapshots call the origin `supplierShop`, not just
`pickup`. Remove that object and `orderLines[].amountMinor` on client projections
of `pendingQuote`, `acceptedQuote` and `quoteHistory[]`. Also inspect legacy
`orderLines[].optionSnapshots` and top-level `optionSnapshots` for raw modifier
amounts; preserve only client-safe specifications/labels. These paths are created
by the quote/commit routes in `src/server.js`, independently of cart checkout.

`publicOrderFor` already removes the shop origin from a client's delivery order,
and substitutes the GRIDGO office for a collection. Preserve the office point
and the client's own destination; neither is a private shop pin. The order
projection is a deny-list: phase 3 must test nested legacy quote snapshots, not
just today's checkout schema. Keep approved rating/zone fields and signed listing
samples. Supplier-provided free text and artwork are not rewritten by phase 1.

## Read-only consumer audit and required follow-ups

Inspected client `a3504b3`, supplier `4ba67eb`, dashboard `04ee081` on 4 October
2026. No app source was modified. Phase 1 preserves every field found, so no
consumer removal is required to deploy this phase. This is source compatibility
inspection, not verification of released mobile binaries.

- Client `app/request/listing.tsx`, `lib/listing.ts`, `lib/measurement.ts`:
  replace local base/options/tier arithmetic with `/me/catalog-quotes`; debounce
  selection requests and discard responses for superseded selections. Keep
  server validation/null handling; never synthesize a zero price.
- `components/OptionGroupPicker.tsx`: use `clientPriceModifierMinor` directly.
  `TopPickCard`, `OtherListingRow`, `CategorySample`, `GridgoPrice`,
  `lib/gridgoPrice.ts`, `lib/homeSamples.ts`, `lib/shopBoards.ts`: use client
  starting/base amounts for rendering, accessibility labels and sorting.
  Do not pass an already-inclusive amount to `GridgoPrice.supplierMinor`.
- `app/checkout.tsx`, `lib/basket.ts`: consume `clientLineSubtotalMinor` and
  `clientQuote` for amount-due/eligibility instead of raw line amounts and shop
  pins. Remove the board downloads used solely for delivery measurement. Use
  `deliveryLines[].lineIds` to associate the anonymous run; use quote zones
  instead of local distances. `linesUnpriced` must no longer check the deprecated
  `lineSubtotalMinor` key.
- `app/order/[id].tsx`, `lib/orderState.ts`, `lib/refunds.ts`, `lib/receipt.ts`:
  use the saved total less delivery for order printing totals; invoices have
  `clientItemSubtotalMinor` and `lines[].clientAmountMinor` (already marked up).
  Preserve legacy order handling until the update gate is in place.
- `lib/api.ts`, listing caches, match/board fixtures and tests: update field types
  and remove private-field dependencies. `lib/shopBoards.ts` uses `shopName`
  for unreadable-board diagnostics; use an anonymous listing/run identifier.
  Match photo refresh may keep catalogue reads but must not need shop identity.
- Legacy `ProductCard`, `lib/catalog.ts`, `store/requestDraft.ts`,
  `app/(tabs)/new-request.tsx` and reorder metadata in `app/(tabs)/orders.tsx`
  consume reference-product base amounts; distinguish these from supplier data.
  Tracking components already tolerate missing shop pickup; verify delivered
  orders remain origin-free and collections retain the office marker.
- Dashboard `src/lib/api/client.ts` `listCatalogShops`/`getCatalogShop`, consumed
  by `src/app/admin/catalogue/_lib/load-floor.ts`: move to `/ops/catalog/shops`
  and `/ops/catalog/shops/:id` with the existing Clerk bearer.
- Supplier `lib/api.ts`/`lib/listingsApi.ts` already use `/me/catalog-items` in
  inspected source. Use `/me/catalog-preview` for any published-board preview
  in an older build, and establish installed-build coverage before phase 3.

Required client validation includes listing/checkout price consistency,
measured/tiered/discounted options, half-centavo aggregate rounding, null prices,
Out of Zone and multiple dropoffs, receipts with historical fee rates, photo
refresh, accessibility labels, and the update prompt for old builds.
