# Approval signature proof

Approval proofs record exactly what the owning client approved. The record is
evidence of the agreed print specification, not a supplier payout authorization.
This is the API contract for the separate client, shop and dashboard releases
(gridgo-client#248; issue report DAE9EE01).

## Rollout and compatibility

`GET /settings` exposes `approvalProofRequired`, default **false**. Only Super
Admin may change it with the existing `PATCH /settings` version/reason handshake.
Apply migration `1792230000000` before deploying. No backfill invents approvals
for existing orders.

New cart checkouts and new legacy request orders snapshot an `approvalPolicy`:
`{version:1, required:boolean, method:"one_tap"|"drawn"}`. Changing settings later
does not alter that order's requirement. Existing request orders without a policy
remain compatible. A cart snapshots the switch at checkout, so a client should
refresh settings before submitting payment and handle `approval_proof_required`.

When the switch is off, old checkout/quote/sample requests still work. The API
records an immutable `legacy_unrecorded` snapshot with null method, statement,
device and signature. This explicitly means **no approval was collected**; never
display it as signed or approved. Updated apps may send explicit approvals while
the switch is off. Existing orders without records return an empty record list.

Enable enforcement only after client signature/one-tap flows, shop proof views
and dashboard proof views are released and old-build update coverage is confirmed.
The API deployment alone does not complete the production rollout. After enabling,
new checkout groups cannot be placed without approval. Required orders also cannot
enter `payment_authorized` or `production` without their checkout approval, including
through alternate mutation paths using `save()`.

## Choosing a method

The server derives the method; it ignores a client-supplied product classification.

| Flow | Required method |
| --- | --- |
| Cart group with any listing in service category `corporate_event_merch` | `drawn` |
| Other standard cart group | `one_tap` (a drawn signature is also accepted) |
| Quoted job through the legacy request/final-quote flow | `drawn` |
| Existing `proof_approval` sample/artwork decision | `drawn` plus received-sample photo |

The taxonomy and existing flow states provide these signals, so no additional
category settings are necessary. A basket has one order per shop/deadline group;
each gets its own proof containing only that group's lines. A basket approval
must use `drawn` if any group needs it. Its same signature may be bound to each
group in the single checkout transaction. `GET /me/carts/:id` exposes
`approvalProofRequired` and each line's `approvalMethod`.

## Uploading private evidence

Use existing `POST /files` multipart upload and ready-state handling:

| Purpose | Uploader | Types | Limit | Retention |
| --- | --- | --- | --- | --- |
| `approval_signature` | owning client | PNG | 2 MiB | existing one-year order-evidence policy |
| `approval_sample_photo` | owning client | JPEG, PNG, WebP | 20 MiB | existing one-year order-evidence policy |

Draw on a signature pad and rasterize to PNG. The API verifies upload type,
ownership, size, ready state and purpose; it does not attest that handwriting is
authentic or that a device identifier is hardware-backed. These purposes bind
only through approval submission, never `/files/:id/attach`. Upload without an
order reference first; approval submission attaches it atomically. Reuse of the
same client-owned signature across one basket's groups is supported.

MinIO stores all bytes. PostgreSQL keeps opaque file references, byte hashes when
available, and metadata. A signature/photo is order evidence, like existing
handoff signatures and fulfilment photos, so this does not change retention
durations or early-deletion authority. Unused uploads retain the 24-hour grace
period. Every open issue, claim, refund, dispute or escalation holds deletion,
including retries and Super Admin early deletion. Automatic deletion remains off
by default. Artwork keeps its existing 30-day completion retention; this feature
does not promise permanent artwork bytes. Immutable metadata/proofs outlive byte
retention. External artwork links record the agreed URL, not a permanent copy of
the external provider's mutable content.

## Checkout and final quote approval

Include `approval` on `POST /me/carts/:id/checkout`, alongside the existing shared
QR receipt. It covers all groups, while the API creates one record per order:

```json
{
  "payment": {
    "method": "qr_manual",
    "proofFileId": "receipt_id",
    "reference": "BANK-REFERENCE"
  },
  "approval": {
    "accepted": true,
    "method": "drawn",
    "signatureFileId": "signature_id",
    "expectedCartVersion": 7,
    "device": {
      "id": "app-installation-id",
      "platform": "android",
      "appVersion": "2.4.8"
    }
  }
}
```

For a standard order use `method:"one_tap"`, omit `signatureFileId`, and show the
client the statement **I approve this order**. `accepted` must be exactly `true`.
Device `id`, `platform`, `appVersion` are nonblank strings, each at most 160
characters. Do not send hardware serials or authentication tokens. The server
records the authenticated GRIDGO account, server time and bounded User-Agent;
the client cannot supply the approval actor or timestamp.

`expectedCartVersion` must equal the version the client reviewed. Any line edit
requires review and approval again. Checkout continues to validate live listing
versions, artwork/link checks, prices and availability under its existing contract.
Failure rolls back orders, jobs, evidence references, audit and notifications
together; basket receipt confirmation remains exclusively the basket boundary.

For a quoted job, first `GET /orders/:id/approval-proof`. Display its `review`
snapshot beside the final quote. Add `approval` to the existing
`POST /orders/:id/transition` body with `state:"awaiting_initial_payment"`, the
existing `quoteVersion`, fulfillment and payment-plan fields. Use `drawn` and
`expectedSnapshotSha256` from `review.snapshotSha256`, instead of a cart version.
Both the quote version and review digest are checked before commit. The proof
records the accepted quote version and specification; later quote supersession
requires another approval and appends another record.

## Received-sample approval

The existing `proof_approval` order state is the sample/artwork approval boundary.
There is no new sample-fulfillment state machine. Either send approval with the
client's existing transition to `approved_for_matching`, or record it first:

`POST /orders/:id/approval-proof` (owning client; only in `proof_approval`):

```json
{
  "approval": {
    "accepted": true,
    "method": "drawn",
    "signatureFileId": "signature_id",
    "samplePhotoFileId": "received_sample_photo_id",
    "expectedSnapshotSha256": "digest-from-current-review",
    "device": { "id": "app-installation-id", "platform": "ios", "appVersion": "2.4.8" }
  }
}
```

Success is `200 {approvalProofs:[...]}`. This records evidence; it does not move
the order. The existing transition may omit approval if a current drawn sample
proof already exists for the same snapshot and sample round. Changed artwork,
specification or a new `proof_approval` round requires another signature and photo.
The explicit proof endpoint always requires approval, including with enforcement
off. A sample approval never substitutes for final quote/checkout approval.

## Read, display and download

`GET /orders/:id/approval-proof` returns:

```json
{
  "requirement": { "version": 1, "required": true, "method": "drawn" },
  "approvalProofs": [],
  "review": { "snapshot": {}, "snapshotSha256": "current-review-digest" }
}
```

`review` is the current review candidate, not signed evidence. Display persisted
`approvalProofs` when showing what was actually approved. Each version-1 record has
`id`, `phase` (`checkout|sample`), `status` (`approved|legacy_unrecorded`), `method`,
`at`, `account` (GRIDGO ID/name/email/account type), `device`, `userAgent`,
`statement`, signature/sample file IDs, `evidence` metadata, `sampleRoundAt`,
`snapshot` and `snapshotSha256`. The digest is SHA-256 of UTF-8 JSON with object
keys sorted recursively and array order preserved; treat it as an opaque review
token. It is not a digital-signature certificate.

Only the owning client, Operations and Super Admin receive the full `account`,
`device` and `userAgent` evidence. Assigned-shop JSON reads and PDF downloads omit
client identity, contact and device fields. The shop receives approval facts,
agreed specification, evidence references and the specification fingerprint.
These role projections never change the immutable stored record.

The immutable snapshot is built from existing agreed order-line and quote
snapshots. It includes uploaded artwork references and hashes/metadata, external
design links, item descriptions, quantities, measurements, selected spec labels,
document page ranges, print layout/check, colour targets, per-page colour tier,
cover/spine, special instructions and upload guidance/warning acceptance. Fields
unavailable in a historical snapshot stay absent. It never reads updated catalogue,
account or settings values to reconstruct an old proof. It excludes supplier
principal, tier sheet prices, supplier payout stages and private object keys.

`GET /orders/:id/approval-proof/download` returns a rendered `application/pdf`
attachment containing the role-projected immutable records with page numbers. It lists private
signature/sample/artwork evidence IDs and available byte hashes; it does not embed
image bytes or expiring URLs. Apps display the corresponding private images using
`GET /files/:fileId/download-url`, whose signed URL expires under the existing
storage contract. No generated PDF blob is stored in PostgreSQL or MinIO. An order
without records returns `404 approval_proof_not_found` for download.

Proof reads/downloads and signature/sample image reads allow the owning client,
Operations, Super Admin, and the currently assigned approved shop after the
artwork/file-check release. Other clients, shops, riders, staff and the support
desk are denied. Historical multi-shop orders fail closed for shop proof reads;
new basket groups are single-shop orders. Proof and signature/photo responses use
`Cache-Control: private, no-store, max-age=0`.

Ordinary order projections expose only `approvalProof` with `requirement`, a
record summary (`id`, phase/status/method/time/digest), `readUrl` and `downloadUrl`
to the same allowed parties. Full records and raw `approvalPolicy` are stripped
by `publicOrderFor`; riders receive neither. Existing role-safe money projection
continues to apply to all ordinary orders.

## Persistence, events and errors

`orders.data.approvalProofs` is append-only. The forward migration prevents
changing/removing any previous record or its saved policy. Later approvals append;
later edits to carts, listings, profiles or spec records cannot rewrite old
proof snapshots. All approval evidence bindings, audit rows and notifications
commit in the enclosing HTTP transaction/advisory lock. Recording a proof writes
`order.approval_recorded` audit and durable `order_approval_recorded` inbox rows to
every Operations/Super Admin membership, and queues order/job invalidations before
`save()`. Push delivery remains after commit.

| HTTP | Error | Meaning |
| --- | --- | --- |
| 400 | `invalid_approval` | Explicit acceptance or required method is invalid |
| 400 | `approval_device_required` | Device/app metadata missing or invalid |
| 400 | `invalid_approval_file` | Missing, foreign-owned, wrong-purpose or incomplete evidence |
| 400 | `invalid_approval_proof_required` | Non-boolean rollout setting |
| 401/403 | `unauthorized` / `forbidden` | Authentication/party/role gate |
| 404 | `order_not_found` / `approval_proof_not_found` | Missing order or no downloadable record |
| 409 | `approval_proof_required` | Required approval not yet recorded |
| 409 | `approval_cart_stale` / `approval_snapshot_stale` | Client must review current content again |
| 409 | `file_not_ready` | Evidence upload not ready or being deleted |
| 409 | `sample_approval_not_allowed` | Explicit sample endpoint outside its decision step |

The existing quote-version errors, settings handshake and artwork/availability
errors remain applicable.
