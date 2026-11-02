# Shop receipt scan before dispatch

Issue report 5B6DA444 / gridgo-supplier#64. The shop scans or uploads its own
invoice/receipt for an order before calling a rider, so Operations sees it at
once instead of waiting for the monthly paper collection.

This is the shop's **incoming** document. GRIDGO issues no official receipts
during the pilot (it is not yet registered to); nothing here generates, numbers
or presents an official or BIR receipt. Riders keep handing the client the
[acknowledgement receipt](ACKNOWLEDGEMENT_RECEIPTS_API.md).

## Finance switch

`GET /settings` exposes `settings.shopReceiptScanRequired`, default **false**.
It belongs in the Finance section of the Admin app and Operations dashboard.
Everyone who can read settings sees it; only Super Admin changes it, through the
existing version-checked handshake:

```http
PATCH /settings
{ "expectedVersion": 12, "reason": "Finance: scans before dispatch", "shopReceiptScanRequired": true }
```

- Operations and every other role: `403 forbidden` (settings writes are Super Admin only).
- A stale `expectedVersion`: `409 settings_version_conflict` with the current `version`.
- A missing reason: `400 settings_reason_required`.
- A non-boolean value: `400 invalid_shop_receipt_scan_required`.

Each change writes the usual `settings.operational_update` audit row with the
actor, reason and `detail.previous` / `detail.current` settings, in the same
transaction. Unrelated settings edits keep the switch's value. Keep it off until
the supplier app ships the upload step.

## The gate

The switch is read when the shop presses **Ready for rider pickup**
(`POST /orders/:id/transition {"state":"ready_for_dispatch"}`, from
`production` or `supplier_self_qc`, legacy and `rider_packs` flows alike).

- **Off:** nothing changes. Scans stay optional and outside `missing`.
- **On, no scan attached:** `409 receipt_scan_required` with a plain `message`
  and the full `missing` list, written to the `order.transition_refused` audit
  like every other packaging refusal. `supplier_self_qc` is not gated.
- **On, scan attached:** the transition proceeds as before.

Rider offers exist only for `ready_for_dispatch` orders
(`GET /dispatch/offers`, `POST /dispatch/:id/accept`), so no rider can be
offered or assigned the order until its scan is attached. Orders that were
already ready (or later) when the switch was turned on keep their offers and
pickup; turning it off never touches an order.

Operations' audited forced step (`reasonCode` + `reason`) can still move a job
whose shop cannot upload. The missing scan is recorded rather than skipped
silently: `forcedSteps[].skippedChecks` contains `receipt_scan_required` and the
`order.production_override` audit detail carries `receiptScanMissing: true`.

### Preflight

`transitionReadiness.ready_for_dispatch.receiptScan` (assigned shop and staff)
is now live:

```json
{ "required": true, "attached": false }
```

`required` follows the switch for `ready_for_dispatch` (always `false` for
`supplier_self_qc`). When required and not attached, `missing` includes
`{ "code": "receipt_scan_required", "message": "…" }`. Show the scan as required
in that case and optional otherwise.

## Uploading and attaching (assigned shop)

Unchanged existing flow and limits (`supplier_invoice` purpose, JPEG/PNG/WebP/PDF,
15 MiB, private financial storage and retention):

1. `POST /files` multipart with `purpose=supplier_invoice` and `file`. Only an
   approved shop may upload. Returns `201 { file }` once stored. Writes the
   audit row `supplier_invoice.scan_uploaded` (`entityType: "file"`,
   `entityId: fileId`, detail `{fileId, supplierId, contentType, size}`).
2. `POST /files/:fileId/attach {"orderId": "…"}` by the order's assigned shop.
   Another shop, a client or a rider gets `403 forbidden`. Writes
   `supplier_invoice.scan_attached`, sends `supplier_invoice_scanned` to both
   administrator memberships and invalidates the order. The response includes
   the refreshed order, so the shop can re-read `transitionReadiness` at once.

Only the assigned shop's ready, attached scans count. A replacement shop's order
needs its own scan.

## Operations and Super Admin visibility

Every Operations/Super Admin order projection (`GET /orders` list items and
`GET /orders/:id`) carries:

```json
{
  "receiptScan": {
    "attached": true,
    "fileIds": ["file_a", "file_b"],
    "latestFileId": "file_b",
    "latestUploadedAt": "2026-11-02T03:00:00.000Z"
  }
}
```

Use `receiptScan.attached` as the list flag and open `latestFileId` (or any of
`fileIds`, oldest first) with the existing signed read `GET /files/:fileId`.
The field appears the moment the attach commits; refresh on the
`supplier_invoice_scanned` inbox event or the order invalidation. The
`GET /ops/hub/receipt-scans` feed is unchanged.

Clients, riders and other shops never receive `receiptScan` or
`supplierInvoiceFileIds`, and `GET /files/:fileId` on a scan returns `403` for
them. The assigned shop sees its own `transitionReadiness.*.receiptScan`, not
the staff field.

No migration: the switch lives in the `platform_settings` JSON, files/references
already store scans, and the order fields are derived per request from the
order read graph's already-loaded file rows.
