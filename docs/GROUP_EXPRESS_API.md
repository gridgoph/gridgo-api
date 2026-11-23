# Group Express API

This API supplies the host/member and rider companion screens for reports
29CB83A5, 0459C559, FE7FA7C0, F54BDF7A and 134A8F09. No screen ships in this
repository. All calls require Clerk authentication and the selected client role,
except rider calls, which require the approved assigned rider.

The group contains at most 15 people including its host. A person can belong to
only one open or checkout-open group. Invite tokens contain 256 random bits;
only SHA-256 digests persist. The token expires at `closesAt` and refuses full,
closed, checked-out and cancelled groups. A removed member cannot read the group.
The create response returns the token once. The client builds its share link/QR
and app/store routing around that token.

## Client calls

1. `POST /express/groups` with `{fulfillmentMode:"delivery"|"pickup",location,
   dropoff?,backupReceiver?:{name,phone},timeLimitMinutes?:15|30|60}`. The default
   is 30 minutes. Delivery requires a labelled host dropoff; backup is delivery
   only. Response: `{group,inviteToken}`. No shop is selected at setup.
2. `GET /express/groups/invites/:token` returns only host name, count, mode,
   closing time and group ID. `POST .../:token/join` joins the signed-in person.
   Closed/expired/full links return `409 group_closed`.
3. `GET /me/express-groups` lists the caller's groups. `GET /express/groups/:id`
   returns status, people/printing people, closing/payment times and `me`.
   `me` contains only the caller's files, selected page count including copies,
   client print subtotal, delivery share, amount owed and paid-back tick.
   The host additionally receives member summary rows and the complete total;
   those rows contain no member files or price per page. Only the host receives
   its address, backup receiver and internal cart ID.
4. `PUT /express/groups/:id/files` replaces the caller's files with `{files:[...]}`,
   or removes them with an empty array. Each entry uses today's Express Preview
   controls: `fileId,copies,pageRange,paper,colour,sides,layout,note,acceptedWarnings`.
   Upload owned, readable, ready artwork first through the existing Files API.
   This release covers A4/short/long Express documents, up to 20 entries per
   person. It reuses detected pages, warnings, approved listings and normal
   Express pricing. The host cannot edit another person's files.
5. `POST /express/groups/:id/leave`; host removal is
   `DELETE /express/groups/:id/members/:userId`. Both stop at checkout opening.
   The host cancels an unordered group with `POST .../:id/cancel`.
6. `POST .../:id/close` opens checkout and locks membership and files. The timer
   does this automatically at the group deadline. It does not create a payment,
   charge a card or manufacture payment evidence. The host then calls
   `POST .../:id/prepare` with `{}` for delivery, or `{supplierId}` for pickup.
   Delivery selects the nearest currently open eligible Express shop capable
   of all files; pickup uses the host's selection. The response supplies
   `{group,cartId,confirmation,quote,shop}`. Review that exact quote. Preparation
   can be repeated to refresh a shop/quote without reopening member editing.
7. Voucher selection and quote refresh reuse today's cart voucher/quote routes.
   Submit only via `POST .../:id/checkout`, with today's `looksRight:true`,
   `expressConfirmation` and existing QR `payment` evidence (or enabled cash /
   fully-funded voucher). The response is `{group,orderId}`. The internal
   `/me/carts/:cartId/checkout` rejects group carts. There is one ordinary Express
   order, invoice and host payment. No member collection or wallet is created.
8. `GET .../:id/tracking` supplies state, the caller's own totals/files, the
   existing delivery milestones and privacy-filtered live rider location/status.
   Only the host gets pickup/delivery codes or the replacement-shop decision.
   The host can also use today's order/payment, invoice and handover endpoints.
   Members cannot use those owning-client routes, call/chat the rider, or open
   another person's file. Existing call/chat stays between the rider and host.
9. `PATCH .../:id/members/:userId/paid-back` with `{paidBack:boolean}` is host-only,
   available after checkout too, and updates tracking only. It never changes
   the payment, member totals, revenue, payout or collection records.
10. `POST .../:id/shop-decision` with `{decision:"use"|"cancel"}` acts on the
    currently pending replacement. The host sees its name, distance and map
    point; members get only a shop-change notice. Five minutes without an
    answer means use. Work remains held until the choice resolves. The new
    shop then has its ordinary five-minute acceptance window.

The ten-minute unpaid limit starts when checkout opens, including automatic
opening. Super Admin can edit `groupPaymentTimeoutMinutes` (integer 1–60,
 default 10) via today's versioned, reason-required `PATCH /settings`. The issued
`payBy` is snapshotted. No order/payment exists while this timer runs. Submitted
QR evidence finishes group checkout and follows today's confirmation workflow;
Operations review time is never treated as unpaid expiry. Expired groups notify
all active people and cannot check out.

After completion, the host rates the shop through today's
`POST /orders/:orderId/review`. Any active group participant can additionally
call `POST /express/groups/:id/review` with whole-number 1–5 `qualityStars`,
`speedStars`, `valueStars`, optional `riderStars` and optional `comment` (2000
characters). Each participant gets one private feedback record, returned only
in their own `me.review`; these do not add duplicate shop-ranking reviews for
one paid order. The existing host review remains the public shop-rating source.

## Money and privacy

All amounts are integer PHP centavos, using BigInt for allocation products.
Every file/member mutation recalculates against the shared checkout quote.
Printing including today's unchanged service fee is allocated proportionally to
selected-page principal, with largest-remainder centavos. Applicable existing
host discounts/vouchers reduce the amount allocated. There is no group discount.
Delivery rewards/vouchers use their existing payable delivery component for
sharing, so fully funded checkouts leave nobody owing cash. The sum of all
member amounts, including the host contribution, equals exactly
the checkout total. Checkout snapshots these amounts; later settings never
reprice them.

For delivery, divide the fare by people with files, then round each non-host
printing person's share up to a whole peso. The host receives the remainder:
PHP 89 across three printing people is 30, 30, 29 for the host. If the host has
no files, its contribution can be a negative rounding adjustment, balancing the
others' whole-peso reimbursements; this is display arithmetic, never a wallet.
Pickup shares are zero. Prior to preparation a nearest-capable-shop quote is
indicative; the selected checkout quote is authoritative.

Cash retains today's solo eligibility and enablement gates, with an additional
group restriction: the **full payable order total including delivery must be
strictly below 150000**. The rider collects that full total from the host.
Cash at the counter is omitted because solo Express has no live counter-cash
method. No new payment method, split-payment collection, service-fee schedule,
approval or payout plan is introduced.

The shop receives one normal Express order. `productionItems[].groupMember`
identifies each packing bundle; Express print settings retain that member's
name/ID. Client projections and file reads keep each person's files private,
including from the paying host. Client projections omit internal rates/payouts.

## Rider calls and handover

Normal job/order reads add `groupOrder:{id,memberCount,hostName}`. Existing
pickup, calls and delivery chat are unchanged and contact the host only.
Report arrival with `POST /dispatch/:orderId/milestones` and `{milestone:"arrived"}`.
`GET /dispatch/:orderId/group-backup` returns `{backup:{unlocked:false}}` until
there are two **server-recorded missed delivery calls from this assigned rider
to the host**, or five elapsed minutes after this assignment's arrival.
After unlock, `backup.receiver` contains the configured name/phone. Never submit
missed-call counters from the app. No backup means today's failed-delivery rule.
For a shared arrival estimate, the rider calls
`POST /dispatch/:orderId/group-arrival-estimate` with `{minutes:1..180}` after
pickup. This is explicitly the assigned rider's estimate, not a routing-service
promise. It is shared in tracking as `estimatedArrivalAt` and triggers a batched
on-the-way notice for host/members; reassignment invalidates the old estimate.
The receiver uses the same host-provided six-digit delivery OTP. The API returns
no answer code to the rider. Group delivery uses the existing OTP verification
flow even if the optional solo OTP setting is off; ordinary solo behavior stays.

## Replacements and refunds

Existing Express decline/timeout selection retains the original fare zone,
accepted price and money snapshots, and excludes tried/closed/incapable shops.
It never widens into another zone, even if current prices happen to match.
Three declines/timeouts or no same-zone shop cancels. Host refusal of a proposed
replacement cancels before work too. These cancellations create a full-refund
**request under the existing available-funds policy** once collection is
verified; no endpoint pretends to have transferred money. Pending QR evidence
can still be verified before refund intake. Voucher remedies reuse the existing
no-cash settlement. The host supplies a receiving destination through the
existing refund destination route; Operations reviews, reserves and records
manual payment through today's refund routes. No new refund transfer path.

## Alerts and release

Group joins, file changes, five-minute warning, checkout opening, placement,
removal, cancellation, shop change, readiness, on-the-way and delivery write
recipient-specific Alerts rows. Existing `/notifications` and realtime streams
carry `groupId` for deep links; existing push routing remains notification ID,
type, order ID and timestamp only. Fetch the Alert to route before an order
exists. Every event also writes Operations/Super Admin inbox rows.

Each person's group pushes are batched to at most one enqueue per minute across
groups. Event Alerts stay durable; a delayed summary carries updates through the
normal post-commit outbox. Pickup codes occur only in host-ready copy. Push text
contains client totals and never internal fee/payout breakdowns. Poll/realtime
refetch the group and `/tracking` after group/order notifications. Companion
client/rider screens must ship separately.

Apply additive migration `1795476000000_express_groups` before API release.
It creates new tables only, with no new constraints on old writers' upserts.
Enable companion group entry only after every API replica runs this release:
old binaries are schema-compatible but cannot enforce the new group work hold.
No application boot schema repair or operational seed is required.
