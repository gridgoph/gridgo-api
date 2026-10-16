# Supplier invoices and monthly collection

Incoming shop invoices are private Finance records. They do not issue a GRIDGO
customer receipt or enable official-receipt generation. Invoice scans and paper
collection remain optional for production, dispatch and payout.

## Obligation and period

One invoice is expected per order, for the supplier assigned when the order first
reaches `ready_for_dispatch`. That event's timestamp defines `expectedAt`; its
**Asia/Manila calendar month** defines `month` (`YYYY-MM`). This is neither the
upload month nor the invoice date. For example, `2026-09-30T16:00:00Z` belongs to
October. The supplier, order, timestamp and month are immutable, including after
cancellation, reassignment, completion and repeated readiness transitions.

Migration `1792000500000` backfills existing orders only when their timeline
records `ready_for_dispatch`, taking the earliest timestamp. Historical shop
attribution prefers the first shop-failure snapshot at or after that event,
then its actor when that actor has supplier membership, then the order's current
supplier. Orders without recorded readiness are not guessed from creation date
or current status. Backfill writes system audit rows and does not send historical
inbox alerts. New readiness writes its obligation, audit and administrator alerts
in the same transaction as the order change.

A batch invoice is not supported. Each order has one current invoice record;
additional scans do not increase the expected or received count. Existing
attached scans remain usable, but count as received only after the shop enters
invoice details. File IDs listed in `scanFileIds` let the app finish that intake
without another upload.

## Shop intake

All endpoints require a Clerk session. Shop endpoints require an active account,
a database supplier membership and an approved supplier approval case. An
explicit `X-GRIDGO-Role` must select a membership the identity holds. The invoice's
snapshotted supplier is its owner even after an order is reassigned.

1. Upload via existing multipart `POST /files` with purpose `supplier_invoice`.
   JPEG, PNG, WebP or PDF, maximum 15 MiB. See [Storage](STORAGE_API.md).
2. Attach the ready file via `POST /files/:fileId/attach` with `{ "orderId": "..." }`.
   Before readiness, this uses the assigned shop; after an obligation exists,
   only its snapshotted shop can attach invoice scans. Refund work holds do not
   block this paperwork. All other file purposes keep their existing gates.
   A former shop receives `{file}` only from attach, without the replacement
   shop's order; currently assigned shops keep the existing `{file, order}` response.
3. After readiness, submit the entered details:

```http
PUT /me/supplier-invoices/:orderId
Content-Type: application/json
```

```json
{
  "fileId": "file_opaque",
  "number": "INV-001",
  "date": "2026-10-01",
  "amountMinor": 10000,
  "expectedVersion": 0
}
```

`number` is trimmed, 1–100 characters, with no control characters. `date` is a real
calendar date in `YYYY-MM-DD`, years 1000–9999. `amountMinor` is a nonnegative safe
integer in PHP centavos (10000 = PHP 100); it is the shop's entered invoice amount,
not a calculation or alteration of order money. No OCR, tax validation or
reconciliation against order totals is implied. Invoice number uniqueness is per
order record, not a global numbering rule imposed on independent shops.

The file must be the owner's ready `supplier_invoice` already attached to this
order. Submission rechecks MinIO existence and byte size inside the domain
transaction. It never accepts an object key, arbitrary URL, other shop's scan,
or a different file purpose.

Before paper collection, the shop may correct details or select a replacement
attached scan using the latest `expectedVersion` and a nonempty `reason` of at
most 1000 characters. The audit retains previous and current details; old file
references stay attached and retain their evidence policy. Each mutation advances
`version` once. Repeating identical normalized details returns the existing
record with no new audit or notification, including a retry with the earlier
version. Conflicting stale edits return `409 supplier_invoice_version_conflict`.
After collection, changes return `409 supplier_invoice_collected`; there is no
uncollect or delete route. An identical retry remains safe.

`GET /me/supplier-invoices/:orderId` returns `{invoice, reminder}`.
`PUT` returns the same shape. Example invoice:

```json
{
  "orderId": "order_opaque",
  "supplierId": "shop_opaque",
  "expectedAt": "2026-09-30T16:00:00.000Z",
  "month": "2026-10",
  "fileId": "file_opaque",
  "number": "INV-001",
  "date": "2026-10-01",
  "amountMinor": 10000,
  "submittedAt": "2026-10-01T01:00:00.000Z",
  "updatedAt": "2026-10-01T01:00:00.000Z",
  "version": 1,
  "collectedAt": null,
  "collectedBy": null,
  "scanFileIds": ["file_opaque"],
  "received": true,
  "collected": false
}
```

Unsubmitted obligations have version 0 and null detail/submission/collection
fields. `received` means entered details plus the selected ready attached scan;
`collected` means Finance recorded receiving the paper original. They are
independent: later authorized byte deletion makes `received` false, but does not
erase entered details, the obligation or paper-collection history.

## Monthly Finance and shop lists

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/ops/finance/supplier-invoices?month=YYYY-MM` | Operations / Super Admin |
| GET | `/ops/finance/supplier-invoices/:orderId` | Operations / Super Admin |
| GET | `/me/supplier-invoices?month=YYYY-MM` | Approved shop, own obligations only |
| POST | `/ops/finance/supplier-invoices/:orderId/collect` | Operations / Super Admin |

Monthly reads require `month`. Finance optionally filters by `supplierId`. Shop
reads always use the caller's identity; a supplied `supplierId` cannot broaden or
switch scope. Clients, riders, ordinary hub staff and the email-only support desk
cannot read the Finance ledger. Responses use `Cache-Control: private, no-store,
max-age=0` and do not appear in ordinary order/client invoice projections.

List response:

```json
{
  "month": "2026-10",
  "reminder": "Do not put your shop invoice inside the printed products or give it to the customer. GRIDGO buys from your shop and provides the customer with its own receipt. Upload your invoice scan here and keep the paper original for collection by GRIDGO.",
  "totals": { "expected": 3, "received": 2, "missing": 1, "collected": 1, "toCollect": 2 },
  "shops": [
    { "supplierId": "shop_opaque", "shopName": "Shop name", "expected": 3, "received": 2, "missing": 1, "collected": 1, "toCollect": 2 }
  ],
  "invoices": [],
  "nextCursor": null
}
```

`invoices` contains the records described above. `expected` counts obligations,
`received` counts submitted records with a ready selected scan, and `missing` is
`expected - received`. `collected` counts paper originals received;
`toCollect = expected - collected`, including orders still missing a scan.
`shops` contains shops with obligations in the selected period, including shops
that now have no live work. Totals and shop summaries cover the **entire filtered
period**, not just the returned page.

Pagination is ordered by `orderId`, using `limit` (default 50, range 1–100) and
`after=<nextCursor>`. The cursor is an opaque order identifier; URL-encode it.
`nextCursor` is null on the last page. These are live operational reads, not an
immutable accounting statement. There is no monetary aggregation that could
silently overflow JavaScript's safe integer range.

## Record paper collection

```http
POST /ops/finance/supplier-invoices/:orderId/collect
```

```json
{ "expectedVersion": 1 }
```

This records the authenticated operator as `collectedBy`, server time as
`collectedAt`, and increments version. The invoice must have submitted details
and its selected scan must still be ready. The response is `{invoice, reminder}`.
Concurrent/repeated collection commands return the single recorded result;
they never overwrite the first operator or timestamp and write one audit event.
A missing scan returns `409 supplier_invoice_scan_required`. Collection does not
confirm payments, release payouts, or move the order.

## Reminder, refresh, errors and retention

Every successful ledger read/write exposes the same `reminder` text. Show it on
the shop upload form and package handover view. It is informational, not a new
checkout consent or dispatch requirement. This backend does not deliver app UI.

The existing `supplier_invoice_scanned` inbox event still announces attached
scans. New `supplier_invoice_expected`, `supplier_invoice_submitted`,
`supplier_invoice_corrected` and `supplier_invoice_collected` events write durable
inbox rows to both Operations and Super Admin memberships. Apps refresh the
ledger on these events. Notifications and order invalidations use the existing
save/outbox boundary; financial details are not copied into push payloads.

Audit actions are `supplier_invoice.expected`, `supplier_invoice.scan_attached`,
`supplier_invoice.submitted`, `supplier_invoice.corrected` and
`supplier_invoice.collected`. Correction audits include the reason and both
versions of entered details. The collection actor and time are immutable in
PostgreSQL. Existing audit-read authorization remains unchanged; these routes do
not expand Operations' general `/audit` access.

Common errors use `{error:"snake_case"}`:

| Status | Error | Meaning |
| --- | --- | --- |
| 400 | `invalid_month`, `invalid_limit` | Invalid/missing monthly filter or page size |
| 400 | `invalid_invoice_number`, `invalid_invoice_date`, `invalid_invoice_amount`, `invalid_invoice_file` | Invalid entered metadata |
| 400 | `expected_version_required`, `reason_required`, `invalid_body` | Invalid mutation body |
| 401 / 403 | `unauthorized` / `forbidden` | Session, membership, approval or ownership refusal |
| 409 | `supplier_invoice_not_expected` | No recorded readiness obligation for that order |
| 409 | `supplier_invoice_scan_required` | No eligible attached scan or unsubmitted details |
| 409 | `supplier_invoice_version_conflict` | Refresh before editing/collecting |
| 409 | `supplier_invoice_collected` | Paper collection makes details final |
| 409 | `storage_object_missing`, `storage_object_mismatch` | Storage verification failed |

File metadata and signed downloads remain on `/files/:fileId` and
`/files/:fileId/download-url`, private to the approved owning supplier and
Operations/Super Admin. New supplier invoice uploads and signed responses use
private/no-store cache controls. Existing financial-file retention (five years
from order closure) and open-case holds remain in force; automatic deletion
remains off by default. No file bytes or object keys are exposed by this ledger.

## Rollout

Apply the forward migration before starting the API. It adds the relational
ledger, immutable-history guards, month/shop index and historical readiness
backfill; no users, payout changes or application-boot schema repair. Existing
upload, attachment and `/ops/hub/receipt-scans` clients remain compatible. That
older feed filters by **upload month** and is not a substitute for this Finance
collection view. Shop apps add entered details and the reminder; Admin Finance
adds monthly counts and explicit paper-collection actions.
