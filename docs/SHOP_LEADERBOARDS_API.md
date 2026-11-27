# Shop leaderboards and monthly Top Shop awards

Report reference: 862A3564. Supplier owners can compare service within their
local area. Clients receive the monthly badge only. Ordinary catalogue matching,
regular-order ranking and every Express sort except Nearest are unchanged.

## Settings

`GET /settings` exposes `shopLeaderboard` only to Super Admin.
`PATCH /settings` accepts a partial `shopLeaderboard` object with the existing
`expectedVersion` and nonblank `reason`. The settings version, audit and policy
commit atomically. Operations cannot change it, including when also sending an
Operations-permitted countdown field.

```json
{
  "expectedVersion": 3,
  "reason": "Adjust local competition",
  "shopLeaderboard": {
    "weights": { "stars": 40, "acceptance": 30, "onTime": 20, "answerSpeed": 10 },
    "minimumOrders": 5,
    "radiusKm": 5,
    "monthlyTopCount": 3
  }
}
```

Weights are integer percentages from 0 to 100 and must total exactly 100 after
merging a partial patch. Minimum orders is an integer 1–10,000; radius is a
finite number greater than zero and at most 500 km; monthly top count is an
integer 1–100. Unknown fields, arrays, null and numeric strings are rejected
with `400 invalid_shop_leaderboard_settings`. The defaults above apply to
existing installations without a reference-data update. No migration creates
an award, account or operational order.

## Owner leaderboard

`GET /me/shop-leaderboard?period=week|month` (default `week`) requires the selected
shop's Supplier Owner session. Staff, managers and other roles receive `403`.
There is no client or anonymous leaderboard route and no arbitrary shop/radius
parameter. The server uses the shop point and the governed radius.

The response includes:

- `period: {kind,startAt,endAt}`: half-open Manila calendar interval. Week starts
  Monday at 00:00; month starts on day 1 at 00:00.
- `radiusKm`, `minimumOrders`, `monthlyTopCount`.
- `own`: `supplierId`, `name`, `printerType`, `rank` (null when unranked),
  `score` (0–100, two decimals), `orderCount`, `ordersToQualify`,
  `unrankedReason` (`minimum_orders_required | shop_location_required | null`),
  `declines`, `missed`, `acceptance`, `parts`, and `gap`.
- `parts`: `stars | acceptance | onTime | answerSpeed`, each with `weight`,
  `value`, `normalized` (0–100), `contribution`, and `samples`. Null values
  explicitly mean no observed evidence. Missing evidence contributes zero.
- `gap`: null for first place or an unranked shop; otherwise `nextRank`,
  `scorePoints`, `acceptedOrdersToPass` and
  `assumption: "other_score_parts_and_competitors_unchanged"`.
  The count is an acceptance-only estimate, not a promise: it is null if that
  component cannot close the gap. Apps can always show the score-point gap.
- `rows`: eligible local shops, each with `supplierId`, `name`, `printerType`,
  `rank`, `score`, `stars`, `acceptedPercent`, `onTimePercent`, `orderCount`,
  `isOwn`. Only `own` includes detailed parts and refusal counts.

Home printers rank alongside shops, using their actual point only inside the
server's distance calculation. Peer responses contain no points, street labels,
pickup instructions, contact details or review comments; home names use their
barangay. Missing coordinates prevent ranking. Review accounts/orders and removed
orders do not contribute or receive awards.

## Score and acceptance definitions

Only accept-first Express attempts (`orderType: express`, `acceptFlow: 2`)
contribute. Each reroute retains its own order and acceptance result. Assignment
time selects the cohort; a resolved outcome must exist by the read/closing cutoff.
A shop qualifies with at least `minimumOrders` accepted attempts in the interval,
including accepted jobs still in progress. Declines and misses never qualify it.

The shared `expressOfferOutcomes` / `expressAcceptRate` implementation in
`src/express-checkout-rules.js` is also the source for shop summaries and the
later missed-job/performance policy. An ordinary call returns the rolling
30-day counters; leaderboard callers supply exact period boundaries.

| Part | Value and normalization |
| --- | --- |
| Stars | Average valid quality stars on accepted cohort orders, reviewed in the interval by the cutoff; stars / 5 × 100. Speed/value stars and free text do not affect this part. |
| Acceptance | Accepted / (accepted + declined + timed out) × 100. `acceptance` includes offered, accepted, declined, timedOut, rate (0–1, four decimals, or null). |
| On time | Ready at/before the shop's `readyBy` (fallback `promiseBy`), using `readyAt`, `awaitingCollectionAt` or the first ready tracking entry. Ready late and overdue unfinished accepted jobs count as zero; not-yet-due unfinished jobs and jobs without a deadline have no observation yet. |
| Answer speed | Average seconds from assignment to accepted/declined answer, capped at 60. Misses and missing timing evidence contribute 60 seconds. Normalize as max(0, 1 − seconds / 60) × 100. |

An elapsed pending one-minute offer counts as missed even before its lifecycle
sweep. Still-open and client-withdrawn offers are excluded. A late lifecycle tick
uses the original deadline for answer speed. Resolved outcomes with timestamps
later than the cutoff are excluded. The score is the sum of each normalized part
times its weight / 100, rounded once to two decimals; displayed contributions
are rounded separately.

Each shop's group is centered on its own shop, includes itself, and includes
eligible peers whose shared straight-line distance is **at most** `radiusKm`.
Groups may overlap and are not transitive clusters. Sort by score descending,
accepted-order count descending, then stable supplier ID ascending. Rank is a
unique ordinal, including ties, so a group awards at most the configured count.

## Monthly closing and client badge

The normal lifecycle runner probes for the previous completed month and closes
it under the domain transaction lock. `shop_leaderboard_months` freezes the
policy, period, validity, local winning ranks, score parts and group sizes.
Each candidate wins if its rank in its **own** radius group is within
`monthlyTopCount`. There may consequently be more than three winners across
distant groups. Zero-winner months also get a marker. Concurrent workers and
restarts see that marker and cannot award the month again.

Closing uses facts timestamped no later than the month's last millisecond and
the policy/shop locations present at the first closing transaction. It does not
reconstruct historical profile moves or policy edits, or backfill older missed
months. On deployment it closes the immediately previous month from the existing
accept-first data. Later reviews, edits, moves and policy changes cannot rewrite
a closed award. PostgreSQL rejects updates/deletes of the award record.

An earned month `2026-11` displays on the badge during December: validity is
`2026-11-30T16:00:00.000Z` through, but excluding,
`2026-12-31T16:00:00.000Z`. At expiry the badge and boost disappear without
waiting for a timer. Before the closing transaction completes, the badge is null.

Express GET and quoted POST printer cards expose only:

```json
{
  "topShop": true,
  "topShopBadge": {
    "type": "top_shop",
    "month": "2026-11",
    "validFrom": "2026-11-30T16:00:00.000Z",
    "validUntil": "2026-12-31T16:00:00.000Z"
  }
}
```

`topShop` is false and `topShopBadge` null without a current award; high lifetime
stars alone no longer make a Top Shop. Existing public star summaries retain their
five-review threshold. The filter count follows the same monthly badge.

Within the eligible Nearest candidate set, selectable award holders sort ahead
of selectable nonholders; distance remains the next key. `nearby` is the legacy
alias of Nearest. Closed/incapable printers never gain selection eligibility.
Accept-first reroutes use the same boost only when the saved client sort was
Nearest. Cheapest, Top rated, Fewest jobs, Ready soonest, all-area distance,
fastest automatic choice and regular matching receive no boost.

Closing writes the awards, one pending sticker per winner, audit and durable
inbox notifications for each winning shop and every current Operations/Super
Admin membership in one commit. `save()` remains the outbox delivery boundary.

## Operations door stickers

`GET /ops/top-shop-stickers?month=YYYY-MM` requires Operations or Super Admin.
The default is the earned month for the currently valid badge. It returns
`{month,closedAt,stickers}`; an unclosed month has null `closedAt` and an empty list.
Each sticker has `supplierId`, `name`, `printerType`, `month`,
`status: pending|delivered`, `deliveredAt`, `deliveredBy`. No private pickup
coordinates or leaderboard scores appear in this list.

`POST /ops/top-shop-stickers/:month/:supplierId/deliver` with `{reason}` records
an actual delivery. Nonblank reason (at most 2,000 characters) is required.
It returns `{ok:true}`. Repeats return success without rewriting the original
delivery or duplicating its audit/notifications. Delivery is separate from the
immutable award; PostgreSQL prevents changing or clearing a recorded delivery.
Invalid month yields `400 invalid_leaderboard_month`; missing task yields
`404 top_shop_sticker_not_found`. Clients, riders and suppliers receive `403`.
