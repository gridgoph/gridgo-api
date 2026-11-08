import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, loadStore, saveStore } from '../src/postgres-store.js';
import { publicOrderFor } from '../src/operational-model.js';
import { setupOperationsReads } from './fixtures/operations-reads.js';
import { AT } from './fixtures/reschedule.js';

const skip = !process.env.DATABASE_URL;
const histories = ['credit_ledger', 'voucher_reservations', 'voucher_redemptions', 'voucher_ledger'];
const target = 'history_target';

async function insertHistory(db, voucher, { count, prefix, related }) {
  const ref = "($1::text || CASE WHEN $2::boolean THEN '' ELSE i::text END)";
  // All four legacy JSON locations remain searchable. Unrelated records have
  // distinct order references, rather than one repeated artificial value.
  const data = `CASE i % 4
    WHEN 0 THEN jsonb_build_object('orderId', ${ref})
    WHEN 1 THEN jsonb_build_object('orderIds', jsonb_build_array(${ref}))
    WHEN 2 THEN jsonb_build_object('data', jsonb_build_object('orderId', ${ref}))
    ELSE jsonb_build_object('data', jsonb_build_object('orderIds', jsonb_build_array(${ref}))) END`;
  const args = [related ? target : 'unrelated_', related, prefix, count, voucher.id, voucher.campaignId, AT];
  await db.query(`INSERT INTO credit_ledger (id,user_id,amount_minor,balance_after_minor,created_at,position,data)
    SELECT $3::text || '_credit_' || i, 'client', 0, 0, $7::timestamptz, i, ${data}
    FROM generate_series(1,$4::integer) i WHERE $5::text IS NOT NULL AND $6::text IS NOT NULL`, args);
  await db.query(`INSERT INTO voucher_reservations (id,voucher_id,client_id,cart_id,status,expires_at,created_at,data)
    SELECT $3::text || '_reservation_' || i, $5::text, 'client', 'history_cart', 'consumed',
      $7::timestamptz, $7::timestamptz, ${data}
    FROM generate_series(1,$4::integer) i WHERE $6::text IS NOT NULL`, args);
  await db.query(`INSERT INTO voucher_redemptions (id,voucher_id,reservation_id,client_id,amount_minor,status,created_at,data)
    SELECT $3::text || '_redemption_' || i, $5::text, $3::text || '_reservation_' || i, 'client', 1, 'restored',
      $7::timestamptz, ${data}
    FROM generate_series(1,$4::integer) i WHERE $6::text IS NOT NULL`, args);
  await db.query(`INSERT INTO voucher_ledger (id,voucher_id,campaign_id,client_id,kind,amount_minor,at,data)
    SELECT $3::text || '_ledger_' || i, $5::text, $6::text, 'client', 'restored', 0, $7::timestamptz, ${data}
    FROM generate_series(1,$4::integer) i`, args);
}

async function sample(db) {
  const queries = [];
  const scoped = await loadHotReadStore({ ...db, query: async (sql, values) => {
    const result = await db.query(sql, values);
    const table = histories.find(table => sql.includes(`FROM ${table} `));
    if (table) queries.push({ table, sql, values });
    return result;
  } }, 'clerk_admin', `/orders/${target}`);
  return { scoped, queries };
}

function nodes(plan) { return [plan, ...(plan.Plans || []).flatMap(nodes)]; }

test('Super Admin detail financial-history work stays indexed after 100k unrelated rows per table', { skip }, async t => {
  const db = createDatabase(process.env); t.after(() => db.close());
  const store = await setupOperationsReads(db);
  const order = { ...structuredClone(store.orders[0]), id: target, supplierId: null };
  order.payments.initial.status = 'not_submitted';
  store.orders.push(order);
  store.credits.client = { balanceMinor: 0, ledger: [] };
  store.carts.push({ id: 'history_cart', clientId: 'client', state: 'draft', version: 1, serviceLevel: 'standard',
    fulfillmentMode: 'delivery', createdAt: AT, updatedAt: AT });
  await db.transaction(() => saveStore(db, store));
  const voucher = store.vouchers[0];
  await insertHistory(db, voucher, { count: 4, prefix: 'related', related: true });
  const before = await sample(db);
  assert.equal(before.queries.length, 4);
  const full = await loadStore(db);
  assert.deepEqual(publicOrderFor(full.orders.find(row => row.id === target), { role: 'super_admin' }, full).removal,
    { allowed: false, blockedReason: 'financial_activity' });
  await insertHistory(db, voucher, { count: 100_000, prefix: 'growth', related: false });
  // Refresh statistics and flush GIN's bounded pending list after bulk fixture
  // loading, so the measured plan reflects the steady-state history index.
  for (const table of histories) await db.query(`VACUUM ANALYZE ${table}`);
  const after = await sample(db);
  assert.equal(after.queries.length, 4);
  for (const graph of [before.scoped, after.scoped]) {
    const rows = [graph.credits.client.ledger, graph.voucherReservations, graph.voucherRedemptions, graph.voucherLedger];
    assert.deepEqual(rows.map(rows => rows.length), [4, 4, 4, 4], 'all four reference shapes, no unrelated history');
    assert.ok(rows.flat().every(row => row.id.startsWith('related_')));
    assert.deepEqual(publicOrderFor(graph.orders[0], { role: 'super_admin' }, graph).removal,
      { allowed: false, blockedReason: 'financial_activity' });
  }
  for (const { table, sql, values } of after.queries) {
    const explained = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN'][0];
    const plan = explained.Plan;
    const scans = nodes(plan);
    assert.ok(scans.some(node => node['Index Name'] === `${table}_order_refs_idx`), `${table}: expected order-reference index`);
    assert.ok(!scans.some(node => node['Node Type'] === 'Seq Scan'), `${table}: must not scan unrelated history`);
    assert.equal(plan['Actual Rows'], 4, table);
    const buffers = (plan['Shared Hit Blocks'] || 0) + (plan['Shared Read Blocks'] || 0);
    assert.ok(buffers <= 128, `${table}: ${buffers} buffers for four related rows`);
    t.diagnostic(`${table}: ${plan['Node Type']}, ${buffers} shared buffers, ${explained['Execution Time']} ms`);
  }
});
