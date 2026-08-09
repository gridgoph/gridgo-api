# Storage and supplier-proof implementation plan

## File map

- `src/attachments.js`: pure attachment constants, validation, multipart parsing, parent lookup, authorization, metadata projection, backfill, and proof-state helpers.
- `src/object-storage.js`: MinIO/S3 SDK configuration, bucket ensure, put/get, availability state, and exception normalization.
- `src/server.js`: route integration, environment-selectable store path, health storage status, attachment upload/read handlers, and proof transitions.
- `tests/attachments.test.js`: pure policy, parser, authorization, backfill, and proof lifecycle tests.
- `docker-compose.yml`, `.env.example`: persistent MinIO development service.
- `docs/STORAGE_API.md`, `README.md`, `AGENTS.md`, `PRD.md`: exact consumer contract and durable project guidance.

## Task 1: Pure attachment and proof rules

**Interfaces:** `parseMultipart(buffer, contentType)`, `validateUpload(file)`, `resolveAttachmentTarget(store, fields)`, `authorizeAttachmentUpload(user, kind, target)`, `authorizeAttachmentRead(user, located)`, `publicAttachment(attachment)`, `backfillAttachments(store)`, `proofUploadTransition(order, user, attachment)`.

1. Write focused `node:test` cases for accepted binary multipart input, missing file, four accepted kinds, disallowed MIME, 10 MiB boundary/overflow, every ownership rule, read isolation, metadata redaction, backfill preservation/idempotency, and the initial/corrected proof transitions.
2. Run `node --test tests/attachments.test.js`; verify failures are caused by the missing module.
3. Implement only the pure rules in `src/attachments.js`.
4. Re-run the focused test and then `npm test`; require zero failures.

## Task 2: MinIO adapter and server integration

**Interfaces:** `createObjectStorage(env)` returns `{ ensureBucket(), putObject(), getObject(), health() }`. Upload route consumes the Task 1 parser/policy and stores metadata on the resolved parent. Read route locates and authorizes before storage access.

1. Add tests for normalized MinIO unavailability and health state using an injected S3 command sender; verify they fail before `src/object-storage.js` exists.
2. Install only `@aws-sdk/client-s3`; add `src/object-storage.js` and pass the adapter tests.
3. Add server integration tests against an isolated copied store and injected/fake storage for upload, download, error mapping, and proof decisions; verify red.
4. Integrate `/attachments`, `/attachments/:id`, `/health` storage status, startup bucket ensure, `STORE_PATH`, public attachment projection, and new transition guards; verify green.

## Task 3: Local infrastructure and consumer documentation

1. Add a MinIO Compose service pinned to an official release, console mapping, health check, and named volume. Bucket creation remains API-boot idempotent.
2. Add `.env.example` with development-only credentials and matching API configuration names.
3. Write `docs/STORAGE_API.md` with every method, auth rule, multipart field, response header/body, error/status pair, state edge, and executable curl example.
4. Update README setup/down commands and contract pointer; update PRD acceptance; record the SDK exception, contract pointer, and new states in AGENTS.md.

## Task 4: Live-style verification without captain-port or captain-store mutation

1. Copy `data/store.json` to a task-local ignored test path. Capture canonical per-collection hashes and full captain-store SHA-256.
2. Run the isolated API twice against the copy and prove the second load is byte-identical; compare untouched collection hashes before/after migration.
3. Start Compose MinIO and the isolated API on a spare port other than 8787/3000/8081-8083; wait for healthy storage.
4. Use real curl multipart requests to round-trip all four kinds and authorized reads.
5. Run the two negative ownership cases plus disallowed type and 10 MiB overflow cases; assert exact status/error pairs.
6. Walk supplier submit, client changes, supplier resubmit, and client approval; assert state and last timeline entry after every request.
7. Restart MinIO and re-read a prior object. Stop MinIO; verify login/orders still work and upload returns `503 minio_unavailable`.
8. Re-run `npm test`, syntax checks, Compose config, `git diff --check`, and captain-store checksums.
9. Commit, push only `fm/gridgo-api-storage`, open a direct PR with command/response evidence, and append the PR URL to the firstmate status file.
