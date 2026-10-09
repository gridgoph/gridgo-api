# Operating hours API

Server contract for [issue 203](https://github.com/gridgoph/gridgo-api/issues/203), report 46481879. Dashboard and mobile UI changes ship separately.

## Settings and editing

`GET /settings` requires authentication and returns the existing `version` and `settings`, plus `operatingStatus`. `PATCH /settings` remains Super Admin only, requires the current `expectedVersion` and a nonempty `reason`, and accepts the complete `operatingHours` object:

```json
{
  "expectedVersion": 42,
  "reason": "Office hours for launch",
  "operatingHours": {
    "timeZone": "Asia/Manila",
    "schedule": {
      "utcOffsetMinutes": 480,
      "week": [
        { "weekday": 1, "opensMinute": 480, "closesMinute": 1020 },
        { "weekday": 2, "opensMinute": 480, "closesMinute": 1020 },
        { "weekday": 3, "opensMinute": 480, "closesMinute": 1020 },
        { "weekday": 4, "opensMinute": 480, "closesMinute": 1020 },
        { "weekday": 5, "opensMinute": 480, "closesMinute": 1020 },
        { "weekday": 6, "opensMinute": 480, "closesMinute": 1020 }
      ],
      "closures": [{ "startDay": "2026-12-25", "endDay": "2026-12-26" }]
    },
    "artworkReviewMinutes": 60,
    "priorityDispatchCutoffMinute": 960
  }
}
```

Launch defaults: Monday–Saturday 08:00–17:00, no closures, 60 operating minutes for artwork review, and the separate 16:00 Priority dispatch cutoff. Sunday is weekday 0. Omit a weekday to close it. Times are integer minutes after Manila midnight. One daytime window per open day is supported; opening is inclusive and closing exclusive. A closing minute of 1440 means the end of that day. At least one weekday must open. Overnight and multiple daily windows are not supported.

Closure ranges include both dates and must be real `YYYY-MM-DD` dates. Each range and their combined distinct dates are limited to 90 days, with at most 100 ranges. This keeps the calendar walk bounded and allows every valid schedule to find an opening within a year. Review time is an integer from 1 through 540 minutes; cutoff is an integer from 0 through 1439. Zone and offset are fixed to Asia/Manila and 480. Bad values return `400 invalid_operating_hours`; stale/missing versions return `409 settings_version_conflict`; a missing reason returns `400 settings_reason_required`.

**Priority Delivery is not offered yet.** The cutoff is persisted and audited but unused. Do not introduce a `priority` or `express` service level or infer an offer from this setting. Cart service levels remain `standard | scheduled`.

Each successful edit increments the existing settings version and writes `settings.operational_update`, including `previous`, `current`, `reviewDelayedOrderIds`, actor and reason. Settings, delay tags, audit and realtime invalidations commit in the existing domain transaction. Migration `1791975800000` installs defaults only when absent and increments the settings version; it does not rewrite orders or penalties. Fresh reference seeding also supplies the defaults.

## Calendar and ready-by

`src/operating-hours.js` uses the shared calendar primitives in `src/availability.js`. All timestamps are ISO UTC instants. Local dates and windows use Asia/Manila (UTC+08:00, no daylight saving).

The estimate proceeds in this order:

1. Start review now if open, otherwise at the next opening.
2. Consume the configured review duration only while the platform is open. A review crossing close resumes at the next opening, skipping closed weekdays and closure dates. Seconds and milliseconds are retained.
3. Feed review completion into the existing shop queue, production duration, working-day calendar and capacity calculation. The shop's production calendar remains independent.
4. Consume the existing platform delivery/promise allowance in platform operating time after production. The existing `promiseAllowanceMinutes` value, or its established 600-minute fallback, is retained; no new delivery duration or fee is invented. A zero allowance still moves a closed-hours finish to the next dispatch window.

`readyBy` stored on an order remains the internal shop production deadline. `promiseBy` remains the immutable client promise including review, wait and delivery allowance. Client-facing listing and summary `readyBy` means this client promise; never display the internal shop deadline. Settings edits never silently amend a committed promise or its money/stage snapshots. Existing reschedule consent remains required to amend promises.

For example, with launch hours and a Monday closure, a Saturday 16:30:15 order completes its one-hour review Tuesday 08:30:15. One shop working hour of production completes Tuesday 09:30:15; a one-hour configured delivery allowance produces Tuesday 10:30:15 as the client promise.

## App and dashboard reads

The shared timing object contains:

| Field | Meaning |
|---|---|
| `timeZone` | `Asia/Manila` |
| `isOpenNow` | Whether the projection instant is within a platform window |
| `artworkReviewMinutes` | Configured operating duration |
| `scheduledReviewAt` | Now if open, otherwise the next opening |
| `reviewCompletesAt` | Review completion after consuming operating minutes |
| `reviewDelayed` | A closure delays review relative to the same week without closures |

This object is exposed as `operatingStatus` on `GET /settings`, `POST /me/matches` and `/me/matches/next`, `GET /me/deadline-days`, and cart responses. Match listings (including anonymous alternatives) carry `review` timing beside their `readyBy`. Existing catalog photo signing and compact cart mutation projections remain intact.

Cart groups carry `readyBy`, computed using the group's combined quantity and longest production duration, matching checkout's group projection. An unavailable group has `readyBy: null`. Cart responses contain `checkoutNotice: null` while open, otherwise `{code:"outside_operating_hours", ...timing, readyBy}`. Its ready-by is the latest group promise, or null if any group cannot be estimated. Show the review time and estimate; do not disable payment or automatic checks. Checkout recomputes feasibility, so a stale cart preview is not a reservation.

`GET /me/deadline-days?subcategoryCode=...&days=120` keeps `{days, earliest}` and adds `operatingStatus`. Days use Manila midnight boundaries independently of the server timezone. Each day has `day`, `state: "cannot" | "tight" | "open"`, and `reason`: null when reachable, `review_production_delivery_exceeds_deadline` before the earliest feasible promise, or `no_eligible_listing` when no eligible shop exists. Disable `cannot` dates and explain the reason. This remains a subcategory-level advisory calendar; final quantities, options, queue and deadline are checked again on match and checkout. A closed date can still be reachable if delivery can finish before it.

Related client/Operations/Super Admin order projections and checkout summaries expose `review` while the new order's file check is pending:

```json
{
  "status": "waiting_for_review",
  "label": "Waiting for review",
  "isOpenNow": false,
  "scheduledReviewAt": "2026-10-13T00:00:00.000Z",
  "reviewCompletesAt": "2026-10-13T01:00:00.000Z",
  "artworkReviewMinutes": 60,
  "timeZone": "Asia/Manila",
  "reviewDelayed": true,
  "originallyScheduledReviewAt": "2026-10-12T00:00:00.000Z",
  "outsideHoursNotice": "outside_operating_hours",
  "readyBy": "2026-10-13T08:00:00.000Z"
}
```

This is an additive presentation status. Lifecycle states and payment status keep their meanings; an order can still await payment confirmation. The Admin queue uses `scheduledReviewAt`; clients use the label. Pending work that has not actually been reviewed projects its next available window from the read time, not a claim that review has happened. Completed/failed/cancelled checks have no pending review projection. Internal clock/review snapshots and raw delay metadata are removed by the role-aware projection, and suppliers/riders do not receive this review object.

An edit that delays a pending review tags its order `reviewDelayed` in the same transaction, without moving its promise. Orders placed against an already-published closure also project the delay. The boolean is retained for that pending review once a settings change has tagged it. Clients/admin should display “review delayed” and the live scheduled review time. A passed review no longer displays the pending tag.

## Work gates and prospective SLA clocks

New orders snapshot an internal `operatingClock` with `version: 1`, settings version and schedule at creation. No migration or read path opts an old order into this clock. The snapshot governs:

- The shop's one-hour acceptance window.
- Production inactivity reminder initial/repeat/reset delays (including durations configured as seconds, minutes, hours or days; a day remains 24 hours of counted time).
- Production lateness: minor through six operating hours, moderate through 24, severe thereafter, with the existing no-communication rule. Payout assessment and release checks use the same clock.

This is a prospective calendar policy: later settings edits do not recalculate an existing order's clock, promises, warnings or deductions. Already-applied/closed lapse records retain the existing assessment guard and are never recomputed. Legacy orders keep their existing acceptance/shop-calendar, reminder/wall-clock and penalty/wall-clock behavior. This separation protects existing financial decisions while making the schedule editable for new orders.

For new orders, manual QA decisions from `needs_qa`, dispatch assignment/acceptance, and pickup checklist completion require the **current** platform window. Closed requests return `409 outside_operating_hours` with the next `scheduledReviewAt`. New unassigned dispatch offers are hidden while closed; assigned trips remain visible. Trips already picked up can continue and deliver after closing. Legacy in-flight orders retain their prior gates. Packing can finish while closed and await dispatch.

Payment submission/confirmation, automatic artwork structure checks, link probes and automatic specification validation remain available at any hour. The client's issue window, consent/offer expiries, and selection-token expiry remain wall-clock durations. Priority cutoff does not gate any current order.

## Verification

`tests/operating-hours.test.js` covers weekend/closure traversal, mid-window review crossing close, second-precision SLA boundaries, legacy clocks, role-safe projections and delayed-review tags. PostgreSQL API tests exercise the settings handshake, authorization, durable audit, immutable order snapshots and manual-work refusal. Run migrations, seed and the full suite against a dedicated test database; never the development database.
