# Home promotions API

Promotions are independent Home content. They never enter order, checkout,
payment or tracking projections or change any ordering rules. A client should
refetch `GET /me/promotions/home` on Home focus; edits need no app release.
Reorder remains a client-owned permanent carousel item.

All routes require Clerk authentication and active GRIDGO membership. Both
`ops_admin` and `super_admin` may manage promotions. Only `client` may read the
Home feed or submit events. Supplier, rider and shop staff access is denied.
An explicit `X-GRIDGO-Role` continues to restrict membership context.

## Promotion JSON and media

```json
{
  "id": "promo_example",
  "name": "DavaoGo",
  "logo": {"fileId": "file_example", "contentType": "image/png", "downloadUrl": "https://storage.example/signed-url", "expiresAt": "2026-11-10T01:05:00.000Z"},
  "image": null,
  "description": "Our partner app in Davao. Tap to visit.",
  "tag": "partner",
  "linkText": "Visit DavaoGo",
  "linkUrl": "https://davaogo.app/",
  "tapAction": "sheet",
  "color": "#FFDE58",
  "style": "yellow",
  "startsAt": "2026-11-10T00:00:00.000Z",
  "endsAt": null,
  "enabled": true,
  "displayOrder": 1,
  "status": "live",
  "views": 12,
  "opens": 4,
  "taps": 2
}
```

`views`, `opens`, `taps` are lifetime totals on **staff responses only**. The
client receives the other fields above, with signed media URLs and no owners,
private object keys or filenames. `image` and `endsAt` are nullable.

Use existing multipart `POST /files` with `purpose=promotion_logo` (5 MiB max)
or `purpose=promotion_image` (15 MiB max), plus the `file` part. Both are staff
upload purposes accepting PNG, JPEG or WebP. On create/edit, send only
`logo: {fileId}` and optional `image: {fileId}`; omit signed response fields.
The Promotions mutation binds these ready uploads atomically. Do not call
`POST /files/:id/attach`; that route returns `409 promotion_attachment_route_required`.
Staff can bind their own upload or reuse media already bound to a promotion.
Clients and staff can use authenticated `GET /files/:fileId` and
`GET /files/:fileId/download-url` for these purposes; suppliers and riders cannot.
Bound promotion media is protected from retention/early deletion. Replacement
or removal detaches old media; ordinary unused-file retention then applies.
Signed links use the existing MinIO TTL (default five minutes); refetch when expired.

Write validation:

- `name`: trimmed, required, 1–120 characters; `description`: string, up to 140
  characters (may be empty); `linkText`: trimmed, required, 1–80 characters.
- `linkUrl`: HTTPS only, maximum 2048 characters, no embedded credentials.
- `tag`: `partner | sponsored | featured_shop`.
- `color`: required on new writes unless legacy `style` is supplied; a string
  containing exactly `#` and six hexadecimal digits (`#RRGGBB`). Lowercase hex
  is accepted, stored and returned uppercase. Null, shorthand, alpha, names,
  whitespace and nonstrings return `400 invalid_promotion` with `field: "color"`.
- Legacy `style: light | yellow` writes still work: `light` sets `#FFFFFF`,
  `yellow` sets `#FFDE58`. An explicit `color` takes precedence when both are
  supplied (a supplied `style` must still be valid). PATCH with neither preserves
  color. Every staff/client response includes `color` and a derived `style`:
  `yellow` only for `#FFDE58`, otherwise `light`, for installed older apps.
  New clients should prefer `color` and fall back to `style` on older APIs.
- `tapAction`: `sheet | link`, default `sheet`.
- `startsAt`: required ISO timestamp with explicit offset, including seconds;
  `endsAt`: null or a strictly later timestamp. Stored and returned in UTC.
  Dashboard date inputs should convert Manila local time to an explicit offset.
- `enabled`: boolean, default false; `displayOrder`: integer 0–2147483647,
  default 0. Other write fields, including `id`, `status` and totals, are rejected.
- `logo` is required. Clear `image`/`endsAt` with null. PATCH preserves omitted fields.

Status precedence: disabled/removed = `off`; enabled and end reached = `ended`;
start not reached = `scheduled`; otherwise `live`. Start is inclusive, end
exclusive. Removed rows are excluded from staff list/detail and client feed;
the row and reporting counters remain in PostgreSQL.

## Staff routes

| Method | Path | Response |
| --- | --- | --- |
| GET | `/ops/promotions` | `200 {promotions: Promotion[]}` |
| POST | `/ops/promotions` | `201 {promotion: Promotion}` |
| GET | `/ops/promotions/:id` | `200 {promotion: Promotion}` |
| PATCH | `/ops/promotions/:id` | `200 {promotion: Promotion}` |
| DELETE | `/ops/promotions/:id` | `204`, empty body; soft removal |
| GET | `/ops/promotions/:id/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` | `200 {timeZone, from, to, days: [{day, views, opens, taps}]}` |

Lists sort by `displayOrder`, then `startsAt`, then `id`. Statistics use
`Asia/Manila`, inclusive dates in ascending order, and include zero-count days.
Default `to` is today in Manila, default `from` is 29 days before `to`.
Maximum range is 366 days. For example:

```json
{"timeZone":"Asia/Manila","from":"2026-11-10","to":"2026-11-11","days":[
  {"day":"2026-11-10","views":12,"opens":4,"taps":2},
  {"day":"2026-11-11","views":0,"opens":0,"taps":0}
]}
```

Create/edit/remove, media binding, audit and durable inbox rows for current
Operations and Super Admin memberships commit together under the domain
transaction lock. These content edits do not send a push notification.

## Client routes and counting

`GET /me/promotions/home` returns `200 {promotions: Promotion[]}`, only enabled,
nonremoved promotions inside their dates, in the same display order. Missing
ready logos suppress the card. Responses are private/no-store.

`POST /me/promotions/:id/events` accepts:

```json
{"type":"view","sessionId":"an-app-session-uuid"}
```

`type` is `view | open | tap`. `sessionId` is required for all event types,
1–128 characters from letters, digits, `_`, `.`, `:`, `-`. Use a random ID per
app session, reused across Home refetches. A successful event returns `204`
with no body. An unavailable/nonlive promotion returns `404 promotion_not_found`.

Count `view` only when the card is actually shown. The server deduplicates
views by promotion + session ID + Manila day, including concurrent retries and
across API restarts. Only a SHA-256 session fingerprint is retained, never the
raw session ID. A session crossing midnight Manila can count again on the new
day. `open` and `tap` count every accepted request, so clients should send once
per user action and avoid automatic retries. Direct-link cards emit `tap`
without an `open`. Telemetry only updates reporting tables; it creates no inbox
or push activity.

## Errors, migration and development seed

Errors use `{error: "snake_case"}` and may include a `field`: `401 unauthorized`,
`403 forbidden`, `404 promotion_not_found`, `400 invalid_promotion`,
`400 invalid_promotion_event`, `400 invalid_promotion_stats_range`,
`409 promotion_file_not_ready`. Existing file/storage errors still apply.

Apply forward migration `1794283200000_home_promotions` before deploying the
API. It adds `home_promotions`, `home_promotion_daily_stats`,
`home_promotion_view_sessions`, and the `home_promotion` file-reference kind.
It contains no production data.

Then apply `1794316000000_home_promotion_color` before deploying the color-aware
API. It adds a nonnull uppercase six-digit hex `color` column and backfills all
existing rows (including disabled/removed rows) from `style`: light to `#FFFFFF`,
yellow to `#FFDE58`. It preserves media, dates, counters and permissions.

`npm run seed:dev` adds the committed DavaoGo logo to MinIO and its metadata to
PostgreSQL, then creates an enabled Partner promotion with the fields above,
yellow style, sheet action and display order 1. It requires the existing
explicit development/test environment and development Clerk key, available
storage, and a seeded staff owner. Repeated seeds preserve edits and soft
removal. Production `npm run seed` never creates a promotion; staff creates the
production partner through the Promotions page.
