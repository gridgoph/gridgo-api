# Targeted reads for issue 307

This is an incremental replacement of the compatibility store reader. Domain
mutations still use `loadStore` and `saveStore` under their existing transaction
and advisory lock. Scoped stores have no write baseline and `saveStore` rejects
them. Read graphs use repeatable-read snapshots and the existing row decoders
and authorization/projection functions.

## Converted reads

| Consumer | Rows loaded |
| --- | --- |
| `GET /notifications` | Indexed 100-row candidate batches until the requested visible page is full; separately indexed watermark, including deleted notices; related current visibility facts only |
| Resumed `/notifications/stream` | The resume row and later caller-owned rows; missing and foreign cursors retain 409/403 behavior |
| `/settings` | Singleton settings, caller identity/memberships/cases, the configured QR file |
| `/taxonomy`, `/zones`, `/catalog` | The requested reference collection and caller authorization facts |
| `/auth/me/{ops,admin,supplier,rider}` | Caller identity, profiles, memberships/cases/documents; own supplier readiness inputs where needed; one indexed staff-session audit row |
| `/auth/me` | Caller identity graph; unchanged Clerk profile copies avoid a write transaction/full reload |
| Client `/me`, `/auth/me/client`, `/auth/me` bootstrap | Caller progress, profiles, organization and reward voucher; unresolved invitation identity/attribution facts; no inbox, audit, ping or push history |
| `/ops/product-type-requests` | Existing 51-row cursor/status query and supplier review marks |
| `/ops/catalog-reviews` | Existing 51-row review cursor/status query and those listings' projection/blocker inputs |
| `/ops/colour-price-checks` | Draft-cart lines referencing colour-priced current/approved listings and their quote inputs/artwork metadata |
| `/ops/shop-failures` | Orders containing failure events and their participants; preserves the existing unpaginated response |
| Cross-process realtime | Committed notification or invalidated subject, connected recipient, and current visibility facts; reconnect loads connected identities only |
| Push outbox | Claimed batch (at most 25), its notifications, current recipients/memberships, referenced orders/holds, active rider trips, claimed devices/subscriptions, season windows |

Web Push enqueue reads subscriptions for the new notifications' recipients.
Idle colour rendering and shop-acceptance sweeps use indexed candidate probes
before the complete mutation graph. No cache is introduced: reference/settings
writes are visible on the next snapshot across API processes without a cache
invalidation protocol.

Inbox filtering remains in `notificationVisible`. Hidden rows do not consume a
page slot; a page may need multiple candidate batches when historical notices
are no longer visible. Ordering and the deleted-row watermark stay compatible.
Initial SSE connections retain the existing complete caller-owned replay.

## Validation and reproducible benchmark

Run migrations and the suite only against private disposable services:

```sh
TEST_DATABASE_URL=postgresql://.../gridgo_perf_test npm test -- --maxWorkers=2
DATABASE_URL=postgresql://.../gridgo_perf_bench_test \
  MINIO_ENDPOINT=http://127.0.0.1:<private-port> \
  MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... \
  node scripts/benchmark-targeted-reads.mjs
```

The benchmark destroys its **test** database. It creates 10,000, then 100,000
rows each in notifications, audit, location history, and delivered push history.
It signs local RSA Clerk tokens and uses a local Clerk stub; it never connects
to production or Clerk. It records ten measured requests per route/scale using
the API's own request log after warm-up, plus database rows returned by the
complete reader and scoped readers. The default uses the current server.
`PERF_SERVER_REF=<base-commit>` loads the older application and its `src` modules
from Git without another checkout (requires Node with `module.registerHooks`,
e.g. Node 24). Row-count instrumentation always uses the working-tree readers;
the JSON records both references explicitly.
`PERF_LABEL`, `PERF_SAMPLES`, `PERF_BASE_ROWS` and `PERF_PRINT_LOGS=1` customize
reporting. The child API binds an available loopback port and is stopped by its
own child PID.

The PostgreSQL tests compare scoped results with the complete reader, including
role filtering, hidden-row refill, deleted watermarks, cursor errors, revoked
membership, review-only queues, colour quotes, signed realtime delivery, and
outbox ownership. They assert tenfold unrelated history does not increase rows
returned by converted reads. The complete existing suite remains required. For this delivery, `npm test -- --maxWorkers=2`
passed all **1,912 tests** with zero failures/skips; the focused PostgreSQL run
passed all **14 checks**.

See [deployment query statistics](DEPLOYMENT.md#postgresql-query-statistics)
for `pg_stat_statements` installation. The server compose change requires an
operator maintenance window; CI does not install that file.

## Local measurements (23 October 2026)

Ten measured API-log samples per route after warm-up, on private PostgreSQL 17
and MinIO. The full suite was running on the same machine during measurements;
these timings are illustrative server measurements, not production acceptance.
History grew from 10,000 to 100,000 rows in each of four tables.

| Route | Before 1× median | After 1× median | Before 10× median | After 10× median | After 10× p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/notifications` | 59 ms | 7 ms | 966 ms | 10 ms | 19 ms |
| `/settings` | 337 ms | 6 ms | 6213 ms | 7 ms | 10 ms |
| `/taxonomy` | 314 ms | 5 ms | 4936 ms | 6 ms | 10 ms |
| `/auth/me/ops` | 336 ms | 6 ms | 5254 ms | 7 ms | 12 ms |
| `/auth/me` | 369 ms | 8 ms | 4972 ms | 10 ms | 16 ms |
| `/ops/product-type-requests` | 344 ms | 5 ms | 5388 ms | 6 ms | 11 ms |
| `/ops/catalog-reviews` | 344 ms | 9 ms | 5011 ms | 11 ms | 21 ms |
| `/ops/shop-failures` | 337 ms | 5 ms | 5005 ms | 6 ms | 10 ms |
| `/ops/colour-price-checks` | 375 ms | 11 ms | 5700 ms | 13 ms | 25 ms |

Rows transferred by the readers (1× → 10×): complete store **30,300 → 300,300**,
settings **4 → 4**, inbox **106 → 106**, push batch **7 → 7**. Query counts remain
106, 7, 10, and 10 respectively. The inbox count includes caller/visibility rows;
the notification candidate query returns at most 100 rows per batch.

`EXPLAIN (ANALYZE, BUFFERS)` at 100,000 notifications used
`notifications_inbox_page_idx` (100 rows, 0.227 ms) and
`notifications_watermark_idx` (one row, 0.093 ms).

## Client bootstrap follow-up (29 October 2026)

Client bootstrap still enters the same domain transaction and advisory lock.
`loadClientBootstrapStore` reads only the current client's progress and public
reward facts plus unresolved global invitations and their matching/attribution
facts. The existing invitation policies run on a disposable copy. The existing
reward entry guards decide whether reconciliation can change anything. When it
can, the handler reloads the complete writable graph and executes the original
reconciliation/save path inside that same lock. A no-op returns the scoped
projection without reading historical tables. Scoped graphs still cannot be
saved. No cache, reward rule, response shape or transaction boundary changes.

The new forward migration adds indexes for normalized identity lookup,
unresolved invitations, attribution and active voucher reservations. Unusual
Unicode/whitespace emails remain candidates for JavaScript's existing matching
policy; SQL normalization cannot silently change attribution.

Measured against the pre-change base `0206e28`, using private PostgreSQL 17 and
MinIO, available loopback API ports and a local Clerk stub. Five measured
API-log samples per route/scale after warm-up; histories contain 10,000 then
100,000 rows **each** in notifications, audit, location pings and delivered push
outbox. This repeats the first delivery's synthetic volume profile; it is an
approximation, not a copy or inventory of current production data. The full
suite was not running during these measurements.

| Client route | Before 1× median | After 1× median | Before 10× median | After 10× median | After 10× p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/me` | 554 ms | 8 ms | 6109 ms | 10 ms | 11 ms |
| `/auth/me/client` | 524 ms | 9 ms | 5224 ms | 8 ms | 15 ms |
| `/auth/me` | 511 ms | 10 ms | 5473 ms | 10 ms | 11 ms |

The complete reader transfers **30,300 → 300,300** rows (111 queries). Client
bootstrap transfers **8 → 8** rows (30 queries), realtime identities **5 → 5**,
inbox **106 → 106**, settings **4 → 4**, and a claimed push batch **7 → 7**.
Other already-converted hot paths measured 3–9 ms median at 10× history.
With 10,000 unrelated identities, `EXPLAIN (ANALYZE, BUFFERS)` for the invitation
identity query used a bitmap combination of the primary key, normalized-email
index and unusual-email partial index (one returned row, 0.038 ms execution).
The benchmark reports `/auth/me?client` as the client-token sample label; the
route is the same `/auth/me` and the query is ignored by the handler.

`tests/client-bootstrap-reads-postgres.test.js` compares actual HTTP responses
against the full-store reader for all three changed routes, including every
existing role, selected-role failures, unmapped/anonymous sessions, account
suspension, business/organization profiles, multiple memberships and awarded
vouchers. It compares progress and reconciliation decisions against full-store
facts, tests Unicode invitation matching, and asserts constant rows/projections
under unrelated history growth. The test-only module hook selects the complete
reader and freezes both clocks; the API has no runtime legacy-reader switch.
The final complete `npm test -- --maxWorkers=2` run passed **2,031 tests** with
zero failures/skips on private PostgreSQL 17. The optional authentication
timestamp test retries authentication while polling, since its existing
best-effort write can skip a concurrent bootstrap foreign-key lock; runtime
timestamp/locking behaviour is unchanged.

## Remaining work

Issue 307 remains open. This delivery preserves response contracts and does not
claim production acceptance or complete removal of `loadStore`.

- Main request fallback: `/orders` and detail/job projections,
  matching/carts/catalogue operations, file
  routes, remaining operational reads and unrecognized paths. Order projections
  include cross-order counters, finance/hold graphs and private file access;
  these need dedicated differential tests before scoping.
- Client bootstrap when the scoped probe finds real reconciliation work (new
  invitation matching, cart-step recording or a possible reward), staff's first
  sign-in and changed Clerk identity copies retain the complete mutation path.
  Global unresolved invitation work remains part of bootstrap compatibility.
- Unconditional production penalty/performance and inactivity sweeps, file
  retention/reconciliation, and workers/lifecycle handlers when a candidate
  actually needs a mutation still use the complete store. They need scoped
  writable graphs that retain audit/outbox atomicity.
- Anonymous device registration/unregistration still uses the separate complete
  device registry adapter, rather than individual token queries.
- Initial SSE replay, order lists and shop-failure lists preserve their existing
  unpaginated contracts. Introduce compatible cursor contracts before changing
  default responses. Colour checks still examine all eligible draft candidates
  to preserve the existing first-100 policy.
- Release to dev, then production; measure the converted routes from production
  request logs and check query statistics/returned rows under normal traffic.
  Local synthetic timings cannot prove the production-data under-100-ms gate.

### Remaining compatibility-loader call sites

The following line inventory records the **first delivery** (23 October), before
later route additions; use function names rather than these historical line
numbers to locate the current call sites:

| Purpose | Lines |
| --- | --- |
| Colour, artwork preview, retention factory callbacks | 317, 318, 333, 338 |
| Tester reconciliation; desk/support/legal/deletion events | 386, 486, 498, 531, 557 |
| Device pruning and failed-upload compensation | 598, 616 |
| First staff sign-in audit | 1000 |
| Issue-window, reschedule, performance/penalty, season, organization and inactivity mutation sweeps | 1711, 1734, 1741, 1756, 1767, 1797, 1805 |
| Machine release broadcast and Clerk webhook | 2231, 2348 |
| Main unconverted request fallback | 2366 |
| Changed identity copy and transition-refusal audit | 2422, 2611 |
| Upload completion/rechecks, preview refresh and file operations | 3271, 3299, 3326, 3415, 3447 |
| Artwork link/checkout preparation | 7594, 7604 |
| Active calls, due shop acceptance, hub reminder, voucher, survey and tester-reminder mutations | 7664, 7686, 7702, 7722, 7738, 7753 |

Client `/auth/me` no longer falls back inside `loadHotReadStore`. Real bootstrap
mutations still reload through `refreshFoundingTester`. This inventory identifies
follow-up work; it does not assert that mutation graphs can safely be replaced
by read-only stores.
