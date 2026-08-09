# Storage and supplier-proof design

The authoritative, app-facing specification is `docs/STORAGE_API.md`. This note records the design boundary; it must not be used as a substitute for that contract.

## Selected architecture

- API control plane: authenticate; stream multipart to disk; count bytes; inspect magic bytes; enforce purpose policy; create and mutate metadata; authorize attach/read/delete.
- MinIO upload data path: after a durable `pending_upload` row exists, the API streams the temp file to private MinIO with the bucket-scoped API credential.
- MinIO download data plane: the API authorizes and stats a ready object, then signs a five-minute GET using fixed `MINIO_PUBLIC_URL`.
- Domain references: top-level `files` owns opaque `fileId` plus private `objectKey`; orders and supplier services contain only purpose-specific file-ID arrays. `artworkName` remains a display-only compatibility mirror.

This supersedes the earlier proxy-download/10 MiB proposal after the legacy server and mobile audits showed that real artwork reaches 50–200 MiB, whole-file buffering exhausts mobile memory, signed URLs must use a phone-reachable origin, and object/metadata partial failures need an explicit lifecycle.

## File lifecycle

`pending_upload -> ready -> delete_pending -> deleted`.

The pending row is saved before `PutObject`. A file ID is returned only after object storage and the ready metadata commit both succeed. A post-put metadata failure triggers compensating deletion; pending/delete markers are reconciled on a later successful-storage boot. Referenced evidence cannot be deleted.

Upload and attach are separate. Attach repeats owner, purpose, policy, target ownership/state, lifecycle, and metadata checks and stats the object immediately before the queued commit. This prevents a valid upload from being rebound as another user's artwork/proof/photo/service image.

## Streaming and validation

The `node:http` multipart parser holds only boundary tail and signature bytes in memory, writes one file part to a private temporary path, and streams that path to MinIO. It accepts Expo `FormData` from a file URI. Extension, any specific declared MIME, and magic bytes must agree; empty/generic iOS MIME is tolerated only when extension and magic agree. HEIC/HEIF is rejected explicitly.

Purpose limits are 200 MiB for artwork/proof and 20 MiB for delivery/service images. Artwork/proof accept JPEG, PNG, WebP, and PDF; the two photo/image purposes accept JPEG, PNG, and WebP.

## Authorization and proofs

Upload role is purpose-gated; attach adds file ownership plus current parent ownership/assignment and state. Downloads are authorized from owner, operations role, or current domain relationships. Live service images are readable by authenticated catalogue users.

Proof attach moves `supplier_accepted` or `supplier_proof_changes_requested` to `supplier_proof_review` and appends a timeline entry carrying `fileId`. The order client requests changes with a reason or approves. Only the assigned supplier or operations can continue approved proof to payment.

## Development security

Pinned MinIO and `mc` images run with a named volume. A one-shot initializer creates the private bucket and a bucket-scoped API user distinct from root. Ports bind to loopback by default. Physical-device signed downloads require explicit exact-LAN-IP binding and matching `MINIO_PUBLIC_URL`; `0.0.0.0`, bare port mappings, Host-derived signing, and post-sign rewriting are prohibited.
