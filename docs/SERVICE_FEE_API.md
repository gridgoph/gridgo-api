# Progressive service fees

Report 5A07D2C2. All money is safe-integer PHP centavos; rates are integer basis points.
The backend ships the report's table for newly priced groups:

| Shop subtotal slice | Rate |
| --- | --- |
| First PHP 2,000 (`200000` minor units) | 4,500 bps |
| Above PHP 2,000 through PHP 20,000 (`2000000`) | 2,500 bps |
| Above PHP 20,000 | 1,500 bps |

These are marginal brackets. A PHP 5,000 shop subtotal costs PHP 900 + PHP 750 =
PHP 1,650 in gross GRIDGO fees, not 25% of the whole subtotal. The reference
examples are PHP 500 → 225; 1,999 → 899.55; 2,000 → 900; 5,000 → 1,650;
20,000 → 5,400; 50,000 → 9,900.

`src/service-fee.js` sums exact BigInt `sliceMinor * rateBps` numerators and rounds
**half-up once per shop/deadline group**: `(sum + 5000) / 10000`. Working rows use
differences of rounded cumulative fees, so their `amountMinor` values add exactly
to the fee even when custom bracket limits create fractional centavos. No floats
or per-bracket independent rounding are used. Unsafe inputs or totals are refused.

## Operational Settings: dashboard follow-up

`GET /settings` retains its `{version, settings, operatingStatus}` envelope.
Only Operations/Super Admin receive `settings.serviceFeeSchedule` and
`settings.scheduledServiceFee`. Other roles never receive the table or its working.
The legacy `serviceFeeRateBps` field remains for old consumers and flat snapshots;
it does not price new groups when a bracket schedule is present.

Super Admin changes the table through the existing audited `PATCH /settings`:

```json
{
  "expectedVersion": 43,
  "reason": "Review service fee brackets",
  "serviceFeeBrackets": [
    { "upToMinor": 200000, "rateBps": 4500 },
    { "upToMinor": 2000000, "rateBps": 2500 },
    { "upToMinor": null, "rateBps": 1500 }
  ],
  "serviceFeeEffectiveFrom": "2026-12-01T00:00:00+08:00"
}
```

Omit `serviceFeeEffectiveFrom` for immediate effect. An explicit date must be an
ISO timestamp with timezone, at or after server time. Limits must be strictly
increasing positive safe integers; the last limit must be `null`. There must be
1–20 brackets, with integer rates 0–10000. Invalid tables return
`400 invalid_service_fee_schedule`; invalid dates return
`400 invalid_service_fee_effective_from`. A date without a table returns
`400 service_fee_brackets_required`.

The existing `expectedVersion` compare-and-swap, required reason, Super Admin
write permission and incremented settings version still apply. A future update
replaces the one pending schedule. An immediate update replaces the effective
table and clears any pending schedule. Replacing a pending update uses the same
handshake and audit trail; there is no separate unaudited cancellation route.

`POST /settings/service-fee/preview` is read-only for Operations/Super Admin. Send
`expectedVersion`, `serviceFeeBrackets` and optional `serviceFeeEffectiveFrom` as
above; a reason is not required for preview. The response contains `version`,
`current`, `proposed`, and `examples`. Each example has `shopPriceMinor` and
`previous`/`next` fee results (`grossServiceFeeMinor`, `serviceFeeSchedule`,
`serviceFeeWorking`). Preview always compares today's effective table against the
proposed table, including when the proposal starts in the future. A stale version
returns `409 settings_version_conflict` for both preview and save. Preview writes
no settings or audit rows. Save audits the complete previous/current settings in
the append-only log.

A schedule has `version: 2`, `rounding: "half_up_once"`, `brackets`, and, for
settings edits, `settingsVersion` and normalized UTC `effectiveFrom`. The pending
table becomes effective at that instant on reads; no timer or boot-time schema
operation is needed. The stored `serviceFeeSchedule` is the baseline and
`scheduledServiceFee` remains as scheduled evidence after its date; resolve the
latter whenever its date has arrived. The next settings edit materializes the
currently effective baseline before replacing a future proposal.

## Locking and legacy compatibility

A shop/deadline cart group locks its schedule when first priced. Every line stores
that group's schedule in `client_cart_lines.service_fee_snapshot`. Added/edited
lines in the same group use its locked schedule. Removing its last line ends the
lock. A line moved to another deadline inherits that destination group's schedule,
or the currently effective table when that destination is new. Changing supplier
prices/quantities still changes the shop subtotal under the locked fee table.

Checkout calculates once per shop/deadline group and snapshots the table, fee,
bracket working and existing money allocations on each group order and invoice.
Multiple groups at the same shop have independent brackets, matching the existing
independent deadline/payment contracts. Combined basket totals sum those groups.
For bracket receipts and cart displays, fee-inclusive line amounts apportion the
fixed group fee by shop principal using largest remainders (ties in line order).
They sum exactly to the group printing total. Unit/catalog display prices remain
indicative; use configured quotes and group totals for checkout.

Supplier-issued pending quotes snapshot their fee table when issued. Accepting an
open quote uses its table even after an effective-date change. Explicitly issuing
a replacement quote uses the currently effective table and retains the prior quote
in history; it still requires the existing supersession reason and client acceptance.
Stateless catalog quote requests are estimates, not accepted commitments; adding a
line establishes the cart group's lock.

Migration `1792037400000` freezes existing cart lines and pending quotes under the
pre-migration flat rate before enabling the table. Existing orders/invoices retain
their flat `serviceFeeRateBps` and amounts unchanged. Version-1 schedule snapshots
use `{version: 1, rateBps}`. Version-2 orders have `serviceFeeRateBps: null`; never
infer a single whole-order rate for them. Fresh reference seeds install the bracket
table, but do not create users or operational records. The migration records its
previous/new settings in the append-only audit log.

## Discounts, refunds and payout

Calculate the gross fee first. The organization discount remains a percentage of
the shop principal, rounded half-up and capped at the gross GRIDGO fee. It never
reduces shop principal or delivery. Bracket vouchers are capped at GRIDGO's fee
and cannot spill into delivery. The existing better-of rule remains: voucher and
organization discounts do not stack; organization wins a tie. Older flat-snapshot
voucher funding, including delivery funding, remains unchanged.

Invoices explain the stored table, not current settings. Refunds prorate the
actual snapshotted net fee paid (after discount/voucher), preserving the existing
cumulative refund rounding and available-funds rules; they do not apply today's
brackets to the remaining principal. Supplier payouts still derive only from
snapshotted shop principal; delivery splits remain unchanged. Organization
statements sum immutable order totals and discounts. Settings edits cannot change
any of these amounts. PostgreSQL checks bracket arithmetic and prevents changes
to committed schedules/working.

## Client privacy and staff money panel

Clients continue to receive combined fee-inclusive printing prices, their existing
discount lines, fulfillment charge and total. Bracket tables, rates and working are
never added to client orders, quotes, carts or invoices. Legacy catalog fields remain
during the documented compatibility window; do not derive a checkout price by
summing marked-up catalog components.

Operations/Super Admin order detail and invoice responses expose
`serviceFeeSchedule` and `serviceFeeWorking` alongside `supplierSubtotalMinor`
(`itemSubtotalMinor` on invoices), `grossServiceFeeMinor`, `organizationDiscountMinor`,
`voucherDiscountMinor`, net `serviceFeeMinor`, delivery and total. Each working row
contains `fromMinor`, `upToMinor`, `rateBps`, `taxableMinor`, and `amountMinor`.
For vouchers, subtract `voucherServiceFeeMinor` from `serviceFeeMinor` to obtain
net fee collected. Combined receipts retain each group's own table and working.
The dashboard settings screen and money-panel rendering are a separate follow-up.
