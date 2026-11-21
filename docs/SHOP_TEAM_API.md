# Shop team API

API half of [supplier Owner/Staff access](https://github.com/gridgoph/gridgo-api/issues/359).
The supplier app and supplier web use the same Clerk accounts and routes. Shop
membership is separate from GRIDGO's platform `staff` (hub) role; joining a shop
never grants a supplier business, hub, Operations, or Super Admin membership.

## Identity and launch compatibility

A shop ID is its existing supplier user ID. Migration `1794192200000` adds shop
memberships and backfills every supplier membership as that shop's active
`owner`. No user IDs, Clerk subjects, credentials, sessions, order assignments,
prices or payment snapshots change. Future supplier enrollment adds its owner
on the normal transactional save boundary.

Supplier surfaces send `X-GRIDGO-Role: supplier`. Send
`X-GRIDGO-Shop-Id: <shopId>` on shop requests to keep concurrent devices/tabs
independent. An explicit header takes precedence over the saved last-used shop;
without a header, the saved active shop is selected, then the person's own
existing shop, then a single current membership. Multiple current memberships
without any of those defaults return `409 shop_selection_required`.
A person can still use an independently granted client/rider/staff/admin role
with its explicit `X-GRIDGO-Role`; shop removal does not revoke unrelated roles.

`GET /me/shop-memberships` returns the signed-in person's choices, including
pending and removed memberships:

```json
{"shops":[{"id":"supplier_123","name":"Print Shop","role":"staff","status":"pending"}],"lastUsedShopId":null,"onboardingRequired":false}
```

`PATCH /me/shop-memberships/selected` with `{"shopId":"supplier_123"}` saves
the signed-in person's choice and returns
`{"shop":{...},"lastUsedShopId":"supplier_123"}`. Any active member can select
their shop, including Staff; it grants no role. Pending/removed membership,
inactive shop, and another person's membership are refused. The choice persists
across API processes and devices. Apps should save it when opening/switching
shops, then send that explicit shop header on subsequent requests. A removed
choice is ignored; `lastUsedShopId` becomes null until another choice is saved.
No selection is written by GET requests. Responses are private and no-store.

### One login and supplier onboarding (report 8BD8C966)

Clerk remains the only sign-in provider. An already registered email or mobile
must resume Clerk **sign-in**, then use the resulting subject/session in either
app; do not create another Clerk user for the other app. The API does not issue
sessions or merge accounts by email/phone. The legacy anonymous
`POST /auth/clerk/client-available` preflight returns `available: true` for an
email containing `@`, regardless of existing platform roles. It is neither an
account-existence lookup nor authorization to link identities.

After sign-in, `GET /me/shop-memberships` works for any mapped person, including
a client with no supplier membership. Empty/currently removed-only choices
return `onboardingRequired: true`: open supplier onboarding using the current
Clerk session. `POST /auth/clerk/enroll/supplier` with its existing profile,
service categories, legal consent and `Idempotency-Key` adds the supplier
profile, pending approval case, draft services and active owner membership to
that same identity. Supplier approval still gates matching and work. Exact
idempotent retries resume that application. The person's client membership,
profile and order IDs remain in place. This is also available to a person who
already works at another shop; enrollment creates their own shop, not a second
person. The legacy one-own-shop-per-supplier-identity limit is unchanged.

`GET /auth/me/supplier` retains `403 supplier_account_not_found` for a mapped
person without a shop. `401 unmapped_identity` means a valid Clerk subject
needs explicit activation/enrollment; `401 unauthorized` means sign in again.
Client app first use calls `POST /auth/clerk/activate`, which idempotently adds
personal client access even to an existing owner/staff identity. Read the
fixed `/auth/me/client` projection afterwards; do not infer the client role
from the compatibility `users.role` or an unspecialized activation response.

No account repair, reassignment, merge, deletion or duplicate-account cleanup
runs in this migration or at boot. If another Clerk subject already owns the
copied email, the existing conflict remains an operator decision; sign in to
the original subject. Do not turn that conflict into automatic linking.

`GET /auth/me/supplier` (also `/auth/me` in supplier context) returns this
bounded bootstrap for delegated Owners and Staff:

```json
{
  "user":{"id":"user_456","name":"Sam Santos","role":"supplier"},
  "shop":{"id":"supplier_123","name":"Print Shop","role":"staff","status":"active"},
  "memberships":[{"role":"supplier"}],
  "approvalCases":[]
}
```

Here `user.id` is the person; `shop.id` is the business. The bootstrap's supplier
membership denotes app access, not a new `user_role_memberships` business row.
Pending members receive the same bootstrap with `status: pending`; show an
approval-waiting screen. They cannot read orders or use shop routes. Existing
Owners retain the existing fixed bootstrap fields, with the additive `shop`.
All team/bootstrap responses are private and must not be cached.

## Add a teammate

1. Owner creates an invite.
2. Owner shares the join link or shows its QR. Email/phone invitees can also find
   their invitation after Clerk sign-in.
3. The signed-in person claims it. It becomes used immediately, and the member
   is **pending**, with no order access.
4. Owner approves or declines the pending person.

### Create and share — Owner only

`POST /me/shop-team/invites`

```json
{"kind":"email","identity":"sam@example.com"}
```

Kinds are `email`, `phone`, `qr`, `link`. Email is normalized to lowercase;
phone must be E.164, e.g. `+639171234567`. Omit `identity` for QR/link.

```json
{
  "invite":{
    "id":"shi_123","shopId":"supplier_123","kind":"email",
    "identity":"sam@example.com","createdAt":"2026-11-08T08:00:00.000Z",
    "expiresAt":"2026-11-09T08:00:00.000Z","status":"open"
  },
  "token":"<43-character opaque token>",
  "delivery":"share_link"
}
```

The API returns each token **once**, only on creation or replacement. It persists
only a SHA-256 hash of 32 random bytes. Newly issued invites of all kinds expire exactly 24 hours after creation and
work once. The frontend builds its own configured universal/app join URL with
the token in the fragment (for example `/join-team#token=...`); the QR encodes
that same join URL. Both submit the token in the claim request body. Do not put
tokens in API URL paths/query strings, analytics, logs, or notification payloads.

This release sends no email/SMS. No provider is added, and support-desk SMTP is
not repurposed. `delivery: share_link` tells the Owner to share the link with the
recipient. Email/phone matching at sign-in works independently of delivery.
The companion app/web must implement the join URL and QR scanner.

### New code — replace an invite, Owner only

`POST /me/shop-team/invites/:id/replace` with no body (or `{}`).

Response `201` is the same `{invite, token, delivery}` shape as creation, with a
new invite ID, a new single-use token and a fresh 24-hour lifetime. The server
copies the original `kind` and normalized `identity`; delivery remains
`share_link`. Body fields cannot change the recipient, kind, role or delivery.
The app/web builds the new join link and QR from the returned token and replaces
the displayed code only after success. The token cannot be retrieved later.

Revoking the selected invite, creating its replacement and writing both audit
entries commit in one transaction under the same domain lock as claims. The old
link, QR and email/phone discovery ID are refused immediately after commit with
`409 shop_invite_revoked`. Other invites and existing memberships are unchanged.
Failure rolls back both issuance and revocation. Replacing an already claimed,
revoked or expired invite returns `409 shop_invite_used`,
`409 shop_invite_revoked` or `410 shop_invite_expired`; an invite outside the
selected shop returns `404 shop_invite_not_found`.

When claim and replacement race, exactly one operation wins: a successful claim
leaves no replacement and replacement returns `409 shop_invite_used`; a
successful replacement leaves only its new token usable and the old claim
returns `409 shop_invite_revoked`. Concurrent replacements similarly yield one
`201` and one `409 shop_invite_revoked`. An uncertain network result requires
refreshing the invite list; retrying the old ID never issues another token.
Successful responses are `Cache-Control: private, no-store`. Tokens and hashes stay out of
lists, audit, notifications and logs; only the newly issued raw token is returned
in the successful private response.

### Discover invitations after sign-in

`POST /auth/shop-invites` with `{}` and a verified Clerk bearer, even before a
GRIDGO user exists. Returns `{ "invites": [...] }` containing only unused,
unexpired email/phone invitations matching a **verified** email address or phone
number fetched from Clerk. Each row has the invite fields above and a `shop`
summary. No tokens are returned. QR/link invitations are never discoverable.

### Claim

`POST /auth/shop-invites/claim` with `{ "token": "..." }`, or
`{ "inviteId": "shi_123" }` for a discovered email/phone invite.

A verified Clerk bearer is mandatory. Email/phone claims also require an exact
verified provider identity match, even when the caller has the token. Client
JWT claims and the copied GRIDGO email/phone are not verification evidence.
There is no email-based account linking. Unmapped Clerk subjects receive a
person record with shop access only; phone-only accounts are supported.

An already mapped client, owner or teammate is reused by Clerk subject, even
when their email is already in GRIDGO. The claim adds only that shop membership;
it does not create another person or grant a platform supplier role. All current
active owners receive a durable `shop_invite_claimed` inbox notification with
`shopId`, and Operations/Super Admin receive their own membership-scoped inbox
copies. The owner notification opens the Team screen for approval. Delivery is
queued at the ordinary post-commit save boundary. No token or invite identity
is included in the notification. Pending approval remains required.

Response `200`:

```json
{
  "member":{"userId":"user_456","name":"Sam Santos","role":"staff","status":"pending","createdAt":"...","updatedAt":"..."},
  "shop":{"id":"supplier_123","name":"Print Shop","role":"staff","status":"pending"}
}
```

Reusing a claimed token returns `409 shop_invite_used`, including by its original
claimant. Refresh bootstrap/team status after an uncertain network result.
Concurrent claims serialize under the domain transaction lock: one succeeds.
A new invitation is required after removal/decline.

### Team list, approval, removal — base Owner contract (extensions below)

| Method and route | Body | Response |
| --- | --- | --- |
| `GET /me/shop-team` | — | `{members:[...], invites:[...]}` |
| `POST /me/shop-team/invites` | Above | `{invite, token, delivery}` |
| `POST /me/shop-team/invites/:id/replace` | — or `{}` | `201 {invite, token, delivery}`; atomically replaces only this open invite |
| `DELETE /me/shop-team/invites/:id` | — | `{invite}` with `status: revoked` |
| `PATCH /me/shop-team/members/:userId` | `{"status":"active"}` | `{member}`; approve pending |
| `DELETE /me/shop-team/members/:userId` | — | `{member}` with `status: removed`; decline or remove |
| `PATCH /me/shop-team/members/:userId` | `{"role":"owner"}` or `{"role":"staff"}` | `{member}`; change an active member's role |

Member fields are `userId`, `name`, `role`, `status`, `createdAt`, `updatedAt`.
Invite fields are `id`, `shopId`, `kind`, `identity`, `createdAt`, `expiresAt`,
`claimedBy` (user ID or null), `status` (`open | claimed | revoked | expired`). Lists never include hashes,
tokens, Clerk IDs, verification documents, or receiving-account details.

The only active Owner cannot be removed or demoted (`409 last_shop_owner`).
Approve another person and promote them first. Removed people cannot be
reactivated by PATCH; invite them again. Pending people cannot be promoted
without approval. Unused open invitations can be revoked by their Owner.

## Operations

Operations and Super Admin, using their own platform membership:

- `GET /ops/shops/:shopId/team` → `{members:[...]}`.
- `DELETE /ops/shops/:shopId/team/:userId` → `{member}`.

Operations cannot create invites, approve members, promote Owners, or bypass the
last-owner guard. Every invite and membership change writes the ordinary audit
ledger with the actual operator, shop, before/after role and status. Existing
audit-read scope restrictions remain intact.

## Staff permissions

Staff never receives the Owner's identity or memberships for authorization.
Each request reloads membership, person standing, shop standing and the existing
supplier approval facts. Staff receives only the following supplier endpoints;
**every other supplier endpoint is Owner-only by default** (Managers have the explicit additions below), including future
routes. Existing ownership, state, artwork-release, evidence, QA, refund, claim,
inspection and handover guards still apply.

| Work | Allowed routes |
| --- | --- |
| Order list/details/specs | `GET /jobs`, `GET /orders`, `GET /orders/:id` |
| Accept/decline/collect Express | `POST /orders/:id/express/accept`, `/decline`, `/pickup` (same work and counter-code guards) |
| Accept a paid matched order | `POST /orders/:id/transition` with `{"state":"payment_authorized"}` |
| Decline a new order | `POST /orders/:id/decline` with the existing reason body |
| Production / mark ready | `POST /orders/:id/transition` for permitted production/readiness states; `POST /orders/:id/production-finished` |
| Client conversation | `GET /orders/:id/client-shop-chat`, `POST /orders/:id/client-shop-chat/messages`, existing message-report subroute |
| Rider handoff conversation | `GET /orders/:id/pickup-chat`, `POST /orders/:id/pickup-chat/messages` |
| Assigned pickup rider location | `GET /dispatch/:id/location` under existing state/privacy rules |
| File access observations | `POST /orders/:id/files/:fileId/access`; job reads expose shop-scoped `fileAccesses` |
| Order files | `POST /files`; `GET /files/:id`, `/download-url`, `/preview-url`; `POST /files/:id/attach`, `/preview`, `/preview-failure` |
| Personal notification transport | Existing `/notifications`, `/notifications/stream`, read/delete routes, `/devices`, `/devices/unregister`, `/web-push/public-key`, `/web-push/subscribe`, `/web-push/unsubscribe`, `/auth/logout` |

Staff transition JSON accepts only `state`, `note`, `reason`,
`specialInstructionsRead`. Price edits, quote negotiation (`supplier_accepted`),
promises, reassignment and payment changes remain Owner-only. Legacy unpriced
orders need an Owner to quote; current paid matching uses `payment_authorized`.
Staff may hand work to the rider after the same readiness checks as the Owner (Express document readiness omits shop photos/product QA; `EXPRESS_API.md`);
inspection, packed-photo evidence and signed pickup remain the assigned rider's
existing routes. Staff cannot sign or confirm on the rider's behalf.

Staff uploads are limited to `fulfilment_proof`, `production_photo`,
`finished_product_photo`, legacy `packing_photo`, `client_shop_chat_attachment`, `pickup_chat_image`.
They may attach only their own unsent uploads. Shop ownership of bytes remains
stable after removal; `createdByUserId` retains the uploader. Reads require an
allowed order purpose and an order belonging to the selected shop. Verification,
receiving-QR, invoice, payment, refund, catalog and other private Owner files
remain inaccessible, even with a known file ID. Artwork access still waits for
Operations file-check release.

Owner-only surfaces include all methods and descendants of supplier profile,
shop hours/open-close, supplier payment terms, supplier services/pricing,
catalog items/products/options/tiers/photos/production times, listing starters,
readiness, catalog preview, payout account, payouts, earnings, reports,
supplier invoices, shop failures, account settings, and team management.
Per-day `schedule.weekdayOverrides` editing remains Owner-only on
`PATCH /me/shop-hours`. Supplier-context `/me/tester-program` reads, check-ins
and feedback also require active Owner access; personal client/rider tester
memberships retain their existing authorization. `POST /ops/orders/:id/remove`
remains Super Admin-only, including when a shop Owner holds other roles.
Staff order projections include Express work and a bounded `paymentMethod` label, allow only work fields and remove nested prices,
payouts, earnings, payment/settlement snapshots and raw financial timeline notes.

## Actor history

Shop and Operations order reads include:

```json
{"actions":[{"id":"aud_123:order_123","at":"2026-11-08T08:00:00.000Z","action":"order.transition","actor":{"userId":"user_456","name":"Sam Santos","role":"staff"}}]}
```

`actor.role` is `owner`/`staff` for shop actions, the existing platform role for
other people, or `system` for automation. New timeline entries also include the
same actor object. Names/roles are immutable action-time snapshots. Audit,
chat sender/read positions, new file uploader and work-event attribution use
the person's ID, while order ownership remains the shop ID. The append-only
`order_actions` table backfills recorded historical order audits; it does not
invent actors where historical evidence was missing. Clients do not receive
this internal actor history. No action record includes prices or chat content.

## Removal and realtime

Removal is effective at commit. The very next supplier request returns
`403 {"error":"shop_access_removed"}`; pending members receive
`403 {"error":"shop_approval_pending"}`. The apps must clear the selected shop,
private cached orders and supplier navigation on removal, and end that supplier
session. Clerk sessions for unrelated roles are unaffected.

The existing SSE stream also emits `event: access_revoked` with
`data: {"error":"shop_access_removed"}` and closes on removal. A database-backed
membership check at most every 25 seconds closes a stream even if a realtime
invalidation is missed. A normal `identity` invalidation refreshes approval and
role changes. Queued notifications recheck current access before delivery.
New `shop_job_assigned` and `shop_express_offer` notifications are additionally copied to
active teammates; Express Staff copies omit earnings; Owner payout/finance notifications are not copied. Push data
and all existing Owner/client/rider notification behavior remain unchanged.

## Errors

All errors use `{ "error": "snake_case" }`.

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Clerk sign-in required/invalid |
| 403 | `shop_membership_required` | Person does not belong to selected shop |
| 403 | `shop_owner_required` | Owner-only route, field or private file |
| 403 | `shop_approval_pending` | Owner has not approved access |
| 403 | `shop_access_removed` | Clear the supplier session/cache |
| 403 | `shop_unavailable` | Shop account is not active |
| 403 | `shop_invite_identity_mismatch` | Verified email/phone does not match |
| 403 | `forbidden` | Existing platform, standing or order access guard |
| 404 | `shop_invite_not_found`, `shop_member_not_found`, `shop_not_found` | Missing scoped resource |
| 409 | `shop_selection_required` | Choose a shop |
| 409 | `shop_invite_used`, `shop_invite_revoked` | Invite is no longer redeemable |
| 410 | `shop_invite_expired` | At or after the issued deadline (24 hours for new invites) |
| 409 | `shop_member_exists` | Person is already pending/active at this shop |
| 409 | `shop_invite_required` | Removed member needs a new invitation |
| 409 | `shop_approval_required` | Approve before promotion |
| 409 | `last_shop_owner` | Preserve at least one active Owner |
| 409 | `email_already_registered` | Different Clerk subject owns copied email; no automatic linking |
| 400 | `invalid_invite_kind`, `invalid_invite_identity`, `invalid_shop_invite_claim`, `invalid_shop_member_update` | Invalid request |
| 400 | `invalid_shop_selection` | Send only a nonempty `shopId` to the selection endpoint |
| 502 | `clerk_unavailable` | Retry verified identity lookup |

## Validation and rollout

Run migrations before deploying this API. Supplier app/web must use bootstrap
`shop.role` and `shop.status` to show only work screens to Staff, provide the join
URL/QR scanner and Team screen, and handle the removal code/event on every
request. API authorization does not depend on hidden controls. Production
acceptance still requires those companion screens and a deployed end-to-end
run; this API PR does not claim to complete the frontend release.

Migration `1795272000000` adds the saved selection timestamp and an immutable
invite lifetime snapshot. Existing 48-hour invitations retain their original
deadlines; newly created/replaced invitations use 24 hours. No existing owner or
staff sign-in, Clerk subject, membership status, or order snapshot is rewritten.
The database default remains 48 hours for API processes running the previous
release during deployment; this release always explicitly writes a 24-hour
lifetime for new and replacement invites.
Apply forward migration `1795272100000` before the version overlap or rollback.
Its insert trigger derives the lifetime snapshot from the unchanged issued
timestamps before PostgreSQL checks an upsert. Previous API processes can then
claim, revoke or replace existing 24-hour invitations despite omitting the new
column. The 24/48-hour check and update immutability/consumption guards remain
in force; this migration does not rewrite existing invitations.
Manager registration while the owner is away and owner SMS confirmation/dispute
remain separate product work. Manager/PIN extensions below retain invite approval.

Companion releases must make these changes:

- **Client app:** resume Clerk sign-in for an existing email/mobile; do not
  reject other platform roles using the old availability result. Activate
  personal client access, read `/auth/me/client`, and retain existing orders.
- **Supplier app:** resume the same Clerk login, retain join tokens across
  authentication, discover/claim invitations for existing users, use
  `/me/shop-memberships` for onboarding and choices, open the last-used active
  shop, and save switches with `PATCH /me/shop-memberships/selected`. Send the
  selected shop header on every shop request and key private caches by person,
  shop and role. Show pending approval, 24-hour expiry/cancellation, and the
  owner's claim notification. Staff see work screens only; clear removed-shop
  data without deleting the person or client session.
- **Supplier web:** implement the same auth/join/onboarding/selection behavior,
  store the selected shop per tab, send its explicit header, and clear private
  caches on role changes/removal. Owner notifications link to that shop's Team
  view; Staff cannot open Money or settings by navigation or direct URL.

Focused tests use a dedicated test database and `npm test -- --maxWorkers=2
 tests/shop-identity.test.js tests/shop-team.test.js tests/shop-team-postgres.test.js tests/auth-mode.test.js`. The HTTP tests use
locally signed Clerk JWTs and a local Clerk Backend API stub, never production
users or a live Clerk instance. The PR CI runs the full repository suite.

## Extended team contract (report F315793B)

The following additions apply to both supplier app and supplier web. Use the
existing Clerk bearer, `X-GRIDGO-Role: supplier` and explicit
`X-GRIDGO-Shop-Id` on every call. All responses are private/no-store.

### Manager and team permissions

`PATCH /me/shop-team/members/:userId` now accepts `role: manager` in addition
to Owner/Staff, plus `jobAlerts: boolean` and `photoFileId: string | null`.
Approval/removal and the last-owner guard remain unchanged. Only Owners may
promote/demote Owners or Managers. Managers may invite, replace/revoke invites,
approve/remove Staff and edit Staff alerts/photos. They cannot modify themselves
or other Managers, promote anyone, or change the shop's team settings.

Managers receive the Staff work routes and the same money-free order/Express
projections. Their additional allowlist is:

- `GET`/`PATCH /me/shop-hours`, including the existing version and schedule rules.
- `GET /listing-starters`, `/me/supplier-readiness`, `/me/supplier-services`.
- Existing `GET`/`POST`/`PATCH`/`DELETE /me/catalog-items` and `/:id`;
  `POST /me/catalog-items/production-time`;
  `GET /me/catalog-items/:id/production-time-preview`;
  existing listing file-format, photo reorder, prep-step, option-group and
  option routes under `/me/catalog-items` and `/me/catalog-option-groups`.
- Team routes below and existing invite/Staff management routes.
- Existing file upload/attach routes for `catalog_item_photo` and
  `shop_team_photo`, alongside Staff's work evidence purposes.

Unlisted routes remain Owner-only. Payout account, Money/earnings/payouts,
reports, invoices, payment terms, supplier profile, supplier-service writes,
account settings, quoting and financial order changes are refused. Listing
prices remain editable product data; that does not grant order financial data.

### Sign-up and shop settings

`POST /auth/clerk/enroll/supplier` accepts optional top-level
`jobsHandledBy: "just_me" | "me_and_staff"` (default `just_me`). This is saved
on the shop without delaying enrollment or approval. The Owner can invite/add
Staff immediately after enrollment and carry on with setup.

`GET /me/shop-team/settings` returns
`{settings:{jobsHandledBy,showRankingToStaff}}` to active teammates.
`PATCH /me/shop-team/settings` is Owner-only and accepts either/both fields;
`showRankingToStaff` is a boolean, default true. Hiding ranking removes the
fastest badge from Staff's team/stats responses; the mission stays visible.
Managers retain the management view. It never adds a slowest list.

### Phone-free Staff and shared devices

PIN Staff are independent shop records, never GRIDGO users, Clerk identities or
platform memberships. They cannot sign in or work remotely using a PIN.

| Method and route | Body | Response |
| --- | --- | --- |
| `POST /me/shop-team/pin-staff` | `{name,pin,role?,jobAlerts?,photoFileId?}` | `201 {member}` |
| `PATCH /me/shop-team/pin-staff/:id` | Any of `{name,role,jobAlerts,photoFileId}` | `{member}` |
| `POST /me/shop-team/pin-staff/:id/reset` | `{pin}` | `{member}`; revokes every old acting context |
| `DELETE /me/shop-team/pin-staff/:id` | — | `{member}` with `status: removed`; revokes contexts |
| `GET /me/shop-team/working` | — | `{members:[...],worker:null\|{pinStaffId,name,role}}` |
| `POST /me/shop-team/working/select` | `{pinStaffId,pin}` | `{worker,token,expiresAt}` |
| `POST /me/shop-team/working/lock` | `{}` | `{locked:true}` |

A PIN is exactly four decimal digits sent as a **string**, preserving leading
zeroes. Names are 1–100 trimmed characters. PIN member role is `staff` (default)
or `manager`; only an Owner may create/promote a Manager or edit a Manager.
`jobAlerts` defaults true. `member` contains `id,shopId,kind:"pin",name,role,status,
jobAlerts,photoFileId,createdAt,updatedAt`; no hash, version or attempt counters.
Removed records cannot be revived; add a new record when needed. PIN hashes use
random salts and scrypt. Raw PINs never appear in lists, audit or logs.

Selection requires an active signed-in Clerk **session with `sid`**, an active
membership in the selected shop, and that shop's PIN. The returned opaque token
lasts 30 minutes and is bound to the shop, signed-in person, Clerk device session
and current PIN version. Store it in memory and send
`X-GRIDGO-Worker-Token: <token>` on subsequent shop requests. Refreshing the Clerk
JWT with the same `sid` keeps that binding; a different login/session cannot use
it. A database-backed session lock prevents dropping the worker header to regain
the signed-in person's Owner permissions, selecting another platform role or
switching to another owned shop.

`working/select` and `working/lock` remain available while locked. The picker
list remains readable without a worker token so the next worker can select
themselves. A successful selection replaces the prior context. Lock, expiry,
PIN reset and removal require selection again; they **never** fall back to the
Owner. Resume Owner management by ending that Clerk session and signing in
again, or use the Owner's separate management device. Clear cached private
Owner screens on selection, role change, lock and all worker errors.

Five failed guesses block that PIN across all devices for 15 minutes. Five
failures in one device session also block that device across PIN records for
15 minutes. Failed attempts commit even though the response is a refusal;
restarting an API process cannot clear them. Reset clears the person's attempt
counter, while an already blocked device must still wait.

The server records both the signed-in account (`actor.userId`) and the selected
person (`actor.pinStaffId`, immutable action-time name/role) in each order action
and timeline event. File/chat ownership continues to use a real signed-in user
ID; the PIN context never changes order ownership, money or Clerk identity.
PIN staff have no separate push destination. Their `jobAlerts` preference is
available to the shared-device UI; account members' preferences additionally
gate inbox/SSE/push delivery. Before entering shared mode the app/web must close
its Owner SSE connection, unregister its personal push/browser subscription,
and clear Owner notifications. Personal notification/device routes are refused
inside a selected PIN context; the work list remains available. New selections
also close pre-existing supplier SSE streams through identity invalidation.

### Team, alerts and photos

`GET /me/shop-team` is now readable by active Staff. It returns:

```json
{"shop":{"id":"shop_id","name":"Print shop"},"members":[],"pinStaff":[],"stats":{"weekStartsAt":"...","weekEndsAt":"...","fastestThisWeek":null,"mission":{}},"settings":{"jobsHandledBy":"me_and_staff","showRankingToStaff":true}}
```

Account members retain the documented fields and add `kind:"account"`,
`jobAlerts`, and nullable `photoFileId`. PIN rows include `onShift`, true only
while an unexpired context matches the current active record/PIN version.
Owners/Managers also receive removed/pending rows and `invites`; Staff receive
active people only, no invite list and no per-person stats. The working picker
uses only active account/PIN rows. Account holders work through their own Clerk
login; the PIN selector selects phone-free records only.

`PATCH /me/shop-team/me` accepts `{jobAlerts:boolean,photoFileId:string|null}`
(or either field). It changes the signed-in person's selected-shop preference,
or the selected PIN person's preference, and returns `{member}`. Owners and
Managers use the member/PIN update routes for Staff preferences. Turning off
account job alerts suppresses new-job/Express fan-out and rechecks previously
queued delivery and inbox visibility; it does not remove other notifications.

For optional photos use the existing multipart `POST /files` with
`purpose=shop_team_photo` and `file` (JPEG/PNG/WebP, max 5 MiB). After the normal
ready response, send its `fileId` to the member preference/update/create route.
Only the uploader's own ready, unattached upload for that selected shop can be
bound. Send null to clear a photo. Do not call `/files/:id/attach` for this
purpose: the team mutation binds the private reference atomically.
Read metadata/signed media through `GET /files/:id` and
`GET /files/:id/download-url`. Current active members in that shop may read
bound team photos; outsiders and removed members cannot. New account invitees
can add their photo after approval. Photos are optional throughout.

### Weekly positive team view

`GET /me/shop-team/stats` returns the same `stats` object as the team response.
Weeks run Monday 00:00 to Monday 00:00 **Asia/Manila**. `jobsThisWeek` counts
unique jobs the person acted on during that week. Acceptance speed uses the
append-only `order.accepted` evidence, with exact elapsed milliseconds from the
snapshotted offer assignment to accepted time; failed/refused/retried actions
never add an acceptance. This release records that evidence at save alongside
the ordinary action log. Historical actions lacking measured acceptance
evidence contribute to handled-job counts but have no invented speed.

Owners/Managers receive `stats.members`, with `userId` or `pinStaffId`, `name`,
`jobsThisWeek`, `acceptedJobs`, and `averageAcceptSeconds` (rounded, null when
unmeasured). Returned member order is roster order, never a slowest ranking.
Staff do not receive this array or any person's speed/count/sample values.
`fastestThisWeek` is null when unmeasured/hidden; otherwise it contains only
`userId` or `pinStaffId`, `name`, `badge:"fastest_this_week"`. Ties use a stable ID
ordering. The mission is `{code:"accept_within_five_minutes",targetJobs:10,
acceptedJobs,quickAcceptedJobs,completed}`: ten team accepts within five minutes
this week. It is a positive progress goal with no penalty or slowest list.
Only actions for this shop count, including when a person works at other shops.

Additional errors: `400 invalid_shop_pin`, `invalid_shop_worker_selection`,
`invalid_shop_team_settings`, `invalid_shop_team_photo`, `invalid_shop_member_name`;
`403 shop_device_session_required`, `shop_worker_invalid`, `shop_worker_locked`,
`shop_pin_invalid`, `shop_mobile_verification_required`;
`429 shop_pin_rate_limited`. Existing member/Owner/access errors still apply.
Treat worker errors as a locked picker state; do not retry an old token silently.

### Required supplier app and supplier web calls

Both clients must implement these same calls and gates:

1. During supplier enrollment submit `jobsHandledBy`; later read/update the
   Owner team settings. Continue setup while invites are pending.
2. Link/QR: create an invite, display/share the fragment-based join URL, preserve
   the token through Clerk sign-in, then claim it using the current account.
   For a **new GRIDGO person** joining by link/QR, collect name and use Clerk's
   six-digit mobile verification flow before claiming. The API reads verified
   mobile evidence from Clerk, never a submitted code/phone claim. Optional
   claim `name` initializes only a new person; existing people retain identity.
   Existing GRIDGO users sign in to their own account; never create duplicates.
   Refresh pending bootstrap, then work after approval; Owner notice is unchanged.
3. Use `GET /me/shop-team` for the team card/roster, pending invites, PIN cards,
   role controls, weekly metrics and positive view. Owner/Manager manage Staff
   through existing member routes; Owner alone grants Manager and hides ranking.
4. Add phone-free Staff with `/pin-staff`; use `working` list/select/lock on the
   signed-in shop device. Retain the returned acting token only for that device,
   send it on every shop call, and show its worker name prominently. Lock on
   handover/background/logout and clear cached Owner data before shared mode.
5. Toggle own alerts/photo through `/me/shop-team/me`; manage other Staff through
   member/PIN routes. Upload photos with the existing upload control plane and
   resolve their private download URLs through the existing file read path.
6. Managers show hours/products/Staff management plus work. Staff show work and
   the positive team view. Only Owners show Money and owner settings. Use
   bootstrap `shop.role` and worker context, never infer privileges from the
   carrier account or legacy `users.role`. Handle every `403` and lock error.

### Deployment compatibility

Apply forward migrations `1795287000000` and `1795287001000` before this API.
Manager grants/preferences and PIN/device state live in separate tables; legacy
`shop_memberships.role` remains `owner|staff` so overlapping older writers keep
working and treat Managers as limited Staff. Nullable action evidence columns
permit old inserts. No existing membership/invite/order is rewritten and no new
CHECK constraint invalidates an old-column membership upsert. Enable companion
PIN/shared-device screens only after **every** API process serves this version;
older binaries cannot enforce a new acting context. Frontend releases and
production end-to-end acceptance remain separate from this API change.
