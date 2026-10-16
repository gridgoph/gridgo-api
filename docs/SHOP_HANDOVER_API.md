# Shop-to-rider handover

Report 6C695C15 changes packing order, not payout plans. This contract supersedes
the supplier packing-photo prerequisite **only for `handoverFlow: "rider_packs"`**.
Receipt/invoice scans remain **optional**: the report described an existing
receipt gate, but the invoice and readiness contracts do not have one. Missing
scans never block production, dispatch or payout.

## Compatibility and rollout

Migration `1792029000000` snapshots `shopHandoverVersion` in `orders.data`:

- Every payout-plan-1 order keeps the legacy handover and supplier proof rules,
  including the 15% packaging milestone. No published payout share, proof owner
  or eligibility state changes.
- Existing plan-2 orders before readiness use version 2. Orders already ready,
  assigned, collected or later retain version 1, including orders with a past
  readiness timestamp/history even if their current state was corrected back.
- New commercial commitments snapshot version 2. No current order is rewound.

Related supplier/rider and staff order projections expose `handoverFlow` as
`rider_packs | legacy`. Use this field rather than guessing from dates or payout
amounts (riders never receive payout plans). The supplier and rider apps must
ship the new flow before users can complete these new gates; old clients cannot
silently bypass them. Existing legacy pickup requests remain valid.

Supplier app labels: **Ready for rider pickup**, replacing **Package for pickup**
and **Mark package ready**. At readiness and call-rider confirmation, show:
**Prepare packing materials. Do not pack yet; the rider checks the unpacked
items first.** Update the packaging instructions screen accordingly. Keep
receipt upload visibly optional.

## Production finished and GRIDGO QA

The supplier uploads JPEG/PNG/WebP with `purpose: "finished_product_photo"` and
attaches it using `POST /files/:fileId/attach {orderId}` while in `production`.
Only ready files belonging to the assigned approved supplier count. Start-of-
production photos, generic `production_photo` and payout proofs do not substitute
for finished-product evidence. The new purpose uses the existing 200 MiB image
limit and private file retention/read rules.

1. Assigned approved supplier: `POST /orders/:id/production-finished {}`.
   Requires at least one attached finished-product photo not used in a previous
   review attempt. Moves `production -> supplier_self_qc`; records the immutable
   submitted photo IDs in `shopHandover.finished` and alerts both staff roles.
2. Operations/Super Admin: `POST /orders/:id/production-review` with
   `{ "decision": "approved" }` or
   `{ "decision": "rejected", "note": "Reprint the damaged copies" }`.
   The photo snapshot must still be available. Rejection requires a nonblank
   note, returns to `production`, and requires new photos for resubmission.
   Each reviewed attempt remains in `shopHandover.attempts`; approval cannot be
   overwritten by a second review request.
3. Assigned supplier: existing `POST /orders/:id/transition`
   `{ "state": "ready_for_dispatch" }`. Requires finished evidence and approved
   QA, with no active claim/refund/recovery/reschedule work hold. **No packed
   photo is required.** Existing ready-time snapshots, dispatch offers and
   notifications follow this transition. The supplier prepares materials only.

`shopHandover.finished` has `{at, by, supplierId, photoFileIds}`; `review` has
`{at, by, decision, note}`. Staff and the assigned shop/rider can read this
workflow evidence. Clients receive signed finished photos in `productionProgress`
and plain progress, without internal reviewers, notes or raw workflow fields.

Refusals include `finished_product_photo_required`,
`finished_product_photo_upload_not_allowed`, `production_finished_required`,
`production_review_required`, `production_finish_not_available`,
`production_review_not_available`, `production_review_note_required` and
`handover_flow_not_available`. State/evidence refusals are 409; invalid review
bodies/notes are 400; wrong roles/parties are 403.

## Rider inspection, packing, pickup

The approved assigned rider accepts dispatch as before. All actions below occur
while `rider_assigned`; none allows an Operations pickup bypass.

1. If the shop presents an already-packed job, record
   `POST /dispatch/:id/arrived-packed {}` **before inspecting**. Tell the shop to
   unpack it. The mark does not excuse inspection and cannot be removed. It is
   idempotent per rider assignment, stores supplier/rider/time, alerts staff and
   writes `order.arrived_packed`. Staff order projections include
   `shopArrivedPackedCount`, the count of recorded incidents for that shop across
   orders, for its performance record. This is an incident count, not an automatic
   deduction, rating adjustment or matching penalty.
2. Submit existing `POST /dispatch/:id/pickup-checklist` with all six `checks`
   and exact per-line `counts`. Count, specification, visible defects and paperwork
   are checked on the **unpacked products**. `packaging_integrity` checks the
   prepared packing materials; `supplier_sign_off` records the joint check.
   The actual supplier signature remains at final custody transfer. All existing
   count mismatch and failure-photo/escalation rules remain. A failed attempt
   transfers nothing and requires Operations resolution followed by a recheck.
3. Six passes now return `pickupChecklist.status: "inspected"` with an
   `inspectionId`, server `completedAt`, rider `completedBy`, checks and counts.
   **State stays `rider_assigned`.** Passing inspections are retained in
   `shopHandover.inspections` for fault/refund review. A signature in this request
   cannot advance custody.
4. Pack in front of the rider. In the rider app, take/upload `packing_photo`,
   then attach `{orderId}`. Only the assigned approved rider can attach it for
   this flow, after a successful inspection. The reference snapshots the current
   inspection ID. It records `order.rider_packing_photo`, not a payout proof.
5. Capture the supplier signature on the rider phone, upload/attach the existing
   `handoff_signature` purpose, then call:

   ```http
   POST /dispatch/:id/pickup-confirm
   ```
   ```json
   { "signature": { "fileId": "file_opaque", "signerName": "Ana Reyes" } }
   ```

   Confirmation uses the **server-stored inspection checks/counts**, ignoring any
   replacement checks/counts in the request. It requires a ready packed photo
   and signature attached for that inspection by the current rider. It moves to
   `picked_up`, retains `inspectionId`, `inspectedAt`, `packedPhotoFileIds`, and
   the existing signature/checklist digest in `pickupChecklist`. Payout amounts,
   milestones and payment records do not change.

A repeat passing inspection creates a new ID: old packed photos and signatures
remain evidence but cannot satisfy the new pickup. Reassignment similarly
invalidates another rider's inspection. Holds and open escalations block final
pickup and packing attachment. There is no direct transition to `picked_up`.

New refusals: `409 unpacked_inspection_required`, `409 packing_photo_required`,
`409 pickup_held`, `409 arrived_packed_not_available`; existing signature,
count, escalation and hold errors remain. Operating hours never refuse these
steps once the rider is assigned ([Operating hours](OPERATING_HOURS_API.md#work-gates-and-prospective-sla-clocks)).
A legacy order cannot use `/pickup-confirm`; its existing single
checklist-plus-signature endpoint still completes pickup.

Attaching `handoff_signature` reports the first missing step in order: with no
current inspection by this rider it returns `409 unpacked_inspection_required`;
with an inspection but no packed photo for it, `409 packing_photo_required`. A
client that never inspected is therefore sent back to the checks, not to the
packing photo.

### Rider client refusal codes

Every refusal a rider app can meet on an assigned trip, by route. Show plain
words for each; never fall back to a generic "not recorded" message.

| Route | Codes |
|---|---|
| any of these routes | `403 forbidden`, `403 rider_not_approved`, `404 order_not_found`, `409 reschedule_fulfillment_stopped`, `409 shop_recovery_pending`, `409 refund_fulfillment_stopped` |
| `POST /dispatch/:id/accept` (new dispatch) | `409 not_offerable`, `409 dispatch_paused`, `409 pickup_fulfillment_not_available`, `409 outside_operating_hours` (with `scheduledReviewAt`) |
| `POST /dispatch/:id/arrived-packed` | `409 arrived_packed_not_available` |
| `POST /dispatch/:id/milestones` | `400 invalid_delivery_milestone`, `409 delivery_milestone_not_available` |
| `POST /dispatch/:id/pickup-checklist` | `409 pickup_checklist_not_available`, `409 pickup_escalation_open`, `409 claim_hold_active`, `409 pickup_count_unavailable`, `400 invalid_pickup_checklist`, `400 invalid_pickup_counts`, `400 checklist_evidence_required`, `400 invalid_checklist_evidence`; legacy flow also `409 handoff_signature_required`, `400 handoff_signer_name_required`, `400 invalid_handoff_signature` |
| `POST /dispatch/:id/pickup-confirm` | `409 handover_flow_not_available`, `409 pickup_checklist_not_available`, `409 pickup_escalation_open`, `409 claim_hold_active`, `409 unpacked_inspection_required`, `409 packing_photo_required`, `409 handoff_signature_required`, `400 handoff_signer_name_required`, `400 invalid_handoff_signature` |
| `POST /files/:id/attach` `packing_photo` | `409 unpacked_inspection_required`, `409 pickup_held` |
| `POST /files/:id/attach` `handoff_signature` | `409 unpacked_inspection_required`, `409 packing_photo_required`, `409 handoff_signature_upload_not_allowed` |
| `POST /files/:id/attach` `delivery_photo` | `409 delivery_photo_upload_not_allowed` |
| `POST /orders/:id/transition` `out_for_delivery` | `409 transition_not_allowed` |
| `POST /dispatch/:id/delivery` | `409 delivery_not_available`, `409 final_payment_not_confirmed`, `409 pof_required`, `400 invalid_delivery_evidence_type`, `400 delivery_evidence_required`, `409 handover_not_ready`, `409 handover_already_completed`, `409 handover_otp_mismatch`, `429 handover_attempts_exceeded` |

General file errors on upload/attach (size, type, state) are in
[STORAGE_API](STORAGE_API.md).

The `packingProgress` gallery includes signed rider photos for the owning client,
assigned supplier/rider and staff. Unassigned riders and unrelated users cannot
read them. Legacy supplier packing photos remain unreadable by riders. Raw
`packingPhotoFileIds` and `finishedProductPhotoFileIds` are never projected.
Evidence uses normal private files, retained for refund/fault decisions under
`STORAGE_API.md` retention and open-case holds.

## Forced steps and audit

Existing staff production corrections remain the only forced handover edges:
`production -> supplier_self_qc`, `production -> ready_for_dispatch`, and
`supplier_self_qc -> ready_for_dispatch`. For **both flows**, request:

```json
{
  "state": "ready_for_dispatch",
  "reasonCode": "evidence_verified_offline",
  "reason": "Inspected the finished work at the counter during the upload outage"
}
```

`reasonCode` must be `technical_issue | evidence_verified_offline |
operational_correction | other`; `reason` is the mandatory trimmed note, at most
2000 characters. Staff projections expose `forcedStepReasonCodes`. Missing note
is `400 production_override_reason_required`; invalid/missing code is
`400 production_override_reason_code_required`; excessive note length is
`400 production_override_reason_too_long`.

Every correction, even if all evidence exists, appends a `forcedSteps` record
with actor, role, server time, from/to, reason code/note and the server-computed
`skippedChecks`. It atomically appends `order.production_override` to the permanent
append-only audit log from the Audit API. The order exposes `forcedByGridgo: true`:
all apps should render **Forced by GRIDGO**. Detailed reasons/actors are scoped
to staff and the assigned supplier/rider; clients get the tag only. Historical
corrections without this new record retain their existing audit evidence.

A correction never invents photos, QA approval, successful counts, a signature
or a rider packed photo; the actual missing checks are audited. Claim/refund/
recovery/reschedule holds cannot be skipped. Staff assignment, ordinary QA
review and payout release are their existing governed actions, not new force
routes. No new force privilege bypasses rider checks or money gates.

New audit actions also include `order.production_finished`,
`order.production_review`, `pickup_checklist.inspected`,
`order.rider_packing_photo`, `order.arrived_packed`; final custody retains
`pickup_checklist.handoff_signed`. Operations audit scope remains correction/
deletion-only; Super Admin retains the full searchable audit. Staff can review
handover evidence on the authorized order projection. Notifications and refresh
hints use the existing transactional inbox/outbox boundary, including durable
inbox rows for both staff memberships.

## Production timing while GRIDGO reviews

Only version-2 handovers exclude staff QA waiting time. While a submission is
pending, the shop's effective lateness clock freezes at its submission timestamp;
no new production deduction can apply during that wait. Approval finalizes that
submission as the shop's finish, even if approval/readiness happens days later.
On rejection the shop clock resumes, excluding the complete submission-to-review
interval. Repeated rejected attempts accumulate only their actual staff review
intervals, measured in the order's snapshotted operating calendar (wall clock for
orders without one). Replacement shops never inherit another shop's QA credit.

This common clock governs lapse warnings/tiers, payout-release assessment,
no-communication eligibility and on-time matching statistics. Already-late shops
can retain a warning while review is pending; they cannot become later simply
because staff has not reviewed them. Approved production counts as finished for
on-time statistics. Pending review does not. The `readyBy` promise and actual
`readyAt` dispatch-readiness snapshots stay unchanged. Applied deductions are
never recalculated. Legacy handovers retain their existing clock and payout
rules. This implements the approved resolution of the QA timing conflict.
