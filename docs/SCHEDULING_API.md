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
