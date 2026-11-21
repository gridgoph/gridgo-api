# Express API

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

Only active, approved suppliers open now under their shop calendar qualify.
They must have a public, approved `document_printing`, `per_page` listing with
`express: true`, and the shop-wide `expressEnabled` must not be false.
The listing switch remains its individual opt-in; staff
visibility/approval holds still apply. Shop setup must offer the print layouts
and option selections it accepts. Busy means at least three assigned/accepted/
printing jobs. New means less than seven elapsed days since supplier approval
(falling back to account creation for legacy rows). The first New shop is put
second in `top_rated` and `fewest_jobs`; nearest remains strictly distance sorted.
Rating uses the existing public rating threshold; it is null below that threshold.
Ready time uses the existing queue/calendar projection, not an invented rush SLA.
Review-data suppliers never mix with ordinary clients.

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
  eligible Express shop not already tried. The order and job assignment move
  together; original print/money snapshots remain. A delivery replacement must
  fall in the same delivery-fee band. The replacement gets a fresh five minutes.
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

## Shop counter code

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

## Supplier offer push

Released Express assignments and replacements create `shop_express_offer`
inbox rows instead of `shop_job_assigned`. The owner copy shows shop principal
(earnings), printed pages including copies, client pickup/rider delivery and
minutes left in its title/body. Staff copies omit earnings. Removed/demoted
members never receive an earnings-bearing copy; accepted, expired or moved
offers are suppressed again before delivery. Retry copy uses the remaining
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
to that shop's active owners and Staff. Each record is:

```json
{"jobId":"job_1","userId":"user_1","deviceId":"installation_1",
 "fileId":"file_1","action":"downloaded","firstAt":"2026-11-21T09:00:00.000Z",
 "lastAt":"2026-11-21T09:01:00.000Z","count":2}
```

After a full file opens or a download succeeds (including an already-signed
order attachment URL), the app/PC calls
`POST /orders/:orderId/files/:fileId/access` with
`{"jobId":"job_1","action":"opened","deviceId":"installation_1"}`.
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
