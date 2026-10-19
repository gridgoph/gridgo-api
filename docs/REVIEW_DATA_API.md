# Review data

Review data supports isolated store-review accounts. It grants no membership,
approval, authentication bypass, or authority to move money. Existing records default
to ordinary data. Apply migration `1792342000000` before deploying this API.

## Marking an account

`users.review_data` is a non-null boolean, exposed as `reviewData`. Only a Super
Admin can call `PATCH /users/:id/review-data`:

```json
{
  "reviewData": true,
  "expectedVersion": 1,
  "reason": "Store review setup"
}
```

Read the current `user.version` from `GET /users/:id` or the staff directory.
The reason must contain 1–2000 characters after trimming. Every accepted command
increments the user version and appends `user.review_data_change`, including
actor, reason, and before/after marks and versions. A stale version returns
`409 user_version_conflict`. The response is
`{ "user": { "id": "…", "reviewData": true, "version": 2 } }`.
Use the same route with `reviewData: false` to clear the account mark.

The server operator can use the same audited command without a dashboard:

```sh
npm run review-data:set -- <userId> --on --reason 'Store review setup'
npm run review-data:set -- <userId> --off --reason 'Store review ended'
```

The command uses the configured `DATABASE_URL`, the shared database transaction
and domain advisory lock, and the version loaded under that lock. Its audit actor
is `system` with no impersonated user. It prints only the identifier, mark, and
version. It does not create accounts or sample records. Mark only identities
explicitly designated for review; this release does not mark any account.

## Immutable order scope

Every new order, including each cart/basket group, snapshots its client's mark
into `orders.review_data`. Both the store adapter and the PostgreSQL insert
trigger derive the mark from the stored client. Request JSON cannot choose it.
The database rejects later changes with `review_data_snapshot_immutable`.
Changing a user's mark never reclassifies existing orders or their financial
children. An already assigned party retains access to that historical work.

## Matching, catalogue and dispatch

- Client matching, alternatives, deadline availability, cart selections, quotes
  and checkout use the client's current mark. They offer only suppliers with the
  same mark. Stale selections and carts cannot cross the boundary after a mark
  changes.
- Legacy eligible-supplier lists and replacement/recovery searches use the
  order's immutable mark. Every new order/job supplier or rider assignment is
  checked again at the persistence boundary, including staff transitions.
- Rider offers and offer notifications include only matching marks. Existing
  assigned work remains accessible. A cross-boundary assignment returns
  `409 review_data_assignment_mismatch` and rolls back all changes.
- Public shop, item and media URLs are filtered before projection or signing.
  Anonymous and ordinary viewers cannot see marked suppliers or their listings;
  marked viewers see marked suppliers. Hidden direct URLs return their ordinary
  catalogue not-found errors. Catalogue responses use private, no-store caching. Staff can use `includeReviewData=1` for catalogue
  inspection. The flag never overrides client matching or assignment fences.
- Featured products follow the catalogue audience. Review data is absent from
  the anonymous featured collection.

## Operations and reporting

Staff must explicitly send `?includeReviewData=1` to include review orders in
these collection reads:

- `/orders`, `/jobs`, `/baskets`, `/claims`, `/issues`, `/escalations`, `/refund-requests`;
- `/ops/riders/locations`, `/ops/colour-price-checks`, `/ops/shop-failures`,
  `/ops/hub/*`, `/ops/shops[/<id>]/performance`;
- `/admin/shop-rankings`;
- `/admin/survey-responses`, `/admin/pricing-feedback`,
  `/admin/checkout-exit-feedback`, `/admin/voucher-redemptions`;
- audit reads and CSV exports.

Filtering happens before counts, pagination and totals. Related jobs, line
items, invoices, claims, refunds, adjustments and performance records follow
the order snapshot. Pricing revenue, costs, funnel counts and the current-month
close calculations exclude review data. Funnel events also snapshot the mark
at insertion, so clearing an account cannot introduce old review activity into
the dashboard. Checkout-exit feedback without an order follows its current client
account mark. Ordinary behavior remains the default for unmarked data.

The opt-in is honored only for Operations/Super Admin readers and does not grant
access to any route. Finance, supplier invoice totals, organization statements
(including CSV/PDF), and pricing revenue, costs, funnel and close totals always
exclude review orders, even when staff send the flag. Explicit order detail
and party-owned order history retain existing authorization so review accounts
can inspect their own work. Review order projections carry `reviewData: true`.
Audit entries about marking users remain visible by default; order-linked review
audit entries require the opt-in.

## Money and notifications

Review orders use the normal client installment and basket payment flow as a
simulation. Checkout and submit record `pending_confirmation`; Operations can
reject, accept a resubmission, and confirm it through the existing routes.
Confirmation reaches `needs_qa` for cart orders, and the usual artwork, production,
handover, delivery and client completion gates continue unchanged. Required final
installments use the same simulation; zero balances remain `not_required`.
Basket confirmation applies atomically to every group.

Every review installment and basket payment carries server-owned `simulated: true`;
confirmed payments use `confirmationSource: "review_data"` instead of
`manual_ops`. These fields live in the existing payment JSON metadata and require
no new migration. The shared graph writer derives them from the immutable order
mark, including CLI writes. Clearing an account mark cannot turn a historical
simulation into money. Request JSON cannot choose the payment classification.
Normal unmarked payments retain their existing status and confirmation source.

Simulated amounts remain visible in the client's order/payment plan, but are not
collections, refundable funds, supplier earnings, rider earnings or platform
revenue. Rider-facing offers, active jobs, earnings and past-job displays show
the normal snapshotted delivery split (`deliveryFeeMinor`, `riderCommissionBps`,
`riderPayoutMinor`, `platformDeliveryShareMinor`) for review orders. These are
display-only simulated amounts, not payable earnings. Staff per-order financial
projections report zero money, and financial
collections, statements, exports and pricing totals exclude review orders even
with `includeReviewData=1`. Party order history and order invoices still show the
sample prices needed to inspect the normal app flow.

Review orders still cannot release supplier milestones, close as payout-released,
reserve or record refund transfers, settle refund money, or record supplemental/
delivery payments or supplemental payouts. These writes return
`409 review_data_money_forbidden`. Credit changes for marked accounts, voucher
grants, reservations and redemptions remain refused. The shared HTTP/store guard
cannot be bypassed with the reporting opt-in. Legacy issue-window completion can
close a review order but never automatically releases retention.

Post-delivery surveys remain available for review orders and marked clients.
If either the order snapshot or the current client is review data, survey reads
return `rewardEligible: false`, `reward: null` (when no reward was previously
issued), and `nextRewardAt: null`. Submitting saves the answers without creating
a voucher or campaign, using the existing no-reward `rewardStatus: "cooldown"`.
Clients must use `rewardEligible` to suppress the voucher promise. Ordinary
clients on ordinary orders retain the existing reward eligibility and issuance.

New order notifications, including Operations and Super Admin inbox copies,
carry `reviewData: true` and a `[Review data]` title prefix. Push data continues
to use its existing allowlist; the label is in visible notification copy.

## Errors

| Status | Error | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | A session is required. |
| 403 | `forbidden` | Only Super Admin can change an account mark. |
| 404 | `user_not_found` | The target identity does not exist. |
| 400 | `invalid_review_data` | Supply a boolean mark. |
| 400 | `reason_required` | Supply a nonblank reason within the limit. |
| 409 | `user_version_conflict` | Reload the user version before retrying. |
| 409 | `review_data_assignment_mismatch` | The new supplier/rider is in the other scope. |
| 409 | `review_data_money_forbidden` | Review data cannot move or reserve money. |
| 409 | `review_data_snapshot_immutable` | An existing order cannot be reclassified. |

The SQL snapshot constraint uses SQLSTATE `23514` for direct database updates.
All HTTP failures roll back the transaction, including audits and notifications.
