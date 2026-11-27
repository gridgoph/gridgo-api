# Shop verification and early online jobs

Tier-price onboarding adds production-off release controls and extends database
payout guards; see [Shop onboarding](SHOP_ONBOARDING_API.md#verification-and-every-payout-path).

Refs gridgoph/gridgo-api#411; issue report F318781A. API contract for the supplier app and dashboard follow-ups. Home printers retain their separate Starter/Verified policy.

A pending shop can receive new online work after sign-up has a location, a document service and a ready receiving QR. Existing active-account, shop-open, membership, live-service, listing review, production/deadline and file gates remain. Operations may independently verify a submitted service line before the shop identity is verified; identity approval is no longer a prerequisite for that line-review action. Rejected or suspended suppliers do not gain access through this policy.

The verification window begins at the supplier membership's immutable creation time, including when another role enrolled first. Reapplying, uploading replacement files and editing a profile do not restart it. At the deadline, new matching and checkout stop. Assigned orders can still be read, accepted, produced and handed over, with their owning supplier’s change-request, production-deadline and invoice tools; temporary shop closure, expiry and recovery debt do not revoke existing work access. Account suspension and independent work/claim/refund holds still apply.

## Operational settings

Super Admin uses the existing `PATCH /settings`, `expectedVersion` and a nonblank `reason`:

```json
{"expectedVersion":12,"reason":"Reviewed verification policy","supplierVerification":{"payoutCapMinor":500000,"windowDays":30}}
```

The amount is integer centavos, a nonnegative safe integer. The window is an integer from 1 to 3650 days. Operations cannot change either value. Limits apply to current policy reads; lowering the cap never rewrites money already paid, and further positive payments wait for verification. A cap reduction that would invalidate an unresolved transfer returns `409 verification_policy_reconciliation_required`; record its actual outcome or explicitly retire the unsent attempt first. Zero-net debt offsets do not spend additional cap capacity. The starting values remain subject to legal/tax review. This API does not introduce automatic bank or payment gateway transfers.

## Supplier app calls

- `GET /me/supplier-verification` (Owner only) returns `verification`, private `verificationDocuments` metadata and the append-only `ledger`. Use the selected shop headers for a delegated Owner. Staff cannot access this route.
- `verification` contains `verified`, `verificationState` (`not_submitted | being_checked | verified`), `startedAt`, `deadlineAt`, `daysLeft`, `countdownDays`, `payoutCapMinor`, `paidBeforeVerificationMinor`, `remainingCapMinor`, `capReached`, `heldMinor`, `recoveryDueMinor`, `paidOpenRegularJobs` and `newOrdersPaused`.
- `countdownDays` is null until the last seven days. Render a short optional verification To do card and a Money banner while unverified; show the cap-reached note from `capReached`. Keep the cap off the receiving-QR screen. A false `verified` flag does not request a negative client-facing label.
- Upload verification bytes using the existing private `POST /files` intake, upload/complete and `POST /files/:fileId/attach` flow. Purpose is `verification_document`; attach body is `{"documentType":"valid_id"}`, `{"documentType":"id_selfie"}` or `{"documentType":"business_permit"}`. Images and PDFs follow existing storage limits. `id_selfie` is the photo with the ID. `replaceFileId` keeps the existing typed replacement semantics. A ready attached upload projects `being_checked`; uploading never stops jobs or approves the case.
- `/auth/me/supplier` includes the verification summary and updates `receiveJobOffers` versus `acceptJobs`: new offers use current eligibility; existing work remains accessible after the deadline. Money should use the dedicated Owner route above.
- Public shop detail/directory/media use the same pending-shop eligibility as listings. Shop/listing cards, anonymous alternative listings and Express shop lists expose a positive `verified` boolean. Verified candidates are promoted within the existing shared distance bands after ordinary ranking; deadline-incapable candidates remain excluded. Different distance bands keep their ordinary ranking positions. A verification-driven match reason is `verified` / `Verified shop nearby`.

Day 7, 20 and 27 reminders use durable inbox/outbox delivery, with a copy to every current Operations and Super Admin membership. The lifecycle sends the latest overdue reminder after downtime, once, while the window is still open. The stored reminder key prevents duplicates across retries and restarts. No SMS provider is introduced.

## Payout desk calls and ledger

Regular online orders retain payout plan 2 (40/35/25 of the shop's cost). Newly committed Express online orders snapshot plan 4: one 100% `delivered` stage after delivery or the governed Express counter handover. Existing plans 1/2/3 and their amounts are unchanged. Express is exempt from the two-paid-open-regular-jobs rule, but its online payments still count toward the cap.

Before sending a transfer, Operations/Super Admin calls:

`POST /orders/:orderId/milestones/:code/prepare` with `{}`.

The existing stage's proof, fulfillment, collection, claim, refund, production-penalty and other release gates are checked first.
A successful preparation returns `payout.status: ready`, the frozen `netAmountMinor`, an opaque `attemptId`, its `payerId`, and `items` with gross/net/recovery amounts.
One payer owns that attempt; another operator, including Super Admin, receives `403 verification_payer_required` instead of another instruction to send.
A same-payer preparation retry returns the same attempt and amounts; it never creates a second transfer.
Final-stage supplements share the stage's attempt and must be transferred and recorded together.
The transaction reserves cap space and paid-open job slots, including during rolling deployments with an older writer.
Do not send a held transfer, resend an in-progress transfer, or reuse a retired attempt.

Include the returned `attemptId` when recording an explicitly prepared transfer through `/release` or `/supplier-payout`.
A missing/stale attempt is `409 verification_payout_attempt_required`; retry a completed command with its original reference and amount.
A changed reference or amount after completion is `409 verification_transfer_reconciliation_required`, rather than a successful replay.
Legacy direct recording remains compatible, but cannot take over an outstanding preparation.

For an abandoned unsent preparation use `POST /orders/:orderId/milestones/:code/cancel-reservation`, or `POST /orders/:orderId/payout-reservations/cancel` with `payoutKey`.
Both require `attemptId`, `noFundsSentConfirmed: true` and a nonblank `reason`.
They retire the whole transfer attempt, with its bundled items, and audit the released capacity.
Only its payer or Super Admin may reconcile it.

`POST /orders/:orderId/payout-reservations/reconcile` requires `payoutKey`, `attemptId`, `reason` and one of these outcomes:

- `unknown`: keep the reservation and mark the whole attempt uncertain; further preparation is `409 verification_transfer_unknown`. Never send again while uncertain.
- `not_sent`: require `noFundsSentConfirmed: true`; retire the attempt before any new preparation.
- `paid`: require `fundsSentConfirmed: true`, exact combined `amountMinor`, the actual ISO `paidAt` (not in the future), `reference` and a ready owned `payout_receipt` `receiptFileId`. This records an already-sent frozen attempt, including its supplements/remainder, without authorizing a new transfer. A positive actual transfer and evidence are required; zero-net offsets use the normal release path. Payer or Super Admin may record it. Exact retries do not duplicate the financial rows, ledger, audit or notifications.

Reconciliation remains available under independent work/refund holds, and never clears those holds or resumes work.
Financial supersession, changed beneficiaries and stage-amount corrections wait while a transfer is unresolved, including a deadline rematch and a new refund settlement.
Record the actual transfer first, or explicitly confirm it was not sent, then calculate settlement amounts from the updated paid ledger.
The database requires matching immutable ledger/evidence proof for recording a prepared stage under a refund hold; it does not permit a fresh payout through that hold.

An over-cap whole stage or third paid-open regular job returns HTTP 202 and `payout.status: held`, with `reason: verification_payout_cap | verification_open_jobs` on the affected item. Every regular stage, legacy retention, supplemental change payout and refund settlement shop payout is included in online cap accounting. Existing rider-paid cash is exempt. A held stage's published amount/status is not reshaped. Additional regular jobs can wait for their first paid stage; existing paid jobs can finish.

After sending the prepared net amount, use the existing `POST /orders/:orderId/milestones/:code/release` with transfer `reference`, optional `receiptFileId` under existing evidence rules, and `amountMinor` equal to the prepared net amount (required for pending shops, recovery offsets and supplements). The response includes `netAmountMinor`. A completed stage retry returns `replayed: true` and creates no second release, audit or payout notification. Supplemental payouts are prepared/accounted individually, then recorded with the same transfer. A fully recovered payout can have net zero; no external transfer is needed for that offset.

For a pending refund settlement shop remainder, call `POST /refund-requests/:id/supplier-payout-prepare` with the existing `expectedVersion`, `reason` and `Idempotency-Key`. The response returns the prepared/held `payout`. Then use existing `/supplier-payout` with `amountMinor` equal to that prepared net, the verified destination version and required receipt/reference. Existing settlement gross obligations remain immutable. Prepare does not advance the refund version; actual recording does.

Verification lifts verification-specific holds and writes `available` ledger/audit events. Operations then reviews and records the actual transfer through the release route; approving an identity never fabricates a payment receipt or bypasses independent claim/refund gates. Two-job holds can also become available after delivery. New cap/window settings do not reshape frozen stage or transfer amounts.

If an unverified shop drops/cancels a job after an online stage was paid, `recovery_due` entries record the full value of paid payout entitlements, including prior recovery offsets, and new orders pause while the shop remains unverified and that debt is outstanding. A zero-value `recovery_assessment` ledger fact preserves eligibility at the time of the fault. An already-sent transfer recorded later is assessed using its actual `paidAt`, even if the shop has since been verified. Bundled stages are assessed together; later records add only the unassessed amount. Retries and previously collected offsets never recreate debt. A confirmed unsent preparation creates no debt, and later legitimate work is not included in an earlier fault.

Subsequent prepared online payouts recover the debt before computing the cash amount to send. `recovered` plus `released` entries settle the gross obligation without changing published stage shares. If that job is later cancelled, its full paid value becomes recoverable, including any earlier offset; a zero-net payment cannot erase an older debt. Verification ends the probationary new-order pause but does not erase debt; subsequent online payouts still recover it. This lets a verified shop earn the money to settle its recovery balance, including when no other job was open. Open work continues. GRIDGO staff can see the debt, paid amount and hold history in the verification queue.

Ledger money is safe-integer centavos, persisted as PostgreSQL BIGINT. Holds, availability, reservations, releases and recovery offsets each have audit records and commit in the existing domain transaction. Release and recovery identities are unique. A deferred database cap check counts outstanding reservations and paid amounts, excludes only an exactly matching already-recorded item, and protects reserved regular-job slots against legacy writers; it does not add incompatible CHECKs to legacy upsert shapes.

## Dashboard calls

Operations/Super Admin reads `GET /ops/supplier-verification` and `/ops/supplier-verification/:supplierId` for the supplier-only financial verification queue. The list supports the existing approval `status` and `cursor`; detail includes the financial ledger. It exposes no approval-decision history or other case kinds, and grants no decision permission.

Super Admin also reads `GET /approval-cases?kind=supplier&status=pending` and `GET /approval-cases/:id`. Supplier entries add `verification` and private `verificationDocuments` metadata. Render uploaded files, days left, paid-before-verification amount and recovery debt. Read files using the existing authorized `/files/:fileId/download-url`; no object keys or public verification bytes are exposed.

Use the existing versioned `/approval-cases/:id/approve` decision (`expectedVersion`, `requestId`, optional `note`). Its response includes the current verification summary; approval lifts verification holds atomically with the case decision. Existing rejection, suspension, restoration and service-review rules remain.

## Cash boundary and follow-ups

New cash checkout requires verified suppliers even if cash is enabled globally. Previously accepted cash orders retain their frozen cash protocol, finish as before, and never count toward this online cap or recovery debt. Once verified, new cash eligibility follows normal cash settings. See [Cash on delivery](CASH_ON_DELIVERY_API.md).

Supplier onboarding should offer a skippable verification step explaining the benefits: a verified badge, uncapped payouts, continued new orders beyond the window, and cash eligibility under normal settings. Supplier app To do/Money/verification upload screens and dashboard queue/payout prepare screens are companion releases. Manager-registration owner-confirm / “this isn't right” text remains a follow-up: this repository has no outbound SMS path/provider. Do not imply that an unimplemented text confirmation grants verification.
