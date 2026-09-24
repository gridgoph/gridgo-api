# Coordinated event interfaces

HTTP role selection, device registration, notification list/SSE/resume, and rider location are defined in [Operational Model v2](OPERATIONAL_MODEL_V2_API.md). Provider credentials and health are defined in [Deployment](DEPLOYMENT.md#2-required-environment-and-secret-files).

## Client payment action and event history

Inbox/SSE `orderState` is current order context. `eventState`, when present, identifies the known historical lifecycle event; title/body/type remain unchanged. `paymentAction` is current client-only final-payment guidance (`installment: "final_online"`, `status: "due" | "pending_confirmation"`, `amountMinor`), including on older inbox rows. New production, packaging, pickup and transport notifications explain QR receipt submission or Operations review as appropriate. Existing occurrence deduplication and push privacy remain unchanged; no repeated payment reminder or automatic payment confirmation is introduced. The one reminder cadence is production inactivity for a silent shop, described in case 25.

## Invalidate payload

`event: invalidate` contains only `resource` and optional `id`. The supported resources come from `INVALIDATE_RESOURCES` in [`src/notifications.js`](../src/notifications.js). For `jobs`, `orders`, `dispatch`, `payouts`, and `location`, `id` is the order ID. Approval, service, claim, and escalation hints use their record IDs; collection hints omit `id`. A resource hint tells the app to refetch through its independently authorized read endpoint.

## Delivery, durability and scope

`save()` derives committed-domain before/after effects, stores notifications and per-device push outbox records in the domain transaction, and issues PostgreSQL NOTIFY pointers within that same transaction. Other API processes LISTEN and rehydrate current visibility before streaming; each process suppresses its own loopback. NOTIFY is commit-only. Disconnected listener recovery asks every mounted resource to refresh. Client reconnect must still refetch because resource invalidation has no Last-Event-ID history.

The push worker leases up to 25 records for five minutes, processes at most 10 leased rows concurrently, and drains subsequent due batches without waiting for another polling tick. It retries from 30 seconds exponentially up to one hour, permits eight attempts, and expires undelivered outbox records after 48 hours; inbox history is retained. Expired outbox records, deleted notifications, revoked memberships/assignments, and rebound device ownership are rechecked before every attempt. This is at-least-once delivery: a process crash after provider acceptance but before database acknowledgement can repeat a push; consumers deduplicate by notificationId. Outbox stores IDs, status and safe provider codes, never copied tokens/message bodies. Provider health is described in [Deployment](DEPLOYMENT.md#2-required-environment-and-secret-files). Unclaimed announcement delivery is a separate best-effort after-commit fan-out with no per-user outbox row or durable retry.

The same bounded system tick (default 30 seconds, configurable `GRIDGO_LIFECYCLE_INTERVAL_MS`, minimum one second) closes up to 100 elapsed issue windows using existing configured issue-window hours, with the domain transaction lock preserving no-double-mutation behavior. The same tick also writes at most 100 production-inactivity nudges for shops that have not made the next production move within the live `productionNudge` policy. It still does not invent balance reminders or issue-window near-expiry pings. No bank refund, team ACL, or other monitoring channel is invented.

Current work and file access follow [Operational Model v2](OPERATIONAL_MODEL_V2_API.md#selecting-an-actor-role) and [Storage API](STORAGE_API.md). A legacy assigned single order-job row does not preserve order/inbox access after the parent order is reassigned. Multiple active order jobs without a primary supplier retain their explicitly assigned supplier relationship. Inbox ownership is absolute even for administrators.

User action acknowledgements remain durable inbox records but use silent inbox invalidation, with no push/SSE banner. Every implemented domain event writes a durable inbox row to each current `ops_admin` and `super_admin` membership, with `appRole` set to that membership, so Super Admin is never left with invalidate-only refresh. Actor-silent still applies to the person who just performed the action. Draft orders do not alert. Both privileged roles are eligible for push/SSE banners; their own actions remain silent. Domain push title/body are `GRIDGO update` / `Open GRIDGO for the latest update.`, keeping payout amounts and private rejection reasons in the authenticated inbox; announcements preserve their explicitly broadcast public copy. Every push data object keeps the existing allowlist. Important announcements retain existing push behavior; no unconfigured preference system is assumed.

## Coverage of the approved 52-case matrix

“Durable” below means owner-scoped inbox plus optional outbox push, with silent screen invalidation always independent. Self-actions use inbox plus silent refresh. Every resource read still authorizes independently.

| # | Case | Implemented effect / deliberate boundary |
|---|---|---|
| 1 | Application submitted/resubmitted | Existing Ops submission writer now keys application revision; applicant identity/approval and reviewer queues invalidate. |
| 2 | Approved/rejected/needs changes | Existing applicant decision notification preserved, or derived when missing; privileged decision copies added; pending/rejected applicant can read own case decision. |
| 3 | Suspended | Existing applicant decision durable; identity/eligibility refresh; current work access and replay/push denied while suspended. Known active assigned work sends Operations an actionable reassignment-review notice; no undefined Super Admin severity threshold alert. |
| 4 | Restored | Existing restore decision durable; only actual decided membership/case restores; identity/dispatch/services refresh. |
| 5 | Role granted/removed | Affected identity durable access notice and all resource-cache invalidation; privileged changes notify other Super Admins; current membership and last-admin gates retained. |
| 6 | Order submitted/checkout | Submitted order alerts Ops; client acknowledgement inbox only; existing checkout QA/payment alerts retained; orders/jobs refresh. Drafts do not alert Ops. |
| 7 | Artwork correction requested | Client/shop state notifications now occurrence-aware; client-initiated proof revision alerts Ops. Actor gets silent inbox refresh. |
| 8 | Corrected artwork submitted | Correction → submitted/needs_qa alerts Ops with new occurrence; cancellation does not; all related order/job views refresh. |
| 9 | Proof ready | Client proof-ready notification per transition occurrence; current file/owner checks retained. |
| 10 | Proof approved/revision | Ops and assigned supplier decision notice; owner current-state transition gates retained. |
| 11 | Supplier assigned | New supplier assignment inbox; client safe assignment status; jobs/orders/payouts refresh. Multi-job hint IDs retain order-ID contract. |
| 12 | Decline/replacement found | Ops/client generic reassignment notice, new supplier assignment; old supplier minimal removal only; the [decline response](OPERATIONAL_MODEL_V2_API.md#supplier-decline) exposes no replacement private fields. |
| 13 | Decline/no replacement | Ops needs-supplier alert, client assignment status; old supplier removal; existing replacement/accepted-term matching logic retained. |
| 14 | Supplier accepts/can start | Existing shop milestone and added safe client acceptance status; related views refresh; approved current membership required. |
| 15 | Quote ready/revised | Existing final-quote milestone and privileged progress notice per occurrence, including unpaid quote revisions that keep awaiting_checkout; quote/payment/accepted-commercial gates unchanged. |
| 16 | Cancelled | Existing client/supplier/rider cancellation milestone and silent removal; reason/state/payment gates retained; no refund execution claim. |
| 17 | Payment submitted/resubmitted | Separate installment/source-submission occurrence; retries deduplicate including tombstoned notifications. Ops actionable alert. |
| 18 | Payment confirmed | Client and privileged confirmation durable per installment; clearing an active delivery final-balance gate alerts its assigned rider once; orders/jobs/payout projections refresh. |
| 19 | Payment rejected | New rejection occurrence per attempt in client and privileged inboxes; client safe copy, authenticated order holds detailed reason. |
| 20 | Balance due/reminder | Existing payment state/collection-balance messages and silent order refresh. No automated reminder enabled: matrix approves no business reminder cadence/preferences. |
| 21 | Credit/refund adjustment | Existing credit account/ledger changes generate owner and privileged credit notices and credits refresh. No bank/provider refund workflow is invented. |
| 22 | Production started | Existing client/shop lifecycle notices; actor silent; order/job/payout refresh. |
| 23 | Legacy supplier self-QC | Existing role-specific compatibility milestone, occurrence-aware; actor silent and other screens refreshed. New supplier flow skips this state. |
| 24 | Packaging ready | Direct production-to-ready transition writes client/shop progress and one offer occurrence per approved rider; duplicate derivation deduplicates. Ready means packed, with joint supplier/rider QC still required at pickup. |
| 25 | Delayed/promise at risk | Supported order/deadline changes invalidate authorized views. No direct delay-report route exists. The one configured production cadence is `productionNudge` on `GET`/`PATCH /settings`: while a shop-owed job stays in `payment_authorized`, `production`, or `supplier_self_qc` without a shop production move, the lifecycle tick writes `shop_production_inactive` (and `ops_production_inactive` only on the last repeat). Desk sets enabled, the first wait, the repeat, and the stop count, in seconds, minutes, hours, or days. The supplier phone plays `notification_alert.mp3` on Android channel `gridgo_production_nudge` and as the APNs sound; every other type stays on `gridgo_default` with `sound: "default"`. A shop move resets the clock. Changing the policy does not rewrite rows already sent. `enabled: false` writes nothing. |
| 26 | Offer available | Current approved membership riders, same contained-pickup eligibility exclusion as accept/offers; durable single offer occurrence. |
| 27 | Assigned/accepted | Existing role-specific client/shop/winner notices and board refresh; office-client safe copy preserved. |
| 28 | Offer withdrawn/lost | Every prior eligible rider gets minimal dispatch removal; no winner/customer details or losing-rider personal notification. |
| 29 | Pickup failure | Existing Ops escalation notice plus assigned supplier safe issue notice; blocked-order views refresh. |
| 30 | Pickup resolved | Existing rider resolution retained once; supplier resume notice; order/escalation refresh; repeat-check gates retained. |
| 31 | Picked up | Existing supplier/client role-specific milestone; office-transfer copy retained; rider actor silent. |
| 32 | Out for delivery | Existing delivery/office-transfer distinction; related order/job/dispatch refresh. |
| 33 | GPS/ETA | Source `recordedAt` preserved as ping `at`; rejects invalid/stale/future fixes and ignores older repeats; authorized location refresh only; no GPS push. |
| 34 | Tracking stale/recovers | API exposes original fix timestamp and accuracy; consumer computes stale label. No configured sustained-stale Ops SLA or native background GPS is invented. |
| 35 | Delivered | Existing client delivery notification plus supplier fulfilment status; issue/payout views refresh, proof/final-balance gate retained. |
| 36 | Office collection ready | Existing office-ready/settle-then-collect notification; location/identity restrictions retained. |
| 37 | Counter collected | Existing client “Collected” notification plus supplier fulfilment status; Ops-only settled-balance gate retained. |
| 38 | Client issue reported | Existing Ops acknowledgement/hold plus supplier safe issue status and payout hold; claims details remain Ops-only. |
| 39 | Issue resolved/dismissed | Client/supplier safe issue status notice; order/claims/payout refresh; no executed-refund assertion. |
| 40 | Hold/reason changed | Supplier hold notice per claim/order occurrence; internal reasons kept off push; Ops finance refresh. |
| 41 | Hold released | Supplier release notice only when the aggregate order/claim hold clears; privileged claim decisions remain durable even while another hold stays active; means checks may continue, never paid. |
| 42 | Payout released/attention | Explicit and automatic released milestones emit supplier notice keyed by milestone. Existing rejected release request remains explicit API error; no fabricated successful transfer or unconfigured persistent failure monitoring notice. |
| 43 | Issue window expiry | Bounded periodic worker closes actual configured windows, emits current order/job/payout effects, cannot double-close; near-expiry reminders deliberately disabled absent policy. |
| 44 | Service submitted/expanded | Entering pending-verification state alerts Ops; subsequent pending edits silently refresh the review queue; supplier service status and public eligible catalog refresh. |
| 45 | Service verified/suspended/withdrawn | Reviewer decision durable to owner; withdrawal silent; catalog/service/availability refresh. Existing order snapshots untouched. |
| 46 | Listing/stock/shop availability | Silent generic public catalog hints and authorized supplier availability/identity refresh. No general customer broadcast. |
| 47 | Fees/zones/settings | Authorized settings refresh; generic public catalog/quote refresh; no retrospective accepted commercial change or private settings payload. |
| 48 | Read/unread/delete | Owner-only mutation retained, same-owner other-device inbox hint; role-scoped snapshot read-all leaves concurrent/new and other-role records unread. |
| 49 | Login/logout/switch/access | Existing claim/release ownership retained; selected-role membership checked; stale current notifications suppressed; consumer account cache/stream teardown supplied by app workers. |
| 50 | Announcement | Membership audience selection and role/app-aware routing; only everyone may reach unclaimed installs with existing exact anonymous data. |
| 51 | Reconnect/foreground | SSE replay uses current authorization/projection; unsupported cursor remains 409; consumer refetch contract plus all-resource server LISTEN-recovery refresh. |
| 52 | Role anomaly/delivery failure | Privileged membership mutation alerts other Super Admins; durable outbox failure/attempt/code state and provider health expose delivery trouble. No unconfigured alert channel, anomaly heuristic or recipient preference invented. |

## Verification limits

Local tests use disposable PostgreSQL and signed test-only Clerk JWTs. The existing file/proof authorization tests cover PostgreSQL metadata; live MinIO, Clerk service login, native APNs/FCM credentials, real handsets and background GPS are not certified by this change. PostgreSQL NOTIFY is not a client replay log; a disconnected app must refetch active resources. Delivery requires deployment of the forward migration and separately installed provider credentials.

An own-account `role_changed` push may reach the account's still-owned device whose app role was just removed, provided the notification has no order/case pointer. Its title/body remain generic. This narrow delivery exception does not permit opening protected work or receiving old role notifications.
