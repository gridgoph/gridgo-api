# Development sample retirement (#133)

The ordinary production one-shot runs `npm run seed`, which has been
reference-only since the PostgreSQL cutover. The production compose previously
also offered a manual `seed-dev` service using the same database and identity
credentials. `GRIDGO_SEED_ORDERS=0` prevented invented orders but still wrote
sample accounts, approved services, listings, and sample photos. The development
seed had no environment gate. That is the repository-supported contamination
path; repository history alone cannot prove which operator command was executed.

The manual production service is removed. Both production one-shots explicitly
declare production mode. Every development seed entry point now requires
`NODE_ENV=development` or `test` and a development Clerk `sk_test_` key, including
calls with an injected identity backend. Refusal precedes database connection,
reference seeding, identity lookup, storage setup, and every write. Local compose
declares development mode for migration and seeding. `npm run seed` remains reference-only.

## Fixed scope and preflight

Migration `1791158400000_retire_development_shops.js` selects four exact
`md5(users.id)` fingerprints. These identify the seed's 8/6/3/1-listing group,
totalling the issue's 18 listings, including the two category-exclusive shops.
The fifth seeded identity is excluded. The separate shop marked as a test is
also excluded until its owner confirms. There is no name, email, photo, prefix,
or broad test-account search in the migration.

Firstmate must verify the identity mapping and history on production before
promotion. If any target is missing, unexpectedly mapped, privileged, or has any
order/payment/payout history, stop promotion for an operator decision; do not
substitute another account. The exact-ID match intentionally refuses to guess
if development seeding reused a pre-existing identity instead of its seeded ID.

Run this read-only query using the production operator's existing database
connection. Counts include all order states and both current and legacy
assignments; no attempt is made to distinguish real from sample history.

```sql
WITH targets(fingerprint, expected_listings) AS (VALUES
  ('d6b92139ce4bfacd39fef11157849025', 8),
  ('1c7445d59be791ec17901e865e2765d0', 6),
  ('fccced1631ee734cbff5154a6c191729', 3),
  ('ead969007167aa27e5f5a0808810df4e', 1)
)
SELECT t.fingerprint, u.id, u.account_status, t.expected_listings,
  (SELECT count(*) FROM supplier_catalog_items i WHERE i.supplier_id = u.id) AS listings,
  (SELECT count(*) FROM user_role_memberships m
    WHERE m.user_id = u.id AND m.role IN ('ops_admin', 'super_admin')) AS privileged_memberships,
  (SELECT count(*) FROM supplier_services s WHERE s.supplier_id = u.id AND s.state = 'live') AS live_services,
  a.status AS supplier_approval,
  (SELECT count(*) FROM orders o WHERE
    u.id IN (o.supplier_id, o.client_id, o.rider_id)
    OR jsonb_path_exists(o.data, '$.**.supplierId ? (@ == $id)', jsonb_build_object('id', u.id))
    OR EXISTS (SELECT 1 FROM order_jobs j WHERE j.order_id = o.id
      AND u.id IN (j.supplier_id, j.rider_id))) AS related_orders,
  (SELECT count(*) FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE
    u.id IN (o.supplier_id, o.client_id, o.rider_id)
    OR jsonb_path_exists(o.data, '$.**.supplierId ? (@ == $id)', jsonb_build_object('id', u.id))
    OR EXISTS (SELECT 1 FROM order_jobs j WHERE j.order_id = o.id
      AND u.id IN (j.supplier_id, j.rider_id))) AS related_payments,
  (SELECT count(*) FROM payout_milestones p JOIN orders o ON o.id = p.order_id WHERE
    u.id IN (o.supplier_id, o.client_id, o.rider_id)
    OR jsonb_path_exists(o.data, '$.**.supplierId ? (@ == $id)', jsonb_build_object('id', u.id))
    OR EXISTS (SELECT 1 FROM order_jobs j WHERE j.order_id = o.id
      AND u.id IN (j.supplier_id, j.rider_id))) AS related_milestone_payouts,
  (SELECT count(*) FROM refund_supplier_payouts p WHERE p.supplier_id = u.id) AS settlement_payouts
FROM targets t
LEFT JOIN users u ON md5(u.id) = t.fingerprint
LEFT JOIN approval_cases a ON a.user_id = u.id AND a.kind = 'supplier'
ORDER BY t.fingerprint;
```

## What deployment does

Retirement executes only under explicit `NODE_ENV=production`; development,
test, and undeclared environments register the migration without retiring their
fixtures. The production image already declares production mode, and production
compose explicitly pins it on the migration service. Confirm this mode on the
server before promotion, including when invoking migrations from a host checkout.

The forward migration runs in the migration transaction and takes the same
transaction-scoped advisory lock as HTTP domain mutations. For each fixed target:

1. Missing identities, identities with any historical order association (as
   client, supplier, rider, legacy job party, or nested supplier snapshot), and
   explicit settlement-payout recipients are skipped. All statuses count,
   including completed/cancelled orders and unpaid orders. Ordinary payments
   and milestone payouts cannot exist without their parent order.
2. Already-inactive accounts are preserved. Incomplete supplier identities and
   identities that now hold an administrator membership are skipped.
3. Eligible active accounts become `suspended`, with an issue reason, timestamp,
   and migration actor. The supplier approval case becomes `suspended`; legacy
   supplier/rider verification standing is synchronized. Only live service lines
   become suspended, tagged with the approval case and previous state so an
   audited restoration can distinguish them from independently suspended lines.
4. An immutable system approval event, suspension audit, owner inbox row, and
   inbox row for each current Operations/Super Admin membership commit together.
   No external messages are sent by the migration.

Nothing is deleted, including accounts, memberships, listings, photos, files,
object-storage bytes, orders, payments, and payouts. Other account suspension
reasons remain unchanged. Re-execution on the same state does not duplicate
events or change timestamps. The down migration intentionally does not restore
accounts; restoration belongs to audited administrator actions.

Every outcome writes a PostgreSQL server log entry (`RAISE LOG`) and a client
notice, keyed only by fingerprint. The migration runner may not print notices;
inspect `docker logs gridgo-postgres` for `demo retirement`. A skip is a request
for review, never authorization to retire that account later automatically.

## Verify after deployment

- Confirm the updated server compose offers only the reference seed; CI never
  installs compose. An old manual service is still blocked by the new image's
  environment/identity guard.
- Repeat the preflight query: normally four accounts are suspended, their
  supplier approvals are suspended, and their live-service counts are zero.
  Listing counts remain unchanged. Check every logged skip against the preflight.
- Count the committed retirements:

  ```sql
  SELECT count(*) AS retired_accounts FROM audit_log
  WHERE id LIKE 'aud_demo_retirement_%' AND action = 'user.account_suspend';
  ```

- Check the owner and both administrator inboxes, and the suspension events and
  service case tags. With an authenticated client, verify the supplier catalogue
  and `/me/matches` exclude the retired accounts; catalogue responses must retain
  real shops. Documents & Publications and Specialized & Prototyping may be empty.
- Verify the separate test shop and fifth seeded identity retain their prior
  account, approval, service, and listing states. The test shop awaits owner
  confirmation and is not part of this retirement count.
- Record the actual retired/skipped counts on issue #133 after production
  verification. A merged PR is not evidence that production retirement happened.
