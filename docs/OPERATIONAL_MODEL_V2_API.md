# GRIDGO Operational Model v2 API

This is the rebuild contract for the three mobile apps and Operations web portal. Field names, enum values, money units, authorization, and state transitions are case-sensitive. `docs/STORAGE_API.md` and `docs/TAXONOMY_API.md` remain authoritative for file bytes and taxonomy structure.

## Conventions

- Bearer auth: `Authorization: Bearer <Clerk session JWT>` except `/health`, `/catalog`, `GET /public/payment-qr`, `GET /public/announcement-images/:fileId`, `POST /webhooks/clerk`, and the two device-registration routes below, which accept a call with **no** `Authorization` header from a phone that has not signed in. Sending an *expired* token is still `401` — omit the header entirely to register anonymously.
- Money: integer PHP minor units. Never send formatted peso strings as amounts.
- Errors: `{ "error": "snake_case", "message": "concrete problem and recovery", ...details }`.
- Membership roles: `client`, `supplier`, `rider`, `ops_admin`, `super_admin`. Clerk claims and metadata never grant them.
- Approval cases: `pending | approved | suspended | rejected`. Only `approved` supplier/rider cases can receive work.
- Client `accountType`: `individual | business | organization`. Clerk self-activation creates an `individual` client; Operations can update the profile later.

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
| POST | `/devices` | authenticated **or** anonymous | register this phone's FCM token against the caller, or unclaimed when no bearer token is sent |
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
| POST | `/orders/:id/payments/:installment/submit` | owning client | submit QR reference |
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
| POST | `/issues/:id/resolve` | ops/super | resolve/dismiss, optionally release claim |
| GET | `/escalations[?status=&orderId=]` | ops/super | pickup escalations |
| POST | `/escalations/:id/resolve` | ops/super | instruction/resolution; rider must recheck |
| GET | `/audit` | ops/super | platform audit with existing filters |
| GET | `/dispatch/offers` | approved rider/ops/super | available/assigned dispatches |
| POST | `/dispatch/:id/accept` | approved rider | assign self to ready dispatch |
| POST | `/dispatch/:id/pickup-checklist` | assigned approved rider | pass or escalate all six checks |
| POST/GET | `/dispatch/:id/location` | POST assigned rider; GET related parties/ops/super | live location ping/latest ping |
| POST | `/dispatch/:id/delivery` | assigned rider | file-backed delivery evidence; opens issue window |
| POST | `/dispatch/:id/proof` | authenticated | retired: always `410 dispatch_proof_route_retired` |
| GET | `/jobs` | supplier | only the caller's assigned supplier jobs |

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

## Push notifications (Firebase Cloud Messaging)

`GET /notifications` and `/notifications/stream` only reach a phone while the app is open and connected. Push is the third delivery leg: the server sends the same notification through **FCM HTTP v1** to every device the owner has registered, so it arrives with the app closed and the screen locked.

Firebase project: **`gridgo-c2ce9`**. The apps need its `google-services.json` / `GoogleService-Info.plist`; the sending credential is server-side only and is never distributed to a device.

Push **supplements** the existing legs and never replaces them. Every push corresponds to exactly one notification record the same user can read in `GET /notifications`, carries that record's ID, and is emitted once — the server pushes from the single place that already persists notifications, so no server path can create a notification without a push or push the same record twice. Apps must still render the in-app list as the source of truth: a phone with notifications denied, a stale token, or an offline period receives nothing, and the list is what closes that gap.

When the deployment has no FCM credential installed, every route below still works and stores registrations; nothing is sent. `GET /health` reports `push.status: "disabled"` in that case — see `docs/DEPLOYMENT.md` §2.

### Device registration model

- A registration is `{ token, platform }`. `token` is the FCM registration token Firebase issued to that installation; `platform` is `android`, `ios`, or `web`.
- **A registration is either claimed or unclaimed.** A claimed registration belongs to one account. An *unclaimed* one belongs to nobody: a phone that installed the app and never signed in, or one whose owner signed out. Unclaimed registrations exist so an app-update announcement reaches every install — see *Reaching a phone that has never signed in*.
- **A token belongs to exactly one user.** Registering a token that is already registered to somebody else moves it to the caller and removes the previous owner's claim, which is what a shared handset or a sign-out/sign-in on the same phone produces. Without that move, one person's orders would appear on another person's lock screen.
- **One user may hold many devices.** A phone and a tablet both receive every notification; one dead device never suppresses the others.
- Re-registering the same token under the same account updates the existing record instead of adding a second one. Apps should re-register on every launch and on every Firebase token refresh; it is idempotent and cheap.
- The server deletes a registration as soon as FCM reports it unregistered or its token invalid. An app that finds itself receiving nothing should simply register again.
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
| `400` | `invalid_device_platform` | `platform` is not `android`, `ios`, or `web`; the response repeats `allowed` |
| `401` | `unauthorized` | the request carried a bearer token that is expired or unknown |

### `GET /devices`

```json
{ "devices": [ { "id": "dev_9f2c41a7c8d3", "userId": "user_client", "platform": "android", "tokenTail": "a7c8d3f1", "createdAt": "…", "updatedAt": "…" } ] }
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
| `400` | `invalid_device_token` | `token` is not shaped like an FCM registration token (64–4096 characters of `A–Z a–z 0–9 _ : . -`) |
| `400` | `invalid_device_platform` | `platform` is not `android`, `ios`, or `web`; the response repeats `allowed` |

What apps can rely on:

- **Register on first launch, before any sign-in**, and re-register on every launch and token refresh. Re-registration updates the one row; it never creates a second.
- **A claimed registration is never changed by an anonymous call.** If the token already belongs to an account, the call is a no-op — it cannot move, re-platform, or silence somebody's phone. The owner's own app re-registers with its bearer token, and a genuine sign-out releases the row itself.
- **`POST /devices/unregister` with no `Authorization` header** removes an unclaimed registration and answers `200 {"ok": true}`. A *claimed* registration is left alone and answers identically; removing one still requires its owner's bearer token.
- **The unclaimed pool is bounded.** Past the pilot ceiling (5,000; `GRIDGO_MAX_UNCLAIMED_DEVICES`) the least recently seen unclaimed registrations are evicted to make room. Claimed registrations are never evicted, and a phone evicted while idle re-registers on its next launch. Registration is not refused at the ceiling: a refusal would let one script close the app-update channel to every genuine new install until an operator intervened.

**What an unclaimed handset may receive — the hard rule.** An unclaimed registration is an anonymous phone; nothing proves who is holding it. It may only ever be sent a general announcement: never an order, a payout, a claim, an issue, a name, an amount, or anything else tied to a person. This is enforced in the delivery path — the client that talks to FCM refuses any batch containing an unclaimed device unless the message carries `data` of exactly `{"type": "announcement"}` — not by convention at the call sites.

### What a push looks like

One FCM v1 message per registered device:

```json
{
  "message": {
    "token": "<one device token>",
    "notification": {
      "title": "Final quote ready",
      "body": "Review the final quote, fulfillment choice, and payment plan."
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

- `title` and `body` are the notification record's own, readable with the phone locked.
- `data` values are always strings, and the keys are exactly `notificationId`, `type`, `orderId`, `at`. Keys with no value are omitted — a notification with no order carries no `orderId`. Route on `type` and `orderId`; fetch the order and re-read `GET /notifications` after opening, because the push carries no order state.
- **Android apps must create the notification channel `gridgo_default`** before requesting a token. A message naming a channel the app has not created is downgraded or dropped on Android 8+.
- `type` is the same discriminator as on the notification record: `supplier_assignment_final_price`, `pickup_check_escalation`, `pickup_escalation_resolved`, and any later value. Treat unknown types as "open the notification list".

**No money reaches a device.** The `data` map is an allowlist, not a redaction pass: nothing outside those four keys is ever sent, so supplier settlement, payout milestone amounts, service-fee amounts, and every other money field stay off the lock screen even if a future notification record carries them. Titles and bodies are the owner-scoped strings the same user already sees in-app.

### Failure behaviour apps can rely on

- A failed push never fails the action that caused it. If a payout releases and FCM is unreachable, the payout still happened, the notification record still exists, and `GET /notifications` still returns it.
- A dead token is pruned, a transient FCM failure is not. A phone that is merely offline or unreachable keeps its registration.
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

Every targeted account gets one notification record (`type: "announcement"`, `orderId: null`, plus the `announcementId` that groups them), readable in `GET /notifications`, on the SSE stream, and pushed to that account's registered devices like any other notification.

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

## Notifications

Notification IDs are opaque. Every notification route is owner-only: an authenticated caller receives only records whose `userId` is their own user ID. A known notification owned by another user returns `403 {"error":"forbidden"}`; an unknown notification returns `404 {"error":"notification_not_found"}`. Deleted notifications are omitted from all later lists.

### `GET /notifications`

Returns the caller's non-deleted notifications, newest first, plus an append-order snapshot watermark. `limit` (default 40, max 100) bounds the window; the inbox is not the full history. A notification about a job the caller can see carries `orderTitle` and `orderState` so a client can draw the stage rail without `GET /orders` or hydrating the job.

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

Opens a caller-scoped Server-Sent Events stream using the same bearer token as other authenticated routes. The response uses `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, and a five-second reconnect hint. Each new notification created by any server path is sent only to its owner. The `data` object is the same public inbox row as `GET /notifications` (including `orderTitle` / `orderState` when the row names an order — never the hydrated order):

```text
id: ntf_124
event: notification
data: {"id":"ntf_124","userId":"user_client","title":"Final price ready","body":"Review your order.","read":false,"at":"2026-08-11T02:01:00.000Z","orderTitle":"Grand opening tarpaulin","orderState":"production"}

```

After a mutation commits, the same stream may also send a silent refetch ping. It has no `id:` field and is not replayed from `Last-Event-ID` — reconnect and list snapshot are enough:

```text
event: invalidate
data: {"resource":"orders","id":"ord_1"}

```

`resource` is one of `orders`, `jobs`, `approvals`, `escalations`, `claims`, `dispatch`, `payouts`. `id` is optional. The payload is never a collection.

The server sends a comment heartbeat every 25 seconds (`: heartbeat <ISO timestamp>`) and removes the subscription and timer immediately when either side closes.

For initial synchronization, call `GET /notifications`, render that response, then open the stream with its non-null `snapshot` as the `Last-Event-ID` header. The server replays caller-owned, non-deleted notifications appended after that ID before continuing live delivery. Native SSE reconnection sends the most recently received event ID automatically, preventing gaps while a phone is backgrounded. With no `Last-Event-ID` (including when the list snapshot is `null`), the stream replays the caller's current non-deleted inbox before continuing live; clients should de-duplicate those IDs against the rendered list. An unknown cursor returns `409 {"error":"notification_resume_unavailable"}` (refresh the list); a cursor owned by another user returns `403 {"error":"forbidden"}` and no stream opens.

### `PATCH /notifications/:id`

Set one notification read or unread. Unread is deliberately supported so an accidental mark can be reversed.

```json
{ "read": true }
```

Returns `200 {"notification": {...}}`. `read` must be a JSON boolean; missing or non-boolean values return `400 {"error":"notification_read_required"}`. A notification already deleted by its owner returns `404 notification_not_found`.

### `PATCH /notifications/read-all`

Mark every non-deleted notification belonging to the caller that existed in a prior list snapshot:

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
    "issueWindowHours": 24,
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

The patch is an audited compare-and-swap: `expectedVersion` must match `GET /settings`, `reason` is mandatory, and success increments `version`. `serviceFeeRateBps` is an actual JSON integer from 0 through 10,000; `issueWindowHours` is an actual JSON integer from 1 through 720. Each `feeMinor` and finite band maximum must also be a JSON safe integer, band maxima increase strictly, and the final maximum is `null`. Numeric strings are rejected rather than coerced. Settings changes affect only future commercial commitments.

Supplier payment timing preferences use `GET|PATCH /supplier-payment-terms`. `GET` returns the caller's terms to a supplier; Operations/Super Admin may select a supplier with `?supplierId=`. Supplier-only `PATCH` accepts any subset of `deliveryDownpaymentRateBps`, `pickupFullOnlineEnabled`, `pickupDownpaymentStoreEnabled`, and `pickupDownpaymentRateBps`, and returns `{ "terms": SupplierPaymentTerms }`. Delivery accepts `deliveryDownpaymentRateBps: 0|2500|5000`. Pickup full-online is independently enabled; pickup downpayment-at-store requires a rate of `2500|5000`, while disabling that mode clears its rate to `null`. When the supplier profile enables pickup, at least one pickup mode must remain enabled. Accepted quotes snapshot these terms.

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

For the rounding vector `supplierSubtotalMinor = 99999`, a 1,000-bps service fee is `10000` and a 2,500-bps initial supplier principal is `25000`; the supplier remainder is therefore `74999`. With the `2500` delivery pass-through, the initial online installment is `35000`, the final online installment is `77499`, and the client total is `112499`.

### Visibility authorization

- Client: items subtotal, service fee, delivery, total, accepted plan/installments, its submitted references, and payout milestone codes/status; never platform supplier-payout amounts.
- Assigned supplier: its full supplier subtotal, zero-deduction settlement card, and milestone amounts; never client payment references. For pickup-at-store plans, the card reports the amount due separately and keeps received-at-store at zero until a later lifecycle owns an explicit receipt signal.
- Rider: client-safe order totals; no supplier payout, allocation, milestone, or client-reference details.
- Operations/Super Admin: full client totals, allocations, supplier settlement, service-fee revenue fields, and milestone amounts.

All order-returning endpoints use this projection.

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
    { "code": "initial", "sharePercent": 25, "amountMinor": 25000, "status": "pending" },
    { "code": "completion", "sharePercent": 75, "amountMinor": 75000, "status": "pending" }
  ]
}
```

Statuses for current commitments are `pending | released`. The supplier original price is the supplier subtotal, never the client total with the service fee. Delivery terms produce these exact payout shapes:

- 0%: one `completion` payout for the full supplier subtotal.
- 25% or 50%: one `initial` payout for that percentage and one `completion` payout for the remainder.

The initial payout releases automatically when production starts. The completion payout releases automatically when delivery is recorded. Both are capped cumulatively by confirmed `supplier_principal` payment allocations, so GRIDGO never fronts supplier cash. An active Operations or claim hold leaves an otherwise eligible milestone pending. Pickup payout remains unavailable until Task H supplies a handover signal; direct-at-store money remains due and unconfirmed.

Release:

```http
POST /orders/:id/milestones/:code/release
```

```json
{ "note": "Hold resolved; retry eligible payout" }
```

Only Operations/Super Admin. This is a recovery path when an automatic release was held. An early initial release is `409 milestone_not_reached`; an early completion release is `409 fulfilment_required`; insufficient confirmed principal is `409 supplier_principal_not_collected`; an active claim is `409 payout_held`. `completed -> payout_released` is permitted only after every milestone is released.

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
| `production` | `supplier_self_qc` | assigned supplier | production complete |
| `supplier_self_qc` | `ready_for_dispatch` | assigned supplier | ready for pickup |
| `ready_for_dispatch` | `rider_assigned` | approved rider/ops/super | normally dispatch accept; rider must be approved |
| `picked_up` | `out_for_delivery` | assigned rider | checklist already passed |
| `completed` | `payout_released` | ops/super | only when all milestones released/no hold |

Endpoint-owned steps:

- `awaiting_initial_payment -> initial_payment_review`: client submits initial payment.
- `initial_payment_review -> payment_authorized`: Operations/Super Admin confirms initial payment.
- `rider_assigned -> picked_up`: all six pickup checks pass; no direct transition bypass.
- `picked_up|out_for_delivery -> delivered -> issue_window_open`: delivery evidence route atomically records delivery and opens window; no direct transition bypass.
- `issue_window_open -> completed`: system only, when `issueWindowExpiresAt` has elapsed and no active hold. No actor can close it early.

Backfilled revision-1 rows may retain `awaiting_downpayment`/`downpayment_review`; new commercial commitments never create them. Supplier-proof states and `awaiting_payment` remain retired.

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

Each code appears exactly once with boolean `passed`. All pass moves to `picked_up` and returns:

```json
{ "signOffPrompt": "GRIDGO partner! Quality check, done! Salamat po!" }
```

Any failure must include `failureNote` and one or more `evidenceFileIds` already attached to the order as rider-owned `delivery_photo` files. The order remains `rider_assigned`; `pickupChecklist.status` becomes `failed_escalated`; an `open` escalation and ops/super notifications are created. Until Operations resolves it, another checklist returns `409 pickup_escalation_open`.

Operations resolves with:

```http
POST /escalations/:id/resolve
```

```json
{ "resolution": "Supplier replaced the affected batch; repeat all six checks." }
```

The rider is notified and must resubmit all six checks.

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

The hours snapshot comes from the one global setting. Request processing expires elapsed windows transactionally. A timely client issue auto-creates a held claim; a late issue returns `409 issue_window_closed`. With no active hold, expiry sets `completed`; supplier principal was already released at delivery unless an active hold prevented it.

## Persistence contract

PostgreSQL is the only persistence system. Versioned forward migrations create the schema; startup never creates or repairs tables. Order transitions, payment and payout movements, credits, claims, and issue handling run inside database transactions guarded against concurrent lost updates.

Fresh seed creates only reference data: taxonomy, catalog, zones, and settings. It creates no users, orders, sessions, devices, or operational records. Files remain private object-storage objects; PostgreSQL stores only file metadata and opaque relationships.
