# Issue reports API

Anyone can file an issue from the landing site's `/report` page. The reports are
read back with the support desk account and written up on the public reports
site (https://gridgo.pages.obsidian-shards.com/reports/). Code: `src/issue-reports.js`.
Every path is also served under `/api`.

## File a report (public)

`POST /issue-reports` with a JSON body:

```json
{
  "issue": "Orders need a manual refresh in Operations",
  "category": "bug",
  "screenshots": ["data:image/png;base64,iVBORw0...", "..."]
}
```

- `issue` is required, 1-5000 characters after trimming.
- `category` is optional: `bug` (bug, issue or concern), `feature` (feature or change request), or `other`.
- `screenshots` is optional: up to 6 base64 strings (a `data:` prefix is fine), each at most 8 MB decoded.
  The type is read from the bytes; only PNG, JPEG, WebP and GIF are kept (no SVG).
- 10 reports per sender per 10 minutes, then `429 too_many_requests`. The sender is Cloudflare's `CF-Connecting-IP` (the edge proxy replaces `X-Forwarded-For`).
- Site-wide over the last 24 hours: at most `ISSUE_REPORTS_DAILY_LIMIT` reports (default 200) and `ISSUE_REPORTS_DAILY_BYTES` of screenshots (default 1 GiB), then `429 report_capacity_reached`.

`201` returns `{ id, createdAt, screenshots }` (the number stored). Screenshots go to MinIO under
`issue_reports/YYYY/MM/DD/<reportId>-<n>.<ext>` before the rows commit; if either fails the stored objects are removed.

## Read and mark reports (dashboard: Operations and Super Admin)

The dashboard uses the signed-in Clerk session. Any identity with an `ops_admin` or `super_admin` membership may use `GET /ops/issue-reports`, `GET /ops/issue-reports/:id` and `PATCH /ops/issue-reports/:id`, which behave exactly like the desk routes below; anyone else gets `403 forbidden`.

## Read and mark reports (support desk)

Send a Clerk session token as `Authorization: Bearer <token>`. The account's verified primary email must be on `SUPPORT_DESK_ALLOWED_EMAILS` — the same gate as the ticket desk. Another Clerk account is `403 forbidden`; no or an invalid token is `401 unauthorized`; an empty allowlist is `503 desk_unconfigured`.

- `GET /issue-reports?status=new&since=2026-09-24&limit=200` lists newest first. `status` is `new | published | dismissed`; every filter is optional.
- `GET /issue-reports/:id` returns one report.
- `PATCH /issue-reports/:id` with `{ "status": "published", "publishedIn": "09-24-2026" }` marks it handled. `publishedIn` is kept only for `published`.

The list response is `{ reports, counts: { new, published, dismissed } }`. Each report is `{ id, issue, category, status, publishedIn, createdAt, updatedAt, screenshots: [{ position, contentType, size, url, expiresAt }] }`.
Screenshot `url`s are presigned MinIO links that expire (`MINIO_DOWNLOAD_URL_TTL_SECONDS`, default 5 minutes), so download them right after listing.
