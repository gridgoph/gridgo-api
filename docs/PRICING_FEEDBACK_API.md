# Pricing feedback

Server contract for gridgo-client#243. The client app and the dashboard ship
separately against this document. It adds three optional pricing questions to
the [post-order survey](SURVEY_API.md), a one-tap checkout exit question, and
Super Admin results for every pricing question.

Nothing here changes order money, the survey reward, vouchers, matching or
listing ratings. The ₱15 survey reward rule is unchanged: pricing answers are
optional, never required for the reward, and never alter `needsFollowUp`.

## Survey: three optional pricing questions

Ask them after the existing price questions (`priceFeeling` and
`expectedPriceMinor`). All three are optional; omit them or send `null`/`[]`.
`GET /me/surveys` and `GET /orders/:id/survey` return their codes in `options`.

| Field | Question | Allowed values |
| --- | --- | --- |
| `directShopComparison` | Compared with ordering directly from a print shop, GRIDGO was… | `much_cheaper`, `cheaper`, `about_the_same`, `more_expensive`, `much_more_expensive`, `not_sure` |
| `priceWorthTags` | What made the price worth it? (choose any) | `print_quality`, `on_time`, `door_delivery`, `no_shop_visits`, `quality_check`, `easy_ordering`, `clear_upfront_price`, `helpful_support`, `other`, `not_worth_it` |
| `orderAgainAtPrice` | Would you order again at this price? | `yes`, `maybe`, `no` |

`priceWorthTags` is a distinct array. `not_worth_it` is the opposite of every
other choice, so it must be sent alone. Show it as a separate “It was not worth
it” choice that clears the others.

Unknown values return `400 invalid_survey_answers` (single choices) or
`400 invalid_survey_tags` (`priceWorthTags`), before anything is saved. Submitted
answers are part of the immutable response: `survey.answers` always includes
the three keys (`null`, `[]` or `null` when not answered), and a replay never
replaces them.

## Checkout exit question

A client who reached checkout and left without paying is asked once, on a later
app open, “What stopped you from ordering?”. It is skippable, asked at most once
every 7 days per account, and has no reward.

### How the API knows checkout was reached

The checkout screen calls:

`POST /me/carts/:id/checkout-visit` (no body) → `{serverTime, visit:{cartId, firstReachedAt, lastReachedAt}}`

Call it each time the checkout screen opens or regains focus; fire and forget,
never block checkout on it. It requires the owning client and a draft cart with
at least one line (`404 cart_not_found`, `409 cart_checked_out`,
`409 cart_empty`). The server snapshots the cart's current quote total and
category codes for the Admin filters. Repeated calls within five minutes with an
unchanged cart write nothing.

A checkout counts as **abandoned** when all of these hold:

- its latest visit was at least **one hour ago** (paying in a bank app and coming
  back is not leaving);
- the cart is still a draft (not checked out);
- the client has placed no order since that visit;
- the visit is later than the last time this account was asked.

### On app open

`POST /me/checkout-exit-feedback/prompt` (no body) claims the question when it is
due and returns:

```json
{
  "serverTime": "2026-10-16T09:00:00.000Z",
  "question": "What stopped you from ordering?",
  "options": [
    {"code": "price_too_high", "label": "The price was too high"},
    {"code": "delivery_cost_or_time", "label": "Delivery cost or time"},
    {"code": "still_deciding", "label": "Still deciding"},
    {"code": "payment_problem", "label": "Trouble paying"},
    {"code": "found_another_option", "label": "Found another option"},
    {"code": "just_browsing", "label": "Just looking around"},
    {"code": "other", "label": "Other"}
  ],
  "prompt": {
    "id": "cxp_...",
    "question": "What stopped you from ordering?",
    "status": "unanswered",
    "reachedAt": "2026-10-16T07:40:00.000Z",
    "askedAt": "2026-10-16T09:00:00.000Z",
    "answeredAt": null,
    "skippedAt": null,
    "reason": null,
    "otherText": null
  },
  "nextEligibleAt": "2026-10-23T09:00:00.000Z"
}
```

`prompt` is `null` when nothing is due; `nextEligibleAt` is then the earliest
time the account may be asked again (or `null` if it has never been asked).
Show the question only when `prompt` is non-null. The claim is the “once”: the
same prompt is never returned again, even if the app closes before an answer,
and the 7-day limit counts from `askedAt`. Call it on app launch or return to
the foreground, not while the checkout screen is open.

### Answer or skip

`POST /me/checkout-exit-feedback/:promptId`

- One-tap answer: `{"reason": "price_too_high"}`
- Other: `{"reason": "other", "otherText": "Needed it by Friday"}` — required,
  trimmed, 1–500 characters. `otherText` is refused for any other reason.
- Skip: `{"skip": true}`

Returns `{serverTime, prompt}`. The first answer or skip is final; a retry
returns it unchanged. Errors: `404 checkout_exit_prompt_not_found` (unknown or
another client's prompt), `400 invalid_checkout_exit_answer`,
`400 invalid_checkout_exit_note`. A skip still counts toward the 7-day limit.

All client routes need a Clerk session with a client membership (others get
`403 forbidden`) and respond `Cache-Control: private, no-store`. The exit
question sends no notifications and issues no voucher.

## Admin results

Both routes require **Super Admin membership**, like `GET /admin/survey-responses`.
Other roles get `403 forbidden`.

### Filters

All filters combine with AND and also apply to `GET /admin/survey-responses`:

- `from`, `to`: inclusive ISO times. Survey answers use submission time; exit
  answers use the time the question was asked.
- `categoryCode`: a taxonomy category (retired aliases resolve). An order matches
  when any of its lines is in that category; an exit answer when its cart was.
- `orderSize`: the client total — order `totalMinor`, or the cart quote total at
  the last checkout visit (an unpriced cart has no size). Inclusive brackets:

  | Code | Range |
  | --- | --- |
  | `under_500` | ₱0 – ₱499.99 |
  | `500_to_1999` | ₱500 – ₱1,999.99 |
  | `2000_to_4999` | ₱2,000 – ₱4,999.99 |
  | `5000_to_19999` | ₱5,000 – ₱19,999.99 |
  | `20000_and_up` | ₱20,000 and up |

- `accountType`: `individual | business | organization`, the client's current
  account type.

Invalid values return `400 invalid_survey_filter`.

### `GET /admin/pricing-feedback`

```json
{
  "serverTime": "...",
  "survey": {
    "responses": 3,
    "questions": {
      "priceFeeling": {"answered": 3, "options": [{"code": "expensive", "count": 1, "percent": 33.3}]},
      "expectedPrice": {"answered": 2, "options": []},
      "directShopComparison": {"answered": 2, "options": []},
      "priceWorthTags": {"answered": 3, "options": []},
      "orderAgainAtPrice": {"answered": 2, "options": []}
    }
  },
  "checkoutExit": {
    "asked": 1, "answered": 1, "skipped": 0, "unanswered": 0,
    "reasons": {"answered": 1, "options": [{"code": "other", "count": 1, "percent": 100}]}
  },
  "orderSizeBrackets": [{"code": "under_500", "minMinor": 0, "maxMinor": 49999}]
}
```

(Option lists are abbreviated.) Every question lists every option in the order
above, with zero counts included. `percent` is `100 × count / answered`, rounded
to one decimal; it is `null` when `answered` is 0. Unanswered optional questions
are left out of `answered`.

- `priceFeeling` options: `very_cheap`, `cheap`, `fair`, `expensive`, `very_expensive`.
- `expectedPrice` compares “what price would have felt right” with the order
  total: `much_lower` (below 80%), `lower` (80% to below 95%), `about_the_same`
  (95%–105%), `higher` (above 105%).
- `priceWorthTags` is choose-any: each option is the share of clients who
  answered that question, so the percentages can add up to more than 100.
- `checkoutExit.reasons` counts answered questions only; `skipped` and
  `unanswered` (asked, but the app closed) are reported separately.

`format=csv` downloads `pricing-feedback.csv` with columns
`section,question,code,count,percent,answered`, one row per option.

### `GET /admin/checkout-exit-feedback`

The individual exit answers, newest question first:
`{serverTime, prompts, total}`. Each row has `id`, `clientId`, `cartId`,
`reachedAt`, `askedAt`, `status` (`answered | skipped | unanswered`), `reason`,
`otherText`, `answeredAt`, `skippedAt`, `cartTotalMinor`, `orderSize`,
`categoryCodes` and `accountType`. Extra filters: `clientId`, `status`, `reason`,
plus `offset` (default 0) and `limit` (default 100, maximum 500). `format=csv`
downloads `checkout-exit-feedback.csv` with every matching row.

### Survey response rows

`GET /admin/survey-responses` rows and CSV add `directShopComparison`,
`priceWorthTags` (pipe-separated in CSV), `orderAgainAtPrice`, `orderTotalMinor`,
`orderSize`, `categoryCodes` and `accountType`.

All CSV cells are quoted, quotes doubled, and formula prefixes (`=`, `+`, `-`, `@`)
escaped. Exports and JSON use `Cache-Control: private, no-store`.

## Storage

Migration `1792090000000` adds the three nullable/empty-default columns to
`order_surveys` (covered by its existing immutability guard) and two tables:

- `checkout_visits`: one mutable row per cart, with the first and latest visit
  and the snapshot used by filters.
- `checkout_exit_prompts`: one row per question asked. A trigger refuses deletes,
  changes to the asked facts, and any change after the answer or skip. It also
  refuses a second question for the same account within 168 hours, under the
  domain advisory lock. Checks keep `reason` and `otherText` consistent.

Policy lives in `src/pricing-feedback.js`, routes in
`src/pricing-feedback-routes.js`, and the store adapter in
`src/checkout-exit-store.js`. Focused tests: `tests/pricing-feedback.test.js`
and `tests/pricing-feedback-postgres.test.js`.
