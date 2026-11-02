# Quote requests: custom signage and 3D printing

Implements [gridgo-api#226](https://github.com/gridgoph/gridgo-api/issues/226). Some jobs
(custom store signage, 3D printing and scale models) have no fixed list price. The client
sends a short brief, Operations collects prices from suitable shops outside the app, and
the client picks one of up to three anonymous options. All amounts are safe-integer PHP
minor units (centavos).

## Design: an accepted option is an ordinary order line

The quote flow does not add a money model. When Operations publishes, each option becomes
a **private whole-job listing** (`supplier_catalog_items`, `pricingUnit: "whole_job"`,
`basePriceMinor` = the shop's own price, production time = the shop's reply). Accepting an
option opens a **fresh draft cart** holding that one listing at the brief's quantity. From
then on everything is the existing path: cart estimates, the progressive service fee,
fulfillment, checkout, the payment plan, approval proof (always `drawn`, the same as a
quoted line), the artwork file check, the shop's job, production, dispatch, payout stages,
claims and refunds. No order field is new.

Quote listings carry `quote_request_id` and `quote_client_id` (migration `1793640000000`).
They never show anywhere else: they are excluded from the public catalogue, matching,
carts of other clients, the shop's own catalogue board and search, listing review, the
staff listing index, supplier readiness, shop reviews and the pricing dashboard. Only the
owning client's cart can price one, and only the accepted option of an unexpired quote
checks out (`409 quote_not_accepted` / `409 quote_expired` at checkout otherwise). The
quote cart line is locked: adding another quote listing to a cart, or changing the line's
quantity, options, measurement, deadline, speed tier, print layout, spine, quantity mode,
structured spec (which carries the brief) or colour targets is `409 quote_line_locked`. The client may still change the line's artwork and special
instructions as in any cart.

## Statuses

| Status | Meaning |
| --- | --- |
| `requested` | Brief received; no shop reply yet. |
| `quoting` | Operations has recorded at least one shop reply. |
| `published` | Options A/B/C are visible to the client until `validUntil`. |
| `accepted` | The client chose an option; its cart is open (`cartId`). |
| `ordered` | Checkout placed the order (`orderId`). Terminal for this request. |
| `expired` | `validUntil` passed without an order. Operations may renew. |
| `cancelled` | Closed by the client or Operations. Terminal. |

Reads apply expiry lazily: a `published`/`accepted` request whose `validUntil` has passed
reads as `expired` before the sweep records it. The lifecycle sweep probes
`quote_requests_due_idx` and only then loads the graph to expire due requests (audit
`quote_request.expire`, quote listings deactivated, client and Operations notified).

## Validity

`validUntil` = publish time + `settings.quoteValidityDays` days (default **7**, integer
1–90). The setting is Super Admin only on `PATCH /settings`, with the usual
`expectedVersion` + `reason` handshake; bad values are `400 invalid_quote_validity_days`.
Operations can override one request's validity with `PUT /ops/quote-requests/:id/validity`.
Expired options cannot be accepted (`410 quote_expired`).

## Client endpoints

All need a Clerk session with a `client` membership (`403 membership_required` otherwise).
Another client's request is `403 forbidden`. Responses are `Cache-Control: private, no-store`.

### `POST /me/quote-requests` → `201 { quoteRequest }`

```json
{
  "productType": "business_store_signages",
  "use": "Shop front sign",
  "placement": "outdoor",
  "size": "2 x 6 ft",
  "quantity": 2,
  "referenceFileIds": ["file_..."],
  "notes": "Weatherproof please",
  "budgetMinor": 500000,
  "eventDate": "2026-11-20",
  "ranking": ["price", "deadline", "distance", "quality"],
  "fulfillmentMode": "delivery",
  "dropoff": { "lat": 7.07, "lng": 125.61, "label": "Event hall" }
}
```

- `productType`: `business_store_signages` or `three_d_printing_scale_models`
  (`400 invalid_quote_product_type`).
- `use` (≤500), `size` (≤200), `placement` (`indoor` | `outdoor`), `quantity` (1–100,000):
  required (`400 invalid_quote_request` with `field`).
- `referenceFileIds`: 1–10 distinct files the client uploaded with purpose `artwork` and
  state `ready` (`400 reference_files_required`, `409 file_not_ready`). They are retained
  while the request exists (file reference type `quote_request`) and become the cart
  line's starting artwork when accepted, where the listing accepts their format.
- `notes`: optional, ≤300 characters; it becomes the order line's special instructions
  (masked for the shop like any cart instruction, so it must pass that rule now).
- `budgetMinor`: optional, non-negative integer. Informational for Operations.
- `eventDate`: optional `YYYY-MM-DD` Manila date, not in the past (`400 invalid_event_date`).
  Informational: it never blocks; it drives each option's `eventDateFit` and the Operations
  warning below.
- `ranking`: optional matching priority; defaults to the client's saved preference.
- `fulfillmentMode` (`delivery` default | `pickup`) with `dropoff` or a saved `addressId`
  for delivery (`400 dropoff_required`; `409 hub_pickup_disabled` when hub pickup is off). The choice is
  copied into the accepted cart as its locked request fulfillment.

Audit `quote_request.create`; every Operations / Super Admin membership gets an
`ops_quote_requested` inbox row.

### `GET /me/quote-requests` → `{ quoteRequests: [...] }` (newest first)
### `GET /me/quote-requests/:id` → `{ quoteRequest }`

The client projection never contains a shop or supplier id, shop name, the shop's own
price, a reply id or a listing id — the same anonymity as matching:

```json
{
  "id": "qreq_...", "status": "published", "version": 4,
  "productType": "business_store_signages", "productTypeName": "Business & store signages",
  "use": "...", "placement": "outdoor", "size": "...", "quantity": 2, "notes": "...",
  "budgetMinor": 500000, "eventDate": "2026-11-20",
  "referenceFiles": [{ "fileId": "file_...", "originalFilename": "sign.pdf" }],
  "requestFulfillment": { "fulfillmentMode": "delivery", "dropoff": { } },
  "ranking": ["price", "deadline", "distance", "quality"],
  "options": [{
    "label": "A", "rank": 1, "clientPriceMinor": 345000,
    "productionTime": { "mode": "days", "minDays": 3, "maxDays": 3 },
    "readyBy": "2026-11-06T09:00:00.000Z", "eventDateFit": "before",
    "recommendedOptions": "Use tarpaulin with grommets",
    "distanceZone": { }, "rating": { }, "acceptable": true
  }],
  "matchReason": { "key": "price", "label": "..." },
  "publishedAt": "...", "validUntil": "...", "acceptedOption": null, "acceptedAt": null,
  "cartId": null, "orderId": null, "cancelledAt": null, "cancelledBy": null, "cancelReason": null,
  "expiredAt": null, "createdAt": "...", "updatedAt": "..."
}
```

- `clientPriceMinor` is the shop price plus the service fee (the same progressive
  schedule and organization discount checkout uses, snapshotted at publish). The final
  total, delivery fee and payment plan come from the cart, as for any order.
- `options` stay empty until published. `rank`/`matchReason` use the client's ranking with
  the matching badge logic (`compareFactors` / `REASON_LABELS` in `src/order-match.js`).
  `rating` appears only when the shop has a public rating.
- `eventDateFit`: `before` | `after` | `null` (no event date or unknown ready date).

### `POST /me/quote-requests/:id/accept` → `201 { quoteRequest, cart }`

Body `{ "option": "A", "expectedVersion": 4 }` (`expectedVersion` optional; a mismatch is
`409 quote_request_version_conflict`). Creates the draft cart described above and returns
it as the full cart projection (photo URLs decorated). The other options stop pricing.
Errors: `410 quote_expired` (the expiry is recorded in the same call, and the body carries
the refreshed `quoteRequest`), `409 quote_not_published`, `409 quote_already_accepted`,
`400 invalid_quote_option`, `409 quote_option_unavailable` (the shop can no longer take
the job). Audit `quote_request.accept`; Operations gets `ops_quote_accepted`.

Checkout of that cart (`POST /me/carts/:id/checkout`) moves the request to `ordered`
(audit `quote_request.ordered`) in the checkout transaction.

### `POST /me/quote-requests/:id/cancel` → `200 { quoteRequest }`

Optional `{ "reason": "..." }`. Allowed until ordered (also from `expired`); otherwise
`409 quote_request_closed`. Quote listings are deactivated, so an accepted cart cannot
check out. Audit `quote_request.cancel`; Operations gets `ops_quote_cancelled`.

## Operations endpoints

Operations or Super Admin only (`403 forbidden`). Every mutation accepts optional
`expectedVersion` for the request.

### `GET /ops/quote-requests?status=` → `{ quoteRequests: [...] }`

Newest 200. `status` is `open` (requested, quoting, and unexpired published/accepted) or a
single status (`400 invalid_quote_status`). Served from the targeted read graph: only the
matching requests, their replies, their clients, the replying shops and their profiles.

### `GET /ops/quote-requests/:id` → `{ quoteRequest }`

The client projection plus `client {id,name,email}`, `replies[]` (shop identity, own
price, `clientPriceMinor`, production time, `readyBy`, `eventDateFit`,
`recommendedOptions`, `note`, `publishedLabel`, `enteredBy`), options with
`replyId`/`supplierId`/`shopName`/`priceMinor`/`catalogItemId`, `cancelledById`, and
`eventDateWarning`:

- `event_date_passed` — the event date is in the past;
- `no_option_before_event` — every active reply is ready after the event date;
- `event_date_soon` — no replies yet and the event is less than 3 days away.

The warning never blocks anything.

### `POST /ops/quote-requests/:id/replies` → `201 { quoteRequest, reply }`

```json
{
  "supplierId": "user_...",
  "priceMinor": 300000,
  "productionTime": { "mode": "days", "minDays": 3, "maxDays": 3 },
  "recommendedOptions": "Use tarpaulin with grommets",
  "note": "Called the shop at 10am",
  "supplierServiceId": "svc_..."
}
```

The shop must pass the ordinary matching gates (`404 supplier_not_found`,
`409 quote_shop_unavailable` with `blockers`). `supplierServiceId` defaults to the shop's
live service line in the product's category (else its first live line). `productionTime`
uses the catalogue shape (`{mode:"same_day",hours}` or `{mode:"days",minDays,maxDays}`).
`priceMinor` is a positive integer. Allowed while `requested`, `quoting`, `published` or
`expired`; otherwise `409 quote_request_closed`. The first reply moves `requested` to
`quoting`. Audit `quote_request.reply`.

### `PATCH /ops/quote-requests/:id/replies/:replyId` → `200 { quoteRequest, reply }`

Any of `priceMinor`, `productionTime`, `recommendedOptions`, `note`, `withdrawn`
(boolean), plus optional `expectedReplyVersion` (`409 quote_reply_version_conflict`).
`404 quote_reply_not_found`. Editing a published reply does not change what the client
sees until Operations publishes again. Audit `quote_request.reply_update` with before/after.

### `POST /ops/quote-requests/:id/publish` → `200 { quoteRequest }`

`{ "replyIds": ["qrep_a", "qrep_b"] }`: one to three active replies, at most one per shop
(`400 invalid_quote_options`, `409 quote_reply_not_found`, `409 quote_replies_required`
before any reply). Each shop must still pass the gates and have an open production
calendar (`409 quote_shop_unavailable`). Options are ranked by the client's priority and
labelled A, B, C in rank order. Publishing again (from `published` or `expired`) replaces
the options, deactivates the earlier quote listings and restarts validity. Audit
`quote_request.publish`; the client gets `quote_options_ready`, Operations
`ops_quote_published`.

### `PUT /ops/quote-requests/:id/validity` → `200 { quoteRequest }`

`{ "validUntil": "2026-11-20T10:00:00.000Z", "reason": "Shop holds price" }`. Future and at
most 90 days away (`400 invalid_quote_validity`); `reason` required. Allowed on published,
accepted or expired (with options) requests. Renewing an expired request restores what
lapsed: its open options, or the client's accepted cart. Audit
`quote_request.validity_update`; the client gets `quote_validity_changed`.

### `POST /ops/quote-requests/:id/cancel` → `200 { quoteRequest }`

`{ "reason": "..." }` (required). Same rules as the client cancel; the client gets
`quote_cancelled`.

## Inbox and audit

Notification rows carry `quoteRequestId` (projected on `GET /notifications`) and go
through `save()`, so push and realtime delivery follow `docs/REALTIME_EVENTS.md`.

| Type | Recipient | When |
| --- | --- | --- |
| `ops_quote_requested` | Operations + Super Admin | Client created a request |
| `ops_quote_published` | Operations + Super Admin | Options published |
| `ops_quote_accepted` | Operations + Super Admin | Client accepted an option |
| `ops_quote_cancelled` | Operations + Super Admin | Either side cancelled |
| `ops_quote_expired` | Operations + Super Admin | Validity lapsed |
| `quote_options_ready` | Client | Options published |
| `quote_validity_changed` | Client | Operations changed validity |
| `quote_cancelled` | Client | Operations cancelled |
| `quote_expired` | Client | Validity lapsed |

Audit actions: `quote_request.create`, `.reply`, `.reply_update`, `.publish`, `.accept`,
`.ordered`, `.validity_update`, `.cancel`, `.expire` (entity type `quote_request`).

## Storage

`quote_requests` (status, client, product type, quantity, budget, event date, validity
and version as columns; the brief, fulfillment, ranking and published option snapshots in
`data`) and `quote_replies` (shop, status, price and version as columns). Both are in the
store compatibility adapter; client and Operations reads use targeted reads
(`readQuoteGraph` in `src/postgres-store.js`).

## Not in this change

The client app (brief form, options screen), the Operations dashboard (queue, reply entry,
publish) and any supplier-side quoting UI. Shops do not see quote requests; Operations
enters their replies.
