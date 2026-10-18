# Review data

Review data supports isolated store-review accounts. It grants no membership,
approval, authentication bypass, or payment authority. Existing records default
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

- `/orders`, `/jobs`, `/claims`, `/issues`, `/escalations`, `/refund-requests`;
- `/ops/riders/locations`, `/ops/colour-price-checks`, `/ops/shop-failures`,
  `/ops/hub/*`, `/ops/shops[/<id>]/performance`;
- `/ops/finance/supplier-invoices`, `/admin/shop-rankings`, `/admin/pricing`;
- `/admin/survey-responses`, `/admin/pricing-feedback`,
  `/admin/checkout-exit-feedback`, `/admin/voucher-redemptions`;
- organization statements and their CSV/PDF exports;
- audit reads and CSV exports.

Filtering happens before counts, pagination and totals. Related jobs, line
items, invoices, claims, refunds, adjustments and performance records follow
the order snapshot. Pricing revenue, costs, funnel counts and the current-month
close calculations exclude review data. Funnel events also snapshot the mark
at insertion, so clearing an account cannot introduce old review activity into
the dashboard. Checkout-exit feedback without an order follows its current client
account mark. Ordinary behavior remains the default for unmarked data.

The opt-in is honored only for Operations/Super Admin readers and does not grant
access to any route. Organization and supplier invoice totals exclude review
orders for ordinary callers, even if they send the flag. Explicit order detail
and party-owned order history retain existing authorization so review accounts
can inspect their own work. Review order projections carry `reviewData: true`.
Audit entries about marking users remain visible by default; order-linked review
audit entries require the opt-in.

## Money and notifications

Review orders cannot submit/confirm collections, release supplier milestones,
close as payout-released, reserve or record refund transfers, settle refund
money, or record supplemental/delivery payments or supplemental payouts. These
writes return `409 review_data_money_forbidden`. Credit changes for marked
accounts, voucher grants, reservations and redemptions are also refused. The guard is shared by HTTP and store writers and
cannot be bypassed with the reporting opt-in. Legacy issue-window completion
can close a review order but never automatically releases retention.

This is an isolation mechanism, not a simulated payment processor. Normal
payment confirmations and payout routes remain unavailable to review orders.
Future sample-record provisioning must preserve this boundary.

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
