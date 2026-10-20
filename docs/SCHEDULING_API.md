# Scheduling: Tight, Secured and Rush (release 1)

Contract for issue #292 / report 45F0B547. Apply migration
`1792417000000_scheduling_tiers` before deploying. Client/supplier UI follows
this API release; the simplified shop editor and Express conversion are release 2.

## One calculation

`projectShopFinish` in `src/order-match.js` uses the existing availability walks:

1. Next GRIDGO review opening, plus review time in GRIDGO hours.
2. Queue, production and quantity/capacity limits in shop hours, including dated
   closures and declared extensions.
3. Existing delivery/promise allowance in GRIDGO hours. Zero allowance still
   needs an open dispatch window. A result at or after the dispatch cutoff
   moves to the next open window before that cutoff.

This applies to matching, anonymous alternatives, add-more listings, cart lines
and groups, checkout, and recovery/reschedule estimates. No Express shortcut
remains. Express is still an editable listing boolean; it grants no additional
capacity or opening hours and does not supply a missing production duration.

Dates are Manila dates. GRIDGO closed weekdays and closure dates cannot be
selected, even if production could finish earlier. Sunday is closed by default;
its reason is `gridgo_closed_sunday`. Today cannot be selected while GRIDGO is
closed or from the cutoff onward. Cutoff equality is too late. Shop closures
and hours affect production, not the definition of a GRIDGO delivery date.
A later date still must satisfy the complete calculation, including its clock
time. A passed time is never silently extended to midnight.

For ordinary listings, project both `minimumTurnaround*` and `turnaround*`;
missing minimum means the same duration as the maximum. Working days retain
the shop's day length; minute/hour durations remain exact. Before the minimum
is impossible; between minimum and maximum is **Tight**; at or beyond the
maximum is **Secured**. Among matching shops/listings, one maximum being met is
enough for Secured. Shop counts and arbitrary first-two-day colouring are not
used. A short production duration (less than a shop working day) uses the
same-day review time, even when closures or queue push completion to another
date. Longer work uses the existing artwork review time.

Without a requested deadline, the ready estimate uses the minimum. With a
requested deadline that reaches the maximum, the accepted projection uses the
maximum; a Tight selection uses the minimum. This keeps the shop's committed
production duration and the client's accepted estimate explicit. Revalidation
at checkout can refuse a stale selection; a match is not a reservation.

## Client projections

`GET /me/deadline-days?subcategoryCode=flyers&days=120` keeps `days`, `earliest`,
`operatingStatus` and `expressAvailable`. Each date adds fields:

```json
{
  "day": "2026-10-23",
  "state": "tight",
  "status": "tight",
  "reason": null,
  "readyBy": "2026-10-23T03:00:00.000Z",
  "rushTier": null
}
```

| `status` | Legacy `state` | Meaning |
| --- | --- | --- |
| `not_possible` | `cannot` | Disable; show `reason` |
| `tight` | `tight` | At least one minimum, no maximum is met |
| `secured` | `open` | At least one ordinary maximum is met |
| `rush` | `tight` | Only a listed faster tier meets the date; “Rush, costs more” |

Reasons: `gridgo_closed_sunday`, `gridgo_closed`, `outside_operating_hours`,
`after_dispatch_cutoff`, `before_shortest_time`, `no_eligible_listing`.
`readyBy` is null for impossible dates. Secured dates show the earliest qualifying
maximum; Tight dates show the earliest qualifying minimum; Rush shows the selected
tier estimate. It may precede a later selected date; it is
not a delivery appointment. `earliest` is independent of the display horizon.
The calendar is advisory at minimum/default quantity; match and checkout use
actual quantities, options and draft group work.

Match root, `listings[]`, anonymous `otherListings[]`, cart `groups[]`, checkout
`order` and ordinary owning-client/staff order projections carry `scheduling`:

```json
{
  "version": 1,
  "status": "tight",
  "reason": null,
  "earliestReadyBy": "2026-10-23T03:00:00.000Z",
  "securedReadyBy": "2026-10-28T03:00:00.000Z",
  "readyBy": "2026-10-23T03:00:00.000Z",
  "sameDay": false,
  "tightDeadline": true,
  "label": "Tight deadline",
  "rushTier": null,
  "expressListing": false
}
```

These times are client estimates, never the internal production deadline.
Existing listing/group `readyBy`, root `promiseBy`, line `promiseBy`, and client
order `readyBy` remain supported. Same-day clients can display the clock time
from these ISO instants in Asia/Manila. `expressPromise` is false on new quotes;
`expressAvailable` means an eligible listing still has the legacy switch.

Supplier/rider order `scheduling` is limited to `status`, `sameDay`,
`tightDeadline`, `label`; suppliers continue to receive their own production
`readyBy`. Show “Tight deadline” before acceptance when `tightDeadline` is true.

## Listed rush tiers and price

`rushTier` is null or the existing public speed tier, including `id`, `label`,
production fields, `priceMinor`/`surchargeMinor` and their `client*` display
counterparts. Calendar tiers contain no shop identity or shop count. Match cards
carry the actual listing and tier; use its client price fields for display and
`POST /me/catalog-quotes` for exact quantities/options. Display component
markups are never added together to make a checkout total.

The match selection token binds the selected tier ID with the listing/deadline.
Adding that token to a cart adopts the tier. Direct cart additions, line PATCH
and `/me/catalog-quotes` accept optional `speedTierId`; null removes it on PATCH.
A caller-supplied price object is not supported. Unknown/removed tiers return
`409 speed_tier_unavailable`; a conflicting token/tier returns
`409 select_token_tier_mismatch`. Cart lines expose `speedTierId`.

The current approved listing resolves the tier on every preview and checkout.
The existing integer pricing engine applies its listed replacement unit price
or fixed surcharge. Order lines snapshot the tier, price and chosen production
duration. No new rush/same-day fee is introduced. Colour price-check listings
cannot select a speed tier because their approved page pricing is independent.

## Pilot warnings and historical orders

Checkout snapshots `scheduling` in `orders.data`. Tight orders and same-day
production orders are warning-only, including legacy short-duration order-line
snapshots and all previously placed `express: true` orders. A reasoned Tight
pre-acceptance decline is marked `tight_deadline_pilot`; it does not increment
performance declines. Timeout and cancellation after acceptance are unchanged.

Late pilot orders retain warnings/audit/inbox history but get no new money
deduction, quality reduction, Top Pick hiding or roster escalation. This also
blocks pending, unapplied deductions even when the money gate is enabled.
Applied/closed records and released payouts remain immutable. Existing order
promises, durations, money and clocks are never recalculated by this release;
reviewed reschedule/recovery consent remains the only way to change a promise.

## Super Admin settings

Existing `PATCH /settings` accepts the full `operatingHours` object with
`sameDayReviewMinutes` (new, default **30**, integer 1–540) and
`priorityDispatchCutoffMinute` (existing, now enforced, default **960** = 16:00).
`artworkReviewMinutes` still controls longer jobs (default 60). A valid schedule
must have an opening before the cutoff. Omission of the new field by older
editors preserves its current setting. `GET /settings` supplies its default even
for pre-release settings rows. The existing Super Admin membership gate,
`expectedVersion`, required `reason`, transaction and `settings.operational_update`
audit (previous/current values) apply. Settings edits affect new estimates only.

## Release 2: one production-time question

Shop app and shop web use the same additive `productionTime` object on
`POST /me/catalog-items` and `PATCH /me/catalog-items/:id` (PATCH retains
`expectedVersion`). Choose exactly one shape:

```json
{ "productionTime": { "mode": "same_day", "hours": 2 } }
```

```json
{ "productionTime": { "mode": "days", "minDays": 1, "maxDays": 3 } }
```

Hours must be positive and resolve to whole minutes (e.g. 1.5); days are
positive whole shop working days, minimum no greater than maximum. Invalid or
mixed choices return `400 invalid_production_time`. Do not send legacy duration
fields or `express` alongside `productionTime`. Same day uses exact hours;
it does not bypass queue, shop closures, GRIDGO review, dispatch or delivery.
The preview can therefore show a later date. The legacy duration fields remain
accepted and returned. The new choice sets `turnaroundMode: "override"` and
maps to the existing `turnaround*` and `minimumTurnaround*` fields; no new
scheduler or fee is introduced. Faster listed tiers and their prices are
unchanged and can move under the UI's More options.

Shop listing reads (own list/detail and staff listing reads) add:

```json
{
  "productionTime": { "mode": "days", "minDays": 1, "maxDays": 3 },
  "productionTimeReview": {
    "required": true,
    "reasons": ["legacy_one_working_day"],
    "message": "Check your production time"
  }
}
```

Inherited time is resolved from the service; missing duration produces
`productionTime: null`. Exact legacy hour durations retain their exact hours. An existing hour range
projects its longest duration; the legacy minimum remains unchanged until saved.
Legacy mixed day/hour ranges that cannot fit either choice also return null;
the old duration fields remain available to explain the current setting.
The review object is always present; when clear it is
`{ "required": false, "reasons": [], "message": null }`.
Reasons are `legacy_one_working_day` and `express_missing_hours`.
Saving a valid production-time choice clears the reminder. An unrelated price,
name, photo or visibility edit does not clear it. Existing app duration edits
also clear it when they explicitly save a usable production duration.

`GET /ops/catalog-items?productionTimeReview=required` uses the existing
Operations/Super Admin membership gate and returns the existing paginated
`{ items: [{ shop, item }], shops, total, nextCursor? }` shape, including each
item's review reasons. Existing supplier, category, search and price filters
still apply. Supplier/client calls are forbidden.

### Preview before saving

`GET /me/catalog-items/:id/production-time-preview?mode=days&minDays=1&maxDays=3&days=14`
(or `mode=same_day&hours=2`) is a supplier-owned read. It accepts a proposed
choice in query parameters and a display horizon `days` from 1 through 120
(default 14). It returns `{ productionTime, scheduling, calendar }`.
`calendar` has exactly the release-1 deadline calendar shape (`days`, `earliest`,
`operatingStatus`, `expressAvailable`); its days include Tight/Secured/Rush,
closed-day reasons and ISO `readyBy` clock times for Asia/Manila display.
`scheduling` supplies the proposed listing's earliest and secured estimates.
Preview uses only this listing, current queue/hours/settings and existing
listed faster tiers at default quantity. It also works for drafts and hidden
listings; it is advisory and grants no matching eligibility or reservation.
No request-supplied clock, price or additional fee is supported.

### Use for all my listings

`POST /me/catalog-items/production-time` accepts:

```json
{
  "productionTime": { "mode": "days", "minDays": 1, "maxDays": 3 },
  "expectedVersions": { "listing_a": 4, "listing_b": 2 }
}
```

Include every own listing ID/version from the shop's list, including hidden
and draft listings. A missing/extra ID or stale version returns
`409 catalog_items_stale` and applies nothing; refresh the list and retry.
Returns `{ items, total }` with the updated private projections and versions.
The transaction updates only the caller's listings, clears their reminders,
and audits each edit as `catalog_item.update` with previous/current production
fields and `bulk: true`. It does not alter services, review/visibility holds,
listed tiers or prices. New production-time edits apply immediately like the
existing duration edits, including listings with pending price revisions.

### Migration and historical promises

Apply `1792501000000_production_time_choice` before this API. Express listings
with a usable effective duration become exact-hour Same day listings and keep
their production duration; the retired boolean becomes false. Express listings
without a usable duration retain the boolean and receive
`express_missing_hours` until the shop supplies a duration.

Migration `1791936000000_production_days` recorded canonical day values but
no original-hour or per-row rounding marker. The new migration conservatively
flags one-day rows that existed at that migration's recorded `pgmigrations`
run time and still carry one-day values;
inherited one-day service durations and audited historical corrections are
included. This reminder asks the shop to confirm; it never guesses or restores
an original duration. Legitimate old one-day settings can also need confirmation.

This migration and all production-time edits write listing metadata only.
Placed/live order promises, duration snapshots, shop clocks, fees and speed-tier
prices are untouched. Changing a listing affects future estimates only.

## Queue lifecycle repair

Queue estimates check both the per-shop job and its parent order. Picked-up,
in-transit, delivered, issue-window, completed and cancelled work cannot consume
queue minutes or a queue position even when an older transition left an active
job row. Shop cancellation, decline and timeout withdraw work from the original
shop throughout recovery and pending refunds; accepted replacement work counts
at its replacement shop. The same rule applies to direct orders, and a closed
job cannot return through the direct-order fallback. Active payment/QA work is
counted once; draft group work still consumes capacity. The parent
check is the scheduling boundary, so new lifecycle routes cannot reintroduce
finished work by missing a compatibility-job update.

Follow-up migration `1792503000000_withdrawn_production_queue_backfill` closes
original-shop recovery jobs (including refund-pending and stale accepted
recovery rows), preserves replacement jobs, and completes legacy payout-released
jobs. It is repeatable and changes only job state/update timestamps.

Migration `1792502000000_order_job_queue_backfill` brings stale nonterminal jobs
forward to their order's pickup/delivery/terminal state. Already completed or
cancelled jobs stay closed. Repeating the backfill changes nothing further.
It never changes orders, promised dates, prices, fees or duration snapshots.

## Selection-token promise window

The match selection token guarantees that listing's offered production ready-by
and client promise for its existing **15-minute** lifetime. Cart add, cart reads
(line `promiseBy` and group `readyBy`/`scheduling`) and checkout use the stored
offer for unchanged selected work, including a Tight offer that would cross the
16:00 dispatch cutoff if recalculated minutes later. Checkout/order client
`readyBy` and `scheduling.readyBy` carry the honoured client promise; the shop
retains the original internal production ready-by.

The guarantee is server-owned, persisted with the selection, and bound to the
client, cart, shop/deadline group, selected quantity/tier, and all same-shop draft
work that influenced the offer: its own group plus earlier-deadline groups (all
dated groups for an undated offer). This workload is checked when adding the
selection and again before checkout materializes any group orders. Adding,
editing or deleting relevant earlier work invalidates affected later offers and
uses the current recheck. Unchanged groups keep their offered dates even while
checkout reserves earlier groups, and external customers' intervening queue work
does not invalidate a still-valid offer. Changing selected work requires a fresh
estimate. It does not reserve prices or
bypass listing availability, artwork, payment or authorization checks. At or
after `selectTokenExpiresAt`, checkout uses the current queue/calendar recheck
and can return `409 deadline_not_met`. Adding an expired token still returns
`410 select_token_expired`. Older selections without an offer snapshot keep the
current recheck. No existing order promise is recalculated.

## Same-day promise margin control

`GET /settings` returns `settings.operatingHours.sameDayPromiseAllowanceMinutes`,
default **120 working minutes** even for older settings rows. Super Admin can
change it through the existing `PATCH /settings` by sending the full
`operatingHours` object plus `expectedVersion` and a nonempty `reason`.
Allowed values are integers **0–600**, inclusive; null, strings, fractions and
out-of-range values return `400 invalid_operating_hours`. Operations, suppliers,
riders and clients receive `403 forbidden` on PATCH. A stale version returns
`409 settings_version_conflict`.

This margin is added after production using GRIDGO's working calendar, before
the existing dispatch cutoff is applied. Same-day production is the scheduler's
existing duration shorter than one shop working day, including exact-hour
listings and shorter listed tiers. The usual review, shop queue and closure
rules still apply. Days-based production keeps its existing promise margin
(default 600 working minutes); no price or fee changes. Older editors that omit
the field preserve the current value. Settings changes use the existing
`settings.operational_update` audit with previous/current settings and affect
future estimates only; accepted order promises and unexpired selection-token
offers stay fixed.
