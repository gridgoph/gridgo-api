# App release announcements

`POST /release-announcements` accepts a server-only `Authorization: Bearer`
credential from `RELEASE_ANNOUNCE_TOKEN`. Unset/empty configuration returns
`404 not_found`; missing or incorrect credentials return `401 unauthorized`.
The token comparison uses the same constant-time digest comparison as firstmate.
The token never goes into the mobile bundle, response, audit, or request log.

`POST /firstmate/release-announcements` accepts the same body using
`FIRSTMATE_TRACKER_TOKEN` instead. It shares the same idempotency record; it is
for manual triggering or safely retrying a failed workflow call, not forcing
another broadcast for an already accepted version.

```json
{ "app": "rider", "version": "1.0.112", "channel": "play" }
```

`app` is exactly `client`, `supplier`, or `rider`. `version` is three unsigned
integer components (up to nine digits each), without leading zeros, prefixes,
whitespace, or prerelease suffixes. `channel` is optional and is exactly `apk`,
`play`, or `ios`; omitting it means `apk`, so the existing APK workflow body
keeps its meaning. Invalid bodies return `400 invalid_release_announcement`.
Other methods return `405` after auth.

The first call returns `201 { announcement }`. Later calls for the same
`(app, version, channel)` return `200 { announcement }` containing the original
record and counts, without adding inbox rows, audit records, or push sends. The
APK, Play and TestFlight notices for one version are separate records, each sent
at most once. History lives in `release_announcements`, independently of
recipient inbox retention. The domain transaction/advisory lock covers the
deduplication record, inbox, audit, and claimed-device outbox. Concurrent
requests and both routes share it. Migrations `1791849600000` and
`1792153000000` must run before deployment; no schema is created at boot.

The `announcement` record carries `releaseChannel` and `storeTarget` (see
below) beside `app`, `version`, the copy and the counts. Records written before
channels existed have neither and were APK notices.

## Install channels

Each app reports how it was installed as `installChannel` on `POST /devices`
(signed in or not; see [Operational model: `POST /devices`](OPERATIONAL_MODEL_V2_API.md#post-devices)):

| `installChannel` | Install | Notice sent when |
|---|---|---|
| `apk` | APK download from GRIDGO | the APK workflow publishes the release |
| `play` | Google Play (internal testing) | the Play upload for that version succeeds |
| `ios` | TestFlight | the TestFlight upload for that version succeeds |

A registration that reports nothing — every build released before this field —
counts as `apk`, so current APK users keep receiving the APK notice exactly as
before. An old Play build that reports nothing is also treated as `apk` and may
receive one or two early APK notices until it updates to a build that reports
`play`. Each re-registration replaces the stored value.

A release notice for a channel is pushed only to that app's devices whose
channel matches (`apk` includes devices that report nothing). Inbox rows follow
the same rule per account: an account receives the notice when it has a
registered install of that app on that channel, and an account with no
registered install of the app receives only the APK notice, as before. An
account whose installs of the app all came from another channel receives no row.

The shared staff-announcement machinery writes one `announcement` notification
per matching membership (clients/suppliers/riders), with the matching `appRole`.
Claimed-device delivery uses the existing after-commit outbox and its retry
policy. A user with several apps receives the notice only in the matching app
where its device registration identifies that app. Legacy claimed devices
without `appRole` retain the existing membership-based fallback.

Signed-out devices whose retained `appRole` matches the release also receive
an anonymous announcement after commit. Fresh anonymous registrations do not
record an app identity, so unidentified devices are excluded from all release
broadcasts: sending a client update to an unknown supplier/rider install would
advertise the wrong app. Ordinary staff `everyone` announcements still reach
all unclaimed devices. Anonymous delivery remains best effort, without durable
retry, and carries data **exactly** `{ "type": "announcement" }`.

Copy is fixed per channel (shown for Rider; each app uses its own label):

| Channel | Title | Body |
|---|---|---|
| `apk` | `GRIDGO Rider 1.0.112 is ready` | `Update now for the latest fixes and features.` |
| `play` | `GRIDGO Rider 1.0.112 is on the Play Store` | `Update from the Play Store for the latest fixes and features.` |
| `ios` | `GRIDGO Rider 1.0.112 is in TestFlight` | `Update in TestFlight for the latest fixes and features.` |

The APK copy is unchanged. The three mobile apps recognize this exact APK title
format on an `announcement` tap and open their existing fixed APK download URL,
even when signed out. The Play and TestFlight titles deliberately do not match
that format, so a released build that predates channels opens its inbox instead
of the APK download.

### Notification data

Release notices add two fixed fields to the push `data`, to the inbox
notification (`GET /notifications`) and to the announcement record:

| `releaseChannel` | `storeTarget` | The app opens |
|---|---|---|
| `apk` | `apk_download` | its existing fixed APK download URL, as today |
| `play` | `play_store` | the Google Play listing for its own package, `ph.gridgo.<app>` (`market://details?id=ph.gridgo.<app>`, falling back to `https://play.google.com/store/apps/details?id=ph.gridgo.<app>`) |
| `ios` | `testflight` | the TestFlight app (`itms-beta://`), never the APK download |

Signed-in devices receive `{ notificationId, type: "announcement", at,
releaseChannel, storeTarget }`; signed-out devices receive exactly
`{ type: "announcement", releaseChannel, storeTarget }`. The values are only
ever those in the table. No URL comes from a payload: the app maps
`storeTarget` to its own fixed destination. An app should act on a release
notice only when `releaseChannel` matches its own install channel, and treat an
unknown `storeTarget` as "open the inbox". Staff announcements carry neither field.

## Release workflow and rollout

Each app's `android-release.yml` calls this route only on a push to `main`,
after both the server upload and GitHub Release succeed, using the version from
`steps.config.outputs.version`. That APK call needs no `channel`. A workflow
that uploads to Google Play internal testing or TestFlight calls the route again
with `"channel": "play"` or `"channel": "ios"` only after that upload succeeds,
with the same version. Manual dispatches and PRs do not broadcast.
The request has a 15-second timeout and refuses redirects. An unset repository
secret produces a notice and a job-summary entry. HTTP/network failures produce
a warning and a job-summary entry while leaving the published release successful.

Firstmate installs the same `RELEASE_ANNOUNCE_TOKEN` value as an API environment
variable and as a GitHub repository secret in `gridgo-client`, `gridgo-supplier`,
and `gridgo-rider`. Keep the existing API `FIRSTMATE_TRACKER_TOKEN` for manual
calls. Deploy the API migration/code and configure the tokens before promoting
the mobile workflows. This feature does not configure any secret itself.
