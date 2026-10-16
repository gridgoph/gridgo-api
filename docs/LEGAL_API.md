# Legal documents, consent and privacy requests

Server contract for report **879B25FC**, tracked in [gridgo-api issue 202](https://github.com/gridgoph/gridgo-api/issues/202). This release supplies the backend and placeholder documents. Apps, dashboard and website screens follow separately. No real legal text is supplied by this release.

Apply migrations, then `npm run seed`. For an existing development database with later migrations already applied, the operator must run `node-pg-migrate up --no-check-order` (or the equivalent local binary invocation). Do not migrate or seed a running development lane from a task worktree.

## Storage and launch library

PostgreSQL stores editable `legal_documents` drafts, immutable `legal_versions`, append-only `legal_acceptances`, and the manual `privacy_requests` queue. PDF bytes remain in MinIO; versions reference `files.file_id`. Mutations, audit rows and staff inbox notifications commit under the existing domain transaction/advisory lock. SQL triggers reject UPDATE and DELETE of published versions and acceptances; there are no HTTP update/delete paths for evidence. Database-owner maintenance such as test TRUNCATE is outside this application boundary.

Reference seed creates these eight slots and their visible placeholder version 1. It never creates users or acceptance records and never overwrites an operator's draft or publication.

| Document ID | Title | Audience |
| --- | --- | --- |
| `terms-of-service` | Terms of Service | `all` |
| `privacy-notice` | Privacy Notice | `all` |
| `supplier-agreement` | Supplier Agreement | `supplier` |
| `rider-agreement` | Rider Agreement | `rider` |
| `hub-staff-terms` | Hub Staff Terms | `staff` |
| `cookie-notice` | Cookie Notice | `all` |
| `age-policy` | Age Policy | `all` |
| `acceptable-use` | Acceptable Use and Artwork Rights | `all` |

Placeholder copy explicitly says the reviewed text will be published later. Acceptance of a placeholder is labelled as such in its version and does not stand in for acceptance of the real text. Launch-slot audiences cannot be changed. Additional document IDs may be created. Reserved launch slots cannot be deleted; neither can any document with a published version. Only an unpublished, non-launch document can be deleted.

## Public reads and account library

No bearer is required:

- `GET /legal/documents?audience=client|supplier|rider|staff|all` → `{ documents: [...] }`. Omitted `audience` or `all` lists the whole library; a specific audience includes that audience plus `all` documents.
- `GET /legal/versions/:versionId` → `{ document: ... }`. Historical effective versions remain readable for evidence and stable links.
- `GET /legal/versions/:versionId/pdf` → the normal MinIO signed-download response `{ url, expiresAt, expiresInSeconds }` when the version has a PDF. Object keys are never returned. Draft and future-effective PDF versions are not public.

A document version has `id` (opaque version ID), `documentId` (stable slot), integer `version`, `title`, `audience`, `text`, `pdfFileId`, `pdfUrl`, `effectiveAt`, `publishedAt`, `placeholder`, `material`, `penalties`, `changeSummary`, and `status: placeholder|live`. Treat `text` as plain text, never executable HTML. `pdfFileId` is an opaque file reference. An optional PDF supplements or replaces the text.

Only effective versions appear publicly; for each document the highest effective version wins. Publishing later text never changes an earlier version. Responses use `Cache-Control: no-store` so newly effective text appears without an app release.

The Accounts > Legal & Privacy library in each app uses its audience. Sign-up links and landing-footer links can use the same anonymous API. The website cookie banner should link `cookie-notice`; non-essential cookies must remain off until the website obtains its own opt-in. This API does not switch browser cookies on or issue an anonymous tracking identifier.

## Pending consent and first sign-in

`GET /me/legal/pending` requires a mapped Clerk bearer and returns:

```json
{ "blocking": true, "pending": [], "notices": [] }
```

Arrays contain complete version objects. Audience selection uses **database memberships**, including all memberships of a multi-role identity, never Clerk metadata or the legacy `users.role`. `all` applies to every signed-in identity.

On first use, Terms, Privacy and the applicable Supplier/Rider/Hub Staff agreement go in `pending`. Supplier/rider apps must call this on their first sign-in, including accounts provisioned by staff. A material version goes in `pending` until the user accepts it or a later version of that document. The first non-placeholder publication is always material, regardless of the editor's submitted flag. Changes to audience or penalty applicability also force material publication.

An editorial/non-material update goes in `notices` when the prior material obligation was accepted. It must not erase an older unaccepted material change: a user who skipped that change is prompted for the latest effective text. Apps display the notice and may remember its version locally to avoid repeating it; no new checkbox is required for an editorial notice. Historical versions cannot be submitted as a substitute for the current text.

Apps call pending on each open/sign-in and block their ordinary navigation while `blocking` is true, with a screen showing the documents and a required initially unticked checkbox. Access to legal text, privacy actions and sign-out remains possible. This server release does **not** add a blanket middleware block to unrelated legacy routes. The pending response is the frontend rollout contract; the existing released apps keep working until their compatible screens ship.

`POST /me/legal/accept`:

```json
{
  "accepted": true,
  "versionIds": ["opaque-version-id"],
  "method": "blocking_screen",
  "app": "gridgo-supplier/1.2.3",
  "device": "app-generated-installation-id"
}
```

`method` is `checkbox|blocking_screen`; `app` is a nonblank string of at most 80 characters and `device` at most 200. These are caller-reported context, not verified hardware identities. Do not send push tokens or device secrets. Submit 1–30 unique current version IDs applicable to this user's memberships. The server records the authenticated user ID and server time; callers cannot supply either. A retry for the same user/version/purpose is a no-op and preserves the original time and context. Response is `{ blocking, pending, notices, recorded }`.

Errors include `401 unauthorized`, `403 legal_audience_mismatch`, `400 legal_consent_required`, `400 invalid_acceptance_metadata`, `400 invalid_legal_versions`, and `409 legal_version_changed`. On the last error, refetch text and obtain consent again.

## Versioned enrollment consent

The existing routes remain the only enrollment paths:

- `POST /auth/clerk/activate` (client)
- `POST /auth/clerk/enroll/supplier`
- `POST /auth/clerk/enroll/rider`

New app releases add the following **top-level body fields**, alongside the existing profile/service fields. Supplier/rider routes retain their existing `Idempotency-Key` requirement and request-payload retry rules.

```json
{
  "legalConsentVersion": 1,
  "legalConsent": {
    "accepted": true,
    "versionIds": ["terms-of-service-1", "privacy-notice-1"],
    "method": "checkbox",
    "app": "gridgo-client/1.2.3",
    "device": "installation-id",
    "junior": false,
    "marketing": false
  }
}
```

Use IDs from public reads, not hard-coded version 1. Required IDs are Terms and Privacy, plus Supplier Agreement or Rider Agreement for the corresponding enrollment. `junior` is a required boolean declaration. If true, `guardian: true` is also required. The app implements the age question and guardian tick; the API neither infers age from a name nor stores a birth date. `marketing` is optional and defaults to false; a false or omitted marketing choice must never prevent enrollment. If present, marketing/guardian must be booleans.

The Terms + Privacy checkbox must start unticked and block the app's sign-up submission until checked. Marketing is a separate optional unticked checkbox. The server enforces explicit required consent for v1 enrollment; it does not intercept Clerk's separate creation of an identity before GRIDGO enrollment. A junior without the guardian affirmation cannot complete v1 GRIDGO enrollment.

Omitting **both** new fields is the compatibility path for already released apps. It records **no inferred consent**. Supplying either opts into validation, and any version other than integer `1` returns `400 unsupported_legal_consent_version`. A v1 body missing required consent returns 400 without committing enrollment. New builds must always send the version; the discriminator is a protocol capability, not a cryptographic app-version attestation. It cannot yet prevent an old or modified caller from choosing the legacy body. Do not claim universal signup enforcement until old-build update coverage is confirmed.

Enrollment and its acceptance rows commit atomically. Terms and Privacy rows both snapshot `marketing`, `junior`, and `guardian`; these are enrollment evidence, not a mutable marketing-preference service. Future consent toggles are out of scope.

## Per-order artwork rights

The `acceptable-use` slot also owns the artwork-rights statement; its real text must explicitly cover the right to print supplied content. Use an independent required, initially unticked per-order checkbox. Reusing general Terms acceptance is insufficient.

For new builds, add this to `POST /files/:fileId/attach` when attaching artwork to an order:

```json
{
  "orderId": "ord_...",
  "legalConsentVersion": 1,
  "artworkRights": {
    "accepted": true,
    "versionIds": ["acceptable-use-1"],
    "method": "checkbox",
    "app": "gridgo-client/1.2.3",
    "device": "installation-id"
  }
}
```

Keep the existing attachment target fields, including line scope where required by the storage contract. The same `legalConsentVersion` and `artworkRights` fields belong in `POST /me/carts/:id/checkout`. Cart uploads occur before an order exists; checkout records a separate acceptance for **every resulting order**, including multiple shop/deadline groups. The shared basket payment boundary and integer-centavo calculations are unchanged.

The acceptance references the owning client, order and exact document version in `legal_acceptances` with `purpose=artwork`. Repeated attachment of the same version to the same order does not replace the original evidence. A new version accepted for that order appends another row. Evidence is kept outside ordinary order projections. The original `/files` multipart byte-upload request remains `purpose` + `file`; consent is required at the order attachment/checkout boundary, when there is an order to bind it to.

A v1 order attachment/checkout without valid rights affirmation is rejected (`400 artwork_rights_required`, or the shared metadata/version error); its domain changes roll back. Only the owning client may record it. Legacy calls omitting both fields retain existing behavior and create no acceptance. New apps must always send the version field, even if their checkbox has not been checked. This deliberately uses the same explicit compatibility rule as enrollment.

## Super Admin editor and publication

Operations and Super Admin may read the library's editor/history views. Only a database **Super Admin membership** may create, edit, delete or publish:

| Route | Body/result |
| --- | --- |
| `GET /admin/legal/documents` | `{ documents: [{ id, revision, draft, launchSlot, versions }] }` |
| `GET /admin/legal/documents/:id` | Same envelope filtered to one document |
| `POST /admin/legal/documents` | `{ id, draft }` → 201 `{ id, revision: 1, draft }` |
| `PATCH /admin/legal/documents/:id` | `{ expectedRevision, draft: { changed fields } }` → `{ id, revision, draft }` |
| `POST /admin/legal/documents/:id/publish` | `{ expectedRevision }` → 201 `{ document, revision }` |
| `DELETE /admin/legal/documents/:id` | `{ expectedRevision }` → `{ ok: true }`; unpublished non-launch only |

Document IDs match `[a-z][a-z0-9-]{2,79}`. Draft fields are `title` (1–200 chars), `audience`, `text` (up to 200,000 chars), `pdfFileId` (nullable), `placeholder`, `material`, `penalties` (booleans), `changeSummary` (1–4,000 chars), and ISO `effectiveAt`. Text or PDF is required. The draft is the editable **Draft** state; public version status is **Placeholder** or **Live**. Editing a draft never edits the current live version. `revision` is the optimistic editor token, separate from the increasing published `version` number. Both edit and publish increment revision; stale requests return `409 legal_document_changed`.

Upload PDF via the normal `POST /files` multipart route with purpose `legal_document` (Super Admin only, PDF only, 20 MiB maximum). Use the returned file ID in the draft. Publish verifies ready state, purpose and detected PDF type. Published PDFs remain retained as legal evidence; automatic retention and early deletion refuse legal-document files, including unbound uploads. No raw object keys appear in document responses.

Each publication creates a new immutable row. Effective dates cannot precede the previous published version's effective date. Future publications take effect on their date through ordinary reads; there is no scheduler to enable. Once real text has been published, reverting to placeholder is refused. `penalties` may be true only for a real Supplier Agreement. First real publication, audience changes, and changes to that flag automatically become material. The final enforced flag is the version response's top-level `material`.

Every create/edit/delete/publish writes an audit row (`legal.created|edited|deleted|published`) and staff inbox event for both Operations and Super Admin, with realtime invalidation before save. Edit audits retain the new draft and revision; publish audits retain the exact version ID and enforced material flag. Seed is idempotent reference data and does not manufacture actor audit events.

## Acceptance history and CSV

Operations and Super Admin:

`GET /admin/legal/acceptances?userId=:userId&offset=0`

Returns `{ acceptances, nextOffset }`, 1,000 rows per page in server-time/ID order. Rows use database field names: `id`, `user_id`, `version_id`, `document_id`, integer `version`, `accepted_at`, `method`, `app`, `device`, `purpose` (`document|enrollment|artwork`), `order_id`, `marketing`, `junior`, `guardian`. Non-enrollment optional-choice fields are null. Evidence is per document version, not a mutable “agreed” flag on the user.

Add `format=csv` for `text/csv` with an attachment filename. Columns are the same evidence fields. Every value is quoted, quotes/newlines are escaped, and spreadsheet-formula-leading values are apostrophe-prefixed. Continue using `X-Next-Offset` when present; CSV pages each include a header. The export is deliberately scoped to an explicit user ID. Clients/suppliers/riders cannot read another person's evidence or export this administrator history.

## Privacy requests

Mapped Clerk users, including users with a held account, can use:

- `POST /me/privacy-requests` with `{ kind: "access"|"correction"|"deletion", confirmed: true, details?: "..." }` → 201 `{ request }`.
- `GET /me/privacy-requests?offset=0&status=pending` → only the caller's requests. Status is optional.

Operations/Super Admin:

- `GET /admin/privacy-requests?status=pending&offset=0` → `{ requests, nextOffset }`, 100 rows per page, earliest due first. Omit status for all requests.
- `PATCH /admin/privacy-requests/:id` with `{ expectedRevision, status?, dueAt?, handlerId?, resolution? }` → `{ request }`.

Projection: `id`, `userId`, `kind`, `status`, `details`, `resolution`, `requestedAt`, `dueAt`, `handlerId`, `updatedAt`, `revision`. Status is `pending|in_progress|completed|rejected`. Due date defaults to **15 calendar days** after server receipt and is editable by staff; `handlerId` is nullable and otherwise must reference an Operations/Super Admin membership. `details`/`resolution` are at most 4,000 characters. Completed/rejected requires a nonblank resolution. Stale revisions return `409 privacy_request_changed`; an ineligible handler returns `400 invalid_privacy_handler`.

This is a manual queue. “See my data”, “Correct my data” and “Delete my account” create requests; they do not automatically export data, edit a profile, delete Clerk identities, remove invoices, or erase acceptance evidence. Staff verify the requester and record how the request was fulfilled and which necessary records were retained. Due dates here are product workflow targets, not a statement of a statutory deadline. New screens use this queue; the existing `/me/account-deletion-request` and its 30-day legacy queue remain available for released clients and the old website form. They are not silently converted or duplicated into the new queue.

Creation and status/due/handler edits are audited (`privacy.requested|updated`) and notify both privileged membership types. Privacy access stays available during account holds. This does not grant the held account access to ordinary work routes.

## Supplier penalties and data minimisation

Before a real effective Supplier Agreement exists, the existing production-penalty behavior remains unchanged, including the default-off Super Admin switch, warning-first policy, collection cap and independent refund/claim holds.

Once a real version is effective, new monetary deductions require that its `penalties` flag is true and the shop has accepted that version or an applicable penalty-bearing version after the most recent material publication. Editorial updates preserve that consent. A material update requires fresh acceptance before another deduction. A real agreement with `penalties: false` permits no new monetary deduction. Warnings/ranking still work; already-applied deductions and published payout shares are not rewritten. Each new deduction records the controlling `supplierAgreementVersionId` in its lapse evidence. All arithmetic remains integer PHP minor units, and payout shares, service fees, the Organization discount, checkout grouping and refunds retain their existing formulas and snapshots.

Supplier order projections strip structured client/customer identity, phone/email/recipient contact, organization officer and invoice-delivery details, including nested quote snapshots. Legacy collection recipient names and handover timeline notes are hidden from suppliers and riders. The supplier's own counter-contact projection is retained. Rider projections retain route coordinates, delivery recipient contact only when assigned, package/count/QA information, delivery evidence and rider earnings. Payment entries expose status for delivery gates, while billing amounts, quotes, invoices and legal evidence are omitted. Existing scoped artwork/mockup access needed for the six-check pickup QA remains governed by `order-file-access.js`; this does not open broader account/contact access. User-authored artwork and free-text location labels are not automatically redacted.

Companion screens should put short purpose notices beside address/phone fields and photo capture, for example: “We use this address to route your delivery”, “We use this number for delivery coordination”, and “This photo records the handover or verifies the requested document”. Tailor these to the actual capture purpose; legal-document content remains editable by Super Admin. Do not put names/phones into supplier-visible free-text order instructions as a substitute for private contact fields.

## Release checks

The server tests cover anonymous reads, role audiences, immutable SQL evidence, first-real/material/editorial requirements, consent metadata and retries, versioned enrollment and guardian/marketing choices, order rights compatibility, queue ownership and staff permissions, CSV escaping, audit/inbox rows, penalty eligibility and role-safe projections. Use an isolated named test database. Full PostgreSQL 17 suite and image-volume checks run in PR CI.

Frontend release acceptance additionally requires the account library, initial unchecked sign-up controls, on-open pending screen, supplier/rider first-use gate, per-order rights checkbox, privacy actions/queue, purpose notices and website cookie behavior. The backend alone does not claim these screens exist. Self-service export/deletion, mutable marketing toggles, incident logs, legal takedown workflows and real legal drafting are outside this release.
