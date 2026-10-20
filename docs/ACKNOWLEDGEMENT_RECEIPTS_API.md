# Delivery acknowledgement receipts

Backend contract for [rider issue 152](https://github.com/gridgoph/gridgo-rider/issues/152)
and the companion rider/client releases. During the pilot this is an
**acknowledgement receipt**, never an official receipt or tax invoice.

## Scope and lifecycle

One immutable receipt per client order with `fulfillmentMode: "delivery"` and an
assigned GRIDGO rider. Hub pickup is excluded: that rider transports the job to
GRIDGO's counter, not to the client's door. A basket has one receipt per delivered
group order, including distinct deadline groups at the same shop. A group's
receipt never contains another group's lines or total.

The rider prepares the receipt at the door, **before** asking for the paper
signature or confirming handover:

1. Complete pickup and begin transport as usual. At the client's door, record
   `POST /dispatch/:id/milestones` with `{"milestone":"arrived"}`. That existing
   endpoint binds arrival to the current rider assignment.
2. `POST /orders/:id/acknowledgement-receipt` with `{}`. Render the returned AR
   number, contents and grand total on the paper-copy guide. Issue is allowed in
   `picked_up` or `out_for_delivery`, after the order's checkout payments settle.
   Rider preparation and reads additionally require the current assignment's
   recorded arrival and an unfinished handover.
3. Hand the client the paper acknowledgement receipt and collect the signatures
   on paper. The existing rider receipt tick remains an app interaction; this API
   neither uploads nor certifies those signatures.
4. Complete `/dispatch/:id/delivery` with the existing evidence and, when
   applicable, OTP. Receipt issuance bypasses none of those gates.

Older rider builds can still complete delivery. The delivery endpoint issues the
same receipt in its transaction immediately before completing a door handover,
if no preparation call issued it. New rider builds must use step 2 to obtain the
number before writing the paper. A failure to validate receipt amounts refuses
the delivery atomically; it cannot silently deliver without a receipt.

There are two receipt states: absent (`404`) and issued (immutable snapshot).
Read the ordinary order state for delivery progress: issuance is **not proof of
delivery**. Cancellation or failed handover after issuance retains the original
receipt and number. Reassignment never changes the receipt; only the currently
assigned approved rider during their active, arrived door handover can read it.
Delivery, cancellation, reassignment or consumption of the handover closes that
rider access, including retries of POST. No receipt is issued merely by reading.
No bulk historical backfill runs during migration. Completed historical orders
without a receipt remain `404`; POST cannot backdate one. Existing active
deliveries receive one through preparation or delivery confirmation.

## Routes and authorization

All routes require the normal Clerk bearer and database role authorization
(including `X-Gridgo-Role` selection for multi-role identities).

| Method | Route | Readers / writers | Result |
| --- | --- | --- | --- |
| POST | `/orders/:id/acknowledgement-receipt` | assigned approved rider at active arrived door handover; Operations/Super Admin | `201 {receipt}` when issued; `200 {receipt}` on authorized retry |
| GET | `/orders/:id/acknowledgement-receipt` | owning client; assigned approved rider at active arrived door handover; Operations/Super Admin | `200 {receipt}` |
| GET | `/orders/:id/acknowledgement-receipt/download` | owning client; Operations/Super Admin | private `application/pdf` attachment, filename `<arNumber>.pdf` |

Ordinary invited hub staff, suppliers, unrelated clients and unassigned/former
riders have no receipt access. Rider reads intentionally expose only the same
allowlisted client receipt snapshot, not supplier principal, service-fee working,
platform shares, payout milestones, payment proofs, artwork or another group's
invoice. Riders cannot use the PDF download endpoint.

This is the explicit, receipt-only exception to the [rider billing privacy
rule](LEGAL_API.md#supplier-penalties-and-data-minimisation). Neither ordinary
order details nor lists, dispatch/history responses or notifications inline the
receipt or its client billing amounts. The rider window requires
`fulfillmentMode: "delivery"`, `picked_up | out_for_delivery`, no recorded
delivery evidence or consumed handover, and `riderProgress.events.arrived` bound
to the current rider and assignment timestamp. It is the rider's recorded
arrival, not a new GPS geofence. Stale arrival from an earlier assignment cannot
open access. Before arrival or after the window closes, GET and POST return
`403 forbidden` without receipt data; client and Operations/Super Admin reads
continue. Rider apps must discard this view when leaving the handover and on
completion, cancellation or reassignment, and must not cache it into history.

All successful reads use `Cache-Control: private, no-store, max-age=0`. Downloads
require an authenticated fetch; there is no public URL or permanent signed link.
The receipt PDF uses WinAnsi text encoding for accented Latin names (such as
José Muñoz), typographic quotes and dashes. Controls and characters outside that
encoding remain explicit Unicode escapes; the JSON snapshot retains the original
text. Backslashes and parentheses are escaped as PDF literals. Approval-proof
documents retain their existing ASCII format.

The server renders PDF bytes on demand using the same paginated text PDF format
as approval proofs. No file blob is stored in PostgreSQL or made public in MinIO.

The order ID itself is the idempotency key. A new HTTP idempotency header or a
lost response cannot allocate another number. An authorized POST retry returns the originally
issued snapshot; after delivery only Operations/Super Admin can make that POST
retry, while the client can continue GET. No request-supplied prices, customer names,
AR numbers, payment facts or dates are accepted.

## Receipt fields

Example of the approved legacy rounding case (amounts are integer PHP centavos):

```json
{
  "receipt": {
    "version": 1,
    "orderId": "ord_example",
    "orderNumber": "ord_example",
    "arNumber": "AR-0000000001",
    "issuedAt": "2026-10-21T01:00:00.000Z",
    "issuedTo": "Client account name",
    "currency": "PHP",
    "lines": [
      {"id":"line_1","description":"Flyers","quantity":1,"unitPriceMinor":5506,"subtotalMinor":5506},
      {"id":"line_2","description":"Posters","quantity":1,"unitPriceMinor":5506,"subtotalMinor":5506}
    ],
    "deliveryFeeMinor": 5000,
    "organizationDiscountMinor": 0,
    "voucherDiscountMinor": 0,
    "roundingAdjustmentMinor": -1,
    "grandTotalMinor": 16011,
    "payments": [
      {"code":"initial","type":"digital","method":"qr_manual","reference":"RECORDED-REFERENCE","amountMinor":16011,"amountReceivedMinor":null,"changeMinor":null}
    ],
    "note": "This temporary receipt acknowledges initial receipt pending final processing. It does not replace an Official Receipt or final invoice."
  }
}
```

`issuedAt` is the first successful issuance instant in UTC; apps may display it
in Asia/Manila. `issuedTo` is the owning client's stored account name at issuance,
not a rider-entered recipient or a later profile name. `orderNumber` is the
existing order ID, not the checkout invoice number. All these facts remain frozen.

`description`, `quantity`, `unitPriceMinor` and `subtotalMinor` come from the
existing client invoice projection of immutable checkout figures. For a basket,
only the matching invoice group is projected. Older orders without an invoice
use their immutable order-line snapshots and the order's own fee snapshot.
Legacy aggregate quoted orders without item snapshots retain their stored title,
quantity and combined item amount as one line; `unitPriceMinor: null` means no
unit price was recorded. Show “Not recorded”, never invent a unit price.

Existing unit prices are indicative (measured products, quantity pricing and
progressive fees can make unit price × quantity differ from the line subtotal).
Render the stored **line subtotal**; never recalculate it from the unit price.
Do not expose raw supplier amounts to make the numbers appear to reconcile.

The arithmetic invariant is:

```text
sum(lines[].subtotalMinor)
  + deliveryFeeMinor
  - organizationDiscountMinor
  - voucherDiscountMinor
  + roundingAdjustmentMinor
  = grandTotalMinor
```

`grandTotalMinor` is exactly the order's original checkout total. Organization
and voucher discounts are distinct positive deductions; omit their visual rows
when zero. `roundingAdjustmentMinor` is signed and returned even when zero;
display a **Rounding adjustment** row only when nonzero. Its absolute value must
not exceed the number of receipt lines (one centavo per line). Larger differences,
invoice/order disagreement or missing figures return
`409 acknowledgement_amount_mismatch` / `acknowledgement_amount_unavailable`
without consuming a number. Escalate to Operations/engineering; do not “fix”
amounts in either app. This preserves the existing legacy invoice display.

The receipt covers the original checkout, not subsequent separately recorded
order-change supplements, redelivery charges, pin surcharges or refunds. Those
records and original money snapshots retain their existing contracts; receipt
issuance never changes them. It does not assert that later adjustments did not
occur.

`payments[]` contains the nonzero checkout installments and their recorded method
and reference. All must be settled, and their amounts must sum to the checkout
total. Zero `not_required` installments are omitted. For basket groups the
initial reference/method/status come from the shared basket payment, while
`amountMinor` remains that group's allocated checkout installment. Never display
the whole basket payment as this group's receipt amount.

Payment `type` is `digital` for `qr_manual`, `gcash`, `maya`, `bank_transfer`,
`qr_ph`; `cash` for recorded `cash`; otherwise `unknown`. `method` preserves the
recorded value (or null). `qr_manual` does **not** prove which wallet was used;
do not label it GCash, Maya or QR Ph without recorded evidence. `reference`,
`amountReceivedMinor` and `changeMinor` may be null (“Not recorded”). Received
amount/change are copied only for recorded cash, never inferred. No new cash or
COD collection endpoint is introduced; the rider collects no payment at the
door. The downloadable copy has blank “Collected by” and “Received by” paper
signature lines and explicitly does not certify those signatures.

Always show the exact `note` in the app receipt and downloaded PDF. No tax,
VAT, TIN or official-receipt fields are added.

## Numbering and persistence

Display format is `AR-` followed by the positive global integer left-padded to
at least ten digits: `AR-0000000001`, `AR-0000000002`, etc. It never resets by
day, year, shop or rider and grows beyond ten digits without truncation.

Migration `1792521200000` adds `acknowledgement_receipts` and a singleton
`acknowledgement_receipt_counter` initialized to zero. It creates no receipts and
changes no order prices. Issuance uses the existing transaction-scoped domain
advisory lock plus a transactional counter-row update, **not** `nextval`.
Counter advance, immutable receipt insert, audit, inbox and handover (when
issued on delivery) commit together. A rollback consumes no number. The order
primary key and global number unique constraint prevent duplicates. SQL guards
reject receipt edits/deletion/truncation and counter resets.

The running series is the **issued** receipt series. A number already shown to
a rider must remain in that series even if the client later refuses delivery;
it is never reclaimed or reused. Thus filtering to only completed deliveries
can show missing numbers, but the issued ledger has no allocation gaps.

An issuance writes audit `acknowledgement_receipt.issued`, one durable inbox row
of type `acknowledgement_receipt_ready` to the client and each current Operations
and Super Admin membership, and queues `orders`, `dispatch`, `notifications`
invalidations through `save()`. Retries create none of these again. Ordinary
order projections do not inline the receipt; clients should read this endpoint
from the order screen and refresh it on the inbox event.

## Errors and rollout

| Status | Error | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Missing/invalid Clerk session |
| 403 | `forbidden` | Wrong party/role, unapproved rider, rider outside the active arrived handover, or rider PDF request |
| 404 | `order_not_found` | Unknown order |
| 404 | `acknowledgement_receipt_not_found` | No receipt issued, including excluded pickup and historical work |
| 409 | `acknowledgement_not_available` | First issuance outside active door transport or without an assigned rider |
| 409 | `acknowledgement_payment_pending` | A nonzero checkout installment is not settled |
| 409 | `acknowledgement_amount_unavailable` | Missing/non-integer stored money, quantity or item description |
| 409 | `acknowledgement_amount_mismatch` | Snapshot/total mismatch, excess rounding, or payment amounts do not sum to checkout |
| 409 | `acknowledgement_customer_unavailable` | Owning account has no stored name |

Deploy the additive migration before this API. Rider/client releases follow this
contract; no feature switch or production backfill is required. Existing receipt
ticks, delivery evidence and OTP requirements remain supported. API deployment
alone makes receipts available after new door deliveries; the companion apps
must ship before calling the complete client/rider experience released.
