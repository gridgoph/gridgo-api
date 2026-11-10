# Google Play closed-test campaign

Additive to [Tester program](TESTER_PROGRAM_API.md); no order-flow changes.
Apply migration `1794286800000_play_optin_campaign`. It inserts missing per-app
settings with `campaignEnabled=false`, `target=12` and
`https://play.google.com/apps/testing/ph.gridgo.<app>`. It enrolls nobody and sends
nothing. Reference seed does not reset these settings.
Apply `1794314000000_play_optin_daily_reminders` before this API release. It adds
per-app daily reminder settings and durable daily run/recipient records; existing
campaigns keep their enabled state. Daily reminders default on at 10 AM Manila,
but disabled campaigns send nothing. Prior manual campaign notifications are
backfilled into the daily recipient ledger to prevent deployment-day duplicates.

## API contract

All routes require a Clerk session and database membership. `app` is `client`,
`supplier`, or `rider`. `/me` requires that app membership; Operations and Super
Admin may administer `/ops/testers`. Account holds, explicit `X-GRIDGO-Role`, shop
owner restrictions and review-Operations default deny remain in force. All
responses are private and noncached. Errors use `{ "error": "snake_case" }`.

`GET /me/play-optin?app=client&platform=android&channel=sideload` returns:

```json
{
  "app":"client","show":true,"step":"confirm_gmail",
  "gmailSuggestion":"tester@gmail.com","groupMode":"link",
  "campaignEnabled":true,"optInUrl":"https://play.google.com/apps/testing/ph.gridgo.client",
  "groupJoinUrl":"https://groups.google.com/g/example-testers","target":12,
  "optedIn":false,"dismissCount":0,
  "playStoreUrl":"https://play.google.com/store/apps/details?id=ph.gridgo.client"
}
```

`platform` is `android | ios | web`; `channel` is `play | sideload` (apps map their
APK distribution to `sideload`; device registration retains its existing `apk`
value). Both are required on GET and every own POST below. GET records the
install report under the transaction lock. An Android `play` report, or an
existing Android Play device registration scoped to this account and app,
permanently records `optedIn=true` with source `play_channel`. It idempotently
enrolls the account/app if staff has not previously removed it from the program. It does not check in. Existing
active enrollments and completed runs are preserved. Operations removal still
requires explicit re-enrollment through `POST /ops/testers`, even when removal
precedes the first Play detection or staff opt-in mark. Opt-in is recorded
without restarting the removed tester program; active runs are preserved.

`show` is true only for Android, non-Play, campaign enabled, no production
approval, no recorded opt-in or known same-app Android Play install, and fewer
than three dismissals. A known Play registration also refuses campaign POSTs
before Home refreshes; another account/app or an unscoped/non-Android device
does not count as this app's Play install. Card and push taps
open this flow. Always honor `show`; do not infer eligibility from cached local
state. An old APK reporting again never clears an earlier opt-in. Install reports
are app telemetry, not Google verification and never an authorization grant.

`step` is `confirm_gmail | join_group | open_optin | install_from_play | opted_in`.
Show the short copy **Help us launch GRIDGO on Play, become a tester.**

`POST /me/play-optin/confirm-gmail`:

```json
{"app":"client","platform":"android","channel":"sideload","email":"tester@gmail.com"}
```

Returns the GET shape with the updated email and step. Gmail and Googlemail
addresses are accepted. A Google-hosted/custom address requires the additional
explicit assertion `"googleAccount":true`; this is user confirmation, not email
ownership verification. No Google password or code is collected. Invalid input
is `400 invalid_gmail`.

- `groupMode=automatic`: the configured Google client adds a MEMBER, accepting
  an already-member response. Success records `group_joined_at` and returns
  `step=open_optin`. A provider failure is `503 google_group_unavailable`, leaves
  the email/group step unchanged, and may be retried. Never silently claim
  success or fall back when configured credentials fail.
- `groupMode=link`: returns `groupJoinUrl`, `step=join_group`. Open that URL,
  tell the user to join using the confirmed Google account, then offer the Play
  opt-in link. A missing URL is `409 group_not_configured`. Link opening is
  recorded separately and never called verified group membership or opt-in.

`POST /me/play-optin/event`:

```json
{"app":"client","platform":"android","channel":"sideload","type":"tapped"}
```

Types: `shown`, `tapped`, `dismissed`, `group_opened`, `optin_opened`. Return
`200 {"ok":true}`. Report `tapped` on either push/card entry, before Gmail input,
so abandoned input is visible to Operations. Report link events when opening
the respective URL. `shown`/`tapped`/link events preserve their first timestamp;
`dismissed` increments up to three. Send it once per dismissal (it is not a
retry-idempotent counter). After the third, GET hides the card. Unavailable
campaign writes return `409 campaign_not_available`; report an install first
(`409 install_not_reported`). Group/opt-in links require confirmed Gmail
(`gmail_not_confirmed`), and opt-in opening requires a group add or group-link
opening (`group_step_required`). Opening Play alone never marks opted in.
If the confirmed email changes, old link steps are cleared.

After `optin_opened`, prompt the APK user to become a tester **and install from
Play**, using `playStoreUrl`. On a subsequent Play-build GET, the card hides and
existing `/me/tester-program` check-ins and app-owned 7 PM reminders take over.
Google exposes no per-user opt-in feed here; an APK user who opted in in the
browser but has not installed from Play remains unfinished until a Play report
or staff confirmation. Staff must reconcile this with the Play Console count.

## Operations and broadcast

`PATCH /ops/testers/settings` retains existing fields and adds optional
`campaignEnabled` (boolean), `optInUrl` (HTTPS Play `/apps/testing/<package>` URL),
`groupJoinUrl` (HTTPS `groups.google.com/g/...` or managed-domain `groups.google.com/a/<domain>/g/...` URL or null), and `target`
(integer 1–10000), `dailyReminderEnabled` (boolean, default true), and
`dailyReminderHour` (integer 0–23, default 10, Asia/Manila), alongside required `app`. Omitted values stay unchanged.
`optedInCount` remains the manually entered Play Console figure. This is tester
configuration, with the existing Operations/Super Admin access and audit.

`GET /ops/testers?app=client` retains `stats` and `testers`; `stats.needed` now
uses the configured target. Adds:

```json
{
  "playOptIn":{
    "campaignEnabled":false,"target":12,"groupMode":"link",
    "dailyReminderEnabled":true,"dailyReminderHour":10,
    "optInUrl":"https://play.google.com/apps/testing/ph.gridgo.client",
    "groupJoinUrl":null,"optedInCount":1,"detectedPlayCount":1,
    "playConsoleOptedInCount":5,
    "unfinished":[{"userId":"internal-user","name":"Tester","app":"client",
      "gmail":"tester@gmail.com","lastStep":"install_from_play","at":"2026-11-10T08:00:00.000Z"}]
  }
}
```

`playOptIn.optedInCount` counts app reports plus staff confirmations;
`detectedPlayCount` counts opt-ins first detected from a Play report or known
app-scoped Android Play registration (`play_channel` source). These are
GRIDGO signals, not a replacement for Google's authoritative Console figure.
Label that figure separately. `unfinished` contains at most 500 newest users
who tapped/confirmed/opened but lack opt-in, sorted by last activity; Gmail may
be null before confirmation. Dismissed users remain visible for follow-up.

`POST /ops/testers/:app/:userId/opt-in {}` manually confirms an existing member
and enrolls them if they have never been explicitly removed, without altering
an active run. Use `POST /ops/testers` to re-enroll a removed tester. Returns
`200 {"ok":true}`; missing membership is `404 user_not_found`. Confirmation is sticky and audited.

`POST /ops/testers/broadcast {"app":"client"}` returns `201 {"announcement":...}`
with existing announcement metadata/counts. Requires enabled campaign and group
configuration (`409 campaign_disabled` / `group_not_configured`). A completed
target returns `409 campaign_target_reached`. Trigger client and supplier first;
enable/trigger rider separately later. Each POST records an announcement, but
recipients already queued a campaign push for this app on this Manila date are
excluded (including automatic reminders); its notified count can be zero.

The existing API lifecycle scheduler automatically records one reminder run per
app per Manila date, at or after `dailyReminderHour`, while
`dailyReminderEnabled` and `campaignEnabled` are true. A restart after that hour
catches up the current day only; earlier dates are never replayed. The scheduler
refreshes its timestamp after acquiring the domain lock and rechecks that day's
hour and eligibility. A lock wait across midnight cannot consume yesterday's slot;
if the new day is before the configured hour, it waits for that hour. Each app stops
when production is approved or either its recorded opt-in count or the manually
entered Play Console `optedInCount` reaches `target` (12 by default). Group
configuration is required, just as for manual broadcasts. Disabling daily
reminders leaves manual broadcasts available.

Automatic reminders use the same copy, `play_optin` deep link, announcement audit,
inbox and committed push outbox as the manual broadcast. Daily run records,
per-person/app/date recipient claims, notifications and the outbox commit in one
transaction under the domain lock. Before claiming recipients, both new manual
and scheduled sends reconcile that app/day's existing `play_optin` notifications
into the recipient ledger. This also covers an old server's manual broadcast
committed after the migration backfill but before replacement. Competing API
instances, retries and restarts cannot enqueue another campaign push for that
person/app/day. A failed transaction
rolls back the run and may retry; a committed run never runs again that day. A
manual broadcast before the reminder consumes the same recipient's daily slot;
a later manual broadcast can reach newly eligible people but cannot notify the
same recipient again that day. This is daily enqueue idempotency; transport
retries retain the existing push outbox delivery guarantees.

It reuses announcement inbox/audit and the committed push outbox, with
notification `type=play_optin`, `appRole=<app>`, the fixed campaign copy, and no
order reference. The existing push data allowlist is unchanged (`type`,
`notificationId`, `at`); each app routes `type=play_optin` to its own campaign.
Only accounts with the selected membership and an explicitly app-scoped Android
non-Play device qualify; no anonymous, unknown-app, iOS, web, or other-app push.
Any recorded opt-in, Play install of that app, or third dismissal excludes the
account. The outbox rechecks device/channel/campaign/opt-in, dismissals and target before delivery and
retry. Campaign broadcasts do not invoke order maintenance.

## Deployment compatibility

Keep each campaign disabled (`campaignEnabled=false`) while replacing an API
version that lacks daily recipient deduplication. Stop all old API instances
before re-enabling campaigns on the new version. Do not leave old manual
broadcast writers running alongside the enabled new scheduler: an old writer
cannot consult the new ledger and could send after a new instance has already
claimed that day's slot. New instances reconcile old notifications already
committed, including those written after migration, but cannot fence a future
write from an old binary. Apply the migration before starting the new version;
resume the desired per-app campaign switches only after replacement completes.

## Setup required from the operator

1. Add each app's tester group to that app's closed track in Play Console. Check
   the default package URLs above, and set the actual Google Group join URL per
   app through tester settings. Configure groups to admit the intended external
   Google accounts. The no-credentials mode works with a consumer Google Group
   allowing self-join; users must complete Join group themselves.
2. Automatic adds require a **Google Workspace or Cloud Identity managed group**
   accessible through the Admin SDK Directory API, not a consumer Google Group.
   A domain administrator enables Admin SDK, creates a service account with
   domain-wide delegation, authorizes only the
   `https://www.googleapis.com/auth/admin.directory.group.member` OAuth scope,
   and supplies a delegated administrator with group-member management rights.
   Configure these server-only environment variables securely (never in settings,
   source, logs, mobile builds, or the PR):

   ```text
   PLAY_TESTER_GOOGLE_CLIENT_EMAIL
   PLAY_TESTER_GOOGLE_PRIVATE_KEY
   PLAY_TESTER_GOOGLE_ADMIN_EMAIL
   PLAY_TESTER_GROUP_CLIENT
   PLAY_TESTER_GROUP_SUPPLIER
   PLAY_TESTER_GROUP_RIDER
   ```

   Private key accepts PEM newlines or literal `\n`. Group variables are the
   respective Directory group email/key. Automatic mode is selected per app
   only when all shared credentials plus that app's group key are configured;
   otherwise the configured join URL is used. Keep the join URL available as
   the operational fallback. Credential rotation takes effect on API restart.
3. Set the Console count (currently operator-reported), target, and URLs through
   `/ops/testers/settings`; enable client/supplier only when companion builds
   support this contract. Daily reminders start automatically at the configured
   Manila hour while enabled; manual broadcasts share the daily recipient limit.
   Enable riders later.
   Establish the 14-day Play clock from Play Console, independently of daily
   GRIDGO check-ins; this API cannot establish continuous Google opt-in days.

Google references: [Directory members.insert](https://developers.google.com/workspace/admin/directory/reference/rest/v1/members/insert),
[service account delegation](https://developers.google.com/workspace/guides/create-credentials).
