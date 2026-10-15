# Shop hours

Backend contract for report **4B4D2591**. Supplier, client and dashboard screens
are companion releases. No schema migration is needed: weekly hours, closures
and the current extension use `supplier_profiles.schedule` JSONB, temporary
closure uses the existing `is_closed`, and order clocks use `orders.data`.

## Supplier and dashboard routes

All routes require Clerk authentication and the indicated database role.

| Route | Role | Response/action |
| --- | --- | --- |
| `GET /me/shop-hours` | Supplier | Own `{ hours }` |
| `PATCH /me/shop-hours` | Supplier | Edit own base schedule, temporary closure, extension |
| `GET /ops/shops/hours` | Operations/Super Admin | `{ shops: [{ supplierId, shopName, hours }] }` |
| `GET /ops/shops/:supplierId/hours` | Operations/Super Admin | One shop's `{ hours }` |
| `PATCH /ops/shops/:supplierId/hours` | Operations/Super Admin | Temporary closure only, with required `reason` |

PATCH requires integer `expectedVersion` matching the supplier profile's shared
version. The response contains the next version. Concurrent/stale writes return
`409 supplier_profile_stale`. Existing `/me/supplier-profile` writes share this
version, so refresh after either editor saves. Fields omitted from a PATCH are
preserved. Example supplier body:

```json
{
  "expectedVersion": 1,
  "schedule": {
    "utcOffsetMinutes": 480,
    "week": [
      { "weekday": 1, "opensMinute": 480, "closesMinute": 1080 },
      { "weekday": 2, "opensMinute": 480, "closesMinute": 1080 },
      { "weekday": 3, "opensMinute": 480, "closesMinute": 1080 },
      { "weekday": 4, "opensMinute": 480, "closesMinute": 1080 },
      { "weekday": 5, "opensMinute": 480, "closesMinute": 1080 },
      { "weekday": 6, "opensMinute": 480, "closesMinute": 1080 }
    ],
    "closures": [{ "startDay": "2026-12-24", "endDay": "2026-12-26" }]
  },
  "temporarilyClosed": false
}
```

Weekday 0 is Sunday; omitted weekdays are closed. A base schedule needs at least
one open day. Asia/Manila (UTC+08:00) is fixed. Closure dates are real inclusive
calendar dates, at most 100 ranges and 90 distinct dates in total. Invalid
calendars return `400 invalid_shop_hours` with a displayable `message`.

**Launch restriction approved for this release:** every base open day must have
the same total open minutes. Unequal totals return
`409 production_day_length_unavailable` with a displayable message. Shops may
move opening/closing times while preserving that daily total. This preserves
the existing meaning of day-based listing durations; shorter Saturdays require
a later product decision. The response's `features` flags are all false:
`multipleWindows`, `overnightWindows`, `riderShifts`, `hubDays`. This release
accepts only one daytime window per day and exposes no switch to enable these
advanced controls. Existing low-level split-window support remains compatible.

Staff may send only `expectedVersion`, `temporarilyClosed`, and `reason`;
attempting to edit hours or extensions returns `403 forbidden`. A trimmed
nonempty reason, maximum 2,000 characters, is required (`400 reason_required`).
Suppliers may supply an optional reason. Unknown fields are rejected.

## Same-day extensions

PATCH `/me/shop-hours` with `{ "expectedVersion": 2, "extension": {
"closesMinute": 1200 } }` declares today's extra hours until 20:00 Manila.
Optional `extension.day` must be today's local date. The close must be later
than the normal close, before midnight (maximum 1439), and at least **30 minutes**
from the request instant. Exactly 30 minutes is accepted; seconds are preserved
in that check. The date must already be an open weekday without a dated closure;
a temporarily closed shop must reopen first. Invalid declarations return
`400 invalid_shop_extension`, or `409 shop_closed` for temporary closure.

The supplier can edit the extension under the same rules, or remove it by
sending `extension: null`. A base-schedule replacement clears the prior
extension; a new extension can accompany that replacement. A declaration made
after normal closing starts at the declaration's next whole minute, so the
closed gap never becomes retroactive working time. Extensions do not alter the
base working-day divisor. The dated record expires automatically for scheduling
and status after its date; no cleanup job is required. A later declaration
replaces it, while audit history and committed order snapshots retain it.

Existing committed orders keep their accepted dates and clock, including any
extension they were priced against. Later edits/removal do not revoke that
commitment. New matching/cart/checkout calculations use the current declaration
and revalidate the requested deadline at checkout.

## Status and closed-shop discovery

`hours` contains `timeZone`, base `schedule`, `version`, `temporarilyClosed`,
`isOpenNow`, `calendarAvailable`, `nextOpeningAt`, `todayExtension`, `dispatchNotice`, and `features`.
`todayExtension` is null or `{ day, opensMinute, closesMinute }`. `nextOpeningAt`
is now while open, the next scheduled opening while closed, or null while
indefinitely temporarily closed (or when no opening exists within a year). An
invalid legacy calendar projects `calendarAvailable: false`, `isOpenNow: false`
and null next opening; reads remain available while scheduling still refuses it.

Catalog shop detail/list and match shop cards add `hours`. Full public listings
add `shopHours`; compact cart mutation listing stubs remain compact. Closed
shops remain in catalog discovery. Ordinary closed weekdays/dates can still
match when the future promise fits the requested deadline. Temporarily closed
shops cannot receive new matches/checkouts or new manual assignments, but keep
their catalog presence and existing commitments. Already-committed matched
orders can still be handed to their shop after review.

If today's extension reaches beyond GRIDGO hours, or is declared while GRIDGO
is closed, `dispatchNotice` is `review_and_dispatch_in_next_working_window`.
Supplier/dashboard copy: “Review and dispatch resume in the next working
window.” This is a warning, not a prohibition on production outside hours.

## One ready-by calculation and independent clocks

The shared `projectShopFinish` remains the calculation for match listings,
cart previews, checkout and recovery proposals:

1. Wait for the next GRIDGO review window and consume configured review time.
2. Consume queue and production in the shop's weekly hours, dated closures and
   declared extension, retaining existing capacity-day constraints.
3. Consume the existing delivery/promise allowance in GRIDGO operating hours,
   which remain the delivery calendar at launch. Zero allowance still waits
   for a dispatch opening. Separate rider shifts and hub days remain off.

No fee, delivery duration, payout share or money policy changes. The order's
internal `readyBy` is its shop deadline; `promiseBy` is the client commitment.
Client listing/checkout `readyBy` continues to mean the client promise. The
dashboard reads those same stored dates, not a fresh calculation from edited
hours. Historical dates never change without the existing consent flow.

Only orders created by this release get internal `shopClockVersion: 1`.
Checkout snapshots `shopClock` with the supplier ID, profile version and
calendar. The legacy order-creation route waits until supplier assignment to
snapshot it. Client-approved replacement snapshots the new supplier's calendar.
The snapshot governs the one-hour acceptance window, production inactivity
grace/repeats, and production lateness. Closed time contributes zero. Rejected
QA wait is credited in that same shop clock so staff review cannot create shop
lateness. GRIDGO review/dispatch continue to use GRIDGO hours.

No migration, read, hours edit or lifecycle sweep opts an older order into this
policy. Orders with the earlier `operatingClock` retain it; older orders retain
their previous behavior. Applied/closed lapse records are still never
reassessed. Temporary closure does not pause an existing commitment or erase
penalties; use the established recovery/reschedule process when it cannot be
met. Production actions outside hours remain available under their normal
proof/authorization gates; undeclared extra hours never shorten a quote.

New-order owning-client and staff projections add `readyEarly` and `readyLabel`.
Once completed production is recorded before the internal shop deadline, these
are `true` and `"Ready early"`; otherwise `false` and null. This label does not
promise immediate dispatch. Internal shop clock/version are stripped from all
ordinary order responses; the client never receives the internal deadline.

## Transaction, audit and notifications

Each write uses the existing domain transaction and advisory lock. The profile,
append-only `supplier_hours.update` audit (before/after schedule, closure,
version, actor and reason) and durable `supplier_hours_updated` inbox rows commit
together. Recipients are the owning supplier plus every current Operations and
Super Admin membership. Catalog/notification invalidations are queued before
`save()`; push/outbox delivery happens after commit. No direct delivery occurs
inside the hours handler. Historical audit rows cannot be edited or deleted.
