# Business and organization verification

Implements the backend for client #163, #164 and #165 on the existing `business_client`
approval case. All routes require a Clerk session. Client routes require the client
membership; staff routes require Operations or Super Admin. The shared organization
email belongs to the signed-in Clerk identity: this API never links identities by email
or creates another login. Application approval changes the account type; submission does not.

## Upload and application checklists

Upload each document using the existing multipart `POST /files` with
`purpose=client_verification_document` (JPEG, PNG, WebP or PDF; 20 MiB maximum).
Keep the returned opaque `file.fileId`. Submit IDs in `documents`; submission attaches
ready files atomically. Do not call `/files/:id/attach` for this purpose. Each checklist
item needs its own file, owned by the applicant. Operations checks authenticity,
matching personal details and business bank-account ownership during review.

Only Operations and Super Admin may subsequently read these files, including signed
URLs (`GET /files/:id`, `GET /files/:id/download-url`). Even the uploader cannot read
verification bytes back through these routes. No public profile exposes their IDs.

`GET /me/client-application/checklist` returns `requiredDocuments`, `optionalDocuments`,
`optionalFields`, `filePurpose` and the current case's `businessPermitRequired`.

| Track | Required keys in `documents` |
| --- | --- |
| organization | `government_id`, `student_id`, `enrollment_document` |
| sole_proprietor | `government_id`, `payout_bank_proof`, `bir_2303`, `dti_certificate` |
| partnership / corporation | `government_id`, `payout_bank_proof`, `bir_2303`, `sec_certificate`, `articles_and_bylaws`, `general_information_sheet`, `signatory_authorization` |

`signatory_authorization` is the notarised board resolution or secretary's certificate.
`school_recognition_certificate` and `facultyAdviserContact` are optional for organizations.
`business_permit` is optional unless staff requests it (Mayor's or Barangay permit).
All other listed documents are mandatory for the pilot.

## Organization email code

1. `POST /me/organization/email-code` with `{ "email": "<shared-login-email>" }`.
   The email must equal the signed-in identity's stored Clerk email. A six-digit code
   is sent using server-only `EMAIL_USER` / `EMAIL_PASSWORD` (the existing mail credentials).
   Returns `{ expiresAt, resendAfter }`, never the code.
2. `POST /me/organization/email-code/verify` with `{ "code": "<six digits>" }`.
   Returns `{ verified: true, expiresAt }`.
3. Submit the application before `expiresAt`. Verification is consumed by that
   applicant revision. Each handover or corrected organization application needs a new code.

Codes expire in ten minutes, permit five guesses, and are single use. Resends invalidate
previous codes; requests are limited to one per minute and five per hour per identity.
Only an HMAC of the code is persisted; its server-side key is the Clerk secret (rotation
invalidates outstanding codes). Failed guesses commit their counters even on HTTP 400.
No mail configuration returns `503 organization_email_not_configured`; delivery failure
returns `503 organization_email_delivery_failed`. Other errors include
`organization_login_email_required`, `organization_code_rate_limited` and
`organization_code_invalid_or_expired`.

## Submit or correct an application

`POST /me/business-application`, with a unique `Idempotency-Key`:

```json
{
  "accountType": "organization",
  "businessName": "<organization name>",
  "businessNature": "<purpose>",
  "school": "<school name>",
  "organizationEmail": "<shared-login-email>",
  "officer": {
    "fullName": "<name matching ID>",
    "dateOfBirth": "2000-01-01",
    "address": "<address matching ID>",
    "phone": "<contact number>",
    "governmentIdType": "passport",
    "governmentIdExpiresOn": "2030-01-01",
    "originalId": true,
    "detailsMatchId": true,
    "studentIdExpiresOn": "2030-01-01"
  },
  "documents": {
    "government_id": "file_...",
    "student_id": "file_...",
    "enrollment_document": "file_..."
  }
}
```

Business bodies use `accountType: "business"`, `businessType: "sole_proprietor" |
"partnership" | "corporation"`, and `signatory` in place of `officer` (no student-ID
expiry, organization email or school). The signatory uses the same government-ID and
personal-detail fields. IDs must be original and unexpired. Accepted `governmentIdType`
values are `philid`, `ephilid`, `passport`, `drivers_license`, `umid`. Non-expiring
PhilID/ePhilID/UMID may use `governmentIdHasNoExpiry: true` instead of an expiry date.
Dates are real `YYYY-MM-DD` calendar dates; expiry is inclusive in Manila time.

The organization-name/school **pair** is unique after Unicode normalization, case folding
and whitespace normalization. Distinct organizations can share a school. Pending
applications reserve that pair; initial rejection releases it. Duplicate attempts return
`409 organization_already_exists`, without identifying the other account. PostgreSQL
also enforces uniqueness, and the domain transaction lock serializes submissions.

Initial submissions return 201 and the fixed client auth projection. Exact retries return
200 without duplicating a case, documents or notifications. A pending/rejected application
can be corrected by supplying the full body, its `expectedVersion` and a new idempotency
key. Corrections increment the application revision in the same case. The existing
`POST /me/approval-cases/business-client/reapply` accepts `{ expectedVersion, application,
correctionSummary? }` with the same full application object. The legacy
`POST /me/business-apply` accepts the same checklist fields alongside its existing contact
and address fields; it cannot bypass verification.

Missing, expired, unready, foreign-owned or wrong-purpose evidence returns
`400 invalid_application` with `fields`. Missing/fresh-code failures return
`409 organization_email_verification_required`. Stale case versions return
`409 approval_state_conflict`.

## Operations review

Existing `GET /approval-cases` and `GET /approval-cases/:id` remain the review queue/detail.
Detail adds the submitted checklist and private personal details to `application`, and
`organization` includes the dated `officerHistory`. Applicant revisions stay in `history`.
Resolve each document ID through the staff file routes above. Decisions continue through
`POST /approval-cases/:id/{approve,reject,suspend,restore}` with existing concurrency and
request-ID checks. Approval revalidates all file states and ID expiry.

`POST /approval-cases/:id/request-business-permit` accepts `{ expectedVersion, reason }`.
Staff can use it on a pending business case. It increments the version, audits the request
and sends the applicant a notice. Approval is refused until a corrected revision includes
`documents.business_permit`.

Pre-rollout pending name-only cases cannot be approved without resubmitting a complete
checklist (`409 application_checklist_required`). Already-approved accounts retain their
status. An existing organization without an officer record submits the full organization
application with its current `expectedVersion` to establish the first verified officer.
Staff can also list and notify these legacy organizations before their first officer is verified. The migration never invents a verified person or backfills old orders with today's name.

## Officer of record and handover

`GET /me/organization` and `GET /auth/me/client` expose `organization` with
`currentOfficer`, `confirmedAt`, `nextConfirmationAt`, `confirmationRequestedAt`, a compact
`approvalCase` and `actions`. A pending initial application has `currentOfficer: null`.

`POST /me/organization/officer/handover` accepts `{ expectedVersion, officer, documents }`
and `Idempotency-Key`. Complete the email-code flow first. Upload fresh incoming-officer
documents and use the organization checklist; already-approved officer files cannot be
reused. Organization name and school remain fixed. The existing review case gets a new
pending revision. Ordering and business-order capabilities remain available throughout
pending/rejected handover. The previous verified officer remains responsible until staff
approves the incoming officer. Rejection keeps the previous officer in place.

Approval closes the previous history entry's `endedAt` and creates exactly one current
entry with `{ id, fullName, startedAt, endedAt: null, verifiedAt, approvalCaseId,
applicationRevision }`. Approval retries cannot append another entry.

Every new order snapshots `organizationOfficer: { id, fullName, verifiedAt }` (or null).
Single-shop and basket invoice snapshots carry the same field. Invoice/statement renderers
must print this **order-time snapshot**, never the live profile's name. `GET /orders` and
`GET /orders/:id` expose it only to the owning client and staff, and
`GET /orders/:id/invoice` uses its immutable receipt snapshot. This supplies the officer
field for statement consumers; it does not introduce the separate statement-export product.
Older orders stay unattributed if no verified officer was recorded then.

## Quarterly confirmation and manual notices

The existing transactional lifecycle worker checks each organization's persisted due date.
First approval, handover approval and confirmation schedule the next check three calendar
months later, clamping to the last day of shorter months. Missed cycles coalesce into one
notice and advance to the next future due date. Restart/retry cannot duplicate a cycle.
Removed/suspended accounts do not receive scheduled reminders.

A reminder is an ordinary durable inbox/push event of type `organization_officer_confirmation`.
`GET /notifications` includes `organizationUserId`, `officerId` and
`actions: ["confirm_officer", "change_officer"]`:

- Confirm: `POST /me/organization/officer/confirm` with `{ officerId }`. Stale officers
  return `409 officer_changed`; a pending handover returns `409 officer_handover_pending`.
  Confirmation clears the outstanding reminder and resets the quarterly clock; retry is a no-op.
- Change: open the verification form and submit the handover endpoint above. It does not
  replace the verified officer until Operations approves it.

Staff endpoints:

| Method/path | Contract |
| --- | --- |
| `GET /ops/organizations?after=<userId>` | Up to 50 organization projections and `nextCursor` |
| `GET /ops/organizations/:userId` | Organization projection including full dated officer history |
| `POST /ops/organizations/:userId/notice` | `{ title, body }` plus `Idempotency-Key`; max 160/2000 characters; returns `{ notificationId }` |

Manual notices address the **current shared organization account**, which is also the
current officer's login. Historical officer records are never delivery recipients. No
separate personal officer identity is inferred or linked by name/email. Inbox records are
also written to current Operations/Super Admin memberships, following the domain-event
contract. Notices use the existing after-commit outbox, realtime and token ownership gates;
no push data allowlist is expanded. Same-key/same-body retries return the original notice;
changed bodies return `409 idempotency_conflict`.

## Persistence and retention

Migration `1791504000000` adds `organization_accounts`, `organization_email_challenges` and
`approval_cases.business_permit_required`; application evidence stays on existing immutable
approval events and private file references. No schema is created at boot. All mutations,
case changes, history, audits and notification records share the domain transaction lock.

Documents follow [file retention](STORAGE_API.md#retention-and-daily-cleanup): retained while
the account is active, then one year after account closure or that application revision's
rejection. Rejected incoming-officer files have their own rejection clock; rejecting a
handover never expires the active officer's approved documents. Reused corrected evidence
clears its prior rejection clock. Open-case holds and audited Super Admin early deletion
remain in force. Automatic deletion remains OFF; this change never enables it.
