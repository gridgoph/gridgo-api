# Supplier job readiness and readable details

Version-2 handovers supersede the legacy photo gates below: see
[Shop handover](SHOP_HANDOVER_API.md) for finished-product QA, rider packing and
forced-step reasons. Receipt scans remain optional in both flows.

Report 6C695C15. Supplier app and supplier web must adopt this additive contract.
No production order was inspected or changed during backend implementation.

## Packaging rules and reproduction

The existing policy is unchanged:

- `production -> supplier_self_qc` requires an attached, ready supplier production image.
- `production -> ready_for_dispatch` and `supplier_self_qc -> ready_for_dispatch`
  additionally require a separate attached `packing_photo` image.
- A start-of-production or legacy printing/packaging payout **image** counts as
  production evidence. A PDF payout proof, an unattached upload, another shop's
  file, or a packing-only photo does not satisfy that requirement.
- Both photo purposes can be attached only in `production` or `supplier_self_qc`.
  Upload first, wait for `ready`, attach with `POST /files/:fileId/attach` and
  `{orderId}`, then refresh the order before advancing it. The attachment
  response also includes the refreshed order projection.
- Open/payout-held claims and independent refund, replacement and deadline
  holds still stop work. Operations cannot bypass those holds. Staff photo
  corrections still require an audited reason.
- Supplier invoice/receipt scans remain **optional**. Their absence never
  disables packaging or dispatch. The separate packing-at-rider proposal is
  outside this change.

PostgreSQL HTTP reproduction covers both transition edges, the attachment
window, production and packing evidence, open claims, staff corrections and
invalid transitions. Valid attached evidence passed on the base code; no
incorrect photo gate was reproduced. The confirmed backend gaps were missing
preflight data, refusal audit entries and display projections.

## Before enabling the action

Assigned suppliers and Operations/Super Admin receive `transitionReadiness` on
ordinary order projections, including `GET /jobs`, `GET /orders/:id`, order
lists and successful attachment/transition responses. Other roles do not receive
it. It is derived, never accepted from request JSON or persisted as order facts.
Operations sees the **supplier's** checklist here, not permission to override.

```json
{
  "transitionReadiness": {
    "supplier_self_qc": {
      "allowed": false,
      "missing": [{
        "code": "production_photo_required",
        "message": "Attach at least one production progress photo before marking this job packed or ready for dispatch. A start-of-production photo counts."
      }],
      "receiptScan": { "required": false, "attached": false }
    },
    "ready_for_dispatch": {
      "allowed": false,
      "missing": [
        { "code": "production_photo_required", "message": "Attach at least one production progress photo before marking this job packed or ready for dispatch. A start-of-production photo counts." },
        { "code": "packing_photo_required", "message": "Add a photo of the finished prints packed and ready before marking Ready for dispatch." }
      ],
      "receiptScan": { "required": false, "attached": false }
    }
  }
}
```

Render every `missing[].message` beside the relevant action, and disable it when
`allowed` is false. Refresh after uploads, attachments and order invalidations.
This is a snapshot, not a reservation: POST always rechecks under the domain lock.
Keep the optional receipt scan visibly optional and outside the missing list.

Authenticated `POST /orders/:id/transition` domain refusals retain their HTTP
status and stable `error` code, and return a plain `message` plus `missing` as
`[{code,message}]`. Packaging refusals include all outstanding checklist items,
including holds and both photos, rather than only the first failure. Other
refusals include their corrective requirement. Show the server message after a
failed POST even if the previous preflight allowed it. Do not substitute a generic
connectivity error for a 400/403/409 response.

Relevant codes include `production_photo_required`, `packing_photo_required`,
`claim_hold_active`, `transition_not_allowed`,
`production_override_reason_required`, `reschedule_fulfillment_stopped`,
`shop_recovery_pending` and `refund_fulfillment_stopped`. Unauthorized parties
receive no photo/receipt checklist about another shop's order.

## Operations refusal history

Each authenticated transition domain refusal writes `order.transition_refused`
to the durable audit in the same locked transaction, before the error response.
It records actor, time, order, prior/requested states, HTTP status, stable code,
plain reason and missing requirements. Uncommitted partial transition edits are
discarded; an already-recorded shop acceptance expiry remains valid. Authentication
failures before an identity is mapped, malformed transport input and infrastructure
errors remain HTTP logs, not attributed domain audit events.

Operations can read:

`GET /audit?action=order.transition_refused&orderId=:id`

The existing filters and limit apply. Unfiltered Operations audit reads stay
forbidden; suppliers, clients and riders cannot read this audit. Super Admin
retains its existing audit access.

## Job details and updates

Supplier and staff order projections add:

```json
{
  "jobDetails": {
    "material": "Coated paper",
    "zone": "Nearby",
    "promisedDate": "2026-10-20T03:00:00.000Z",
    "missing": []
  }
}
```

Use these fields for the Material, Zone and Promised cards. Each missing display
value is exactly `Not specified`; `missing` names the affected keys. A partially
specified multi-line material list also flags `material` as missing. Read individual
line specs from `productionItems` when showing a multi-line job.

- Material uses caller-scoped immutable line specifications, then selected options
  whose snapshotted group is named Material/Materials. Legacy orders without lines
  use the order's own material. Live listings are never consulted.
- Zone uses the order's `distanceZone` snapshot, then the fixed known zone labels
  or the legacy zone reference name. New cart checkouts snapshot the shared band
  lookup on the order. Older rows lacking that information remain missing;
  current fee settings are never used to guess historical fees or zone boundaries.
- Promised uses the shop's `readyBy`, then legacy `promisedDate`/`deadline`.
  Never use the padded client `promiseBy` for a supplier deadline. The supplier's
  existing `promisedDate` alias also uses this date, or null when missing.
- On an authorized successful or refused transition attempt, missing facts create
  one `order_job_details_missing` inbox event per current Operations/Super Admin
  membership and distinct missing-field combination. Staff should open the order's
  `jobDetails`. Repeated identical attempts do not spam the inbox.

Supplier `timeline` entries retain `{at,state,note}`. Notes preserve production
instructions, translate internal payout stage codes to plain labels, and hide
client-authored private notes and arbitrary internal event/file fields. Operations
retains the original audit history. Use `note` for display; `state` remains a
machine-readable code. Supplier payout cards retain their separate stage labels.

File metadata `originalFilename` and supplier `artworkName` are decoded once for
display. Malformed percent escapes remain readable; control characters are removed.
Do not decode these fields again. Stored filenames, object keys, attachment IDs
and signed download authorization are unchanged. Treat filenames as text, not HTML.

## Required Operations check for 6C695C15

Use the order reference held in the private report. Record the original values
and audit evidence before any correction:

1. Inspect the exact prior/requested states, supplier membership/approval, file
   purposes, readiness, owner and order references; check open claim, refund,
   replacement and deadline holds. Look for a PDF or merely uploaded/unattached
   photo. Compare the failed action with its valid attachment window.
2. Verify immutable pickup/dropoff and fulfillment mode, recorded distance,
   zone/snapshot, original checkout/quote and per-shop job. Confirm the zone using
   the settings effective when the order was committed; do not apply today's bands
   to recalculate a historical order.
3. Reconcile `deliveryFeeMinor` with the original quote/receipt, fulfillment fee,
   collected payment allocations and any approved adjustment. A missing zone label
   alone does not prove a wrong charge.
4. Check `riderCommissionBps`, `riderPayoutMinor`, platform delivery share, job
   snapshots and actual rider releases. Preserve legacy pass-through and hub-pickup
   rules. Record discrepancies in PHP minor units and use the established audited
   correction/settlement process; do not directly rewrite immutable money snapshots.
5. Verify the supplier surfaces display the returned checklist/message and a shop
   with valid evidence advances without a staff override after their releases.
