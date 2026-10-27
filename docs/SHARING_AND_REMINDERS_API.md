# Order sharing and rider handoff reminders

API half of [client story card](https://github.com/gridgoph/gridgo-client/issues/341)
and [rider reminder](https://github.com/gridgoph/gridgo-rider/issues/157).
Apply migration `1793125000000_order_sharing_delivery_reminders` before deploying.
All routes require Clerk authentication. Responses are private/no-store, and
all timestamps are server-assigned ISO timestamps. Errors use `{ "error": "snake_case" }`.

There is no share reward or rider incentive. Existing survey, mission, invite,
voucher and payout rules are unchanged. A tap is an attempt to open the phone's
share sheet; it is not proof that anything was published. No image is generated
or uploaded here: the client renders the 9:16 GRIDGO design without a photo.

## Client share data

Owning client only; other clients get `404 order_not_found`, other roles `403 forbidden`,
missing authentication `401 unauthorized`.

`GET /orders/:id/share` returns the current data without mutation.
`POST /orders/:id/share/prepare` with `{}` idempotently ensures the client's
existing tester invite code and returns the same shape. Call prepare before
rendering a share card or opening the delivered-order Share button.

```json
{
  "serverTime": "2026-10-28T01:00:00.000Z",
  "share": {
    "orderId": "order_123",
    "available": true,
    "firstName": "Ana",
    "foundingTester": true,
    "inviteCode": "0123456789ABCDEF01234567",
    "inviteLink": "https://configured-signup.example/?code=0123456789ABCDEF01234567",
    "card": {
      "firstShownAt": null,
      "dismissedAt": null,
      "repeatShownAt": null,
      "closedAt": null,
      "showAfterSurvey": true,
      "showFromOrder": false
    }
  }
}
```

`available` means a delivered order (including completed issue windows or hub
collection) or any order with a submitted survey, including an eligible failed-order
survey. Manual sharing remains available after the card has been exhausted and
does not require a survey. Review data is unavailable for public sharing.
Prepare/card/tap writes before availability return `409 order_share_not_available`.
GET still returns `200` with `available: false`.

`firstName` is the first whitespace-delimited part of the client's saved name.
`foundingTester` means the label was awarded, rather than merely eligible.
The code is the same stable code returned by `/me/founding-tester`; prepare
does not issue or reconcile rewards. Before prepare, code/link can be null.
`inviteLink` also remains null if the existing Super Admin setting
`testerSignupFormUrlTemplate` is unset. Use the code in that case; do not invent
a destination or share a QR pointing at an unconfigured signup route. The app
adds the link to Share text and shares only the link for Send to a friend when
a link is configured.

## Card lifecycle

After a successful `POST /orders/:id/survey`, call prepare and inspect
`card.showAfterSurvey`. A submitted survey is required for automatic cards.
The order screen uses GET and inspects `card.showFromOrder`.

`POST /orders/:id/share/card` accepts:

```json
{ "presentation": "after_survey", "action": "shown" }
```

- `presentation`: `after_survey` or `order_repeat`.
- `action`: `shown`, `maybe_later`, or `close`.
- Response: `200 { serverTime, share }`, as above.

Record `shown` when displaying the card. This clears the corresponding show
flag. An initial `maybe_later` records dismissal and enables one `order_repeat`.
Recording repeat `shown` consumes that repeat permanently, even if the app
closes before sending its dismissal. A repeat `maybe_later` closes the card.
`close` after a shown card permanently ends automatic prompts (including when
the client finishes a Share/Send to a friend action). The card must always be
closable in the UI. Manual Share remains available.

Each transition is idempotent for its named presentation. Retrying an initial
shown/dismiss after the repeat has appeared cannot close or reset that repeat.
Closed cards never reopen. A repeat before initial dismissal, or a dismissal/
close before that presentation was shown, returns `409 share_card_transition_invalid`.
No submitted survey returns `409 share_card_not_available`; invalid action/
presentation returns `400 invalid_share_card_event`. Non-object JSON is
`400 invalid_request`. Unsupported methods/paths return `404 not_found`.

## Tap recording

`POST /orders/:id/share/taps` accepts:

```json
{ "eventId": "5daf3673-c956-4b5d-b187-9051767a445b", "action": "share" }
```

Use a new UUID v4 for each actual tap, persist it locally for network retries,
and reuse that ID for retries. `action` is `share` or `send_to_friend`.
The event key is scoped to the authenticated client across all their orders.

Response is `200 { serverTime, share, eventId, recorded: true, replay: false }`.
An identical retry returns `replay: true` and counts once, including concurrent
requests. Reusing the key for a different action or order returns
`409 share_tap_conflict`; invalid UUID/action returns `400 invalid_share_tap`.
Tapping does not itself change card state; send the appropriate card close
event separately. It never creates a voucher, credit, reward or payout.

## Rider delivery completion

The existing `POST /dispatch/:orderId/delivery` retains its current evidence,
payment, Proof of Fulfilment, assignment/approval and OTP gates. New rider builds
must send `handoffReminderVersion: 1` for door delivery:

```json
{
  "evidenceType": "photo",
  "evidenceFileId": "file_delivery",
  "otp": "123456",
  "handoffReminderVersion": 1,
  "remindedClient": true,
  "clientAgreedToPhoto": true,
  "packagePhotoFileId": "file_package"
}
```

`otp` is only needed when the order uses the existing OTP handover.
`clientAgreedToPhoto` is optional, defaults false, and must be a JSON boolean.
`packagePhotoFileId` is optional/nullable; agreeing to a photo does not require
one. A package photo requires `clientAgreedToPhoto: true`. The regular delivery
photo/signature remains required independently of the optional package photo.

Upload the package-only JPEG/PNG/WebP (max 20 MiB) via existing multipart
`POST /files` with `purpose=delivery_package_photo`, then
`POST /files/:fileId/attach` with `{ "orderId": "order_123" }`.
Only the assigned approved rider can attach it, while the door delivery is
`picked_up` or `out_for_delivery`. Attachment stages a rider-only candidate;
it does not record consent or authorize client/staff reads. Photograph the package only, never documents
or shop signage; the server validates the file's image type, ownership,
readiness and order reference, not its visual contents.

The normal `200 { order }` completion response now includes, for the owning
client, assigned rider and ops/super only:

```json
{
  "deliveryReminder": {
    "orderId": "order_123",
    "clientId": "client_123",
    "riderId": "rider_123",
    "deliveredAt": "2026-10-28T01:00:00.000Z",
    "protocolVersion": 1,
    "remindedClient": true,
    "clientAgreedToPhoto": true,
    "packagePhotoFileId": "file_package"
  }
}
```

The rider can preview attached candidates before completion. Clients and staff
receive an empty `deliveryPackagePhotoFileIds` list and cannot read package
photo metadata or signed downloads until completion commits an affirmative
reminder and photo consent with that selected file ID. Completion retains only
that selected photo and detaches every other candidate in the same transaction.
Consent false, omitted consent, an omitted photo ID, or a legacy completion
retains no package photo. Discarded candidates lose their order reference and
become unused uploads for the existing retention cleanup. A failed completion
leaves the candidates private for a corrected retry; an abandoned attachment
never becomes client/staff delivery proof and retains the existing order-file
retention and open-case protections.

Use the existing `GET /files/:fileId` signed-read flow. The selected package photo
is private to its approved rider owner, owning client and ops/super; suppliers
cannot read it or receive these fields. Delivery reminder snapshots are
immutable. Photos follow delivery-proof retention and open-case holds and are
included in staff issue evidence.

New errors (in addition to existing delivery/storage errors):

| Status | Error | Condition |
| --- | --- | --- |
| 400 | `unsupported_handoff_reminder_version` | Any new reminder field supplied without integer version 1, or unsupported version |
| 400 | `client_reminder_required` | Version 1 door delivery without literal `remindedClient: true` |
| 400 | `invalid_photo_consent` | Photo consent supplied with a non-boolean value |
| 400 | `invalid_package_photo` | Photo ID is empty or non-string (null is allowed) |
| 400 | `package_photo_consent_required` | Photo ID supplied without consent |
| 400 | `package_photo_required` | Photo is not the assigned rider's ready image of the correct purpose attached to this order |
| 409 | `package_photo_upload_not_allowed` | Package photo attachment outside an unfinished door delivery |
| 409 | `delivery_reminder_not_available` | Client reminder/consent/photo fields supplied on a hub drop-off |

Validation happens before OTP verification, completion, receipt issuance or
payout-proof changes. A refusal commits no reminder or completion.

### Older riders and hub drop-offs

This follows the existing legal-consent request-version capability pattern;
there is no authenticated global rider build/version enforcement in this API.
Omitting **all four** new fields retains the released-app completion path and
records `protocolVersion: 0`, `remindedClient: false`,
`clientAgreedToPhoto: false`, `packagePhotoFileId: null`. It never infers consent.
New apps must send version 1; a caller omitting the whole capability still uses
legacy behavior. Universal enforcement requires old-build update coverage/a
separate rollout decision. No global minimum version is changed by this release.

Hub drop-offs do not involve the client and do not require a reminder; omit
the acknowledgement/consent/photo fields. Version 1 alone is accepted for hub
drop-offs, but creates no client reminder record or dashboard denominator.
Existing delivery evidence remains unchanged for all old and new builds.

## Staff dashboard

Both endpoints require an `ops_admin` or `super_admin` database membership;
all other authenticated roles get `403 forbidden`, anonymous callers get
`401 unauthorized`. They return `200` JSON and exclude review clients/orders.

Both accept optional `from`/`to` ISO timestamps, `offset` (default 0), and
`limit` (default 100, range 1–500). The interval is inclusive from, exclusive to.
Invalid timestamps or `from >= to` give `400 invalid_share_filter`; invalid
pagination gives `400 invalid_pagination`. `total` is the number of grouped
rows before pagination. No mutation methods are supported (`404 not_found`).

`GET /ops/mission-shares?clientId=client_123`:

```json
{
  "serverTime": "2026-10-28T01:00:00.000Z",
  "total": 1,
  "clients": [{ "clientId": "client_123", "shareTaps": 3, "sendToFriendTaps": 2 }]
}
```

`clientId` is optional. Includes current clients with zero taps. Date filters
apply to server-recorded tap timestamps; counts are tap events, not unique
orders or successful posts. Rows sort by client ID.

`GET /ops/delivery-reminders?riderId=rider_123`:

```json
{
  "serverTime": "2026-10-28T01:00:00.000Z",
  "timezone": "Asia/Manila",
  "total": 1,
  "weeks": [{
    "riderId": "rider_123",
    "week": "2026-W44",
    "weekStart": "2026-10-26",
    "deliveries": 4,
    "remindedDeliveries": 3,
    "legacyDeliveries": 1,
    "reminderRate": 0.75,
    "surveySubmittedDeliveries": 2,
    "shareTappedDeliveries": 1,
    "surveyAndShareDeliveries": 1
  }]
}
```

`riderId` is optional. Weeks use the Asia/Manila Monday calendar date and ISO
week-year (including cross-year weeks). Rows sort newest week first, then rider
ID. Date filters select **delivery cohorts**, not the follow-through timestamps.
There are no empty rider/week rows. `reminderRate` is the fraction 0–1,
`remindedDeliveries / deliveries`.

`deliveries` counts door deliveries, including old requests and historical
file-backed delivery evidence. `legacyDeliveries` counts version 0 or historical
deliveries with no recorded capability. They stay in the denominator and never
count as reminded. The rider and delivery time use the immutable reminder
snapshot, falling back to the old delivery-evidence snapshot for history.

The last three fields count **reminded orders** whose owning client subsequently
submitted the survey, tapped `share`, or did both, respectively. Each order
counts at most once regardless of repeated taps. Only actions at/after that
order's delivery count. `send_to_friend` does not count as `share`. Repeated
orders from the same client count independently; another order's survey/taps
cannot be attributed to this delivery. Follow-through can appear in later
requests as clients respond after the delivery week. None affects rider pay.
