# Shop verification and early online jobs

Refs gridgoph/gridgo-api#411; issue report F318781A. API contract for the supplier app and dashboard follow-ups. Home printers retain their separate Starter/Verified policy.

A pending shop can receive new online work after sign-up has a location, a document service and a ready receiving QR. Existing active-account, shop-open, membership, live-service, listing review, production/deadline and file gates remain. Operations may independently verify a submitted service line before the shop identity is verified; identity approval is no longer a prerequisite for that line-review action. Rejected or suspended suppliers do not gain access through this policy.

The verification window begins at the supplier membership's immutable creation time, including when another role enrolled first. Reapplying, uploading replacement files and editing a profile do not restart it. At the deadline, new matching and checkout stop. Assigned orders can still be read, accepted, produced and handed over; temporary shop closure, expiry and recovery debt do not revoke existing work access. Account suspension and independent work/claim/refund holds still apply.

## Operational settings

Super Admin uses the existing `PATCH /settings`, `expectedVersion` and a nonblank `reason`:

```json
{"expectedVersion":12,"reason":"Reviewed verification policy","supplierVerification":{"payoutCapMinor":500000,"windowDays":30}}
```

The amount is integer centavos, a nonnegative safe integer. The window is an integer from 1 to 3650 days. Operations cannot change either value. Limits apply to current policy reads; lowering the cap never rewrites money already paid, and further payments wait for verification. The starting values remain subject to legal/tax review. This API does not introduce automatic bank or payment gateway transfers.

## Supplier app calls

- `GET /me/supplier-verification` (Owner only) returns `verification`, private `verificationDocuments` metadata and the append-only `ledger`. Use the selected shop headers for a delegated Owner. Staff cannot access this route.
- `verification` contains `verified`, `verificationState` (`not_submitted | being_checked | verified`), `startedAt`, `deadlineAt`, `daysLeft`, `countdownDays`, `payoutCapMinor`, `paidBeforeVerificationMinor`, `remainingCapMinor`, `capReached`, `heldMinor`, `recoveryDueMinor`, `paidOpenRegularJobs` and `newOrdersPaused`.
- `countdownDays` is null until the last seven days. Render a short optional verification To do card and a Money banner while unverified; show the cap-reached note from `capReached`. Keep the cap off the receiving-QR screen. A false `verified` flag does not request a negative client-facing label.
- Upload verification bytes using the existing private `POST /files` intake, upload/complete and `POST /files/:fileId/attach` flow. Purpose is `verification_document`; attach body is `{"documentType":"valid_id"}`, `{"documentType":"id_selfie"}` or `{"documentType":"business_permit"}`. Images and PDFs follow existing storage limits. `id_selfie` is the photo with the ID. `replaceFileId` keeps the existing typed replacement semantics. A ready attached upload projects `being_checked`; uploading never stops jobs or approves the case.
- `/auth/me/supplier` includes the verification summary and updates `receiveJobOffers` versus `acceptJobs`: new offers use current eligibility; existing work remains accessible after the deadline. Money should use the dedicated Owner route above.
- Match shop/listing cards, anonymous alternative listings and Express shop lists expose a positive `verified` boolean. Verified candidates are promoted within the existing shared distance bands after ordinary ranking; deadline-incapable candidates remain excluded. Different distance bands keep their ordinary ranking positions. A verification-driven match reason is `verified` / `Verified shop nearby`.

Day 7, 20 and 27 reminders use durable inbox/outbox delivery, with a copy to every current Operations and Super Admin membership. The lifecycle sends the latest overdue reminder after downtime, once, while the window is still open. The stored reminder key prevents duplicates across retries and restarts. No SMS provider is introduced.

## Payout desk calls and ledger

Regular online orders retain payout plan 2 (40/35/25 of the shop's cost). Newly committed Express online orders snapshot plan 4: one 100% `delivered` stage after delivery or the governed Express counter handover. Existing plans 1/2/3 and their amounts are unchanged. Express is exempt from the two-paid-open-regular-jobs rule, but its online payments still count toward the cap.

Before sending a transfer, Operations/Super Admin calls:

`POST /orders/:orderId/milestones/:code/prepare` with `{}`.

The existing stage's proof, fulfillment, collection, claim, refund, production-penalty and other release gates are checked first. A successful response contains `payout.status: ready`, the frozen `netAmountMinor` to transfer, and `items` with gross `amountMinor`, `recoveryMinor` and `netAmountMinor`. The transaction reserves cap space and a paid-open job slot. Retrying prepare returns the same amount. Do not send a held transfer. If an unused preparation is abandoned, use `POST /orders/:orderId/milestones/:code/cancel-reservation` with `noFundsSentConfirmed: true` and a nonblank `reason`; this releases its cap reservation with an audit entry. For a settlement or individual supplemental reservation, use `POST /orders/:orderId/payout-reservations/cancel` with its `payoutKey`, the same confirmation and reason. Never cancel when a transfer may already have been sent; reconcile its actual outcome first. An active preparation also prevents automatic shop reassignment.

An over-cap whole stage or third paid-open regular job returns HTTP 202 and `payout.status: held`, with `reason: verification_payout_cap | verification_open_jobs` on the affected item. Every regular stage, legacy retention, supplemental change payout and refund settlement shop payout is included in online cap accounting. Existing rider-paid cash is exempt. A held stage's published amount/status is not reshaped. Additional regular jobs can wait for their first paid stage; existing paid jobs can finish.

After sending the prepared net amount, use the existing `POST /orders/:orderId/milestones/:code/release` with transfer `reference`, optional `receiptFileId` under existing evidence rules, and `amountMinor` equal to the prepared net amount when recovery applies. The response includes `netAmountMinor`. A completed stage retry returns `replayed: true` and creates no second release, audit or payout notification. Supplemental payouts are prepared/accounted individually, then recorded with the same transfer. A fully recovered payout can have net zero; no external transfer is needed for that offset.

For a pending refund settlement shop remainder, call `POST /refund-requests/:id/supplier-payout-prepare` with the existing `expectedVersion`, `reason` and `Idempotency-Key`. The response returns the prepared/held `payout`. Then use existing `/supplier-payout` with `amountMinor` equal to that prepared net, the verified destination version and required receipt/reference. Existing settlement gross obligations remain immutable. Prepare does not advance the refund version; actual recording does.

Verification lifts verification-specific holds and writes `available` ledger/audit events. Operations then reviews and records the actual transfer through the release route; approving an identity never fabricates a payment receipt or bypasses independent claim/refund gates. Two-job holds can also become available after delivery. New cap/window settings do not reshape frozen stage or transfer amounts.

If an unverified shop drops/cancels a job after an online stage was paid, one `recovery_due` entry records actual net funds paid, and new orders pause while that debt is outstanding. Subsequent prepared online payouts recover the debt before computing the cash amount to send. `recovered` plus `released` entries settle the gross obligation without changing published stage shares. Verification does not erase debt. Open work continues. GRIDGO staff can see the debt, paid amount and hold history in the verification queue.

Ledger money is safe-integer centavos, persisted as PostgreSQL BIGINT. Holds, availability, reservations, releases and recovery offsets each have audit records and commit in the existing domain transaction. Release and recovery identities are unique. A deferred database cap check also refuses a legacy process's new over-cap online release; it does not add incompatible CHECKs to legacy upsert shapes.

## Dashboard calls

Super Admin reads `GET /approval-cases?kind=supplier&status=pending` and `GET /approval-cases/:id`. Supplier entries add `verification` and private `verificationDocuments` metadata. Render uploaded files, days left, paid-before-verification amount and recovery debt. Read files using the existing authorized `/files/:fileId/download-url`; no object keys or public verification bytes are exposed.

Use the existing versioned `/approval-cases/:id/approve` decision (`expectedVersion`, `requestId`, optional `note`). Its response includes the current verification summary; approval lifts verification holds atomically with the case decision. Existing rejection, suspension, restoration and service-review rules remain.

## Cash boundary and follow-ups

New cash checkout requires verified suppliers even if cash is enabled globally. Previously accepted cash orders retain their frozen cash protocol, finish as before, and never count toward this online cap or recovery debt. Once verified, new cash eligibility follows normal cash settings. See [Cash on delivery](CASH_ON_DELIVERY_API.md).

Supplier app To do/Money/verification upload screens and dashboard queue/payout prepare screens are companion releases. Manager-registration owner-confirm / “this isn't right” text remains a follow-up: this repository has no outbound SMS path/provider. Do not imply that an unimplemented text confirmation grants verification.
