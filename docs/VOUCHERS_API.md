# GRIDGO-funded vouchers

Server contract for report **63AFAA4A**, tracked in [gridgo-api#204](https://github.com/gridgoph/gridgo-api/issues/204). Client wallet/checkout screens and dashboard screens ship separately. PHP money is integer centavos: the tester campaign uses `valueMinor: 1500` and `validityDays: 7`.

## Identity and storage

All routes require a Clerk session and database membership. `/admin/*` below requires Super Admin; Operations has only the explicit read-only lookup. Clients can read and redeem only their own vouchers. Email matching finds existing client memberships; it never provisions users, links identities, or changes roles. No transfer, cash conversion, minimum-order rule, percentage voucher, free-delivery type, or referral mechanic exists.

Migration `1791975600000` creates `voucher_campaigns`, `vouchers`, `voucher_reservations`, `voucher_redemptions`, append-only `voucher_ledger`, `voucher_code_attempts`, `voucher_cart_choices`, and `voucher_email_outbox`. Identity, lifecycle, limits, and money are relational columns. Bounded reservation order IDs, refund decisions and reminder timestamps are JSONB snapshots. The existing domain transaction/advisory lock serializes every mutation, including campaign caps and code claims. Unique constraints enforce one wallet item per account/campaign, one live reservation per voucher/cart, and one current consumption per voucher. Money, ledger, audit and notifications commit together.

The development database needs the operator command **`node-pg-migrate up --no-check-order`**, because parallel forward migrations may already have been installed there. Never run that command against the shared development database from a task worktree. Production uses the normal forward migration deployment workflow; application boot creates no schema.

## Campaign administration

| Method | Path | Result |
| --- | --- | --- |
| GET | `/admin/voucher-campaigns` | `{campaigns:[...]}` |
| POST | `/admin/voucher-campaigns` | `201 {campaign}` |
| GET | `/admin/voucher-campaigns/:id` | `{campaign}` |
| PATCH | `/admin/voucher-campaigns/:id` | `{campaign}`; draft terms only |
| DELETE | `/admin/voucher-campaigns/:id` | `{ok:true}`; unissued draft only |
| POST | `/admin/voucher-campaigns/:id/status` | `{campaign}` |
| POST | `/admin/voucher-campaigns/:id/issue` | bulk matched/unmatched report |
| POST | `/admin/vouchers/:id/void` | `{voucher}` |
| POST | `/admin/vouchers/:id/reissue` | `{voucher}` |

Creation body:

```json
{
  "name": "Soft-launch tester thanks",
  "valueMinor": 1500,
  "mode": "assigned",
  "validityDays": 7,
  "totalLimit": 100,
  "perAccountLimit": 1
}
```

`code` is optional: omission generates 16 random hexadecimal characters. Typed codes are trimmed, case-insensitive, normalized uppercase, and must be 4–40 ASCII letters/digits/hyphens. Codes are globally unique. Modes are `assigned` (staff issue only) or `shared` (client code claim). Creation always starts `draft`. Set either `endsAt` (an exact future ISO timestamp) or `validityDays` (1–365); omitted validity defaults to seven days. Issued vouchers snapshot value and expiry. `totalLimit` is a count of issued accounts, from 1 through 1,000,000, not a budget in pesos. `perAccountLimit` must be 1 for launch. Voids, expiry and restoration never free an issuance slot.

Status body is `{"status":"active"}`. Allowed transitions: draft → active/ended; active → paused/ended; paused → active/ended. Ended is terminal. Pausing/ending blocks new issuance and reservation; already reserved valid checkouts are honored. End dates are enforced even if no lifecycle tick has run. Terms are editable only while draft and unissued, protecting issued commitments. To change a launched offer, create another campaign. Deleting a launched campaign is refused.

Void/reissue bodies require a nonempty `reason` (at most 1,000 characters). Only available vouchers may be voided. A submitted checkout reservation must first be reconciled/cancelled; void returns `409 voucher_payment_reconciliation_required` while it owns order IDs. Reissue changes the same unexpired void wallet item back to available; it does not extend expiry, duplicate entitlement, or consume another campaign slot. Used/expired rewards cannot be silently reissued; create a separately budgeted campaign if a new entitlement is required. Both operations append ledger and audit records.

## Bulk issue and age handling

JSON accepts either:

```json
{"emails":["tester@example.test"]}
```

or:

```json
{"recipients":[{"email":"tester@example.test","adultConfirmed":true}]}
```

`POST /admin/voucher-campaigns/:id/issue` also accepts a raw **`Content-Type: text/csv`** upload (not multipart), maximum 1 MiB:

```csv
email,adultConfirmed
tester@example.test,true
younger-tester@example.test,false
```

`email` is the required first header; `adultConfirmed` is optional. Quoted cells and doubled quotes are supported. The boolean column accepts true/false. Each call accepts 1–1,000 entries. Matching trims and lowercases addresses, requires exactly one existing client identity, and returns:

```json
{
  "matched":[{"email":"tester@example.test","clientId":"usr_...","voucherId":"vch_...","issued":true}],
  "unmatched":[{"email":"missing@example.test","reason":"no_client_account"}]
}
```

Other unmatched reasons are `invalid_email` and `ambiguous_email`. Repeated emails and retries return the existing wallet ID with `issued:false`; there is no second issue notice. A campaign cap/status failure rolls back the entire call, including earlier matched rows. The response contains personal information and is staff-only; never paste it in public issues or PRs.

Personal accounts currently have no reliable age field. Staff must explicitly attest adult eligibility using `adultConfirmed:true` to enable push/email. Under-18 and unknown-age recipients receive **in-app only**. The client cannot set this flag. Shared-code claims default to unknown age/in-app only. This conservative launch rule avoids inferring age from an address or Clerk metadata. A later verified-age feature can extend adult notification eligibility.

## Wallet and code entry

- `GET /me/vouchers?tab=available|used|expired|all` (default available).
- `POST /me/vouchers/code` with `{"code":"TESTERS"}` claims a shared campaign idempotently. Returns `{voucher,issued}`.
- `GET /ops/vouchers?clientId=usr_...&tab=all` is the Operations/Super Admin read-only account lookup. `clientId` is required; the tab options/default match the client route.

List responses contain `{serverTime,vouchers}`. A wallet item contains:

```json
{
  "id":"vch_...",
  "campaignId":"vcamp_...",
  "name":"Soft-launch tester thanks",
  "valueMinor":1500,
  "status":"available",
  "issuedAt":"2026-10-09T08:00:00.000Z",
  "expiresAt":"2026-10-16T08:00:00.000Z",
  "secondsRemaining":604800,
  "redeemable":true,
  "reservation":null,
  "fundedBy":"GRIDGO",
  "transferable":false,
  "cashValue":false
}
```

Status is available/used/expired/void. Expiry is computed on every read; the Expired tab also includes void items, retaining `status:"void"` for its label. Reserved items remain in Available with `redeemable:false` and `reservation:{id,cartId,expiresAt}`. Paused/ended campaigns also make an available item non-redeemable. Display the exact expiry in the user's timezone and maintain the live countdown from `expiresAt` plus the `serverTime` offset. Refetch on app resume and after any mutation. “Use now” opens a cart; it does not redeem a voucher by itself.

Wrong shared codes are counted durably per account, across app sessions/processes. Five wrong codes in an hour return `429 voucher_code_locked` with `retryAt` and lock entry for 15 minutes. A valid code is also refused during the lock. Another wrong attempt in the same hourly window locks again; the hourly counter resets after an hour. Earlier failures return `400 voucher_code_invalid`. Failed-code responses commit the attempt counter. Codes and private campaign lists are never exposed to clients.

## Checkout quote, apply and remove

The existing authenticated cart quote/checkout arithmetic is authoritative. Matching/catalog display components are not added to derive a voucher amount.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/me/carts/:id/voucher` | quote and automatic selection; `{cart,serverTime}` |
| POST | `/me/carts/:id/voucher` | apply `{voucherId}` or add-and-apply `{code}`; `{cart,serverTime}` |
| DELETE | `/me/carts/:id/voucher` | remove and release reservation; `{cart,serverTime}` |

The cart must belong to the client and be draft. Existing `GET /me/carts/:id`, `/quote` previews, and checkout include the same voucher pricing. Exactly one eligible available wallet voucher is auto-selected. With multiple eligible vouchers the client chooses; the server does not pick arbitrarily. Remove suppresses future auto-selection for that cart until an explicit apply. GET previews never reserve or write. POST apply reserves for 30 minutes, bounded by voucher expiry. Checkout auto-selection reserves at checkout if not previously reserved; an existing reservation deadline is not extended by checkout. Expired reservations are released during the lifecycle sweep or the next reserve operation.

`cart.clientQuote` adds `voucher` (wallet projection or null), `voucherDiscountMinor`, `discountKind` (voucher/organization/null), and `voucherGroups` with group IDs, voucher fee/delivery funding, net client service/delivery fees and adjusted totals. `organizationDiscountMinor`, `totalMinor`, `downpaymentMinor`, `balanceMinor`, and `cart.groups[].totalMinor` reflect the selected discount. Incomplete quotes keep `totalMinor:null` and do not select a voucher. Monetary fields are nonnegative integer centavos. The 75% legacy setting retains the principal payment allocation, so a voucher can reduce the first installment by more than 75% of its face value; always render the returned payment plan.

A voucher replaces the Organization discount only if its **usable** value is strictly larger. Equal savings retain the Organization discount and leave the voucher untouched. An explicit apply that cannot improve the Organization discount returns `409 voucher_not_better_than_organization`.

One voucher covers one checkout payment boundary, including a multi-shop/multi-deadline basket. First fund gross GRIDGO service fees, then delivery/pickup charges, never shop principal. The usable value is capped by those charges; unused face value is forfeited on consumption. For baskets, fee funding is apportioned by gross service-fee weights with largest-remainder rounding, stable cart-group ties. Delivery overflow uses the same weights, capped at each group's delivery charge, redistributing overflow to groups with capacity. All-zero weights split equally. The sum of group discounts exactly equals the usable voucher value.

Checkout snapshots a separate `voucher` line:

```json
{"id":"vch_...","campaignId":"vcamp_...","label":"GRIDGO-funded voucher","fundedBy":"GRIDGO","amountMinor":1500,"serviceFeeMinor":1000,"deliveryMinor":500}
```

Orders also store `voucherDiscountMinor`, `voucherServiceFeeMinor`, `voucherDeliveryMinor`, `clientServiceFeeMinor`, and `clientDeliveryFeeMinor`. Gross `serviceFeeMinor`/`deliveryFeeMinor`, shop subtotal, principal payment allocations, payout stage amounts/shares, rider split and rider pay remain intact. Only client fee/delivery allocations and installment totals decrease. Immutable invoice snapshots show the separate GRIDGO-funded discount against GRIDGO charges, with shop amounts unchanged; any delivery overflow is separately identified. No supplier tax-credit note is generated pending accountant confirmation.

Client/Operations order and invoice projections include the voucher line. Ordinary supplier/rider projections omit wallet identifiers and discount funding fields. Operations money reporting additionally includes `voucherFunding`, while platform revenue reports the voucher discount and net fee. Supplier settlement and rider entitlements are unchanged.

## Confirmation, expiry and cancellation

Existing single-order initial-payment confirmation and basket confirmation consume the reservation atomically with payments, audit and notices. Basket groups cannot confirm through individual order payment routes. Confirmation checks the exact owning payment boundary, voucher availability, voucher expiry and reservation expiry. Expiry is exclusive: confirmation at the timestamp is refused. Pausing a campaign does not invalidate an existing reservation; voiding a reserved submitted checkout is refused.

`409 voucher_expired_or_unavailable` leaves the submitted payment unconfirmed and the accepted money snapshot unchanged. Operations must reconcile any externally transferred funds before cancelling/recreating checkout; the API never silently confirms an underpayment, increases an immutable price, or treats a voucher as cash. Rejection does not renew the reservation. Final installment confirmation does not redeem a second time.

An unpaid cancellation releases the reservation. If `cancelledBy` is the owning client, the voucher is forfeited (Used); otherwise it becomes available until its original expiry. Once cash has been confirmed, the existing refund workflow owns reconciliation.

For a voucher order, staff `POST /refund-requests/:id/settle` additionally requires `clientCaused: true|false`. This is snapshotted in the settlement with the existing audited reason; clients cannot decide fault. Refund calculation returns only verified client cash allocations, never the funded voucher value. Voucher delivery funding covers its portion of the preserved rider obligation instead of reducing rider pay.

When the refund transfer is recorded, a no-fault decision restores an unexpired used voucher with the same ID, value and expiry. Client-caused refunds consume it permanently. For baskets, all benefiting order groups must have recorded no-fault transfers before the single wallet item is restored. A partial basket remedy does not make a still-benefiting voucher reusable. Restoration is idempotent and appends a negative funding ledger line; historical order, invoice and redemption snapshots remain intact.

## Redemption log and budget

`GET /admin/voucher-redemptions` returns `{entries,total,budgetUsedMinor,budgetUsedScope,serverTime}`. Filters: `campaignId`, `clientId`, `kind`, inclusive ISO `from`/`to`; pagination `offset` (default 0), `limit` (default 100, maximum 500). Entries are newest first. This append-only activity log includes issue, reserve, release, redeem, restore, fault decisions, void and reissue, with actor/reason/order references in `data`.

`budgetUsedMinor` is a **decimal integer string**, because the sum across many safe-integer vouchers can exceed JavaScript's safe-integer range. The initial scope is `filtered_net_redemptions`: redeemed amounts minus restored amounts within the selected filters. Use campaign-only filters to display campaign lifetime net budget used; use no filters for the total. Issue/reserve/void entries have zero used budget. A restore-only/date slice can be negative, representing net funding returned during that slice.

Add `format=csv` to export all matching rows (pagination does not truncate export). The UTF-8 CSV includes IDs, campaign, voucher, client, kind, amount and timestamp; cells are quoted and spreadsheet formula prefixes escaped. The filename is `voucher-ledger.csv`. Ops cannot export or mutate campaigns.

## Notifications and internal issuance

Issue and 48/24-hour reminders use existing durable inbox/push outbox enqueueing at `save()`. They notify the client and current Operations/Super Admin memberships. Reminder timestamps are recorded once; sweeps do not repeat notices. A late sweep sends the currently applicable reminder window, not a burst of missed notices. Inbox projection includes `voucherId`; push `data` remains the four-field allowlist (`notificationId`, `type`, optional `orderId`, `at`) and never includes a code/email/wallet ID.

Adult-confirmed recipients additionally queue plain-text transactional emails using existing `EMAIL_USER`/`EMAIL_PASSWORD` Gmail SMTP configuration. Provider I/O runs outside the issuing transaction. The durable queue retries failures up to eight attempts and never fails issuance; without SMTP configuration, messages remain pending. Delivery may be at least once after a process crash around SMTP acknowledgement. Sent, expired, void or used vouchers are not newly mailed. Under-18/unknown recipients never enter the email queue and have push disabled. Animated/countdown email images are deliberately post-launch.

The [post-order survey](SURVEY_API.md) reward integration calls exported `issueVoucher(store, campaign, clientId, {id,at,actorId,adultConfirmed})` from `src/vouchers.js` inside the existing domain transaction, then calls the normal server `save()` once. Survey campaigns are internally managed and use `purpose: "survey"`; their private copyable codes resolve only to the owning account's already-issued voucher. It returns `{voucher,issued}` and provides the same idempotency, caps, age handling, ledger and notifications. Do not call SMTP/push directly or introduce another public reward-issuance endpoint.

## Errors and tests

Errors use `{error:"snake_case"}`. Common errors: `forbidden`, `voucher_campaign_not_found`, `voucher_campaign_unavailable`, `voucher_campaign_cap_reached`, `voucher_campaign_immutable`, `voucher_code_exists`, `voucher_unavailable`, `voucher_code_invalid`, `voucher_code_locked`, `voucher_reason_required`, `voucher_expired_or_unavailable`, `voucher_refund_fault_required`. Invalid request/CSV/campaign fields return 400; wrong-role calls return 403; unavailable/expired monetary actions return 409.

Node tests cover integer fee-first/floor arithmetic, Organization competition, proportional basket allocation, payout/rider/principal invariance, real checkout quote/apply/remove and basket confirmation, expiration and double-use, restore/fault rules, bulk idempotency and matching, roles, rate limits, reminder/email policy, PostgreSQL concurrent issue, append-only ledger and immutable payment allocations. Focused local validation must use a dedicated test database; the PR's **Checks against PostgreSQL 17** runs the full suite.

## Founding Tester missions

[api#293](https://github.com/gridgoph/gridgo-api/issues/293) ships missions and the
label only. Invites, share prompts, abuse checks, monthly budgets and mission CSV
exports are not implemented. The existing manual voucher features remain available.

### Launch eligibility and counting

Super Admin sets `foundingTesterLaunchAt` through the existing audited
`PATCH /settings`, with `expectedVersion` and a nonempty `reason`:

```json
{"expectedVersion":4,"reason":"Official launch cutoff","foundingTesterLaunchAt":"2026-11-01T00:00:00.000Z"}
```

The field is a UTC ISO timestamp (seconds, optionally three millisecond digits),
or `null`. `GET /settings` returns null when unset. Null/absent means all client
accounts are eligible. Otherwise `users.created_at` must be **strictly before**
the timestamp; equality is ineligible. The account's creation time is used, not
its client membership enrollment time. Settings changes affect unawarded accounts;
already-earned labels and reward references remain immutable. Settings authorization,
version conflicts and audit behavior are unchanged. Invalid timestamps return
`400 invalid_founding_tester_launch_at`. Review-data accounts cannot earn rewards;
review-data orders never count, even after their owner is unmarked.

Three account missions, in order, with no minimum order size:

1. `placed`: initial order payment confirmed, including a basket group's shared
   payment confirmation. An unconfirmed submission does not count.
2. `received`: that qualifying order's client handover confirmed, through delivery
   or pickup. Hub arrival/readiness alone does not count.
3. `rated`: a post-order survey submitted for a qualifying received order. Shop
   reviews and survey dismissal do not count. Scores do not affect eligibility.

An order with client fault does not contribute to any mission. Approved staff
issue decisions with `fault:"client"`, or a refund settlement with
`snapshot.clientCaused:true`, take precedence. Cancelled orders and refund
settlements without a recorded shop/GRIDGO failure do not count. Delivery-only
fee adjustments are not order refunds for this rule.

A recorded `shopFailureEvents` event, or an **approved** issue decision assigning
`fault:"shop"|"gridgo"`, counts `placed` and `received` even if the client never
received the goods. A pending decision does not. This exception also permits
that eligible client's normal survey route for seven days from the failure
(or survey go-live for a failure in the preceding 14 days). The original survey
invitation, if already present, is retained. The client can rate to finish; no
fake delivery transition, payment or payout is created. The shop-failure refund
choice does not become client fault merely because the client chose it.

For non-voucher refunds, staff may now include `clientCaused:true|false` in the
existing settlement body; when supplied it is preserved in the immutable snapshot.
It remains required for voucher refunds. Unknown historical fault is never inferred
from free text, the refund requester, or a staff cancellation actor.

Once awarded, progress remains 3/3 and the label stays earned. Later changes cannot
mint another entitlement. Existing reason-required staff voucher voiding remains
the way to revoke an unused reward; it does not reset the missions.

### Client and dashboard projections

All responses require their existing Clerk/membership gates. No field is added to
shared `publicUser`, order, shop, supplier or rider projections.

| Route | Projection |
| --- | --- |
| `GET /auth/me/client` | `clientProfile.foundingTester` |
| `GET /auth/me` with client role, `GET /me` | `user.foundingTester` |
| `GET /users?role=client` | Each client row adds boolean `foundingTester` |
| `GET /users?role=client&foundingTester=true|false` | Operations/Super Admin filter; false selects unawarded client rows only |
| `GET /users/:id` for a client row | `user.foundingTester`, full progress/reward projection |
| `GET /ops/founding-testers?offset=0&limit=100` | Operations/Super Admin dashboard; `{serverTime,total,clients:[{clientId,name,foundingTester}]}` |

The dashboard is read-only and includes eligible and ineligible client memberships.
Pagination defaults to 100, maximum 500. It includes no invite or spending/export
features. A supplier/rider directory row never contains the field, even when the
same identity also has a client membership; request `role=client` for that membership.
`foundingTester` filter values other than true/false return
`400 invalid_founding_tester_filter`; invalid dashboard pagination returns
`400 invalid_pagination`. Ordinary suppliers/riders/clients cannot use the dashboard.

Full projection (the `reward` is the existing wallet projection, including its
private owner code, expiry and current availability):

```json
{
  "eligible": true,
  "label": "Founding Tester",
  "awardedAt": "2026-10-20T08:00:00.000Z",
  "missions": {"placed":true,"received":true,"rated":true},
  "completedCount": 3,
  "rewardStatus": "issued",
  "reward": {"id":"vch_...","valueMinor":1500,"expiresAt":"2026-11-19T08:00:00.000Z"}
}
```

Before completion, label/awardedAt/reward are null and rewardStatus is `pending`
or `ineligible`. `existing_survey_reward` means the existing survey voucher was
reused; no new money or expiry was promised. A completed historical account can
briefly appear 3/3 with no label in a staff read before its own profile reconciliation.
Use `awardedAt` as the stable celebration identifier; repeated profile loads and
survey retries must not replay a reward animation. Refetch the profile and wallet
after submission or an `identity` invalidation. Profile reconciliation is automatic
and limited to the signed-in client; staff list reads never award in bulk.

### One entitlement and survey compatibility

For eligible clients, the ₱15 survey reward is earned **only through the three
missions**, once per account. Subsequent surveys remain available but never issue
another survey or tester voucher, even after seven days, expiry, use or voiding.
Clients outside the cutoff retain the existing survey reward and seven-day cooldown.

New rewards call the same `issueVoucher` wallet hook: integer `valueMinor:1500`,
30 elapsed days, `adultConfirmed:false`, no cash or credit conversion. Internal
campaigns use `purpose:"founding_tester"` and cannot be manually issued, edited,
paused or ended (`409 founding_tester_campaign_managed`). Code entry resolves to
the owning client's existing wallet item. Checkout, funding, expiry, restoration,
voiding, ledger and review-data money fences are unchanged.

If the account has already earned any survey voucher, reconciliation reuses its
first survey reward ID, preserving its status and original expiry even if it is
used, void or expired. Existing historical rewards are not clawed back or extended.
A completed historical response without a reward earns a new mission voucher once.

Survey responses add `rewardProgram:"founding_tester"|"survey"`.
Eligible submissions store `rewardStatus:"founding_tester"` with no separate
survey reward FK. Their `reward` projection resolves to the one account reward
(or null until all missions qualify). The same reward can therefore appear on
multiple survey cards; it is one wallet item. `nextRewardAt` is null for this
programme, and `rewardEligible` is false after award. Existing submitted survey
records and their reward references are not rewritten. Admin survey filtering also
accepts `rewardStatus=founding_tester`.

### Reminders and persistence

The lifecycle sends at most two `founding_tester_reminder` notices per eligible,
active account with **no orders at all**, at two and five elapsed days after sign-up.
Draft carts do not count as orders; even an unpaid/cancelled submitted order stops
these nudges. A delayed run can send the day-two reminder before day five, or the
day-five reminder before day six, never both together. Missed reminders after day
six are skipped. Notification deletion, restart or retries never reset their markers.

Notices use the existing durable inbox and push outbox, with generic push data
only. Each event also creates current Operations/Super Admin inbox rows. Award
and voucher notices are in-app only for unknown-age clients; there is no new email
path. Push transport failure does not roll back missions or reminders.

Migration `1792500000000` adds `founding_testers`: one row per client, immutable
award/reward link and two once-only reminder timestamps. It adds the internal
campaign purpose and survey reward status. No users, rewards or labels are seeded
or bulk awarded by migration or application boot. Progress derives from existing
order/payment, handover, fault and survey records. The shared domain transaction
and advisory lock commit entitlement, wallet, ledger, audit, notices and outbox
atomically; PostgreSQL guards ownership, reward terms and immutable markers.

### Historical preflight — stop before production bulk issuance

**Do not run a production bulk award without the captain's count approval.**
This task does not execute a production backfill and introduces no bulk award
endpoint or write-mode backfill command. Historical accounts reconcile idempotently
on their own profile access or a relevant order/fault mutation. A later approved
bulk operation must call the same reconciler through the normal `save()` boundary.

Read-only SQL candidate count, before applying the detailed order-fault rules:

```sql
SELECT count(DISTINCT u.id) AS submitted_survey_candidates
FROM users u
JOIN user_role_memberships m ON m.user_id=u.id AND m.role='client'
JOIN order_surveys s ON s.client_id=u.id AND s.submitted_at IS NOT NULL
LEFT JOIN founding_testers f ON f.client_id=u.id
LEFT JOIN platform_settings p ON p.singleton
WHERE NOT u.review_data AND f.awarded_at IS NULL
  AND ((p.settings->>'foundingTesterLaunchAt') IS NULL
    OR u.created_at < (p.settings->>'foundingTesterLaunchAt')::timestamptz);
```

For the **exact** count, use the read-only shared-policy preflight against the
operator-selected database (it has no apply mode and prints no account PII):

```sh
node --env-file-if-exists=.env src/founding-tester-count.js
```

It returns `eligibleCompletedUnawarded`, `reuseSurveyVoucher`, `newVouchers`,
`newFaceValueMinor` (decimal integer string), and `applied:false`. It loads one
consistent PostgreSQL snapshot and applies the same cutoff, review-data, fault,
handover and survey rules as online reconciliation. Present those counts before
requesting any later production bulk action. No production counts were gathered
as part of this task.

Tests cover payment and handover gates, both fulfillment modes, survey completion,
client-fault exclusions, shop/GRIDGO failure exceptions, cutoff equality, historical
reward reuse, concurrent/idempotent award, rollback, private role projections,
audited settings versioning, code ownership, review-data denial, and durable capped
reminders through the inbox/push outbox.
