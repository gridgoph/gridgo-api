# Account deletion requests

This release records requests for Operations to complete manually within 30 days.
It does not erase accounts, revoke sign-in, anonymise records, or handle Clerk
`user.deleted`. Automatic deletion awaits approved retention rules.

- `POST /me/account-deletion-request`: Clerk-authenticated mapped identity,
  `{ "confirmed": true }`. Records the authenticated user and contact email;
  caller-supplied identity fields are ignored. Available even when account standing
  is suspended or removed. Orders, refunds, disputes and payouts do not block a
  request: Operations reviews these during manual processing.
- `POST /account-deletion-requests`: public web submission,
  `{ "email": "account@example.test", "confirmed": true }`. A web email is
  unverified: never links an account by email. Operations must verify ownership
  before taking any deletion action. Limited to 10 attempts per connection per
  10 minutes. `/api/account-deletion-requests` is an equivalent path for the
  landing development proxy. Use the landing site's `/delete-account` page.
- Both return `202 { "ok": true, "message": "We will delete your account within 30 days" }`.
  Repeated pending requests reuse the existing request and original deadline.
  Public responses never disclose whether an account or request exists.
- `GET /ops/account-deletion-requests?status=pending&offset=0`: Operations/Super
  Admin memberships only. Status is `pending` (default) or `done`; returns
  `{ requests, nextOffset }`, at most 100 oldest requests first. Each request has
  `id`, `userId` (nullable), `contactEmail`, `source` (`app` or `web`), `status`,
  `requestedAt`, `dueAt`, `completedAt`, and `completedBy`.
- `PATCH /ops/account-deletion-requests/:id`: same staff access,
  `{ "status": "done", "confirmed": true }`. Records the operator's confirmation
  that manual deletion is complete. This action itself deletes nothing. Returns
  `{ request }`. Repeating it preserves the first completion timestamp/operator.

All writes, audits and staff inbox notifications commit atomically. Requests and
contact details are never exposed to other accounts. Staff invalidations contain
no contact details. Migration `1791946800000` must precede deployment.

Operations must resolve record-retention and unpaid-money/dispute decisions before
manual erasure; marking a request done must never substitute for that work. The
queue is a workflow record, not proof that deletion has happened.
