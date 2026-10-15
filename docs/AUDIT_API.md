# Permanent audit log

Server contract for B63CD487. The dashboard Audit Logs screen and order tab can
consume these endpoints after deployment. Clerk authenticates the caller;
PostgreSQL memberships determine access.

## Access

- Super Admin: the complete log, search, export, and every order's log.
- Operations: the existing correction/deletion scopes only. `GET /audit` requires
  `action=order.production_override`, `order.transition_refused`,
  `file.early_delete`, or `file.retention_delete`, or both `entityType=file` and a
  nonblank `entityId`. Filters always intersect.
- `GET /orders/:id/audit`: Super Admin sees all associated entries; Operations
  sees only those four correction/deletion actions. It does **not** grant
  Operations the unrestricted money, settings, or staff log. An unknown order
  returns `404 order_not_found`.
- Clients, suppliers, riders, and hub staff cannot read the audit log. An ordinary
  order response never embeds audit evidence. Unauthenticated requests are 401;
  authenticated callers outside their scope are 403.

## Reads and export

`GET /audit` and `GET /orders/:id/audit` accept:

| Parameter | Meaning |
| --- | --- |
| `actorId` | Exact GRIDGO user ID |
| `person` | Case-insensitive substring of snapshotted actor name or ID |
| `action` | Exact action code |
| `orderId` | Exact order ID; on the order endpoint it must equal the URL ID |
| `entityType`, `entityId` | Exact affected item type and ID |
| `q` | Literal, case-insensitive substring of actor name, action, item ID, order ID, or reason; `%` and `_` are literal characters |
| `from`, `to` | Inclusive UTC date (`YYYY-MM-DD`) or timestamp (`YYYY-MM-DDTHH:mm:ss[.SSS]Z`); a date-only `to` includes the whole day |
| `limit` | Positive integer, default 100; maximum 500 for JSON, 5000 for CSV |
| `offset` | Nonnegative integer, default 0, maximum 10000000 |
| `format` | `json` (default) or `csv` |

Results sort by `at DESC, id DESC`, including a deterministic tie-breaker.
Shared basket payment and file records carry `orderIds` and appear in every
associated order workspace; single-order records also retain `orderId`.
Malformed paging, dates, reversed date ranges, and unsupported formats return
400 with a snake-case error. All filters intersect; no filter expands access.

Example: `/audit?person=Maria&action=order.transition&from=2026-10-01&to=2026-10-31&limit=100`.

```json
{
  "audit": [{
    "id": "aud_…",
    "at": "2026-10-15T04:00:00.000Z",
    "actorId": "user_…",
    "actorName": "Maria",
    "actorRole": "supplier",
    "app": "supplier",
    "device": "GRIDGO Supplier/1.0",
    "action": "order.transition",
    "entityType": "order",
    "entityId": "ord_…",
    "orderId": "ord_…",
    "before": { "state": "production" },
    "after": { "state": "supplier_self_qc" },
    "reason": "Printing finished",
    "detail": null
  }],
  "limit": 100,
  "offset": 0,
  "nextOffset": null
}
```

`nextOffset=null` means the final page. CSV uses the same filters and paging,
with `Content-Disposition: attachment; filename="gridgo-audit.csv"` and the next
page offset in `X-Next-Offset` (empty at the end, exposed to browser JavaScript).
Columns: `id, at, actorId, actorName, actorRole, app, device, action, entityType,
entityId, orderId, before, after, reason`. Objects are JSON inside quoted CSV
cells. Quotes, commas, and newlines are escaped; cells that could become
spreadsheet formulas are prefixed with an apostrophe. The response is UTF-8.

For an export spanning multiple pages, set `to` once to the current UTC timestamp
and reuse it with each next offset so later events do not move the page boundary.
The server bounds each export page; it does not silently export only the first
page as though it were the complete log. JSON and CSV have `private, no-store`.

## Evidence shape and privacy

`src/audit.js` finalizes **new** entries at `saveStore` so direct domain writers,
HTTP handlers, CLI writers and lifecycle jobs share the shape. Previously stored
rows are never rewritten by the application. The actor name and role are
snapshots, unaffected by later account changes. `actorId=null`, `actorRole=system`
and `actorName=System` identify automatic work. Old rows may have null names,
source, or snapshots: the API does not invent historical facts.

`before`/`after` are safe business projections of the affected item at the start
and end of the transaction, or explicit event-specific snapshots. Creation has
`before=null`; deletion has `after=null`. Unsupported historical data and events
without an applicable state change can also have null snapshots. `reason` is the
recorded explanation or null when the action does not collect an explanation;
this change does not invent a reason for an existing event.

Apps may send `X-GRIDGO-App` (CORS allows it). Otherwise the request origin, or
`api`, identifies the source. `device` is the bounded User-Agent; non-HTTP writes
use `app=system`. These strings describe the request and are not verified device
identity or authorization inputs. No device push token, raw session ID, IP
address, JWT, authorization header, signing URL, object key, file bytes, full
personal document, contact email/phone, or copied privacy-request narrative is
part of the audit projection. Future writers must use small business fields,
never raw request bodies. Recursive redaction is defense in depth.

`staff.sign_in` records the first successful `/auth/me`, `/auth/me/admin`, or
`/auth/me/ops` or `/staff/me` bootstrap observed for a staff membership and Clerk session. The
raw session identifier is never stored; a one-way fingerprint prevents duplicate
refresh entries under the domain lock and a database unique index. This records
GRIDGO app access, not an assertion that every Clerk login reached GRIDGO.

`artwork.download_authorized` records a successful authorized signed-URL issue
for artwork/mockups, with file ID and associated order IDs, before returning the
URL. Unauthorized requests add no download record. MinIO serves the bytes:
URL issuance does not prove download completion or record later URL re-use.

## Coverage inventory and changes

| Required area | Already recorded before this change | Gaps filled here |
| --- | --- | --- |
| Fees, delivery bands, schedules, hub switch, invoice mode | `settings.operational_update`, `settings.payment_qr_replace`, `zone.*`, `season_window.*` | Consistent actor/source and old/new settings snapshots |
| Voucher configuration, issue, void | `voucher.campaign_*`, `voucher.issued`, `voucher.void`, redemption/restoration events | Correct campaign target and old/new campaign/voucher snapshots |
| Forced steps, QA checks/problems | `order.production_override`, `order.transition_refused`, `order.file_check`, pickup checklist events | Ordinary `order.created` / `order.transition`, including self-QC and correction transitions |
| Holds, reassignments, cancellations | `claim.raise/hold/release`, `issue.report/resolve`, `order.supplier_assigned`, `order.shop_recovery_*`, reschedule events | `order.rider_assigned` and `order.supplier_changed`, ordinary cancellation transitions and state snapshots |
| Refunds, penalties, pin changes | `refund.*`, `production_lapse.*`, `order.dropoff_confirmed`, `order.dropoff_review_requested`, `user.shop_update` | Safe request/settlement metadata and old/new pin-confirmation snapshots |
| Payout releases/freezes and credits | `payout_milestone.release`, payment decisions, claim/refund/recovery holds, `credits.grant` | Consistent money/status snapshots; no new payout bypass or independent freeze mechanism |
| Legal and privacy | `legal.created/edited/deleted/published/accepted`, `privacy.requested/updated`, account deletion request events | Explicit old/new revision/publication/status metadata; no copied legal draft or personal request text |
| Artwork downloads | File access was authorized but successful signed reads had no audit entry | `artwork.download_authorized` |
| Staff sign-in, role changes, account creation/removal | `user.role_change`, account standing actions, approval decisions, staff invite/profile/role events, administrator bootstrap | Once-per-session `staff.sign_in`; explicit `user.created` / `user.deleted` for server domain changes |
| Read usability and permanence | Limited in-memory filters; mutable SQL table | SQL-backed search/filter/paging/CSV; per-order read; database and adapter immutability |

Existing action codes remain available for filters. More detailed domain records
(claims, refunds, payments, legal versions) remain authoritative for their own
workflows; this is their common audit index and evidence trail.

## Database and retention

Forward migration `1792017100000_permanent_audit` is later than the dev migration
set at implementation. It drops the actor/order foreign keys whose cascades
would otherwise rewrite evidence, retains the identifiers as snapshots, links
old order-targeted entries to their order, adds query/deduplication indexes, and
installs ALWAYS triggers rejecting UPDATE, DELETE and TRUNCATE (`23514`). This
also rejects direct DML from a table owner and from an application role with
accidental broad DML grants. The compatibility adapter marks audit rows
append-only and issues only INSERT for new rows. There is no edit/delete API.

Database administration can still change schema or disable triggers; no SQL
trigger can constrain a PostgreSQL superuser doing DDL. Runtime credentials
should not have schema administration privileges. Dashboard Super Admin has no
such database capability.

Nothing is purged. Audit entries are retained at least as long as orders and
invoices; no cleanup job or retention deadline is introduced until the accountant
confirms the period. Account/order removal never cascades into audit evidence.
Development seeding preserves existing audit rows. Test resets explicitly disable
only the truncation trigger under test-owner DDL, truncate isolated test data,
and re-enable the ALWAYS trigger atomically; runtime code has no reset bypass.

## Verification

`tests/audit-postgres.test.js` exercises PostgreSQL enforcement (including a
non-superuser with DML grants), adapter refusal, immutable snapshots after source
removal, transaction rollback, filtering/date validation, deterministic paging,
CSV escaping/formula defense, role boundaries, per-order reads, request context,
settings snapshots, ordinary transitions, staff sign-in deduplication, and artwork
reads. Existing API, refund, legal, voucher, dropoff, bootstrap and store tests
cover the domain action paths listed above. CI runs the full PostgreSQL suite.
