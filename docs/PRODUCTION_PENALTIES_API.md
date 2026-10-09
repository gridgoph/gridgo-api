# Late-production warnings and deductions

Backend contract for gridgoph/gridgo-api#123. Supplier-agreement wording and the
supplier/dashboard screens ship separately. **Do not enable production deductions
until the captain has checked the warning and policy wording.** This release defaults
to warnings only and performs no deployment or settings enablement.

## Deadline and tiers

The lifecycle sweep evaluates committed orders in `payment_authorized`,
`production`, or `supplier_self_qc`, plus orders with a recorded `readyAt`.
Lateness is measured from the shop's `readyBy`, not the padded client `promiseBy`
or delivery time. Once present, `readyAt` fixes the finish time. Orders created
after the [operating-hours rollout](OPERATING_HOURS_API.md) measure the thresholds
below in their snapshotted platform operating hours. Older orders retain wall-clock
hours. Applied penalties are never recalculated.

- Minor: more than zero and at most six hours late.
- Moderate: more than six and at most 24 hours, with a formal warning.
- Severe: more than 24 hours, or a missed deadline with Operations-confirmed
  absence of communication. Sets `productionReassignmentEligible: true` on the
  private supplier/Operations order projection. It does not reassign anything.

There is no agreed-reschedule feature yet. `productionDeadline(order)` in
`src/production-penalties.js` is the explicit integration hook for the approved
renewed deadline when that feature ships. Do not use unapproved supplier dates.

Communication outside the API cannot be inferred from missing app activity.
Operations/Super Admin can record their finding with
`POST /orders/:id/production-no-communication`, body `{ "reason": "..." }`.
It requires an active, unfinished, overdue production order and an audited reason;
repeated calls do not create another warning. Suppliers cannot call this route.
It produces `{ lapses: [...] }`. Invalid timing returns
`409 production_deadline_not_missed`; missing reason returns `400 reason_required`.

## Settings handshake and safety gate

`GET /settings` returns `version` and `settings.productionPenalty`:

```json
{
  "deductionsEnabled": false,
  "minorBps": 500,
  "moderateBps": 1500,
  "severeBps": 3000
}
```

Only Super Admin may include `productionPenalty` in `PATCH /settings`, even if
unchanged. Submit the complete object with `expectedVersion` and a nonempty
`reason`. Rates are integer basis points, 0–10,000 inclusive, in nondecreasing
tier order. The gate is a JSON boolean. Invalid values return
`400 invalid_production_penalty`; stale/missing version returns
`409 settings_version_conflict`; Operations or other roles receive `403 forbidden`.
Other existing settings retain their existing authorization.

The first warning snapshots all three rates, the current settings version, and
the gate. A warning-only lapse **stays warning-only** if deductions are later
enabled. Rate edits affect new lapses. Turning the live gate off also stops
pending deductions on previously enabled lapses. It does not reverse deductions
already applied. Warning and rank records continue when deductions are off.

## Warning, assessment, and payout

One durable `production_lapses` row exists per order. Each tier reached adds at
most one warning, so its warning history contains at most three entries. Warnings
and deductions write an audit event plus durable inbox rows for the supplier and
every Operations/Super Admin membership; push/realtime delivery follows `save()`.

The warning states the deadline, tier, percentage, remaining-balance cap, no
carry-over, ranking effect, whether deductions are off, and how to contact
Operations. Moderate and severe warnings have `formal: true`; severe warns about
reassignment eligibility. Example minor warning (default safety gate):

> This order missed its ready-by deadline of 2026-10-01T00:00:00.000Z. This is minor lateness. The penalty is 5% of what GRIDGO still owes your shop on this order, capped at that balance. Nothing carries over to another order. Recent late orders lower your quality ranking in matching. Deductions are off for this lapse; this is a warning only. Update the job and contact Operations if the deadline or circumstances need review.

With deductions enabled, a later transaction may assess **one deduction per
order**, once the job finishes or reaches severe lateness. Each escalation must
first commit its own warning. There are no repeated percentages or top-ups.
Until assessment, an enabled late order's payout release returns
`409 production_penalty_pending`. Warning-only orders retain ordinary releases.

The basis is the sum of unpaid, non-superseded shop payout stages at assessment.
The percentage uses integer minor units and BigInt half-up rounding, capped at
that remaining balance. Already released stages and the accepted order price
stay unchanged. Deduction is allocated from the last unpaid stage backwards:

- Stage `amountMinor` is the **net** amount Operations should pay.
- Stage `productionDeductionMinor` is the reduction; absent/zero means none.
- Their sum preserves the original versioned stage amount/share.
- `supplierSettlement.gridgoDeductionsMinor` totals reductions.
- The legacy response field `supplierEarningsMinor`, earnings, outstanding,
  protected funds, released amounts, and payout receipts
  use the net amounts. Client price, installments, service fee, and rider pay do
  not change. Deductions are not classified as service-fee revenue.

Claims and refund holds prevent deduction. A refund settlement or cancellation
closes a pending lapse without deduction; any already applied deduction remains
in the original stages. Refund settlements retain their separate negotiated
entitlement and payout. No deduction is taken from that separate settlement.
Database constraints reconcile deductions with the lapse ledger and original
stage shares and prevent changes to an applied lapse or released payout amount.

## Read endpoints for follow-up apps

| Endpoint | Access | Response |
| --- | --- | --- |
| `GET /me/production-lapses` | Supplier membership; caller's records only | `{ supplierId, lapses }` |
| `GET /users/:id/production-lapses` | Operations or Super Admin | `{ supplierId, lapses }` |

Unknown/non-supplier target is `404 supplier_not_found`; wrong role is
`403 forbidden`; unauthenticated is `401 unauthorized`. Records are sorted newest
first. There is no supplier write/override route.

Each lapse contains `id`, `orderId`, `supplierId`, `deadlineAt`, `detectedAt`,
`tier`, `rateBps`, `settingsVersion`, `policy` (snapshot), `warnings`,
`remainingBalanceMinor`, `deductionMinor`, `appliedAt`, `closedAt`,
`reassignmentEligible`, and `status` (`warning_only | warned | applied | closed`).
Each warning has `tier`, `at`, `message`, and `formal`. Amounts are integer PHP
minor units; zero amounts on an unassessed warning are not a payout quote.
Clients/riders do not receive lapse records, stage deductions, or private
reassignment/communication fields on order projections.

## Matching weight

Within the existing quality factor, subtract **two points per late order whose
missed deadline was in the last 30 days, capped at ten points out of 100**.
Count each order once, regardless of tier or deduction gate. Do not alter the
public review average. The four client factors remain strictly ordered, with
quality adjusted at its selected position; an earlier cost/speed/distance
preference still wins. Deadline feasibility filtering remains unchanged. This
is a modest quality adjustment, not a return to weighted total-score matching.
