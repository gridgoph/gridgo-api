# Matching and cart-line save boundary

Issue 307's hybrid save scope applies to `POST /me/matches`,
`POST /me/matches/next`, and `POST`, `PATCH` and `DELETE` cart-line mutations.
They retain the domain transaction and transaction-scoped advisory lock. The
compatibility decoder hydrates the caller's own order/cart/verification facts,
the requested catalogue family or selected listings and relevant shop workload,
and notification/recipient policy context. It does not hydrate unrelated inbox,
audit, location or push-outbox history. Query coverage is cached only inside this
one locked hydration; no cache survives a transaction or needs invalidation.

Shared save still performs the requester's maintenance before persistence,
including call expiry, own voucher cancellation, surveys, invitation attribution,
production performance and hub state. Workload and historical shop event parents
remain policy context for performance counts/exemptions, while explicit order
scope limits which orders performance/call reconciliation may modify. Queued
invalidates from the maintenance view are transferred at their original save
stage. Audit, notifications, push outbox and transactional realtime events remain
in the same commit; transport delivery remains after commit.

Existing global supplement-reference/proof uniqueness and pending change/pin
payment refusals remain global, through indexed SQL candidates and the same JS
policy. The Unicode reference fallback keeps JavaScript trim/uppercase semantics.
The request's ordinary ownership, role, token, deadline, artwork, pricing and
compact cart-response contracts are unchanged. Artwork short-link preflight uses
a read-only repeatable-read graph without waiting for the domain lock; external
provider checks still precede the separately locked authorization/fingerprint
recheck. Own issue-window expiry still
precedes routing and retains the distinction between returned error responses
and thrown errors/rollback.

## Upkeep timing

Unrelated upkeep no longer waits for the next **scoped** matching/cart-line save.
A one-second candidate sweep handles removed accounts' saved-file closure,
cancelled voucher reservations, tester/promotion invite attribution, unavailable
change closure and failure-based survey gaps. Existing lifecycle candidate sweeps
continue at their configured cadence (30 seconds by default) for ordinary
surveys, hub reminders, production performance, voucher expiry and colour work;
active calls retain their one-second sweep. Expired match-selection records older
than the retained 24-hour expiry window are pruned by a one-second indexed probe.

The new probe does not load the complete writer for unchanged invitation/change
candidates. When upkeep actually changes, it rechecks under the domain lock and
uses the existing complete audited save. These positive-work branches, as well
as other existing full-adapter mutations, remain follow-up work for issue 307.
There is no claim that every background branch is now a scoped writer.

Moved upkeep retains its system actor, business audit evidence, notifications,
outbox and invalidates. Its audit app/device provenance is now `system`/`null`,
rather than the next request's app/device. The hub reminder helper tracks changes
per order, so a preceding changed candidate cannot invalidate a later unchanged
order merely because it followed it in the loop.

## Persistence and fallback

Forward migrations are required; see [Deployment](DEPLOYMENT.md). Old review
payment flags are normalized once without changing amounts or statuses. Private
`store_collection_counts` metadata maintains exact audit/inbox array cardinality,
including sparse historical positions, so appends need no history scan. The
counts exclude notifications hidden by an order's recorded removal, matching the
compatibility adapter's visible array; statement triggers update that count when
a removal is recorded or a notification's order reference changes. Layout
markers also detect gaps/compaction caused by edits, deletes or logical order
removals. Where own maintenance would edit a row whose legacy global ordinal
cannot be proved from the scoped graph, the request retains the full writer;
existing row positions are never guessed from a subset. The scoped writer still refuses ordinary
read-only projection stores and only changes the hydrated delta.

`POST /me/carts/:id/checkout` and its artwork preflight retain the full store and
money boundary. A rare first cart-line addition that would complete all five
missions for a legacy client with four missions but no recorded added step also
retains the full reward/budget/referral graph. It is not replaced with a partial
money calculation. Non-active accounts, other nonclient/unsupported write graphs and the historical
layout fallbacks above retain their legacy path. In particular, the full fallbacks still run legacy global maintenance.

Request time can still depend on the caller's relevant history and the candidate
shops' workload/catalogue; this release adds no response pagination or limits.
Production sub-100ms acceptance, the dev/production rollout and the remaining
full-adapter writes remain separate issue 307 release gates.

## Verification

`tests/scoped-saves-postgres.test.js` compares actual baseline/scoped HTTP bytes
and relational rows, exercises global payment errors and direct-call SQL rollback,
checks concurrent cart versions, and compares moved upkeep with the old save's
business rows. Test-only module hooks freeze clocks/randomness and inject late
failures; production has no baseline switch. Matching catalogue thumbnails and
compact mutation listing projections retain their signing behaviour.

`scripts/benchmark-scoped-saves.mjs` runs only against an isolated test database.
It grows unrelated notifications, audit, pings and delivered push-outbox history
from 10,000 to 100,000 rows each and asserts identical scoped query/row budgets.
It reports server request-log medians/p95s; `PERF_BASELINE=1` also samples the old
full save. Local synthetic timings do not establish production acceptance.
