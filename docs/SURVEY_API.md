# Post-order survey

Server contract for report **81CA4493**. Client and dashboard UI ship separately.
Rewards use the existing [GRIDGO-funded voucher wallet and ledger](VOUCHERS_API.md).
Optional pricing questions, the checkout exit question and Admin pricing results:
[Pricing feedback](PRICING_FEEDBACK_API.md).
Survey answers never change order money, payout holds, issues, claims, refunds,
listing ratings, or matching rank.

## Eligibility and launch

Migration `1791993000000` records an immutable `survey_launch.launched_at` once.
This migration's application is the server go-live boundary; redeploys and seeds
do not reset it. Deploy the compatible client promptly so the launch window is
usable. No operational records are added by the reference seed.

A confirmed client handover qualifies: direct delivery or completed pickup/claim,
not arrival at the hub or readiness for collection. Completion uses the original
`issueWindowOpenedAt` (legacy fallback: the first delivered timeline timestamp).
Eligible orders have state `delivered`, `issue_window_open`, `completed`, or
`payout_released`. Once invited, the original completion/window facts stay fixed.

- New handovers: opens at completion, expires exactly seven elapsed days later.
- At go-live: orders completed in the preceding 14 elapsed days, including the
  exact lower boundary, get a fresh seven-day window starting at go-live.
- Expiry is exclusive; submission at `expiresAt` is refused.
- One final response per order. A basket's independent orders each have their
  own survey, subject to the same account reward cooldown.
- Skipping is optional dismissal. It hides the automatic prompt but does not
  consume the response or reward; the order card can reopen until expiry.

The normal `save()` boundary creates one invitation and durable
`order_survey_available` client inbox/push notice in the handover transaction.
The lifecycle sweep catches eligible historical orders. Reads can show a card
before that sweep without mutating anything. Notice retries and subsequent saves
never extend the window or send a second invitation. Push data stays the existing
allowlist (`notificationId`, `type`, `orderId`, `at`); it contains no answers or
voucher code. Current Operations and Super Admin memberships receive generic
invitation/dismissal/submission event notices, without survey answers. Only Super Admin
can access the response dataset.

## Client routes

All routes require a Clerk session and a database client membership. An order
must belong to that identity; another client's order returns `404 order_not_found`.
Supplier, rider, staff and Operations without client membership get 403.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/me/surveys` | `{serverTime, options, surveys}`; all currently open owning-client cards, including dismissed ones |
| GET | `/orders/:id/survey` | `{serverTime, options, survey}`; null when ineligible, otherwise open/expired/submitted |
| POST | `/orders/:id/survey/dismiss` | `{serverTime, survey}`; idempotent dismissal while open |
| POST | `/orders/:id/survey` | `{serverTime, survey}`; final submission and reward decision atomically |

Responses are private/no-store. Use server time for countdowns and refetch on
resume, order completion, notification open, and after submission. Filter
`dismissedAt` out of automatic prompts, but keep a manual entry on the order.
The notification's `orderId` opens that order's survey route.

Submission body (integer PHP minor units for expected price):

```json
{
  "fulfillmentStars": 2,
  "fulfillmentTags": ["late"],
  "easeStars": 4,
  "easeTags": ["easy_checkout"],
  "priceFeeling": 3,
  "expectedPriceMinor": 10000,
  "directShopComparison": "about_the_same",
  "priceWorthTags": ["door_delivery"],
  "orderAgainAtPrice": "yes",
  "qualityStars": 5,
  "recommendScore": 8,
  "improvementNote": "More delivery updates would help."
}
```

The first three **scores** are required: `fulfillmentStars` and `easeStars` are
integers 1–5; `priceFeeling` is 1–5 mapping to very cheap, cheap, fair, expensive,
very expensive. Tags are optional (default empty), distinct, and allowlisted;
use `options` returned by the server. The fulfillment question is delivery or
pickup according to `fulfillmentKind`.

| Group | Allowed tag codes |
| --- | --- |
| Delivery | `on_time`, `late`, `friendly_rider`, `clear_updates`, `hard_to_contact`, `careful_handling`, `damaged_package`, `other` |
| Pickup | `easy_to_find`, `ready_on_time`, `long_wait`, `helpful_staff`, `clear_instructions`, `inconvenient_hours`, `damaged_package`, `other` |
| Ease | `easy_to_find_product`, `clear_options`, `easy_checkout`, `upload_difficulty`, `confusing_steps`, `payment_difficulty`, `slow_app`, `other` |

`expectedPriceMinor` is optional/null, nonnegative, and a safe integer.
`qualityStars` is optional/null, integer 1–5. `recommendScore` is optional/null,
integer 0–10 so completing the first three questions alone can earn the reward.
`improvementNote` is optional/null, trimmed, maximum 2,000 characters.
`directShopComparison`, `priceWorthTags` and `orderAgainAtPrice` are optional
pricing questions defined in [Pricing feedback](PRICING_FEEDBACK_API.md); they
never affect the reward or `needsFollowUp`. No age,
adult-confirmation, role, reward amount or reward identifier is accepted from
the client. There is no partial-save or answer-edit endpoint: submit once after
collecting whichever optional answers the client wants to give. A replay returns
the original response and reward even after expiry; changed replay bodies do not
replace answers or issue another voucher.

A survey card contains:

```json
{
  "orderId": "ord_...",
  "status": "submitted",
  "fulfillmentKind": "delivery",
  "openedAt": "2026-10-14T08:00:00.000Z",
  "expiresAt": "2026-10-21T08:00:00.000Z",
  "dismissedAt": null,
  "submittedAt": "2026-10-14T08:05:00.000Z",
  "answers": {"fulfillmentStars":2,"fulfillmentTags":["late"],"easeStars":4,"easeTags":["easy_checkout"],"priceFeeling":3,"expectedPriceMinor":10000,"directShopComparison":"about_the_same","priceWorthTags":["door_delivery"],"orderAgainAtPrice":"yes","qualityStars":5,"recommendScore":8,"improvementNote":"More delivery updates would help."},
  "needsFollowUp": true,
  "rewardStatus": "issued",
  "reward": {"id":"vch_...","campaignId":"vcamp_...","code":"7AFD123456789ABC","name":"Thank you for your order feedback","valueMinor":1500,"status":"available","issuedAt":"2026-10-14T08:05:00.000Z","expiresAt":"2026-11-13T08:05:00.000Z","secondsRemaining":2592000,"redeemable":true,"reservation":null,"fundedBy":"GRIDGO","transferable":false,"cashValue":false},
  "rewardEligible": false,
  "nextRewardAt": "2026-10-21T08:05:00.000Z",
  "reportProblem": {"label":"Report a problem with this order","path":"/orders/ord_.../issues","method":"POST"}
}
```

Before submission, `answers`, `submittedAt`, `rewardStatus`, and `reward` are
null. `rewardEligible` is a current preview, not a reservation; another order's
submission can consume the account's available reward first.

## Reward and low-score behavior

**Founding Tester exception:** eligible pre-launch client accounts earn the single
₱15 reward through the five missions, replacing the repeat survey reward below.
See [Founding Tester path and invites](FOUNDING_TESTER_API.md) for the five-step reward gate, budget pauses and referral rewards; see [Founding Tester missions](VOUCHERS_API.md#founding-tester-missions) for cutoff,
failure surveys, progress projections, one-time historical reuse and reminder rules.
Cards add `rewardProgram`; mission submissions use `rewardStatus:"founding_tester"`
and resolve `reward` to the single account wallet item. Non-tester clients retain
the survey cooldown below. Existing submitted survey records are immutable.

Every eligible submission receives a voucher at the current `rewards.surveyMinor` (default ₱15 / `1500` centavos), configured in [promotion settings](VOUCHERS_API.md#launch-promotions). Already-issued amounts remain fixed. Scores, tags and comments do not affect the amount. A submission earns no new voucher if that user already received a
survey reward within the preceding seven elapsed days. Exact seven-day equality
qualifies again. The cooldown is across all orders and all app sessions.

During cooldown the answer is still saved, with `rewardStatus: "cooldown"` and
`reward: null`. It never becomes a deferred reward; retries after the cooldown
remain the original submission. Only a new eligible order can earn again.
Voiding, using, expiring, refunding or restoring a voucher does not reset the
survey cooldown or create another reward for its source order.

Rewards expire exactly 30 elapsed days after issuance. An internal assigned
campaign per earned entitlement preserves the wallet's one-per-campaign rule.
These campaigns have `purpose: "survey"`; general campaign administration cannot
issue more recipients, edit terms, pause or end them (`409 survey_campaign_managed`).
Ordinary manual campaign behavior is unchanged. Admin can still audit and void
an individual voucher with the existing reason-required wallet operations.

Survey reward wallet projections include a private `code`. Display/copy it from
`survey.reward.code` or `GET /me/vouchers`. Existing `POST /me/vouchers/code` and
cart code entry resolve that code to the **already issued owning-client voucher**;
they never create another entitlement and never transfer it. A different account
receives the normal wrong-code response/rate limiting. Existing voucher checkout,
expiry, fee-first GRIDGO funding, refund restoration and ledger rules apply.

All survey rewards use `adultConfirmed:false`. Under-18 and unknown-age clients
receive their reward in-app only, with no reward push or email and no marketing
email queue entry. The service survey invitation itself uses the normal order
notification push. Age is not inferred from email or client input.

Any fulfillment/ease/quality star score ≤2 sets `needsFollowUp`. A recommendation
score 0–6 also sets the Admin flag (an NPS detractor). Price feeling is not a star
rating; “cheap” is not a complaint. `reportProblem` is non-null only for a low
**star** score while the actual order is `issue_window_open` and before its issue
window expiry. It is recalculated on every read. Otherwise show a thank-you
without a report prompt. A detractor recommendation alone does not offer the
low-star issue shortcut.

The link opens the existing issue form. Do not auto-POST an issue: a separate,
explicit client action and the existing issue endpoint's validation are required.
A survey never creates a refund, issue, claim, escalation, payout hold, or money
adjustment. Closing an issue window can remove the shortcut while the seven-day
survey remains open.

## Admin responses and export

`GET /admin/survey-responses` requires **Super Admin membership**; Operations,
suppliers, riders, invited staff, and ordinary clients cannot list or export it.
There is no public or shop-facing survey aggregate. Responses never enter ordinary
order projections, catalog ratings, or matching signals.

Filters combine with AND:

- `clientId`, `orderId`, `fulfillmentKind=delivery|pickup`, `rewardStatus=issued|cooldown|founding_tester`.
- `needsFollowUp=true|false` (automatic flag, not editable).
- Exact `fulfillmentStars`, `easeStars`, `qualityStars`, `priceFeeling`, `recommendScore`.
- `tag` matches either answer's tag set.
- Inclusive ISO `from` and `to`, applied to submission time.
- `categoryCode`, `orderSize` and `accountType`, as defined in
  [Pricing feedback](PRICING_FEEDBACK_API.md#filters).
- `offset` (default 0), `limit` (default 100, maximum 500).

JSON: `{serverTime,responses,total,aggregates}`. Rows include order/client IDs,
original completion/window/notified/dismissed/submitted timestamps, fulfillment
kind, all scores/tags/comment, pricing answers, flag, reward status and voucher ID,
plus the order total, order size bracket, category codes and account type. No email,
Clerk subject, private files or voucher code is included. Rows sort by submission
descending, then order ID ascending. `total` and aggregates cover **all matching
responses**, not just the page.

`aggregates` contains `averages` and `counts` keyed by each score,
`needsFollowUp` count, `promoters`, `passives`, `detractors`, and `nps`.
Null optional answers are excluded from denominators. NPS is
`100 × (promoters − detractors) / recommendScoreCount`, where 9–10 are promoters,
7–8 passives, and 0–6 detractors. Empty averages and NPS are null, not zero.
Averages/NPS may be fractional; dashboard display can round them.

`format=csv` downloads `survey-responses.csv` as UTF-8 CSV. The same filters apply;
pagination does not truncate export. Columns include scores, tags (pipe-separated),
comment, flag, reward references, pricing answers and the filter facts. Cells are quoted, quotes doubled, and
spreadsheet formula prefixes escaped, including leading whitespace. Exports and
JSON use `Cache-Control: private, no-store`.

## Storage, atomicity and validation

PostgreSQL `order_surveys` owns one row per order, foreign-keyed to its client,
order and reward voucher. Scores, lifecycle dates, reward relation and flags are
relational; tag arrays are bounded JSONB. The adapter is `src/survey-store.js`;
policy and projection are `src/surveys.js`; routes are `src/survey-routes.js`.

The existing transaction-scoped domain advisory lock serializes submission,
reward eligibility, voucher ledger, audit and inbox/outbox writes across API
processes. Database constraints independently protect unique order/reward links,
score ranges, immutable facts/answers, voucher ownership/value/expiry and rolling
reward spacing. Provider I/O remains after commit. No schema is created at boot.

Errors use `{error:"snake_case"}`: 401 `unauthorized`; 403 `forbidden`; 404
`order_not_found`; 409 `survey_closed` or `survey_campaign_managed`; 400
`invalid_survey_answers`, `invalid_survey_tags`, `invalid_survey_expected_price`,
`invalid_survey_note`, `invalid_survey_filter`, or `invalid_pagination`.

Focused tests cover window boundaries, first-three-answer rewards, cooldown
boundary/retries, copy-code ownership, low-star prompts, no automatic remedy,
PostgreSQL concurrent submissions, rollback and history guards, handover notices,
role/ownership denial, filtering, aggregates and CSV escaping. Local validation
uses an isolated test database; CI runs the full suite.
