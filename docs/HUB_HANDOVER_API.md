# Hub handovers and invited staff

Refs gridgoph/gridgo-api#124 and gridgoph/gridgo-api#125.

All routes use the existing Clerk instance. The Admin App may select its staff context with `X-GRIDGO-Role: staff`; Operations/Super Admin feed screens must use their corresponding membership context. GRIDGO database memberships are authoritative. An invite grants the `staff` membership and a configurable staff profile role; the built-in `hub_staff` role permits handouts. Custom role codes never grant Operations, Super Admin, rider or supplier permissions. Operations and Super Admin are staff without an invite or staff profile: their own membership grants every staff route with `canHandout:true`, and they select it with `X-GRIDGO-Role: ops_admin` or `super_admin` (the projection's `role` is that membership). `X-GRIDGO-Role: staff` stays a 403 for an account without the `staff` membership. Account suspension, staff-profile suspension and membership removal take effect on the next request. A staff account may retain other existing memberships.

## Staff provisioning (Super Admin dashboard)

| Method | Endpoint | Body / response |
|---|---|---|
| GET | `/admin/staff/roles` | `{roles:[{code,name,canHandout}]}` |
| POST | `/admin/staff/roles` | `{code,name,canHandout}`; creates a role (201) |
| POST | `/admin/staff/invites` | `{roleCode,expiresInDays?:7}`; `{invite,code}` (201); expiry 1–30 days |
| GET | `/admin/staff/invites` | `{invites}` with expiry, redemption and revocation; never the code/hash |
| POST | `/admin/staff/invites/:id/revoke` | revokes an unused code; does not revoke an already-created membership |
| GET | `/admin/staff` | named staff profiles with `active`, `roleCode`, `updatedAt` |
| PATCH | `/admin/staff/:userId` | `{roleCode,active}`; reassigns or suspends the profile |
| POST | `/auth/staff/redeem` | Clerk bearer + `{code}`; `{staff:{id,name,role,canHandout}}` |
| GET | `/staff/me` | same caller-only staff projection (Operations/Super Admin: `role` is their membership); inactive/missing staff is 403 |

The invite code is a 192-bit bearer secret returned **once** and stored as SHA-256. Deliver it privately to the intended staff member. The first verified Clerk subject to redeem it owns it; a same-subject retry is idempotent, another subject gets `409 staff_invite_used`. Expired/revoked/unknown codes return `409 staff_invite_invalid`. Redemption never links identities by email; an email already mapped to another subject returns `409 email_already_registered`. New identities receive only `staff`, with name copied from Clerk. Redeeming another invite cannot silently reassign an existing staff profile.

No new Clerk application, local passwords, signup, distribution automation or app build is introduced.

## Hub and Admin App

| Method | Endpoint | Access / response |
|---|---|---|
| GET | `/staff/hub` | active staff; `{hub,sop}` |
| GET | `/ops/hub` | Operations/Super Admin; same hub and SOP |
| POST | `/staff/hub/claims` | active staff role with `canHandout`; `{qrToken,otp}` |
| GET | `/staff/hub/handouts` | own handouts and own count |
| GET | `/ops/hub/handouts` | all handouts and counts grouped by staff |
| GET | `/ops/hub/unclaimed` | all waiting orders, ready time, missed days, Operations flag and redelivery requests |
| GET | `/ops/hub/escalations` | handover mismatch reports, including delivery reports |

The single hub record has `id:"primary"`, name, point, fee and schedule. Its point is the existing GRIDGO counter location. Its schedule and fee use the previously shipped `settings.hubPickup`; changes remain on the existing versioned Super Admin settings endpoint. `GET /settings` and `GET /staff/hub` both expose `schedule: null` when no schedule is configured; settings are the only source of opening hours. Unset hours do not block pickup readiness or claims. Set actual opening hours and closures before accepting pilot pickups. Each QR snapshots the point and schedule when the rider records arrival. Existing order fee snapshots never change.

SOP text covers identification, QR/OTP matching, blocked mismatch/escalation, named handouts and the restrictions on pricing talk, solicitation and supplier contacts. The API never pays a staff incentive.

A successful claim returns `{handout,order:{orderId,state,...}}`. Each append-only handout contains `id`, `orderId`, `staffId`, the staff name at handover, `hubId`, and `at`. PostgreSQL enforces one handout per order. Log endpoints return `{handouts,staffTotals,nextCursor}`; `limit` defaults to 50, maximum 100, and `before` accepts the returned cursor. Counts cover the full caller scope, independent of the page.

## Client and rider OTP

| Method | Endpoint | Access / behavior |
|---|---|---|
| GET | `/orders/:id/handover` | owning client; assigned rider for delivery only; `{handover:null}` until ready or after consumption |
| POST | `/dispatch/:id/delivery` | existing rider evidence body plus `otp` for a governed delivery |
| POST | `/orders/:id/handover/escalate` | owner/assigned rider; `{reason}`; staff must also supply the scanned `qrToken` |
| POST | `/orders/:id/hub-redelivery` | owning client after 3 missed days; `{costAccepted:true}` |

At the delivery production-ready boundary, one six-digit OTP is minted. It is unique among active handovers. Client and assigned rider see the same `{otp}`. The rider compares it before submitting the existing photo/signature evidence and OTP. The code does not replace the six supplier pickup checks, supplier handoff signature, delivery evidence, or final-payment gate.

For hub pickup, production-ready is **not** client-ready: the rider still carries the order to the hub. Recording arrival sets `awaiting_collection`, mints an opaque 256-bit QR token paired with its OTP, and does not open the issue window. The owning client's handover read returns `{otp,qrToken,hub,orderId,state,readyAt,missedDays,operationsRequired,redeliveryRequest}`. Render **only `qrToken`** inside the QR and show the OTP separately. Supplier, staff, unrelated client and hub transport rider cannot retrieve that credential pair. Ordinary order/basket/job responses omit the entire internal handover object.

Staff submit both values. Missing/wrong OTP is `409 handover_otp_mismatch`, with `canEscalate:true` and `escalatePath`. Five failures on that QR/order lock attempts for 15 minutes (`429 handover_attempts_exceeded`, `retryAfter`); the budget commits even on refusal. Mismatch never hands out the package. Escalation records a reason and alerts both Operations and Super Admin; it is not an override. A consumed token returns `409 handover_already_completed`. Wrong QR returns `404 claim_not_found`.

Both successful delivery and hub claim call the same delivery event: record delivered progress, consume the credential, open the configured issue window, notify parties/admins, and invalidate order reads. Existing payout plans, evidence requirements, principal collection caps, claim holds and independent refund holds remain authoritative. In particular, plan-2 payout remains **Operations/Super Admin released**, never an automatic cash disbursement on scan. Hub arrival evidence remains the delivered-stage proof; client claim advances the fulfillment state. Forfeiture is not implemented and is never automatic.

## Unclaimed timeline and redelivery

The existing transactional lifecycle worker sends the ready notification and catches up each completed open hub date. A date counts once, after its last closing time, if the package was ready before closing; closures and closed weekdays do not count. Readiness after closing starts counting on the next open date. Multiple opening windows count as one hub day. The ready date itself counts if the client misses its closing time. Stored date keys make retries/restarts idempotent. A handover with a null schedule gets a ready notice saying collection hours are unset; no missed-day reminders or escalation are calculated without opening hours. Existing issued schedules remain immutable.

The first missed day gets a reminder; the second gets a stronger warning. On the third, `operationsRequired` becomes true, both administrator memberships receive a durable inbox event, and the client can request redelivery at their own cost. Later missed hub days continue reminders. No state cancellation, payment forfeiture or payout happens.

Redelivery creates one audited `{status:"pending_operations",costAccepted:true,at,by}` request. Operations arranges the additional delivery and its separate cost with the client; this API does not invent a fee, charge the client, change the original receipt or reassign a rider automatically. The pending choice is visible in `/ops/hub/unclaimed` and the client's handover projection.

## Receipt-scan feed

Supplier invoices are incoming private documents, not official receipts issued by GRIDGO. No official-receipt generation is enabled.

An approved assigned supplier may upload a `supplier_invoice` via the existing `POST /files` multipart flow (JPEG/PNG/WebP/PDF, maximum 15 MiB), then attach it with `POST /files/:fileId/attach` and `{orderId}`. It is optional and does not create a new dispatch gate. Reads/signing remain on `GET /files/:fileId`, private to the supplier owner and Operations/Super Admin. Clients, riders and hub staff cannot read it or its order file IDs. Financial-file retention and open-case holds apply.

`GET /ops/hub/receipt-scans` returns `{scans:[{fileId,supplierId,orderId,at}],nextCursor}`; optional `month=YYYY-MM`, `supplierId`, `limit` (50 default/100 maximum) and `before`. Each newly attached scan writes `supplier_invoice_scanned` to both administrator memberships through the existing after-commit inbox/realtime delivery. Refresh the feed on that inbox event; use the existing signed file read to open a scan. The feed is suitable for the Admin App's Operations/Super Admin surface and the dashboard; ordinary hub staff receive 403. Public-launch official receipts and monthly physical collection workflows remain separate issues.

## Compatibility and deployment

`settings.handoverOtpEnabled` defaults to **false** to preserve released apps during the backend-first deployment. Super Admin enables it with the existing `PATCH /settings` body `{expectedVersion,reason,handoverOtpEnabled:true}` once client/rider OTP screens and the staff scanner are released. The update is audited and version checked. With the switch off, readiness keeps the existing handover contract. Enabling affects subsequent readiness transitions; it never silently rewrites already-ready orders. Disabling later does **not** bypass OTPs for orders that already have credentials.

Run the forward migration before deploying the API. It adds staff roles/profiles/invites and an immutable handout ledger, extends the existing membership role vocabulary with `staff`, and protects issued handover facts and consumption in `orders.data`. It creates no users and changes no existing money or payout snapshots.

Routes and ordinary response shapes remain available. **Already-ready orders without a handover record retain the legacy evidence/Operations collection route.** Orders entering a new physical readiness state while the switch is enabled receive the OTP contract. Their old `/orders/:id/collection` route returns `409 hub_claim_required`; generic transitions cannot bypass it. Delivery completion still uses `/dispatch/:id/delivery`, adding `otp`. Release the client/rider OTP screens and invited staff scanner in coordination with enabling new ready work; an older rider build cannot complete a newly OTP-governed delivery without that update. No missing-OTP success fallback is provided for a governed order.

This is backend-only; phone/desktop screenshots are not applicable. All credential/invite/staff/hub responses are private and non-cacheable.
