# GRIDGO Operational Model v2 API

This is the rebuild contract for the three mobile apps and Operations web portal. Field names, enum values, money units, authorization, and state transitions are case-sensitive. `docs/STORAGE_API.md` and `docs/TAXONOMY_API.md` remain authoritative for file bytes and taxonomy structure.

## Conventions

- Bearer auth: `Authorization: Bearer <Clerk session JWT>` except `/health`, `/catalog`, `GET /public/payment-qr`, `GET /public/announcement-images/:fileId`, `POST /webhooks/clerk`, and the two device-registration routes below, which accept a call with **no** `Authorization` header from a phone that has not signed in. Sending an *expired* token is still `401` — omit the header entirely to register anonymously.
- Money: integer PHP minor units. Never send formatted peso strings as amounts.
- Errors: `{ "error": "snake_case", "message": "concrete problem and recovery", ...details }`.
- Membership roles: `client`, `supplier`, `rider`, `ops_admin`, `super_admin`. Clerk claims and metadata never grant them.
- Approval cases: `pending | approved | suspended | rejected`. Only `approved` supplier/rider cases can receive work.
- Client `accountType`: `individual | business | organization`. Clerk self-activation creates an `individual` client; Operations can update the profile later.

### Selecting an actor role

Authenticated domain requests may send `X-GRIDGO-Role` with one of the caller's memberships; CORS permits this header. It selects authorization and response projection without changing the stored primary role. Unknown or missing memberships return `403 forbidden`. Fixed auth projections, activation, and enrollment keep their URL-selected bootstrap behavior. `/auth/me` still returns all memberships; a supported header projects `user.role` and approval when that membership exists, otherwise it returns the bootstrap identity needed for enrollment.

Without the header, primary-role compatibility remains, except `/dispatch/offers` and `POST /dispatch/*` infer a held rider membership for non-Operations actors, and `/jobs` infers a held supplier membership. Location GET does not infer rider. Explicit role selection also limits approval-decision audit authority to that role; requests without it keep existing administrator precedence. Account-profile routes, including `POST /me/business-apply`, still require a persisted client primary row during the compatibility window (`409 client_profile_unavailable` otherwise).

Supplier/rider order and dispatch access requires current approval. Order reads expose assigned work and, for approved riders, unassigned eligible dispatch offers; other riders' active jobs are excluded. Reassignment removes the former assignee's access. File rules are in [Storage API](STORAGE_API.md#post-filesfileidattach--bind-to-a-domain-record).

`GET /users?role=` remains a membership directory filter, not an actor selector. It includes secondary memberships and projects that role's profile/approval; without the filter it retains the primary-user directory.

## Complete route index

| Method | Path | Authorization | Contract |
|---|---|---|---|
| GET | `/health` | public | service/database/storage/push health, plus `commit`/`builtAt` build identity |
| GET | `/catalog` | public | demo product catalogue |
| POST | `/auth/signup` | removed | always `404`; sign-up is owned by Clerk |
| POST | `/auth/login` | removed | always `404`; sign-in is owned by Clerk |
| POST | `/auth/clerk/activate` | Clerk JWT | create or add only the caller's personal client membership after Google/email SSO |
| POST | `/auth/clerk/enroll/supplier` | Clerk JWT + `Idempotency-Key` | create or add a pending supplier membership/profile and draft category services |
| POST | `/auth/clerk/enroll/rider` | Clerk JWT + `Idempotency-Key` | create or add an unsubmitted pending rider membership/profile |
| POST | `/me/business-application` | client membership + `Idempotency-Key` | submit a pending business-client application without removing personal access |
| POST | `/me/approval-cases/rider/submit` | rider membership + `Idempotency-Key` | idempotently confirm the current-licence gate and submit the pending case |
| POST | `/me/approval-cases/:kind/reapply` | matching membership + `Idempotency-Key` | rejected applicant resubmission for `business-client`, `supplier`, or `rider` |
| GET | `/auth/me` | authenticated | identity plus every DB membership and approval-case summary; refreshes the person name and email copy from Clerk |
| POST | `/webhooks/clerk` | Clerk Svix signature | refresh the person copy for a mapped account after a Clerk dashboard edit |
| GET | `/auth/me/client` | client membership | client profile, business case, and capabilities |
| GET | `/auth/me/supplier` | supplier membership | supplier profile, case, readiness, and capabilities |
| GET | `/auth/me/rider` | rider membership | rider profile, case, document summaries, and capabilities |
| GET | `/auth/me/ops` | `ops_admin` membership | fixed Operations projection |
| GET | `/auth/me/admin` | `super_admin` membership | fixed Super Admin projection |
| GET | `/approval-cases?status=&kind=&cursor=` | ops/super | submitted cases ordered oldest first; defaults to pending |
| GET | `/approval-cases/:caseId` | ops/super | applicant profile, kind-specific review data, readiness, and immutable history |
| POST | `/approval-cases/:caseId/approve` | ops/super | pending → approved with expected version and idempotency key |
| POST | `/approval-cases/:caseId/reject` | ops/super | pending → rejected; reason required |
| POST | `/approval-cases/:caseId/suspend` | ops/super | approved → suspended; reason required |
| POST | `/approval-cases/:caseId/restore` | ops/super | suspended → approved; restore note required |
| POST | `/auth/logout` | authenticated | optionally releases this phone back to unclaimed; the client signs out of Clerk |
| POST | `/files` | purpose role | streamed upload; see storage contract |
| GET | `/files/:fileId` | file owner/related order or service/ops/super | public metadata |
| GET | `/files/:fileId/download-url` | same as file read | five-minute signed GET |
| POST | `/files/:fileId/attach` | file owner + parent owner/assignee | attach opaque file ID |
| DELETE | `/files/:fileId` | purpose-specific; see Storage API | safe delete lifecycle |
| GET | `/devices` | authenticated | caller's own push registrations |
| POST | `/devices` | authenticated **or** anonymous | register this phone's push token against the caller, or unclaimed when no bearer token is sent |
| POST | `/devices/unregister` | authenticated **or** anonymous | stop push to one of the caller's own phones; an anonymous call may remove only an unclaimed registration |
| POST | `/announcements` | ops/super | one general message to an audience; `everyone` also reaches unclaimed handsets |
| GET | `/notifications` | authenticated | caller's notifications, newest first |
| GET | `/notifications/stream` | authenticated | caller-scoped SSE notification delivery and resume |
| PATCH | `/notifications/:id` | notification owner | set `{read:true|false}` |
| PATCH | `/notifications/read-all` | notification owner | mark caller's list snapshot read |
| DELETE | `/notifications/:id` | notification owner | persistent soft delete from caller's inbox |
| GET | `/settings` | authenticated | versioned service-fee rate, global issue window, delivery bands, and payment QR (`imageUrl` when one is uploaded) |
| PATCH | `/settings` | ops/super | audited compare-and-swap update of any operational setting |
| POST | `/settings/payment-qr` | ops/super | activate a ready `payment_qr` file as the platform receiving plate |
| GET | `/public/payment-qr` | public | current ready payment-QR bytes; `404` if none uploaded |
| GET | `/supplier-payment-terms[?supplierId=]` | supplier own; ops/super any | supplier delivery and pickup payment-plan preferences |
| PATCH | `/supplier-payment-terms` | supplier | update the caller's payment-plan preferences |
| GET | `/credits/balance` | client own; ops/super any `?clientId=` | pilot grant ledger only |
| POST | `/credits/authorize` | authenticated | retired: always `410 payment_route_retired` |
| POST | `/credits/grant` | super | non-cash pilot grant; audited |
| GET | `/users[?role=]` | ops/super | public-user directory |
| GET | `/users/:id` | ops/super | one public user; supplier detail also includes verification documents |
| PATCH | `/users/:id/shop` | owning supplier; ops/super any supplier | replace supplier shop pin; existing orders are unchanged |
| GET | `/users/:id/verification-documents` | owning supplier; ops/super any supplier | private attached verification-document metadata |
| GET, PATCH, DELETE | `/me/payout-account` | supplier | where this shop wants payouts sent: wallet, account name, number, and the receiving-QR file |
| GET | `/users/:id/payout-account` | owning supplier; ops/super any supplier | that shop's payout account with `shopName`, for the release desk |
| PATCH | `/users/:id/role` | super | role change; audited |
| POST | `/users/:id/verification` | ops/super | one-release legacy supplier/rider verification compatibility path |
| GET | `/zones` | authenticated | address-zone records; order creation requires an active zone code, but zone fees are not used for v2 pricing |
| POST | `/zones` | super | create zone |
| PATCH | `/zones/:idOrCode` | super | update zone |
| GET | `/taxonomy` | authenticated | flat taxonomy plus derived `categoryTree` |
| POST | `/taxonomy/categories` | super | create category |
| PATCH | `/taxonomy/categories/:idOrCode` | super | update category |
| POST | `/taxonomy/subcategories` | super | create subcategory |
| PATCH | `/taxonomy/subcategories/:idOrCode` | super | update subcategory |
| POST | `/taxonomy/materials` | super | create material |
| PATCH | `/taxonomy/materials/:idOrCode` | super | update material |
| POST | `/taxonomy/finishes` | super | create finish |
| PATCH | `/taxonomy/finishes/:idOrCode` | super | update finish |
| DELETE | `/taxonomy/categories/:idOrCode` | super | delete an unused, unseeded category (`409 catalog_entry_in_use` / `catalog_entry_shipped` otherwise; see `docs/TAXONOMY_API.md`) |
| DELETE | `/taxonomy/subcategories/:idOrCode` | super | delete an unused, unseeded print job (same refusals) |
| GET | `/supplier-services[?supplierId=&state=]` | supplier own; ops/super any | service catalogue |
| POST | `/supplier-services` | supplier | create `draft` service |
| GET/PATCH | `/supplier-services/:id` | owner supplier; ops/super read, limited edit | service detail/edit |
| POST | `/supplier-services/:id/submit` | owner supplier | request verification |
| POST | `/supplier-services/:id/verify` | ops/super | make service `live`; owner must be approved |
| POST | `/supplier-services/:id/suspend` | ops/super | suspend; reason required |
| POST | `/supplier-services/:id/withdraw` | owner supplier | withdraw from new matching |
| GET | `/orders/:id/eligible-suppliers` | ops/super | explainable approved/live matches |
| GET | `/orders` | role-scoped | caller-visible order list |
| GET | `/orders/:id` | related party/ops/super | role-filtered order detail |
| POST | `/orders` | client | draft/submit order and return estimate range |
| POST | `/orders/:id/transition` | edge-specific role | unchanged QA/production edges below |
| POST | `/orders/:id/decline` | assigned approved supplier | [decline response](#supplier-decline) |
| POST | `/orders/:id/payments/:installment/submit` | owning client | submit QR reference and optional uploaded receipt |
| POST | `/orders/:id/payments/:installment/confirm` | ops/super | manual confirmation |
| POST | `/orders/:id/payments/:installment/reject` | ops/super | reject submitted reference with client-visible reason |
| POST | `/orders/:id/milestones/:code/release` | ops/super | retry an eligible collection-capped supplier payout |
| GET | `/claims` | ops/super | list claims; filters `orderId`, `status` |
| POST | `/claims` | ops/super | raise claim; holds unless `hold:false` |
| GET | `/claims/:id` | ops/super | claim detail |
| POST | `/claims/:id/hold` | ops/super | hold payout; reason required |
| POST | `/claims/:id/release` | ops/super | release hold; reason required |
| GET | `/issues[?orderId=&status=]` | client own/supplier own orders/ops/super | issue list |
| GET | `/issues/:id` | related client/supplier/ops/super | issue detail |
| POST | `/orders/:id/issues` | owning client, within window | issue + automatic payout-hold claim |
| POST | `/orders/:id/confirm` | owning client, within window, no open issue | client confirms the order arrived fine; closes the window now as `completed` |
| GET | `/orders/:id/physical-invoice` | owning client | the paper-invoice request on this order, else `404 physical_invoice_not_found` |
| POST | `/orders/:id/physical-invoice` | owning client | [request a paper invoice](#physical-invoice-request); one per order |
| POST | `/issues/:id/resolve` | ops/super | resolve/dismiss, optionally release claim |
| GET | `/escalations[?status=&orderId=]` | ops/super | pickup escalations |
| POST | `/escalations/:id/resolve` | ops/super | instruction/resolution; rider must recheck |
| GET | `/audit` | ops/super | platform audit with existing filters |
| GET | `/dispatch/offers` | approved rider/ops/super | available/assigned dispatches |
| POST | `/dispatch/:id/accept` | approved rider | assign self to ready dispatch |
| POST | `/dispatch/:id/pickup-checklist` | assigned approved rider | pass or escalate all six checks |
| POST/GET | `/dispatch/:id/location` | POST assigned approved rider; GET related parties/ops/super | [location contract](#rider-location) |
| GET | `/ops/riders/locations` | ops/super | [active rider map](#rider-location) |
| POST | `/dispatch/:id/delivery` | assigned rider | file-backed delivery evidence; opens issue window |
| POST | `/dispatch/:id/proof` | authenticated | retired: always `410 dispatch_proof_route_retired` |
| GET | `/jobs` | approved supplier | only the caller's assigned supplier jobs |

## Clerk identity and role provisioning

Clerk owns sign-up, sign-in, password recovery, Google SSO, sessions, and JWT refresh. The API has no passwords or locally issued sessions. The former `/auth/signup` and `/auth/login` endpoints return `404 not_found`.

The first authenticated activation creates an `individual` client identity, membership, and profile. The same fixed endpoint may add a client membership to an already-mapped non-client identity. Supplier, rider, Operations, and Super Admin access comes only from database memberships. Clerk client-settable metadata is ignored, and supplier/rider approval remains a separate Postgres case. During the one-release compatibility window, a `POST /users/:id/verification` decision also updates the target's matching supplier or rider approval case in the same transaction (legacy `unverified` maps to case `pending`), so fixed projections and legacy work gates report the same approval state. Any `PATCH /users/:id/role` change into supplier or rider — a re-promotion or a direct supplier↔rider switch — re-initializes legacy verification to `unverified` and resets any stale decided approval case of the target kind to `pending`: a demoted then re-promoted supplier or rider re-earns approval, and supplier approval never grants rider approval or vice versa. Every legacy-surface status change on an existing case also increments the case `version`, so a decision holding a pre-change `expectedVersion` loses with `409 approval_case_stale`. Conversely, a canonical case decision requires the applicant to still hold the membership matching the case kind — deciding a case whose user was demoted or switched roles returns `409 approval_case_role_mismatch` and changes nothing — and legacy `verificationStatus` is synced only while the legacy role matches the case kind.

`GET /auth/me` returns the identity plus every membership and approval-case summary. After the JWT maps to a GRIDGO account, the handler loads the Clerk user and refreshes only the person copy: display name from first + last name (else username, else the email local part) and primary email. Shop name, pin, floor phone, and supplier floor contact are not overwritten. A Clerk email that already belongs to another GRIDGO account is left on the previous value rather than merged. A Clerk Backend read failure leaves the stored copy in place so the shop is not signed out. The fixed projections `/auth/me/client`, `/auth/me/supplier`, `/auth/me/rider`, `/auth/me/ops`, and `/auth/me/admin` derive the required membership from the URL alone; request JSON can never select or grant one. A verified but unmapped Clerk subject stays `401 unmapped_identity` so a shop app can open apply. An invalid, expired, or unsigned token stays `401 unauthorized` and must not be treated as a new application. A mapped identity missing the required membership receives `403 supplier_account_not_found` on `/auth/me/supplier` and `403 membership_required` (with `requiredRole`) on the other four projections.

### `POST /webhooks/clerk`

Public. No Bearer token. Body is the raw Clerk webhook payload. Required headers: `svix-id`, `svix-timestamp`, `svix-signature`. Verified with `CLERK_WEBHOOK_SIGNING_SECRET` through `@clerk/backend/webhooks`. A missing secret is `503 webhook_unconfigured`. A bad signature is `400 invalid_webhook`.

Handles `user.updated` and `user.created` with the same person-copy rule as `/auth/me`. An unmapped Clerk user is ignored (`200 { ok: true }`) — accounts are still created only by activate/enroll. `user.deleted` is ignored in this pass. Applying an already-current copy is a no-op.

`PATCH /users/:id/role` refuses to demote the platform's only Super Admin: because administrator bootstrap closes permanently after first use, removing the last `super_admin` would lock role management. The attempt returns `409 last_super_admin`; promote another user to `super_admin` first.

### `POST /auth/clerk/activate`

Auth: `Authorization: Bearer <Clerk session JWT>`. Empty body.

Used once after Google / public SSO. `/auth/me` does not create or email-link accounts.

- Verifies the JWT the same way other Clerk routes do (signature, issuer, expiry). A present `azp` must be on `CLERK_AUTHORIZED_PARTIES`; Expo session tokens that omit `azp` are accepted.
- Loads an unmapped Clerk user with the Backend API.
- A previously mapped Clerk identity idempotently keeps or adds only its `client` membership and personal client profile.
- An unmapped identity creates a client (`clerkUserId`, primary verified email, name, phone if present, and `accountType: "individual"`). Email is not used to merge identities.
- Success is `200 { user }` (`publicUser`; no `clerkUserId`). The same Clerk JWT can immediately call `/auth/me`.
- Unmapped JWT on `/auth/me` remains `401 unauthorized`. Role or status claims and Clerk metadata cannot elevate database memberships or approval cases.

### Fixed enrollment and reapplication

The URL fixes the membership and initial `pending` approval case. Callers cannot send `role`, status, commission, or live service state; unsupported input returns `400 unexpected_field`. All application routes require an `Idempotency-Key` of 1–200 letters, numbers, dots, underscores, colons, or hyphens. The first successful supplier, rider, or business application returns `201`; an exact retry returns the same application identifiers with `200`. A different request for an existing role application returns `409 application_already_exists`. Supplier retries still undergo shape, unexpected-field, and taxonomy-independent field validation before replay lookup; active-category resolution follows replay lookup so an exact retry survives later taxonomy changes.

- `POST /auth/clerk/enroll/supplier` accepts `{profile:{shopName,contactName,phone,location:{lat,lng,label}},serviceCategories:[...]}`. It creates one `draft` service per resolved active category and sets `submittedAt` immediately. An already-mapped identity with any existing memberships may deliberately add the supplier membership to the same identity.
- `POST /auth/clerk/enroll/rider` accepts `{profile:{phone,vehicleType,plateNumber,licenseNumber?}}`. It creates a pending case with `submittedAt: null`; attaching the required current driver's licence records evidence but leaves onboarding incomplete. While the case remains pending and unsubmitted, `/auth/me/rider` returns `onboardingIncomplete: true` so the next sign-in resumes intake. `POST /me/approval-cases/rider/submit` accepts `{expectedVersion}`, rechecks the vehicle type, plate, and current licence, and atomically sets `submittedAt`; exact-key retries replay that success.
- `POST /me/business-application` accepts `{businessName,businessNature}` after ordinary client activation. Personal ordering remains available while business approval is pending, rejected, or suspended.
- `POST /me/approval-cases/:kind/reapply` accepts `{expectedVersion,correctionSummary}`. Only `rejected` may transition to `pending`; success increments both case `version` and `applicationRevision`, clears decision fields, and retains the profile, files, services, and prior immutable events.

Enrollment-specific errors are `400 idempotency_key_required` for a missing key, `400 unexpected_field` for caller-controlled contract fields, `400 invalid_application` with a `fields` map for invalid input, `403 membership_required` when a mapped caller lacks the route's membership, `409 application_already_exists` for enrollment conflicts, and `409 approval_state_conflict` for submit/reapply state, version, or key conflicts. An incomplete or expired rider licence returns `409 rider_documents_incomplete` or `409 document_expired`. Identity provisioning may also return `401 unauthorized`, `409 email_already_registered`, or `502 clerk_unavailable`.

## Approval queue and decisions

`GET /approval-cases` is shared by Operations and Super Admin. `status` defaults to `pending`; `kind` is optional and accepts `business_client`, `supplier`, or `rider`. Results contain only cases with `submittedAt`, sort by `submittedAt` then ID ascending, and return at most 50 rows plus an opaque `nextCursor`. An interrupted rider case with no submission timestamp never appears. `GET /approval-cases/:caseId` returns the applicant identity, case, immutable history, and kind-specific profile data. Supplier detail contains governed service lines and readiness but no commission or deduction field.

Decision bodies are:

```text
// approve
{ "expectedVersion": 1, "requestId": "approval-uuid", "note": "optional" }

// reject or suspend
{ "expectedVersion": 2, "requestId": "approval-uuid", "reason": "required" }

// restore
{ "expectedVersion": 3, "requestId": "approval-uuid", "note": "required" }
```

Each committed decision increments `version` and atomically writes the case, immutable event, audit row, and applicant notification. Replaying the winning `requestId` is idempotent; reusing it for a different case or action returns `409 request_id_conflict`. A different stale/racing decision returns `409 approval_already_decided`; a stale version on an otherwise valid transition returns `409 approval_case_stale`; a case whose applicant no longer holds the matching role membership returns `409 approval_case_role_mismatch`.

Initial supplier approval requires a complete shop/contact/location and at least one complete `pending_verification` service line supported by the current schema. All complete pending lines publish to `live` in the approval transaction; incomplete lines remain pending. Failure returns `409 supplier_profile_incomplete` with `missing`. Supplier suspension records each live line's prior state and makes it `suspended`. Account restore never republishes those lines: Operations must explicitly review each line through `/supplier-services/:id/verify`.

Rider approval and restore through the canonical `/approval-cases/:id/approve|restore` routes require a completed allowed vehicle type and plate, a ready current driver's licence with a future expiry, and non-null `submittedAt` produced by the explicit rider submit endpoint. Attaching licence evidence alone never submits or queues the case. Profile failures return `400 invalid_application`; missing, expired, or unsubmitted evidence returns `409 rider_documents_incomplete`, `409 document_expired`, or `409 approval_state_conflict` respectively.

The one-release Operations queue still decides through `POST /users/:id/verification`. That compatibility path accepts the typed licence number from rider enroll when no licence file has ever been attached, and records `submittedAt` on the decision so the case matches the verification status. A licence file that was later removed still blocks approval.

## Supplier shop and verification profile

### `PATCH /users/:id/shop`

Auth: an authenticated supplier may update only their own user ID. `ops_admin` and `super_admin` may update any supplier. Clients, riders, and a different supplier receive `403 forbidden`.

Request body (replace the complete shop point):

```json
{
  "shop": {
    "lat": 7.0701,
    "lng": 125.6202,
    "label": "New supplier building, Davao City"
  }
}
```

`lat` and `lng` must be JSON numbers, finite, and within `-90..90` and `-180..180`. Numeric strings are rejected. `label` must be a non-empty string after trimming.

Success: `200 { "user": PublicUser }`; the returned `user.shop` is the saved point and `shopUpdatedAt` is set. The change is audited as `user.shop_update`.

Errors:

| Status | `error` | Meaning and fix |
|---:|---|---|
| 400 | `invalid_shop_coordinates` | Send finite numeric latitude/longitude inside Earth bounds. |
| 400 | `shop_label_required` | Add a non-empty address or landmark label. |
| 400 | `shop_requires_supplier` | Operations targeted a non-supplier user; choose a supplier. |
| 403 | `forbidden` | The caller is not Operations/Super Admin and does not own this supplier profile. |
| 404 | `user_not_found` | Refresh users and use an existing supplier ID. |

Moving a shop does **not** rewrite any existing order, including `pickup`, `deliveryDistanceMeters`, `deliveryFeeMinor`, totals, or installment amounts. Those values are order snapshots. This prevents a profile correction from silently changing a price the client accepted. Future supplier assignments snapshot the new shop; an assigned supplier that has not yet accepted/finalized an order still uses the then-current profile when final pricing runs.

### Verification documents on the approval surface

File bytes use `purpose=verification_document` and the upload/attach contract in `docs/STORAGE_API.md`.

`GET /users/:id/verification-documents` is authorized only for that supplier or Operations/Super Admin. Success:

```json
{
  "userId": "user_supplier",
  "verificationDocuments": [
    {
      "fileId": "file_8c9f61e4b2aa",
      "purpose": "verification_document",
      "verificationDocumentType": "valid_id",
      "state": "ready"
    }
  ]
}
```

Each array item is the complete public `File` metadata object; the abbreviated example highlights identifying fields. A supplier cannot request another supplier's list. Clients and riders cannot request any list. All denied calls return `403 {"error":"forbidden","message":"..."}`; a non-supplier target returns `400 verification_documents_require_supplier`; an unknown target returns `404 user_not_found`.

The existing Operations/Super Admin `GET /users/:id` approval response is now `{ "user": PublicUser, "verificationDocuments": File[] }` for a supplier. The same array is returned by `POST /users/:id/verification`, so the decision response remains a complete approval surface. General `PublicUser` values—including `/users`, login, `/auth/me`, matching, and catalogue projections—never contain `verificationDocumentFileIds`.

## Supplier payout account

Payout release is a person in Operations scanning the shop's own receiving QR with a wallet app. This record is that plate plus the words needed to check the right shop is being paid. It is private to the shop and to Operations / Super Admin; it never appears in any client, rider, or public catalogue projection.

### `GET /me/payout-account`

Auth: supplier membership, including a shop still waiting for accreditation. Success: `200 { "payoutAccount": PayoutAccount | null }`.

```json
{
  "payoutAccount": {
    "supplierId": "user_supplier",
    "provider": "gcash",
    "accountName": "Lovis P.",
    "accountNumber": "+639171234567",
    "institution": null,
    "qr": {
      "fileId": "file_8c9f61e4b2aa",
      "originalFilename": "gcash-qr.jpg",
      "detectedContentType": "image/jpeg",
      "size": 184213,
      "readyAt": "2026-09-15T02:10:00.000Z"
    },
    "version": 3,
    "updatedAt": "2026-09-15T02:10:00.000Z"
  }
}
```

`provider` is one of `gcash`, `maya`, `bank`, or `other`. `accountName` is the name the wallet or bank shows back after a scan. `accountNumber` is optional: for `gcash` and `maya` it is normalised to `+639XXXXXXXXX`; for `bank` and `other` it is free text up to 60 characters. `institution` names the bank or wallet for `bank` and `other`. `qr` is `null` until a plate is bound; its bytes come from `GET /files/:fileId/download-url` (authorized for the owning shop and Operations only).

### `PATCH /me/payout-account`

Creates the account on the first write (`201`) and updates it afterwards (`200`). Every write after the first must carry `expectedVersion` (body, `If-Match`, or query) equal to the current `version`; a mismatch is `409 payout_account_stale`. Body fields are all optional on an update; `provider` and `accountName` are required when no account exists yet.

```json
{
  "expectedVersion": 2,
  "provider": "gcash",
  "accountName": "Lovis P.",
  "accountNumber": "0917 123 4567",
  "institution": null,
  "qrFileId": "file_8c9f61e4b2aa"
}
```

`qrFileId` binds a ready `supplier_payout_qr` file the caller uploaded through `POST /files` (`docs/STORAGE_API.md`); the previous plate, if any, is retired to `delete_pending`. `"qrFileId": null` removes the picture and keeps the words. Every field is validated before anything is written, so a refused number or picture leaves no half-applied edit. Audited as `payout_account.create` / `payout_account.update`.

| Status | `error` | Meaning and fix |
|---:|---|---|
| 400 | `invalid_payout_account` | `details.field` names the field: unknown provider, blank account name, a wallet number that is not a Philippine mobile number, or text over its limit. |
| 400 | `invalid_payout_qr` | `qrFileId` is not the caller's own ready `supplier_payout_qr` upload. Upload the plate again and send the new id. |
| 400 | `expected_version_required` | An account exists; send its current `version`. |
| 403 | `forbidden` | The caller has no supplier membership. |
| 404 | `supplier_profile_not_found` | Complete supplier enrollment first. |
| 409 | `payout_account_stale` | The account changed since this screen loaded. Reload and try again. |
| 409 | `file_already_attached` | That file is already bound somewhere. Upload the plate again. |

### `DELETE /me/payout-account`

Requires `expectedVersion` (`If-Match` header or query). Removes the account, retires the bound plate, and answers `200 { "payoutAccount": null }`. Audited as `payout_account.delete`. Deleting an absent account is a no-op `200`.

### `GET /users/:id/payout-account`

Authorized for that supplier or Operations / Super Admin. Success: `200 { "userId": "...", "payoutAccount": PayoutAccount & { "shopName": string } | null }`. A non-supplier target is `400 payout_account_requires_supplier`; an unknown target is `404 user_not_found`.

### On orders

Every order Operations / Super Admin reads carries `supplierPayoutAccount` (the same shape as above with `shopName`, or `null` when the assigned shop has not set one up), so the release desk has the plate beside the milestone it is releasing. The field is absent for every other role.

Changing a payout account raises the `identity` live hint for that shop.

## Push notifications

Push supplements the in-app inbox through FCM HTTP v1 or explicit native APNs registrations. The inbox remains the source of truth when notifications are denied, a token is stale, or a device is offline. Silent acknowledgements and delivery/retry guarantees are defined in [Realtime events](REALTIME_EVENTS.md#delivery-durability-and-scope).

Firebase project: **`gridgo-c2ce9`**. FCM apps need its `google-services.json` / `GoogleService-Info.plist`; sending credentials stay server-side. Provider configuration and health are in [Deployment](DEPLOYMENT.md#2-required-environment-and-secret-files). Registration routes remain usable without configured providers.

### Device registration model

- A registration accepts `{ token, platform, appRole?, tokenProvider? }`. `platform` is `android`, `ios`, or `web`. `tokenProvider` defaults to `fcm` on every platform, including existing iOS registrations. Native APNs requires explicit `tokenProvider: "apns"` and `platform: "ios"`; its device token is 64 hexadecimal characters. Authenticated registration validates provider/platform but APNs token shape is checked at delivery.
- Optional `appRole` must be a held membership. It scopes claimed-device delivery to notifications currently visible in that app role; omitting it retains combined-account delivery. Send it on each authenticated re-registration, because omission clears the previous app role. Anonymous registration does not accept an app-role discriminator.
- **A registration is either claimed or unclaimed.** A claimed registration belongs to one account. An *unclaimed* one belongs to nobody: a phone that installed the app and never signed in, or one whose owner signed out. Unclaimed registrations exist so an app-update announcement reaches every install — see *Reaching a phone that has never signed in*.
- **A token belongs to exactly one user.** Registering a token that is already registered to somebody else moves it to the caller and removes the previous owner's claim, which is what a shared handset or a sign-out/sign-in on the same phone produces. Without that move, one person's orders would appear on another person's lock screen.
- **One user may hold many devices.** Each eligible device can receive a notification; one dead device never suppresses the others.
- Re-registering the same token under the same account updates the existing record instead of adding a second one. Apps should re-register on every launch and on every provider token refresh; it is idempotent and cheap.
- The server deletes a registration when the provider identifies a dead or invalid token. An app that finds itself receiving nothing should simply register again.
- **Registrations are strictly caller-owned.** Ownership is established exactly as it is for `/notifications` — from the bearer token. There is no operations override and no route through which one account can read, move, or delete another account's registrations.
- **A registration is bound to the account, not to its login address.** The stored record holds `userId`; it never holds an email. Changing an account's Clerk sign-in address leaves the phone registered to the same person, and apps do not need to re-register afterward.

### `POST /devices`

```json
{ "token": "fcm-registration-token-from-firebase", "platform": "android" }
```

`201` when this token was not registered anywhere, `200` when an existing registration was updated or moved:

```json
{
  "device": {
    "id": "dev_9f2c41a7c8d3",
    "userId": "user_client",
    "platform": "android",
    "appRole": null,
    "tokenProvider": "fcm",
    "tokenTail": "a7c8d3f1",
    "createdAt": "2026-08-11T02:00:00.000Z",
    "updatedAt": "2026-08-11T02:00:00.000Z"
  },
  "created": true,
  "reassigned": false
}
```

`reassigned` is `true` when the token was taken from another account. **The raw token is never returned** by any route; `tokenTail` is its last eight characters, enough to identify a registration in a list or a support conversation.

Registering a token that is currently **unclaimed** claims it for the caller: the same row, now owned, and `reassigned` is `false` because nobody lost a phone.

| Status | Error | Cause |
|---|---|---|
| `400` | `device_token_required` | `token` missing, empty, or not a string |
| `400` | `device_token_too_long` | `token` longer than 4096 characters |
| `400` | `invalid_token_provider` | unsupported provider, or APNs with a non-iOS platform |
| `403` | `forbidden` | authenticated `appRole` is unknown or not a held membership |
| `400` | `invalid_device_platform` | `platform` is not `android`, `ios`, or `web`; the response repeats `allowed` |
| `401` | `unauthorized` | the request carried a bearer token that is expired or unknown |

### `GET /devices`

```json
{ "devices": [ { "id": "dev_9f2c41a7c8d3", "userId": "user_client", "platform": "android", "appRole": null, "tokenProvider": "fcm", "tokenTail": "a7c8d3f1", "createdAt": "…", "updatedAt": "…" } ] }
```

Only the caller's own registrations, always — and never an unclaimed one, which belongs to nobody and is therefore nobody's to list. An account with none receives `{"devices": []}`. There is no route, for any role, that lists or counts unclaimed registrations.

### `POST /devices/unregister`

```json
{ "token": "fcm-registration-token-from-firebase" }
```

Returns `200 {"id": "dev_9f2c41a7c8d3", "unregistered": true}`.

| Status | Error | Cause |
|---|---|---|
| `400` | `device_token_required` | `token` missing or empty |
| `404` | `device_token_not_found` | the token is not registered **to the caller** |
| `401` | `unauthorized` | the request carried a bearer token that is expired or unknown |

A token registered to a *different* account also returns `404`, not `403`. Unlike an opaque server-minted notification ID, a device token is a value a caller can supply, so a distinguishable refusal would answer "is this token registered to somebody else?" for anyone who asked. Nothing is changed either way.

Called with **no** `Authorization` header, this route removes an unclaimed registration and answers `200 {"ok": true}` — see below.

### Signing in and signing out

Clerk owns sign-in. After Clerk returns a session, the app calls authenticated `POST /devices`; that path registers and claims the installation in one idempotent operation.

`POST /auth/logout` accepts an optional device token and **releases** it in the same call:

```json
{ "deviceToken": "fcm-registration-token-from-firebase" }
```

```json
{ "ok": true, "deviceUnregistered": true, "deviceUnclaimed": true }
```

**Call this before ending the Clerk session.** After Clerk signs out, the phone can no longer authenticate the release and would otherwise keep receiving the previous user's notifications.

The registration is **released, not deleted**: the row survives holding no identity, so the handset stays on the app-update channel while continuing to receive nothing personal. `deviceUnregistered` keeps its published meaning — this phone no longer receives the caller's notifications — and `deviceUnclaimed` describes the same release. Both are `false` when no token was sent or when the token belongs to another account; the body is still `200`. Sending no body remains valid. The API does not revoke or mint Clerk sessions.

### Reaching a phone that has never signed in

An "update your app" notice has to reach every install, including the ones whose owner never got as far as an account — they are the most likely to be stuck on a broken build. So `POST /devices` accepts a call with **no** `Authorization` header and stores an *unclaimed* registration.

```
POST /devices          (no Authorization header)
{ "token": "fcm-registration-token-from-firebase", "platform": "android" }
```

```json
{ "ok": true }
```

**That body is fixed.** It is the same whether the token was new, already registered unclaimed, or belongs to a signed-in account, and it carries no id, no `created`, and no count. The caller supplies the token, so any variation would answer "is this token registered, and to whom?" for anyone who asked.

| Status | Error | Cause |
|---|---|---|
| `400` | `device_token_required` | `token` missing or empty |
| `400` | `invalid_device_token` | FCM token is not 64–4096 characters of `A–Z a–z 0–9 _ : . -`, or explicit APNs token is not 64 hexadecimal characters |
| `400` | `invalid_token_provider` | unsupported provider, or APNs with a non-iOS platform |
| `400` | `invalid_device_platform` | `platform` is not `android`, `ios`, or `web`; the response repeats `allowed` |

What apps can rely on:

- **Register on first launch, before any sign-in**, and re-register on every launch and token refresh. Re-registration updates the one row; it never creates a second.
- **A claimed registration is never changed by an anonymous call.** If the token already belongs to an account, the call is a no-op — it cannot move, re-platform, or silence somebody's phone. The owner's own app re-registers with its bearer token, and a genuine sign-out releases the row itself.
- **`POST /devices/unregister` with no `Authorization` header** removes an unclaimed registration and answers `200 {"ok": true}`. A *claimed* registration is left alone and answers identically; removing one still requires its owner's bearer token.
- **The unclaimed pool is bounded.** Past the pilot ceiling (5,000; `GRIDGO_MAX_UNCLAIMED_DEVICES`) the least recently seen unclaimed registrations are evicted to make room. Claimed registrations are never evicted, and a phone evicted while idle re-registers on its next launch. Registration is not refused at the ceiling: a refusal would let one script close the app-update channel to every genuine new install until an operator intervened.

**What an unclaimed handset may receive — the hard rule.** An unclaimed registration is an anonymous phone; nothing proves who is holding it. It may only ever be sent a general announcement: never an order, a payout, a claim, an issue, a name, an amount, or anything else tied to a person. This is enforced in the delivery path — the delivery router refuses any batch containing an unclaimed device unless the message carries `data` of exactly `{"type": "announcement"}` — not by convention at the call sites.

### What a push looks like

Example FCM v1 message for an eligible device:

```json
{
  "message": {
    "token": "<one device token>",
    "notification": {
      "title": "GRIDGO update",
      "body": "Open GRIDGO for the latest update."
    },
    "data": {
      "notificationId": "ntf_9c1f3a",
      "type": "supplier_assignment_final_price",
      "orderId": "ord_demo_1",
      "at": "2026-08-11T02:00:00.000Z"
    },
    "android": { "priority": "high", "notification": { "channel_id": "gridgo_default" } },
    "apns": { "headers": { "apns-priority": "10" }, "payload": { "aps": { "sound": "default" } } }
  }
}
```

- Domain push copy follows the privacy policy in [Realtime events](REALTIME_EVENTS.md#delivery-durability-and-scope); fetch the inbox for the detailed message. Announcements retain their public broadcast copy.
- `data` values are always strings, and the keys are exactly `notificationId`, `type`, `orderId`, `at`. Keys with no value are omitted — a notification with no order carries no `orderId`. Route on `type` and `orderId`; fetch the order and re-read `GET /notifications` after opening, because the push carries no order state.
- **Android apps must create the notification channel `gridgo_default`** before requesting a token. A message naming a channel the app has not created is downgraded or dropped on Android 8+.
- **`shop_production_inactive` and `ops_production_inactive` are the only types that name a different channel and sound.** Their FCM `android.notification.channel_id` is `gridgo_production_nudge` and their APNs `aps.sound` is `notification_alert.mp3`. The supplier app creates that channel and bundles the file. Every other type, including `shop_job_may_start`, stays on `gridgo_default` with `aps.sound: "default"`. Client and rider apps do not create the production channel. Lock-screen title and body stay the generic domain copy above; the detailed shop sentences live in the inbox.
- `type` is the same discriminator as on the notification record: `supplier_assignment_final_price`, `pickup_check_escalation`, `pickup_escalation_resolved`, and any later value. Treat unknown types as "open the notification list".

**No money reaches a device.** The `data` map is an allowlist, not a redaction pass: nothing outside those four keys is ever sent, so supplier settlement, payout milestone amounts, service-fee amounts, and every other money field stay off the lock screen even if a future notification record carries them. Domain title/body copy is also generic under the realtime privacy policy.

Native APNs sends the same allowed data fields at the payload root alongside `aps.alert` and `aps.sound: "default"`. It does not include the optional announcement image.

### Failure behaviour apps can rely on

- A failed push never fails the action that caused it. If a payout releases and FCM is unreachable, the payout still happened, the notification record still exists, and `GET /notifications` still returns it.
- A dead token is pruned, a transient provider failure is not. A phone that is merely offline or unreachable keeps its registration.
- There is no delivery receipt and no read receipt. `read` is set only through `PATCH /notifications/:id` or `PATCH /notifications/read-all`; a push does not mark anything read.

## Platform announcements

One general message to a whole audience, from Operations. `everyone` is the app-update channel.

### `POST /announcements`

Authorization: `ops_admin` or `super_admin`.

```json
{ "audience": "everyone", "title": "Update your app", "body": "GRIDGO 1.4 is available in the store.", "imageUrl": "https://cdn.example/update.png" }
```

`imageUrl` is optional. It is either an `http(s)` picture link, or a hosted path `/public/announcement-images/<fileId>` returned after `POST /files` with `purpose=announcement_image` (JPEG/PNG/WebP, 1 MiB). The picture is stored on each notification record, shown in-app, and included in the FCM payload as an absolute URL the **handset** downloads. Hosted paths are joined to `GRIDGO_PUBLIC_API_ORIGIN`, or locally to the http `MINIO_PUBLIC_URL` host on this process's port.

`GET /public/announcement-images/:fileId` is unauthenticated and streams a ready `announcement_image` so FCM and the apps can load it without a signed MinIO URL.

`201`:

```json
{
  "announcement": {
    "id": "anc_4f21c9d0a8b7",
    "audience": "everyone",
    "title": "Update your app",
    "body": "GRIDGO 1.4 is available in the store.",
    "imageUrl": "https://cdn.example/update.png",
    "at": "2026-08-11T02:00:00.000Z",
    "notifiedUsers": 6,
    "unclaimedDevices": 3
  }
}
```

Every targeted account gets one notification record (`type: "announcement"`, `orderId: null`, plus the `announcementId` that groups them). Audience selection uses current memberships, including secondary roles; reading and delivery follow the notification visibility and device app-role rules below.

**Which audiences reach unclaimed devices:**

| `audience` | Accounts notified | Unclaimed handsets |
|---|---|---|
| `everyone` | every account | **yes** — this is the only audience that reaches them |
| `clients` | role `client` | no |
| `suppliers` | role `supplier` | no |
| `riders` | role `rider` | no |
| `ops` | roles `ops_admin`, `super_admin` | no |

A role-targeted announcement **cannot** reach an unclaimed handset, and this is not a setting: an unclaimed registration has no role, and guessing one would put a print-shop message on a rider's lock screen. If a message must reach phones that have never signed in, it has to be true and safe for anyone holding any phone — which is what `everyone` means.

Write `everyone` announcements accordingly: the same words land on handsets nobody has signed in on, so nothing order-, money- or person-specific belongs in one. The audience rule is enforced; the wording is Operations' judgement.

| Status | Error | Cause |
|---|---|---|
| `400` | `invalid_announcement_audience` | `audience` is not one of the five above; the response repeats `allowed` |
| `400` | `invalid_announcement_title` | `title` empty or longer than 120 characters |
| `400` | `invalid_announcement_body` | `body` empty or longer than 500 characters |
| `400` | `invalid_announcement_image` | `imageUrl` is not an http(s) link or a hosted `/public/announcement-images/<fileId>` path |
| `403` | `forbidden` | the caller is not ops or super |

Every announcement is written to the platform audit log (`announcement.broadcast`) with its audience, title, and both counts.

## Production files and installment receipts

Order reads include `productionItems` for the owning client, Operations, and assigned supplier/rider. Each item exposes `id`, `itemName`, `quantity`, `pricingUnit`, `packageQty`, `structuredSpec` (size/material/finish), selected `options` (`groupName`, `label`), `artworkFileId`, and `mockupFileId`. Supplier/rider items follow assigned job IDs; legacy primary-party fallback applies only when no jobs exist. Prices and payment receipts are excluded. `measurement` is null or contains whole `pages`, and/or `widthMilli`, `heightMilli`, `lengthMilli` in thousandths of its `unit`. New snapshots preserve the listing unit; historical snapshots without it return null rather than guessing from a changed listing.

`POST /orders/:id/payments/:installment/submit` accepts `{method:"qr_manual",reference,proofFileId?}`. Canonical installment keys are `initial` and `final_online`; route aliases `downpayment` and `balance` remain supported. When supplied, `proofFileId` must identify the caller's ready `payment_proof` upload. Submission atomically binds that receipt to the order and installment, and changes payment status to `pending_confirmation`. Reference-only legacy submissions remain accepted. Receipt metadata and signed downloads are private to the owner and Operations; supplier/rider order reads omit receipt IDs. Rejection clears the installment's active receipt while retaining its private reference for review history. Receipt OCR never confirms payment: only Operations confirmation clears the existing handover/collection gate.

## Notifications

Notification IDs are opaque. Every notification route is owner-only: an authenticated caller receives only records whose `userId` is their own user ID. A known notification owned by another user returns `403 {"error":"forbidden"}`; an unknown notification returns `404 {"error":"notification_not_found"}`. Deleted notifications are omitted from all later lists. Current membership, approval, assignment, and audience visibility also apply to list/replay and individual mutations; an owned but no-longer-visible row returns `403 forbidden` on mutation.

`GET /notifications`, `GET /notifications/stream`, and `PATCH /notifications/read-all` accept optional `?role=` using the membership roles above. This overrides `X-GRIDGO-Role` for these three routes; an unknown/nonmember role returns `403 forbidden`. With neither selector, the inbox combines currently visible owned rows. Pending applicants can read their own approval decisions. Super-only users retain historical Operations-tagged rows; dual Operations/Super Admin users see each role's own copy when selecting that role. Use the same selector for list, stream, and mark-all.

### `GET /notifications`

Returns the caller's currently visible, non-deleted notifications, newest first, plus an append-order snapshot watermark. `limit` (default 40, max 100) bounds the window; the inbox is not the full history. A notification about a job the caller can see carries `orderTitle` and `orderState` as current order context. Known unambiguous client lifecycle types also carry `eventState` for the historical event rail; omitted values must not be inferred from the current state. Stored title/body/type remain historical. Client-owned rows can additionally carry `paymentAction: {installment:"final_online",status:"due"|"pending_confirmation",amountMinor}` from current order data, from production through delivery/collection while the initial payment is confirmed and a positive final installment remains outstanding. This applies equally to old inbox rows and SSE without rewriting history or creating duplicate notifications.

```json
{
  "notifications": [
    {
      "id": "ntf_123",
      "userId": "user_client",
      "orderId": "ord_1",
      "orderTitle": "Grand opening tarpaulin",
      "orderState": "production",
      "title": "Final price ready",
      "body": "Review your order.",
      "read": false,
      "at": "2026-08-11T02:00:00.000Z"
    }
  ],
  "snapshot": "ntf_123"
}
```

`snapshot` is `null` when the caller has never had a notification. Clients must retain the non-null snapshot returned with the list and echo it to mark-all; it is not a notification timestamp. The snapshot is still the caller's last append, including a soft-deleted watermark, even when `limit` hides older rows.

### `GET /notifications/stream`

A stream stays open for at most `NOTIFICATION_STREAM_MAX_MS` (default ten minutes) after the bearer was verified, heartbeating every `NOTIFICATION_HEARTBEAT_MS`; it no longer ends when the short-lived session token expires, because every frame is re-authorized against the committed store. Reconnect with a fresh token and `Last-Event-ID` to resume.

Opens a caller-scoped Server-Sent Events stream using the same bearer token as other authenticated routes. The response uses `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, and a five-second reconnect hint. Banner-eligible notifications are sent only to their currently authorized owner. Silent inbox rows are fetched through the list, not streamed as banners, including during replay. The `data` object is the same public inbox row as `GET /notifications` (including `orderTitle` / `orderState` when the row names an order — never the hydrated order):

```text
id: ntf_124
event: notification
data: {"id":"ntf_124","userId":"user_client","title":"Final price ready","body":"Review your order.","read":false,"at":"2026-08-11T02:01:00.000Z","orderTitle":"Grand opening tarpaulin","orderState":"production"}

```

After a mutation commits, the same stream may also send a silent refetch ping. It has no `id:` field and is not replayed from `Last-Event-ID`:

```text
event: invalidate
data: {"resource":"orders","id":"ord_1"}

```

Resource names and ID meanings are defined in [Realtime events](REALTIME_EVENTS.md#invalidate-payload). The payload never contains a collection. Refetch all active resources on foreground/reconnection; notification replay cannot recover missed invalidations.

The server sends a comment heartbeat every 25 seconds (`: heartbeat <ISO timestamp>`) and closes the stream at a heartbeat when the verified JWT has expired. Refresh the Clerk token before reconnecting. The subscription and timer are removed when either side closes.

For initial synchronization, call `GET /notifications`, render that response, then open the stream with its non-null `snapshot` as the `Last-Event-ID` header. The server replays currently visible, banner-eligible notifications appended after that ID before continuing live delivery. Native SSE reconnection sends the most recently received event ID automatically. Refetch the inbox and active resources on reconnect to recover silent updates. With no `Last-Event-ID` (including when the list snapshot is `null`), the stream replays the caller's currently visible, banner-eligible inbox rows before continuing live; clients should de-duplicate those IDs against the rendered list. An unknown cursor returns `409 {"error":"notification_resume_unavailable"}` (discard the cursor, refresh the list and active resources, then reconnect); a cursor owned by another user returns `403 {"error":"forbidden"}` and no stream opens.

### `PATCH /notifications/:id`

Set one notification read or unread. Unread is deliberately supported so an accidental mark can be reversed.

```json
{ "read": true }
```

Returns `200 {"notification": {...}}`. `read` must be a JSON boolean; missing or non-boolean values return `400 {"error":"notification_read_required"}`. A notification already deleted by its owner returns `404 notification_not_found`.

### `PATCH /notifications/read-all`

Mark every currently visible, non-deleted notification in the selected role context that existed in a prior list snapshot:

```json
{ "snapshot": "ntf_123" }
```

Returns `200 {"updatedCount":2}`. A missing/empty snapshot returns `400 {"error":"notification_snapshot_required"}`. Unknown and foreign snapshot IDs use the same `404`/`403` errors above. The server uses append order through that ID, not wall-clock timestamps, so notifications appended after the list response remain unread even if the mark-all request races with delivery.

### `DELETE /notifications/:id`

Returns `200 {"id":"ntf_123","deletedAt":"2026-08-11T02:05:00.000Z"}`. Retrying the same owner delete returns the same response. Deletion is a durable soft delete: the record remains as internal lifecycle evidence (assignment notifications gate payment), but it never appears in `GET /notifications` again. This makes swipe-to-delete persistent without breaking order invariants.

## Settings and distance fee

Default `GET /settings` response:

```json
{
  "version": 4,
  "settings": {
    "serviceFeeRateBps": 1000,
    "riderCommissionBps": 8500,
    "issueWindowHours": 24,
    "productionNudge": {
      "enabled": true,
      "afterValue": 4,
      "afterUnit": "hours",
      "repeatValue": 4,
      "repeatUnit": "hours",
      "maxCount": 3
    },
    "deliveryFeeBands": [
      { "maxDistanceMeters": 4999, "feeMinor": 2500 },
      { "maxDistanceMeters": 10000, "feeMinor": 5000 },
      { "maxDistanceMeters": null, "feeMinor": 7500 }
    ],
    "paymentQr": { "method": "qr_manual", "caption": "QR Ph" }
  }
}
```

`paymentQr` describes the single supported manual QR checkout method. `method` and `caption` stay `qr_manual` / `QR Ph`. When Operations has activated a plate, `imageUrl` is the cache-busted public path `/public/payment-qr?v=<fileId>` (API-root relative). Omit `imageUrl` when none is uploaded — clients then use their bundled fallback. Do not advertise another payment method.

Upload is two steps, both `ops_admin` / `super_admin`:

1. `POST /files` with `purpose=payment_qr` and a JPEG, PNG, or WebP (up to 5 MiB). Not attachable to an order (`400 payment_qr_not_attachable`).
2. `POST /settings/payment-qr` `{ "fileId": "file_…", "reason": "…" }` activates that ready file as the platform QR, retires the previous one, and is audited. Repeating the same `fileId` is a no-op.

```http
GET /public/payment-qr
```

Unauthenticated. Streams the current ready plate so checkout and the ops preview do not depend on a signed MinIO URL. `404 {"error":"payment_qr_not_found"}` when none is active. `GET /public/payment-qr.jpg` is the same resource.

These band figures are provisional Firstmate values, not captain-specified prices. Operations/Super Admin can change them without a release:

```http
PATCH /settings
```

```json
{
  "expectedVersion": 4,
  "serviceFeeRateBps": 1000,
  "issueWindowHours": 48,
  "deliveryFeeBands": [
    { "maxDistanceMeters": 4999, "feeMinor": 3000 },
    { "maxDistanceMeters": 10000, "feeMinor": 6000 },
    { "maxDistanceMeters": null, "feeMinor": 9000 }
  ],
  "reason": "Pilot pricing update"
}
```

The patch is an audited compare-and-swap: `expectedVersion` must match `GET /settings`, `reason` is mandatory, and success increments `version`. `serviceFeeRateBps` and `riderCommissionBps` are actual JSON integers from 0 through 10,000; `issueWindowHours` is an actual JSON integer from 1 through 720. Each `feeMinor` and finite band maximum must also be a JSON safe integer, band maxima increase strictly, and the final maximum is `null`. Numeric strings are rejected rather than coerced. Settings changes affect only future commercial commitments.

`productionNudge` is the live cadence for a shop that has not made the next production move. Desk (Operational settings, both `/ops/settings` and `/admin/settings`) edits one object on this same route:

| Field | Rule |
|---|---|
| `enabled` | JSON boolean. `false` writes no new reminders; existing inbox rows stay. |
| `afterValue` + `afterUnit` | First reminder. Unit is `"hours"` (1–720) or `"days"` (1–30). |
| `repeatValue` + `repeatUnit` | Each later reminder. Units may differ from the first wait. Same bounds. |
| `maxCount` | Whole number 1–10, including the first reminder. The last one also writes `ops_production_inactive` for each Operations and Super Admin membership. |

The stored object keeps value and unit. The sweep converts days to hours (`value * 24`) when it reads. A later change does not rewrite occurrence keys or old inbox rows; the next tick uses the new policy. Omitted on PATCH, the previous object is kept. Absent on an older row, GET returns the defaults above.

Desk fields, in order: an Enabled toggle; “First reminder after” (number and Hours/Days); “Then remind every” (number and Hours/Days); “Stop after” (1–10, caption “Including the first reminder.”); and “In force right now”, one sentence from the saved object. A shop cannot set this.

Supplier payment timing preferences use `GET|PATCH /supplier-payment-terms`. `GET` returns the caller's terms to a supplier; Operations/Super Admin may select a supplier with `?supplierId=`. Supplier-only `PATCH` accepts any subset of `deliveryDownpaymentRateBps`, `pickupFullOnlineEnabled`, `pickupDownpaymentStoreEnabled`, and `pickupDownpaymentRateBps`, and returns `{ "terms": SupplierPaymentTerms }`. Delivery accepts `deliveryDownpaymentRateBps: 0|2500|5000`. Pickup full-online is independently enabled; pickup downpayment-at-store requires a rate of `2500|5000`, while disabling that mode clears its rate to `null`. When the supplier profile enables pickup, at least one pickup mode must remain enabled. Accepted quotes snapshot these terms.

## Client ready-time promises

Every public cart line includes `promiseBy: string | null`, including `GET /me/carts/:id` and compact line-mutation responses. The string is an ISO 8601 UTC timestamp, for example `"2026-09-28T06:00:00.000Z"`. It is the projected client ready time for that listing and quantity at request time, including active work already queued at the shop, the listing's effective turnaround (inherited or overridden), daily capacity, the shop's working hours and closures, and GRIDGO's promise allowance. It is `null` when the listing/shop is unavailable or its calendar cannot produce a projection. Clients should show an unavailable estimate for `null`, rather than deriving a ready time from raw turnaround hours.

Matching, cart previews, and checkout share `projectShopFinish` in `src/order-match.js`. For the same listing, quantity, queue, calendar, settings, and instant, they produce the same `promiseBy`. Matching initially uses the fastest eligible listing for the requested subcategory before the client configures quantity; selecting a slower listing or a capacity-limited quantity can move the preview later. Each cart line is projected individually; checkout uses the basket's maximum turnaround and total quantity for its shop job.

Cart promises are live estimates, not reservations: elapsed time or changes to the shop's queue/calendar can move them. Checkout recomputes before adding its own job to the queue and snapshots `orders.promiseBy`; subsequent cart refreshes do not change that saved promise. The checkout response exposes this client promise as `order.readyBy`. The separate stored `orders.readyBy` is the shop's unpadded deadline and must not be exposed to the client. See [Client order match API](ORDER_MATCH_API.md) for the full match/cart contract.

## Price estimate and exact money

At `POST /orders`, `priceRange` is a client-safe supplier-subtotal estimate:

```json
{
  "priceRange": {
    "supplierSubtotalMinMinor": 45000,
    "supplierSubtotalMaxMinor": 50000,
    "serviceFeeStatus": "calculated_at_quote_acceptance",
    "deliveryFeeStatus": "pending_supplier_assignment"
  }
}
```

It is derived from current product and live-service reference prices. No supplier or delivery point is selected yet, so delivery is pending. It is an estimate, not an authorization.

Order creation validates its inputs before drafting anything: `quantity` must be a positive integer (omitted means `1`) or the request is `400 invalid_quantity`, and `zone` must be an active zone code from `GET /zones` (omitted means `davao_central`) or the request is `400 invalid_zone`. When the reference catalog has not been seeded, creation fails with `409 catalog_not_seeded` instead of estimating from missing data.

The assigned approved supplier issues a versioned final quote:

```http
POST /orders/:id/transition
```

```json
{
  "state": "supplier_accepted",
  "supplierSubtotalMinor": 100000,
  "promisedDate": "2026-08-12T09:00:00.000Z"
}
```

The response state is `awaiting_checkout`. The versioned quote captures line/specification/format choices, the supplier shop, promised date, and payment terms; it is not yet commercial history.

The assigned supplier may supersede a pending quote, or a client-accepted commitment whose payments are all still `not_submitted`, by issuing `supplier_accepted` again with a non-empty `reason`. The API archives the prior quote, audits `order.quote_superseded`, clears the prior commercial snapshot and payment plan, increments the quote version, and returns to `awaiting_checkout`. Once any payment submission or authorization has started, supersession returns `409 payment_authorization_started`.

The owning client accepts the exact version and selects one offered fulfillment/payment plan:

```json
{
  "state": "awaiting_initial_payment",
  "quoteVersion": 1,
  "fulfillmentMode": "delivery",
  "paymentPlan": "delivery_online"
}
```

Acceptance snapshots the service-fee setting and every money/fulfillment field, creates generalized payments and component allocations, and returns `awaiting_initial_payment`. A mismatched version is `409 quote_stale`.

Task G defines and validates both pickup financial shapes, but pickup commercial commitment remains contained until Task H owns handover. Selecting either pickup plan currently returns `409 pickup_fulfillment_not_available`; it does not create a payable pickup order or expose that order to rider dispatch.

### Rider delivery split

`riderCommissionBps` means **the share the rider keeps**, default `8500` (85% rider, 15% GRIDGO). Operations and Super Admin edit it through `PATCH /settings`, e.g. `{ "expectedVersion": 4, "riderCommissionBps": 8500, "reason": "Delivery split update" }`. Other roles receive `403 forbidden`. Null, strings, fractional and out-of-range values return `400 invalid_rider_commission_rate` with `field: "riderCommissionBps"`; stale versions return `409 settings_version_conflict`. Omitting the field keeps the current setting. The change is audited with previous/current settings.

Quote acceptance and cart checkout snapshot the setting when the delivery fee is set. Each order and its checkout job store the rate; later settings, assignment, or state changes do not reprice it. Migration `1786978800000` preserves all pre-existing orders/jobs at `10000` (their original full rider pass-through), while seeding `8500` for new commitments. A permitted quote supersession creates a new commercial commitment with the then-current rate. Zero-fee pickup jobs have zero rider payout and zero GRIDGO delivery share.

The following top-level fields are on rider and Operations/Super Admin order projections, including `GET /dispatch/offers` (`offers[]`), dispatch mutation responses (`order`), and `GET /orders` / `GET /orders/:id`. The rider app should sum `riderPayoutMinor` for its completed-delivery earnings view; `deliveryFeeMinor` remains the gross client charge. These amounts describe entitlement, not a recorded bank transfer; this contract adds no rider withdrawal or payout-release endpoint.

| Field | Meaning | Example (minor units) |
|---|---|---:|
| `deliveryFeeMinor` | Gross delivery fee charged to client | 2500 |
| `riderCommissionBps` | Immutable rider share rate | 8500 |
| `riderPayoutMinor` | `floor((deliveryFeeMinor * riderCommissionBps + 5000) / 10000)` | 2125 |
| `platformDeliveryShareMinor` | `deliveryFeeMinor - riderPayoutMinor` | 375 |

Rider rounding is half-up; GRIDGO gets the exact remainder. For a fee of `10` minor units at `8500` bps, the rider receives `9` and GRIDGO `1`. PostgreSQL generated `BIGINT` columns compute the same split with exact numeric arithmetic, and database triggers protect the rate snapshots. Client and supplier projections omit the three internal split fields. Client totals and invoices continue to show the gross delivery charge.

Ops order/finance projections additionally include `deliverySettlement`: the four fields above plus `collectedMinor` (confirmed gross delivery collections), `riderCollectedMinor`, and `platformCollectedMinor`. Collection is summed across confirmed payment allocations before applying the snapshot rate and half-up rounding, so installment rounding never adds an extra centavo. `platformRevenue.billedMinor` now includes service fee plus GRIDGO's delivery share; `collectedMinor` includes confirmed service-fee allocations plus the collected GRIDGO delivery share. `recognizedMinor` follows the existing delivered-state and adjustment/refund rules on this combined amount. Supplier principal, collection caps, and payout milestones are unchanged.

The persisted payment allocation component `delivery_pass_through` remains the compatibility name for **gross delivery collection**, including both shares. It is not rider earnings. Keeping that collection shape preserves payment-sum and supplier-principal SQL invariants; ownership is represented by the separate order/job split columns.

### Worked example

| Field | Minor units | Peso meaning | Client receives field? |
|---|---:|---:|---|
| `subtotalMinor` | 100000 | ₱1,000 items subtotal | yes |
| `serviceFeeRateBps` | 1000 | 10% | yes |
| `serviceFeeMinor` | 10000 | ₱100 | yes |
| `deliveryFeeMinor` | 2500 | ₱25 | yes |
| `totalMinor` | 112500 | ₱1,125 | yes |
| initial online (25% supplier principal + fee) | 35000 | ₱350 | yes |
| final online (supplier remainder + delivery) | 77500 | ₱775 | yes |

`round_bps(x,bps) = floor((x*bps+5000)/10000)`. Application calculations use `BigInt`, PostgreSQL constraints recompute the formula with exact `numeric`, and the HTTP boundary rejects results outside the JavaScript safe-integer range. The service fee and initial supplier principal are rounded independently; the supplier remainder is subtraction, so it receives every principal-rounding cent. Delivery never enters the fee base, and the full service fee is allocated to the initial payment.

For the rounding vector `supplierSubtotalMinor = 99999`, a 1,000-bps service fee is `10000` and a 2,500-bps initial supplier principal is `25000`; the supplier remainder is therefore `74999`. With the `2500` delivery fee, the initial online installment is `35000`, the final online installment is `77499`, and the client total is `112499`.

### Visibility authorization

- Client: items subtotal, service fee, delivery, total, accepted plan/installments, its submitted references, and payout milestone codes/status; never platform supplier-payout amounts.
- Assigned supplier: its full supplier subtotal, zero-deduction settlement card, and milestone amounts; never client payment references. For pickup-at-store plans, the card reports the amount due separately and keeps received-at-store at zero until a later lifecycle owns an explicit receipt signal.
- Rider: client-safe order totals and the snapshotted delivery split above; no supplier payout, allocation, milestone, or client-reference details.
- Operations/Super Admin: full client totals, allocations, supplier settlement, combined service-fee/delivery-share revenue fields, and milestone amounts.

All order-returning endpoints use this projection.

`physicalInvoiceRequest` is read only by the owning client and by Operations/Super Admin. Suppliers and riders never receive it: nobody prints or carries the paper copy, so the client's office contact is not theirs to have.

Operations revenue cards expose `billedMinor`, `collectedMinor`, `recognizedMinor`, `adjustedMinor`, and `refundedMinor` separately. Adjustment and refund values retain their signed stored amounts; both contribute to recognized revenue only after fulfilment.

## Digital payment plans and allocations

Canonical installment codes are `initial` and optional `final_online`. The legacy route aliases `downpayment` and `balance` map to those codes. COD is not an enum and is rejected with `400 payment_method_not_allowed`.

Order payment shape:

```json
{
  "payments": {
    "initial": {
      "amountMinor": 35000,
      "label": "Initial online payment",
      "percent": 25,
      "componentLines": [
        { "component": "supplier_principal", "amountMinor": 25000 },
        { "component": "service_fee", "amountMinor": 10000 }
      ],
      "method": "qr_manual",
      "status": "not_submitted",
      "reference": null,
      "submittedAt": null,
      "confirmedAt": null,
      "confirmedBy": null,
      "confirmationSource": null,
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null
    },
    "final_online": {
      "amountMinor": 77500,
      "label": "Final online payment",
      "percent": 75,
      "componentLines": [
        { "component": "supplier_principal", "amountMinor": 75000 },
        { "component": "delivery_pass_through", "amountMinor": 2500 }
      ],
      "method": "qr_manual",
      "status": "not_submitted",
      "reference": null,
      "submittedAt": null,
      "confirmedAt": null,
      "confirmedBy": null,
      "confirmationSource": null,
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null
    }
  }
}
```

Statuses: `not_submitted | pending_confirmation | confirmed`.

Client submission:

```http
POST /orders/:id/payments/initial/submit
POST /orders/:id/payments/final_online/submit
```

```json
{ "method": "qr_manual", "reference": "GCASH-ABC123" }
```

Payment is `409 commercial_commitment_required` until the final quote is accepted. Initial submission changes the order to `initial_payment_review`; final-online submission requires confirmed initial payment.

Manual confirmation:

```http
POST /orders/:id/payments/initial/confirm
POST /orders/:id/payments/final_online/confirm
```

```json
{ "note": "Reference matched Operations wallet" }
```

Only Operations/Super Admin. Confirmation sets `status: "confirmed"`, actor/timestamp, and `confirmationSource: "manual_ops"`. Initial confirmation changes the order to `payment_authorized`; final-online confirmation marks online collection paid. Delivery is blocked until final online payment is confirmed.

Manual rejection:

```http
POST /orders/:id/payments/initial/reject
POST /orders/:id/payments/final_online/reject
```

```json
{
  "reason": "The submitted GCash reference does not match the Operations wallet. Check the reference and submit it again."
}
```

Only Operations/Super Admin. Rejection restores `status: "not_submitted"`, clears the submitted reference/timestamp, and records `rejectedAt`, `rejectedBy`, and `rejectionReason`. Initial rejection restores `awaiting_initial_payment`; final-online rejection leaves the production state intact. The timeline and audit log retain the rejection.

Exact rejection errors:

| Status | `error` | Meaning and recovery |
|---:|---|---|
| 400 | `payment_rejection_reason_required` | `reason` is blank or missing; state the concrete payment problem and what the client must correct. |
| 403 | `forbidden` | caller is not Operations or Super Admin. |
| 404 | `order_not_found` | no order has that ID. |
| 409 | `payment_not_pending` | installment has no submitted payment awaiting review; refresh before acting. |
| 409 | `payment_already_confirmed` | installment is `confirmed`; accepted money cannot be reversed through this route and needs manual reconciliation. |

## Supplier payout milestones

```json
{
  "payoutMilestones": [
    { "code": "printing", "sharePercent": 50, "amountMinor": 50000, "status": "pending_pof", "pofFileIds": [] },
    { "code": "packaging_qc", "sharePercent": 15, "amountMinor": 15000, "status": "pending_pof", "pofFileIds": [] },
    { "code": "delivered", "sharePercent": 25, "amountMinor": 25000, "status": "pending_pof", "pofFileIds": [] },
    { "code": "retention", "sharePercent": 10, "amountMinor": 10000, "status": "pending_pof", "pofFileIds": [] }
  ]
}
```

A shop is paid across four stages of the supplier subtotal (never the client total with the service fee): `printing` 50%, `packaging_qc` 15%, `delivered` 25%, and `retention` 10%, with `retention` absorbing rounding so the four sum exactly. Statuses are `pending_pof | pof_attached | released`. Nothing releases on a state change alone: the shop attaches a Proof of Fulfilment for `printing` and `packaging_qc`, the rider's delivery evidence serves `delivered` and is inherited by `retention`, and Operations releases each share once it has looked at the proof. `packaging_qc` means the job is packed and ready for a rider; the joint supplier/rider quality check happens at pickup and is recorded by the pickup checklist, not by this milestone. `retention` releases automatically when the issue window closes with proof attached.

Release:

```http
POST /orders/:id/milestones/:code/release
```

```json
{
  "note": "Proof of Fulfilment reviewed",
  "reference": "GCASH-1234567890",
  "receiptFileId": "file_5f2a…"
}
```

`note`, `reference`, and `receiptFileId` are all optional. `reference` is the wallet's own reference number (trimmed, up to 80 characters; `400 invalid_payout_reference` beyond that). `receiptFileId` binds the caller's own ready `payout_receipt` upload (`docs/STORAGE_API.md`) to the share; anything else is `400 invalid_payout_receipt`, and a receipt already bound elsewhere is `409 file_already_attached`. Both are validated before the share moves. The released milestone then carries `reference` and `receiptFileId`, the order lists the file in `payoutReceiptFileIds`, the audit row records both, and the shop's `shop_payout_released` notification quotes the reference. Clients never receive either field.

Only Operations/Super Admin. A share without proof is `409 pof_required`; a share whose stage the order has not reached is `409 milestone_not_reached` (`delivered` before delivery is `409 delivery_required`, `retention` before the window closes is `409 issue_window_open`); insufficient confirmed supplier principal is `409 supplier_principal_not_collected`; an active claim or hold is `409 payout_held`. Every release writes an `ops_payout_released` notification to each Operations and Super Admin membership and a `shop_payout_released` notification to the supplier. `completed -> payout_released` is permitted only after every milestone is released.

## Order states and transitions

The transition endpoint accepts only these role edges. A role label means the related account only: the owning client, assigned supplier, or assigned rider; another account with the same role receives `403 forbidden`. Endpoint-owned atomic steps are listed separately.

| From | To | Actor | Notes |
|---|---|---|---|
| `draft` | `submitted` | owning client | submit request |
| `submitted` | `needs_qa` | ops/super | start QA |
| `needs_qa` | `client_correction` | ops/super | correction required |
| `needs_qa` | `proof_approval` | ops/super | client artwork/QA decision; not supplier proof |
| `needs_qa` | `approved_for_matching` | ops/super | ready to match |
| `client_correction` | `submitted` | owning client | resubmit |
| `proof_approval` | `approved_for_matching` | owning client | approve artwork/QA |
| `proof_approval` | `client_correction` | owning client | request artwork correction |
| `approved_for_matching` | `supplier_assigned` | ops/super | supplier must be approved and eligible |
| `supplier_assigned` | `approved_for_matching` | assigned supplier | decline/rematch |
| `supplier_assigned` | `awaiting_checkout` | assigned approved supplier | request says `supplier_accepted`; creates the next final quote version |
| `awaiting_checkout` | `awaiting_initial_payment` | owning client | accepts exact quote version and snapshots money/fulfillment |
| `payment_authorized` | `production` | assigned supplier | after confirmed initial payment; automatically releases an eligible 25%/50% initial supplier payout |
| `production` | `ready_for_dispatch` | assigned supplier | packaging ready; offers and notifications go to approved riders; joint pickup QC still required |
| `production` | `supplier_self_qc` | assigned supplier | legacy client/portal compatibility; new supplier flow skips this step |
| `supplier_self_qc` | `ready_for_dispatch` | assigned supplier | legacy work can advance to the same rider handoff |
| `ready_for_dispatch` | `rider_assigned` | approved rider/ops/super | normally dispatch accept; rider must be approved |
| `picked_up` | `out_for_delivery` | assigned rider | checklist already passed |
| `completed` | `payout_released` | ops/super | only when all milestones released/no hold |

Endpoint-owned steps:

- `awaiting_initial_payment -> initial_payment_review`: client submits initial payment.
- `initial_payment_review -> payment_authorized`: Operations/Super Admin confirms initial payment.
- `rider_assigned -> picked_up`: the assigned rider completes all six pickup checks together with the supplier before taking the package; no direct transition bypass. Failed checks require evidence and an Operations escalation; after resolution, repeat all six checks.
- `picked_up|out_for_delivery -> delivered -> issue_window_open`: delivery evidence route atomically records delivery and opens window; no direct transition bypass.
- `issue_window_open -> completed`: system only, when `issueWindowExpiresAt` has elapsed and no active hold. No actor can close it early.

Backfilled revision-1 rows may retain `awaiting_downpayment`/`downpayment_review`; new commercial commitments never create them. Supplier-proof states and `awaiting_payment` remain retired.

Packaging readiness is not a passed pickup quality check. It makes the job available for a rider to accept and travel to the supplier. This handoff change does not alter payment confirmation, payout milestone/proof eligibility, collection caps, or claims/holds.

## Supplier decline

`POST /orders/:id/decline` accepts an optional `{reason}` from the assigned approved supplier while `supplier_assigned`. Success returns only `{order:{id,state},replaced}`; the departing supplier must remove the job from its local list and must not expect the previous full order projection. `replaced:true` leaves the order in `supplier_assigned`; `false` returns it to `approved_for_matching` for Operations. A later-state decline returns `409 decline_not_available`.

## Rider pickup checklist and escalation

```http
POST /dispatch/:id/pickup-checklist
```

```json
{
  "checks": [
    { "code": "quantity_match", "passed": true },
    { "code": "specification_match", "passed": true },
    { "code": "visible_defects", "passed": true },
    { "code": "packaging_integrity", "passed": true },
    { "code": "documentation", "passed": true },
    { "code": "supplier_sign_off", "passed": true }
  ]
}
```

Each code appears exactly once with boolean `passed`.

### Supplier handoff signature

Six passes move nothing on their own. Custody changes hands only once the supplier has signed for the handoff **on the rider's phone**, and the same request carries that signature:

```json
{
  "checks": [ "…all six passed…" ],
  "signature": { "fileId": "file_…", "signerName": "Ana Reyes" }
}
```

The rider first uploads the rasterised pad as a `handoff_signature` PNG (rider-only, 2 MiB, see [STORAGE_API](STORAGE_API.md#purpose-policies)) and attaches it with `{ "orderId" }` — accepted only while the order is `rider_assigned` and the caller is its assigned approved rider. The checklist request then names that file. A file ID can be attached once and is never rebound; a retried checklist may name a file it already attached.

| Refusal | Meaning |
|---|---|
| `409 handoff_signature_required` | all six passed but no `signature.fileId` was sent — the order stays `rider_assigned`; an older client cannot take the package on the checks alone |
| `400 handoff_signer_name_required` | `signerName` missing, or outside 2–120 characters after trimming |
| `400 invalid_handoff_signature` | `fileId` is not a ready, rider-owned `handoff_signature` file attached to this order |
| `409 handoff_signature_upload_not_allowed` | (on attach) the order is no longer `rider_assigned` |

With a valid signature the order moves to `picked_up` and the checklist records the attestation. The signature is immutable once recorded: the checklist route is closed after `rider_assigned`, and attaching another signature is refused, so re-signing requires Operations to reopen the pickup through an escalation.

```json
{
  "order": {
    "state": "picked_up",
    "pickupChecklist": {
      "status": "passed",
      "checks": [ "…" ],
      "completedAt": "2026-09-19T07:24:00.000Z",
      "completedBy": "user_rider",
      "signOffPrompt": "GRIDGO partner! Quality check, done! Salamat po!",
      "handoffSignature": {
        "fileId": "file_…",
        "signerName": "Ana Reyes",
        "signedAt": "2026-09-19T07:24:00.000Z",
        "riderId": "user_rider",
        "checklistHash": "sha256 hex of {orderId, checks in canonical order}"
      }
    }
  },
  "signOffPrompt": "GRIDGO partner! Quality check, done! Salamat po!",
  "handoffSignature": { "…as above…" }
}
```

`pickupChecklist.handoffSignature` is projected to the assigned rider, the assigned supplier and Operations on every order read, so the supplier app and the ops dashboard can show who signed and when; the image itself is fetched with `GET /files/:fileId/download-url` under that purpose's read rule. The client's projection omits the field and may not read the file — the client learns the checks passed from `pickupChecklist.status`, not who signed for the shop. `checklistHash` is `checklistDigest(orderId, checks)` from `src/operational-model.js`; escalated checklists carry `handoffSignature: null`, and checklists recorded before this contract carry no field at all.

To let the rider's phone prefill the signer, orders read by the assigned rider, the assigned supplier or Operations also carry `supplierContact: { shopName, contactName }` from the shop's profile (`null` when the order has no shop profile).

The response still returns the trained spoken line for the rider to close the checkpoint out loud; saying it is not recorded.

Any failure must include `failureNote` and one or more `evidenceFileIds` already attached to the order as rider-owned `delivery_photo` files. The order remains `rider_assigned`; `pickupChecklist.status` becomes `failed_escalated`; an `open` escalation and ops/super notifications are created. Until Operations resolves it, another checklist returns `409 pickup_escalation_open`.

Operations resolves with:

```http
POST /escalations/:id/resolve
```

```json
{ "resolution": "Supplier replaced the affected batch; repeat all six checks." }
```

The rider is notified and must resubmit all six checks.

## Physical invoice request

`POST /orders/:id/physical-invoice` takes `{contactPerson, officeAddress, operatingHours}` from the owning client and answers `201 {request}` with `orderId` and `requestedAt`. Fields are trimmed and bounded at 80/240/80 characters; anything else is `400 invalid_physical_invoice` naming the field. Another client's order is `403 forbidden`, and a second request on the same order is `409 physical_invoice_already_requested`.

The request rides in `orders.data` jsonb, so it needed no migration. It is not a state change: no transition fires and no money moves. What it does produce is a record and an instruction:

- an audit row `order.physical_invoice_requested` against the order, whose `detail` carries the contact, office and hours;
- a durable inbox row `ops_physical_invoice_requested` to every current `ops_admin` and `super_admin` membership, titled with the order id and carrying the office in its body, written once when the request first appears.

Operations acts on the inbox row. Without it the request would sit in jsonb unread, because nothing else in the lifecycle asks anybody to courier a document.

## Rider location

`POST /dispatch/:id/location` accepts `{lat,lng,accuracy?,recordedAt?}` from the assigned approved rider during `picked_up` or `out_for_delivery`; other states return `409 tracking_not_active`. Coordinates must be finite numbers within latitude/longitude bounds; accuracy, if present, is nonnegative meters (`400 invalid_location` otherwise). Optional `recordedAt` is the source GPS fix timestamp; omission uses server time. Invalid timestamps, fixes more than 30 seconds ahead, or more than five minutes old return `400 invalid_location_timestamp`. A valid fix no newer than the current assigned rider's latest fix returns `200 {ping,ignored:true}`. Accepted fixes return `{ping}` with source time in `ping.at`.

`GET /dispatch/:id/location` returns `{ping}` for the current rider only, or `{ping:null}`. Related approved supplier/rider, delivery client, and Operations/Super Admin may read it; pickup clients cannot track the internal transfer. Consumers calculate staleness from `at` and `accuracy`.

`GET /ops/riders/locations` returns `{riders:[{riderId,name,vehicleType,plateNumber,orderId,orderTitle,state,lat,lng,accuracy,at,pickup,dropoff}]}`. It selects the latest stored fix per rider across their currently assigned `picked_up`/`out_for_delivery` orders. Riders without a fix are omitted. `vehicleType` is the rider profile's `motorcycle | car | van | truck | bicycle` and `plateNumber` its plate, both `null` when no profile exists, so the map can draw the vehicle the rider actually drives. `pickup` and `dropoff` are the order's snapshot points as `{lat,lng,label}` or `null`; a collected order reports the GRIDGO Office point as `dropoff`, the same substitution `publicOrderFor` applies, so the map can draw the remaining leg of the trip. This endpoint does not impose a freshness cutoff; the map must label old fixes using `at`.

## Delivery and issue window

Upload and attach rider `delivery_photo` evidence, then:

```http
POST /dispatch/:id/delivery
```

```json
{ "evidenceFileId": "file_123", "evidenceType": "photo" }
```

`evidenceType` is `photo | signature`; signature is allowed when the camera cannot be used. The assigned rider, passed checklist/active transport, confirmed digital balance, and attached ready evidence are required. Success stores `deliveryEvidence`, appends delivered history, automatically releases eligible remaining supplier principal, then opens:

```json
{
  "state": "issue_window_open",
  "issueWindowOpenedAt": "2026-08-10T10:00:00.000Z",
  "issueWindowExpiresAt": "2026-08-11T10:00:00.000Z"
}
```

The hours snapshot comes from the one global setting. Request processing and the bounded periodic worker expire elapsed windows transactionally; worker scheduling is defined in [Realtime events](REALTIME_EVENTS.md#delivery-durability-and-scope). A timely client issue auto-creates a held claim; a late issue returns `409 issue_window_closed`. With no active hold, expiry sets `completed`; supplier principal was already released at delivery unless an active hold prevented it.

The window has a second ending. The owning client may confirm the order arrived with no problems:

```http
POST /orders/:id/confirm
```

It performs the same completion the expiry sweep performs -- `completed`, a timeline entry in the client's name, and the retention share released when the rider's evidence already covers it -- only now rather than at expiry. It answers `200 { order }`, `409 issue_window_not_open` outside the window, and `409 issue_open` while a report or payout hold is active on the order; a client cannot both report a problem and call the job clean.

## Persistence contract

PostgreSQL is the only persistence system. Versioned forward migrations create the schema; startup never creates or repairs tables. Order transitions, payment and payout movements, credits, claims, and issue handling run inside database transactions guarded against concurrent lost updates.

Fresh seed creates only reference data: taxonomy, catalog, zones, and settings. It creates no users, orders, sessions, devices, or operational records. Files remain private object-storage objects; PostgreSQL stores only file metadata and opaque relationships.
