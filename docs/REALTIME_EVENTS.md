# Coordinated event interfaces

- All authenticated domain requests may send X-GRIDGO-Role with a supported membership. It selects current role-specific actor/projection and approval; CORS permits it. Fixed auth probe/activation/enrollment handlers retain their original bootstrap behavior. Fixed /dispatch/offers and POST /dispatch/* infer rider membership without the header; GET /jobs infers supplier. GET location does not infer rider. PATCH read-all with ?role= scopes the snapshot operation to visible notifications in that context.
- GET /notifications and GET /notifications/stream accept optional role=client|supplier|rider|ops_admin|super_admin. Nonmember/unknown role gets 403. A pending applicant remains a member and can read their own approval decision. Absence keeps combined owned inbox compatibility. Role context does not grant domain endpoint authorization.
- SSE retains event:notification, with durable notification id; event:invalidate contains only resource and optional id. Jobs id is order ID, as are orders/dispatch/payouts/location. Approvals id=approval case ID, services=service ID, claims=claim ID, escalations=escalation ID. Collection hints omit id. Resources: orders,jobs,approvals,escalations,claims,dispatch,payouts,notifications,identity,catalog,services,availability,settings,location,credits.
- POST /devices adds optional appRole (same role enum, membership validated) and tokenProvider=fcm|apns. Default provider=apns on ios, fcm otherwise. Existing clients may omit appRole. All registrations remain single-account owned.
- POST /dispatch/:orderId/location accepts recordedAt ISO timestamp of source GPS fix. Omission retains server-time compatibility. Invalid/future beyond 30 sec/older than 5 min rejected; same or older than stored latest fix returns 200 {ping,ignored:true}. at in returned ping is source timestamp. accuracy remains optional nonnegative meters. Client carried-to-office location denied.
- Mobile foreground refresh all active resources on connection/reconnection; invalidates are deliberately not replayed. 409 notification_resume_unavailable means discard event cursor and reconnect plus refetch.
- Direct native APNs uses GRIDGO_APNS_KEY_FILE, GRIDGO_APNS_KEY_ID, GRIDGO_APNS_TEAM_ID, GRIDGO_APNS_{CLIENT,SUPPLIER,RIDER}_TOPIC (or GRIDGO_APNS_TOPIC), GRIDGO_APNS_SANDBOX=true for development. Missing config surfaces health and retries; no physical-device claim without credentials/device evidence.

## Delivery, durability and scope

`save()` derives committed-domain before/after effects, stores notifications and per-device push outbox records in the domain transaction, and issues PostgreSQL NOTIFY pointers within that same transaction. Other API processes LISTEN and rehydrate current visibility before streaming; each process suppresses its own loopback. NOTIFY is commit-only. Disconnected listener recovery asks every mounted resource to refresh. Client reconnect must still refetch because resource invalidation has no Last-Event-ID history.

The push worker leases up to 25 records for five minutes, retries from 30 seconds exponentially up to one hour, permits eight attempts, and expires notifications after 48 hours. Expired actions, deleted notifications, revoked memberships/assignments, and rebound device ownership are rechecked before every attempt. This is at-least-once delivery: a process crash after provider acceptance but before database acknowledgement can repeat a push; consumers deduplicate by notificationId. Outbox stores IDs, status and safe provider codes, never copied tokens/message bodies. Missing FCM/APNs credentials are explicitly reported under health; local verification does not assert physical push delivery.

The same bounded system tick (default 30 seconds, configurable `GRIDGO_LIFECYCLE_INTERVAL_MS`, minimum one second) closes up to 100 elapsed issue windows using existing configured issue-window hours, with the domain transaction lock preserving no-double-mutation behavior. No reminder cadence, production SLA, bank refund, team ACL, or new monitoring channel is invented.

Supplier/rider work requires current membership and approval. Suspended suppliers/riders retain identity/application decision access, but work endpoints and private work notifications deny access until restoration. A legacy assigned single order-job row does not preserve access after the parent order is reassigned. Multiple active order jobs without a primary supplier retain their explicitly assigned supplier relationship. Inbox ownership is absolute even for administrators.

User action acknowledgements and routine administrator copies remain durable inbox records but use silent inbox invalidation, with no push/SSE banner. Routine actionable Operations alerts prefer Operations push; administrators retain authorized queues and inbox history. Push title/body are generic for domain notifications, including payout amounts and private rejection reasons; announcements preserve their explicitly broadcast public copy. Every push data object keeps the existing allowlist. Important announcements retain existing push behavior; no unconfigured preference system is assumed.

A role-selected actor affects money/document projection and restricted handlers without writing `users.role`. Applications should always send their fixed/active role header; legacy requests without it retain the existing primary-role behavior except the fixed rider and supplier endpoints listed above. Role selection never grants a missing membership. `/auth/me` continues to expose all actual memberships for navigation.

## Coverage of the approved 52-case matrix

“Durable” below means owner-scoped inbox plus optional outbox push, with silent screen invalidation always independent. Self-actions and routine administrator copies use inbox plus silent refresh. Every resource read still authorizes independently.

| # | Case | Implemented effect / deliberate boundary |
|---|---|---|
| 1 | Application submitted/resubmitted | Existing Ops submission writer now keys application revision; applicant identity/approval and reviewer queues invalidate. |
| 2 | Approved/rejected/needs changes | Existing single decision notification preserved; no derived duplicate; pending/rejected applicant can read own case decision. |
| 3 | Suspended | Existing applicant decision durable; identity/eligibility refresh; current work access and replay/push denied while suspended. Known active assigned work sends Operations an actionable reassignment-review notice; no undefined Super Admin severity threshold alert. |
| 4 | Restored | Existing restore decision durable; only actual decided membership/case restores; identity/dispatch/services refresh. |
| 5 | Role granted/removed | Affected identity durable access notice and all resource-cache invalidation; privileged changes notify other Super Admins; current membership and last-admin gates retained. |
| 6 | Order submitted/checkout | Submitted order alerts Ops; client acknowledgement inbox only; existing checkout QA/payment alerts retained; orders/jobs refresh. Drafts do not alert Ops. |
| 7 | Artwork correction requested | Client/shop state notifications now occurrence-aware; client-initiated proof revision alerts Ops. Actor gets silent inbox refresh. |
| 8 | Corrected artwork submitted | Transition out of correction alerts Ops with new occurrence; all related order/job views refresh. |
| 9 | Proof ready | Client proof-ready notification per transition occurrence; current file/owner checks retained. |
| 10 | Proof approved/revision | Ops and assigned supplier decision notice; owner current-state transition gates retained. |
| 11 | Supplier assigned | New supplier assignment inbox; client safe assignment status; jobs/orders/payouts refresh. Multi-job hint IDs retain order-ID contract. |
| 12 | Decline/replacement found | Ops/client generic reassignment notice, new supplier assignment; old supplier minimal removal only; decline response no longer returns replacement private order fields. |
| 13 | Decline/no replacement | Ops needs-supplier alert, client assignment status; old supplier removal; existing replacement/accepted-term matching logic retained. |
| 14 | Supplier accepts/can start | Existing shop milestone and added safe client acceptance status; related views refresh; approved current membership required. |
| 15 | Quote ready/revised | Existing final-quote milestone per occurrence; quote/payment/accepted-commercial gates unchanged. |
| 16 | Cancelled | Existing client/supplier/rider cancellation milestone and silent removal; reason/state/payment gates retained; no refund execution claim. |
| 17 | Payment submitted/resubmitted | Separate installment/source-submission occurrence; retries deduplicate including tombstoned notifications. Ops actionable alert. |
| 18 | Payment confirmed | Client confirmation durable per installment; clearing an active delivery final-balance gate alerts its assigned rider once; orders/jobs/payout projections refresh. |
| 19 | Payment rejected | New rejection occurrence per attempt; client safe copy, authenticated order holds detailed reason. |
| 20 | Balance due/reminder | Existing payment state/collection-balance messages and silent order refresh. No automated reminder enabled: matrix approves no business reminder cadence/preferences. |
| 21 | Credit/refund adjustment | Existing credit account/ledger changes generate owner credit notice and credits refresh. No bank/provider refund workflow is invented. |
| 22 | Production started | Existing client/shop lifecycle notices; actor silent; order/job/payout refresh. |
| 23 | Printing complete/QC | Existing role-specific QC milestone, occurrence-aware; actor silent and other screens refreshed. |
| 24 | QC passed/ready | Existing client/shop milestone plus one rider offer occurrence; duplicate derivation deduplicates. |
| 25 | Delayed/promise at risk | Supported order/deadline changes invalidate authorized views. No direct delay-report route or configured lateness SLA exists, so no synthetic alert/scheduler added. |
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
| 41 | Hold released | Supplier release notice deduplicated across order and claim consequences; means checks may continue, never paid. |
| 42 | Payout released/attention | Explicit and automatic released milestones emit supplier notice keyed by milestone. Existing rejected release request remains explicit API error; no fabricated successful transfer or unconfigured persistent failure monitoring notice. |
| 43 | Issue window expiry | Bounded periodic worker closes actual configured windows, emits current order/job/payout effects, cannot double-close; near-expiry reminders deliberately disabled absent policy. |
| 44 | Service submitted/expanded | Entering pending-verification state alerts Ops; subsequent pending edits silently refresh the review queue; supplier service status and public eligible catalog refresh. |
| 45 | Service verified/suspended/withdrawn | Reviewer decision durable to owner; withdrawal silent; catalog/service/availability refresh. Existing order snapshots untouched. |
| 46 | Listing/stock/shop availability | Silent generic public catalog hints and authorized supplier availability/identity refresh. No general customer broadcast. |
| 47 | Fees/zones/settings | Authorized settings refresh; generic public catalog/quote refresh; no retrospective accepted commercial change or private settings payload. |
| 48 | Read/unread/delete | Owner-only mutation retained, same-owner other-device inbox hint; role-scoped snapshot read-all leaves concurrent/new and other-role records unread. |
| 49 | Login/logout/switch/access | Existing claim/release ownership retained; selected-role membership checked; stale current notifications suppressed; consumer account cache/stream teardown supplied by app workers. |
| 50 | Announcement | Membership audience selection and role/app-aware routing; only everyone may reach unclaimed installs with existing exact anonymous data. |
| 51 | Reconnect/foreground | SSE replay uses current authorization/projection; unsupported cursor remains409; consumer refetch contract plus all-resource server LISTEN-recovery refresh. |
| 52 | Role anomaly/delivery failure | Privileged membership mutation alerts other Super Admins; durable outbox failure/attempt/code state and provider health expose delivery trouble. No unconfigured alert channel, anomaly heuristic or recipient preference invented. |

## Verification limits

Local tests use disposable PostgreSQL and signed test-only Clerk JWTs. The existing file/proof authorization tests cover PostgreSQL metadata; live MinIO, Clerk service login, native APNs/FCM credentials, real handsets and background GPS are not certified by this change. PostgreSQL NOTIFY is not a client replay log; a disconnected app must refetch active resources. Delivery requires deployment of the forward migration and separately installed provider credentials.

An own-account `role_changed` push may reach the account's still-owned device whose app role was just removed, provided the notification has no order/case pointer. Its title/body remain generic. This narrow delivery exception does not permit opening protected work or receiving old role notifications. `/auth/me` with the role header projects that existing membership as its compatible `user.role`/approval status; missing membership still returns the bootstrap identity for enrollment.
