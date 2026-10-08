# GRIDGO Storage API contract

This is the authoritative contract for all three mobile apps. It covers client artwork, milestone Proofs of Fulfilment (POFs), rider delivery/checklist photos, supplier-service images, the platform payment QR, and private supplier and rider verification documents. Field names, states, status codes, and error codes are stable and case-sensitive.

## Architecture decision

GRIDGO uses the API as the **control plane** and MinIO as the **download data plane**:

1. `POST /files` streams multipart bytes through the API. The API counts bytes, captures only signature bytes in memory, writes the upload to a temporary file, validates magic bytes, and then streams that file to MinIO. It never buffers the complete upload in RAM.
2. The API creates a durable `pending_upload` file record **before** `PutObject`. A successful response is sent only after MinIO confirms the put and the record is durably changed to `ready`.
3. `POST /files/:fileId/attach` separately binds a ready file to a domain record. It rechecks lifecycle state, uploader, purpose, detected media type, target ownership/state, metadata integrity, and MinIO object existence and byte size.
4. `GET /files/:fileId/download-url` authorizes the caller from current domain relationships, checks the object, and returns a short-lived presigned GET. MinIO serves the bytes.

Presigned GETs avoid routing 50–200 MiB artwork back through the single Node process. Payment proofs and payout/refund receipts additionally support an authenticated API byte read for browser receipt reading when a LAN storage origin is blocked. Uploads remain proxied because only the API can enforce byte limits and signature inspection before declaring a file ready.

The prior NestJS API's broader shape—upload, presigned URL, inspect, get, delete, and my-uploads—was evaluated. This contract adopts upload, metadata get, presigned GET, and safe delete. Binary inspection and `my-uploads` are deferred: inspection needs a defined analysis product, while current apps reach files from role-scoped orders/services. Those routes may be added later without changing this contract.

## MinIO origins and physical phones

`MINIO_ENDPOINT` and `MINIO_PUBLIC_URL` are intentionally separate fixed origins:

- `MINIO_ENDPOINT` is used by the API for put/stat/delete, normally `http://127.0.0.1:9000`.
- `MINIO_PUBLIC_URL` is used by the signer. It must be the exact origin the phone will request. A signed URL must never be rewritten afterward; changing its host, port, path, or signed query invalidates SigV4.
- The API never derives the signing origin from an HTTP `Host` header.

Safe desktop default:

```dotenv
MINIO_BIND_ADDRESS=127.0.0.1
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_PUBLIC_URL=http://127.0.0.1:9000
```

Physical device on a trusted LAN, using an example API-host address of `192.168.1.10`:

```dotenv
MINIO_BIND_ADDRESS=192.168.1.10
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_PUBLIC_URL=http://192.168.1.10:9000
```

Then restart Compose so the exact binding takes effect. This is an explicit LAN-only opt-in and is off by default. Never use `0.0.0.0` or a bare Docker port mapping; the Compose preflight accepts only one explicit IPv4 address and rejects wildcard/IPv6 forms. Docker-published ports bypass host `ufw`; do not expose MinIO on an untrusted LAN or the internet. The console stays on `127.0.0.1` in every mode. The bucket is private, and possession of a signed URL grants read access only until its five-minute expiry.

For the hosted pilot, `MINIO_ENDPOINT` is the single-label MinIO container origin on the private network while `MINIO_PUBLIC_URL` is the Cloudflare-facing public HTTPS origin. Caddy receives plain HTTP from Cloudflare Flexible TLS and exposes only the signed private-bucket path, never the MinIO port or console. Production startup rejects an absent or non-HTTPS public URL. See [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) for the exact topology, backup, and restore procedure.

## Base conventions

- API example base: `http://127.0.0.1:18787`
- Auth header on every route below: `Authorization: Bearer <Clerk session JWT>`
- Errors: JSON `{ "error": "snake_case", "message": "concrete problem and recovery" }`, with only the documented additive detail fields
- Upload field names: exactly one binary `file` and one text `purpose`
- Upload, target-resolution, and attach role labels mean PostgreSQL memberships, not the legacy `users.role`; an identity that adds supplier membership can upload and attach its own supplier evidence and service images.
- The client must not supply a bucket, object key, URL, owner ID, lifecycle state, size, or detected MIME
- IDs are opaque. Clients may persist `fileId`, never an object key or presigned URL.

Obtain Clerk session JWTs from the corresponding signed-in development clients,
then export them for the examples below. The API never issues local tokens:

```bash
API=http://127.0.0.1:18787
CLIENT_TOKEN='<Clerk client session JWT>'
SUPPLIER_TOKEN='<Clerk supplier session JWT>'
RIDER_TOKEN='<Clerk rider session JWT>'
OPS_TOKEN='<Clerk Operations session JWT>'
```

## File metadata and parent references

A public file object has exactly this shape:

```json
{
  "fileId": "file_8c9f61e4b2aa",
  "purpose": "artwork",
  "originalFilename": "opening-banner-final.pdf",
  "declaredContentType": "application/octet-stream",
  "detectedContentType": "application/pdf",
  "size": 48231,
  "ownerId": "user_client",
  "state": "ready",
  "createdAt": "2026-08-09T10:15:30.000Z",
  "readyAt": "2026-08-09T10:15:31.000Z",
  "deleteRequestedAt": null,
  "deletedAt": null,
  "references": [
    { "type": "order", "id": "ord_demo_1", "field": "artworkFileIds" }
  ]
}
```

For `purpose: "verification_document"`, the attached file object additionally contains `verificationDocumentType: "business_permit" | "valid_id" | "sample_work"`, and its user reference contains the same value as `documentType`. That field is absent before attachment and for every other purpose.

The durable internal record additionally has a server-generated `objectKey`. It is never returned as a standalone metadata field. The authorized presigned URL necessarily encodes the bucket and key in its signed path; clients must treat the complete URL as an opaque, expiring capability and never parse those internals. `purpose` is the retention and authorization tag; it is not inferred from a target.

Parents contain IDs only:

| Purpose | Parent reference field |
|---|---|
| `artwork` | `order.artworkFileIds: string[]` |
| `production_photo` | `order.productionPhotoFileIds: string[]`; plain progress only |
| `packing_photo` | `order.packingPhotoFileIds: string[]`; packed-work evidence only |
| `fulfilment_proof` | `order.fulfilmentProofFileIds: string[]` and the selected `payoutMilestone.pofFileIds` |
| `delivery_photo` | `order.deliveryPhotoFileIds: string[]` |
| `handoff_signature` | `order.handoffSignatureFileIds: string[]`; the one the checklist was signed against is `order.pickupChecklist.handoffSignature.fileId` |
| `service_image` | `supplierService.imageFileIds: string[]` |
| `catalog_item_photo` | listing photo rows on `supplier_catalog_item` (`sortOrder` 0–7, optional `altText`) |
| `supplier_shop_image` | shop media slot `logo` or `cover` |
| `verification_document` | `supplier.verificationDocumentFileIds: string[]` (private; never part of `PublicUser`) |
| `supplier_payout_qr` | `supplierPayoutAccount.qr.fileId` (private to that shop and Operations; bound through `PATCH /me/payout-account`, never through attach) |
| `refund_qr` | refund destination plate; owning client and ops/super only |
| `refund_evidence` | refund request evidence; owning client and ops/super only |
| `refund_receipt` | client-refund wallet transfer evidence; owning client and ops/super only |
| `payout_receipt` | `order.payoutReceiptFileIds: string[]` and `payoutMilestone.receiptFileId` (Operations and the assigned shop; bound at `POST /orders/:id/milestones/:code/release`, never through attach) |
| `rider_verification_document` | `riderDocument.fileId: string` (private evidence; prior rows remain after replacement or deletion) |
| `tracker_decision` | `tracker_decisions.attachment_ids` (Super Admin only; bound by `POST /admin/tracker/:repo/:number/decisions`, never through attach) |
| `delivery_chat_image` | `delivery_chat_messages.attachment_file_ids` (the delivery's client and rider only; bound by `POST /orders/:id/delivery-chat/messages`, never through attach) |

Legacy orders may still return `proofFileIds` containing retired supplier-proof files. They remain readable evidence but the `proof` upload purpose and supplier-proof workflow no longer accept writes.

`order.artworkName` remains as a backward-compatibility display string and is populated from `originalFilename` when artwork is attached. It is never file identity, never accepted as a key, and never proves an object exists. No artwork and empty file-ID arrays are valid.

## Purpose policies

Validation uses the filename extension, the declared part MIME when it is specific, and file magic bytes. Magic bytes are authoritative; renaming a file is not enough. Empty or `application/octet-stream` declared MIME is accepted for iOS only when extension and magic agree. A conflicting specific MIME is rejected.

| Purpose | Upload role | Allowed detected types | Maximum |
|---|---|---|---|
| `artwork` | client | JPEG, PNG, WebP, PDF, DOCX, Photoshop (`image/vnd.adobe.photoshop`, magic `8BPS`) | 200 MiB (`209715200`); DOCX 16 MiB (`16777216`) |
| `mockup` | client | JPEG, PNG, WebP, PDF | 20 MiB (`20971520`) |
| `payment_proof` | client | JPEG, PNG, WebP | 15 MiB (`15728640`) |
| `production_photo` | supplier | JPEG, PNG, WebP | 200 MiB (`209715200`) |
| `packing_photo` | supplier | JPEG, PNG, WebP | 200 MiB (`209715200`) |
| `fulfilment_proof` | supplier or rider; assignment checked on attach | JPEG, PNG, WebP, PDF | 200 MiB (`209715200`) |
| `delivery_photo` | rider | JPEG, PNG, WebP | 20 MiB (`20971520`) |
| `handoff_signature` | rider | PNG | 2 MiB (`2097152`) |
| `service_image` | supplier | JPEG, PNG, WebP | 20 MiB (`20971520`) |
| `catalog_item_photo` | supplier | JPEG, PNG, WebP | 15 MiB (`15728640`) |
| `supplier_shop_image` | supplier | JPEG, PNG, WebP | 15 MiB (`15728640`) |
| `verification_document` | supplier, including pending | JPEG, PNG, WebP, PDF | 20 MiB (`20971520`) |
| `supplier_payout_qr` | supplier, including pending | JPEG, PNG, WebP | 5 MiB (`5242880`) |
| `payout_receipt` | ops/super | JPEG, PNG, WebP | 15 MiB (`15728640`) |
| `refund_qr` | client | JPEG, PNG, WebP | 5 MiB (`5242880`) |
| `refund_evidence` | client/ops/super | JPEG, PNG, WebP | 15 MiB (`15728640`) |
| `refund_receipt` | ops/super | JPEG, PNG, WebP | 15 MiB (`15728640`) |
| `delivery_chat_image` | client or rider | JPEG, PNG, WebP | 15 MiB (`15728640`) |
| `rider_verification_document` | rider, including pending | JPEG, PNG, WebP, PDF | 20 MiB (`20971520`) |
| `tracker_decision` | super | JPEG, PNG, WebP, PDF | 10 MiB (`10485760`) |

Accepted detected types are `image/jpeg`, `image/png`, `image/webp`, and where shown `application/pdf`. Artwork also accepts Photoshop (`image/vnd.adobe.photoshop`) and DOCX (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `.docx`). HEIC/HEIF is deliberately rejected with `415 invalid_file_type` with `reason: "heic_not_supported"`; the app must request JPEG camera output or convert before upload. 3MF and STL are listing chips only until a dedicated model-file sniff exists — they are not stored through `POST /files`.

DOCX is artwork-only. The complete ZIP is checked before storage: at most 16 MiB
compressed, 2,048 entries, 16 MiB expanded per entry and 64 MiB expanded overall,
with at most a 200:1 compression ratio per entry. Stored and deflated entries,
including data descriptors, are supported. CRCs, declared lengths, local and
central headers must agree; duplicate/unsafe paths, overlaps, encrypted, ZIP64,
macro-bearing and unsupported compression containers are refused. A renamed
arbitrary ZIP is not a DOCX: `[Content_Types].xml` must identify the Word main
part and `word/document.xml` must contain Word document/body markup. Malformed
or over-budget packages return `415 invalid_file_type`; DOCX uploads above
16 MiB return `413 file_too_large`. No archive entry is extracted to disk, no
external XML entity or relationship is fetched, and no document is rendered.
This is a bounded package check, not a full Word validator or print preview.

The automatic artwork verdict accepts a structurally valid DOCX even without
page metadata. `detected` uses `kind: "document"`, `pageCount` from a positive
safe-integer `docProps/app.xml` `<Pages>` value, or `null` when absent/unusable.
Dimensions stay unknown. Word's cached page count is advisory and can depend on
fonts/layout; Operations still checks print readiness. See [document page
selection](ORDER_MATCH_API.md#document-page-selection) for manual DOCX counts.

Client file pickers must offer `.docx` and its MIME above (or use the governed
registry's uploadable types); clients must permit entering `measurement.pages`
when a DOCX's detected count is null. This API change does not update any app.


The upload request timeout defaults to 15 minutes. Clients may show transfer progress, but progress reaching 100% is **not success**. Only a `201` response containing `file.fileId` means MinIO storage and `ready` metadata both completed. Retry after any lost connection or non-201 response; never invent or reuse a guessed ID.

## POST /files — streamed upload

Auth: `client` for `artwork`; `supplier` for `service_image`, `catalog_item_photo`, `supplier_shop_image`, `verification_document`, supplier `production_photo`, supplier `packing_photo`, and supplier `fulfilment_proof`; rider for `delivery_photo`, `handoff_signature`, `rider_verification_document`, and rider `fulfilment_proof`. Assignment and domain state are rechecked when a file is attached. Pending applicants may upload their own role-specific evidence; no other identity may upload it on their behalf.

Request: `multipart/form-data` with exactly:

| Field | Type | Required | Value |
|---|---|---|---|
| `purpose` | text | yes | one purpose enum |
| `file` | file | yes | one file with a filename; part MIME may be empty/generic on iOS |

React Native / Expo:

```ts
const form = new FormData();
form.append("purpose", "artwork");
form.append("file", {
  uri: pickedAsset.uri,
  name: pickedAsset.name ?? "artwork.jpg",
  type: pickedAsset.mimeType ?? "application/octet-stream",
} as any);

const response = await fetch(`${apiUrl}/files`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

Do not manually set the request `Content-Type`; React Native supplies the multipart boundary. The native fetch body streams from the file URI. Do not read the URI into base64 or a JavaScript buffer.

Success: `201 { "file": File }`; returned `file.state` is always `ready`, `references` is initially `[]`, and `objectKey` is absent.

Curl for each purpose:

```bash
ARTWORK_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $CLIENT_TOKEN" \
  -F 'purpose=artwork' -F 'file=@./artwork.pdf;type=application/octet-stream' | tee /tmp/artwork-upload.json | jq -r .file.fileId)

POF_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -F 'purpose=fulfilment_proof' -F 'file=@./start-pof.png;type=image/png' | tee /tmp/pof-upload.json | jq -r .file.fileId)

DELIVERY_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $RIDER_TOKEN" \
  -F 'purpose=delivery_photo' -F 'file=@./handoff.jpg;type=image/jpeg' | tee /tmp/delivery-upload.json | jq -r .file.fileId)

SERVICE_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -F 'purpose=service_image' -F 'file=@./press.webp;type=image/webp' | tee /tmp/service-upload.json | jq -r .file.fileId)

VERIFICATION_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -F 'purpose=verification_document' -F 'file=@./business-permit.pdf;type=application/pdf' | tee /tmp/verification-upload.json | jq -r .file.fileId)

RIDER_LICENSE_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $RIDER_TOKEN" \
  -F 'purpose=rider_verification_document' -F 'file=@./drivers-license.jpg;type=image/jpeg' | tee /tmp/rider-license-upload.json | jq -r .file.fileId)

PAYMENT_QR_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $OPS_TOKEN" \
  -F 'purpose=payment_qr' -F 'file=@./gcash-qr.jpg;type=image/jpeg' | tee /tmp/payment-qr-upload.json | jq -r .file.fileId)
```

`payment_qr` is Operations / Super Admin only (JPEG/PNG/WebP, 5 MiB). It is not attachable to an order. Activate it with `POST /settings/payment-qr`; checkout reads the public `GET /public/payment-qr` path advertised as `settings.paymentQr.imageUrl`.

`payout_receipt` is the wallet screenshot Operations keeps after paying a shop (JPEG/PNG/WebP, 15 MiB). It is not attachable: upload it, then release the share with `receiptFileId` (and an optional `reference`) on `POST /orders/:id/milestones/:code/release`. Binding writes an `order` reference with field `payoutReceiptFileIds`, so the file reads as `file_in_use`; Operations and the assigned shop may read it, a client never can.

`tracker_decision` is evidence a Super Admin attaches to a tracker decision (JPEG/PNG/WebP/PDF, 10 MiB, at most 6 per decision). It is not attachable: upload it, then send its `fileId` in `attachmentIds` to `POST /admin/tracker/:repo/:number/decisions` ([Tracker API](TRACKER_API.md)). Binding writes a `tracker_decision` reference so the file reads as `file_in_use`. Only Super Admin may upload, read, sign or delete it; Operations gets `403`.

`supplier_payout_qr` is the shop's own receiving plate (JPEG/PNG/WebP, 5 MiB), the one Operations scans to release a payout. It is not attachable either: upload it, then send its `fileId` as `qrFileId` to `PATCH /me/payout-account` (see `docs/OPERATIONAL_MODEL_V2_API.md`, "Supplier payout account"). Binding writes a `supplier_payout_account` reference; replacement/removal unlinks the old plate. The old picture then follows unused-file cleanup, including its default-off deletion flag, just like a replaced platform QR. Only the owning shop and Operations / Super Admin may read the bytes through `GET /files/:id/download-url`.

## POST /files/:fileId/attach — bind to a domain record

Auth: the caller must be the file owner **and** the relevant parent owner/assignee. Attaching `fulfilment_proof` or `delivery_photo` also requires current approval for the required supplier/rider membership. Verification-document intake remains available to its unapproved owner. The body is JSON and contains exactly the fields selected by the stored purpose:

| Purpose | Body | Required state/ownership |
|---|---|---|
| `artwork` | `{ "orderId": "..." }` | caller is `order.clientId`; any current order state |
| `production_photo` | `{ "orderId": "..." }` | assigned approved supplier, while order is `production` or `supplier_self_qc`; otherwise `409 production_photo_upload_not_allowed` |
| `packing_photo` | `{ "orderId": "..." }` | assigned approved supplier, while order is `production` or `supplier_self_qc`; otherwise `409 packing_photo_upload_not_allowed` |
| `fulfilment_proof` | `{ "orderId": "...", "milestoneCode": "production_started" }` | a stage of the order's own payout plan that takes a file: assigned supplier for `production_started` (plan 2) or `printing`/`packaging_qc` (legacy plan 1); assigned rider for `delivered`. `issue_window` and `retention` take no direct upload |
| `delivery_photo` | `{ "orderId": "..." }` | caller is assigned `order.riderId`; state `rider_assigned`, `picked_up`, `out_for_delivery`, `delivered`, or `issue_window_open` |
| `handoff_signature` | `{ "orderId": "..." }` | caller is assigned `order.riderId`; state `rider_assigned` only, else `409 handoff_signature_upload_not_allowed`. Named by `signature.fileId` on `POST /dispatch/:id/pickup-checklist` |
| `service_image` | `{ "supplierServiceId": "..." }` | caller is `supplierService.supplierId` |
| `verification_document` | `{ "documentType": "business_permit" }` or `{ "documentType": "sample_work", "replaceFileId": "..." }` | caller is a supplier; target is always derived from the token and cannot be supplied |
| `rider_verification_document` | `{ "riderDocumentType": "drivers_license", "expiresOn": "2028-06-30" }` | caller is the rider owner; licence requires a future expiry, while `or_cr` and `selfie` omit it |

Immediately before commit the API revalidates: `state === "ready"`, caller equals `ownerId`, the file has no existing reference, purpose matches the target family, detected MIME is still allowed for that purpose, object key is nonempty, size is positive, domain ownership/state still permits attach, and MinIO `stat` finds the object with the recorded size. A `fileId` attaches once. A file cannot be rebound even if another user knows its ID.

Success: `200 { "file": File, "order": Order }` for order purposes, `200 { "file": File, "supplierService": SupplierService }` for a service image, or `200 { "file": File, "user": PublicUser, "verificationDocuments": File[] }` for a verification document. The returned parent projection already includes the attachment. A POF attach changes the selected milestone from `pending_pof` to `pof_attached`; on a legacy plan-1 order a delivered POF is also linked to `retention`.

A rider-document attach returns `{file,riderDocument,approvalCase}`. Attaching `drivers_license` replaces the prior current licence without deleting it but remains evidence-only; the explicit rider submit endpoint rechecks readiness and sets `submittedAt`. Optional `or_cr` and `selfie` replace only their own current slots.

Verification-document attachment rules:

- `documentType` is required and must be exactly `business_permit`, `valid_id`, or `sample_work`.
- The API derives the supplier account from the bearer token. `userId`, `supplierId`, and all other target fields are rejected with `400 unexpected_target_field`; a supplier cannot target another account.
- Attaching `business_permit` or `valid_id` automatically replaces every prior attachment in that singleton slot. Replaced files remain private and follow the verification retention policy below; only Super Admin may delete them early with a reason.
- `sample_work` without `replaceFileId` appends another photo/document. To replace one sample, send its currently attached `fileId` as `replaceFileId` with `documentType: "sample_work"`.
- `replaceFileId` may also select the current permit or ID explicitly. It must be attached to the caller in the same type slot or the API returns `409 verification_document_replacement_mismatch`.

Curl for all six targets:

```bash
curl -fsS -X POST "$API/files/$ARTWORK_FILE_ID/attach" -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_demo_1"}' | jq

curl -fsS -X POST "$API/files/$POF_FILE_ID/attach" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_production","milestoneCode":"production_started"}' | jq

curl -fsS -X POST "$API/files/$DELIVERY_FILE_ID/attach" -H "Authorization: Bearer $RIDER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_active_delivery"}' | jq

curl -fsS -X POST "$API/files/$SERVICE_FILE_ID/attach" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"supplierServiceId":"svc_demo_print"}' | jq

curl -fsS -X POST "$API/files/$VERIFICATION_FILE_ID/attach" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"documentType":"business_permit"}' | jq

curl -fsS -X POST "$API/files/$RIDER_LICENSE_FILE_ID/attach" -H "Authorization: Bearer $RIDER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"riderDocumentType":"drivers_license","expiresOn":"2028-06-30"}' | jq
```

## GET /files/:fileId — metadata

Auth for ordinary purposes: `ops_admin`, `super_admin`, file owner, or a user related to any current reference: the referenced order's client/assigned supplier/assigned rider, the referenced service's owner supplier, or any authenticated user when the referenced service is `live`. Unattached ordinary files are visible only to owner and ops/super. A `handoff_signature` is additionally never readable by the order's client — it is a person's handwriting, and the client has no part in the counter handoff. When acting as supplier/rider, an order-referenced file additionally requires current approval, even for its uploader. Explicit [actor role selection](OPERATIONAL_MODEL_V2_API.md#selecting-an-actor-role) applies to file authorization and returned parent projections throughout upload/attach transactions.

`packing_photo` metadata and signed reads are limited to its supplier owner, the owning client after attachment, and Operations/Super Admin. Riders cannot read it, including an assigned rider. It uses the existing one-year order-photo retention policy and open-case holds.

`support_chat_image` reads use the conversation boundary (`canViewThread` in `src/support-chat.js`). Photos in a private staff-pair thread are available only to its participants, including against unrelated Operations/Super Admin callers. Photos in a party support thread remain available to that party and the shared staff inbox. Unsent uploads are owner-only. This applies to metadata and signed download URLs.

`delivery_chat_image` reads follow the delivery conversation (`canReadDeliveryChatPhoto` in `src/delivery-chat.js`): the order's client and the rider the photo was sent with, while that rider still has the job and the conversation is open or read-only. Operations, Super Admin, a reassigned rider and, after the conversation closes, the sender too are refused. When the lifecycle sweep deletes the conversation it removes the references, sets the photos `delete_pending` (`deletionSource: "early"`, `deletionReason: "delivery_chat_closed"`) and deletes their objects; the file retention pass retries any that storage refused. Unsent uploads are owner-only and expire as unused files.

Artwork and mockup reads for suppliers/riders follow the reader's assigned job lines, including `line:<lineId>:artwork|mockup` references. A line reference must resolve to that order's line, the requested file, and a job assigned to the reader; a primary order assignment, uploader ownership, or additional order-wide reference cannot bypass that check. Files shared by multiple lines are readable through any assigned line. The same scope filters `artworkFileIds`, `mockupFileIds`, and the artwork filename in order responses. The owning client and Operations/Super Admin retain full access.

Operations supplier reassignment transfers the former supplier's jobs in the same transaction as the order assignment. Line snapshots and file references stay unchanged: the replacement can read those jobs' artwork, mockups, and design links, and the former supplier can no longer request their metadata or new download URLs. Other jobs retain their existing scope. Previously issued signed URLs remain usable until their normal expiry (five minutes by default, at most fifteen minutes); reassignment does not revoke those URLs.

For older order-level references, the API uses the line snapshots when available. Unattributed artwork/mockups retain legacy access on a single-shop order. On multi-shop orders they are omitted from supplier/rider lists and return `403 forbidden` for metadata and signed URLs; client/staff access remains available. Riders assigned multiple jobs can read all of those jobs' attributed files, preserving combined-delivery access without granting access to unassigned jobs. Current order-read authorization still selects one active rider; this file rule does not broaden order access.

Auth for `verification_document` is intentionally stricter and never inherits order/service visibility: only the supplier owner, `ops_admin`, or `super_admin` may read metadata or request a download URL. Another supplier, client, and rider always receive `403 forbidden`, even if a malformed legacy reference points at one of their orders/services. Supplier document lists use `GET /users/:id/verification-documents` as specified in `docs/OPERATIONAL_MODEL_V2_API.md`.

`rider_verification_document` is likewise private to its rider owner and Operations/Super Admin. It never inherits order or service visibility.

Success: `200 { "file": File }`.

```bash
curl -fsS "$API/files/$ARTWORK_FILE_ID" -H "Authorization: Bearer $CLIENT_TOKEN" | jq
```

## GET /files/:fileId/download-url — authorized read-back

Auth: same as metadata get. The file must be `ready`; MinIO must contain an object with the recorded byte size.

Success:

```json
{
  "fileId": "file_8c9f61e4b2aa",
  "url": "http://192.168.1.10:9000/gridgo-uploads/artwork/2026/08/09/file_8c9f61e4b2aa.pdf?X-Amz-Algorithm=...",
  "expiresAt": "2026-08-09T10:25:00.000Z",
  "expiresInSeconds": 300
}
```

The URL is an opaque, short-lived capability. Do not persist it, log it, rewrite it, or treat it as file identity. Request a new one when it expires.

```bash
DOWNLOAD_URL=$(curl -fsS "$API/files/$ARTWORK_FILE_ID/download-url" \
  -H "Authorization: Bearer $CLIENT_TOKEN" | jq -r .url)
curl -f "$DOWNLOAD_URL" --output ./artwork-readback.pdf
cmp ./artwork.pdf ./artwork-readback.pdf
```

## GET /files/:fileId/content — private payment image bytes

Auth: exactly the same `authorizeFileRead` gate as `download-url`, including current role selection and approval. Supported purposes are `payment_proof`, `payout_receipt`, and `refund_receipt` only (each at most 15 MiB). Operations and Super Admin may read these; other readers retain the existing purpose-specific rules: payment proof owner, approved assigned supplier for a payout receipt, and the refund's owning client for a bound refund receipt. No new reader is granted access.

Success: `200` with streamed MinIO bytes, `Content-Type` from the detected upload type, `Content-Length` from validated metadata, `Cache-Control: private, no-store, max-age=0`, and `X-Content-Type-Options: nosniff`. The object must exist and match the recorded size, as for `download-url`. Authorization failures and storage failures use the existing JSON error contract. A readable file of another purpose returns `400 file_content_not_supported`; non-ready or unknown files return `404 file_not_found`.

Dashboard integration: fetch this API path with `Authorization: Bearer <Clerk session JWT>` and the same `X-GRIDGO-Role` header used for other file reads, read the response as a blob, and pass a local object URL/data URL to the receipt reader. Revoke object URLs when finished. Do not use this authenticated path directly as an `<img src>` without fetching the bytes first. This avoids a browser request to the LAN storage origin; the API uses its internal MinIO connection. Large artwork and all other file purposes continue using `download-url`.

## DELETE /files/:fileId — file deletion

Auth: **Super Admin only**, or the owning client deleting their own `artwork` / `mockup` after every related order is `completed` or `payout_released`. Client artwork still used by a draft cart cannot be deleted. Clients cannot delete unattached uploads through this endpoint; unused uploads follow scheduled cleanup. Operations, suppliers and riders cannot delete files early, including their own verification evidence.

Super Admin sends a JSON body `{ "reason": "Written reason for deletion" }`. A nonblank reason of at most 2,000 characters is required (`400 reason_required` / `reason_too_long`). Client deletion needs no body. Both actions append a durable `file.early_delete` audit entry with actor, file ID, purpose, timestamp, and the Super Admin's trimmed reason. Authorization follows the selected database membership, never token role claims.

**No role may bypass an open issue, claim, refund, dispute or pickup escalation.** The response is `409 file_retention_hold`; unresolved order/case references fail closed. This protection is rechecked under the domain mutation lock immediately before deleting storage bytes, including retries. For verification evidence, open cases on the owner's related orders also hold deletion.

The API commits `delete_pending` and its audit entry before deleting MinIO, then commits `deleted`. If storage fails, the durable pending intent remains for boot/daily retry. The domain lock covers the final check and MinIO delete so a case cannot open between them. References and domain snapshots remain for historical integrity; tombstones have no object key. When rider evidence is deleted, backing `rider_documents` become non-current and a pending application lacking a ready licence reverts to unsubmitted intake.

Success: `200 { "file": File }` with `state: "deleted"` and `deletedAt`. A case opened after the initial intent can defer deletion: the response retains `state: "delete_pending"` and retries wait until the hold clears. Existing signed URLs may remain usable until bytes are deleted.

```bash
curl -fsS -X DELETE "$API/files/$FILE_ID" -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data '{"reason":"Duplicate upload confirmed during review"}'
```

## Retention and daily cleanup

The policy decided on 4 October 2026 is implemented in `src/file-retention-policy.js`. All deadlines use UTC instants. A year means a calendar year (29 February rolls to 1 March in a non-leap year).

| File type | Retention |
| --- | --- |
| Client artwork and design files (`artwork`, `mockup`) | 30 days after order completion. Cancelled orders do not qualify as completed. |
| Money proof (`payment_proof`, `payout_receipt`, `refund_receipt`) | 5 years after the order closes (completed, payout released, or cancelled). |
| Refund QR revisions and supporting refund evidence (`refund_qr`, `refund_evidence`) | 5 years after order closure, as part of the financial evidence. |
| Production and delivery photos, legacy fulfilment proofs, handoff signatures | 1 year after order closure. |
| Shop, rider, business/organization ID and verification evidence | While the account is active, then 1 year after removal/closure or rejection of the corresponding application. Suspension is not closure. Replaced verification evidence follows this same rule. |
| Unused uploads and unlinked listing/shop images or receiving QRs | Eligible after a 24-hour upload grace period; each daily pass removes those no longer used. Active cart artwork, current media/settings references, and historical order evidence are not orphans. |

Files referenced by multiple orders use the latest applicable closure and require every order to qualify. Closure comes from the explicit completion/closure timestamp or the first terminal timeline event, never the mutable `updatedAt`. Missing closure evidence, unresolved references, and unknown attached purposes are retained for review. Open issues, claims, refunds, disputes and pickup escalations block **all** deletion, including Super Admin requests and recovery of pending deletions. Financial metadata, audit records, order snapshots and external artwork links are not deleted by this job; only GRIDGO-managed file bytes are removed and file rows tombstoned.

The API runs a pass after storage initialization and every 24 hours thereafter. **Automatic deletion is OFF unless `GRIDGO_FILE_RETENTION_DELETE_ENABLED=true` is explicitly configured.** Missing, false or any other value keeps the pass read-only. This flag does not disable explicitly authorized early deletion. Failed deletions keep their durable intent and retry on later passes. Legacy pending deletions without an audited source must qualify under the retention policy and the automatic-deletion flag before the worker adopts them with a new audit intent. Pending uploads are subject to the upload grace period and the automatic-deletion flag; a restart alone never discards an in-flight upload.

### GET /admin/files/retention — dry-run counts

Auth: Super Admin. Always read-only, regardless of the deletion flag; it performs no MinIO operation and changes no file rows. Returns `{at,dryRun:true,deletionEnabled,total,byPurpose,deleted:0,failed:0}`. `byPurpose` maps each eligible purpose to its count (absent purposes have zero candidates). Counts include eligible pending retries and exclude protected files. No filenames, private keys or URLs are returned.

The operator CLI uses the same policy and defaults to dry run:

```bash
npm run files:retention -- --dry-run
# Only after reviewing counts and approving the first production cleanup:
GRIDGO_FILE_RETENTION_DELETE_ENABLED=true npm run files:retention -- --execute
```

Even `--execute` only reports counts while the flag is off. Real passes also report `deleted` and `failed`; a CLI pass with failures exits nonzero. Keep the flag off for the first production rollout. Firstmate must run the production dry run, report counts by file type, and stop for approval before enabling deletion. This implementation does not execute production cleanup.

Privacy-notice wording for the landing/client follow-up: “We retain artwork for 30 days after completion, money evidence for five years after order closure, production/delivery evidence for one year, and verification documents while an account is active plus one year after closure or application rejection; open cases pause deletion.”

## File lifecycle and crash recovery

```text
pending_upload --PutObject + metadata commit--> ready
ready --authorized delete request--> delete_pending
pending_upload --compensation/reconciliation--> deleted
delete_pending --MinIO delete + metadata commit--> deleted
```

- `pending_upload` is written before MinIO receives bytes.
- `ready` is the only attachable, readable state.
- If final metadata persistence fails after `PutObject`, the API attempts compensating object deletion. The durable pending row remains a reconciliation marker if cleanup cannot finish.
- On boot and daily retry, authorized `delete_pending` intents are rechecked against open cases before storage deletion; automatic intents additionally require the deletion flag.
- Age-based retention follows the policy above, with automatic deletion disabled by default.

## Proof of Fulfilment lifecycle

Which stages take a Proof of Fulfilment comes from the order's `payoutPlanVersion` (`docs/OPERATIONAL_MODEL_V2_API.md#supplier-payout-milestones`). Upload the bytes, attach the ready file to one milestone, then Operations/Super Admin may release that milestone through the operational-model endpoint. Nothing releases on attach.

| Milestone (plan) | Uploader | Attach result |
|---|---|---|
| `production_started` (2) | assigned supplier | start-of-production milestone becomes `pof_attached` |
| `delivered` (2) | assigned rider | delivered milestone becomes `pof_attached`; `POST /dispatch/:id/delivery` evidence does the same without a separate upload |
| `printing` (1) | assigned supplier | printing milestone becomes `pof_attached` |
| `packaging_qc` (1) | assigned supplier | packaging/QC milestone becomes `pof_attached` |
| `delivered` (1) | assigned rider | delivered and retention milestones become `pof_attached` |

The retired states `supplier_proof_review`, `supplier_proof_changes_requested`, and `supplier_proof_approved` are never accepted as transitions or valid PostgreSQL order states. Legacy POF compatibility uses `fulfilment_proof` file references only.

## Error contract

| HTTP | `error` | When / client fix |
|---:|---|---|
| 400 | `invalid_file_purpose` | Purpose is absent/unknown; send one documented enum. |
| 400 | `file_content_not_supported` | Byte route requested for another readable purpose; use `download-url`. |
| 400 | `invalid_multipart` | Multipart framing is malformed/incomplete; recreate `FormData` and retry. |
| 400 | `unexpected_form_field` | Upload includes a text field other than `purpose`; remove it. |
| 400 | `file_required` | Missing or multiple/wrong-named file part; send exactly one `file`. |
| 400 | `file_empty` | Zero bytes; choose a nonempty file. |
| 400 | `filename_required` | Picker supplied no name; provide a name with a supported extension. |
| 400 | `attachment_target_required` | Attach body lacks `orderId`, `milestoneCode`, or `supplierServiceId`; send the purpose-specific fields. |
| 400 | `unexpected_target_field` | Attach JSON includes a field other than the purpose-specific target; remove it. |
| 400 | `invalid_milestone_code` | POF target is not a file-taking stage of the order's plan (`details.allowed` lists them); choose the stage represented by the file. |
| 400 | `invalid_verification_document_type` | `documentType` is missing/unknown; choose `business_permit`, `valid_id`, or `sample_work`. |
| 400 | `invalid_rider_document_type` | `riderDocumentType` is missing/unknown; choose `drivers_license`, `or_cr`, or `selfie`. |
| 400 | `invalid_application` | A driver's-licence expiry is missing, malformed, or not a real calendar date; send `expiresOn` as `YYYY-MM-DD`. |
| 400 | `invalid_json` | Attach/transition JSON is malformed; fix JSON. |
| 401 | `unauthorized` | Token absent, invalid, or expired; sign in and retry. |
| 403 | `forbidden` | Wrong role, file owner, parent owner/assignee, or read relationship; open the caller's own record. |
| 404 | `file_not_found` | No readable ready file for that ID; refresh parent metadata. |
| 404 | `order_not_found` | Target order does not exist; refresh orders. |
| 404 | `service_not_found` | Target supplier service does not exist; refresh services. |
| 409 | `file_not_ready` | File is not `ready`; only use the ID returned by successful upload. |
| 409 | `file_already_attached` | File already has a parent reference; upload a new file for another record. |
| 409 | `file_state_conflict` | Requested lifecycle operation is invalid for current state; refresh metadata. |
| 409 | `file_metadata_invalid` | Purpose/media/key/size metadata is internally inconsistent; upload again. |
| 409 | `file_in_use` | Client artwork is not exclusively tied to completed orders, or remains in an active cart. |
| 409 | `file_retention_hold` | An open case or unresolved reference prevents deletion, including for Super Admin. |
| 409 | `delivery_photo_upload_not_allowed` | Delivery is not in an allowed active/post-delivery state; refresh order state. |
| 409 | `verification_document_replacement_mismatch` | `replaceFileId` is not attached to the caller in the requested document slot; refresh the supplier's documents and choose the matching file. |
| 409 | `document_expired` | The driver's-licence expiry is not in the future in Asia/Manila; upload current evidence. |
| 409 | `transition_not_allowed` | Requested order step is not reachable from the current state/role; refresh and use an available action. |
| 409 | `storage_object_missing` | Ready metadata has no MinIO object; upload and attach a replacement. |
| 409 | `storage_object_mismatch` | MinIO byte size differs from metadata; upload and attach a replacement. |
| 413 | `file_too_large` | Purpose limit exceeded; choose a smaller file. Response includes `purpose`, `maxBytes`, `maxMiB` when known. |
| 413 | `request_body_too_large` | Non-file JSON exceeds 1 MiB; remove extra data. |
| 415 | `multipart_required` | Upload is not multipart; send `FormData`. |
| 415 | `invalid_file_type` | Unsupported, mismatched, or purpose-ineligible format. Response includes a plain `message`, `purpose`, `allowedContentTypes`, and `reason`: `content_type_not_allowed`, `file_type_mismatch`, `purpose_media_type_not_allowed`, or `heic_not_supported`. Export to an accepted format. |
| 503 | `minio_unavailable` | MinIO is unreachable; run `docker compose up -d --wait` and retry. Non-file endpoints remain available. |
| 503 | `storage_initializing` | Boot-time MinIO recovery is still running; wait briefly and retry the file action. |

Upload validation runs before storage access, including during storage recovery. Dashboards should show the response `message` for `invalid_file_type`, and the `maxMiB`/`maxBytes` limit for `file_too_large`; reserve a storage-unavailable message for `503 minio_unavailable` or `storage_initializing`. Type errors formerly returned the individual reason as the top-level `error`; that detail now lives in `reason`.

No file route returns raw SDK exceptions, stack traces, credentials, or standalone bucket/key metadata. The one deliberate exception is the authorized presigned URL, whose signed path necessarily contains the bucket and key and must remain opaque.

## Legacy-audit trap checklist

| Trap | Resolution in this contract |
|---|---|
| Blobs/base64 in PostgreSQL | Prohibited; only metadata, private object keys, and opaque file references enter the database. |
| Public bucket | Prohibited; reads require an API-authorized five-minute signed GET. The signed path exposes bucket/key text only as part of that opaque capability. |
| Client-supplied keys | Prohibited for upload, attach, read, presign, and delete; keys are generated server-side. |
| Persist signed/raw URLs as identity | Prohibited; persist only `fileId`. URLs are ephemeral response data. |
| Rewrite host after signing | Prohibited; signer uses fixed `MINIO_PUBLIC_URL`. |
| Trust extension or declared MIME alone | Prohibited; extension, optional specific declared MIME, and magic bytes must agree. |
| Turn 200 MiB into multiple buffers | Avoided; multipart is streamed to disk, with only parser tail/signature bytes retained, then disk is streamed to MinIO. |
| Assume object put + database commit are atomic | Avoided; pending record first, ready commit second, compensating delete, and boot reconciliation. |
| Delete referenced evidence on uploader request | Only Super Admin with a reason, or a client’s own artwork after completion; open cases always block. |
| API uses root credentials | Prohibited; Compose provisions a separate bucket-policy API user. Root credentials are init/console only. |
| Floating MinIO image | Prohibited; compose and CI smoke pin GRIDGO's own `ghcr.io/gridgoph/minio` and `ghcr.io/gridgoph/mc` by release tag **and** digest. See [MinIO images](#minio-images). |

## MinIO images

Upstream withdrew the MinIO images GRIDGO used to pin: `quay.io/minio/minio` and `quay.io/minio/mc` release tags return "no such manifest", and Docker Hub `minio/minio` / `minio/mc` deny anonymous pulls. GRIDGO therefore builds the same releases itself from the official AGPL-3.0 source and publishes them as private GHCR packages linked to this repository (same access as `ghcr.io/gridgoph/gridgo-api`):

| Image | Upstream source | Pinned reference |
| --- | --- | --- |
| MinIO server | `github.com/minio/minio` tag `RELEASE.2025-07-23T15-54-02Z`, commit `7ced9663e6a791fef9dc6be798ff24cda9c730ac` | `ghcr.io/gridgoph/minio:RELEASE.2025-07-23T15-54-02Z@sha256:ec083fa6b02af8f3f971def273b3ab2f1a102ca0aa74e6b45c0bcb462f0f5cfe` |
| mc | `github.com/minio/mc` tag `RELEASE.2025-07-21T05-28-08Z`, commit `ee72571936f15b0e65dc8b4a231a4dd445e5ccb6` | `ghcr.io/gridgoph/mc:RELEASE.2025-07-21T05-28-08Z@sha256:e114957171327027e2440679742baff3dfb4acccf883471061b070926dad7342` |

- Build definitions are `docker/minio-images/{minio,mc}.Dockerfile`; `.github/workflows/minio-images.yml` builds, version-checks, and publishes them (linux/amd64 and linux/arm64). Each build clones the tag, refuses to continue unless it resolves to the pinned commit, uses the go.mod `toolchain` with `GOTOOLCHAIN=local` and `CGO_ENABLED=0`, and stamps upstream's own release ldflags, so `minio --version` / `mc --version` report the exact release and commit. OCI labels carry the upstream source URL, commit, release, and license.
- The server image keeps the upstream entrypoint, `curl` (compose healthchecks use it), `/data`, and root as its user, because existing `gridgo_minio_data` volumes were written by the root-run upstream image. The `mc` image keeps `/bin/sh` for the compose/CI init scripts and runs as uid 10001.
- A published tag is never re-pushed; the workflow only re-verifies an existing tag and reports its digest. Moving to a new MinIO release means new Dockerfile pins, a new tag, and updating every digest reference (both compose files, the deploy smoke job, and this table) together.

## PostgreSQL reconciliation

Versioned migrations create file metadata and reference tables; there is no JSON import or load-time structural migration. Boot retries durable deletion intents using the same hold checks as daily cleanup. Pending uploads use the 24-hour grace and automatic-deletion flag.

## Private refund files

The [refund contract](REFUNDS_API.md#files-privacy-and-retention) owns QR/evidence/receipt binding and retention rules. Refund purposes bind through refund routes, never `/files/:id/attach`. `refund_qr` is owned and supplied by the client; `refund_receipt` is uploaded by the operator and becomes readable by that refund's client after binding. Neither is readable by shops, riders, other clients, public media, or the support desk. Bound old QR revisions remain pinned evidence. Financial image object metadata, signed-response overrides and API metadata/signing responses use `private, no-store, max-age=0`; infrastructure must preserve this through the proxy.

The separately authorized shop settlement payout uses existing `payout_receipt` privacy (owning supplier plus ops/super), with mandatory reference and receipt on `/refund-requests/:id/supplier-payout`. All wallet screenshots are **transfer evidence**, not official receipts.

## Production photo visibility

Progress images use the same private read gate as artwork. The client gallery and packing refusal contract are [Production progress photos](OPERATIONAL_MODEL_V2_API.md#production-progress-photos). A start-of-production image counts, including legacy shop image proofs; PDFs do not. Client/rider file metadata strips internal reference fields and calls legacy fulfilment evidence `order_photo`. Attached evidence follows the retention and audited early-deletion policy above.

### Client application documents

`client_verification_document` uploads are client-owned JPEG/PNG/WebP/PDF files up to 20 MiB. Complete application submission attaches them through the existing file-reference mechanism. Only Operations and Super Admin can read metadata or signed bytes, including after submission; the owner receives the opaque file ID at upload. Track checklists, rejected-revision retention and handover rules are in [Organization accounts](ORGANIZATION_ACCOUNTS_API.md). Automatic deletion remains disabled by default.

### Pick-up chat photos

`pickup_chat_image` accepts supplier/rider JPEG, PNG and WebP images up to 15 MiB, using the usual upload verification. Up to four own ready unsent photos bind through `POST /orders/:id/pickup-chat/messages`. Generic attach is refused with `pickup_chat_image_not_attachable`. Sent metadata/downloads are private to the approved assigned supplier and rider while the conversation is readable, including Office transfers; reassignment revokes access. The chat sweep queues byte deletion when the conversation closes; retained opaque order references preserve open-case holds on every retry. See [pick-up messages](OPERATIONAL_MODEL_V2_API.md#pick-up-messages).
