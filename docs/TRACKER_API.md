# Super Admin Tracker API

The tracker is the set of GitHub issues labelled `tracker` across the GRIDGO repositories. **GitHub stays the source of truth** for every item and its status; the API reads and writes those issues with a server-side token and keeps only what GitHub cannot hold: the decisions a Super Admin records, their attachments, and the audit rows. firstmate collects each decision as soon as it is saved.

Implementation: `src/tracker.js`. Migration: `migrations/1786989600000_super_admin_tracker_decisions.js`.

## Configuration

| Variable | Meaning |
|---|---|
| `GITHUB_TRACKER_TOKEN` | Fine-grained GitHub token with Issues read/write on the tracker repositories. It stays on the server and is never sent to a browser or included in a response. **Unset:** every `/admin/tracker` route answers `503 tracker_not_configured` with a message saying why, and nothing else in the API changes. |
| `GITHUB_TRACKER_REPOS` | Comma list of `owner/name` (or bare `name`, owner `gridgoph`). Default: `gridgoph/gridgo-api,gridgoph/gridgo-web,gridgoph/gridgo-client,gridgoph/gridgo-supplier,gridgoph/gridgo-rider`. Repository names must be unique, because an item is addressed by its bare name. A malformed value also yields `503 tracker_not_configured`. |
| `FIRSTMATE_TRACKER_TOKEN` | Bearer service secret for the firstmate pickup routes. **Unset:** those routes answer `404`, so they are invisible. |
| `GITHUB_TRACKER_API_URL` | Test-only override for the GitHub API origin. Leave it unset in every real deployment. |

Production sets these in `gridgo-api.env` (see [Deployment](DEPLOYMENT.md)), never under `environment:` in compose.

## Items

Each tracker issue body ends with a marker:

```html
<!-- tracker: {"id":"S1-2","section":"step-01","order":2,"ref":"1.2","summary":"…","category":"…","sheetStatus":"…","owner":"mark"} -->
```

The last marker in the body wins; an issue without one still lists, using its title as the requirement. Pull requests are ignored.

| Field | Source |
|---|---|
| `key` | `"<repo>#<number>"`, for example `gridgo-api#12` |
| `repo`, `number`, `url` | the issue (`repo` is the bare repository name) |
| `section` | marker `section`, lower-cased |
| `order` | marker `order` (number or `null`) |
| `ref` | marker `ref` |
| `module` | marker `module` when present, else the section's report label (`General`, `Supplier`, `Step 01` … `Step 08`) |
| `developer` | `"Mark"` or `"Ven"` from the `owner:mark` / `owner:ven` label, else from marker `owner`, else `null` |
| `requirement` | marker `summary`, else the issue title |
| `category` | marker `category` |
| `status`, `statusSource` | see [Statuses](#statuses) |
| `decisions` | `[{ id, text, attachments: [{ id, name, contentType, size }], decidedBy: { id, name }, decidedAt }]`, oldest first |

Items sort in report order: `general`, `supplier`, `step-01` … `step-08`, then any other section, then by `order`, repository, and issue number.

Module, step, id, requirement, and category are never editable. Sending any of `module`, `section`, `step`, `order`, `ref`, `id`, `requirement`, `summary`, `category`, or `developer` to a write route gives `400 tracker_field_not_editable`.

## Statuses

| Value | Label |
|---|---|
| `open` | Open |
| `in-review` | In review |
| `merged-dev` | Merged (dev) |
| `live` | Live (prod) |
| `needs-decision` | Needs decision |
| `blocked` | Blocked |

An explicit choice is stored on GitHub as exactly one `status:<value>` label (`statusSource: "explicit"`). A write keeps GitHub consistent in one issue update:

- every other `status:*` label is removed;
- `needs-decision` also adds the `needs-decision` label, and every other status removes it;
- `live` closes the issue as completed;
- any other status reopens the issue if it is closed.

Without an explicit label the status is derived (`statusSource: "derived"`): `live` for an issue closed as completed, `needs-decision` when it carries the `needs-decision` label, otherwise `open`.

## Super Admin routes

All four routes need a Clerk session with a `super_admin` membership. No session gives `401 unauthorized`. Operations and every other role get `403 forbidden`. An unconfigured tracker gives `503 tracker_not_configured`. GitHub being unreachable or refusing the token gives `502 tracker_github_unavailable`. GitHub's own error text and the token are never relayed.

Writes serialize on a tracker advisory lock while GitHub answers. They take the domain mutation lock only for the final commit, which holds the audit row, the decision's file references, and the decision row, so a slow GitHub never stalls other platform mutations. GitHub is written before that commit, so a GitHub failure leaves no decision behind and the Super Admin can retry.

### `GET /admin/tracker`

```json
{ "fetchedAt": "2026-09-25T06:00:00.000Z", "items": [ { "key": "gridgo-api#12", "…": "…" } ] }
```

GitHub reads are cached in-process for 60 seconds, and `fetchedAt` says when the cache was filled. `?refresh=1` bypasses the cache. A status change or decision updates its item in the cache straight away. Decisions are always read live from PostgreSQL.

### `PATCH /admin/tracker/:repo/:number/status`

Body: `{ "status": "<value>", "note": "optional, ≤ 5000 chars" }`.

This re-reads the issue from GitHub and applies the status as described in [Statuses](#statuses). It writes an audit row with action `tracker.status`, entity `tracker_item` / `<key>`, the actor, and detail `{ from, to, note }`. It returns the updated item.

Errors: `400 invalid_tracker_status`, `400 tracker_field_not_editable`, `404 tracker_item_not_found` (unknown repository, not an issue, or no `tracker` label).

### `POST /admin/tracker/:repo/:number/decisions`

Body: `{ "text": "1..5000 chars", "attachmentIds": ["file_…"], "status": "optional, default open" }`.

This is allowed only while the item's current status is `needs-decision`; otherwise it returns `409 tracker_decision_not_needed`. The route:

1. Checks each attachment. It must be one of the caller's own `ready`, unbound `tracker_decision` uploads, with at most 6 per decision; duplicates are collapsed.
2. Inserts a `tracker_decisions` row (`processed_at` is null).
3. Posts a GitHub comment `Decision recorded by <name> on <Mon D, YYYY, h:mm AM> (Manila): <text>`. When there are attachments it adds a second paragraph, `<n> attachment(s) in the GRIDGO dashboard`. The comment never includes file bytes, names, or signed links.
4. Sets the item to `status` (default `open`, meaning ready for work) as described in [Statuses](#statuses).
5. Pins each attachment with a `tracker_decision` file reference, so it reads as `file_in_use`, and writes an audit row `tracker.decision` with detail `{ decisionId, from, to, attachmentCount }`.

It returns the updated item, including the new decision.

Errors: `400 invalid_request` (missing, blank, or too-long text; bad `attachmentIds`), `400 too_many_attachments`, `400 invalid_tracker_status`, `400 invalid_tracker_attachment` (not the caller's `tracker_decision` upload), `409 file_not_ready`, `409 tracker_attachment_in_use`, `409 tracker_decision_not_needed`, `404 tracker_item_not_found`.

#### Attachments

Upload attachments first through the ordinary `POST /files` flow with `purpose=tracker_decision`: JPEG, PNG, WebP, or PDF, up to 10 MiB each, Super Admin only ([Storage](STORAGE_API.md#purpose-policies)). They are private to Super Admin. Operations cannot read, sign, or delete them, and `POST /files/:id/attach` refuses them with `400 tracker_decision_not_attachable`.

### `GET /admin/tracker/decisions/:id/attachments/:attachmentId`

This returns a short-lived signed MinIO download URL, from the same signer as `GET /files/:id/download-url`:

```json
{ "attachmentId": "file_…", "name": "brief.pdf", "contentType": "application/pdf", "size": 48213,
  "url": "https://…", "expiresAt": "…", "expiresInSeconds": 300 }
```

Errors: `404 tracker_decision_not_found`, `404 tracker_attachment_not_found`.

## firstmate pickup

These routes authenticate with `Authorization: Bearer <FIRSTMATE_TRACKER_TOKEN>`, compared in constant time. A Clerk session does not work here. While the variable is unset, both routes answer `404`. A missing or wrong token gives `401 unauthorized`.

### `GET /firstmate/tracker/decisions?unprocessed=1`

`unprocessed=1` limits the list to decisions not yet marked processed. Without it, every decision is listed. The list is oldest first:

```json
{ "decisions": [ {
  "id": "tdec_…", "itemKey": "gridgo-api#12", "text": "…",
  "decidedBy": { "id": "user_…", "name": "…" }, "decidedAt": "…",
  "attachments": [ { "name": "brief.pdf", "contentType": "application/pdf", "url": "https://…signed…", "expiresAt": "…" } ]
} ] }
```

A response carries no other data.

### `POST /firstmate/tracker/decisions/:id/processed`

This marks the decision processed and returns `{ "id", "processedAt" }`. It is idempotent: a repeat keeps the first `processedAt`. An unknown id gives `404 tracker_decision_not_found`.

## Storage

`tracker_decisions`: `id` (text, `tdec_…`), `repo`, `issue_number`, `text` (1..5000), `attachment_ids text[]` (≤ 6), `decided_by` → `users.id`, `decided_at`, `processed_at` (nullable). The file bytes live in MinIO. `file_references` gains the reference type `tracker_decision`.
