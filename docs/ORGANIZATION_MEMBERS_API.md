# Organization members and the member perk

Refs gridgoph/gridgo-api#446 (issue report F67EAE25). Reuses verified organization
accounts and officers ([ORGANIZATION_ACCOUNTS_API](ORGANIZATION_ACCOUNTS_API.md)),
the organization discount and statements ([ORGANIZATION_MONEY_API](ORGANIZATION_MONEY_API.md))
and voucher arithmetic ([VOUCHERS_API](VOUCHERS_API.md)).

Official receipts, text messages and kiosk work are out of scope. Money fields are
integer centavos. All routes answer `Cache-Control: private, no-store`.

## Terms

A term is one school year, 1 June to 31 May, Asia/Manila. The wire form is
`{ code: "2026-27", label: "SY 2026-27", endsOn: "2027-05-31" }`. A term ends at
midnight after 31 May Manila time.

## Who sees what

| Person | Sees |
| --- | --- |
| Officer of record (the partner organization's own account, with a current officer) | Requests, members (name, member since, term, order **count**, uses), open list contacts, totals, events |
| Client | Only their own memberships and their own matches |
| Operations | Partner list, perk settings and totals; never a member name, list row or contact |
| Super Admin | As Operations, and the only role that sets partners and the perk |
| Shop, rider | Nothing. Order projections omit the perk and the organization |

An officer route needs a signed-in client whose organization account has a
`currentOfficer` (`403 officer_of_record_required`) and a live partnership
(`403 organization_partner_required`). A live partnership means: partner status
`active`, approved organization, active account, current officer. A handover changes
the officer on the same account, so the list stays.

## Partners and the perk (GRIDGO)

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/ops/organization-partners` | Operations, Super Admin | `{ partners }` with totals |
| GET | `/ops/organization-partners/:userId` | Operations, Super Admin | `{ partner }` |
| PUT | `/ops/organization-partners/:userId` | Super Admin | Create or change a partner |
| GET | `/ops/member-perk` | Operations, Super Admin | `{ standard }`, `null` until set |
| PUT | `/ops/member-perk` | Super Admin | Set the one standard perk |
| PUT | `/ops/organization-partners/:userId/perk` | Super Admin | Set this organization's override |
| DELETE | `/ops/organization-partners/:userId/perk` | Super Admin | Back to the standard perk |

Partner body: `{ label, status: "active"|"ended", partnerSince, benefits: { badge, jointPromos, boothSupport }, expectedVersion, reason }`.
`label` (40 characters at most) is the short name; members show as `<label> member`.
Use `expectedVersion: 0` to create. The account must be a verified organization
(`409 verified_organization_required`). Ending a partnership stops the perk and
redacts every open list contact; past orders do not change.

Perk body: `{ enabled, amountMinor, maxOrdersPerTerm, endsAt, budgetCapMinor, expectedVersion, reason }`.
An override row replaces the standard perk completely: `enabled: false` turns the
perk off for that organization. There is no perk until a Super Admin sets one.
`budgetCapMinor` is cumulative per organization; raise it to add money. Every change
writes an audit row with before, after and reason. Stale versions return `409`
with `currentVersion`. A change prices new orders only.

## Join by QR or link

| Method | Path | Purpose |
| --- | --- | --- |
| GET, POST | `/me/organization/members/invite` | Read, or create; `{ replace: true }` makes a new link and stops the old one |
| POST | `/me/memberships/preview` | `{ token }` to `{ invite }` before joining |
| POST | `/me/memberships` | `{ token, source: "qr"\|"link" }` to a pending request |
| DELETE | `/me/memberships/:id` | Cancel a request, or leave |

One link per organization and term. `invite.path` is `/join/<token>`; the QR carries
the same path. Asking twice keeps one request. Unknown, replaced, past-term and
ended links, and an organization's own link, all answer `404 member_invite_not_found`.
Each account may look up 20 links an hour; the fifth wrong link in that hour locks
look-ups for 15 minutes (`429 member_join_rate_limited`). The counters are durable.

## Requests and members (officer)

| Method | Path | Body or query |
| --- | --- | --- |
| GET | `/me/organization/members/summary` | `{ label, term, memberCount, requestCount, expiredCount }` |
| GET | `/me/organization/members/requests` | `after`, `limit` |
| GET | `/me/organization/members` | `q`, `status=active\|expired\|all`, `filter=all\|ordered\|not_ordered`, `after`, `limit` |
| GET | `/me/organization/members/:id` | one member |
| PATCH | `/me/organization/members/:id` | `{ expectedVersion, memberSince }` |
| DELETE | `/me/organization/members/:id` | `{ expectedVersion }` |
| POST | `/me/organization/members/:id/approve` | `{ expectedVersion, memberSince, term? }` |
| POST | `/me/organization/members/:id/decline` | `{ expectedVersion }` |
| POST | `/me/organization/members/:id/renew` | `{ expectedVersion }` |
| POST | `/me/organization/members/renew` | `{ memberIds }`, all or none, 500 at most |

`memberSince` is the real joining date: `YYYY-MM-DD`, `YYYY-MM` or `MM/DD/YYYY`, never
in the future and never filled in for the officer (`400 invalid_member_since`).
Approval covers the current term only. Removal stops the label and the perk at once.

Status: `pending`, `active`, `expired`, `removed`. A removed row carries
`removedReason` for its own client: `declined`, `request_cancelled`, `left`,
`removed_by_officer`, `request_expired`. One row per client and organization is
reused; `termsCount` counts terms held.

At term end memberships become `expired` and unanswered requests lapse. The perk
stops at that moment even before the lifecycle sweep writes it. Renewal is always an
officer action.

A member row shows `ordersThisTerm`, `perksUsed` and `perksPerTerm`. Only paid,
uncancelled orders placed while a member this term count. What was ordered is never
shown.

## Member list

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/me/organization/members/list/check` | Check only; stores no row |
| POST | `/me/organization/members/list` | Save; needs `consent: true` |
| GET | `/me/organization/members/list` | Waiting rows and counts |
| DELETE | `/me/organization/members/list/:id` | Take a row off |

Send `{ csv }` with the columns `Name`, `Email or mobile`, `Member since`, or
`{ rows: [{ name, contact, memberSince }] }` for one or several. Limits: 500 rows a
call, 2,000 rows per organization per Manila day.

The result gives `rowCount`, `readyCount`, `alreadyListedCount`, `emailCount`, `mobileCount`,
`needsFixCount` and `needsFix: [{ row, field, code, message }]`. Email rows match in the
app or get the invite; mobile rows match in the app or use the link. The result never says
how many rows already have an account: a list padded with known contacts would turn that
count into a way to look people up. The officer sees `counts.accepted` grow as members
confirm. Saving answers the same fields plus `savedCount`.

A listed person is **not** a member until they confirm.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/me/memberships` | `{ serverTime, memberships, matches }` |
| POST | `/me/memberships/matches` | Match the caller's **verified** email and mobile addresses |
| POST | `/me/memberships/matches/:id/confirm` | One tap: active, with the list's date |
| POST | `/me/memberships/matches/:id/dismiss` | Not me |

The app calls `POST /me/memberships/matches` once after sign-in and on resume. The
identity provider is asked each time; an unverified address never matches, and
confirming checks again. `502 clerk_unavailable` is retryable;
`429 member_match_rate_limited` means 30 calls in ten minutes.

### Contacts and email

Contacts exist only in `member_list_entries` while a row is open. Confirming,
dismissing, removing, 30 days, the term's end and the end of a partnership each set
the contact and typed name to null in the same statement; a check constraint enforces
it. They never enter audit, notifications or logs. A keyed fingerprint stays until the
term ends, only so a person is not invited twice, then it is deleted too.

Email only. One invite goes to a listed email address that has no account, between
18:00 and 20:00 Manila; one reminder at most goes seven evenings later if the row is
still open and unmatched. A send with an unknown outcome is never repeated. Taking a
row off and adding it again sends no second invite. Mobile-only rows get no message:
they match in the app, or the person uses the link. Nothing is sent when no mailbox is
configured (`EMAIL_USER`, `EMAIL_PASSWORD`).

## Perk at checkout

Automatic, like the organization discount. Rules:

1. The larger single one applies: the organization discount **or** one member perk.
   A tie keeps the discount and keeps the use. Two organizations never add up.
2. A voucher may be used with the perk, on the part of the fee that is left. A voucher
   that replaces the organization discount does not block the perk. If the perk would
   not lower the total, no use is spent.
3. The perk lowers only GRIDGO's service fee: `min(amountMinor, gross service fee)`.
   Printing, delivery and pickup charges are not touched, so shop, rider and payout
   amounts do not change and the total never goes below zero. On a small order the
   client may save less than the full amount.
4. The whole amount must fit the remaining budget; it is never cut down to fit.
5. One use covers one checkout, however many shops are in it.

Cart (`GET /me/carts/:id` and quotes): `clientQuote.memberPerkMinor` (0 when none),
`clientQuote.memberPerk: { membershipId, label, amountMinor, useNumber, maxOrdersPerTerm, fundedBy: "GRIDGO" } | null`,
`discountKind: "member_perk"` when it is the only saving, and `groups[].memberPerkMinor`.

Checkout accepts an optional `expectedMemberPerkMinor`, the amount the app showed. If
the perk changed in between, the answer is `409 member_perk_changed` with
`memberPerkMinor`, and nothing is stored. Older apps may omit it.

Orders and invoices snapshot `memberPerkMinor` and `memberPerk`. The snapshot is
immutable after commitment (PostgreSQL enforces it). `serviceFeeMinor` is net;
`grossServiceFeeMinor` is unchanged. Staff see `platformRevenue.memberPerkMinor`.

| Case | Result |
| --- | --- |
| Rounding | The perk is whole centavos. Baskets split it by gross fee with largest remainder, so the parts add up exactly. 75/25 plans round once, after the perk. |
| Cancelled before payment | The use and its budget return on the same save, when every order of that checkout is cancelled. |
| Paid, then cancelled | The use returns only if every order of that checkout is cancelled with no client fault, when the refund is recorded. |
| Refund | Returns client cash only. The perk was never cash. A partial refund does not return the use. |
| Express | Same rule on the Express fee. |
| Group order | The host's perk only. Members' shares go down in proportion, like the host's voucher. A joiner's membership does not price the host's order. |
| Cash | The client hands over the lower total; only the fee part is lower. The use is confirmed at collection and returns if the order is cancelled unpaid. |
| Removed, left, term end | New quotes lose the perk at once. Placed orders keep their snapshot. |

Uses are a ledger (`member_perk_uses`: `reserved`, `confirmed`, `returned`). A trigger
locks the partner row and enforces active membership, the per-term cap, the budget and
immutability, so concurrent checkouts cannot pass either limit. `returned` frees both.

The member's own view: `perk: { amountMinor, maxOrdersPerTerm, used, left, validUntil, available, fundedBy }`
and `totalSavedMinor` (confirmed uses). Budget figures stay with GRIDGO.

## Partnership and liquidation records (officer)

`GET /me/organization/partnership` returns `label`, `partnerSince`, `benefits`, the
read-only `perk` (`setBy: "GRIDGO"`, `editable: false`), `results`
(`memberCount`, `membersOrdered`, `memberOrders`, `membersSavedMinor`) and `events`.

| Method | Path | Body |
| --- | --- | --- |
| GET, POST | `/me/organization/events` | `{ name, orderIds? }` |
| GET, PATCH, DELETE | `/me/organization/events/:id` | `{ expectedVersion, name?, orderIds? }` |
| GET | `/me/organization/events/:id/pack?format=json\|csv\|pdf` | statement pack |

An event groups the organization's **own** orders; an order is in one event at most
(`409 event_order_already_recorded`). Status is `complete` when it has orders and all
are closed. The pack lists closed orders with the statement columns and the notice
**Not a tax document. Official receipts are issued separately.**

## Notices

The organization and the client each get their own inbox rows. Operations and Super
Admin get rows that say what happened, never to whom. `identity` is invalidated for
both parties.
