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

The list response is `{ reports, counts: { new, tracked, published, dismissed, priorities }, triageCounts }`. Each support desk report is `{ id, issue, category, status, priority, publishedIn, createdAt, updatedAt, screenshots: [{ position, contentType, size, url, expiresAt }], triage, aiReview }` (see [Triage and AI review](#triage-and-ai-review)).
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

## Triage and AI review

Staff triage and AI review sit beside the workflow `status`; neither changes the status, priority, tracker link, or the reporter's own `category`. Migration `1792600000000_issue_report_triage` adds the columns (every existing report starts `unreviewed` with no AI review) and refuses to roll back once any report has been triaged or AI reviewed.

Every report on every read route (support desk, dashboard, firstmate) carries:

```json
{
  "triage": {
    "validity": "unreviewed | valid | spam | duplicate",
    "category": "bug | feature | question | feedback | other | null",
    "labels": ["checkout", "map"],
    "duplicateOf": "<report id> | null",
    "triagedBy": { "id": "<user id>", "name": "Ana | null" },
    "triagedAt": "<ISO time> | null"
  },
  "aiReview": null
}
```

`aiReview` is `null` until an AI review is recorded, then `{ reviewedAt, validity, category, labels, duplicateOf, note, outcome }`. AI `validity` is `valid | spam | duplicate`; `note` is at most 500 characters or `null`. `outcome` compares the current human triage with the current AI suggestion: `pending` while `triage.validity` is `unreviewed`; `confirmed` when the validity matches and, where the AI named them, the category and duplicate target match too; otherwise `overridden`. Labels never affect `outcome`. `triagedBy` is `null` until a person triages, and `name` is `null` when the identity has no user row. For Operations and the support desk, GitHub URLs in `aiReview.note` are redacted like other text.

Labels are free lowercase slugs (`^[a-z0-9][a-z0-9-]{0,31}$`), at most 10 per report. Writes trim, lowercase and de-duplicate them; the list sent replaces the stored list. There is no separate label table: `triageCounts.labels` lists every label in use.

### Staff triage (Operations and Super Admin)

`PATCH /ops/issue-reports/:id` with only a `triage` object:

```json
{ "triage": { "validity": "duplicate", "category": "bug", "labels": ["checkout"], "duplicateOf": "<report id>" } }
```

- Every field is optional, but at least one is required; unknown fields are `400 invalid_request`. Omitted fields keep their stored value. `category: null` clears it.
- `duplicateOf` must be another existing report and needs the resulting validity to be `duplicate`. Changing validity away from `duplicate` clears it; it becomes `null` if the target report is ever deleted.
- `validity: "unreviewed"` undoes a verdict.
- Each triage write records the caller as `triagedBy` and the time as `triagedAt`.
- `triage` cannot be combined with `status`, `publishedIn`, `trackerIssueUrl`, or `priority` (`400 invalid_request`). Clients and other roles get `403 forbidden`; support desk and firstmate PATCHes with `triage` are also `403 forbidden`. An unknown report is `404 issue_report_not_found`.

### AI review (firstmate only)

`PATCH /firstmate/issue-reports/:id` with only an `aiReview` object:

```json
{ "aiReview": { "validity": "spam", "category": "other", "labels": ["promo"], "duplicateOf": null, "note": "Advertising, not a GRIDGO problem." } }
```

- `validity` is required; `category`, `labels`, `duplicateOf` and `note` default to empty. Each write replaces the whole AI suggestion and sets `reviewedAt` to now. `duplicateOf` needs `validity: "duplicate"`.
- Only the `ai_*` columns are written, so an AI review never changes the human `triage`, whether it is sent before or after the person.
- `aiReview` cannot be combined with workflow fields (`400 invalid_request`). Dashboard and support desk PATCHes with `aiReview` are `403 forbidden`.

### Filters and counts

Every list route (`/issue-reports`, `/ops/issue-reports`, `/firstmate/issue-reports`) also accepts these filters. They combine with `status`, `since`, `priority`, `limit` and `before` paging:

- `validity=unreviewed,valid` (comma-separated, any of the four values). For example, the default "not spam" view is `validity=unreviewed,valid,duplicate`.
- `triageCategory=bug,none`: the staff category, comma-separated. `none` matches reports with no staff category.
- `label=checkout`: reports carrying that label. Matching is case-insensitive.
- `aiReviewed=true|false`.

An unknown value is `400 invalid_request`. The list response adds `triageCounts` next to the unchanged `counts`. These are totals over every report, whatever the filters:

```json
{ "triageCounts": { "validity": { "unreviewed": 1, "valid": 1, "spam": 1, "duplicate": 1 },
  "aiReviewed": 1, "aiAwaitingHuman": 0, "labels": [{ "label": "map", "count": 2 }] } }
```

`aiAwaitingHuman` counts reports that have an AI review but are still `unreviewed`. `labels` is sorted by most used, then by name. Status `counts` still include spam, so the existing paging contract keeps working. Only authenticated staff and firstmate receive counts. The public `POST /issue-reports` response returns no counts, and anything counted publicly, such as the reports site, should use `validity` to leave spam out.
