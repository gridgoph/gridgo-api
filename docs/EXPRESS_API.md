# Express listings

A shop can switch **Express** on for any of its listings. While it is on, the
listing can meet any deadline from today on, the same day included. In the
client's deadline calendar a kind of work with at least one Express listing has
every day from today **open**: none of those days is tight (yellow) or crossed
out because of production time. There is no extra charge, and for this testing
release there are no extra safeguards (no rider or reviewer availability check,
no queue priority, no add-on refund).

Code: `src/express.js` (the rule), `projectShopFinish` in `src/order-match.js`
(every match, cart and checkout projection), `deadlineDays` in the same file.
Migration `1792120000000_listing_express`.

## The shop's switch

`supplier_catalog_items.express boolean NOT NULL DEFAULT false`. Every existing
listing starts with it off.

| Route | Field |
| --- | --- |
| `POST /me/catalog-items` | Optional `express` boolean, default `false`. |
| `PATCH /me/catalog-items/:id` | Optional `express` boolean, with `expectedVersion` (or `If-Match`) like every listing edit. Omitted or `null` leaves it unchanged. A non-boolean is `400 invalid_catalog_item` with `field: "express"`; a stale version is `409 catalog_item_stale`. |

The change applies at once and **does not enter listing review**, the same as
turnaround and active/hidden changes: Express is the shop's own promise about
time, not what the client buys or what it costs. An approved listing with a
review-sensitive revision pending still uses the shop's current Express switch
on the approved version clients see. A change of the switch writes the
`catalog_item.update` audit with `detail: { express }`.

## Reads

All new fields are additive and optional for released builds.

| Read | Field |
| --- | --- |
| `GET /me/catalog-items`, `GET /me/catalog-items/:id` (shop) | `item.express` |
| `GET /ops/catalog-items`, `GET /ops/catalog-items/:id` (GRIDGO Team, Super Admin) | `item.express` |
| `GET /catalog/items/:id` and every public listing projection | `express` |
| `POST /me/matches`, `/me/matches/next` | `listings[].express`, `otherListings[].express`; `listings[].expressPromise`, `otherListings[].expressPromise`; root `expressPromise` |
| `GET /me/carts/:id` and line mutations | `lines[].listing.express` (the compact stubs from line mutations carry it too); `groups[].expressPromise` |
| `GET /me/deadline-days` | `expressAvailable` |
| Checkout response `order`, `GET /orders/:id` and every order projection | `order.express` |

`expressPromise` is true when the `readyBy` beside it is the Express promise
rather than the ordinary production projection. A listing with Express on can
still show `expressPromise: false`, because Express only answers the deadlines
its ordinary projection would miss (below).

`order.express` is the order's Express tag, visible to the client, the shop,
the GRIDGO Team and Super Admin: `true` when checkout promised the order under
Express, `false` on any other new order. Orders placed before this release do
not carry the field; read a missing value as `false`. It lives in `orders.data`
and, like the order's `readyBy`/`promiseBy`, never changes after checkout.

## The rule

For one listing (or one shop group) and one requested deadline:

1. The ordinary projection is computed as before: GRIDGO review hours, the
   shop's queue, turnaround, daily capacity, opening hours and the promise
   allowance.
2. If it meets the deadline, it stands. Express never changes a promise that
   already works, and work with **no deadline** is always projected the
   ordinary way.
3. Otherwise, if Express is on, the shop is promised for the deadline itself:
   `readyBy` (the shop's date) and `promiseBy` (the client's date) are both the
   **requested deadline**. No allowance and no review wait are added.
4. When the deadline's day is today but its clock time has already passed (the
   client app sends 18:00 on the chosen day), the promise is the **end of
   today** in the shop's time, and the deadline still counts as met. Express is
   available the whole day long.

A deadline on a day before today is never an Express deadline.

What still holds an Express listing back:

| Constraint | With Express |
| --- | --- |
| Production time, queue, daily capacity | Ignored |
| Shop opening hours (weekly schedule, extensions) | Ignored |
| GRIDGO review hours and promise allowance | Ignored |
| Temporary closure (`temporarilyClosed`) | Still excludes the shop from matching, so no Express |
| Dated closures (`closures[]`) | Still respected: Express needs at least one day from today through the deadline's day that is not a dated closure. A shop closed today is Express from its next non-closure day. |
| Approval, live service, complete public listing, printer width cap, take-down | Unchanged |

A shop group (a basket or an order with several products at one shop on one
deadline) shares one promise, so Express answers it only when **every** product
in the group is Express. Matching another product into a group that holds an
ordinary product uses the ordinary projection for both. Checkout makes the
Express promise for the soonest deadline on the order's lines.

Shop recovery replacements and production-deadline reschedules keep the
ordinary projection in this release.

## Deadline calendar

`GET /me/deadline-days?subcategoryCode=&days=` keeps `{days, earliest,
operatingStatus}` and adds `expressAvailable`.

- When at least one eligible listing of the kind of work has Express on, every
  day from that listing's first Express day (today, unless a dated closure
  shuts the shop) is `state: "open"` with `reason: null`. One Express listing is
  enough; it is never `tight`.
- `earliest` becomes the end of the first Express day when that is sooner than
  any ordinary promise.
- `expressAvailable` is a boolean, never a count of shops or listings.
- Days before the first Express day, and kinds of work with no Express listing,
  keep the existing `cannot` / `tight` / `open` behaviour and reasons.

The client app reads `state` alone to decide what is selectable, so released
builds already show these days as open.

## Matching, cart and checkout

`POST /me/matches` with a deadline that only Express can meet offers the Express
listings, each with `readyBy` equal to the Express promise and
`expressPromise: true`; ordinary listings that miss the deadline are left out as
before. The ranking itself is unchanged: an Express promise is simply an earlier
`readyBy` when speed is compared. Prices, the service fee and delivery are the
same as for the ordinary listing.

Selecting a listing through its `selectToken` saves the deadline on the cart
line exactly as before; `lines[].promiseBy` and `groups[].readyBy` then show
the Express promise for that deadline, and checkout snapshots it as the order's
`readyBy` and `promiseBy` and tags `order.express: true`. If the shop switches
Express off before checkout, checkout re-projects the ordinary way and refuses
with the existing `409 deadline_not_met`.
