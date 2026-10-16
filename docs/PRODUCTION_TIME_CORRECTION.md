# Reviewed production-time recovery (39853344)

This is a separate operator procedure, not a deployment step. The implementation
worker does not query or change production or development databases. Apply the
forward minute migration normally; never edit or rerun the old day migration.
Test this procedure first against an isolated restored copy of the target data.

## Evidence and scope

Supply the verified **actual deployment instant** with `--deployed-at` in ISO
format including timezone. Do not use a migration filename timestamp as the
cutoff. `DATABASE_URL` selects the target; the script defaults to a repeatable-read,
read-only dry run and never creates schema or restores backups itself.

If available, restore the pre-deploy backup into a separate isolated PostgreSQL
database and set `BACKUP_DATABASE_URL` to that copy. Supply its verified capture
time with `--backup-at`; it must precede deployment. The backup is read only,
using its original hour columns and approved catalogue snapshots. Do not migrate
the backup before reading it: doing so would destroy the original evidence.
No backup contents are imported wholesale.

Without backup evidence for a listing maximum, use the newest order line created
strictly before deployment for that catalogue item (creation time descending,
ID descending for ties). This does not establish a service default, rush tier,
minimum, starter or individual speed tier. Those unresolved fields are reported
as `missing_evidence`, not inferred from another duration. Inherited listings
stay inherited; recovering their service defaults requires backup evidence.
The order-line fallback can still establish that listing's historical order time.

A recovery candidate must still have its migrated day value. Its original time
must round to the current duration under the shop calendar. Rows changed after
deployment, incompatible calendars/conversions, unresolved minimum bounds and
missing evidence are listed for decision and are not applied. Newer creations
and minute-based writes are not treated as migration casualties. Approved
snapshot durations are handled separately, with separate evidence and audits;
prices, tier IDs, listing review and visibility holds do not change.

## Review and apply

Use a restrictive umask: reports include order references, shop names, client
account types and internal evidence. Example shell inputs below are operator
variables, not defaults:

```sh
umask 077
# Set DATABASE_URL to the isolated target copy first.
# Optionally set BACKUP_DATABASE_URL to an unmigrated restored pre-deploy backup.
npm run production:correct -- --deployed-at "$DEPLOYED_AT" \
  --backup-at "$BACKUP_CAPTURED_AT" > correction-preview.txt
```

Omit `--backup-at` and unset `BACKUP_DATABASE_URL` when no backup is available.
For machine-readable JSON without npm's command banner, use:

```sh
node scripts/correct-production-time.mjs --deployed-at "$DEPLOYED_AT" > correction-preview.json
```

The report lists source duration candidates and potentially affected post-deploy
orders. Each order includes reference, shop, client account type, open status,
old shop/client dates, corrected line/job minutes, and a `basisHash`. Finished
orders are listed only. Dates remain null until reviewed: the historical shop
calendar, queue and capacity calculation were not snapshotted, so subtracting
hours or replaying checkout using today's state cannot establish a safe promise.

For each eligible open order, Operations reviews the shop's schedule, closures,
capacity, queue, artwork/review timing, platform allowance and existing promises.
Create a JSON array in a restricted manifest file:

```json
[
  {
    "orderId": "ord_example",
    "expectedBasisHash": "copy the current report basisHash",
    "readyBy": "2026-10-08T02:00:00.000Z",
    "promiseBy": "2026-10-08T03:00:00.000Z",
    "schedulingBasis": "Record the verified calendar, queue, capacity, start and allowance calculation and evidence reference.",
    "reviewedBy": "operator identifier",
    "reviewedAt": "2026-10-14T05:00:00.000Z",
    "noScheduledOrStartedConflict": true
  }
]
```

These dates are illustrative. The script validates the reviewed shape and checks
for stale state; it does not certify the human's scheduling calculation. The
corrected shop date must precede the original but not order creation. The client
date must be at or after the corrected shop date and no later than its original.
The hash covers the order, immutable lines, jobs, recovered duration evidence,
shop calendar, shop job queue, service capacities and settings. Any change
requires a fresh report and review. Started work (including timeline or released
payout evidence), scheduled jobs, reschedules, shop recovery and refund holds
are conservatively reported as `scheduling_conflict`; this script cannot apply
a correction to them. Resolve those individually through a separate reviewed
Operations decision, not by editing the script's guards.

```sh
node scripts/correct-production-time.mjs --deployed-at "$DEPLOYED_AT" \
  --manifest /restricted/correction-manifest.json > correction-reviewed.json
# After reviewing the report against the isolated copy and approving the target:
node scripts/correct-production-time.mjs --deployed-at "$DEPLOYED_AT" \
  --manifest /restricted/correction-manifest.json --apply > correction-applied.json
```

Include the same `BACKUP_DATABASE_URL` / `--backup-at` inputs on every run that
uses backup evidence. An apply run changes only `ready` entries, under the domain
transaction lock. Other entries remain listed and unchanged. Exit 2 means there
are unresolved entries, **including after a partial apply**; exit 0 means no
unresolved entries, and exit 1 means validation/database failure. Never treat a
nonzero exit as proof that nothing committed: read the report and audits.

Duration-only apply is allowed without an order manifest. It changes the live
catalogue; generate a fresh order report afterward because service changes can
invalidate prior manifest hashes. The same audit correction key can apply only
once even if the live duration is edited later. Orders with a correction marker
are also never corrected twice. Rerunning is safe but is not an undo operation.

## Atomic records, privacy and follow-up

Catalogue durations, jobs, order dates, audit rows and staff inbox/outbox rows
commit together. Original order line snapshots, invoice snapshots, money and
payout stages remain unchanged. `orders.data.productionTimeCorrection` retains
original dates, original/corrected line and job times, scheduling review, reason,
time and evidence beside those snapshots. The client's `promiseBy` (and legacy
`promisedDate` when present) and the shop's `readyBy` change together. Job minutes
change so the queue stops counting the inflated duration.

Every applied correction writes `production_time.correct_39853344` audit rows
and durable Operations/Super Admin inbox notices. Realtime invalidations enqueue
in the same transaction; the running API delivers queued pushes through its
outbox retry worker. Ordinary order projections remove the entire correction
object for **all** roles. The restricted report/audit is the Operations evidence.
Corrected orders remain warning-only for lateness; the deductions gate and payout
release check cannot deduct or block on a correction-related penalty assessment.
Other payout holds remain in force.

Archive the preview, reviewed manifest and applied report. Operations uses the
old/corrected dates to contact affected clients. Finished, unresolved, already
started and scheduled orders require explicit follow-up; shipping the server
change does not itself complete that operational recovery or the app releases.
