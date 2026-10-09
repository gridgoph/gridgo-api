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

The future survey reward integration should call exported `issueVoucher(store, campaign, clientId, {id,at,actorId,adultConfirmed})` from `src/vouchers.js` inside the existing domain transaction, then call the normal server `save()` once. It returns `{voucher,issued}` and provides the same idempotency, caps, age handling, ledger and notifications. Do not call SMTP/push directly or introduce another public reward-issuance endpoint.

## Errors and tests

Errors use `{error:"snake_case"}`. Common errors: `forbidden`, `voucher_campaign_not_found`, `voucher_campaign_unavailable`, `voucher_campaign_cap_reached`, `voucher_campaign_immutable`, `voucher_code_exists`, `voucher_unavailable`, `voucher_code_invalid`, `voucher_code_locked`, `voucher_reason_required`, `voucher_expired_or_unavailable`, `voucher_refund_fault_required`. Invalid request/CSV/campaign fields return 400; wrong-role calls return 403; unavailable/expired monetary actions return 409.

Node tests cover integer fee-first/floor arithmetic, Organization competition, proportional basket allocation, payout/rider/principal invariance, real checkout quote/apply/remove and basket confirmation, expiration and double-use, restore/fault rules, bulk idempotency and matching, roles, rate limits, reminder/email policy, PostgreSQL concurrent issue, append-only ledger and immutable payment allocations. Focused local validation must use a dedicated test database; the PR's **Checks against PostgreSQL 17** runs the full suite.
