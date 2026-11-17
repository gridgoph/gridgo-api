# Rider map home and guided trip API (v1)

Companion contract for [rider issue 180](https://github.com/gridgoph/gridgo-rider/issues/180).
This release adds exclusive timed offers and digital acknowledgement signatures.
The existing trip, pickup, payment, handover and pricing contracts still apply.

## Offer pool and rotation

`GET /dispatch/offers` requires an approved rider membership (Operations/Super
Admin retain the dispatch overview). A rider receives at most one **unaccepted**
offer, exclusive to that rider. Already assigned `rider_assigned` jobs remain in
the response for released apps; use their state to separate the active trip from
a new offer. This does not introduce an active-job eligibility filter.

For each ready order the server chooses the approved rider who least recently
received an offer, with lexicographic user ID as the stable tie breaker. Never
offered riders go first. Review-data pools remain separate. Orders competing
for available reservation slots use oldest ready/created time, then order ID.
Riders with an outstanding offer wait for that reservation to end before being
offered another order. There are **no new distance, zone, vehicle, online or
active-trip eligibility filters**. All existing job holds and shop/platform
hours continue to apply. The app's online switch is presentation only in this
contract; it does not register server-side dispatch presence.

A decline or expiry advances to the next rider in that rotation, skipping riders
who already declined or timed out for this order. A temporarily withdrawn offer
(e.g. an order hold) is not a decline. When all eligible riders have declined or
expired, or the pool is empty, `dispatchOffer.status` becomes `exhausted` and one
`dispatch_offer_exhausted` inbox row is written to **each** current Operations
and Super Admin membership. There is no automatic restart after exhaustion;
Operations can use its existing audited rider assignment transition. If the
remaining riders are reserved by other offers, the order waits instead of
escalating. No rider assignment or money changes merely because an offer exists.

Offer creation, end-of-offer history, rotation timestamps, audit and inbox/outbox
rows commit under the existing domain advisory lock. Reservation metadata lives
in `orders.data`; `users.data.lastDispatchOfferAt` is internal and not public user
information. A deferred SQL constraint prevents two outstanding offers for one
rider, including concurrent replicas. Timed offers survive API restarts. A
one-second sweep advances expired offers without app polling; offer reads and
accept/decline requests also reconcile deadlines under the lock. Sweep timing
may delay the next notification; it never extends acceptance beyond `expiresAt`.

Only the current recipient may read an unassigned offer through normal order
reads or its dispatch notification. Past/expired dispatch notices stop appearing
as actionable offers. The offer attempt history is internal; other riders'
identities never appear in rider or client responses.

## Countdown setting

`GET /settings` returns `version` and `settings.riderOfferTimeoutSeconds`, default
**30**, an integer from **10 through 120**. Operations may edit only this setting:

```http
PATCH /settings
Content-Type: application/json

{"expectedVersion":4,"reason":"Allow more time to review cargo","riderOfferTimeoutSeconds":45}
```

This is a narrow exception to Super Admin settings authority. For `ops_admin`,
any other body key beyond these three is `403 forbidden`. Other existing
settings remain Super Admin only. The existing handshake applies: stale/missing
version is `409 settings_version_conflict`, blank reason is
`400 settings_reason_required`, invalid timeout (including strings, fractions or
null) is `400 invalid_rider_offer_timeout`. Success increments the settings
version and audits previous/current values. Omission preserves the value on a
Super Admin settings patch. Each newly issued offer snapshots its timeout;
editing settings does not move existing deadlines or reprice an order.

## Offer response and actions

The offers response adds `serverTime` (UTC). Each unaccepted offer includes:

```json
{
  "id": "ord_example",
  "state": "ready_for_dispatch",
  "dispatchOffer": {
    "id": "offer_opaque",
    "status": "offered",
    "riderId": "rider_opaque",
    "offeredAt": "2026-11-18T01:00:00.000Z",
    "timeoutSeconds": 30,
    "expiresAt": "2026-11-18T01:00:30.000Z"
  },
  "riderCommissionBps": 8500,
  "riderPayoutMinor": 850,
  "deliveryFeeMinor": 1000,
  "pickup": {"lat":7.06,"lng":125.60,"label":"Shop"},
  "dropoff": {"lat":7.07,"lng":125.61,"label":"Client"},
  "cargoSummary": {
    "lines": [{"lineItemId":"line_opaque","description":"Flyers","quantity":10}],
    "totalQuantity": 10
  },
  "travelEstimate": {"distanceMeters":1500,"durationSeconds":null,"source":"order_snapshot"}
}
```

Use `expiresAt` and `serverTime` for the countdown, bounded by the snapshotted
`timeoutSeconds`; the API refuses an offer at its expiry instant. Distance is
the stored shop-to-destination distance, not a routing estimate or handset-to-shop
distance. Missing distance and travel duration are `null`: no routing/traffic
provider exists in this API. The app may obtain a navigation ETA from its map
provider, but must label it as that provider's estimate, never production hours.
Cargo uses existing immutable line descriptions and checkout quantities, with a
legacy aggregate fallback. Use `pickupCountItems` for governed physical counter
counts; package quantities can differ from checkout units. Pickup/dropoff and the existing role-safe `productionItems` remain
available. Client billing and supplier payout figures stay private.

**Display `riderPayoutMinor` as the rider's own fee.** Do not multiply the gross
fee by 80%. Existing default commitments are 85%; older or explicitly configured
orders can have other rates. This release changes no setting, checkout price,
rate or snapshot. A future 80% default is a captain/Super Admin pay decision
through the existing audited `riderCommissionBps` setting.

- `POST /dispatch/:id/accept` with `{"offerId":"offer_opaque"}` accepts only the
  caller's current, unexpired reservation, under the existing transaction lock.
  Released builds may omit `offerId` to accept their own current reservation.
- `POST /dispatch/:id/decline` requires that same body, returns `{ "ok": true }`
  and immediately tries the next rider. Exact decline retries are idempotent.
- Missing decline ID: `409 dispatch_offer_id_required`. A stale supplied ID on
  the caller's current offer: `409 dispatch_offer_stale`. Missing, expired,
  already assigned or another rider's reservation: `409 not_offerable`.
- The legacy rider `POST /orders/:id/transition` to `rider_assigned` is subject to
  the same reservation gate. Staff's existing manual assignment remains intact.
- Offers and receipt reads use private, no-store responses. Push payloads remain
  the existing allowlist; no recipient signature, route, cargo or money is put
  in push data. Refresh the offer endpoint on notification/invalidate.

## Four app steps, existing server gates

No second trip state machine is introduced:

| App step | Existing API state/event |
| --- | --- |
| To shop | `rider_assigned`; `/dispatch/:id/milestones` with `heading_to_shop`, then `at_shop` |
| Check at shop | Existing `/pickup-checklist`; version-2 inspection, packing photo and `/pickup-confirm` |
| To client | `picked_up`; existing transition to `out_for_delivery` |
| Hand over | `arrived` milestone; prepare receipt, sign, then `/dispatch/:id/delivery` |

Keep all six pickup codes and per-line `counts` on the wire. The four UI groups
are labels over existing checks, not a new four-code request:

| App checklist group | Existing checks/evidence |
| --- | --- |
| Count | `quantity_match` plus exact `pickupCountItems` counts |
| Print matches approved proof | `specification_match` and `documentation`; use existing scoped artwork/proof reads |
| No damage | `visible_defects` |
| Packaged and photographed | `packaging_integrity`, existing packing photos, `supplier_sign_off` and the shop `handoff_signature` |

Version-2 handover first checks **unpacked** goods, then binds the rider's packing
photo and shop signature to that inspection. Packaging confirmation is completed
at `/pickup-confirm`, not falsely asserted before unpacked inspection. Do not
replace this sequence with four blind ticks. Legacy jobs retain their existing
handover/evidence requirements. Failures still require photos and a note,
escalate to Operations, and block transport. See [Shop handover](SHOP_HANDOVER_API.md)
and [pickup counter/signature rules](OPERATIONAL_MODEL_V2_API.md#counter-count).
Calls, support and problem reports use their existing routes.

## Digital acknowledgement receipt

At an active, arrived **door** handover:

1. Record `arrived` with the existing milestone endpoint.
2. `POST /orders/:id/acknowledgement-receipt` obtains the immutable numbered
   receipt. Show its exact `receipt.note` and the new response `invoiceNote`:
   **The official invoice comes from GRIDGO.** This is not a tax invoice.
3. Capture the receiving person's on-screen signature. Upload through the
   existing `/files` flow with purpose `acknowledgement_signature` (approved
   rider only, PNG only, maximum 2 MiB). Attach to this order using
   `POST /files/:fileId/attach`. The attachment is bound to the current rider
   assignment; a signature from another assignment cannot be reused.
4. Submit existing delivery evidence, OTP/reminder fields when applicable, and:

```json
{
  "evidenceType": "photo",
  "evidenceFileId": "fil_delivery_photo",
  "receiptMode": "digital",
  "acknowledgementSignature": {
    "arNumber": "AR-0000000001",
    "fileId": "fil_signature",
    "signerName": "Receiving person's name"
  }
}
```

`receiptMode: "digital"` requires the signature; new map-flow builds must send
it. A supplied signature is always validated, even without that mode. Legacy
builds that omit both retain the released paper flow. Existing delivery photo,
payment, OTP, reminder and custody gates remain mandatory. The AR signature is
separate from the **shop's** pickup `handoff_signature`. It never substitutes
for the governed delivery evidence or an OTP. Hub arrivals retain their existing
counter handover and do not issue a door receipt.

Validation requires the exact AR number, a 2–120 character trimmed signer name,
and a ready PNG owned by this assigned rider and attached to this assignment.
Failures return `400 acknowledgement_signature_required`,
`acknowledgement_signer_name_required`, `acknowledgement_receipt_mismatch` or
`invalid_acknowledgement_signature`. Failure rolls back receipt issuance (if
new), delivery, signature metadata, audit and notifications together.

The immutable issued receipt row is never updated. Separate immutable
`order.acknowledgementSignature` evidence stores `fileId`, `signerName`, `signedAt`,
`riderId`, and `arNumber`. The owning client and Operations/Super Admin receive
this metadata on normal order detail reads and may fetch the private image
through `GET /files/:fileId`. Suppliers, other clients and other riders cannot
read it. The capturing rider can read their upload only during the active
arrived handover; completed receipt data stays absent from rider history.
The signature file follows existing photo retention and open-case hold rules.

`GET /orders/:id/acknowledgement-receipt` returns `{receipt, signature,
invoiceNote}`, with `signature: null` for the paper flow. The original `receipt`
object and its AR number remain unchanged. The client/staff PDF download records
the digital signer, time and private evidence ID when present; the raster image
is read separately through the authenticated file route. It adds the GRIDGO
invoice note. Signature completion emits `acknowledgement_receipt_signed` to the
owning client and **every** current Operations and Super Admin membership,
with queued order/inbox invalidates. Receipt issuance's existing ready notice
is separate. Signature handwriting and billing never appear in push data.

## Deployment and verification

Apply migration `1794944100000_rider_map_home` before deploying the API. It adds
only the missing countdown setting, offer indexes, a deferred exclusivity guard
and signature immutability guard. It never changes historical money, rider
rates, files, receipts, or assignments. No boot-time schema work or data reset.
New rule coverage: `tests/rider-map-home.test.js` and
`tests/rider-map-home-postgres.test.js`; existing six-check/shop-handover and
receipt suites continue to cover the reused flow. Ship the rider app after this
API and verify the complete map journey on a real phone.
