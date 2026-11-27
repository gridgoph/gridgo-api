# Express API

Group document ordering and companion client/rider calls: [Group Express API](GROUP_EXPRESS_API.md).

Express is an order type on the existing checkout, payment, refund, production,
artwork review and payout model. Express document production skips finished photos
and product QA; regular orders retain their evidence gates. It is not the legacy scheduling override represented by a
listing's `express` flag. Existing orders and custom checkout remain unchanged.

The 19 November decision applies: the client pays GRIDGO using the existing QR,
cash-delivery (when enabled and eligible), or voucher paths. Printing includes
the existing service fee. There is no Express fee, direct shop payment, load
wallet, or starter load. **Spending Credits, refunds to Credits, and the Credits
toggle are deferred until the kiosk resumes.** The existing Pilot Credits ledger
is untouched. Mission rewards remain the existing vouchers.

All money fields use integer PHP centavos. Express client responses contain
peso amounts, with no service-fee rate, schedule, percentage or separate fee line.
All routes require a Clerk session and the appropriate PostgreSQL membership.
Mutations use the normal domain transaction, lock, audit/inbox and after-commit
push boundary. No endpoint transfers money externally.

## Rates and Pay shops

Super Admin uses the existing `GET /settings`, then:

```json
PATCH /settings
{
  "expectedVersion": 42,
  "reason": "Updated Express page prices",
  "expressRates": { "bwMinor": 300, "colourMinor": 500 }
}
```

Both rates must be positive safe integers; the object replaces both rates.
Defaults are PHP 3.00 B&W and PHP 5.00 colour **shop principal per printed page**.
Stale versions return `409 settings_version_conflict`; missing reason and invalid
rates return `400`. Operations cannot edit these rates. Client settings omit them.
The draft locks these rates and the same service-fee schedule as ordinary cart
checkout. Later settings edits do not reprice that draft or an accepted order.
Print principal = selected pages × copies × page rate. Duplex changes the sheet
layout, not the page count: two printed sides are two pages.

`GET /express/shops?lat=7.06&lng=125.60&sort=nearest` is client-only.
Sort is `nearest | top_rated | fewest_jobs`. Response:

```json
{
  "shops": [{
    "supplierId": "shop_1", "catalogItemIds": ["item_1"],
    "name": "Example Print", "address": "Davao",
    "location": { "lat": 7.06, "lng": 125.60, "label": "Davao" },
    "distanceMeters": 250, "rating": { "average": 4.8, "count": 12 },
    "jobsAhead": 3, "readyAt": "2026-12-01T03:00:00.000Z",
    "isNew": false, "busy": true
  }]
}
```

Active Verified shops and eligible Starter shops use the existing supplier
verification gates. Open shops follow their shop calendar.
They must have a public, approved `document_printing`, `per_page` listing with
`express: true`, and the shop-wide `expressEnabled` must not be false.
The listing switch remains its individual opt-in; staff
visibility/approval holds still apply. Shop setup must offer the print layouts
and option selections it accepts. Busy means at least three assigned/accepted/
printing jobs. New means less than seven elapsed days since supplier approval
(falling back to account creation for legacy rows). New/Busy are informational
badges; the printer-choice sorts below determine the displayed order.
Rating uses the existing public rating threshold; it is null below that threshold.
Ready time uses the existing queue/calendar projection, not an invented rush SLA.
Review-data suppliers never mix with ordinary clients.

### Who prints it? (B26328C8)

After Preview, call **`POST /express/shops`** with the same `location`,
`fulfillmentMode`, delivery `dropoff`, and `files` body used by `/express/drafts`,
omitting `supplierId`. This is an authenticated client read: it persists no draft,
mission progress, voucher reservation or notification. File ownership, detected
page counts, approved listings, supported settings and actual job readiness are
checked with the same draft/checkout builders. Each selectable card adds its
exact `quote` and `paymentTiming`. Do not add display prices to estimate checkout.

Optional fields:

- `sort`: `nearby` (default; `nearest` is an alias), `all_davao`, `fastest`,
  `top_rated`, `lowest_price`, or the retained `fewest_jobs`.
- `shopsOnly`, `verifiedOnly`: booleans, default false. Filtering precedes
  expansion. `lowest_price` compares the complete printing subtotal and is
  available for A3 and plans.
- `productType`: `documents` (default) or `plans`. Plans use approved Express
  `blueprint_cad_plotting` listings priced `per_unit` (one sheet) or `per_page`.
  Supported plan papers are `a4 | a3 | a2 | a1 | a0 | 30x40`; the listing's size
  and standard stock options must support the choice. A readable uploaded page
  count times copies determines sheets. Per-unit order/invoice quantities record
  sheets, while `expressOrder.printSettings[].copies` retains the original copies.
  Area/length/colour-coverage/custom quoted listings stay
  in ordinary ordering. Plans use daytime scheduling.

The response is `{shops,sort,expanded,expandedZones,expansionReason,fareBands,
walkingEstimateSource}`. Nearby starts with zone A, adds B if fewer than three
selectable printers remain, then C if still fewer than three. It never fabricates
three printers or expands beyond C. `expandedZones` contains the added letters;
`expansionReason:"fewer_than_three_open_printers"` supports the widening notice.
Closed cards stay visible after open choices, with `selectable:false`,
`isOpenNow:false`, `openStatus:"closed"`, and no current quote/readiness promise.
An open shop outside rider hours may have `isOpenNow:true` but `selectable:false`
for delivery. Never enable its select button from the open label alone.

Cards add `printerType:"shop"|"home"`, `verificationLevel:"verified"|"starter"`,
`isOpenNow`, `selectable`, `openStatus:"open"|"night"|"closed"`, `readyAt`,
`zone:{code:"A"|"B"|"C"|null,key,label}`, and `deliveryFeeMinor` (null for pickup).
Pickup cards use `walkingTimeMinutes`, a straight-line estimate at 80 metres per
minute, identified by `walkingEstimateSource`; this is not a routed walking ETA.
`deliveryFareMinor` on quoted cards is the prospective delivery fare used for
the fare-limit choice even for pickup. Display walking time for pickup.
Home cards expose `barangay` as their name/address, `location:null`, rounded-up
500 m distance estimates and `distanceApproximate:true`. Shop cards retain their
public location. This release supplies the discriminator/privacy projection;
home-printer enrollment, persistence and operational rules are defined in
[Home printers](HOME_PRINTERS_API.md). Its profile adapter supplies
`supplierType:"home"` and `barangay`; public responses never expose its pin.

The existing shared `settings.deliveryFeeBands` remains the only fare source.
Zone A maps to `nearby`, B to `away`, C to `long_distance`; bounds are inclusive.
Current repository defaults already match 5/10/15 km and PHP 89/149/229. Existing
saved settings are preserved. Beyond C is `out_of_zone` (null letter), using the
existing editable `baseFeeMinor + perKmMinor × ceil(distanceMeters/1000)` formula.
Super Admin reads `GET /settings` and patches the complete `deliveryFeeBands`
array with `expectedVersion` and `reason`; no new fee table, seed or migration is
needed. “All Davao”/“Any” can show that out-of-zone charge. Nearby never does.

For **Just print it**, call **`POST /express/drafts`** with that same preview body,
`selection:"just_print_it"` and a required `fareLimit`, omitting `supplierId`:

- `nearby`: zone A only, using the saved band limit;
- `up_to_149`: the live prospective delivery fare must be at most 14,900 centavos;
- `any`: any quoted, open, eligible printer, including Out of Zone.

Optional shop/verification filters apply. The server chooses the earliest actual
job `readyAt`, then nearest on a tie, and returns the normal draft/quote. Missing
or invalid limits return `400 invalid_express_fare_limit`; no candidate returns
`409 express_shop_unavailable`. A3/plans return `409
express_manual_selection_required`: the client must choose each shop's price.
For a manual choice, use the existing `POST /express/drafts` with `supplierId`.
Draft creation and checkout independently recheck current eligibility. Automatic
drafts persist the client's fare permission with their print snapshot and refuse
checkout if a later settings change takes the printer above that permission.

The retained `GET /express/shops?lat=...&lng=...&fulfillmentMode=...` preserves
its default `nearest` and legacy `top_rated | fewest_jobs` open-only list with
additive card metadata. Those legacy sorts keep their existing ranking behavior.
Explicit new sorts (`nearby | all_davao | fastest`) opt into the new card policy;
query booleans `shopsOnly=true|false`, `verifiedOnly=true|false` are supported.
It cannot quote `lowest_price`. The new screen should use the POST read with its
files to avoid counting printers that cannot accept that Preview.

## Files, Preview and Pay

Upload through the existing Files API or reuse an owned ready artwork file.
The server's document metadata supplies page count; the client cannot override
PDF counts. For a Drive source, the client must download/export the document and upload its
bytes through the Files API to obtain readable page metadata. The existing
`/artwork/link-check` probe does not import bytes or establish page counts; a
Drive viewer URL alone cannot create an Express draft.

There is no cart **screen**. The app creates an internal draft with
`POST /express/drafts`:

```json
{
  "supplierId": "shop_1",
  "location": { "lat": 7.06, "lng": 125.60 },
  "fulfillmentMode": "pickup",
  "files": [{
    "fileId": "file_1", "catalogItemId": "item_1",
    "copies": 2, "pageRange": "1-3, 5", "paper": "a4",
    "colour": "bw", "sides": "two", "layout": "fit_to_paper",
    "note": "Keep each copy together",
    "acceptedWarnings": ["paper_size_mismatch"]
  }]
}
```

Use `fulfillmentMode: "delivery"` with `dropoff: {lat,lng,label}` for delivery.
Pickup is at the chosen shop, without a rider/hub fee. Cash remains delivery-only.
One to twenty file entries are allowed. Copies are positive integers. Paper is
`a4 | short | long`, colour `bw | colour`, sides `one | two`, layout
`fit_to_paper | actual_size_centered | actual_size_original_position` (top-left).
The chosen listing must support the layout. The server selects its matching
colour/size options and standard (first active) paper stock; that stock is saved
with the print settings. Custom add-ons and client-supplied `optionIds` are refused.
Unrecognized required option groups return `express_listing_configuration_required`.
Omit `pageRange` for all pages. Accepted warnings are an array of
`paper_size_mismatch | rgb_colour`. Notes use the existing masked, 300-character
special-instructions contract.

Returns `201 {cartId, confirmation, quote, shop}`. `quote` includes
`clientItemSubtotalMinor` (printing including the fee), `deliveryFeeMinor`,
`organizationDiscountMinor`, `voucherDiscountMinor`, `totalMinor`,
`downpaymentMinor`, and `balanceMinor`. Amounts come from `clientCartQuote`, the
same builder used by ordinary checkout. Use the existing cart voucher endpoints
to select/remove a voucher, and `GET /me/carts/:cartId/quote` to refresh pricing.
Only one discount wins; the existing organization/voucher comparison is retained.
No price estimate is returned before files have a readable page count. Custom
cart write routes refuse Express draft changes with `express_draft_replace_required`.

Recreate the draft after changing files, print settings, shop or fulfillment;
clear the local “Looks right” tick. Submit through the existing endpoint:

```json
POST /me/carts/:cartId/checkout
{
  "looksRight": true,
  "expressConfirmation": "confirmation from the current draft",
  "payment": {
    "method": "qr_manual", "reference": "TRANSFER-REFERENCE",
    "proofFileId": "file_payment"
  }
}
```

Include the existing artwork rights consent and approval-proof fields when their
release gates require them. Enabled cash uses the existing `payment.method:
"cash"`; a fully funded voucher uses the existing zero-cash boundary. The server
rechecks shop availability, files, metadata, price and the preview fingerprint.
A changed preview returns `409 express_preview_required`. Ordinary checkout
errors, payment confirmation, file review and voucher expiry rules remain.

The result is the normal `{order, invoice}`, with `orderType: "express"` and
`expressOrder`. Stored line snapshots include the rate and print settings; client
projections omit internal pricing and pickup credentials before readiness.

## States, shop actions and five-minute timer

The existing `order.state` remains authoritative. `expressOrder.status` maps it
to `sending | accepted | printing | ready | picked_up | delivered | cancelled`.
The append-only `expressOrder.events[]` records timestamps, including `moved`,
`declined`, and `timed_out`. `expressOrder` also exposes `originalSupplierId`,
`currentSupplierId`, `declineCount`, `acceptBy`, and scoped `printSettings`.
Existing custom orders retain their previous response fields; only Express adds
`orderType: "express"`.

Sending initially includes payment confirmation and Operations artwork review.
Supplier access stays held until that review passes. The **five elapsed minutes**
start when the existing workflow assigns the released order to the shop, not
when the client uploads or submits a payment screenshot. `acceptBy` is an ISO
server timestamp. Acceptance exactly at the deadline is late.

Only the assigned, approved supplier may call:

- `POST /orders/:id/express/accept` with `{specialInstructionsRead:true}` when
  the order has notes (otherwise `{}`). Success is `200
  {orderId,state:"payment_authorized",expressOrder}`. Repeated acceptance is
  idempotent. It does not charge, release money or skip artwork/approval gates.
- `POST /orders/:id/express/decline` with `{reason:"Printer unavailable"}`.
  A decline or timeout increments the counter and chooses the nearest open,
  eligible document Express shop not already tried. The order and job assignment move
  together; original print/money snapshots remain. A delivery replacement must
  fall in the original zone and retain exactly the accepted delivery fee.
  Pickup document replacements also stay in their original distance zone.
  New orders snapshot the band limits; later settings edits cannot widen that
  accepted rerouting area or change the paid fare.
  The replacement gets a fresh five minutes.
  The old shop loses order/file access through the normal assigned-job scoping.
- **It's ready:** `POST /orders/:id/transition` with
  `{"state":"ready_for_dispatch"}` works directly from accepted
  (`payment_authorized`), `production`, or `supplier_self_qc` for document Express.
  The released supplier app's `production` then `ready_for_dispatch` chain also
  works. No production/finished/packing photo, product review or receipt-scan gate
  is required for this shop readiness action. Pickup waits for the client's code;
  delivery becomes ready for rider assignment. Ordinary orders, including the
  legacy listing `express` scheduling flag, retain all their existing gates.
  Ownership, supplier approval, checkout approval, payment, independent work
  holds and claim holds still apply. Payout amounts/releases do not change.
  Operations forced corrections still require the existing reason code and note.

**Reopened/interrupted production (Owner and Staff):** use
`order.orderType === "express"` together with
`order.transitionReadiness.ready_for_dispatch` from `GET /orders/:id` (or the
shop's order list). In `production` and `supplier_self_qc`, an unheld Express job
projects `allowed:true`, `missing:[]`, and `receiptScan.required:false`, even when
`shopHandover.finished` is absent. Offer **It's ready** and post the ordinary
ready transition; do not infer a finished-photo requirement from the empty
handover object. A false `allowed` and its `missing[]` entries still describe the
independent work/claim holds and state refusals. The write rechecks all guards.
`handoverFlow:"rider_packs"` continues to describe the rider's inspection,
packing-photo and signature contract for delivery; it does not reintroduce shop
production photos or product QA for Express. No new handover flag is needed.

At three refusals (timeouts count), or when no eligible same-price replacement
remains, the order/jobs become cancelled. No reassignment is allowed after a shop
payout release. Paid cancellations expose `refundRequired`; use the existing
`/orders/:id/refund-requests` process, including staff review, verified collection,
receiving destination and manual transfer. Cancellation never claims money has
already been returned. Voucher-only remedies use the existing no-cash settlement.
Clients can request cancellation through that same refund route before acceptance;
its hold blocks acceptance/timer work. After acceptance, today's refund and work-stop
rules continue; there is no new cancellation lock or charge.

Reassignment is automatic and notified to the client; the app can show the moved
event and the existing cancellation action. There is no extra move-approval state.
No automatic shop pausing is introduced. Delivery rider offers begin at the
existing ready-for-dispatch boundary. Pickup orders never enter rider offers.

**A3 and plans are manual choices.** They never automatically move, even when a
second shop has an equal price. A decline or shop timeout cancels that unpaid
choice and sets `expressOrder.repickRequired:true`; show the printer picker again
and create a new draft. Each price still comes from the shop's approved listing.
Checkout omits `payment`, returns `paymentTiming:"after_acceptance"`, and uses
the existing artwork review and shop acceptance. On acceptance, `expressOrder.payBy`
is five elapsed minutes later. The client submits payment evidence through
`POST /orders/:id/payments/initial/submit` strictly before that deadline; late
submissions return `409 express_payment_expired`. Timely submitted evidence keeps
the accepted price while Operations reviews it; the five minutes do not limit
Operations confirmation time. Unsubmitted payments expire to cancellation with
the same repick flag through the existing lifecycle/save boundary. Production
and readiness still require confirmed payment. Legacy accepted orders without a
`payBy` keep their existing behavior. Fully voucher-funded zero-cash checkout
retains the existing voucher settlement and requires no cash submission window.
This changes no payout shares or releases.

Client follow-up call sequence: upload/read Preview files; `POST /express/shops`;
`POST /express/drafts` (manual or Just print it); existing cart quote/voucher
calls if needed; `POST /me/carts/:cartId/checkout` with its confirmation; observe
`GET /orders/:id`/realtime for acceptance, `payBy`, moves or `repickRequired`;
submit initial payment only after acceptance for A3/plans. Standard documents
retain checkout payment. Supplier calls remain `/orders/:id/express/accept` and
`/decline`. The client app screen is a separate release; no UI ships here.
Enable the new screen after every API process runs this version, so older
processes cannot apply the earlier A3 reassignment/payment-window behavior.

## Shop counter code

This section is the **version 1** hand-over, used by every order placed without
`expressPickupPin` (all orders placed before this change, every released client
build, and Express groups). New client builds use
[On my way and pickup PIN](#on-my-way-and-pickup-pin) instead.

When ready, only the owning client's `expressOrder` includes `pickupCode`, a
six-character digit string (retain leading zeroes). Ordinary supplier, rider,
staff and unrelated-client projections do not reveal it.

The assigned approved shop calls
`POST /orders/:id/express/pickup` with `{ "code": "012345" }`.
This requires a ready pickup order, settled installments and no claim/refund/work
hold. Five wrong attempts impose a 15-minute retry delay. Wrong code returns
`409 express_pickup_code_mismatch`, throttling `429
express_pickup_attempts_exceeded` with `retryAfter`.

Success uses the existing handover completion function: records `pickedUpAt`,
opens the usual issue window, marks the job delivered, and leaves supplier
milestone amounts and Operations payout-release gates intact. Repeated success
is idempotent. Legacy transition routes cannot bypass the counter code.
Delivery Express orders use today's rider and delivery-proof flow. A shop-side
“Give to the rider” completion route is **not shipped**: today's version-2 flow
requires the assigned rider's six checks and exact per-line counts, an
inspection-bound rider packing photo, and the shop signature attached by that
rider through `/dispatch/:id/pickup-confirm`. A shop-only tap cannot supply or
confirm those rider-owned facts. Express skips the shop production evidence
only; replacing rider evidence/authority needs a separate handover contract.

## On my way and pickup PIN

Version 2 hand-over (report 83C6494A). The live tracker every order now carries
is in [ORDER_TRACKING_API.md](ORDER_TRACKING_API.md).

**Opt in at checkout.** A client build that shows the new screens sends
`"expressPickupPin": "on_my_way"` in `POST /me/carts/:cartId/checkout`. For a
single-client pickup order this snapshots `expressOrder.handoverVersion: 2` and
creates **no** `pickupCode`. Any other value is `400 invalid_express_pickup_pin`.
Delivery orders and Express groups ignore the opt-in and stay on their existing
flows. The handover version is immutable (database trigger), so an order never
switches flows part way. `expressOrder.pickupHandover` tells the app which flow
an order uses: `on_my_way_pin` or `counter_code`.

**I'm on my way.** `POST /orders/:id/express/on-my-way` (owning client) with an
optional `{ "location": { "lat": 7.06, "lng": 125.61 } }` (the client's current
point; the checkout location is used without it). Allowed only while the order is
ready (`ready_for_dispatch`), otherwise `409 express_not_ready`; version 1 orders
get `409 express_on_my_way_unavailable`. The first call:

- creates the 6-digit pickup PIN (leading zeroes kept) and returns it as
  `expressOrder.pickupPin` — the only place it is ever shown, and only to the
  owning client;
- records `expressOrder.onMyWay` `{at, updatedAt, walkMinutes, walkEstimateSource,
  clientLabel}`. The walk time is straight line at 80 m a minute; a home printer's
  point is rounded to 500 m like its shop card, so the estimate never pins a home
  address. `clientLabel` is the first name and last initial ("Mara L.");
- sends the shop a `shop_client_on_the_way` push: "Mara L. is on the way",
  "About 7 min away. Ask for the 6-digit pickup PIN before you hand over."

Repeating the call keeps the same PIN and only refreshes the walk estimate; the
shop is told once. The shop, its Staff and Operations see `onMyWay`,
`pickupPinIssued`, `pickupPinLocked` and (shop/Operations) `pickupPinRetryAfter`,
never the PIN. While the client is on the way the shop and its counter Staff also
see `counterCollection.amountMinor`, the cash to take at the counter (`0` when
already paid). This is the client's price, not shop earnings.

**Hand-over.** The shop (owner or Staff) calls the existing
`POST /orders/:id/express/pickup` with `{ "code": "482917" }`, plus
`"cashCollectedMinor"` when cash is owed at the counter:

| Case | Response |
| --- | --- |
| Client has not tapped I'm on my way | `409 express_pickup_pin_not_issued` |
| Wrong PIN | `409 express_pickup_code_mismatch` with `attemptsLeft`; nothing is handed over |
| 5 wrong in a row | `429 express_pickup_attempts_exceeded` with `retryAfter` (15 minutes) |
| 10 wrong in total | `423 express_pickup_pin_locked`; even the right PIN waits for Operations |
| Cash owed, amount missing | `400 cash_collected_required` with `amountDueMinor` |
| Cash amount differs | `409 cash_collected_mismatch` with `amountDueMinor` |
| Cash given but none owed | `400 cash_not_due` |
| Right PIN | `200`; repeat success is idempotent |

Wrong tries are committed even though they are refusals. A cash mistake is
checked before the PIN and is not counted as a PIN guess. On lock, Operations and
Super Admin get `ops_express_pickup_pin_locked` and the client gets
`order_pickup_pin_locked` ("Too many wrong PINs were tried at the counter…"); the
client's PIN is hidden until reset. Operations or Super Admin unlocks with
`POST /orders/:id/express/pickup-pin/reset` and `{ "reason": "…" }` (optionally
`"pin": "rider"`): it issues a new PIN, clears the counters, audits the reason
and tells the client (`order_pickup_pin_reset`). The old PIN stops working.

Success records `expressOrder.pickedUpAt` and `expressOrder.pickupHandover`
`{at, method:"pickup_pin", byUserId, cashCollectedMinor}`, then uses the same
handover completion as version 1 (issue window, job delivered, payouts and their
Operations gates unchanged). The PIN disappears from the client view.
`handedOver` `{at, method}` is projected to the client, and with
`cashCollectedMinor` to the shop and Operations.

Cash at the counter applies to orders whose checkout snapshotted
`paymentMethod: "counter_cash"`. The amount owed is the order total less any
settled installments. Hand-over records what the shop took, audits
`express.counter_cash_collected` and notifies Operations
(`ops_express_counter_cash_collected`); it does not confirm installments or move
shop money — the existing counter-cash ledger route in
[SHOP_MONEY_API.md](SHOP_MONEY_API.md) stays the money record. Orders without
counter cash still need settled installments (`409 payment_required`).

**Home printers** use the same flow at their pickup point; nothing extra is
exposed. **Delivery** gives the PIN step to the rider (below).

### Delivery: the rider PIN step

For an Express delivery, the assigned rider calls
`POST /orders/:id/express/on-my-way` while the order is `rider_assigned`. It
returns `expressOrder.riderPin.code` to that rider only and sends the shop
`shop_rider_on_the_way`. The shop enters the rider's PIN through the same
`POST /orders/:id/express/pickup` with `{code}`, with the same retry and lock
rules. Success sets `riderPin.verifiedAt` and moves nothing: the rider's six
checks, counts, packing photo and signature still hand the package over. A
reassigned rider needs a new PIN.

When Super Admin sets `expressRiderPinRequired: true` (default `false`),
`POST /dispatch/:id/pickup-checklist` and `/pickup-confirm` refuse with
`409 express_rider_pin_required` until the current rider's PIN is confirmed.
Leave it off until rider and supplier builds with the PIN step reach coverage,
so released rider apps keep working.

### Old and new app versions

| Client build | Order flow | What it sees |
| --- | --- | --- |
| Released (no opt-in) | version 1 counter code | Unchanged: `pickupCode` when ready |
| New (opt-in) | version 2 PIN | Tracker, I'm on my way, PIN after the tap |

Orders already in progress keep their `pickupCode` and the old hand-over. A
released supplier app keeps working for both: it already sends the client's
six digits to `/express/pickup`. On a version 2 order it gets
`express_pickup_pin_not_issued` until the client taps I'm on my way.

## Supplier offer push

Released Express assignments and replacements create `shop_express_offer`
inbox rows instead of `shop_job_assigned`. The owner copy shows shop principal
(earnings), printed pages including copies, client pickup/rider delivery and
minutes left in its title/body. Staff copies omit earnings, including the
original shop account after demotion; each current recipient gets one copy.
Every Express recipient must have an active membership in the notification's own
shop, including the original account. An earnings-bearing copy additionally
requires current Owner access. This is checked both at enqueue and delivery;
access to a different shop never substitutes for membership in the offering shop.
The generic account role-change notice retains its separate delivery exception.
Accepted, expired or moved offers are suppressed again before delivery. Retry copy uses the remaining
server time, and the message expires at the acceptance deadline.

The supplier app already registers category `gridgo_express_offer`, channel
`gridgo_express`, and actions `express_accept` (Accept) / `express_see` (See job).
Accept calls the existing ownership-checked `POST /orders/:id/express/accept`;
no token, credential, or unauthenticated accept URL is sent. Notes still require
`specialInstructionsRead:true`, so the app opens the accept screen when needed.

Android Express uses a high-priority data-only FCM presentation envelope:
fixed `categoryId`, `channelId`, sound and vibration, plus title/message and a
JSON `body` containing only the existing application routing fields
`notificationId`, `type`, `orderId`, `at`. This lets Expo display its category
buttons when backgrounded instead of Android displaying an actionless system
notification. iOS uses `aps.category`; its ordinary application data remains
unchanged. There are no file URLs, pickup codes, client identity or payout
stages in either payload. Channel audibility/lock-screen permission remains a
handset setting. An installed-device FCM walkthrough is still a release check.

## Shop-wide Express availability

Owners, including delegated owners/managers of the selected shop, use:

- `GET /me/express-settings` → `{expressEnabled:true, version:1}`.
- `PATCH /me/express-settings` with
  `{"expressEnabled":false,"expectedVersion":1}` → the new flag/version.

Use the normal `X-GRIDGO-Role: supplier` and selected `X-GRIDGO-Shop-Id` headers.
The shop-team model has `owner | staff`; a manager must have active `owner`
access. Ordinary Staff cannot read or write this switch. Invalid bodies return
`400 invalid_express_settings`; stale shared profile versions return
`409 shop_profile_stale`. A write audits the actual person and notifies
Operations/Super Admin. The additive `supplier_profiles.express_enabled` defaults
to true, preserving existing listing opt-ins. Off excludes the shop from new
Express drafts, checkout revalidation and automatic replacements without
rewriting any listing's `express` flag or changing an accepted order. Turning
on restores the individual listing preferences and all ordinary eligibility gates.

## Shop file access and delete reminders

`GET /jobs`, `GET /orders` and `GET /orders/:id` expose `order.fileAccesses` only
to that shop's active owners and Staff. Regular jobs omit the field until there
is an observation; Express jobs return an empty array when none exists. Each record is:

```json
{"jobId":"job_1","userId":"user_1","deviceId":"installation_1",
 "fileId":"file_1","action":"downloaded","firstAt":"2026-11-21T09:00:00.000Z",
 "lastAt":"2026-11-21T09:01:00.000Z","count":2}
```

After a full file opens or a download succeeds (including an already-signed
order attachment URL), the app/PC calls
`POST /orders/:orderId/files/:fileId/access` with
`{"jobId":"job_1","action":"opened","deviceId":"installation_1"}`.
`jobId` is optional: the server infers authorized job(s) from the file's line
assignment when omitted, since the ordinary order read need not expose internal
job IDs. Supplying it narrows the observation to that authorized job.
`action` is `opened | downloaded`. `deviceId` is a non-secret, locally persisted
installation identifier, 1–128 ASCII letters/digits/`_.:-`; never send a push
token or hardware identifier. The response is `200 {fileAccesses:[...]}`.
Repeated observations aggregate first/last time and count for each
job/shop/person/device/file/action; timestamps and person come from the server.

The route rechecks current membership, assigned job, artwork release and
job/line file authorization. Wrong scope returns `403`; missing order/file
`404`; invalid observation `400 invalid_file_access`. Logs remain scoped to the
shop that recorded them after reassignment. Clients and riders never see them.

Existing `GET /files/:id/download-url` additionally records
`action:download_authorized` for every authorized shop job. Send
`X-GRIDGO-Device-Id` to attribute that request to an installation; older apps
record `unspecified`. A signed URL issuance is not proof the bytes downloaded.
Use confirmed `opened`/`downloaded` rows for a precise delete-files reminder;
legacy apps can conservatively remind on `download_authorized`. Thumbnails and
background order-attachment signing do not record an open. No file bytes, URLs
or credentials are stored in the log, and logs do not delete files remotely.

Staff work reads also include `orderType`, scoped `expressOrder`, and the
allowlisted `paymentMethod` (`qr_manual | cash | gridgo_voucher`) plus
`paymentClassification` (`in_app | cash | voucher`) for the app's payment label.
Staff Express uses an explicit work-field/print-setting allowlist; it omits pickup
codes, free-text event history, payment amounts, references, proof and earnings.

Migration `1795270000000_express_shop_work` adds the shop availability flag and
indexed `shop_file_accesses` metadata table. Run it before API deployment.

## Guide and missions

`GET /me/express-guide` returns `{guide:{missions, popupLastShownDate,
guideSeen, guideCompleted, showPopup}}`. Missions are the existing server-derived
`added, placed, tracked, received, rated` flags; clients cannot mark operational
steps complete. Dates are server-derived Asia/Manila calendar days.

`PATCH /me/express-guide` takes one `action`:

- `popup_shown`: records today's date; `showPopup` becomes false for the day.
- `guide_seen`: Skip/seen, without completing the guide.
- `guide_completed`: permanently sets both seen and completed.
- `file_added` with `fileId`: records step one only after verifying an owned,
  ready artwork upload. Creating an Express draft also records this step.

Existing custom cart additions still complete step one. The popup stops after
that step. The guide itself creates no order and awards no reward. All other
mission rules and reward vouchers remain unchanged.

## Friend Pass

`POST /me/express-friend-pass` creates/reuses the existing tester referral code;
`GET` reads it. Both return `{friendPass:{link,signups,successful}}`. `link` uses
the existing Admin `testerSignupFormUrlTemplate` and is null until configured.
The existing referral self-invite and shared phone/device/address checks also apply.
Website signup and verified account matching reuse the existing tester invitation
endpoints; there is no email-based authentication linking.

When the referred client's first non-cancelled real order reaches `completed`
after the issue window, both parties receive one delivery reward. Each takes
5% off the delivery fee of its next eligible delivery checkout, rounded half-up
in integer centavos. It never reduces supplier principal or rider entitlement.
It competes with other discounts through the existing best-discount selection;
no stacking. Pickup cannot consume it. Reward wallets, reservations, redemption,
and no-fault restoration reuse vouchers, not Credits. These rewards use the
existing maximum 365-day voucher validity; their calculated peso value is shown
at checkout rather than as a fixed wallet face value. Existing mission/referral
voucher awards continue under their original rules.

The dedicated campaign purpose is `express_friend_pass`; its zero `valueMinor`
means variable value, never a free cash credit. The value is computed from delivery
at checkout, reserved, and snapshotted on the ordinary order. Campaign and per-client
wallet uniqueness prevent repeated completion events awarding it twice. Review
accounts never earn real rewards.

## Admin and release

`GET /ops/express/daily?date=2026-12-01` (Operations/Super Admin) returns
`{date,orderCount,cancelledCount,totalMinor,lowRatings}` for orders created on that
Manila day. `totalMinor` includes cancelled-order original totals; it is order
volume, not collected revenue. Low ratings are quality scores of one or two.
Submit ratings through the existing `POST /orders/:id/review` with whole-number
`qualityStars`, `speedStars`, `valueStars` (1–5) and optional `comment`, after the
issue window closes. A low Express rating also writes an admin inbox alert and queues
push through the normal save boundary. Review data is excluded from totals.

Run migrations before release:
`1795069000000_express_delivery_rewards` permits variable-value delivery vouchers
without changing fixed-value vouchers; `1795069100000_express_snapshots` protects
original shop, print facts and counter credential against updates. No schema work
runs at boot. Default rates require no production user or operational seed.

Main refusals beyond the existing contracts: `invalid_express_rates`,
`invalid_express_location`, `invalid_express_sort`, `invalid_express_files`,
`invalid_express_print`, `invalid_express_warnings`, `express_shop_unavailable`,
`express_listing_unavailable`, `express_preview_required`,
`express_acceptance_not_pending`, `shop_acceptance_expired`,
`express_reassignment_payout_released`, `express_pickup_required`,
`express_not_ready`, `express_pickup_code_required`, and `invalid_express_guide_action`.
Errors use `{error:"snake_case"}`. Wrong role/ownership is `403`; unknown IDs `404`;
invalid input `400`; state/timer conflicts `409`.

## Legacy listing compatibility

The prior listing/scheduling contract remains: `supplier_catalog_items.express`
is a boolean, default false, writable through `POST /me/catalog-items` or
`PATCH /me/catalog-items/:id` with `expectedVersion` (or `If-Match`). Invalid
non-booleans return `400 invalid_catalog_item`; stale versions return
`409 catalog_item_stale`. The switch remains non-review-sensitive metadata and
writes the existing `catalog_item.update` audit. Approved catalogue projections
retain the current switch even while a private review-sensitive revision waits.

Custom match/cart `expressPromise` remains false. Calendar `expressAvailable`
reports the listing switch, not whether today is reachable. Scheduling still
respects production time, queue, capacity, shop/GRIDGO hours and dispatch cutoff.
Historical `order.express` tags and stored promises keep their existing pilot
behavior. New document Express uses **orderType**, not that retired scheduling
tag, and receives no legacy penalty exemption. See [Scheduling](SCHEDULING_API.md).

Migration `1795069200000_express_reward_funding` retains the existing voucher
money guard and adds one narrow exception for a verified delivery-reward wallet:
exactly 5% delivery, zero service-fee/principal discount, delivery fulfillment
only. It does not loosen ordinary voucher allocation or payout rules.

## My shop status and night documents

`GET /me/shop-status` is the compact My shop/status-sheet read. Use the Clerk
bearer, `X-GRIDGO-Role: supplier` and the selected `X-GRIDGO-Shop-Id`. Active
Owners and Staff may read; **Owners alone may write in this release**. Manager
team permissions are a separate release; this does not grant a new role.

The response is `{supplierId,shopName,version,hours,todayHours,isOpenNow,
nextOpeningAt,expressEnabled,nightJobs,nightWindow,printerDemandPings,pausedUntil}`.
`hours` is the existing shop-hours projection; `todayHours` contains today's
Manila opening-minute windows (including a dated extension). `isOpenNow` also
includes an enabled night window; a pause or temporary closure closes both.
`nextOpeningAt` is null for a manually closed shop whose reopening is unknown.
`nightWindow` is the current configured night interval `{night,startsAt,endsAt}`
or null; actual availability additionally requires Express on, no pause/closure,
approval, account standing and an eligible document listing. `pausedUntil` is null
when a pause has expired. Reads never need a timer or a write to resume a shop.

`PATCH /me/shop-status` takes `expectedVersion` plus any of:

```json
{
  "expectedVersion": 1,
  "temporarilyClosed": false,
  "expressEnabled": true,
  "nightJobs": "until_23",
  "printerDemandPings": true,
  "pause": "one_hour"
}
```

`nightJobs` is `off` (default), `until_21`, `until_23`, or `all_night` and recurs
on scheduled shop days. Night windows begin at the final effective closing time
(after any weekday override or dated extension). They end exclusively at 21:00,
23:00, or the following day's first scheduled opening for all night (08:00 if
that following day has no scheduled opening). All night is a separate window
that can cross midnight; existing production schedules still use daytime windows.
Dated closures suppress night work on the closed date, including an overnight
spill. A closing time at or after the chosen end produces no night window.
All times use Asia/Manila. `pause` is `one_hour`, `today` (until the next Manila
midnight), or null (resume). Pause never changes the separate manual closure,
Express/listing preferences, prices, orders, or accepted promises. Pauses block
new matching and checkout; existing work can finish.

This shares the supplier-profile version with `/me/shop-hours`,
`/me/supplier-profile` and `/me/express-settings`; refresh after `409
shop_profile_stale`. Invalid fields are `400 invalid_shop_status`. The old
Express switch and temporary-closure routes remain supported and synchronized.
Changes audit the signed-in actor and enqueue durable admin notices atomically.

Night matching accepts only enabled `document_printing`, `per_page` Express
listings. It bypasses GRIDGO's daytime staff review calendar, because document
Express already uses automatic file checks and skips staff readiness review.
Queue and listing turnaround must fit in the remaining night window; oversized
work returns `409 express_night_capacity`. Accepted night promises/window facts
are snapshotted, and ordinary/custom scheduling is unchanged. The snapshot also
allows rider dispatch during that night window when a shop's daytime override
would otherwise forbid it.

`GET /express/shops?lat=...&lng=...&fulfillmentMode=pickup|delivery` adds
`nightWindow` and `deliveryAvailable` to each shop. Omitted mode defaults to
pickup for compatibility. Pickup at night goes directly to the shop, with the
existing Express pickup code. **Delivery is offered only while GRIDGO's rider
operating schedule is open**, and its estimated readiness must also fall in
that schedule. Draft creation and checkout recheck the selected mode and actual
listings' combined queue/turnaround projection, independently of the shop card's
fastest listing. Replacement selection applies the same check to listings that
actually support every accepted print setting. Dispatch still refuses new rider assignment outside that schedule; existing trips retain
their custody-completion rules. No night staff or off-duty riders are required.

### Opt-in demand pings

The client app calls `POST /express/demand` with
`{location:{lat,lng},fulfillmentMode:"pickup"}` when a signed-in client actively
looks for document printing. Default mode is pickup. It always returns
`{ok:true}` without recipient identities/counts. Suppliers cannot invoke it.
There is no scheduled broadcast and no pings from a passive catalogue GET.

Only approved, active, unpaused, open-for-night-Express shops with
`printerDemandPings:true` and an eligible document listing within **5 km** of
the requested location qualify. This includes home printers enrolled as shops;
no new account type or approval bypass is introduced. Each shop gets at most
**three pings per night**, with at most one per client per night. The night key
is the Manila date the night began, so midnight does not reset the budget. New
night = new budget; changing preferences or pausing does not reset it. Both the
current and prior Manila night histories are retained, so editing
hours across midnight and restoring them cannot reset either budget; older
histories are pruned only after they are no longer reachable.

`printer_demand` inbox rows go to current active Owners via the ordinary
notification/save/outbox service. Push carries only the existing allowlisted
notification ID/type/time, without client identity or location. Delivery rechecks
opt-in, pause/closure, night window and recipient ownership; queued retries are
suppressed after the deadline. Each send uses the earlier of the issued
deadline and the current matching night window end for mobile expiry and
browser TTL; shorter hours shorten retries, and later extensions never extend
an already-issued notice. All implemented demand events also create current Operations/Super Admin inbox rows.

### Supplier app and supplier web calls

- My shop card/status sheet: `GET/PATCH /me/shop-status` as above. Staff get the
  read-only status; disable all edits for Staff. Refresh on stale versions.
- Hours pencil: existing `GET/PATCH /me/shop-hours`.
- Products row/search: `GET /me/catalog-items` (existing pagination/search),
  `POST /me/catalog-items` to add; `PATCH /me/catalog-items/:id` with
  `expectedVersion` and `active:false|true` to hide/show. Hiding retains prices,
  options and ready-time settings; it does not reopen price review.
- Price/ready-time edits: the same PATCH with `basePriceMinor` and the existing
  production-time fields, or the existing price-tier/option routes. Price edits
  keep the governed listing-review contract.
- Remove: `DELETE /me/catalog-items/:id` with `expectedVersion`; referenced
  listings are archived and their accepted order-line snapshots still finish.
- Team: existing `/me/shop-team` contract. This API change has no UI screens;
  supplier app/web and client demand-call releases are companion work.

Apply `1795290000000_shop_availability` before API deployment. Its nullable
JSONB column is additive; old profile upserts omit it and preserve settings and
ping budgets, without new CHECK constraints. During rolling deployment, enable
the companion night/pause controls only after every API process runs this
version: older binaries remain schema-compatible but cannot enforce new gates.
## A3 extension

Guided document shops may offer A3 at their own snapshotted page prices. A3
Express uses artwork review, then shop acceptance, then client QR payment before
work starts. Standard Express retains checkout payment. See the exact calls in
[Supplier sign-up](SUPPLIER_SIGNUP_API.md#capability-aware-matching-and-a3-express).
