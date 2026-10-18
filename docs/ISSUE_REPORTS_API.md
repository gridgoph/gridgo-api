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

The dashboard uses the signed-in Clerk session. Any identity with an `ops_admin` or `super_admin` membership may use `GET /ops/issue-reports`, `GET /ops/issue-reports/:id` and `PATCH /ops/issue-reports/:id`, which follow the desk workflow below with the role restrictions in this section; anyone else gets `403 forbidden`.

Only a `super_admin` membership receives `trackerIssueUrl` in dashboard list, detail,
status-change, and priority-change responses. Operations responses omit the property
entirely and redact GitHub URLs pasted into other response text. Stored text is unchanged.
Operations still receives status, priority, and `publishedIn` (with any GitHub URL redacted).

An Operations PATCH containing `trackerIssueUrl` (including null or an empty string,
or combined with priority) returns `403 tracker_issue_url_forbidden` without changes.
Operations status changes always preserve the stored tracker link, including transitions
to `new` or `dismissed`. Super Admin retains the link behavior described below.
Support desk callers have the same link restrictions as Operations, regardless of their email allowlist entry. Only Super Admin dashboard callers and firstmate token routes receive and manage tracker links.

## Read and mark reports (support desk)

Send a Clerk session token as `Authorization: Bearer <token>`. The account's verified primary email must be on `SUPPORT_DESK_ALLOWED_EMAILS` — the same gate as the ticket desk. Another Clerk account is `403 forbidden`; no or an invalid token is `401 unauthorized`; an empty allowlist is `503 desk_unconfigured`.

- `GET /issue-reports?status=new&since=2026-09-24&limit=200` lists newest first. `status` is `new | tracked | published | dismissed`; every filter is optional. `limit` is capped at 500.
- Paging: `before=<report id>` returns only reports older than that one (same filters, same order; ties on `createdAt` are broken by `id`), so the next page is `?status=new&limit=25&before=<id of the last report shown>`. An id that is not a report is `400 invalid_request`. Without `before` the response is unchanged. `counts` are always the totals per status, so a caller knows more remain while it has shown fewer than `counts[status]`.
- `GET /issue-reports/:id` returns one report.
- `PATCH /issue-reports/:id` with `{ "status": "published", "publishedIn": "09-24-2026" }` marks it handled. `publishedIn` is kept only for `published`.

The list response is `{ reports, counts: { new, tracked, published, dismissed, priorities } }`. Each support desk report is `{ id, issue, category, status, priority, publishedIn, createdAt, updatedAt, screenshots: [{ position, contentType, size, url, expiresAt }] }`.
Screenshot `url`s are presigned MinIO links that expire (`MINIO_DOWNLOAD_URL_TTL_SECONDS`, default 5 minutes), so download them right after listing.

## Statuses and the tracker issue link

- `new`: not handled yet.
- `tracked`: filed on, or linked to, a GitHub tracker issue (`trackerIssueUrl`).
- `published`: named in a dated report (`publishedIn`).
- `dismissed`: not acted on.

For Super Admin dashboard callers and firstmate token routes, `trackerIssueUrl` is `null` or `https://github.com/gridgoph/<repo>/issues/<number>`; any other value in a PATCH is `400 invalid_request`
(also when the status would clear it). In a PATCH, omitting it keeps the stored link and `null` (or `""`) clears it. The link is kept for
`tracked` and `published` and always cleared on `new` and `dismissed`. These routes never talk to GitHub; firstmate files the issue itself.

## firstmate intake

firstmate reads new reports and records the tracker issue each one became with `Authorization: Bearer <FIRSTMATE_TRACKER_TOKEN>`,
checked in constant time with the tracker's firstmate helper (`firstmateRefusal` in `src/tracker.js`). While the token is unset the
routes are `404 not_found`; a missing or wrong token is `401 unauthorized`. They follow the desk workflow above, but retain `trackerIssueUrl` in every report and may manage it:

- `GET /firstmate/issue-reports?status=new[&since=&limit=]` returns `{ reports, counts }` with each screenshot's signed `url`.
- `GET /firstmate/issue-reports/:id`
- `PATCH /firstmate/issue-reports/:id` with `{ "status": "tracked", "trackerIssueUrl": "https://github.com/gridgoph/gridgo-api/issues/94" }` (or `publishedIn`).

## Shared priorities

Operations and Super Admin can PATCH `/ops/issue-reports/:id` with only `{ "priority": true }` (pin) or `{ "priority": false }` (unpin). Values must be booleans and priority cannot be combined with workflow fields. This preserves status, `publishedIn`, `trackerIssueUrl`, and original list position. Status updates preserve priority. Public submissions cannot set it, and support desk/firstmate PATCH callers cannot change it.

Every report includes `priority` (default false). All list routes accept `priority=true` to return pinned reports across statuses, with the existing `before`/`limit` paging. Optional `status` and `since` further narrow the query. `counts.priorities` is the total number of pinned reports across all statuses; existing status counts stay unchanged. Pinning a report does not change its linked GitHub issue.

Migration `1791976000000_issue_report_priorities` adds the boolean and last priority actor/time (`priority_updated_by`, `priority_updated_at`) and a partial paging index. Deploy API/migration before dashboard.
