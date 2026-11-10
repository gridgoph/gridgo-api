# Google Play tester program

This program tracks GRIDGO check-ins for explicitly enrolled accounts, separately
from Founding Tester, referrals and vouchers. Apply migration
`1794065000000_tester_program` before starting this API. Migration and reference
seed enroll nobody. The optional [Play opt-in campaign](PLAY_OPTIN_API.md) adds group joining,
Android broadcasts and enrollment from Play-install reports. There are no
scheduled server reminders, order hooks, or changes to order processing.

All routes require a Clerk session and database memberships. App values are
`client`, `supplier`, `rider`. Each `/me` request requires the corresponding app
membership and always addresses the authenticated account; supplied user IDs,
phone dates and time zones cannot select another account or day. Account holds
and `X-GRIDGO-Role` restrictions follow existing authenticated routes.
Operations and Super Admin memberships may use `/ops/testers`. Existing review
Operations accounts remain subject to their default-deny allowlist and receive
`403 test_operations_forbidden` on all these routes, including settings. A review
Super Admin retains its existing Super Admin authority.

## App routes

`GET /me/tester-program?app=client` returns `200 {"enrolled":false}` for an
unenrolled account, or:

```json
{
  "enrolled": true,
  "app": "client",
  "day": 3,
  "streak": 3,
  "checkedInToday": true,
  "runComplete": false,
  "stopped": false,
  "productionApproved": false,
  "manilaDate": "2026-11-07",
  "nudge": {"trigger": "streak_3"}
}
```

`POST /me/tester-program/check-in` accepts:

```json
{"app":"client","version":"1.2.3 (45)","source":"open"}
```

`source` is `open` or `button`; `version` is a nonempty string up to 100
characters with no control characters. Returns the same state shape as GET.
Unenrolled callers receive `404 not_enrolled`. GET itself does not check in.

The server computes the calendar date in Manila (UTC+8) after taking the
transaction lock. The database enforces one daily record per account/app/date.
Retries, concurrent devices and API replicas preserve the first version, source
and check-in time; only `latest_seen_at` advances. Explicit re-enrollment may link
the same daily record to a new enrollment without duplicating it.

`streak` counts consecutive checked days ending today or yesterday. If today is
not checked, `day` is the next day to check (minimum 1); otherwise it includes
today. A gap resets `streak` to 0 and the next `day` to 1. A successful fourteenth
consecutive check-in permanently completes that enrollment: `runComplete=true`,
`streak=day=14`, `stopped=true`. Later opens do not add check-ins. Production
approval also sets `stopped=true` and stops new check-ins, without claiming the
run completed. `productionApproved` is true only when production approval is set
for the requested app, independently of `runComplete`. Apps must hide every
feedback ask when it is true, including a day-14 feedback card already held
locally after reporting `shown`. Apps cancel local reminders on `stopped` or
unenrollment. Daily 7PM and next-morning local reminders belong to the apps; no server push is sent.

`POST /me/tester-program/feedback` accepts:

```json
{"app":"client","event":"shown","trigger":"streak_3"}
```

Returns `200 {"ok":true}`. Events are `shown`, `tapped`, `dismissed`; there is no
`done` event or claim that feedback was submitted. Allowed trigger strings are
`streak_3`, `streak_7`, `streak_10`, `streak_14`, `completed_order`.

Render only the server-returned nudge, then report `shown`. Milestone nudges are
eligible on their checked-in day; a completed run can still offer its day-14
feedback card. Completed-order eligibility observes an existing completed or
payout-released order related to this app/account, updated after enrollment and
the previous shown prompt. It never changes that order. Each order can trigger
at most one completed-order prompt per account/app. Milestones take priority.

The server permits at most one shown prompt per rolling **72 hours** per
account/app, across enrollment runs. A tap permanently suppresses future nudges
for that account/app, including after re-enrollment. Production approval hides
all new nudges. `nudge` is otherwise null. Shown retries for the same live prompt
and repeated tapped/dismissed reports are idempotent. Tapped/dismissed must refer
to the latest shown trigger in the current enrollment. Unavailable shown nudges
return `409 nudge_not_available`; events without a matching shown prompt return
`409 feedback_not_shown`.

Feedback cards are dismissible, optional, unrewarded links to the Play testing
feedback/store page. They must never invoke in-app review from a tap. This API
makes no assertion that Google received feedback.

## Operations routes

`GET /ops/testers?app=client` returns:

```json
{
  "app":"client",
  "stats":{
    "activeToday":1,"fullStreak":0,"needed":12,
    "playClockStartDate":"2026-11-01","optedInCount":13,
    "productionApprovedAt":null
  },
  "testers":[{
    "userId":"user_internal","name":"Tester","email":"tester@example.com",
    "role":"client","addedAt":"2026-11-01T00:00:00.000Z",
    "day":1,"streak":1,"lastCheckInDate":"2026-11-07",
    "latestVersion":"1.2.3 (45)","stoppedCheckingIn":false,
    "days":[{"date":"2026-10-25","state":"before_start"}],
    "feedback":{"shownCount":0,"tappedAt":null,"dismissedCount":0}
  }]
}
```

The example abbreviates `days`: the real response always has exactly **14**
chronological entries, oldest first. It ends today for an unfinished enrollment,
or on the completion date for a completed run (so completion stays visible).
A date before enrollment is `before_start`; a recorded day is `checked_in`;
today without a check-in is `today`; an elapsed unchecked day is `missed`.
Dates before a current streak can be red without affecting the independently
entered Play clock. `role` is the enrollment app's membership, including for
accounts with multiple memberships.

`activeToday` counts current enrollments checked in today; `fullStreak` counts
completed current enrollments. `stoppedCheckingIn` means an unfinished,
non-production-approved enrollment has no check-in for at least three Manila
calendar days (measured from enrollment if never checked in). It is **not**
evidence of leaving Google's track. Feedback totals span this account/app's
retained history; `latestVersion` is the first reported version on its latest
checked day in the current enrollment.

`POST /ops/testers {"app":"client","email":"tester@example.com"}` explicitly
adds an existing GRIDGO account. Email matching is case insensitive and exact
(no substring or provider alias matching). Returns `200 {"ok":true}`.
Errors: `400 invalid_email`, `404 user_not_found`, `400 role_mismatch`,
`409 already_enrolled`; an ambiguous legacy email yields `409 ambiguous_email`.
Role matching uses database membership rows, never the legacy role column or
Clerk claims. It does not create identities or enroll anyone in Google Play.

`DELETE /ops/testers/:app/:userId` returns `200 {"ok":true}`, ending the active
enrollment while preserving check-ins and feedback. Missing active enrollment
is `404 not_enrolled`. Re-adding creates a fresh enrollment with no completed
run or checked days, until a new explicit check-in. Earlier days do not count.

`PATCH /ops/testers/settings` accepts:

```json
{
  "app":"client",
  "playClockStartDate":"2026-11-01",
  "optedInCount":13,
  "productionApprovedAt":null
}
```

All fields except app are optional. Dates are real `YYYY-MM-DD` dates (or null);
count is a nonnegative PostgreSQL integer; approval is an ISO timestamp no later
than server time (or null). Omitted fields retain their values. Clearing approval
resumes unfinished enrollments; completed runs stay complete. Returns
`200 {"ok":true}`. These settings belong only to this program, with the Ops access
specified here; they do not modify Super Admin platform settings.

Enrollment, removal and settings writes append `tester_program.enrolled`,
`tester_program.removed`, `tester_program.settings_updated` audit events in the
same locked transaction. Own telemetry writes no notifications. Reads are
private, noncached database snapshots. Invalid app values return
`400 invalid_app`; unauthenticated callers receive 401 and wrong memberships
receive `403 forbidden`. Input-specific errors use snake_case error bodies.

## Google and shared-contract details

Checked 7 November 2026: Google's
[`edits.testers` resource](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers)
exposes `googleGroups[]` and explicitly does not support individual email lists.
It provides no per-person continuous opt-in status. The dashboard must label the
GRIDGO daily streak separately from the manually entered Google Play continuous
opt-in clock, and must not label red days as resets of Google's clock.

The shared spec's route and projection shapes are preserved. Clarifications for
companion consumers: trigger strings above; successful staff/feedback writes use
`200 {"ok":true}`; cooldown is rolling 72 hours; the 14 boxes freeze on completion;
test Operations follows its existing default deny. The additive
`productionApproved` field distinguishes approval from run completion; no Google
integration was added.
