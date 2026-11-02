# Client Home API: theme, smart tile and bug-report voucher

API contract for the client Home redesign, gridgo-client#335. The client app and the
dashboard implement it separately after this API and migration
`1793610000000_client_home_bug_rewards` are deployed. PHP money is integer centavos.
Errors use `{ "error": "snake_case", "message": "..." }`.

## Theme preference

The light/dark choice is saved on the client account. `system` (the default for every
account) means follow the phone setting. The app follows the phone until the client
taps the switch, then sends the choice and applies the saved value on every screen and
device.

| Read | Field |
| --- | --- |
| `GET /auth/me/client` | `clientProfile.themePreference` |
| `GET /me` (client) | `user.themePreference` |

`PATCH /me/theme` with `{ "themePreference": "system" | "light" | "dark" }` returns
`200 { "themePreference": "dark" }`. It needs a Clerk session with a client membership
and a client account profile. There is no version handshake: the last write wins, and repeating the
current value is a no-op. A change queues an `identity` invalidation for the client's
other signed-in devices. Errors:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | No or invalid session. |
| 403 | `membership_required` | Not a client. |
| 400 | `invalid_theme_preference` | Missing or unknown value (`allowed` lists the values). |
| 400 | `unexpected_field` | Any other body field. |
| 409 | `client_profile_unavailable` | The identity has no editable client profile. |

Stored as `client_profiles.theme_preference` (`system | light | dark`, default `system`).

## Smart tile summary

`GET /me/home-summary` (client membership required, `Cache-Control: private, no-store`)
returns everything the Home smart tile shows, in one call:

```json
{
  "serverTime": "2026-11-02T08:00:00.000Z",
  "tile": "missions",
  "missions": {
    "eligible": true, "label": null, "awardedAt": null,
    "missions": { "added": true, "placed": true, "tracked": false, "received": false, "rated": false },
    "completedCount": 2, "total": 5, "rewardStatus": "pending"
  },
  "activeOrder": {
    "orderId": "ord_...", "state": "production", "step": 2, "stepKey": "printing", "stepCount": 4,
    "fulfillmentMode": "delivery", "basketId": null, "awaitingPayment": false,
    "promisedAt": "2026-11-04T09:00:00.000Z", "statusAt": "2026-11-02T03:10:00.000Z",
    "time": { "kind": "promised", "at": "2026-11-04T09:00:00.000Z" }
  },
  "activeOrderCount": 1,
  "testerVoucher": null,
  "bugReport": { "rewardAvailable": true, "amountMinor": 1500 }
}
```

`tile` is the first state that applies, in this order:

1. `missions`: the client is Founding Tester eligible, not yet awarded, and
   `completedCount < total`. Show `missions` progress. `missions` uses the same rules as
   `GET /me/founding-tester` ([contract](FOUNDING_TESTER_API.md)).
2. `active_order`: `activeOrder` is not null.
3. `tester_voucher`: `testerVoucher` is not null.
4. `invite`: none of the above. Use `GET /me/founding-tester` for the invite link.

All four objects are always present (null when empty), so the client may render a
different state while keeping the tile the same size.

### The four steps

`activeOrder` is the client's most relevant active order. These order states map to the
four-step bar. Any state not listed (`draft`, `completed`, `payout_released`, `cancelled`)
is not an active order.

| Step | `stepKey` | Suggested label | Order states |
| --- | --- | --- | --- |
| 1 | `placed` | Order placed | `submitted`, `needs_qa`, `client_correction`, `initial_payment_review`, `proof_approval`, `approved_for_matching`, `supplier_assigned`, `supplier_accepted`, `awaiting_checkout`, `awaiting_initial_payment`, `awaiting_downpayment`, `downpayment_review`, `payment_authorized` |
| 2 | `printing` | Printing | `production`, `supplier_self_qc` |
| 3 | `on_the_way` | On the way (hub pickup: Ready for pickup) | `ready_for_dispatch`, `rider_assigned`, `picked_up`, `out_for_delivery`, `awaiting_collection` |
| 4 | `delivered` | Delivered | `delivered`, `issue_window_open` |

`awaitingPayment` is true for `awaiting_checkout`, `awaiting_initial_payment` and
`awaiting_downpayment`, so the tile can show a payment prompt instead of progress. Use
`fulfillmentMode` (`delivery` or `pickup`) for the step 3 label. Each shop group of a
basket is its own order; `basketId` links them.

Which order is chosen: orders in steps 1 to 3 come first, soonest promise first (orders
without a promise last), then the most recent status change. A step 4 order (delivered,
waiting for the client to confirm receipt) is shown only when nothing is in progress,
latest delivery first. `activeOrderCount` counts every active order, including step 4.

The time to show is `time`:

- `{ "kind": "promised", "at": ... }` for steps 1 to 3 when the order has a promise:
  `promiseBy`, else the legacy `promisedDate`, else the requested `deadline`. This is
  `promisedAt`, the time the client was told.
- `{ "kind": "since", "at": ... }` for steps 1 to 3 with no promise: when the order
  entered its current state (`statusAt`).
- `{ "kind": "delivered", "at": ... }` for step 4: when the issue window opened, else
  the delivery time.

### Tester voucher and bug-report tag

`testerVoucher` is the client's unused (available, not expired) tester-programme
voucher that expires soonest, or null. It covers the mission voucher, the referral voucher
on either side of the invite, and the bug-report voucher:

```json
{ "voucherId": "vch_...", "kind": "mission | referral | bug_report", "valueMinor": 1500,
  "code": "A1B2C3D4E5F60718", "expiresAt": "2026-11-29T00:00:00.000Z",
  "secondsRemaining": 2332800, "daysLeft": 27, "redeemable": true, "reserved": false }
```

`daysLeft` is whole days rounded up. `reserved` means a cart currently holds it.

`bugReport.rewardAvailable` is true while a confirmed report from this client would still
earn the one-time voucher (a Founding Tester eligible client with no bug-report
entitlement yet). Show the ₱15 tag on the Report a bug tile only while it is true.
`amountMinor` is the voucher's face value.

### Read cost

The route is a targeted read (see [targeted reads](TARGETED_READS.md)): one
repeatable-read snapshot of the caller's identity, settings, own client profile, own
orders and their payment/line/issue/refund/survey facts, own carts, own tester rows,
and only the vouchers those tester rows reference. It reads no inbox, audit, location,
push or other clients' history. It never issues or reconciles rewards. Refetch after
order or voucher changes, and on `identity` or `orders` invalidations.

## One-time bug-report voucher

Decided 26 Oct 2026: a tester earns one ₱15 voucher, once ever, after GRIDGO staff
confirm a report of theirs is a real bug. No other reward amount, trigger or budget
changes.

### Filing a report from the app

The app files through the existing `POST /issue-reports` ([contract](ISSUE_REPORTS_API.md#file-a-report-public))
and **adds the client's Clerk session** as `Authorization: Bearer <token>`. The report
then records its reporter. Without a header the report is anonymous, as from the landing
page. A header with an invalid or expired session is `401 unauthorized` (sign in again
and resend). A valid session with no GRIDGO account files anonymously. The reporter is
immutable.

### Confirm real bug (dashboard)

`POST /ops/issue-reports/:id/confirm-bug` with `{}`. Operations or Super Admin only.
Returns `200` and the report in the dashboard projection.

- The first confirmation records who confirmed it and when, sets the staff triage to
  `validity: "valid"`, `category: "bug"`, and decides the voucher:

  | `voucherOutcome` | When | Voucher |
  | --- | --- | --- |
  | `granted` | The reporter is a tester with no bug-report entitlement, and the monthly tester budget has room | One ₱15 voucher issued now, valid 30 days |
  | `paused` | As above, but the monthly tester budget has no room | Entitlement stored `paused`; issued when Super Admin resumes it |
  | `already_rewarded` | The reporter already has a bug-report entitlement (from another report, in any state) | None |
  | `not_tester` | The reporter is not Founding Tester eligible | None |
  | `no_reporter` | Anonymous report | None |

- A tester is a client the Founding Tester programme counts as eligible: a non-review
  client account created before `foundingTesterLaunchAt` (or any client while that
  setting is null), or an already-awarded Founding Tester.
- Confirming the same report again is an idempotent `200` that changes nothing,
  including concurrent retries.
- Nobody confirms their own report (staff can also hold a client membership):
  `403 issue_report_self_confirmation`, also enforced by a database check.
- Reports triaged `spam` or `duplicate` are `409 issue_report_not_confirmable`. Confirm the
  original report, or change the triage first.
- Errors: `401 unauthorized`, `403 forbidden` (any other role), `404 issue_report_not_found`,
  and `409 tester_budget_overflow` from the tester budget.

The voucher uses the existing tester wallet hook: an internal `tester_bug_report`
campaign named "Thank you for reporting a bug", assigned to the reporter, ₱15, 30 days.
The client gets the standard in-app `voucher_issued` notice. The face value counts
against the same Asia/Manila monthly tester budget as mission and referral vouchers
([budget](FOUNDING_TESTER_API.md#operational-settings-and-monthly-budget)).

Every confirmation writes an `issue_report.bug_confirmed` audit row (reporter, outcome,
entitlement ID). The entitlement's own `tester_reward.issued` / `tester_reward.paused`
audit and staff inbox events come from the tester programme. All of it commits in one
domain transaction with the report update.

The entitlement is a tester reward of `kind: "bug_report"`
(`amountMinor: 1500`, no inviter). It appears in `GET /ops/tester-rewards`, and the
existing Super Admin `POST /admin/tester-rewards/:id/resume` and `/void` routes
manage it. Resume rechecks only tester eligibility and the budget. Void works as for
mission vouchers.

### Report fields

Dashboard (`/ops/issue-reports` list, detail, PATCH and confirm responses) reports add:

```json
{
  "reporter": { "id": "usr_...", "name": "Ana", "tester": true, "bugRewardAvailable": true },
  "bugConfirmation": {
    "confirmedAt": "2026-11-02T08:00:00.000Z",
    "confirmedBy": { "id": "usr_ops", "name": "Ops" },
    "voucherOutcome": "granted",
    "voucherGranted": true,
    "reward": { "id": "trwd_...", "status": "issued", "amountMinor": 1500, "voucherId": "vch_..." }
  }
}
```

- `reporter` is null for anonymous reports. `tester` and `bugRewardAvailable` tell the
  dashboard, before confirming, whether a confirmation would earn the voucher.
- `bugConfirmation` is null until confirmed. `voucherOutcome` is the decision at
  confirmation time and never changes. `voucherGranted` is whether a voucher was actually
  issued for this report: it becomes true when a paused entitlement is resumed, and stays
  true after that voucher is voided (a paused entitlement voided before issue stays false). `reward` is null unless the outcome was `granted` or `paused`; its
  `status` is the live entitlement state (`issued | paused | voided`).

Support desk and firstmate report reads include `bugConfirmation` without `reward` and
never include `reporter`.

### Database guarantees

- `tester_rewards` gains kind `bug_report`. The existing `UNIQUE(kind, client_id)` makes it
  once per tester ever, even after expiry or void. The existing tester reward guard
  requires the voucher to belong to the reporter with the entitlement's face value.
- `issue_reports` gains `reporter_id`, `bug_confirmed_at`, `bug_confirmed_by`,
  `bug_reward_outcome` and a unique `bug_reward_id`. Check constraints keep them
  consistent. A trigger makes the reporter and the confirmation immutable, and requires
  a linked entitlement to be the reporter's own `bug_report` reward.
- `voucher_campaigns.purpose` allows `tester_bug_report`, which is protected from generic
  campaign edits like the other tester campaigns (`founding_tester_campaign_managed`).

## Rollout

Apply the migration and deploy the API first. The migration rewrites no table and is
forward-only. Then the client app sends the session on in-app reports, reads
`/me/home-summary` and the theme fields, and calls `PATCH /me/theme`. Then the
dashboard adds the Confirm real bug action and renders `reporter` and `bugConfirmation`.
Older clients keep working: the new fields are additive, and their reports stay anonymous.
