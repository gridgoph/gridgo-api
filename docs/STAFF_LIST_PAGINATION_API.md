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
  retained order removals are excluded from both the count and page.
- Season `banners` remains the full currently active banner subset, independently
  of the window page. Past windows remain available through the admin page.
- The performance page limits **shops**, retaining each selected shop's complete
  event/history and metric inputs. It does not page events, notices or warnings.
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

The reviewed slice leaves `/admin/promotions`' two independent nested lists,
`/admin/shop-rankings` and `/ops/shops/:id/performance` histories for follow-up
contracts that retain their full-population budgets/ranks/incident windows.
Mixed party/staff `/orders`, `/baskets`, `/issues` and `/credits/balance` are also
follow-ups. `/ops/riders/locations` remains a complete live map snapshot by design.
Existing paginated desks keep their current contracts.

## Deployment and verification

Apply `1794190500000_staff_list_pages` before the API release. Its page/filter
indexes use individual concurrent builds; use the existing
[interrupted-build recovery](DEPLOYMENT.md#targeted-read-indexes-and-interrupted-builds).
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
histories for any one selected shop are held constant; exact reschedule totals
still require a database count of their complete matching scope. The exact
supplier-filtered `totalRequests` count is an explicit performance exception in
this slice; a maintained counting table is follow-up work. Local synthetic
results do not establish the production timing target.
