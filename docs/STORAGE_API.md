# GRIDGO Storage API contract

This is the authoritative contract for all three mobile apps. It covers client artwork, milestone Proofs of Fulfilment (POFs), rider delivery/checklist photos, and supplier-service images. Field names, states, status codes, and error codes are stable and case-sensitive.

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

## Base conventions

- API example base: `http://127.0.0.1:18787`
- Auth header on every route below: `Authorization: Bearer <token>`
- Errors: JSON `{ "error": "snake_case", "message": "concrete problem and recovery" }`, with only the documented additive detail fields
- Upload field names: exactly one binary `file` and one text `purpose`
- The client must not supply a bucket, object key, URL, owner ID, lifecycle state, size, or detected MIME
- IDs are opaque. Clients may persist `fileId`, never an object key or presigned URL.

Login helpers used below:

```bash
API=http://127.0.0.1:18787
CLIENT_TOKEN=$(curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  --data '{"email":"client@gridgo.local","password":"demo"}' | jq -r .token)
SUPPLIER_TOKEN=$(curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  --data '{"email":"supplier@gridgo.local","password":"demo"}' | jq -r .token)
RIDER_TOKEN=$(curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  --data '{"email":"rider@gridgo.local","password":"demo"}' | jq -r .token)
OPS_TOKEN=$(curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  --data '{"email":"ops@gridgo.local","password":"demo"}' | jq -r .token)
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

The durable internal record additionally has a server-generated `objectKey`. It is never returned as a standalone metadata field. The authorized presigned URL necessarily encodes the bucket and key in its signed path; clients must treat the complete URL as an opaque, expiring capability and never parse those internals. `purpose` is the retention and authorization tag; it is not inferred from a target.

Parents contain IDs only:

| Purpose | Parent reference field |
|---|---|
| `artwork` | `order.artworkFileIds: string[]` |
| `fulfilment_proof` | `order.fulfilmentProofFileIds: string[]` and the selected `payoutMilestone.pofFileIds` |
| `delivery_photo` | `order.deliveryPhotoFileIds: string[]` |
| `service_image` | `supplierService.imageFileIds: string[]` |

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

Accepted detected types are `image/jpeg`, `image/png`, `image/webp`, and where shown `application/pdf`. HEIC/HEIF is deliberately rejected with `415 heic_not_supported`; the app must request JPEG camera output or convert before upload.

The upload request timeout defaults to 15 minutes. Clients may show transfer progress, but progress reaching 100% is **not success**. Only a `201` response containing `file.fileId` means MinIO storage and `ready` metadata both completed. Retry after any lost connection or non-201 response; never invent or reuse a guessed ID.

## POST /files — streamed upload

Auth: `client` for `artwork`; `supplier` for `service_image`; assigned suppliers and riders for `fulfilment_proof`; rider for `delivery_photo`.

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
```

## POST /files/:fileId/attach — bind to a domain record

Auth: the caller must be the file owner **and** the relevant parent owner/assignee. The body is JSON and contains exactly the fields selected by the stored purpose:

| Purpose | Body | Required state/ownership |
|---|---|---|
| `artwork` | `{ "orderId": "..." }` | caller is `order.clientId`; any current order state |
| `fulfilment_proof` | `{ "orderId": "...", "milestoneCode": "printing" }` | assigned supplier for `printing`/`packaging_qc`; assigned rider for `delivered`; direct `retention` uploads are invalid |
| `delivery_photo` | `{ "orderId": "..." }` | caller is assigned `order.riderId`; state `rider_assigned`, `picked_up`, `out_for_delivery`, `delivered`, or `issue_window_open` |
| `service_image` | `{ "supplierServiceId": "..." }` | caller is `supplierService.supplierId` |

Immediately before commit the API revalidates: `state === "ready"`, caller equals `ownerId`, the file has no existing reference, purpose matches the target family, detected MIME is still allowed for that purpose, object key is nonempty, size is positive, domain ownership/state still permits attach, and MinIO `stat` finds the object with the recorded size. A `fileId` attaches once. A file cannot be rebound even if another user knows its ID.

Success: `200 { "file": File, "order": Order }` for order purposes, or `200 { "file": File, "supplierService": SupplierService }`. The returned parent already contains the ID. A POF attach changes the selected milestone from `pending_pof` to `pof_attached`; a delivered POF is also linked to `retention` because both gates use the same delivery evidence.

Curl for all four targets:

```bash
curl -fsS -X POST "$API/files/$ARTWORK_FILE_ID/attach" -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_demo_1"}' | jq

curl -fsS -X POST "$API/files/$POF_FILE_ID/attach" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_production","milestoneCode":"printing"}' | jq

curl -fsS -X POST "$API/files/$DELIVERY_FILE_ID/attach" -H "Authorization: Bearer $RIDER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"orderId":"ord_active_delivery"}' | jq

curl -fsS -X POST "$API/files/$SERVICE_FILE_ID/attach" -H "Authorization: Bearer $SUPPLIER_TOKEN" \
  -H 'Content-Type: application/json' --data '{"supplierServiceId":"svc_demo_print"}' | jq
```

## GET /files/:fileId — metadata

Auth: file owner, `ops_admin`, `super_admin`, or a user related to any current reference: the referenced order's client/assigned supplier/assigned rider, the referenced service's owner supplier, or any authenticated user when the referenced service is `live`. Unattached files are visible only to owner and ops/super.

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

## DELETE /files/:fileId — unreferenced file deletion

Auth: owner, `ops_admin`, or `super_admin`. Only a `ready` file with `references: []` may be deleted. Attached artwork, proofs, service images, and delivery evidence return `409 file_in_use`; deletion never silently removes evidence.

The API first persists `delete_pending`, then deletes MinIO, then persists `deleted`. If MinIO is unavailable, the durable `delete_pending` marker remains and startup reconciliation retries it.

Success: `200 { "file": File }` where `state` is `deleted`, `deletedAt` is set, and `objectKey` remains absent.

```bash
curl -fsS -X DELETE "$API/files/$UNATTACHED_FILE_ID" \
  -H "Authorization: Bearer $CLIENT_TOKEN" | jq
```

## File lifecycle and crash recovery

```text
pending_upload --PutObject + metadata commit--> ready
ready --authorized unreferenced delete request--> delete_pending
pending_upload --compensation/reconciliation--> deleted
delete_pending --MinIO delete + metadata commit--> deleted
```

- `pending_upload` is written before MinIO receives bytes.
- `ready` is the only attachable, readable state.
- If final metadata persistence fails after `PutObject`, the API attempts compensating object deletion. The durable pending row remains a reconciliation marker if cleanup cannot finish.
- On every successful-storage API boot, reconciliation deletes objects belonging to interrupted `pending_upload` or `delete_pending` records and tombstones them as `deleted`.
- No automatic age-based retention is enabled in this demo. `purpose` and references are durable so a future retention job can apply different policies without guessing from keys.

## Proof of Fulfilment lifecycle

POF is a milestone gate, not an order-state approval loop. Upload the bytes, attach the ready file to one milestone, then Operations/Super Admin may release that milestone through the operational-model endpoint.

| Milestone | Uploader | Attach result |
|---|---|---|
| `printing` | assigned supplier | printing milestone becomes `pof_attached` |
| `packaging_qc` | assigned supplier | packaging/QC milestone becomes `pof_attached` |
| `delivered` | assigned rider | delivered and retention milestones become `pof_attached` |

The retired states `supplier_proof_review`, `supplier_proof_changes_requested`, and `supplier_proof_approved` are never accepted as transitions. Load-time migration moves existing orders in those states to `awaiting_downpayment` and preserves their legacy `proofFileIds`.

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
| 409 | `file_in_use` | File has domain references; do not delete lifecycle evidence. |
| 409 | `delivery_photo_upload_not_allowed` | Delivery is not in an allowed active/post-delivery state; refresh order state. |
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
| Blobs/base64 in JSON | Prohibited; only metadata and file IDs enter `store.json`. |
| Public bucket | Prohibited; reads require an API-authorized five-minute signed GET. The signed path exposes bucket/key text only as part of that opaque capability. |
| Client-supplied keys | Prohibited for upload, attach, read, presign, and delete; keys are generated server-side. |
| Persist signed/raw URLs as identity | Prohibited; persist only `fileId`. URLs are ephemeral response data. |
| Rewrite host after signing | Prohibited; signer uses fixed `MINIO_PUBLIC_URL`. |
| Trust extension or declared MIME alone | Prohibited; extension, optional specific declared MIME, and magic bytes must agree. |
| Turn 200 MiB into multiple buffers | Avoided; multipart is streamed to disk, with only parser tail/signature bytes retained, then disk is streamed to MinIO. |
| Assume object put + JSON save are atomic | Avoided; pending record first, ready commit second, compensating delete, and boot reconciliation. |
| Delete referenced evidence on uploader request | Prohibited; `409 file_in_use`. |
| API uses root credentials | Prohibited; Compose provisions a separate bucket-policy API user. Root credentials are init/console only. |
| Floating MinIO image | Prohibited; both `minio/minio` and `minio/mc` use pinned release tags. |

## Existing-store migration

`load()` additively creates top-level `files: []`, order `artworkFileIds`, legacy `proofFileIds`, `fulfilmentProofFileIds`, and `deliveryPhotoFileIds`, and supplier-service `imageFileIds` only when missing. It never fabricates an object from `artworkName`, overwrites valid file metadata, removes orders, or changes unrelated collections. Running it twice produces no second change. Never reset a live/demo store to obtain these fields.
