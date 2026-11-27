# Home printers

Refs gridgoph/gridgo-api#412; issue report 0B10F8DE. API-only contract; supplier,
client, rider and dashboard screens are companion releases.

Home printers reuse supplier memberships, guided sign-up, service/listing review,
private verification uploads, approval cases, Express payment/dispatch and shop
payouts. There is no new role, payout schedule or automatic accreditation.

## Supplier app

Use Clerk and the existing supplier role/selected-shop headers. Owner controls
below are unavailable to ordinary Staff or Managers.

1. `GET /auth/clerk/supplier-signup`, then versioned `PATCH` steps as in
   [supplier sign-up](SUPPLIER_SIGNUP_API.md). At `eligibility` send
   `{shopKind:"home_printer",registrantRole:"owner",adult:true}`. Under-18
   declarations are refused. Save the existing verified contact in `shop`.
2. The `location` step uses this shape (use the exact consent wording returned
   by GET after selecting the home kind):

   ```json
   {"point":{"lat":7.06,"lng":125.6},"barangay":"Example barangay","street":"Example street","propertyType":"house","landmark":"Optional landmark","consent":{"accepted":true,"wording":"<locationConsentWording>"}}
   ```

   `propertyType` is `house | boarding_house`. Barangay and street are separate
   required fields. The optional landmark and property type stay private.
   The street field is the street name; do not ask for a public house/unit number.
   Consent explicitly describes barangay/rough distance, street after paid home
   pickup, and the assigned active rider's exact pin.
3. `prints` must contain only `groups:["documents"]`, with any of
   `papers:["short","a4","long"]`, existing colour/duplex capabilities, and no
   finishing extras. A3, plans and other groups are refused. Existing Express
   `expressRates` determine checkout prices; supplier catalogue prices cannot
   override those document rates. Enroll through existing
   `POST /auth/clerk/enroll/supplier` with `signupVersion`, legal consents and
   `Idempotency-Key`.
4. `GET /me/supplier-signup` resumes directly to the existing team/payout/photo
   checklist, skipping fixed hours for a home printer. Finish the existing
   receiving QR/owner consent and document-listing photos/review. No approval or
   listing-review bypass is introduced. Use the existing authenticated document
   sample and `/files` catalogue-photo flow from the sign-up contract.
5. `GET /me/home-printer` returns `{version,homePrinter,pin}`. `homePrinter`
   contains `level: pending | starter | verified`, `symbol:"house"`, `verified`,
   `online`, `offersPaused`, `reason`, `deadlineAt`, `weeklyJobs`, `weeklyJobCap`,
   `offlineUntil`, `allowHomePickup`, `pinConsentWording` and
   `filePrivacyWording`. The owning supplier can read its own full `pin` and
   `nextChangeAt`; these fields never appear on client cards.
6. Accept the current file agreement through `PATCH /me/home-printer`:

   ```json
   {"expectedVersion":1,"filePrivacyAgreement":{"accepted":true,"wording":"<filePrivacyWording>"}}
   ```

   Upload private `verification_document` files through the existing upload,
   complete and `/files/:fileId/attach` flow. Starter slots are `valid_id`,
   `id_selfie` and `sample_work` (the test print). Staff must inspect the ID for
   age and the evidence before granting Starter; uploading does not grant it.
7. The To do switch uses `PATCH /me/home-printer` with
   `{expectedVersion,online:true,location:{lat,lng}}`; switching off sends
   `{expectedVersion,online:false}`. Going online requires a current fix. While
   online, submit new `location` fixes on movement/foreground refresh with the
   latest version; the latest reported fix beyond 300 metres pauses new offers
   without withdrawing an accepted job. Returning within range resumes offers
   if the switch and other eligibility gates allow. GPS fixes are owner/staff
   only and never become public tracking pings. Fixed shop hours do not govern
   home production; rider delivery still respects GRIDGO's operating hours.
8. Two consecutive timed-out Express offers switch offline. Accepting or
   explicitly declining resets that streak. The supplier must explicitly
   switch on again. `POST /orders/:orderId/express/accept` and `/decline` retain
   their existing contracts. New acceptance rechecks the home policy under the
   mutation lock, including the weekly cap.
9. `POST /orders/:orderId/express/give-back` with `{reason}` returns an accepted
   home Express job to the next capable printer at the same frozen price and
   original zone. Exactly five minutes after acceptance is still free. Later
   returns count in a rolling seven-day window: the third enforces 24 hours
   offline; each further late return requires Starter review again. The online
   switch cannot clear a hold or lost Starter access. Released payouts, work
   holds and handover states refuse give-back. No eligible replacement uses the
   existing cancellation/refund-required flow. A give-back itself never pays,
   changes the accepted price or silently releases a refund.
10. Update the pin only through `PATCH /me/home-printer` with
    `{expectedVersion,pin:<the location-step shape>}`. At most one change is
    permitted per calendar-month interval (clamped to the end of the next
    month), starting with initial pin consent. A move switches offline and
    requires a new location fix before going online. Existing order pickups and
    accepted money retain their original snapshots. Both legacy profile-pin
    write routes refuse home-printer moves, including staff corrections.
11. Verified printers may opt into `{expectedVersion,allowHomePickup:true}` on
    this same PATCH route. Starter pickup is refused. Verification does not
    silently enable home pickup.
12. Verified evidence uses `barangay_clearance` **or** `business_permit` (DTI),
    plus `tin`, through the same private file attachment route. Use existing
    `/me/supplier-verification` and `/auth/me/supplier`; the latter also adds the
    home status. Existing Money, receiving QR and daily shop payout calls are
    unchanged. Unverified payout limits/independent financial holds remain.

The 30-job Starter cap counts distinct jobs accepted by that printer in the
preceding seven days, including jobs subsequently returned/cancelled. Repeated
acceptance retries do not count again. Accepted events stay in the existing
Express history through reassignment, so a return cannot reset the cap.
Verified has no job cap. After 30 days from supplier enrollment, an unverified
home printer receives no new work; already accepted work can finish.
Re-enrollment, evidence replacement, pin changes and Starter re-review never
restart that window.

## Client app

Reuse `POST /express/shops`, `/express/drafts`, cart GET/quote/checkout and
`GET /orders/:id` from [Express](EXPRESS_API.md). Render `printerType:"home"`
as a house, `verificationLevel:"starter"` as Starter and `verified:true` as a
green Verified check. Shop cards keep their store symbol. `shopsOnly` and
`verifiedOnly` remain available. Home printers accept only Short/A4/Long
Express documents. Mixed shop/home nearest comparisons use true internal
location; displayed home distance is rounded upward to 500-metre buckets,
with a minimum 500 metres, rather than an exact coordinate/distance.
Partners receive no preference or exclusion. Ordinary matching excludes home
printers; home catalogues cannot be ordered through ordinary/custom carts.

Home names, personal contacts, coordinates, landmarks and property details are
removed from client catalogue, cart, checkout, order, nested job and quote
responses. Public home shop media is omitted. Delivery exposes only barangay;
paid home pickup exposes `{barangay,street}` in `order.pickup`. It requires both
payment installments to be confirmed/not-required: submitting payment evidence
alone reveals no street. **Clients never receive the exact pin**, including
paid pickup. Checkout and reassignment freeze private home metadata so later
profile edits cannot change order privacy or expose an older pin. Pickup at a
home is available only when Verified and explicitly enabled.
An owner using their client membership retains their own personal account name
and contacts; their home-printer card and pickup details still follow these rules.

### Pickup point

A home printer may share a **pickup point** instead of its home pin, for
[accept-first Express](EXPRESS_API.md#accept-first-express-send-accept-then-pay).
Set it with `PATCH /me/home-printer`:

```json
{ "expectedVersion": 4, "pickupPoint": { "point": { "lat": 7.0645, "lng": 125.609 },
  "kind": "gate", "description": "Green gate beside the chapel",
  "consent": { "accepted": true, "wording": "<HOME_PICKUP_POINT_CONSENT>" } } }
```

- `kind` is `gate`, `guardhouse` or `landmark`.
- `description` is 1–160 characters.
- `consent.wording` must equal the server's fixed sentence (`HOME_PICKUP_POINT_CONSENT` in `src/home-printers.js`).
- `null` removes the point. A home printer that offers delivery only leaves `allowHomePickup` off.
- Errors: `400 invalid_home_pickup_point` and `400 home_pickup_point_consent_required`.
- The owner reads the point back in `GET /me/home-printer` as `pickupPoint`.

The point is frozen on the order with the other private home metadata. It is
shown as `expressOrder.pickupPoint` only to the **owning client** of an
accept-first **pickup** order, and only from the shop's acceptance until pickup or
cancellation. It holds `kind`, `description`, `lat`, `lng`, `barangay`,
`distanceMeters`, a straight-line `walkingTimeMinutes` at 80 m per minute, and
`onlyVisibleToYou: true`. Everyone else, and the same client before acceptance
or after pickup or cancellation, receives no point. Accept-first order history
keeps the barangay only, with no street.

Accept-first home printers take QR only, and orders up to the manual QR limit
while QR is confirmed by hand. See [Express](EXPRESS_API.md#home-printers).

## Rider app

Reuse `GET /dispatch/offers`, `POST /dispatch/:orderId/accept`,
`GET /orders/:orderId` and the existing inspection/pickup/delivery routes.
Offers expose the barangay, house symbol and approximate distance. Only after
assignment, in `rider_assigned | picked_up | out_for_delivery |
awaiting_collection`, does that order's `pickup` carry its exact frozen pin
and optional private landmark/property type. Unassigned/offered riders,
previous riders and completed/cancelled order reads get no pin or house
information. The printer's personal name is not supplied to the rider; adapt
signature-name prefill for the anonymous home-printer contact. No new rider
location endpoint or payout flow is needed.

On an accept-first delivery, the assigned rider's `pickup` is the home printer's
pickup point (`lat`, `lng`, `label` from its description, `pickupPointKind`)
instead of the home pin, when a pickup point is set.

## Staff and policy

Operations/Super Admin reads `GET /ops/home-printers/:supplierId` for the
private pin, status, evidence metadata and current version. After reviewing
the ID, selfie and test print, call
`POST /ops/home-printers/:supplierId/starter` with
`{expectedVersion,dateOfBirth:"YYYY-MM-DD",reviewedFileIds:[...]}`.
The ID's date of birth must meet the configured adult age, and the referenced
current ready files must cover every Starter slot. The file agreement is
mandatory. This audited decision can restore lost Starter access but does not
clear an unexpired fair-play hold or extend the verification deadline.

An earlier approval never supplies missing home evidence: Verified also requires
Starter review and current ready permit/clearance and TIN records.

Full verification reuses the existing versioned
`POST /approval-cases/:id/approve` Super Admin decision. It requires current
Starter access, permit/clearance and TIN, plus the ordinary supplier readiness
checks. Restoration also rechecks home verification. No approval authority or
shop approval policy is changed. Use existing supplier service/listing review
routes to approve document capability and listings independently.

Super Admin edits the existing `GET/PATCH /settings`, with `expectedVersion`
and a reason:

```json
{"expectedVersion":12,"reason":"Reviewed home printer policy","homePrinter":{"minimumAgeYears":18,"starterWeeklyJobCap":30,"verificationWindowDays":30}}
```

The defaults are 18, 30 jobs and 30 days. Bounds are 18–100 years, 1–10,000 jobs,
and 1–3,650 days, all integers. These starting levels/cap remain subject to
legal review of permits, tax and file privacy. Settings changes apply to new
eligibility reads without rewriting accepted work or money. Ordinary shop
verification settings remain separate. Availability, Starter and fair-play
updates use durable inbox/outbox delivery to the supplier and every current
Operations/Super Admin membership; private pins and evidence never go in push.

## Deployment and compatibility

Apply the additive migration, then upgrade/drain **every** API process before
enabling home-printer screens or admitting home work. The nullable profile JSON
column survives legacy upserts with no incompatible CHECK. An old executable
cannot enforce the new privacy/eligibility policy. Previously enrolled guided
home-kind profiles are conservatively marked offline with unknown barangay,
requiring new private-pin consent, file agreement and Starter review. Their
original supplier enrollment still starts the verification window.

API-only validation uses focused tests on an isolated PostgreSQL database;
full PostgreSQL 17 tests run on CI. There are no new rendered screens or
phone/desktop screenshots in this API change. Supplier/client/rider/dashboard
screen releases and production end-to-end verification are follow-up work.
