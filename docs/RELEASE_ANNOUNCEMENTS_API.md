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
{ "app": "rider", "version": "1.0.112" }
```

`app` is exactly `client`, `supplier`, or `rider`. `version` is three unsigned
integer components (up to nine digits each), without leading zeros, prefixes,
whitespace, or prerelease suffixes. Invalid bodies return
`400 invalid_release_announcement`. Other methods return `405` after auth.

The first call returns `201 { announcement }`. Later calls for the same
`(app, version)` return `200 { announcement }` containing the original record
and counts, without adding inbox rows, audit records, or push sends. History
lives in `release_announcements`, independently of recipient inbox retention.
The domain transaction/advisory lock covers the deduplication record, inbox,
audit, and claimed-device outbox. Concurrent requests and both routes share it.
Migration `1791849600000` must run before deployment; no schema is created at boot.

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

Copy is fixed: `GRIDGO Rider 1.0.112 is ready` and
`Update now for the latest fixes and features.` (with the respective app label).
The three mobile apps recognize this exact release-title format on an
`announcement` tap and open their existing fixed APK download URL, even when
signed out. No URL from a payload is opened, and the push-data allowlist stays
unchanged. Older apps still open the inbox and retain their launch update check;
the direct download tap requires the companion mobile changes.

## Release workflow and rollout

Each app's `android-release.yml` calls this route only on a push to `main`,
after both the server upload and GitHub Release succeed, using the version from
`steps.config.outputs.version`. Manual dispatches and PRs do not broadcast.
The request has a 15-second timeout and refuses redirects. An unset repository
secret produces a notice and a job-summary entry. HTTP/network failures produce
a warning and a job-summary entry while leaving the published release successful.

Firstmate installs the same `RELEASE_ANNOUNCE_TOKEN` value as an API environment
variable and as a GitHub repository secret in `gridgo-client`, `gridgo-supplier`,
and `gridgo-rider`. Keep the existing API `FIRSTMATE_TRACKER_TOKEN` for manual
calls. Deploy the API migration/code and configure the tokens before promoting
the mobile workflows. This feature does not configure any secret itself.
