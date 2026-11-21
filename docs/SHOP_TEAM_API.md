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

### Team list, approval, removal — Owner only

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
**every other supplier endpoint is Owner-only by default**, including future
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
Manager registration while the owner is away, owner SMS confirmation/dispute,
and PIN-only staff are separate product work; this change retains the published
owner/staff permissions and approval flow.

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
