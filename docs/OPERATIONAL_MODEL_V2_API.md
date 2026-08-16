# GRIDGO Operational Model v2 API

This is the rebuild contract for the three mobile apps and Operations web portal. Field names, enum values, money units, authorization, and state transitions are case-sensitive. `docs/STORAGE_API.md` and `docs/TAXONOMY_API.md` remain authoritative for file bytes and taxonomy structure.

## Conventions

- Bearer auth: `Authorization: Bearer <Clerk session JWT>` except `/health`, `/catalog`, and the two device-registration routes below, which accept a call with **no** `Authorization` header from a phone that has not signed in. Sending an *expired* token is still `401` — omit the header entirely to register anonymously.
- Money: integer PHP minor units. Never send formatted peso strings as amounts.
- Errors: `{ "error": "snake_case", "message": "concrete problem and recovery", ...details }`.
- Roles: `client`, `supplier`, `rider`, `ops_admin`, `super_admin`.
- Verification: `unverified | pending | approved | suspended | rejected`. Only `approved` supplier/rider accounts can receive work.
- Client `accountType`: `individual | business | organization`. Clerk self-activation creates an `individual` client; Operations can update the profile later.

## Complete route index

| Method | Path | Authorization | Contract |
|---|---|---|---|
| GET | `/health` | public | service/database/storage/push health, plus `commit`/`builtAt` build identity |
| GET | `/catalog` | public | demo product catalogue |
| POST | `/auth/signup` | removed | always `404`; sign-up is owned by Clerk |
| POST | `/auth/login` | removed | always `404`; sign-in is owned by Clerk |
| POST | `/auth/clerk/activate` | Clerk JWT | create the caller's first GRIDGO client row after Google/email SSO |
| GET | `/auth/me` | authenticated | `{user}` without password |
| POST | `/auth/logout` | authenticated | optionally releases this phone back to unclaimed; the client signs out of Clerk |
| POST | `/files` | purpose role | streamed upload; see storage contract |
| GET | `/files/:fileId` | file owner/related order or service/ops/super | public metadata |
| GET | `/files/:fileId/download-url` | same as file read | five-minute signed GET |
| POST | `/files/:fileId/attach` | file owner + parent owner/assignee | attach opaque file ID |
| DELETE | `/files/:fileId` | owner/ops/super; unreferenced only | safe delete lifecycle |
| GET | `/devices` | authenticated | caller's own push registrations |
| POST | `/devices` | authenticated **or** anonymous | register this phone's FCM token against the caller, or unclaimed when no bearer token is sent |
| POST | `/devices/unregister` | authenticated **or** anonymous | stop push to one of the caller's own phones; an anonymous call may remove only an unclaimed registration |
| POST | `/announcements` | ops/super | one general message to an audience; `everyone` also reaches unclaimed handsets |
| GET | `/notifications` | authenticated | caller's notifications, newest first |
| GET | `/notifications/stream` | authenticated | caller-scoped SSE notification delivery and resume |
| PATCH | `/notifications/:id` | notification owner | set `{read:true|false}` |
| PATCH | `/notifications/read-all` | notification owner | mark caller's list snapshot read |
| DELETE | `/notifications/:id` | notification owner | persistent soft delete from caller's inbox |
| GET | `/settings` | authenticated | global issue window and delivery bands |
| PATCH | `/settings` | ops/super | replace either/both operational settings |
| GET | `/credits/balance` | client own; ops/super any `?clientId=` | pilot grant ledger only |
| POST | `/credits/authorize` | authenticated | retired: always `410 payment_route_retired` |
| POST | `/credits/grant` | super | non-cash pilot grant; audited |
| GET | `/users[?role=]` | ops/super | public-user directory |
| GET | `/users/:id` | ops/super | one public user; supplier detail also includes verification documents |
| PATCH | `/users/:id/shop` | owning supplier; ops/super any supplier | replace supplier shop pin; existing orders are unchanged |
| GET | `/users/:id/verification-documents` | owning supplier; ops/super any supplier | private attached verification-document metadata |
| PATCH | `/users/:id/role` | super | role change; audited |
| POST | `/users/:id/verification` | ops/super | supplier/rider approval decision |
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
| POST | `/orders/:id/milestones/:code/release` | ops/super | POF-gated supplier payout release |
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

The first authenticated activation creates an `individual` client. Supplier, rider, Operations, and Super Admin access is granted only by a database role change performed by an existing Super Admin. The database role is authoritative for every authorization decision; Clerk client-settable metadata is ignored. Supplier/rider verification remains a separate Operations-controlled approval.

`PATCH /users/:id/role` refuses to demote the platform's only Super Admin: because administrator bootstrap closes permanently after first use, removing the last `super_admin` would lock role management. The attempt returns `409 last_super_admin`; promote another user to `super_admin` first.

### `POST /auth/clerk/activate`

Auth: `Authorization: Bearer <Clerk session JWT>`. Empty body.

Used once after Google / public SSO. `/auth/me` does not create or email-link accounts.

- Verifies the JWT the same way other Clerk routes do (signature, issuer, `azp`, expiry).
- Loads the Clerk user with the Backend API.
- A previously mapped Clerk identity returns its existing database user.
- An unmapped identity creates a client (`clerkUserId`, primary verified email, name, phone if present, and `accountType: "individual"`). Email is not used to merge identities.
- Success is `200 { user }` (`publicUser`; no `clerkUserId`). The same Clerk JWT can immediately call `/auth/me`.
- Unmapped JWT on `/auth/me` remains `401 unauthorized`. Role claims or public metadata cannot elevate the database role.

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
      "title": "Supplier assigned and final price ready",
      "body": "A supplier accepted your order. Review the final price and submit the digital downpayment."
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

**No money reaches a device.** The `data` map is an allowlist, not a redaction pass: nothing outside those four keys is ever sent, so supplier price, commission, payout milestone amounts and every other field the [visibility rules](#visibility-authorization) hide stay off the lock screen even if a future notification record carries them. Titles and bodies are the owner-scoped strings the same user already sees in-app.

### Failure behaviour apps can rely on

- A failed push never fails the action that caused it. If a payout releases and FCM is unreachable, the payout still happened, the notification record still exists, and `GET /notifications` still returns it.
- A dead token is pruned, a transient FCM failure is not. A phone that is merely offline or unreachable keeps its registration.
- There is no delivery receipt and no read receipt. `read` is set only through `PATCH /notifications/:id` or `PATCH /notifications/read-all`; a push does not mark anything read.

## Platform announcements

One general message to a whole audience, from Operations. `everyone` is the app-update channel.

### `POST /announcements`

Authorization: `ops_admin` or `super_admin`.

```json
{ "audience": "everyone", "title": "Update your app", "body": "GRIDGO 1.4 is available in the store." }
```

`201`:

```json
{
  "announcement": {
    "id": "anc_4f21c9d0a8b7",
    "audience": "everyone",
    "title": "Update your app",
    "body": "GRIDGO 1.4 is available in the store.",
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
| `403` | `forbidden` | the caller is not ops or super |

Every announcement is written to the platform audit log (`announcement.broadcast`) with its audience, title, and both counts.

## Notifications

Notification IDs are opaque. Every notification route is owner-only: an authenticated caller receives only records whose `userId` is their own user ID. A known notification owned by another user returns `403 {"error":"forbidden"}`; an unknown notification returns `404 {"error":"notification_not_found"}`. Deleted notifications are omitted from all later lists.

### `GET /notifications`

Returns the caller's non-deleted notifications, newest first, plus an append-order snapshot watermark:

```json
{
  "notifications": [
    { "id": "ntf_123", "userId": "user_client", "title": "Final price ready", "body": "Review your order.", "read": false, "at": "2026-08-11T02:00:00.000Z" }
  ],
  "snapshot": "ntf_123"
}
```

`snapshot` is `null` when the caller has never had a notification. Clients must retain the non-null snapshot returned with the list and echo it to mark-all; it is not a notification timestamp.

### `GET /notifications/stream`

Opens a caller-scoped Server-Sent Events stream using the same bearer token as other authenticated routes. The response uses `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, and a five-second reconnect hint. Each new notification created by any server path is sent only to its owner:

```text
id: ntf_124
event: notification
data: {"id":"ntf_124","userId":"user_client","title":"Final price ready","body":"Review your order.","read":false,"at":"2026-08-11T02:01:00.000Z"}

```

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
  "settings": {
    "issueWindowHours": 24,
    "deliveryFeeBands": [
      { "maxDistanceMeters": 4999, "feeMinor": 2500 },
      { "maxDistanceMeters": 10000, "feeMinor": 5000 },
      { "maxDistanceMeters": null, "feeMinor": 7500 }
    ]
  }
}
```

These band figures are provisional Firstmate values, not captain-specified prices. Operations/Super Admin can change them without a release:

```http
PATCH /settings
```

```json
{
  "issueWindowHours": 48,
  "deliveryFeeBands": [
    { "maxDistanceMeters": 4999, "feeMinor": 3000 },
    { "maxDistanceMeters": 10000, "feeMinor": 6000 },
    { "maxDistanceMeters": null, "feeMinor": 9000 }
  ],
  "reason": "Pilot pricing update"
}
```

`issueWindowHours` is a whole number from 1 to 720. Band maxima increase strictly; the final maximum is `null`. The API derives `deliveryDistanceMeters` with a Haversine distance between the assigned supplier's `shop`/order `pickup` and order `dropoff`. Client-supplied `deliveryFeeMinor` is ignored.

## Price estimate and exact money

At `POST /orders`, `priceRange` is client-safe and commission-inclusive:

```json
{
  "priceRange": {
    "subtotalMinMinor": 49500,
    "subtotalMaxMinor": 55000,
    "deliveryFeeStatus": "pending_supplier_assignment"
  }
}
```

It is derived from current product and live-service reference prices. No supplier or delivery point is selected yet, so delivery is pending. It is an estimate, not an authorization.

Order creation validates its inputs before drafting anything: `quantity` must be a positive integer (omitted means `1`) or the request is `400 invalid_quantity`, and `zone` must be an active zone code from `GET /zones` (omitted means `davao_central`) or the request is `400 invalid_zone`. When the reference catalog has not been seeded, creation fails with `409 catalog_not_seeded` instead of estimating from missing data.

Supplier acceptance uses the existing transition endpoint with a new exact field:

```http
POST /orders/:id/transition
```

```json
{
  "state": "supplier_accepted",
  "supplierPriceMinor": 100000,
  "promisedDate": "2026-08-12T09:00:00.000Z"
}
```

The assigned, approved supplier is the only allowed caller. This atomically computes money, creates a `supplier_assignment_final_price` client notification, stores `assignmentNotificationId`/`assignmentNotifiedAt`, and returns order state `awaiting_downpayment`.

### Worked example

| Field | Minor units | Peso meaning | Client receives field? |
|---|---:|---:|---|
| `supplierPriceMinor` | 100000 | ₱1,000 | no |
| `commissionRatePercent` | 10 | 10% | no |
| `commissionMinor` | 10000 | ₱100 | no |
| `subtotalMinor` | 110000 | ₱1,100 | yes |
| `deliveryFeeMinor` | 2500 | ₱25 | yes |
| `totalMinor` | 112500 | ₱1,125 | yes |
| `downpaymentMinor` | 84375 | ₱843.75 | yes |
| `balanceMinor` | 28125 | ₱281.25 | yes |

`commissionMinor = round(supplierPriceMinor * 10 / 100)`. `subtotalMinor = supplierPriceMinor + commissionMinor`. `totalMinor = subtotalMinor + deliveryFeeMinor`. `downpaymentMinor = round(totalMinor * 75 / 100)` and `balanceMinor` receives the exact remainder.

### Visibility authorization

- Client: subtotal, delivery, total, downpayment/balance, payment status, its submitted payment references, and milestone codes/status/POF IDs. Never supplier price, commission rate/amount, or milestone amounts.
- Assigned supplier: client-visible totals plus its `supplierPriceMinor` and milestone `amountMinor`. Never commission or client payment references.
- Rider: client-safe order money; no supplier price, commission, payout amounts, or client payment references.
- Operations/Super Admin: full supplier price, commission, client totals, installment amounts, and milestone amounts.

All order-returning endpoints use this projection. Commission secrecy is an API authorization rule.

## Digital payment split

`installment` is `downpayment` or `balance`. COD is not an enum and is rejected with `400 payment_method_not_allowed` on legacy transition attempts. The old credit authorization route is `410` and the old rider proof/cash route is `410`.

Order payment shape:

```json
{
  "payments": {
    "downpayment": {
      "amountMinor": 84375,
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
    "balance": {
      "amountMinor": 28125,
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
POST /orders/:id/payments/downpayment/submit
POST /orders/:id/payments/balance/submit
```

```json
{ "method": "qr_manual", "reference": "GCASH-ABC123" }
```

Payment is `409 assignment_notification_required` until the persisted assignment notification exists. Downpayment submission changes order state to `downpayment_review`. Balance submission requires confirmed downpayment.

Manual confirmation:

```http
POST /orders/:id/payments/downpayment/confirm
POST /orders/:id/payments/balance/confirm
```

```json
{ "note": "Reference matched Operations wallet" }
```

Only Operations/Super Admin. Confirmation sets `status: "confirmed"`, actor/timestamp, and `confirmationSource: "manual_ops"`. Downpayment confirmation changes order state to `payment_authorized`; balance confirmation sets legacy summary `paymentStatus: "paid"`. Delivery is blocked until balance is confirmed.

Manual rejection:

```http
POST /orders/:id/payments/downpayment/reject
POST /orders/:id/payments/balance/reject
```

```json
{
  "reason": "The submitted GCash reference does not match the Operations wallet. Check the reference and submit it again."
}
```

Only Operations/Super Admin. A successful rejection returns `200 { "order": ... }`, restores the installment to `status: "not_submitted"`, clears its submitted reference/submission timestamp, and sets `rejectedAt`, `rejectedBy`, and client-visible `rejectionReason`. Downpayment rejection also restores order state `awaiting_downpayment` and summary `paymentStatus: "unpaid"`; balance rejection restores summary `paymentStatus: "downpayment_confirmed"` without changing the production/delivery state. The client can submit the installment again immediately. Resubmission clears the three current rejection fields; the rejection remains in `order.timeline` and the platform audit log.

Exact rejection errors:

| Status | `error` | Meaning and recovery |
|---:|---|---|
| 400 | `payment_rejection_reason_required` | `reason` is blank or missing; state the concrete payment problem and what the client must correct. |
| 403 | `forbidden` | caller is not Operations or Super Admin. |
| 404 | `order_not_found` | no order has that ID. |
| 409 | `payment_not_pending` | installment has no submitted payment awaiting review; refresh before acting. |
| 409 | `payment_already_confirmed` | installment is `confirmed`; accepted money cannot be reversed through this route and needs manual reconciliation. |

## Payout milestones and POF

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

Statuses: `pending_pof | pof_attached | released`. Amounts split `supplierPriceMinor`, not client total. Retention receives any integer-rounding remainder so amounts sum exactly to supplier earnings.

POF uses the existing file flow with `purpose=fulfilment_proof`, then:

```http
POST /files/:fileId/attach
```

```json
{ "orderId": "ord_123", "milestoneCode": "printing" }
```

Uploader authorization: assigned supplier for `printing`/`packaging_qc`; assigned rider for `delivered`. Direct retention upload is invalid; delivered POF links to both delivered and retention.

Release:

```http
POST /orders/:id/milestones/:code/release
```

```json
{ "note": "POF reviewed" }
```

Only Operations/Super Admin. Missing POF is `409 pof_required`; an early production-stage release is `409 milestone_not_reached`; active claim is `409 payout_held`; delivered share additionally needs recorded delivery and confirmed balance; retention needs completed issue-window expiry. `completed -> payout_released` is permitted only after every milestone is released.

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
| `supplier_assigned` | `awaiting_downpayment` | assigned approved supplier | request says `supplier_accepted`; acceptance + price + notification are atomic |
| `payment_authorized` | `production` | assigned supplier | after confirmed downpayment |
| `production` | `supplier_self_qc` | assigned supplier | production complete |
| `supplier_self_qc` | `ready_for_dispatch` | assigned supplier | ready for pickup |
| `ready_for_dispatch` | `rider_assigned` | approved rider/ops/super | normally dispatch accept; rider must be approved |
| `picked_up` | `out_for_delivery` | assigned rider | checklist already passed |
| `completed` | `payout_released` | ops/super | only when all milestones released/no hold |

Endpoint-owned steps:

- `awaiting_downpayment -> downpayment_review`: client submits downpayment.
- `downpayment_review -> payment_authorized`: Operations/Super Admin confirms downpayment.
- `rider_assigned -> picked_up`: all six pickup checks pass; no direct transition bypass.
- `picked_up|out_for_delivery -> delivered -> issue_window_open`: delivery evidence route atomically records delivery and opens window; no direct transition bypass.
- `issue_window_open -> completed`: system only, when `issueWindowExpiresAt` has elapsed and no active hold. No actor can close it early.

Retired states are never accepted or stored: `supplier_proof_review`, `supplier_proof_changes_requested`, `supplier_proof_approved`, `awaiting_payment`.

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

Upload/attach rider `delivery_photo` evidence and delivered `fulfilment_proof`, then:

```http
POST /dispatch/:id/delivery
```

```json
{ "evidenceFileId": "file_123", "evidenceType": "photo" }
```

`evidenceType` is `photo | signature`; signature is allowed when the camera cannot be used. The assigned rider, passed checklist/active transport, confirmed digital balance, attached ready evidence, and delivered POF are required. Success stores `deliveryEvidence`, appends delivered history, then opens:

```json
{
  "state": "issue_window_open",
  "issueWindowOpenedAt": "2026-08-10T10:00:00.000Z",
  "issueWindowExpiresAt": "2026-08-11T10:00:00.000Z"
}
```

The hours snapshot comes from the one global setting. Request processing expires elapsed windows transactionally. A timely client issue auto-creates a held claim; a late issue returns `409 issue_window_closed`. With no active hold, expiry sets `completed` and automatically releases retention when delivered POF is present.

## Persistence contract

PostgreSQL is the only persistence system. Versioned forward migrations create the schema; startup never creates or repairs tables. Order transitions, payment and payout movements, credits, claims, and issue handling run inside database transactions guarded against concurrent lost updates.

Fresh seed creates only reference data: taxonomy, catalog, zones, and settings. It creates no users, orders, sessions, devices, or operational records. Files remain private object-storage objects; PostgreSQL stores only file metadata and opaque relationships.
