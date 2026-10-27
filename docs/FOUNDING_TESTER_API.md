# Founding Tester path, invites and voucher budget

Contract for client#323, extending the existing [tester mission programme](VOUCHERS_API.md#founding-tester-missions). PHP money is integer centavos. The client and dashboard may implement this contract independently after the API migration/release. Timed sharing prompts and the tester CSV export remain deferred.

## Five-step path and client reads

`GET /me/founding-tester` returns HTTP 200:

```json
{
  "serverTime": "2026-10-20T14:00:00.000Z",
  "foundingTester": {
    "eligible": true,
    "label": null,
    "awardedAt": null,
    "missions": {"added":true,"placed":true,"tracked":false,"received":false,"rated":false},
    "completedCount": 2,
    "rewardStatus": "pending",
    "reward": null
  },
  "invites": {"code":null,"link":null,"invited":0,"joined":0,"completed":0}
}
```

Clerk authentication and a client membership are required. Caller-supplied client IDs never select a different account. Responses are `Cache-Control: private, no-store`. Existing `/auth/me/client` (`clientProfile.foundingTester`), `/auth/me` and `/me` (`user.foundingTester`) return the same five-step projection; the new route also includes invite counts. Staff directory routes retain their existing projections and permissions.

Render the path in this order:

| Key | Label | Authoritative fact |
| --- | --- | --- |
| `added` | Add an item to your cart | At least one owned cart line or non-review checkout order line; once observed during a relevant mutation/profile reconciliation, `addedAt` preserves this step after removal. An empty cart does not count. |
| `placed` | Place your order | Initial payment confirmed, including basket payment confirmation; an unpaid checkout does not count. |
| `tracked` | Track your order | A client-owned `POST /orders/:orderId/tester-tracking` acknowledgement for a qualifying placed order. Ordinary order reads never imply this event. |
| `received` | Receive your order | Confirmed delivery or hub handout, not hub arrival/readiness. |
| `rated` | Complete the survey | A submitted order survey for a qualifying received order. Ratings and dismissal are different actions; score values do not affect rewards. |

The existing account-level aggregation across qualifying orders remains: the steps need not all reference a single order. `tracked` must reference an order that qualifies for `placed`; `rated` must reference one that qualifies for `received`. An earlier tracking acknowledgement remains recorded but stops contributing if its order is later disqualified before award.

Client-caused refunds/cancellations and unattributed cancellations/refunds contribute no `placed`, `tracked`, `received` or `rated` progress. The independently observed cart action remains completed. An approved shop/GRIDGO failure still substitutes for `placed` and `received`; it does not fabricate tracking or a survey. The client opens tracking and submits the existing failure-eligible survey. See the original contract for fault precedence and survey windows.

Launch eligibility is unchanged: `users.createdAt` strictly before `foundingTesterLaunchAt`, or all non-review client accounts when the setting is null. New invitees are subject to this same cutoff. Inviting does not override it. Already-awarded clients retain the label, original wallet ID and five completed steps, without needing historical tracking backfill. Unawarded historical clients must acknowledge tracking before a new award. Review accounts/orders cannot earn rewards.

All five steps plus eligibility earn one mission voucher (default ₱15; new entitlements use `rewards.missionMinor` from [promotion settings](VOUCHERS_API.md#launch-promotions)), valid for 30 elapsed days, and the Founding Tester label. Subsequent surveys, retries, expiry and voiding never earn another mission voucher. An existing survey reward is reused with its original expiry/status; it is not issued or counted again. Ineligible clients keep the existing separate survey programme.

`rewardStatus` is `pending`, `ineligible`, `paused`, `issued`, `existing_survey_reward`, or `voided`. `reward` is the existing [wallet projection](VOUCHERS_API.md#wallet-and-code-entry), including its current status and expiry. With a budget pause, progress is 5/5 but label/awardedAt/reward stay null until issuance; display completion with “Reward awaiting approval/budget”, not an available voucher. A void keeps any previously awarded label and progress. Use `awardedAt` as the once-only celebration ID and retain the last celebrated value locally. Refetch after survey/tracking mutations and `identity` invalidations. `GET /me/founding-tester` is a pure read; existing own-profile reconciliation and relevant client/order mutations can issue a newly qualified reward. Staff reads never issue.

## Client mutations

All successful routes below return HTTP 200 with the same `{serverTime,foundingTester,invites}` envelope above. They are idempotent by account or account/order; an `Idempotency-Key` is not required by these endpoints.

| Method/path | JSON body | Effect |
| --- | --- | --- |
| `POST /orders/:orderId/tester-tracking` | `{}` or `{"installationId":"<UUID v4>"}` | Call when the client actually opens the tracking screen for their placed order. One immutable acknowledgement per owner/order. Requires qualifying placed facts; do not call just because a Home card was displayed. |
| `POST /me/founding-tester/invite` | `{}` or `{"installationId":"<UUID v4>"}` | Creates or returns the client's permanent personal code. Any non-review client can share; the invitee must meet mission eligibility to earn rewards. |
| `POST /me/founding-tester/installation` | `{"installationId":"<UUID v4>"}` | Records installation association, idempotently. Call after client sign-in/activation, before showing invite/reward UI. |

Generate a random UUID v4 **once per app installation** and persist it across sign-out/account changes. Send the same value for every account using that installation. Never generate a new UUID per session/user. This is an app-installation signal, not a tamper-proof physical-device identifier: reinstall/reset, separate installations, absent legacy signals, and dishonest clients can evade it. No advertising ID, hardware fingerprint, push-token reuse, or IP comparison is used. UUID values are stored in append-only account/installation history; client responses and staff lists never expose them. Invalid supplied values fail rather than silently dropping the check. Missing values remain permitted under the approved positive-match policy.

## Invite links, form ingestion and matching

`invites.code` is an opaque permanent uppercase string; `link` is the Super Admin-configured HTTPS form URL with that code filled into its query. Either can initially be null. If the form template is unset the code still exists but link is null; the client should disable Copy/Share until a link is available. Copy and Share use the returned link unchanged.

The API does not fetch arbitrary form providers, install webhooks, count link clicks or send invitations. Operations records form responses using the following authenticated endpoint, manually or through an authorized integration. **The form must collect email and the prefilled code**, and its responses must be ingested before a referral can be rewarded. Merely sharing/copying a URL is not an invited count.

| Method/path | Body/result |
| --- | --- |
| `POST /ops/tester-invites` | `{ "code":"<personal invite code>", "email":"friend@example.test" }` → `200 {invite}`. Operations/Super Admin only. Records a form response and attempts email matching. No reward issuance. |
| `POST /ops/tester-invites/match` | `{}` → `200 {matched:<total joined>,unmatched:<total unmatched>}`. Operations/Super Admin only. Retries all unmatched entries; no reward issuance. Account mutations also retry matching. |
| `GET /ops/tester-invites?status=unmatched&inviterId=usr_...&offset=0&limit=100` | `200 {serverTime,total,invites:[...]}`. Operations/Super Admin only. Both filters optional. `status`: `unmatched`, `joined`, `completed`. |

Email is trimmed/lowercased, with basic email-shape validation (maximum 254 characters); no provider-specific alias folding. Exactly one existing, non-review client identity with that email matches. Matching never creates an identity, changes memberships, or links authentication accounts. First form attribution wins globally per normalized email and per matched account. Same-code retries reuse the entry; a different inviter for the same email is a conflict. Email changes cannot reattribute an already-matched account. Self-invites never match. No invite-count cap exists.

An invite row contains `id`, `inviterId`, `code`, `email`, nullable `clientId`, `createdAt`, nullable `matchedAt`, nullable `completedAt`, and nullable `unmatchedReason`. List rows additionally include derived `status`. Unmatched reasons: `no_client_account`, `ambiguous_email`, `self_invite`, `account_already_attributed`. Matching clears the reason. These email/identity details are staff-only.

Client aggregate counts:

- `invited`: unique recorded form responses attributed to this code, including unmatched entries.
- `joined`: responses matched to a client account.
- `completed`: matched eligible clients whose five-step completion has been reconciled, regardless of whether referral rewards were issued, paused, blocked or later voided.

At completion, the invitee receives **one referral voucher (default ₱15, adjustable as `rewards.inviteMinor`) in addition to their ordinary once-only mission voucher** and the inviter receives a voucher of the same amount. Both referral vouchers expire 30 elapsed days after issuance. There is one referral entitlement per invited account, containing both vouchers. Signup/matching alone never rewards either party. Later completion events cannot repeat the entitlement. Existing completed eligible accounts may be matched; their next own reconciliation processes the referral, never a staff-list bulk sweep. For a new/resumed referral, previously awarded accounts satisfy the added/tracked steps but placement/receipt/survey facts and client-fault exclusions are rechecked; an earned label cannot bypass those rules.

## Abuse evidence and outcomes

Before issuing either referral voucher, compare the invitee against (a) the inviter and (b) each previously rewarded invitee of this inviter, including later-voided rewards. Preserve the rewarded invitee's evidence snapshot and also compare any currently recorded evidence, so removing/changing a profile does not erase the prior snapshot.

| Check | Normalization/source |
| --- | --- |
| `phone` | Current `users.phone`. Strip formatting; normalize Philippine `09…` and `9…` to `639…`, and international `00` prefixes. Only 10–15 digit results contribute. This is recorded phone data, not new phone verification. |
| `device` | All historical UUID v4 installation associations recorded through the client mutations above. |
| `address` | Non-review **delivery** orders' `dropoff.addressLine` or `dropoff.label`. NFKC normalization, lowercase, punctuation-to-space and whitespace collapse; at least five characters; generic labels such as Home/Office/School/Client and the known GRIDGO office pin are omitted. No coordinate radius/fuzzy match. Pickup orders contribute no address evidence; the GRIDGO hub is never compared as a personal address. |

A positive match on any check blocks **both referral vouchers**, permanently, with `status:"blocked"` and comma-separated reasons `same_phone`, `same_device`, `same_address` in that order. It does not block the separate mission voucher. There is no staff bypass or block-resume route.

Missing evidence is neither a match nor proof of distinctness. **It does not hold a reward.** With no positive match, issue both vouchers subject to the budget. Every referral reward preserves the performed checks and missing-evidence coverage for Super Admin review. Each `checks.phone|device|address` contains:

```json
{"status":"no_match","comparedClientIds":["inviter_id"],"missingClientIds":[],"matchedClientIds":[]}
```

Status is `match`, `no_match`, or `missing` (no comparison possible). A `no_match` result can still have missing comparator IDs; inspect the coverage arrays. Only staff receive these arrays. Internal evidence hashes/installation UUIDs never appear in staff JSON. Signals are exact recorded-evidence checks, not a guarantee of distinct people/households. Staff can void issued rewards; there is no automatic clawback when evidence changes later.

## Operational Settings and monthly budget

Existing Super Admin-only `PATCH /settings` adds two nullable fields using the existing version/reason handshake:

```json
{
  "expectedVersion": 4,
  "reason": "Enable tester invites with a monthly allowance",
  "testerMonthlyBudgetMinor": 150000,
  "testerSignupFormUrlTemplate": "https://forms.example.test/signup?entry.123={code}"
}
```

`testerMonthlyBudgetMinor` is integer PHP centavos (example ₱1,500), safe-integer range, default/null = no limit, zero = pause all new paid entitlements. The dashboard may render pesos but must submit integer centavos. `testerSignupFormUrlTemplate` is null or an HTTPS URL up to 2,048 characters, with exactly one literal `{code}` placeholder in the query, no URL credentials. This supports provider-specific prefill keys such as `entry.123`. Super Admin is responsible for selecting an actual form with the correct prefill field. No provider probing is performed.

Budget uses the **Asia/Manila calendar month** of issuance and face value, not redemption or reservation. Count all mission and referral vouchers issued in that month, including earlier mission vouchers, expired/used/void vouchers. Reusing a survey voucher costs zero and does not count it again. Ordinary survey/manual campaigns are outside this tester budget. Voiding never frees budget. Money/order totals, wallet redemption funding and payout plans stay unchanged.

Mission issuance needs the snapshotted mission amount available; referral issuance needs twice the snapshotted invite amount for the pair (defaults ₱15/₱30). No partial referral issue. A qualifying entitlement with insufficient room is stored as `paused`, `reason:"monthly_budget"`, with no vouchers. Mission and referral entitlements are independent; the mission is evaluated first during the same completion action. The ledger and domain advisory lock serialize concurrent budget decisions.

**Paused rewards wait for individual Super Admin resume, including after a month change or budget increase.** No automatic monthly/lifecycle/bulk sweep issues vouchers. Resume recomputes eligibility, mission progress, budget and referral abuse checks before issuance; new positive evidence can move a paused referral to blocked. Expiry begins on actual issuance. If insufficient budget remains, resume returns 200 with the reward still paused.

Budget read shape:

```json
{"month":"2026-10","timezone":"Asia/Manila","limitMinor":150000,"usedMinor":4500,"remainingMinor":145500,"resumePolicy":"super_admin_per_reward"}
```

With no limit both `limitMinor` and `remainingMinor` are null.

## Staff rewards and actions

| Method/path | Result and authorization |
| --- | --- |
| `GET /ops/founding-testers?offset=0&limit=100` | Existing Operations/Super Admin account read, now `{serverTime,total,clients:[{clientId,name,foundingTester,invites}],budget}`. Includes eligible and ineligible accounts. |
| `GET /ops/tester-rewards?status=paused&clientId=usr_...&offset=0&limit=100` | Operations/Super Admin; `{serverTime,total,rewards:[...],budget}`. Optional state filter `issued|paused|voided|blocked`; `clientId` matches either beneficiary. Budget is always this month's whole programme, not filtered rows. |
| `POST /admin/tester-rewards/:id/resume` | Super Admin, `{reason:"..."}` → `{reward,budget}`. Only paused entitlements. |
| `POST /admin/tester-rewards/:id/void` | Super Admin, `{reason:"..."}` → `{reward,budget}`. Issued or paused; an already-voided entitlement is an idempotent success. Blocked rewards cannot be voided. |

All success responses use HTTP 200. Reasons must be nonempty strings up to 1,000 characters. Lists default to offset 0 / limit 100, maximum 500; invite/reward lists sort newest first with ID tie-breaking. No CSV variant exists.

Reward fields: `id`, `kind` (`mission|referral`), `clientId` (mission owner/invitee), nullable `inviterId`, nullable `inviteId`, `amountMinor` (snapshotted mission amount / twice the invite amount for a referral / 0 reused survey), `status`, `createdAt`, nullable `issuedAt`, nullable `voidedAt`, nullable `voucherId` (mission owner/invitee voucher), nullable `inviterVoucherId`, nullable `reason`, and `checks` (empty object for missions). States are `issued`, `paused`, `voided`, `blocked`; voided and blocked are terminal. Existing migrated awards have opaque IDs beginning `legacy-mission:`; clients must never construct any reward ID.

Voiding a referral entitlement voids **both unused vouchers** together. Available cart reservations are released. If either voucher owns a submitted checkout reservation, return `409 voucher_payment_reconciliation_required` and change neither until that payment is reconciled. Already-used vouchers remain historical consumption: no cash/credit/debt/clawback is created. Mark them so later refund restoration cannot revive the voided reward. Expired available items can also be marked void. Keep awarded labels and original expiry. Record an audit event and staff inbox notices atomically. Legacy `/admin/vouchers/:id/void` routes programme-owned vouchers through the same entitlement void; their generic `reissue` endpoint returns `tester_reward_managed`.

Internal campaigns use `founding_tester` or `tester_referral`. Both are protected from generic campaign edits/status/issue routes by `founding_tester_campaign_managed`. Voucher issuance uses the existing wallet/ledger hook; unknown-age recipients get in-app notices, no referral marketing push/email. All implemented reward events notify current Operations and Super Admin memberships durably. The standard save/outbox boundary handles delivery after commit.

## Errors

Errors have `{error:"snake_case"}`. Existing request parsing, Clerk, settings and survey errors remain applicable.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Missing/invalid session. |
| 403 | `forbidden` | Wrong membership for endpoint. |
| 403 | `tester_client_required` | Invite-code creation requires a non-review client identity. |
| 404 | `order_not_found` | Tracking order absent or belongs to another client. |
| 404 | `tester_reward_not_found` | Unknown staff reward ID. |
| 404 | `not_found` | Unsupported tester path/method. |
| 400 | `invalid_request` | JSON body is not an object. |
| 400 | `invalid_tester_installation_id` | Supplied value is not a UUID v4. |
| 400 | `invalid_tester_email` | Invalid form email or over 254 characters. |
| 400 | `invalid_tester_invite_code` | No matching personal code. |
| 400 | `invalid_tester_invite_status` | Unknown invite-list state filter. |
| 400 | `invalid_tester_reward_status` | Unknown reward-list state filter. |
| 400 | `invalid_pagination` | Invalid offset/limit. |
| 400 | `tester_reason_required` | Missing/blank/too-long action reason. |
| 400 | `invalid_tester_monthly_budget` | Not null or a nonnegative safe integer. |
| 400 | `invalid_tester_signup_form_url` | Invalid form template. |
| 400 | `invalid_founding_tester_launch_at` | Invalid existing UTC cutoff. |
| 400 | `settings_reason_required` | Missing existing settings reason. |
| 409 | `settings_version_conflict` | Existing expectedVersion handshake failed; response includes current version. |
| 409 | `tester_order_not_placed` | Tracking target has no qualifying placed facts yet. |
| 409 | `tester_invite_already_attributed` | Email already belongs to another inviter. |
| 409 | `tester_reward_not_paused` | Resume target is not paused; blocks cannot be bypassed. |
| 409 | `tester_reward_not_ready` | Resume target no longer eligible or five steps no longer qualify. |
| 409 | `tester_reward_not_voidable` | Void target is blocked. |
| 409 | `voucher_payment_reconciliation_required` | Submitted checkout reservation prevents void. |
| 409 | `tester_reward_managed` | Generic wallet reissue is forbidden for tester entitlements. |
| 409 | `founding_tester_campaign_managed` | Generic mission/referral campaign mutation is forbidden. |
| 409 | `tester_budget_overflow` | Aggregate issued money exceeds the JS safe-integer bound; no new issuance. |

## Migration, rollout and validation

Apply `1792506000000_tester_path_invites` before API deployment. It adds `founding_testers.added_at`, relational invite codes/attributions, append-only installation and tracking history, reward state/beneficiary/voucher references, and bounded JSONB abuse-evidence snapshots. Existing awards become reward-history rows only; **the migration issues zero vouchers and does not fabricate tracking events**. PostgreSQL guards identity ownership, unique attribution/entitlement and immutable terminal history. Every mutation uses the existing domain transaction/advisory lock, with audit, vouchers and notifications committed together. No schema repair at boot.

Rollout order: API migration/release → Super Admin configures the real form template/budget and form-response ingestion → client sends installation/tracking events and renders five steps/Copy/Share → dashboard renders invites, missing-evidence coverage, budget, resume and void. Legacy clients do not send tracking acknowledgements and cannot complete a new five-step award until upgraded; already-awarded accounts retain their reward. Keep the prior no-production-bulk-award preflight gate. No production voucher issue is part of this change.

Tests cover mission facts and grandfathering, attribution and unmatched records, each positive abuse signal, missing-evidence behavior, sibling invite snapshots, atomic pair issuance, void/refund protection, monthly boundaries and explicit resume, concurrent retries, launch cutoff, permissions and SQL guards. The integration suite starts a separate real HTTP API with signed test JWTs; PostgreSQL 17 runs on a dedicated free port with its data directory under `/tmp`. Checkout/payment/QA/rider handover/OTP/survey flow is exercised through HTTP. Identity provisioning and uploaded camera/file bytes are test fixtures; this is not a real Clerk tenant or physical-device test. Separate HTTP flows exercise the abuse block, void, settings handshake and budget pause/resume.
