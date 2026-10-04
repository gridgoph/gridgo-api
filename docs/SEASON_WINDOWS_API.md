# Season windows API

Season windows are public awareness messages written by Super Admin. They never
change matching, checkout, supplier availability, fees, or which deadlines can be
booked. Overlapping windows are valid and returned independently.

## Dates and banner timing

`startDate` and `endDate` are real `YYYY-MM-DD` calendar dates, inclusive, in
`Asia/Manila` (UTC+08:00). Demand levels are exactly `Normal`, `Busy`, or `Peak`.
Names are trimmed, required, and at most 120 characters; messages are trimmed,
required, and at most 500 characters. An end date cannot precede its start date.

The server calculates the banner interval as **start minus 42 days through start
minus 28 days, inclusive** (six to four weeks before the season). At Manila
midnight immediately after the interval's end date it stops being active.
`banners` contains every window whose interval includes `today`, in start-date/ID
order. Clients can dismiss a banner locally by its window ID. Calendar consumers
use `windows`, not `banners`; current windows remain available through their
inclusive end date. There is no single-window precedence when intervals overlap.

## Public read

`GET /season-windows` requires no token. It returns current and upcoming windows;
past windows and internal scheduling fields are omitted. Empty results keep the
same envelope, with both arrays empty. The server clock supplies `today`; there
is no caller-supplied date override.

```json
{
  "timeZone": "Asia/Manila",
  "today": "2026-10-02",
  "awarenessOnly": true,
  "windows": [{
    "id": "sea_example",
    "name": "School season",
    "startDate": "2026-11-13",
    "endDate": "2026-11-30",
    "demandLevel": "Peak",
    "message": "Plan your printing early.",
    "status": "upcoming",
    "banner": {
      "startDate": "2026-10-02",
      "endDate": "2026-10-16",
      "active": true
    }
  }],
  "banners": [{
    "id": "sea_example",
    "name": "School season",
    "startDate": "2026-11-13",
    "endDate": "2026-11-30",
    "demandLevel": "Peak",
    "message": "Plan your printing early.",
    "status": "upcoming",
    "banner": {
      "startDate": "2026-10-02",
      "endDate": "2026-10-16",
      "active": true
    }
  }]
}
```

`status` is `upcoming | current` on this public endpoint. Both arrays carry the
same public window shape. These messages are public: never include private order
or account details in them.

## Super Admin editor

All `/admin/season-windows` routes require a Clerk bearer with a current database
`super_admin` membership. Operations, client, supplier and rider alone cannot
use them. An explicitly selected `X-Gridgo-Role: client` (or other non-Super
Admin role) also cannot use a second Super Admin membership. Missing authentication returns `401`; insufficient membership returns
`403 forbidden`. Clerk role claims never authorize these routes.

| Method/path | Request | Success response |
| --- | --- | --- |
| `GET /admin/season-windows` | None | `200` public envelope with `windows` containing **all** windows, including past, plus admin fields below; `banners` retains the public active subset |
| `POST /admin/season-windows` | `{name,startDate,endDate,demandLevel,message}` | `201 {window}` with admin fields |
| `PATCH /admin/season-windows/:id` | `{expectedVersion,...changed fields}` | `200 {window}` with admin fields |
| `DELETE /admin/season-windows/:id` | `{expectedVersion}` JSON body | `200 {ok:true}` |

Admin window fields additionally include `version` (positive integer),
`noticeQueuedAt` (ISO instant or null), `createdAt`, and `updatedAt` (ISO instants).
Admin `status` can also be `past`. New windows start at version 1. Edits and
scheduler enqueue each increment the version; deletion requires the latest
version. Missing/stale versions return
`409 {error:"season_window_version_conflict",version:<current>}`. Unknown IDs
return `404 season_window_not_found`; invalid fields return
`400 {error:"invalid_season_window",field:<field>}`. Caller fields cannot set IDs,
versions, timestamps, or clear the once-only marker.

Create, edit, delete and push-setting changes write audits and durable silent
inbox rows for both Operations and Super Admin memberships, plus a `settings`
invalidation. No client push occurs when an editor saves a window.

## Push setting and dry run

**Sending is OFF by default.** Missing settings also mean off. The forward
migration and fresh reference seed set `{enabled:false,version:1}`. No window is
seeded. Generic `PATCH /settings` cannot change this switch.

| Method/path | Request | Success response |
| --- | --- | --- |
| `GET /admin/season-windows/push-settings` | None | `200 {enabled:false,version:1}` initially |
| `PATCH /admin/season-windows/push-settings` | `{enabled:<boolean>,expectedVersion:<integer>,reason:<1–500 chars>}` | `200 {enabled,version}`; audit and version increment |
| `POST /admin/season-windows/push-dry-run` | `{}` or empty body | `200` counts below; **no mutations, enqueue or sending** |

All three are Super Admin only. Setting version conflicts use the same `409`
shape. Invalid booleans return `400 invalid_season_push_setting`; an empty or
oversized reason returns `400 season_push_reason_required`.

Example dry run (works while disabled):

```json
{
  "enabled": false,
  "version": 1,
  "timeZone": "Asia/Manila",
  "today": "2026-10-02",
  "eligibleClients": 24,
  "eligibleDevices": 30,
  "windows": [{
    "id": "sea_example",
    "name": "School season",
    "banner": {"startDate":"2026-10-02","endDate":"2026-10-16","active":true},
    "noticeQueuedAt": null,
    "due": true,
    "wouldNotifyClients": 24,
    "wouldNotifyDevices": 30
  }]
}
```

Counts use current database client memberships, active accounts, and registered
claimed devices for the client app (or legacy devices without an app role).
Registering a token through authenticated `/devices` is the existing indication
that a handset allowed notifications. Clients should unregister when permission
is revoked. No separate preference system is introduced. Anonymous handsets,
non-client app registrations, suspended/removed accounts, and clients without a
registered eligible handset are excluded. A client with several devices counts
once as a client and once per eligible device. Tokens and identity details are
never returned. Stale registrations can still overstate delivery; these are
eligibility counts, not delivery guarantees.

Each dry-run window has `due:true` only when its banner is active and it has never
been queued. `wouldNotify*` shows prospective counts **ignoring the disabled
switch**, so Super Admin can review the first broadcast before enabling it. It
is zero when the window is not due. Overlapping due windows each generate a
notice; recipient totals across windows are not distinct-client totals.

## Scheduling, safety and once-only behavior

The existing lifecycle tick (normally 30 seconds) checks for due windows. When
explicitly enabled, its first tick inside the banner interval snapshots the
Super Admin's name/message into one `season_window` inbox notice per eligible
client and queues the existing per-device outbox. An outage or disabled interval
can catch up within the six-to-four-week interval; it does not send late notices
after that interval. A due window with zero eligible clients is still marked
processed and is not rearmed later.

The window marker, audit, client notices, silent privileged inbox rows and outbox
entries commit atomically under the transaction-scoped domain advisory lock.
`noticeQueuedAt` is immutable once set, enforced in PostgreSQL. Repeated ticks,
restarts, concurrent API instances, edits, toggling the switch, or deleting inbox
history cannot rearm the same window. A new season occurrence needs a new window
ID. Deleting a window suppresses any remaining unsent pushes for its ID.

The outbox rechecks the switch, window existence, banner timing, active client
membership, device ownership and app role before attempts. Disabling suppresses
pending notices; reenabling does not replay them. A push already accepted by the
provider cannot be withdrawn. Push failure does not fail the trigger. Scheduling
is once per window; transport retains the existing bounded at-least-once retry
contract, so clients deduplicate by `notificationId` if a provider accepted a
request just before a process crash.

Season push title/body are the public name/message. Push data remains allowlisted
(`notificationId`, `type:"season_window"`, `at`); no season ID or private fields
are added. On tap, clients can open the season calendar and refetch the public
endpoint. The owning authenticated inbox contains the same name/message.

Before the first production broadcast, review the dry-run counts and obtain the
rollout decision required by gridgoph/gridgo-client#161. This backend task leaves
the switch off and sends no production notices. The setting is the explicit
Super Admin rollout control; enabling it can enqueue every currently due window
on the next tick. Tests use an isolated database and never contact live push
providers.
