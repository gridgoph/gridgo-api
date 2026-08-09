# Storage and supplier-proof implementation plan

1. Add streamed multipart parsing, magic-byte/type/size policy, file lifecycle, authorization, parent reference, proof transition, and idempotent backfill helpers with `node:test` coverage.
2. Add the single approved direct dependency (`minio` SDK), with private put/stat/delete and fixed-public-origin presigned GET operations plus normalized storage errors.
3. Integrate `POST /files`, `POST /files/:id/attach`, `GET /files/:id`, `GET /files/:id/download-url`, and `DELETE /files/:id`; keep external I/O outside the JSON mutation queue and use atomic saves.
4. Add pinned MinIO/`mc` Compose services, loopback-default binding, named volume, private bucket initialization, a bucket-scoped non-root API credential, and exact README commands.
5. Preserve the live store through additive load-time file-registry/file-ID backfill; compare canonical untouched-collection hashes and prove a second run is byte-identical.
6. Validate on a copied store and spare port: all four upload/attach/presigned-download round trips, negative owner checks, MIME/oversize rejects, full proof correction loop, MinIO restart persistence, MinIO outage degradation, pending cleanup, and delete/reference protection.
7. Reconcile `README.md`, `PRD.md`, `AGENTS.md`, and the exact mobile contract in `docs/STORAGE_API.md`; run tests, syntax checks, Compose validation, audit, diff checks, and independent review before publishing.
