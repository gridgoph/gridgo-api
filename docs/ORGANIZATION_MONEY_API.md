# Organization discount and statements

Refs gridgoph/gridgo-client#166 and gridgoph/gridgo-client#160.

## Eligibility

The database must contain a client membership, `users.accountType = organization`,
an approved `business_client` approval case, and an active account. Neither a pending
application, an organization name, nor Clerk claims grant these benefits. Approval
is checked again at checkout and at every statement/export request. Existing order
snapshots survive a later suspension or settings change.

## Discount and checkout

`organizationDiscountRateBps` defaults to **500 (5%)**. Like the service fee, its
base is the shop's printing subtotal, excluding delivery and hub pickup. Round to
minor units independently for each shop group. For PHP 100 printing at a 10% fee:
Printing is PHP 110, Organization discount is -PHP 5, and printing payable is PHP 105.
Delivery is added unchanged. Supplier principal remains PHP 100.

`PATCH /settings` (Super Admin, existing `expectedVersion` and audited `reason`)
accepts integer `organizationDiscountRateBps` from 0 to 10000. Both directions of
an invalid fee/discount combination return `400 organization_discount_exceeds_service_fee`.
Malformed discount rates return `400 invalid_organization_discount`. The final
combined settings must have `serviceFeeRateBps >= organizationDiscountRateBps`.
PostgreSQL also enforces this floor. Migration refuses an existing below-floor
configuration; it does not silently raise the service fee.

Client integration:

- `GET /me/carts/:id` and cart mutations: `cart.clientQuote.organizationDiscountMinor`
  and `cart.groups[].organizationDiscountMinor`; `clientItemSubtotalMinor` is gross
  Printing (fee included), and `totalMinor`/payment amounts are after the discount.
- `POST /me/carts/:id/checkout`: `order.organizationDiscountMinor`,
  `invoice.organizationDiscountMinor`, and, for baskets,
  `basket.groups[].organizationDiscountMinor` and `invoice.groups[].organizationDiscountMinor`.
- `GET /orders`, `GET /orders/:id`, `GET /baskets/:id`,
  `GET /orders/:id/invoice`, `GET /baskets/:id/invoice` preserve these snapshots.
- Render positive `organizationDiscountMinor` as **Organization discount -₱X**,
  formatting minor units as pesos; subtract it exactly once. Printing includes the
  gross fee. Organization client checkout/order/invoice projections omit fee amounts
  and rates. The existing `serviceFeeVisibleToClient` setting remains the control for
  fee explanatory copy, never a reason to itemize a fee amount. The discount line
  remains visible regardless of that switch.
- The legacy quote-acceptance transition also applies the same approved-account gate
  and snapshots the discount in the accepted quote.

Staff/finance integration: existing Operations/Super Admin order list/detail and
basket endpoints retain `grossServiceFeeMinor`, `organizationDiscountRateBps`,
`organizationDiscountMinor`, and `serviceFeeMinor` (**net** service fee). Every
committed order's `platformRevenue` adds `grossServiceFeeMinor`,
`organizationDiscountMinor`, and `netServiceFeeMinor`. Billed/collected/recognized
revenue uses the net fee and existing delivery share. The audited checkout snapshot
records the discount; immutable order data and payment allocations persist atomically.
No supplier payout stage, payout entitlement, delivery fee, or rider split changes.
A basket owns one payment but each group owns its own discount and finance record.

## Statements

- Client: `GET /me/organization/statements`
- Operations/Super Admin: `GET /ops/organizations/:clientId/statements`
- Query: `period=this_month` (default), `period=this_quarter`, or
  `from=YYYY-MM-DD&to=YYYY-MM-DD` (optionally `period=custom`). Dates are inclusive
  **Asia/Manila** calendar dates, maximum 366 days.
- `format=json` (default), `format=pdf`, or `format=csv`. Exports are attachment
  responses with private/no-store cache headers; files are generated on demand and
  are not persisted. The JSON shape is `{ statement: { notice, currency, period,
  orderCount, totalSpendMinor, discountEarnedMinor, orders } }`.
- Each row contains `date`, `closedAt`, `orderId`, `product`, `amountMinor`,
  `organizationDiscountMinor`, `invoiceNumber`, `officerOfRecord`.
- Closed means `completed` or `payout_released`. The period uses the first closed
  timeline timestamp (fallback: explicit `closedAt`/`completedAt`), not creation
  time or a later payout update. Undated historical rows are excluded rather than
  assigned a guessed closure date. Cancelled/open orders are excluded.
- Each shop-group order counts once, even when groups share a basket invoice.
  Spend is the sum of committed order totals after organization discounts;
  discount earned is the sum of immutable order discounts (legacy missing = zero).
  This is an order-spend summary, not a refund, cash-movement or tax ledger.
- Every representation says **Not a tax document. Official receipts are issued
  separately.** Existing per-order official-receipt handling is unchanged.
- The officer field defensively reads an immutable `order.officerOfRecord` or
  receipt `snapshot.officerOfRecord` (string or `{ name }`). It stays blank when
  absent; it never substitutes today's officer or the account display name.
  The upstream officer-of-record implementation (#164) is built separately and
  is not present on this branch's base.
- `401 unauthorized` for unsigned requests; `403 forbidden` for a wrong role;
  `403 organization_approval_required` for non-approved/non-organization accounts;
  `400 invalid_statement_period`/`invalid_statement_format` for invalid queries.
  Unsafe aggregate totals return `409 statement_total_too_large`.

PDF uses an embedded, licensed Unicode font and paginated text with wrapping. CSV
is UTF-8 with BOM, RFC-style quoting and spreadsheet-formula neutralization.
