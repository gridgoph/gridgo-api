# GRIDGO Storage API contract

This is the authoritative contract for all three mobile apps. It covers client artwork, milestone Proofs of Fulfilment (POFs), rider delivery/checklist photos, supplier-service images, and private supplier verification documents. Field names, states, status codes, and error codes are stable and case-sensitive.

## Architecture decision

GRIDGO uses the API as the **control plane** and MinIO as the **download data plane**:

1. `POST /files` streams multipart bytes through the API. The API counts bytes, captures only signature bytes in memory, writes the upload to a temporary file, validates magic bytes, and then streams that file to MinIO. It never buffers the complete upload in RAM.
2. The API creates a durable `pending_upload` file record **before** `PutObject`. A successful response is sent only after MinIO confirms the put and the record is durably changed to `ready`.
3. `POST /files/:fileId/attach` separately binds a ready file to a domain record. It rechecks lifecycle state, uploader, purpose, detected media type, target ownership/state, metadata integrity, and MinIO object existence and byte size.
4. `GET /files/:fileId/download-url` authorizes the caller from current domain relationships, checks the object, and returns a short-lived presigned GET. MinIO serves the bytes.

This deliberately replaces the earlier API-proxied-download proposal. Presigned GETs avoid routing 50–200 MiB artwork back through the single Node process. Uploads remain proxied because only the API can enforce byte limits and signature inspection before declaring a file ready.

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
| `fulfilment_proof` | `order.fulfilmentProofFileIds: string[]` and the selected `payoutMilestone.pofFileIds` |
| `delivery_photo` | `order.deliveryPhotoFileIds: string[]` |
| `service_image` | `supplierService.imageFileIds: string[]` |
| `verification_document` | `supplier.verificationDocumentFileIds: string[]` (private; never part of `PublicUser`) |

Legacy orders may still return `proofFileIds` containing retired supplier-proof files. They remain readable evidence but the `proof` upload purpose and supplier-proof workflow no longer accept writes.

`order.artworkName` remains as a backward-compatibility display string and is populated from `originalFilename` when artwork is attached. It is never file identity, never accepted as a key, and never proves an object exists. No artwork and empty file-ID arrays are valid.

## Purpose policies

Validation uses the filename extension, the declared part MIME when it is specific, and file magic bytes. Magic bytes are authoritative; renaming a file is not enough. Empty or `application/octet-stream` declared MIME is accepted for iOS only when extension and magic agree. A conflicting specific MIME is rejected.

| Purpose | Upload role | Allowed detected types | Maximum |
|---|---|---|---|
| `artwork` | client | JPEG, PNG, WebP, PDF | 200 MiB (`209715200`) |
| `fulfilment_proof` | assigned supplier or rider | JPEG, PNG, WebP, PDF | 200 MiB (`209715200`) |
| `delivery_photo` | rider | JPEG, PNG, WebP | 20 MiB (`20971520`) |
| `service_image` | supplier | JPEG, PNG, WebP | 20 MiB (`20971520`) |
| `verification_document` | supplier, including pending | JPEG, PNG, WebP, PDF | 20 MiB (`20971520`) |
| `rider_verification_document` | rider, including pending | JPEG, PNG, WebP, PDF | 20 MiB (`20971520`) |

Accepted detected types are `image/jpeg`, `image/png`, `image/webp`, and where shown `application/pdf`. HEIC/HEIF is deliberately rejected with `415 heic_not_supported`; the app must request JPEG camera output or convert before upload.

The upload request timeout defaults to 15 minutes. Clients may show transfer progress, but progress reaching 100% is **not success**. Only a `201` response containing `file.fileId` means MinIO storage and `ready` metadata both completed. Retry after any lost connection or non-201 response; never invent or reuse a guessed ID.

## POST /files — streamed upload

Auth: `client` for `artwork`; `supplier` for `service_image` and `verification_document`; assigned suppliers and riders for `fulfilment_proof`; rider for `delivery_photo` and `rider_verification_document`. Pending applicants may upload their own role-specific evidence; no other identity may upload it on their behalf.

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
  -F 'purpose=fulfilment_proof' -F 'file=@./printing-pof.png;type=image/png' | tee /tmp/pof-upload.json | jq -r .file.fileId)

DELIVERY_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $RIDER_TOKEN" \
  -F 'purpose=delivery_photo' -F 'file=@./handoff.jpg;type=image/jpeg' | tee /tmp/delivery-upload.json | jq -r .file.fileId)

SERVICE_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -F 'purpose=service_image' -F 'file=@./press.webp;type=image/webp' | tee /tmp/service-upload.json | jq -r .file.fileId)

VERIFICATION_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -F 'purpose=verification_document' -F 'file=@./business-permit.pdf;type=application/pdf' | tee /tmp/verification-upload.json | jq -r .file.fileId)

RIDER_LICENSE_FILE_ID=$(curl -fsS -X POST "$API/files" -H "Authorization: Bearer $RIDER_TOKEN" \
  -F 'purpose=rider_verification_document' -F 'file=@./drivers-license.jpg;type=image/jpeg' | tee /tmp/rider-license-upload.json | jq -r .file.fileId)
```

## POST /files/:fileId/attach — bind to a domain record

Auth: the caller must be the file owner **and** the relevant parent owner/assignee. The body is JSON and contains exactly the fields selected by the stored purpose:

| Purpose | Body | Required state/ownership |
|---|---|---|
| `artwork` | `{ "orderId": "..." }` | caller is `order.clientId`; any current order state |
| `fulfilment_proof` | `{ "orderId": "...", "milestoneCode": "printing" }` | legacy commitments only: assigned supplier for `printing`/`packaging_qc`; assigned rider for `delivered`; direct `retention` uploads are invalid |
| `delivery_photo` | `{ "orderId": "..." }` | caller is assigned `order.riderId`; state `rider_assigned`, `picked_up`, `out_for_delivery`, `delivered`, or `issue_window_open` |
| `service_image` | `{ "supplierServiceId": "..." }` | caller is `supplierService.supplierId` |
| `verification_document` | `{ "documentType": "business_permit" }` or `{ "documentType": "sample_work", "replaceFileId": "..." }` | caller is a supplier; target is always derived from the token and cannot be supplied |
| `rider_verification_document` | `{ "riderDocumentType": "drivers_license", "expiresOn": "2028-06-30" }` | caller is the rider owner; licence requires a future expiry, while `or_cr` and `selfie` omit it |

Immediately before commit the API revalidates: `state === "ready"`, caller equals `ownerId`, the file has no existing reference, purpose matches the target family, detected MIME is still allowed for that purpose, object key is nonempty, size is positive, domain ownership/state still permits attach, and MinIO `stat` finds the object with the recorded size. A `fileId` attaches once. A file cannot be rebound even if another user knows its ID.

Success: `200 { "file": File, "order": Order }` for order purposes, `200 { "file": File, "supplierService": SupplierService }` for a service image, or `200 { "file": File, "user": PublicUser, "verificationDocuments": File[] }` for a verification document. The returned parent projection already includes the attachment. On a legacy commitment, a POF attach changes the selected milestone from `pending_pof` to `pof_attached`; a delivered POF is also linked to `retention`.

A rider-document attach returns `{file,riderDocument,approvalCase}`. Attaching `drivers_license` replaces the prior current licence without deleting it but remains evidence-only; the explicit rider submit endpoint rechecks readiness and sets `submittedAt`. Optional `or_cr` and `selfie` replace only their own current slots.

Verification-document attachment rules:

- `documentType` is required and must be exactly `business_permit`, `valid_id`, or `sample_work`.
- The API derives the supplier account from the bearer token. `userId`, `supplierId`, and all other target fields are rejected with `400 unexpected_target_field`; a supplier cannot target another account.
- Attaching `business_permit` or `valid_id` automatically replaces every prior attachment in that singleton slot. Replaced files become unreferenced but remain private and readable to their owner/Operations/Super Admin until the owner deletes them.
- `sample_work` without `replaceFileId` appends another photo/document. To replace one sample, send its currently attached `fileId` as `replaceFileId` with `documentType: "sample_work"`.
- `replaceFileId` may also select the current permit or ID explicitly. It must be attached to the caller in the same type slot or the API returns `409 verification_document_replacement_mismatch`.

Curl for all five targets:

```bash
curl -fsS -X POST "$API/files/$ARTWORK_FILE_ID/attach" -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_demo_1"}' | jq

curl -fsS -X POST "$API/files/$POF_FILE_ID/attach" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_production","milestoneCode":"printing"}' | jq

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

Auth for ordinary purposes: file owner, `ops_admin`, `super_admin`, or a user related to any current reference: the referenced order's client/assigned supplier/assigned rider, the referenced service's owner supplier, or any authenticated user when the referenced service is `live`. Unattached ordinary files are visible only to owner and ops/super.

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

## DELETE /files/:fileId — file deletion

Auth: owner, `ops_admin`, or `super_admin` for ordinary purposes. A `verification_document` may be deleted only by its supplier owner, and a `rider_verification_document` only by its rider owner. For every purpose except `rider_verification_document`, only a `ready` file with `references: []` may be deleted: attached artwork, proofs, service images, delivery evidence, and current verification documents return `409 file_in_use`; deletion never silently removes evidence. Replace a verification slot first, then the supplier may delete the now-unreferenced old file.

`rider_verification_document` is the deliberate exception: the rider owner may delete their own uploaded evidence through this same flow even while rider-document rows still reference it. The same transaction that persists `delete_pending` marks every `rider_documents` row backed by that file non-current; the rows themselves are preserved as prior evidence. If that removes the rider's only current driver's licence backed by a `ready` file, a pending rider case reverts to unsubmitted intake (`submittedAt: null`); a case that already left `pending` is untouched. Every submit, reapply, and approval readiness gate rejects deleted or dangling licence evidence — a current rider-document row whose backing file is absent or not `ready` never satisfies any gate, so the rider must attach a replacement licence before submitting or reapplying.

The API first persists `delete_pending`, then deletes MinIO, then persists `deleted`. If MinIO is unavailable, the durable `delete_pending` marker remains and startup reconciliation retries it.

Success: `200 { "file": File }` where `state` is `deleted`, `deletedAt` is set, and `objectKey` remains absent.

```bash
curl -fsS -X DELETE "$API/files/$UNATTACHED_FILE_ID" \
  -H "Authorization: Bearer $CLIENT_TOKEN" | jq
```

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
- On every successful-storage API boot, reconciliation deletes objects belonging to interrupted `pending_upload` or `delete_pending` records and tombstones them as `deleted`.
- No automatic age-based retention is enabled in this demo. `purpose` and references are durable so a future retention job can apply different policies without guessing from keys.

## Legacy Proof of Fulfilment lifecycle

POF milestone gating applies only to legacy `moneyModelVersion: 1` commitments. Current v2 `initial` and `completion` payouts do not accept POF; they release automatically when their lifecycle and confirmed supplier-principal collection gates are satisfied. For a legacy commitment, upload the bytes, attach the ready file to one milestone, then Operations/Super Admin may release that milestone through the operational-model endpoint.

| Milestone | Uploader | Attach result |
|---|---|---|
| `printing` | assigned supplier | printing milestone becomes `pof_attached` |
| `packaging_qc` | assigned supplier | packaging/QC milestone becomes `pof_attached` |
| `delivered` | assigned rider | delivered and retention milestones become `pof_attached` |

The retired states `supplier_proof_review`, `supplier_proof_changes_requested`, and `supplier_proof_approved` are never accepted as transitions or valid PostgreSQL order states. Legacy POF compatibility uses `fulfilment_proof` file references only.

## Error contract

| HTTP | `error` | When / client fix |
|---:|---|---|
| 400 | `invalid_file_purpose` | Purpose is absent/unknown; send one documented enum. |
| 400 | `invalid_multipart` | Multipart framing is malformed/incomplete; recreate `FormData` and retry. |
| 400 | `unexpected_form_field` | Upload includes a text field other than `purpose`; remove it. |
| 400 | `file_required` | Missing or multiple/wrong-named file part; send exactly one `file`. |
| 400 | `file_empty` | Zero bytes; choose a nonempty file. |
| 400 | `filename_required` | Picker supplied no name; provide a name with a supported extension. |
| 400 | `attachment_target_required` | Attach body lacks `orderId`, `milestoneCode`, or `supplierServiceId`; send the purpose-specific fields. |
| 400 | `unexpected_target_field` | Attach JSON includes a field other than the purpose-specific target; remove it. |
| 400 | `invalid_milestone_code` | POF target is not printing, packaging/QC, or delivered; choose the stage represented by the file. |
| 400 | `invalid_verification_document_type` | `documentType` is missing/unknown; choose `business_permit`, `valid_id`, or `sample_work`. |
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
| 409 | `file_in_use` | File has domain references and is not rider-owned `rider_verification_document` evidence; do not delete lifecycle evidence. |
| 409 | `delivery_photo_upload_not_allowed` | Delivery is not in an allowed active/post-delivery state; refresh order state. |
| 409 | `verification_document_replacement_mismatch` | `replaceFileId` is not attached to the caller in the requested document slot; refresh the supplier's documents and choose the matching file. |
| 409 | `transition_not_allowed` | Requested order step is not reachable from the current state/role; refresh and use an available action. |
| 409 | `storage_object_missing` | Ready metadata has no MinIO object; upload and attach a replacement. |
| 409 | `storage_object_mismatch` | MinIO byte size differs from metadata; upload and attach a replacement. |
| 413 | `file_too_large` | Purpose limit exceeded; choose a smaller file. Response includes `purpose`, `maxBytes`, `maxMiB` when known. |
| 413 | `request_body_too_large` | Non-file JSON exceeds 1 MiB; remove extra data. |
| 415 | `multipart_required` | Upload is not multipart; send `FormData`. |
| 415 | `content_type_not_allowed` | Specific declared MIME is unsupported; export to an accepted format. |
| 415 | `purpose_media_type_not_allowed` | Valid detected format is not allowed for that purpose (for example PDF delivery photo); use an allowed image. |
| 415 | `file_type_mismatch` | Extension, specific declared MIME, and magic bytes disagree or signature is unknown; export correctly. |
| 415 | `heic_not_supported` | HEIC/HEIF detected; convert/capture as JPEG or PNG. |
| 503 | `minio_unavailable` | MinIO is unreachable; run `docker compose up -d --wait` and retry. Non-file endpoints remain available. |
| 503 | `storage_initializing` | Boot-time MinIO recovery is still running; wait briefly and retry the file action. |

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
| Delete referenced evidence on uploader request | Prohibited for every purpose except `rider_verification_document` (`409 file_in_use`). A rider deleting their own evidence invalidates the backing rider-document rows in the same transaction instead of orphaning them. |
| API uses root credentials | Prohibited; Compose provisions a separate bucket-policy API user. Root credentials are init/console only. |
| Floating MinIO image | Prohibited; both `minio/minio` and `minio/mc` use pinned release tags. |

## PostgreSQL reconciliation

Versioned migrations create file metadata and reference tables; there is no JSON import or load-time structural migration. On every successful-storage API boot, reconciliation deletes objects belonging to interrupted `pending_upload` or `delete_pending` records and tombstones them as `deleted` in a transaction.
