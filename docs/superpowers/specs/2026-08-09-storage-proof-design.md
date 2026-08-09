# Storage and supplier-proof design

## Scope and constraints

GRIDGO will add durable private object storage without changing its replaceable JSON-domain model. MinIO is the development S3 service, accessed only through `@aws-sdk/client-s3`. The API must keep serving non-file routes when MinIO is absent. Existing `data/store.json` is live demo data: migrations only fill missing attachment arrays and never reset, delete, or fabricate objects for legacy `artworkName` values.

The existing server has an Operations QA state named `proof_approval`. Supplier proofs therefore use distinct `supplier_proof_*` states so the two workflows remain unambiguous.

## Considered approaches

1. **One attachment API with private byte reads (selected).** `POST /attachments` accepts the same multipart shape for all four kinds; `GET /attachments/:id` authorizes against the parent record before streaming bytes. This gives all three apps one client implementation and keeps bucket details private.
2. Resource-specific upload routes. These make URLs self-describing but duplicate multipart, validation, response, and future migration behavior four times.
3. Presigned S3 URLs. These scale well in production but expose storage choreography to mobile clients, complicate local MinIO networking, and weaken the requested API-authorized read boundary.

## External contract

`POST /attachments` requires `multipart/form-data` with exactly one binary `file` part and text fields:

- `kind`: `artwork`, `proof`, `delivery_photo`, or `service_image`
- `orderId`: required for the first three kinds
- `supplierServiceId`: required for `service_image`

Accepted part content types are `image/jpeg`, `image/png`, `image/webp`, and `application/pdf`. Maximum file size is 10 MiB (`10485760` bytes). The response is `201 { "attachment": Attachment, "order": Order }` for order kinds and `201 { "attachment": Attachment, "supplierService": SupplierService }` for a service image. Expo Image Picker and Document Picker use form field `file` with `{ uri, name, type }`, which produces this exact multipart shape.

`GET /attachments/:id` returns the original bytes with recorded `Content-Type`, `Content-Length`, and a safe `Content-Disposition: inline; filename="..."`. It never redirects and never returns a bucket URL.

Public attachment metadata is:

```json
{
  "id": "att_...",
  "kind": "artwork",
  "originalFilename": "opening-banner.pdf",
  "contentType": "application/pdf",
  "size": 48231,
  "uploaderId": "user_client",
  "uploadedAt": "2026-08-09T00:00:00.000Z"
}
```

The stored record additionally carries an internal `objectKey`; API serializers must remove it. Orders expose `attachments: Attachment[]`; supplier services expose the same field. On artwork upload, `order.artworkName` becomes the uploaded original filename for legacy clients.

## Authorization

- `artwork`: only the order's client uploads. The order client, assigned supplier, and ops/super may read it.
- `proof`: only the assigned supplier uploads. The order client, assigned supplier, and ops/super may read it.
- `delivery_photo`: only the assigned rider uploads. The order client, assigned supplier, assigned rider, and ops/super may read it.
- `service_image`: only the service's supplier uploads. That supplier and ops/super may read it.

Unknown parents return `404`; known but unauthorized parents return `403`. This prevents record existence from being inferred through attachment lookup: an unauthorized attachment read is always `403` once its parent is found.

## Supplier-proof lifecycle

Uploading a `proof` is the state-changing action, so a state cannot claim that a proof exists without a stored object:

```text
supplier_accepted --supplier proof upload--> supplier_proof_review
supplier_proof_review --client request_changes + reason--> supplier_proof_changes_requested
supplier_proof_changes_requested --supplier proof upload--> supplier_proof_review
supplier_proof_review --client approve--> supplier_proof_approved
supplier_proof_approved --existing transition endpoint--> awaiting_payment
```

Client decisions use the existing `POST /orders/:id/transition` shape with `state` set to `supplier_proof_changes_requested` or `supplier_proof_approved`. `reason` is mandatory for requested changes. Only the order client may make either decision. Each state change appends a timeline entry with actor, time, state, and a concrete note. Proof upload entries also include `attachmentId`.

The pre-existing direct `supplier_accepted -> awaiting_payment` edge remains for compatibility, as required by the repository constraint not to remove state-machine edges.

## Storage availability and errors

The API creates an S3 client and idempotently ensures the configured bucket at boot. Boot-time failure only marks storage unavailable and logs a concise warning; the HTTP server still starts. Every file operation retries bucket availability. `/health` exposes `storage.status` as `checking`, `available`, or `unavailable`.

File-route failures use `{ error, message, ...details }`. Stable codes include `multipart_required`, `invalid_multipart`, `file_required`, `invalid_attachment_kind`, `attachment_target_required`, `content_type_not_allowed`, `file_too_large`, `file_empty`, `proof_upload_not_allowed`, `reason_required`, `forbidden`, `attachment_not_found`, and `minio_unavailable`. Messages name the problem and the recovery action; SDK exceptions are never returned.

## Persistence and rollback behavior

An object is written before its metadata is added to JSON. A failed object write leaves the domain record unchanged. A JSON write failure can leave an unreachable object, which is acceptable for this local demo and can be garbage-collected later. Reads authorize entirely from durable parent metadata before touching MinIO.

`backfillAttachments(store)` only assigns `[]` when an order or supplier service lacks an attachment array. It does not modify existing valid arrays, legacy names, timelines, or any other collection. Running `load()` twice must produce an identical file on the second run.

## Test strategy

Pure Node tests cover multipart binary parsing, content-type and size policy, upload/read authorization, parent lookup, metadata redaction, attachment backfill idempotency, and supplier-proof state rules. End-to-end curl validation runs a separate API process and a copied store on a spare port. It uploads and reads all kinds, checks negative authorization and validation errors, walks the full proof loop, restarts/stops MinIO, and compares canonical checksums of untouched collections.
