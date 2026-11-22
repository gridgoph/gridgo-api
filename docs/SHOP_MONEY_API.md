# Shop balances and daily settlement

Refs gridgoph/gridgo-api#416. Issue report 4EF1D71D. This is the API contract for supplier app and dashboard follow-ups. All amounts are safe-integer PHP centavos. All supplier profiles, including home printers, use their supplier membership as the ledger counterparty. Staff and managers cannot read Money; selected-shop headers work for delegated Owners.

## Schedule and policy

Shops earn around the clock. At 16:00 Asia/Manila on a business day, the lifecycle creates one durable settlement run. Operations may also request the due run with `POST /ops/shop-money/run` and `{}`. A retry returns the same run; before the cutoff or on a non-business day the result is `run: null`. A delayed run uses the current balances. Unpaid amounts and amounts below the minimum remain in the next business day's calculation.

The run is a review list, not a receipt or a bank transfer. The team prepares a shop's current eligible items, verifies its frozen receiving QR, sends one combined transfer outside GRIDGO, then records that transfer. GRIDGO bears transfer fees; no fee is subtracted from the shop's balance. Automatic payouts remain deferred to the payment gateway work.

Super Admin edits the existing versioned `PATCH /settings` with a reason:

```json
{
  "expectedVersion": 12,
  "reason": "Reviewed settlement policy",
  "shopMoney": {
    "payoutTime": "16:00",
    "minimumMinor": 10000,
    "payDeadline": "18:00",
    "reminderTime": "17:00",
    "bonusRateBps": 2000,
    "bonusDays": 7,
    "bonusCapMinor": 50000,
    "businessWeekdays": [1, 2, 3, 4, 5],
    "holidays": [],
    "extraBusinessDates": []
  },
  "riderCommissionBps": 8000
}
```

Times are Manila `HH:mm`; cutoff < reminder < deadline. Weekdays use Sunday=0. Calendar exceptions use real `YYYY-MM-DD` dates; an extra business date overrides a holiday. Partial money settings preserve omitted values. The migration's `launchedAt` is an immutable eligibility boundary: pre-release commitments are not retroactively awarded a launch bonus. Fresh seeded settings record their launch boundary when seeded. Operations retains only its existing permission to change the dispatch-offer timeout.

## Supplier app

- Owner `GET /me/shop-money?period=week|month` returns `balances`, `policy`, `jobs`, `history`, `earningsByDay`, `paymentMethods` and `payGridgo`. Default period is month. History additionally accepts `from` (ISO timestamp), `kind`, `orderId` and `method`. Period filters do not change the all-time balances. Payment-method charts count jobs; a mixed voucher/QR job contributes to both method categories.
- `balances.owedMinor` is **GRIDGO owes you**; `owingMinor` is **You owe GRIDGO**. `netMinor` is their difference. `paidMinor` counts actual outgoing cash, excluding recovery offsets. `nextPayoutAt` is the next business cutoff. `overdue` and `paused` describe the Pay GRIDGO new-order hold. Independent verification, standing, shop-open and service eligibility still apply.
- `jobs` supplies the order ID, creation time, shop pay, client payment methods, daily/staged tag and launch bonus. Ordinary owning-supplier order reads also expose `clientPayment` and `shopLaunchBonus`; clients and riders never receive the bonus. Staff receive their existing minimized work projection.
- `clientPayment.methods` is an immutable array of `in_app_qr`, `cash_to_rider`, `voucher`, `counter_cash`. A mixed voucher/QR order has both methods. Each persisted job/order retains this fact independently of later debt repayments. `clientPayment.settlement` is `daily` for Express or `staged` for Regular.
- The bonus is 20% of the accepted shop pay for commitments strictly within seven elapsed days of that supplier's first order, with a lifetime PHP 500 cap per shop. Each job snapshots its amount/rate/window/cap; later settings do not rewrite it. Cancelled unpaid bonuses are voided. It is a separate GRIDGO-funded entitlement, payable when the principal's final stage is eligible or, for collected cash, the delivered job is clear of holds. It counts toward online verification exposure. Regular 40/35/25 shares are unchanged.
- A `payGridgo` sheet contains `requestId`, `amountMinor`, unique `reference`, `deadlineAt`, `qrImageUrl`, and `confirmation: "manual"`. Show the supplied amount/reference beside GRIDGO's existing QR Ph. The platform QR is static; this API does not encode a dynamic payment instruction or claim automatic bank confirmation. A refreshed amount reflects recovery already applied from other payouts.
- Keep the receiving-QR screen on the existing `/me/payout-account` flow. A prepared daily transfer locks QR edits until paid or explicitly confirmed unsent.

Gross entitlements and actual payouts are distinct journal events. Work not yet eligible for release remains in the owed balance and does not enter the actionable daily transfer amount. Recovery is deducted before the minimum is applied. A zero-cash full recovery offset may settle without an external transfer or invented receipt. Independent holds never become a new permission to send money.

## Dashboard

All routes below are Operations/Super Admin, except the per-shop rollout switch, which is Super Admin only.

1. `GET /ops/shop-money` reads every shop's owed/owing/net/paid/overdue/paused balances, the latest 31 runs and latest 100 prepared transfers with current status. `GET /ops/shop-money/shops/:supplierId` returns exactly the owning shop's balances/history/chart data. Ordinary private file reads remain role-scoped.
2. `POST /ops/shop-money/run` obtains the due run. Its `data.shops` lists `availableMinor`, `amountMinor`, `rolloverMinor`, eligible item keys and held reasons. Claim, refund, production proof, collection, verification cap, recovery and two-open-Regular-job rules are evaluated together. Existing unresolved preparations are excluded from another actionable list.
3. Before sending, `POST /ops/shop-money/runs/:runId/shops/:supplierId/prepare` with `{}` rechecks the selected items and minimum, freezes the current payout account, and reserves each underlying item through the existing verification ledger. The response's `transfer.id`, `data.netAmountMinor`, `data.items` and `data.payoutAccount` are the instruction to review. Only its payer receives a replay of that actionable instruction. Another operator gets `verification_payer_required`. Never send from a run preview alone.
4. After the actual combined transfer, `POST /ops/shop-money/transfers/:transferId/confirm` takes exact `amountMinor`, `fundsSentConfirmed: true`, actual ISO `paidAt`, `reference`, a ready owned `payout_receipt` `receiptFileId`, and `reason`. It records all frozen stages, supplements, settlement remainders and bonuses atomically. Positive transfers require evidence. Exact amount/reference retries return `replayed: true`; a changed completion is refused. A zero-cash offset instead requires `amountMinor: 0`, `offsetConfirmed: true`, `paidAt` and `reason`, with no receipt/reference.
5. An uncertain transfer uses `/unknown` with `reason`. It stays reserved and must never be resent. After positively checking that no money moved, `/cancel` requires `noFundsSentConfirmed: true` and `reason`. The frozen attempt is retired; its unpaid balance rolls into a later run. Payer or Super Admin may reconcile. Recording an already-sent evidenced transfer remains possible if an independent hold arose afterward; it leaves that hold in place. A zero-cash offset rechecks its release gates.

Existing individual `/orders/:id/milestones/:code/prepare`, `/release`, reservation reconciliation and refund supplier-payout routes remain compatible. Do not use them to send a second transfer for a batch's reserved items. Unknown attempts retain the same evidence/reconciliation contract as [supplier verification](SUPPLIER_VERIFICATION_API.md).

## Pay GRIDGO and future counter cash

Counter cash remains off for every shop by default. `PATCH /ops/shop-money/shops/:supplierId/policy` takes `expectedVersion` (initially 0), `counterCashEnabled`, and `reason`. Enabling requires a verified supplier and the platform receiving QR to be configured. This preserves the existing new-cash verification boundary. This switch prepares financial collection and new-order holds; it does not add a client checkout option or change Express's existing all-online payment policy.

For a future checkout that has already snapshotted `counter_cash`, staff may `POST /ops/shop-money/shops/:supplierId/counter-cash` with `orderId`, the exact sale `amountMinor`, `cashReceivedConfirmed: true` and `reason`. It records the snapshotted GRIDGO service share once in the same recovery ledger used for payout netting. During the supplier's snapshotted launch week that counter service share is waived. It cannot reclassify an online order as counter cash.

At a business cutoff a negative shop net creates one Pay GRIDGO request. The 16:00 settlement notice and 17:00 unpaid reminder use the existing durable inbox/outbox, with copies to every current Operations and Super Admin membership. Reminders and overdue events are durable and deduplicated across retries/restarts.

At the snapshotted 18:00 deadline, shared matching/checkout eligibility pauses new orders while the request is unpaid. Accepted work can finish. The team checks the actual incoming bank receipt then calls `POST /ops/shop-money/payments/:requestId/confirm` with the current exact `amountMinor`, actual bank `reference`, and `reason`. Confirmation reduces recovery debt, audits and notifies, and immediately lifts this new-order hold. Exact retries do nothing twice. An overlapping prepared recovery must be reconciled first to avoid collecting the same debt twice. Full payout recovery also closes the request. Other standing/verification/claim holds remain independent.

There is no payment gateway account, credential or webhook integration in this change. Pay GRIDGO is manually confirmed until that integration is available. Supplier app, rider app and dashboard screens remain separate releases.

## Rider app

Continue reading the existing dispatch offer/order fields `riderCommissionBps`, `riderPayoutMinor`, `platformDeliveryShareMinor` and existing rider earnings/wallet routes. New commercial commitments use the configured 8000 bps share: PHP 89 fare = PHP 71.20 rider pay. Existing accepted delivery/order/job rate snapshots remain unchanged, including legacy full pass-through and 85% terms. Cash custody and wallet offsets retain [their existing contract](CASH_ON_DELIVERY_API.md). No rider mutation or new provider is required for this rate update.
