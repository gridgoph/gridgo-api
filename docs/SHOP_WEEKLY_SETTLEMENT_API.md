# Weekly shop settlement and availability

API contract for issue report 8CBA54AF. All mutations use the existing domain
transaction/advisory lock. Journal facts, audit evidence, file references, inbox
rows and realtime invalidations commit together; push delivery follows commit.

## Release controls

Super Admin patches `shopMoney` through `PATCH /settings`, with `expectedVersion`
and a reason. Operations cannot change these controls. `weeklyNettingEnabled`
and `overduePauseEnabled` default **false in production**, **true with
NODE_ENV=development or NODE_ENV=test**. The forward migration supplies those
same environment defaults to existing settings, preserving explicit values.
Production activation remains a release decision. With weekly netting off, the
existing daily settlement and existing issued daily payment deadlines continue.
Turning off the new overdue control disables weekly payment pauses only.

Additional `shopMoney` settings (partial patches retain omitted values):

| Setting | Default | Meaning |
| --- | --- | --- |
| weeklyDueWeekday | 1 | Sunday=0 through Saturday=6; default Monday |
| weeklyDueTime | 23:59 | Due through the end of this Manila minute |
| payoutTime | 16:00 | Existing settlement preparation time |
| reviewMinutes | 3 | Working minutes for manual receipt review |
| reviewOpens / reviewCloses | 08:00 / 17:00 | Manila review window, daily |
| missedJobLimit | 3 | Consecutive unanswered accept-first offers |
| acceptanceSeconds | 60 | Snapshotted on each new accept-first offer |
| demandAlertsPerDay | 2 | Per-shop budget, Manila calendar day |
| demandRadiusMeters | 5000 | Maximum internal distance from demand |
| openMinutes | [30,60] | Owner's temporary opening choices |

Integer validation rejects fractional counts/money. Time, weekday and bounded
positive values are validated. Changes affect future offers, runs and openings;
issued deadlines, scheduled amounts, paid amounts and order money stay fixed.

## Settlement

When enabled, the Monday run covers the preceding completed Monday-Sunday
period and catches up on the first later sweep if the API was unavailable.
Repeated runs in that week return the same immutable run. Cash-fee events from
that period are recognized exactly once. Cash collected after the cutoff rolls
into the next period. GRIDGO first offsets the fees against releasable QR
principal, then pays the QR surplus or requests the remaining cash-fee balance.
Held principal cannot erase a debt. Gross payout-plan shares never change.
Weekly transfers use the existing prepare/confirm/reconcile routes under
`/ops/shop-money`; a fully offset payout requires the explicit zero-transfer
confirmation and no invented payment receipt. The legacy daily minimum does
not defer a weekly offset or surplus.

Every item already in any settlement run is **scheduled**, including an item
whose transfer is not yet reserved. Its original net amount is preserved when
prepared, retried or subsequently released. Later cash fees use unscheduled
items in a later run. Existing reservations and paid transfers retain their
amounts. An incompatible later recovery state requires reconciliation rather
than changing the scheduled amount. Application and PostgreSQL guards enforce
this boundary, including historical writers.

`GET /me/shop-money` is owner-only. It retains `balances`, `history`, and
`payGridgo`, and adds `weeklySettlement` with cash fees, QR-order count, offset,
net payable and immutable scheduled items. Operations can read the same shop
through `/ops/shop-money/shops/:supplierId`. Clients and shop Staff cannot read
shop settlement amounts.

`payGridgo` includes the immutable amount/deadline, platform payment QR URL,
manual confirmation mode, review window, and latest receipt. To submit:

```
POST /me/shop-money/payments/:requestId/receipt
{ "amountMinor": 13000, "reference": "EXAMPLE-001", "receiptFileId": "file_..." }
```

Upload `shop_payment_receipt` first (JPEG/PNG/WebP, maximum 15 MiB). The upload
must be ready, owned by this shop, undeleted and unused. Receipts remain private
to the owner and Operations/Super Admin, including signed reads. Submit through
this route rather than generic attachment. Exact retries return `replayed:true`;
conflicting/reused references are rejected. `reviewBy` counts three working
minutes, beginning at the next opening outside review hours. Sending a receipt
does not reopen a paused shop.

Operations/Super Admin confirms the matching submitted amount/reference through
`POST /ops/shop-money/payments/:requestId/confirm`, with `reason`. Confirmation
alone closes the payment request and removes its overdue gate. After Monday
23:59:59.999 Manila, unpaid weekly requests block new matching/assignment and
hide the shop from the printer map. Accepted production and handovers continue;
independent verification, standing, claim, refund and availability holds remain.

## Missed jobs and demand

`GET /me/shop-status` adds `performance`: consecutive misses, missed-today order
references/times, pause state, and this Manila week's acceptance counters/rate.
It consumes the same canonical resolved accept-first offer population used by
leaderboards: accepted / (accepted + declined + timed out), excluding review,
removed, withdrawn and unresolved offers. No-outcome periods return a null rate.

Each unanswered offer creates one durable owner reminder and a durable inbox row
for every current Operations/Super Admin membership. At the threshold, new jobs
pause and the shop is hidden; accepted work continues. Accepts and declines
break the consecutive-miss streak. Replaying a timeout creates no extra reminder.

Owners patch `/me/shop-status` with the current `expectedVersion` and:

- `missedJobs: "resume"` acknowledges the missed-job pause and resets its streak.
- `missedJobs: "closed_today"` acknowledges it and pauses until Manila midnight.
- `openFor: 30`, `openFor: 60`, or `openFor: "midnight"` explicitly opens for the
  selected duration, acknowledging missed jobs and ending a temporary pause.
- `printerDemandPings: false` mutes demand alerts; `true` unmutes them.

`openOptions` advertises current duration choices. A temporary opening does not
clear an unpaid-fee or account hold, change existing promises, or bypass delivery
hours. A shop previously manually closed returns to closed at the exact end;
otherwise its normal calendar resumes. These writes are owner-only and audited.

Authenticated `POST /express/demand` uses the existing printer-demand boundary
and always returns `{ok:true}`. Eligible nearby shops, including closed/offline
shops, may hear demand during the day or night; demand alerts default on unless
muted. No client coordinates or identities are sent to suppliers. A repeated
client consumes at most one slot per shop/day. The budget is stored with shop
availability and survives concurrent API requests, process restarts and calendar
edits. New demand pushes recheck mute, owner membership and their immutable
midnight expiry; legacy night-window notifications retain their original expiry
rules. Notifications offer availability choices, never reserve jobs or promise
ranking priority.
