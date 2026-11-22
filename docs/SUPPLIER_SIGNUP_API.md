# Guided supplier sign-up

API contract for report **2074B695**. The supplier app and supplier web use the
same calls below. Screens and their release remain separate work. Apply the
three `1795315000000`–`1795315002000` forward migrations before deploying.

Clerk remains the identity provider. Supplier accreditation and listing review
remain unchanged: sign-up prepares real, positive-priced document services and
pending listings; it does not approve the shop or its listings. Optional
verification uses the separate [verification contract](SUPPLIER_VERIFICATION_API.md),
including its pending-shop eligibility and payout limits. Do not promise a payout
hour or a bonus.

## Save and resume before enrollment

Every call uses `Authorization: Bearer <Clerk session JWT>`. A mapped GRIDGO
user is not needed for the private draft. Drafts belong to the exact verified
Clerk subject and cannot be looked up by mobile or email.

`GET /auth/clerk/supplier-signup` returns:

```json
{
  "signup": {"version":0,"supplierId":null,"steps":{},"nextStep":"eligibility","updatedAt":null},
  "printGroups":["documents","marketing","banners_signage","apparel","merchandise","awards","construction","packaging"],
  "locationConsentWording":"...",
  "payoutConsentWording":"...",
  "documentRates":{"bwMinor":300,"colourMinor":500}
}
```

`PATCH /auth/clerk/supplier-signup` saves one step with
`{expectedVersion,step,value}` and returns the same projection. The first version
is `0`; use each returned version for the next write. A stale write returns
`409 supplier_signup_stale`. No client-supplied completion flags or timestamps
are trusted. `nextStep` is the first unfinished step, independently of the order
in which the app displays missions. Reopening the app reads this endpoint again.

| Step | `value` |
| --- | --- |
| `eligibility` | `{shopKind:"print_shop"|"home_printer",registrantRole:"owner"|"manager",adult:true}`. The server records attestation time. An under-18 declaration is refused. Role cannot be switched after contact details are saved. |
| `shop` | `{shopName,contactName,phone,ownerPhone?}`. Mobile normalizes to `+639XXXXXXXXX`. Confirm `phone` with Clerk's phone code flow first; the API checks verified Clerk Backend API phone records and returns `403 shop_mobile_verification_required` otherwise. A manager must give a different, valid owner mobile. That contact does not grant ownership. |
| `location` | `{point:{lat,lng,label},consent:{accepted:true,wording}}`. Display the exact wording returned by GET. Wording and server receipt time are stored together; a client `at` is ignored. Missing/replaced wording or absent consent is refused. |
| `prints` | `{groups:[...],documents?:{papers:["short","a4","long","a3"],colours:["bw","colour"],duplex:true,a3PricesMinor:{bw:1200,colour:2500},finishing:{stapling:500,binding:15000,photo_paper:3000}}}`. At least one paper and colour are required for documents. A3 requires a positive safe-integer minor-unit price for every selected colour. Finishing is optional and every supplied price is positive integer minor units. |

The eight print groups are onboarding interests, not a new taxonomy or a grant
of capability. Only `documents` creates services here. Other selected groups can
wait, or use assisted setup below. Standard Short/A4/Long page prices come from
`documentRates`, read-only in this flow. Price per **printed side** is charged
once; duplex is not an additional multiplier.

## Enroll once, then reuse shop routes

Call existing `POST /auth/clerk/enroll/supplier` with an `Idempotency-Key` and:

```json
{"signupVersion":4,"jobsHandledBy":"just_me","legalConsentVersion":"<current version>"}
```

Use the existing legal consent contract, including its current document
acceptances when required. `jobsHandledBy` also accepts `me_and_staff`. Replaying
the exact enrollment and idempotency key returns the original enrollment. The
draft is now linked to its shop and pre-enrollment PATCH returns
`409 supplier_signup_enrolled`; later profile/catalog edits use existing routes.
Legacy `{profile,serviceCategories,...}` enrollment remains compatible.

Document enrollment creates a submitted service with PDF acceptance, a one-hour
initial turnaround, and a pending listing for each selected size/colour. Every
listing has required size, colour and sides options. A3 keeps its own size/colour
price; standard page prices use the current fixed schedule. Express starts on.
Optional binding/stapling are separate per-unit catalogue items at the shop's
price; photo-paper printing is a separate per-page item. These optional items
are not Express extras. No zero-price category drafts are created by this path.
Existing services and released listings are not rewritten.

After enrollment, send `X-GRIDGO-Role: supplier`; also send
`X-GRIDGO-Shop-Id` when selecting a particular shop. Both app and web should:

1. Read `GET /auth/me/supplier` and use `shop.role` to show Owner or Manager.
2. Read `GET /me/supplier-signup` for saved steps, `nextStep` and `payoutStatus`.
   After enrollment, progress derives from saved hours, team settings, owner
   claim, QR consent and listing photos. `GET /me/payout-status` returns the
   hold status alone and is available to Managers without exposing Money.
3. Save hours with existing `GET/PATCH /me/shop-hours`; reuse its shared-day,
   per-day, closed-day and night-job contracts. Reuse `/me/shop-team/settings`,
   `/me/shop-team/me` and the existing staff/invite routes for staff choice and
   job alerts. These features are not duplicated.
4. Get generated listing IDs through `GET /me/catalog-items`. Download
   authenticated `GET /auth/clerk/supplier-signup/document-sample` (a static,
   unbranded PNG). Upload that sample automatically **once per generated
   listing** through existing multipart `POST /files`, purpose
   `catalog_item_photo`, then `POST /files/:fileId/attach` with
   `{catalogItemId,sortOrder:0}`. Each listing needs its own file ID. The optional
   shop logo uses the existing `supplier_shop_image` upload/attachment route.
   Ordinary listing review still checks photos and specs; no new photo bypass.
5. Follow the owner flow below when required, then save the existing payout
   account. Register device/browser push through the existing device/web-push
   routes after permission is granted, and save the current member's job-alert
   preference with the existing team endpoint.
6. Read `GET /me/supplier-readiness`. `nextStep:"complete"` means setup is saved;
   show actual approval/operational readiness from this existing endpoint before
   claiming the shop can take jobs. Pending ownership holds payouts, not matching
   or completed-job earnings. Existing accreditation, live-service, listing,
   account-standing and hours gates still apply.

## Manager starts; owner explicitly claims

Manager enrollment creates an active **Staff** shop membership with the existing
Manager preference, not Owner. The supplier membership and accreditation remain
on the existing shop key. Repeated compatibility saves do not create an Owner.
Managers can finish hours, listings and staff setup. Payout QR access remains
Owner-only. Money should show `payoutStatus.reason:"shop_owner_claim_required"`
and an **Ask your owner to claim the shop** action, using the safe status route.

- Manager: `POST /me/shop-team/invites` with `{kind:"owner"}`. Its identity is
  fixed to the saved owner mobile; callers cannot redirect it. It uses the
  existing 24-hour deadline, hashed token, revoke and replace routes. Share the
  returned token/link through the phone share sheet; no SMS provider is added.
- Owner: sign in with their own Clerk account and verify the invited mobile.
  Existing `POST /auth/shop-invites` discovers the invite; alternatively open
  the shared token. `POST /auth/shop-invites/claim` with `{token}` or `{inviteId}`
  requires that verified phone. It makes this identity an active Owner, leaves
  the registering Manager as Manager, and grants no platform supplier/admin
  membership. An existing same-shop Staff member may explicitly claim too.
  The registering Manager's own Clerk account cannot claim its owner invite,
  even if another verified mobile is added (`shop_owner_separate_account_required`).
- Wrong mobile, unverified mobile, expiry, revocation, consumed tokens and a
  second ownership claim are refused. A successful claim revokes sibling owner
  invites atomically. Claim, policy, audit and inbox changes use the domain lock.
- **This isn't right:** the invited, verified owner sends
  `{token,choice:"not_right"}` to the same claim route. The invite is revoked,
  the shop closes to new jobs, and the manager plus privileged staff are told.
  Existing work and earned obligations are preserved. Issuing another invite
  does not silently reopen the shop; normal authorized reopening remains needed.

An enrolling Owner retains today's ownership behavior. An owner invite is a new
credential kind: old API handlers fail closed if they try to consume it as a
generic Staff invitation. Ordinary legacy invite upserts remain valid, and their
24-hour/48-hour timestamps and lifetime normalization remain unchanged. Route
owner-claim screens to the upgraded API; older apps cannot complete this new flow.
Enable guided sign-up after every API process has upgraded: old matchers and
payout handlers do not interpret the new capability, timing and hold facts.
Additive storage preserves those facts across legacy upserts; it does not add
new behavior to an older executable. Drain old processes before screen rollout.

## Existing payout account, added consent and destination pause

The active Owner uploads/scans a ready private `supplier_payout_qr` file through
`POST /files`, reads `GET /me/payout-account`, and writes the existing
`PATCH /me/payout-account`. Keep its existing `provider`, `accountName`, optional
number/institution, `qrFileId` and `expectedVersion` fields. Add:

```json
{"holder":"family","consent":{"accepted":true,"wording":"<payoutConsentWording from sign-up GET>"}}
```

`holder` is `mine | family | friend | staff`; `accountName` is the name on the QR
and remains required. There is no name-match rule. Guided shops, and existing
shops that opt into holder/consent fields, require consent when binding a QR,
changing an existing QR destination, or changing holder details. Released callers
without guided sign-up or prior consent retain their old payout-account payload
contract; their destination changes still receive the same 24-hour hold and owner
notifications. Do not invent a consent record for those older screens.
The API stores exact wording, receipt time and consenting identity. Account reads
include `holder`, `consent` and `payoutStatus` for the owning shop and authorized
staff only.

Initial setup has no 24-hour delay. Changing a saved destination or removing its
account pauses shop payments for 24 hours; delete/recreate cannot erase the
independent policy. Status includes `held`, `reason`, `ownerClaimRequired` and
`pausedUntil`. The hold ends exactly at `pausedUntil` and never changes money or
stage amounts. Milestone, settlement, supplemental, cash shop payments and funded
reprint/replacement payments enforce this independent hold. Managers/Staff cannot
read or change the payout destination, including through an owner-carried shared
device selected as Manager/Staff. Active owners and all privileged staff receive
durable inbox/push updates via the existing after-commit delivery boundary.
An actual SMS to the owner remains a follow-up; delivery uses existing push/inbox.

## Capability-aware matching and A3 Express

Capabilities live on the document service and survive PostgreSQL round trips.
Normal matching accepts the existing `structuredSpec` fields `size`, `colourMode`
and `sides`; `bw | colour` and `one | two` are the canonical print controls.
Matching, manual supplier eligibility, recovery, quotes, cart writes and checkout reject unsupported requested paper,
colour or duplex. Fixed size/colour listings must also fit that request. Old
services without these new capability facts retain their existing behavior.

`POST /express/drafts` additionally accepts `paper:"a3"`. It chooses an eligible
size/colour listing, snapshots the shop's positive A3 page price, and returns
`paymentTiming:"after_acceptance"` when any file uses A3 (`checkout` otherwise).
Preview and fee arithmetic still use the existing cart builder. For A3:

1. Client checks out with the existing `looksRight` and `expressConfirmation`,
   omitting `payment`. Artwork goes to the ordinary Operations review, unpaid.
2. After review, the shop uses existing
   `POST /orders/:id/express/accept`; the order becomes
   `awaiting_initial_payment`. Acceptance itself pays nobody.
3. Client sends the existing
   `POST /orders/:id/payments/initial/submit` with manual QR payment evidence.
   Operations uses the existing `/confirm` or `/reject` route. Confirmation moves
   an already-reviewed, accepted A3 job to `payment_authorized`, without repeating
   artwork review. Work/readiness/collection cannot bypass payment.

Standard Express keeps its existing checkout payment. A3 replacement matching
also checks the snapshotted page price; it never substitutes a different shop's
price into an accepted order. Existing immutable money, print settings, client
privacy and refund/recovery rules remain in force.

## Let GRIDGO set it up

For deferred product groups, Owner or Manager uploads up to eight images/PDFs
with purpose `supplier_price_list`, then calls
`POST /me/supplier-signup/setup-help` with `{fileIds:[...]}`. The ready own-shop
files become private signup references, the request persists, and each current
Operations/Super Admin membership gets a durable inbox row. Retrying the same
file list returns the same request; a different second request is `409`.
`GET /ops/shops/:shopId/signup` lets authorized staff inspect the request and use
existing private file reads. This request does not invent services or prices.

## Validation and release

Focused tests cover mobile verification/manager contact, saved consent and
resume, owner identity mismatch/replay/rejection, PostgreSQL/HTTP persistence,
legacy upserts, capability matching/cart refusal, A3 pricing and payment gates,
owner-only QR consent, independent 24-hour pauses and private setup assistance.
The complete PostgreSQL suite runs on CI. This API PR has no new application
screen; phone/desktop screenshots and store releases belong to the two screen
follow-ups. Deploy the additive migrations and API before enabling those screens.
