# Supplier Performance API

Contract for gridgoph/gridgo-api#223, decision B (18 October 2026). API support
ships separately from the supplier app and dashboard views. All responses are
private and require Clerk authentication with database memberships. No client
release is required for the matching change.

## Warnings only

From the migration's immutable rollout timestamp, **no new production deduction
is assessed**, including an older pending assessment. No warning, notice,
Top Pick demotion or roster-review flag changes any payout amount or introduces
a payout hold. This remains true even if the legacy deductions setting is true
or an agreement was accepted. The existing Super Admin setting is not changed;
keep it off. Previously applied deductions and released amounts remain immutable.
Money penalties and disputes require a separate release.

The migration adds an append-only `supplier_performance_events` ledger and a
rollout marker. It does not modify prices, stage shares, settings or historical
orders. Events before rollout are not backfilled into this new ledger. Historical
production-lapse endpoints remain available with their compatibility fields;
new Performance responses contain no penalty amounts or percentages.

## Clocks and completion

A late finish is measured from the shop's committed internal `readyBy`, never the
padded client promise. Use the committed shop calendar, including a declared
extension in that snapshot. Later hours edits cannot alter existing commitments.
Older active orders without a shop clock receive a separate private Performance
calendar snapshot on first observation, using pre-edit hours if that observation
is an hours change; this does not alter their operational
clocks or committed dates. Closed time contributes zero. Temporary closure does
not pause an accepted job.

Exactly **60 shop minutes** after the deadline is within grace. Beyond grace:

| Shop time after ready-by | Tier |
| --- | --- |
| More than 1 hour, up to and including 6 hours | `minor` |
| More than 6 hours, up to and including 24 hours | `moderate` |
| More than 24 hours | `severe` |

The grace hour is a threshold, not a subtraction from `hoursLate`. Preserve exact
`workingLateMs` for calculations; `hoursLate` is rounded to four decimal places
for display. Tier comparisons use the unrounded elapsed time.

Version-2 finished-product submissions freeze the production endpoint while QA
is pending. Record completion only when approved, attributed to submission time;
rejected QA intervals are excluded in the same shop clock. Other handovers use
`readyAt`. One completed outcome exists per order and supplier, regardless of
repeated sweeps, reads or requests. In-progress legacy tier warnings can still
appear in the inbox; only completed outcomes count as late finishes here.

### Exemptions

- A client-accepted reschedule requested **before** the original ready-by uses
  the accepted renewed ready-by. There is no original-deadline late-finish count.
  A later breach of the renewed commitment is counted normally.
- Pending, declined or expired requests do not change the committed deadline.
  A request made at/after the original deadline cannot erase that miss from
  Performance even if later accepted; Performance uses its immutable original
  ready-by, while the operational order keeps the client-approved revised dates.
- A Super Admin no-fault event exempts that order/supplier pair from counts,
  on-time statistics, quality adjustment and Top Pick consequences. It can be
  recorded before or after completion. Existing notices remain visible and
  marked exempt. It does not rewrite dates, undo transfers or resolve work holds.
- Reviewed historical production-time corrections with `penaltyExempt` remain
  exempt. Declines with a reason code incur no money consequence, as do all other
  events in this release; they still count toward the three-decline warning.

## Rolling rules and Top Pick

Use the interval `(asOf - 30 calendar days, asOf]`; future events do not count.
The acceptance deadline remains the existing one-shop-hour deadline. It is not
replaced with a wall-clock timeout.

| Incident | Consequence within the rolling window |
| --- | --- |
| Decline | At 3, `repeated_declines` warning |
| Acceptance timeout | At 2, `repeated_timeouts` warning; at 3, hide from Top Pick for 7 calendar days |
| Late finish beyond grace | Written notice for every finish; at 2, hide for 7 calendar days; at 3, roster review |
| Cancellation after acceptance | Immediate `accepted_order_cancelled` warning; at 2, roster review |
| Arrived packed | At 2 distinct orders, `repeated_arrived_packed` warning |

Each further qualifying incident records a warning and, where applicable,
starts a new seven-day interval. A repeated request or lifecycle tick does not
start another interval. At the exact expiry the demotion ends, even while the
30-day count remains above threshold. Roster review is a flag based on current
counts, never an automatic suspension. A cancellation before acceptance counts
as a decline. Repeated arrived-packed reports for one order/supplier count once.

**Matching rule:** Top Pick hiding is a demotion. A hidden
shop is never Top Pick while an eligible unhidden shop can satisfy the request.
Hidden shops remain selectable in `otherListings`. If every eligible shop is
hidden, return the best-ranked hidden shop as Top Pick. Hiding alone never causes
`match_not_found`. Ranking and feasibility within each group keep their existing
strict priority; no weights or new response shape are introduced. Expiry needs
no background cleanup. No performance details are exposed to clients.

The existing quality adjustment also counts each non-exempt completed late order
once (two points, capped at ten), without double-counting its legacy lapse row.
No-fault decisions recompute consequences without deleting the underlying history.

## Read endpoints

| Method and path | Access | Body |
| --- | --- | --- |
| `GET /me/performance` | Supplier membership, own shop only | `{ performance }` |
| `GET /ops/shops/:supplierId/performance` | Operations or Super Admin | `{ performance }` |
| `GET /ops/shops/performance` | Operations or Super Admin | `{ shops: [performance, ...] }` |

Use `X-Gridgo-Role` for a selected role when needed. A different supplier cannot
read another shop's Performance. Private response headers include `no-store`.

Example `performance`:

```json
{
  "supplierId": "supplier_id",
  "asOf": "2026-11-02T04:00:00.000Z",
  "policy": "warnings_only",
  "windowDays": 30,
  "graceMinutes": 60,
  "counts": { "declines": 0, "timeouts": 0, "lateFinishes": 0, "cancellations": 0, "arrivedPacked": 0 },
  "rosterReview": false,
  "topPick": { "hidden": false, "hiddenUntil": null, "allHiddenFallback": true },
  "onTime": { "completed": 0, "onTime": 0, "late": 0, "rate": null },
  "warnings": [],
  "notices": [],
  "events": []
}
```

`warnings` contains recorded warnings in the last 30 days; `notices`
contains the complete written late-finish history; `events` contains all recorded
outcomes, incidents and no-fault declarations. All are newest first, with ID as
a stable tie-breaker. A notice can also occur in `warnings` and `events`; use its
`id` to deduplicate a combined view. Reads do not generate events.

`onTime.completed` includes only non-exempt completed outcomes in the window;
`onTime.onTime` includes finishes within grace. `rate` is the ratio from 0 through
1 (four decimal places), or null when there is no eligible completed work. It is
not based on open jobs, decline counts or the notification count.

Each event projection has:

```json
{
  "id": "performance_id",
  "orderId": "order_id",
  "kind": "late_finish",
  "at": "2026-11-02T03:00:00.000Z",
  "recordedAt": "2026-11-02T03:00:30.000Z",
  "reason": "Finished after the committed ready-by and one-hour grace window.",
  "reasonCode": null,
  "message": "Order order_id: finished 2 shop hours after the committed ready-by (minor). Reason: Finished after the committed ready-by and one-hour grace window. Warning only; no money is deducted.",
  "tier": "minor",
  "deadlineAt": "2026-11-02T01:00:00.000Z",
  "hoursLate": 2,
  "workingLateMs": 7200000,
  "graceMinutes": 60,
  "exempt": false,
  "exemptionReason": null,
  "warningCodes": ["late_finish"],
  "active": true
}
```

Kinds: `late_finish | on_time_finish | declined | timed_out | cancelled |
arrived_packed | no_fault`. Non-finish events have null timing/tier fields.
`at` is incident time; `recordedAt` is transaction time. `warningCodes` is the
immutable notice-time classification. `active` indicates whether its warning
still qualifies after exemptions; an exemption can also remove a repeated-event
threshold from a different notice. The current window is represented by `counts`
and `warnings`, not by an old notice's `active` value alone. No-fault history and
exempt notices remain reviewable. `message` is null for outcomes without a notice.

## No-fault declaration and reason codes

`POST /orders/:orderId/performance-no-fault` is **Super Admin only**:

```json
{ "reason": "Verified external interruption", "supplierId": "supplier_id" }
```

`reason` is required, trimmed, 1–2,000 characters. Optional `supplierId` defaults
to the currently assigned supplier; an explicit historical supplier must have a
Performance event on the order. The declaration applies only to that pair. A
retry returns the existing immutable declaration; it cannot replace its reason.
Success: `200 { performance }`. This is not a penalty dispute endpoint.

The existing `POST /orders/:id/decline` and `/shop-cancel` additionally accept
optional `reasonCode`, a lowercase snake-case identifier starting with a letter,
up to 64 characters. `reason` stays required; older callers remain compatible.
The code is retained in the failure and Performance record. Existing recovery,
replacement consent and refund behavior are unchanged.

## Errors, durability and app refresh

Errors use `{ "error": "snake_case" }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Missing/invalid authenticated session |
| 403 | `forbidden` | Wrong membership or no-fault caller is not Super Admin |
| 404 | `supplier_not_found` | Unknown/non-supplier read target, or unrelated no-fault target |
| 404 | `order_not_found` | No-fault order does not exist |
| 405 | `method_not_allowed` | Unsupported method for this endpoint |
| 400 | `reason_required` | Missing/invalid no-fault reason |
| 400 | `invalid_shop_reason_code` | Malformed optional decline/cancellation code |
| 409 | `performance_not_active` | Rollout marker is not yet effective |

Existing Clerk identity and role-selection errors still apply.

Mutation saves and the normal lifecycle sweep capture events under the existing
transaction/advisory lock. Event, audit, inbox and outbox writes commit atomically.
Every written notice goes to the supplier and **each** current Operations/Super
Admin membership as `supplier_performance_notice`; push keeps its existing data
allowlist. Order/job/catalog invalidations accompany the save. Refresh Performance
when this inbox event or related order/job invalidation arrives; refresh on view
focus to reflect time-window expiry. There is no direct push send in event code.

Late completion collection normally happens in the completing mutation; lifecycle
sweeps provide recovery. QA-approved late submissions are attributed to submission
rather than staff review time. Events predating rollout remain in their original
history and are not included in the new dashboard counters.
