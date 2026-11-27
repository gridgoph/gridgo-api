# Shop ratings

Structured review tags, client summaries and comment privacy for report
`18CA1296`. Apply `1795792400000_structured_review_tags` before this API release.
The migration is additive and forward only; boot does not repair schema.

## Submit a review

The owning client uses the existing `POST /orders/:id/review`:

```json
{
  "qualityStars": 5,
  "speedStars": 4,
  "valueStars": 4,
  "tags": ["Accepted fast", "Clear print"],
  "comment": "Ready before I got there."
}
```

All three scores remain required whole numbers from 1 to 5. Quality determines
the tag group and continues to be the only review score used in matching.

| Quality stars | Allowed tags |
| --- | --- |
| 4–5 | Accepted fast, Clear print, Ready on time, Friendly, Good value, Easy to find |
| 1–3 | Faded print, Wrong settings, Slow to accept, Not ready on time, Rude, Hard to find |

`tags` is optional for installed clients. When present it must be an array of
these exact strings from the appropriate group. Duplicate selections are saved
once; unknown tags, another score group's tags, non-arrays and null return
`400 invalid_rating_tags`. Omitted tags are stored as an empty array. The
PostgreSQL constraint also enforces valid, unique tags in the score group.

A review remains one per order (`409 already_rated`), authorized to its owning
client. Regular orders retain their finished-order gate. Express can be rated
after pickup/delivery under [Order tracking](ORDER_TRACKING_API.md#rating-after-pickup).
Ratings remain separate from problem reports, reprints and refunds.

The `201 {review}` response adds `tags` and uses the comment display filter
below. Scores, comment evidence, structured tags and the existing rating audit
commit in one domain transaction. No new notification flow is introduced.

## Client summary

`GET /shops/:supplierId/ratings` requires a signed-in client. It returns
`401` without authentication, `403 forbidden` for another selected role, or
`404 shop_not_found` if the shop is absent or outside that client's visible
approved catalogue. It applies the same visibility rules to home printers.
Responses use `Cache-Control: private, no-store`.

With fewer than five valid quality reviews, the response is exactly
`{"summary":null}`. Show no stars, count, review preview or replacement badge.
The existing catalogue, match and printer-card rating gates remain unchanged.
From the fifth review:

```json
{
  "summary": {
    "average": 4.8,
    "count": 5,
    "starBars": [
      { "stars": 5, "count": 4 },
      { "stars": 4, "count": 1 },
      { "stars": 3, "count": 0 },
      { "stars": 2, "count": 0 },
      { "stars": 1, "count": 0 }
    ],
    "acceptRate": {
      "windowDays": 30, "offered": 10, "accepted": 8,
      "declined": 1, "timedOut": 1, "rate": 0.8
    },
    "averageAnswerSeconds": 20,
    "jobsAhead": 2,
    "topTags": [
      { "tag": "Clear print", "count": 4 },
      { "tag": "Accepted fast", "count": 3 },
      { "tag": "Friendly", "count": 2 }
    ],
    "latestReview": {
      "reviewer": "Mira H.", "qualityStars": 5,
      "tags": ["Clear print", "Accepted fast"],
      "comment": "Ready before I got there.",
      "createdAt": "2026-11-27T10:00:00.000Z"
    }
  }
}
```

- `average` is the quality-star mean rounded to one decimal. `count` and the
  descending 5–1 bars use the same valid reviews; marked test orders are excluded.
- Acceptance reuses the accept-first 30-day metric: assignments strictly after
  the window start and up to now; accepted, declined and timed-out attempts
  count, including reroutes as their own shop attempts. Pending/withdrawn offers,
  legacy acceptance flows and marked test orders do not count. `rate` is a 0–1
  fraction, rounded to four decimals, or null with no resolved offers.
- `averageAnswerSeconds` uses the same 30-day assignment window, averaging actual
  accepted/declined answer timestamps and rounding to whole seconds. A timeout
  is not an answer. Missing, negative or future answer times are excluded; no
  answers means null. Later production/payment events never stand in for an answer.
- `jobsAhead` shares the Express printer-card queue: assigned pending work,
  payment authorized, production and self-QC; refused accept-first assignments
  are excluded. This is current GRIDGO work, not an estimate of walk-in jobs.
- Each selected tag counts once per review. `topTags` contains up to three,
  ordered by descending count then label for stable ties.
- The latest review is ordered by creation time then review ID, newest first.
  It contains a first name and last-name initial, date, quality score, tags and
  filtered comment. A single name remains a single name; malformed/missing
  profile names use `Client`. No client/order IDs or contact details are included.
- The summary has no shop point, pickup point, street, address or coordinates.
  Home printers use the same scores, threshold, tags and metrics.

## Existing text and display privacy

Migration converts only one complete standalone `Tags: ...` line containing known
labels in the review's quality-score group, separated by commas or middle dots.
It copies those labels to the new array, removing duplicate selections, while
preserving every stored score, original comment, author, order and timestamp.
Multiple tag lines, or an ambiguous, unknown, incomplete or wrong-group line, remain unconverted and
its stored comment is unchanged. Read projections also recognize clean legacy
lines for compatibility with installed writers that still send text tags.

Free-text filtering runs before comments are returned in the creation response,
`GET /me/reviews` and the client summary. It suppresses the whole comment as
null when it detects phone/account numbers, links (including contact-obfuscation
forms supported by the chat filter), address/direction markers, coordinates or
known private shop/home pickup text. Original evidence is retained in PostgreSQL;
filtering never edits an existing rating. Ordinary comments remain readable.
The filter is deterministic and conservative: ambiguous contact/location text
can be withheld along with the rest of that comment. It is not geocoding.
Home street, landmark and pickup-description evidence, including retained home
snapshots, is checked as private text and never added to the summary.

The supplier's existing review response adds `tags`, retains its three scores
and job metadata, and continues to omit the client's identity. Its ranking and
minimum-review matching rules do not change.
