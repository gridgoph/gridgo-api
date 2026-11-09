# Compatible staff list pagination

The following GET lists accept optional `limit` and `cursor`, matching the
Operations catalogue desk's parameter names and top-level `nextCursor` field.
Existing authentication, role headers, filters and private projections still apply.

**No `limit` or `cursor`:** the response retains its complete legacy list,
ordering and shape. There is no default truncation or new response field.
The existing targeted reader and its SQL remain in use; lists without an
application sort retain that reader's enumeration. Deterministic keyset ordering
applies only when the caller supplies page parameters.

**Either parameter supplied:** select a bounded SQL keyset page before loading
its related rows. `limit` is a decimal integer from 1 through 50; it defaults to
50 when only `cursor` is supplied. Invalid limits return `400 invalid_limit`.
An empty, malformed, wrong-route or changed-filter cursor returns
`400 invalid_cursor`. Authorization and existing required-field checks still
precede these parameter errors.

The array retains its existing name and row shape. Other response fields remain
present, and `nextCursor` is a string when more matching rows exist or `null` on
the final/empty page. Pass the returned string as `cursor`, keeping the same
route, filters and selected role. The page size may change between requests.
Cursors are opaque; clients must not construct or interpret their keys.

```http
GET /admin/staff/invites?limit=20
GET /admin/staff/invites?limit=20&cursor=<nextCursor>
```

```json
{ "invites": [], "nextCursor": null }
```

## Routes and page order

| GET route | Array | Opt-in page order |
| --- | --- | --- |
| `/orders` | `orders` | `createdAt` descending, order ID descending |
| `/baskets` | `baskets` | `createdAt` descending, basket ID descending |
| `/issues` | `issues` | `createdAt` descending, issue ID descending |
| `/credits/balance` | `ledger` | ledger `at` descending, entry ID descending |
| `/admin/promotions?section=claims` | `founding.claims` | `claimedAt` descending, voucher ID descending |
| `/admin/promotions?section=invites` | `friendPass.invites` | `createdAt` descending, invite ID descending |
| `/admin/shop-rankings` | `rows` | existing global rank/name order, stable supplier tie-breaker |
| `/ops/shops/:id/performance` | `performance.events` | event `at` descending, event ID descending |
| `/admin/staff` | `staff` | `updatedAt` descending, user ID descending |
| `/admin/staff/invites` | `invites` | `createdAt` descending, invite ID descending |
| `/admin/staff/roles` | `roles` | role code ascending |
| `/admin/voucher-campaigns` | `campaigns` | `createdAt` descending, campaign ID descending |
| `/ops/vouchers?clientId=…` | `vouchers` | `issuedAt` descending, voucher ID descending |
| `/ops/hub/escalations` | `escalations` | legacy order position ascending, order ID ascending |
| `/ops/hub/unclaimed` | `orders` | legacy order position ascending, order ID ascending |
| `/users/:id/production-lapses` | `lapses` | `detectedAt` descending, lapse ID descending |
| `/supplier-services` | `services` | legacy service position ascending, service ID ascending |
| `/ops/shops/hours` | `shops` | supplier ID ascending |
| `/ops/shops/performance` | `shops` | supplier ID ascending |
| `/ops/reschedule-requests` | `requests` | `requestedAt` descending, order ID descending |
| `/refund-requests` | `refunds` | refund ID ascending |
| `/users` | `users` | user ID ascending |
| `/claims` | `claims` | `createdAt` descending, claim ID descending |
| `/escalations` | `escalations` | `createdAt` descending, escalation ID descending |
| `/admin/season-windows` | `windows` | window ID ascending |

ID/code comparisons use PostgreSQL's binary `C` collation. Relational timestamp
keys use the same millisecond precision as the HTTP projection, with the ID as
the tie-breaker, including when stored timestamps have finer precision.
Each request reads one repeatable-read snapshot; pages across requests reflect
live changes rather than a frozen multi-request export. Refresh from the first
page when a desk changes.

## Scope and summaries

- Voucher `tab=available|used|expired|all` filtering occurs before the page;
  `expired` continues to include void vouchers. `serverTime`, expiry projection
  and the SQL status gate share the same request time.
- `/users` retains the membership `role` filter, `foundingTester` filter and
  selected-role profile projection. The acting identity is loaded separately
  when necessary and is not added to the returned page.
- `totalRequests` on the reschedule queue covers the full permitted supplier
  scope, across statuses, as before; it is independent of the page/status filter.
  Historical requests stay with their original requesting shop after recovery;
  retained order removals are excluded from both the count and page. Transactional
  per-shop/global counters now serve this total; it no longer counts order history
  on each page. Review-only and ordinary scopes retain their previous totals.
- Season `banners` remains the full currently active banner subset, independently
  of the window page. Past windows remain available through the admin page.
- `/ops/shops/performance` still limits **shops**. On the separate
  `/ops/shops/:id/performance` detail, the shared event cursor limits `events`;
  `notices` and `warnings` contain only their matching subset of those events.
  Either subset may be empty while `nextCursor` is non-null. Counts, on-time
  totals, roster-review status and current top-pick demotion remain full summary
  values. SQL aggregates current/incident windows, including retroactive no-fault
  and scheduling exemptions; only selected events and their evidence are hydrated.
- `/admin/promotions` uses `section=claims|invites` when paging; it defaults to
  `claims`. The selected nested array is paged and the other nested array is empty.
  Keep separate cursors for the two sections. Invalid sections return
  `400 invalid_section` on paged requests. Settings, version, budget, slot counts,
  used/expired totals and issued-invite total cover the whole launch population.
- `/admin/shop-rankings` retains the complete categories, global `rankedCount`,
  per-shop scores and absolute `position`. PostgreSQL calculates compact global
  star totals; JavaScript retains the existing rounding and name/tie ordering.
  The rank cursor seeks by score/count/quality/name/supplier facts, not an offset.
  Only selected shops hydrate finished-order clock inputs and category prices.
- The mixed order/basket/issue/credit pages retain existing party, membership,
  selected-role, review-data, file and financial projections. Balance is always
  the account's full current balance, independently of the ledger page. Staff
  order packed-arrival counts still cover their full reporting scope. Order
  visibility probes hydrate only bounded access/hold facts before the final page.
- Review-only Operations selection and ordinary review-data visibility are
  applied before the keyset limit. Order removals remain excluded.
- Supplier access to `/supplier-services`, and client access to
  `/refund-requests`, retain their existing ownership scope when opting in.

## Dashboard adoption and remaining contracts

Dashboard consumers can opt in independently: staff profiles/roles/invitations,
voucher campaigns and the account voucher lookup, hub escalation/unclaimed desks,
supplier lapse detail and service-line directory, shop hours/performance roster,
deadline request/refund queues, Roles directory, claims/escalations, and the season
editor. Keep the current page plus cursor in screen state; stop when it is `null`.
Do not infer a total from the current page's length. This API release does not
change dashboard code or turn on default pagination for older builds.

The Promotions claims/invites tabs, shop rankings, shop performance history,
shared Orders, basket/payment history, issue lists and credit ledger screens can
now adopt these contracts. They must keep their current summary fields and
separate list state; fetching a page must not replace a total with its row count.
This release changes API contracts only and does not update dashboard or apps.
`/ops/riders/locations` remains a complete live map snapshot by design.

## Deployment and verification

Apply `1794190500000_staff_list_pages` before the API release. Its page/filter
indexes use individual concurrent builds; use the existing
[interrupted-build recovery](DEPLOYMENT.md#targeted-read-indexes-and-interrupted-builds).
Apply `1794217000000_reschedule_request_counts`,
`1794217010000_mixed_list_pages`, `1794217020000_aggregate_page_indexes` and
`1794217030000_colour_worker_reads` before the finish-slice release. Count
initialization takes the domain lock and brief order/removal table locks;
insert/update transition tables aggregate deltas once per statement. Concurrent
indexes on existing tables follow the same recovery procedure. Basket page
indexes have a redundant length predicate supplied only by opted-in queries,
so legacy unpaged enumeration keeps its original query plans.
No schema work runs at boot. HTTP mutations, advisory locks, save, audit and
notification boundaries are unchanged.

On an isolated migrated test database, run:

```sh
TEST_DATABASE_URL=postgresql://…/gridgo_task_test npm test -- --maxWorkers=2 tests/staff-list-pages-postgres.test.js
DATABASE_URL=postgresql://…/gridgo_task_test PERF_BASE_ROWS=10000 PERF_SAMPLES=5 node scripts/benchmark-staff-list-pages.mjs
```

The unpaged differential matrix loads the actual pre-pagination dev source from
Git, keeping its targeted dispatcher enabled, and compares 250 HTTP answers.
It uses the recorded baseline commit by default; set `STAFF_LIST_DEV_REF` to
another available pre-pagination dev commit when needed. A shallow checkout
without that object skips the historical-source matrix explicitly; the CI test
job retains Git history so this matrix runs there. The wallet
regression always runs: it seeds 20,000 mixed-status vouchers, compares dev's
selective wallet query before/after the page indexes, and checks SQL and HTTP
enumeration with both sequential and indexed plans. Where historical source is
available it also compares the complete dev HTTP answer before the migration
against the current answer after it. The full-store oracle is separate: it does
not define the enumeration of routes that already had targeted readers. Its
forced-index lapse comparison canonicalizes only equal-time ties, preserving
timestamp order and every row/field; the actual-dev matrix checks native order.

The destructive benchmark grows matching list parents and unrelated notification,
audit and location history from 10,000 to 100,000 rows per grown table. It vacuums/analyzes each completed bulk load, then reports
API-own request-log timings, first/deep parent query plans and SQL row/query budgets, and
asserts that page hydration budgets remain equal at both scales. Performance
histories for any one selected shop are held constant in that earlier benchmark.
The finish-slice benchmark below also grows old performance history and launch
claims/invites, with distinct synthetic beneficiaries and complete two-group
basket money snapshots. It exercises first/deep cursors and asserts equal
query/transfer budgets across 10,000/100,000 history rows and 1,000/10,000
complete baskets (configurable with `PERF_BASKET_BASE_ROWS`). Aggregate computation
can still depend on the relevant launch/league/incident population; unrelated
inbox, audit and ping growth is never hydrated. Reschedule totals use only their
maintained scope rows. Local synthetic
results do not establish the production timing target.


Finish-slice verification:

```sh
TEST_DATABASE_URL=postgresql://…/gridgo_task_test npm test -- --maxWorkers=2 tests/finish-pages-postgres.test.js tests/finish-counts-migration.test.js tests/finish-page-index-migration.test.js tests/upload-intake-parity.test.js tests/upload-colour-worker-parity.test.js
DATABASE_URL=postgresql://…/gridgo_task_test PERF_BASE_ROWS=10000 PERF_SAMPLES=5 node scripts/benchmark-finish-pages.mjs
```

The new unpaged matrix compares 90 HTTP bodies against actual pre-change dev
source. Separate cursor tests compare concatenated projected rows and all
summaries with the unpaged API, including Unicode reasons, future no-fault facts,
sub-millisecond timestamps and exact 30-day/7-day performance boundaries.
Counters are also tested against populated migration input, bulk DML, cascades,
truncates and rollback. Index tests prove later writers proceed during a build,
interrupted builds recover, and 20,000 basket rows retain legacy enumeration.
