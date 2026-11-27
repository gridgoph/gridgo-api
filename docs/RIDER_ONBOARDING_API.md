# Rider document onboarding

Issue report 3D146B7C. Apply migration `1795793000000_rider_document_review`
before deploying this API. Clerk remains the only sign-in provider.

## Enrollment and uploads

`POST /auth/clerk/enroll/rider` creates/resumes the existing pending application.
Use `GET /auth/me/rider` on every sign-in: it includes `riderProfile`,
`approvalCase`, `documents` and `riderVerification`. Only an approved rider may
receive dispatch offers, accept assignments or start tracking.

Upload through the existing `rider_verification_document` purpose, then
`POST /files/:fileId/attach`. Uploads are private, at most 20 MiB. The attach body
selects exactly one slot:

| `riderDocumentType` | Attach fields | Accepted content |
|---|---|---|
| `drivers_license` (front) | `expiresOn` required, `YYYY-MM-DD`, future in Asia/Manila | JPEG, PNG, WebP |
| `drivers_license_back` | none | JPEG, PNG, WebP |
| `or_cr` | none; no expiry check | PDF, JPEG, PNG, WebP |
| `motorcycle_photo` | `description`, trimmed 1–500 characters | JPEG, PNG, WebP |
| `resume` | none | PDF, JPEG, PNG, WebP |

All five slots and a completed vehicle/plate profile are required before sending.
Expiry is saved on the license-front document and returned as `expiresOn`.
`selfie` remains an accepted legacy optional slot; it never substitutes for a
required document. Each new attachment replaces only the current row of its own
kind; prior rows, references and reasons remain retained as private history.

An application under review cannot change its attached documents. After a
re-upload request, only requested slots may be replaced; other slots remain
unchanged. Each replacement advances `approvalCase.version`. The new document
has no `reuploadReason`; the retired row retains its reason. After all requested
slots are replaced, the rider must explicitly send again.

## Consent and sending

`riderVerification` contains `status`, `requiredDocuments`, `consentVersion`,
`consentWording` and `consent` (null until sending). Render the server-provided
wording beside an unticked consent control. To send, require `Idempotency-Key`
and call:

```http
POST /me/approval-cases/rider/submit
Idempotency-Key: rider-send-unique-key
Content-Type: application/json

{"expectedVersion":3,"consent":{"accepted":true,"version":1}}
```

The server rechecks all ready documents, future license expiry, profile and the
current version. It records the server time, version and exact wording in
`riderVerification.consent: {acceptedAt,version,wording}` and the immutable
submission event. No caller-supplied timestamp or wording is accepted. A missing
or unchecked consent is `400 consent_required`. A rejected application's existing
`POST /me/approval-cases/rider/reapply` also requires this `consent` object.
Exact idempotency retries replay the original success; changed input with the
same key is `409 approval_state_conflict`.

`riderVerification.status` is `intake`, `under_review`, `needs_reupload` or
`approved` (and mirrors `rejected`/`suspended` after those staff actions).
The existing `approvalCase.status` remains `pending` during intake, review and
re-upload, preserving the membership contract. Read the dedicated review status
for the rider onboarding screen. Re-upload keeps the case in the submitted queue.

## Operations and Admin review screen

Operations and Super Admin use these authenticated endpoints:

- `GET /approval-cases?kind=rider&status=pending&cursor=...`: submitted riders,
  up to 50, `nextCursor`; each row adds `riderVerification`. Use
  `status=approved` for approved riders. Operations must specify `kind=rider`.
- `GET /approval-cases/:caseId`: `applicant`, `riderProfile` (vehicle, plate,
  license number), `riderDocuments` (current files, description, expiry,
  `reuploadReason`), `riderVerification`, and immutable `history`.
- `GET /files/:fileId/download-url`: authorized, short-lived preview/download.
  The detail's file metadata does not contain object keys or signed URLs.
- `POST /approval-cases/:caseId/approve`: existing
  `{expectedVersion,requestId,note?}` contract. Requires explicit submission,
  all current ready documents, consent, and no outstanding re-upload cycle.
- `POST /approval-cases/:caseId/needs-reupload`: example below. Each selected
  current document needs a nonblank reason (up to 1,000 characters). Duplicate
  kinds, unsupported fields and empty selections return
  `400 invalid_reupload_request`.

```json
{
  "expectedVersion": 1,
  "requestId": "rider-review-unique-request",
  "documents": [{"kind":"or_cr","reason":"The registration number is unreadable."}]
}
```

The re-upload action increments the case version and returns the full detail plus
`replayed`. An exact `requestId` retry adds no events or notifications; different
input with that ID returns `409 request_id_conflict`. Stale decisions return
`409 approval_case_stale`; invalid states return `409 approval_state_conflict`.
All mutations commit documents, review state, consent, immutable case events,
audit and durable notifications in the existing locked transaction.

Operations has rider read/approve/re-upload access only. Other case kinds and
reject/suspend/restore decisions retain their existing Super Admin authorization.
Clients and shops cannot read rider documents through file, order or case routes.
The rider can still preview their own uploads. No document IDs are added to
ordinary public user projections.

Every review-state change writes durable `rider_under_review`,
`rider_needs_reupload`, `rider_approved` (or the corresponding rejection/suspension)
inbox rows to the rider and every current Operations/Super Admin membership.
Existing `save()` outbox delivery sends push after commit; push data contains
only the existing allowlisted identifiers, never document reasons or consent.
Approvals and identity invalidations tell apps to refetch.

## Existing approvals and rollout

The forward migration marks only riders already approved at migration time with
an internal `legacyApproved` compatibility marker. It changes no approval,
assignment, earnings or job gate. They keep working without uploading the new
bundle, and a later Super Admin restore can retain that exemption. Suspension
still blocks their work until restored. Rejection/reset to pending requires the
complete new application; the exemption does not authorize a new pending
approval. New approvals through the legacy `/users/:id/verification` route now
use the same document, explicit-submit and consent gates, preventing typed-field
approval from bypassing onboarding.

Deploy this migration/API before the rider and dashboard releases. The API does
not deploy either companion screen or publish this change to production itself.
