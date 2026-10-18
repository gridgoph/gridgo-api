# Cancellation quotes and manually reviewed problem reports

Implements the narrowed 18 October 2026 decision for [tracker 221](https://github.com/gridgoph/gridgo-api/issues/221). This release adds an exact cancellation quote, automatic evidence gathering on existing issues, and an audited human fault/remedy record. All money is safe-integer PHP minor units (100 centavos = ₱1). All routes require Clerk authentication and current database membership.

The existing [manual refunds](REFUNDS_API.md), [issue window and claims](OPERATIONAL_MODEL_V2_API.md), and [net payout adjustments](PRODUCTION_PENALTIES_API.md) remain authoritative. This release adds no automatic fault attribution, payout freeze, recovery ledger, cross-order deduction, or payment execution. Existing issue-created claims and refund holds continue unchanged. There is no schema migration: evidence and decisions use `issues.data`; accepted quotes use append-only `refund_events.data`.

## Client cancellation flow

1. `GET /orders/:orderId/cancellation-quote` returns the current exact refundable cash amount. Access: owning client or Operations/Super Admin. It does not reserve funds or change the order.
2. Show `quote.refund` to the client and obtain confirmation.
3. As the owning client, submit `POST /orders/:orderId/refund-requests` with `kind: "cancellation"`, `reason`, and `cancellationQuoteToken`. Use the existing mandatory `Idempotency-Key` header. Optional destination and evidence follow the existing refund contract.
4. The API recalculates under the mutation transaction lock. A changed quote is refused with `409 cancellation_quote_stale`; fetch a fresh quote and obtain fresh client confirmation. Successful submission snapshots the quote, creates the existing refund request, and applies its existing work hold.
5. Operations reviews the receiving QR, records the stop-work/shop agreement, and settles through the existing endpoints. Both preview and settlement enforce the exact accepted refund components and entitlements. The order becomes cancelled on settlement. Operations reserves and records the manual transfer to the client's own receiving QR; the paid amount must equal the settlement. Acceptance or approval never means money has been sent.

Client quote response:

```json
{
  "quote": {
    "policyVersion": "cancellation_quote_v1",
    "quoteToken": "opaque-current-facts-token",
    "beforeProduction": false,
    "refund": {
      "principalMinor": 60000,
      "feeMinor": 6000,
      "deliveryMinor": 5000,
      "totalMinor": 71000
    }
  }
}
```

Confirmation example:

```json
{
  "kind": "cancellation",
  "reason": "Please cancel this order.",
  "cancellationQuoteToken": "opaque-current-facts-token"
}
```

The returned `{refund}` and subsequent refund reads add `cancellationQuote` with the same client-safe shape as `quote`. Staff see `{policyVersion, quoteToken, beforeProduction, amounts}`, where `amounts` is the existing settlement-preview calculation, including the shop/rider entitlement and collection breakdown. Clients never receive those internal amounts or supplier milestones. The token is opaque to callers, specific to the order's current facts, and is not permission to cancel another client's order. Quotes do not expire by time; confirmation checks the current facts. All quote, refund and issue responses use `Cache-Control: private, no-store`.

### Amount rules

Before production: return all remaining verified cash, including the collected service fee and unused delivery charge. An unpaid installment or voucher value is not refundable cash.

After production starts on payout plan 2: preserve the snapshotted 40% production-start shop entitlement whether already released or still owed. Refund the remaining collected principal, the proportional service fee under the existing refund formula, and unused delivery charge. If the start payout has not been released, the existing settlement creates the separate remaining shop payout item; it does not release the old milestone. Superseded stages, original amounts, collections and published payout plans retain the existing immutable settlement semantics.

Example: shop principal 100000, service fee 10000, delivery 5000, all collected. Before production the refund is 115000. After production starts the shop entitlement is 40000; the refund is 60000 principal + 6000 proportional service fee + 5000 delivery = 71000. A released start payout does not reduce the refund a second time.

Historical post-production payout plans, paid additional work, applied production deductions, active recovery/deadline requests, pending/direct collections and rider obligations require the existing staff review workflow instead of an automatic quote. Existing requests without a quote token keep their prior contract. Never present those legacy requests as a client-confirmed exact quote. A quoted settlement cannot silently change the accepted amount; before settlement, withdraw/reject through the existing flow and obtain a new client confirmation if reconciliation changes the facts.

| Error | Meaning |
|---|---|
| `cancellation_quote_stale` | Facts changed between quote and confirmation; re-quote. |
| `cancellation_quote_mismatch` | Proposed settlement differs from the accepted components or entitlements. |
| `cancellation_legacy_review_required` | Historical post-production payout plan needs staff review. |
| `cancellation_manual_review_required` | Additional paid work, deductions, recovery or deadline request needs review. |
| `cancellation_delivery_review_required` | Rider assignment/handover requires reconciliation. |
| `cancellation_after_delivery` | Use the problem-report/complaint flow. |
| `refund_state_conflict` / `refund_already_open` | Existing cancellation/settlement or active request. |
| `refund_collection_reconciliation_required` | Resolve pending, mismatched, noncash or direct collection. |
| `refund_no_available_funds` | No verified cash is available for this quote. |

Other existing refund authorization, version, idempotency, transfer and available-funds errors remain unchanged. No quote or decision grants an override of available funds.

## Problem report and automatic evidence

Use the existing `POST /orders/:orderId/issues` as the owning client while the order is `issue_window_open` and server time is strictly before `issueWindowExpiresAt`. The existing configurable window defaults to 24 hours after handover; this release does not change its duration, early confirmation or late-review behavior.

New client body:

```json
{
  "problemType": "damage",
  "description": "Damage was visible when the package was opened.",
  "photoFileIds": ["file_problem_photo"]
}
```

`problemType`: `material_quality | damage | wrong_item | delivery | other`. `description` (or existing `reason`) is a nonempty string up to 2000 characters. Upload one to ten distinct JPEG/PNG/WebP photos using existing purpose `refund_evidence`, then pass their IDs. They must be ready, unused and owned by the reporting client. The server binds them to this order during intake. Caller-supplied evidence snapshots are ignored. Old builds sending only `kind` and `description` remain compatible; their cases still gain automatic snapshots, with absent photos explicit.

Returns `201 {issue, claim}`. The existing one-open-issue and automatic linked-claim behavior is unchanged. Additions on the issue are `version: 1` and `photoFileIds`. The evidence bundle is staff-only and visible through the existing `GET /issues/:id` and `GET /issues?orderId=...` routes. Client/supplier projections omit the bundle and full decision history; supplier projections also omit problem photo IDs. Unrelated clients and riders cannot read the case. Private problem photo files remain readable only by the owning client and Operations/Super Admin.

Staff evidence shape:

```text
evidenceSnapshot: {
  version: 1,
  capturedAt: ISO timestamp,
  groups: [{id, kind, data}],
  files: [{fileId, purpose?, originalFilename?, detectedContentType?, size?,
           contentSha256?, state?, createdAt?, readyAt?, artworkCheck?, detected?,
           unavailable: boolean}]
}
```

The fixed group IDs are also valid decision citations:

| ID | Captured facts |
|---|---|
| `specification` | Order/line specifications and instructions, options, artwork links, snapshotted artwork guidance and accepted warning timestamps. |
| `approvals` | Recorded checkout/sample approvals and their original approved specification snapshots. Legacy missing approval remains missing. |
| `file_check` | Operations artwork review and checklist, if recorded. |
| `shop_qa` | Finished-product photos, QA decision and earlier submitted/reviewed attempts. |
| `rider_check` | Pickup counts/checks, inspection history, packed photo references and handoff signature. |
| `delivery` | Delivery photo/signature evidence and recorded delivery file references. |
| `client_photos` | The client's problem photos. |

`files` includes referenced evidence metadata and server `artworkCheck` pre-flight results; related production/handover evidence already attached to the order is also gathered. It excludes unrelated uploads, private object keys, account documents and payment QR data. Empty groups, missing fields and `unavailable: true` explicitly mean evidence was not recorded or is unavailable; they are never proof of consent or intact goods. Obtain current authorized download URLs through `GET /files/:fileId`; expiring signed URLs are not stored in the snapshot. Open-case retention already protects these referenced files. Later order edits do not change the captured snapshot.

Errors: `400 invalid_issue`, `invalid_problem_type`, `problem_photos_required`, `invalid_problem_photo`; `409 issue_window_closed`, `issue_already_open`; normal `401/403/404` authorization/not-found errors.

## Manual Operations decision

`POST /issues/:id/decision` is Operations/Super Admin only. It records a human finding; it does not determine fault from photos, initiate a remedy, pay money or change claims. Each successful write increments `issue.version`, appends `faultDecisionHistory`, writes an audit event, and notifies the client and every Operations/Super Admin membership.

```json
{
  "expectedVersion": 1,
  "fault": "shop",
  "remedy": "full_refund",
  "reason": "The reviewed production photo shows the defect before pickup.",
  "evidenceIds": ["shop_qa", "file_finished_photo"],
  "alternativesReason": "A reprint or replacement cannot meet the need; the entire job is unusable.",
  "costMinor": 150000,
  "gridgoCostMinor": 100001
}
```

`fault`: `shop | rider | gridgo | client`. `remedy`: `reprint | replacement | partial_refund | full_refund | none`. Client fault requires `none` with zero cost; other faults require a remedy. `reason` and, for either refund remedy, `alternativesReason` are nonempty strings up to 2000 characters. Cite one to fifty distinct gathered group IDs or evidence file IDs. Operations must verify that cited evidence supports its reason; the API does not interpret it.

`costMinor` is total remedy cost; `gridgoCostMinor` is the part GRIDGO funds, including a shop-fault advance. Both are nonnegative safe integers; GRIDGO's amount cannot exceed cost. Rider/GRIDGO fault requires GRIDGO to fund the full cost. A shop-funded reprint can have zero GRIDGO funding.

Response: `200 {issue}`. Staff receive:

```text
faultDecision: {
  id, fault, remedy, reason, evidenceIds, alternativesReason,
  costMinor, gridgoCostMinor, recordedBy, recordedAt,
  status: "approved" | "awaiting_approval",
  approvedBy?, approvedAt?, approvalReason?
}
faultDecisionHistory: [decision snapshots in write order]
version: integer
```

GRIDGO funding **above 100000** requires Super Admin approval. Operations can record a pending proposal; it is not authority to execute that remedy. Exactly 100000 can be approved by Operations. A Super Admin recording the decision approves it directly. Revisions use the current version and re-evaluate the threshold, so an earlier approval never approves a later amount.

`POST /issues/:id/approve-decision`, Super Admin only:

```json
{
  "expectedVersion": 2,
  "decisionId": "idecision_current",
  "reason": "The stated advance is approved."
}
```

This approves only the current pending decision and increments the version. Retry by reloading the issue; stale version requests never append another decision. These two decision endpoints use version concurrency, not the refund idempotency-key protocol.

Client/supplier `faultDecision` contains only `id, fault, remedy, reason, status, recordedAt, approvedAt?`; funding, staff identity and full history remain private. The client's reason must explain the finding in understandable terms.

Resolve the issue separately through the existing `POST /issues/:id/resolve`. Cases with a decision require its current `expectedVersion`; a pending funding approval prevents resolution (`fault_approval_pending`). Existing claim release remains explicit and independent. Refund complaint settlement and new transfer reservations also refuse an awaiting-approval case, client fault or a recorded non-refund remedy. Successful existing transfer retries/reconciliation remain available. The manual refund amount is still bounded by the existing available-funds policy.

Errors: `400 invalid_fault_decision`, `fault_reason_required`, `fault_evidence_required`, `fault_client_no_refund`, `invalid_fault_funding`, `invalid_refund_amount`; `403 forbidden`, `fault_super_admin_required`; `409 issue_stale` (with `currentVersion`), `issue_closed`, `fault_decision_conflict`, `fault_approval_pending`, `fault_refund_not_authorized`.

## Written Operations rules

Use the custody evidence in chronological order. The party holding the goods when damage first appears carries the fault. A client's later discovery alone does not prove who held the goods when the damage occurred. Missing evidence requires a documented human investigation; never fabricate consent, inspection or a signature.

- **Shop fault:** seek a reprint at the shop's expense, otherwise refund. Unreleased payouts remain subject to the existing claim/refund holds. Any 40% start payout already paid is recovered only from future earned payouts through the existing net adjustment process.
- **Rider fault:** GRIDGO pays the remedy and the shop is paid in full; record the incident in the rider's operational record manually.
- **GRIDGO fault:** GRIDGO pays the remedy. Above ₱1,000 of GRIDGO funding, obtain Super Admin approval before executing it.
- **Client fault:** an accepted, relevant warning or a print that matches the approved specification can support no refund. Explain the reason and reviewed evidence to the client. An unrecorded warning is not an accepted warning.

Consider remedies in order: reprint or replacement, partial refund, full refund. Record why earlier remedies are unsuitable. Restore an unexpired order voucher when fault is not the client's through the existing refund/voucher workflow; never refund voucher value as cash. Give the client the outcome within the usual two business days and document communications and any delay. This release does not add an automated response deadline or reminders.

**Q2 A funding decision:** GRIDGO fronts a shop-fault gap so the client receives the full agreed refund within the usual two business days. Recover that advance only from the shop's future **earned** payouts; never create a negative balance, spend unearned future money, or alter a published payout plan. Include the advance in `gridgoCostMinor`; above ₱1,000 needs Super Admin approval. Record the funding, approval, eventual external payment and later net adjustments in the existing audited operational processes.

This narrow release records that funding decision as guidance and a case approval; it does not add a funding override to the available-funds refund ledger. If a protected prior payout makes the existing refund route reject the full amount, Operations must arrange and document the approved manual advance outside that ledger rather than falsify collection, releases or settlement amounts. Do not claim the case decision itself paid the client. A future funded-refund API/recovery implementation is outside this release.

Stop and escalate if legal review says the existing 24-hour reporting limit cannot stand, or if proposed recovery would take funds the shop has not earned. This implementation does not change those rules or represent a legal review.
