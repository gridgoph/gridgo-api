import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { isHotReadPath, loadHotReadStore, saveStore } from '../src/postgres-store.js';
import { instrument } from './fixtures/order-reads.js';
import { parityApiForTest } from './fixtures/read-parity.js';
import { setupOperationsReads } from './fixtures/operations-reads.js';
const skip = !process.env.DATABASE_URL;

// ANY array binds describe membership, not order. Keep every other bind and
// SQL/row-count field strict, and sort copies so instrumentation is unchanged.
function comparableQueries(queries) {
  return queries.map(query => {
    const setParameters = new Set([...query.sql.matchAll(/\bANY\(\$(\d+)::(?:text|jsonb)\[\]\)/g)]
      .map(match => Number(match[1])));
    return { ...query, values: query.values?.map((value, index) =>
      setParameters.has(index + 1) && Array.isArray(value) ? [...value].sort() : value) };
  });
}

test('Operations reads preserve exact HTTP bytes and headers across roles, filters, private evidence and review views', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  const fixture = await setupOperationsReads(database);
  const at = Date.now() + 120000;
  const old = await parityApiForTest(t, true, at), current = await parityApiForTest(t, false, at);
  let compared = 0;
  async function compare(who, path, opts = {}) {
    const a = await old(who, 'GET', path, null, { raw: true, ...opts });
    const b = await current(who, 'GET', path, null, { raw: true, ...opts });
    const context = `${who} ${path} ${JSON.stringify(opts)}`;
    assert.equal(b.status, a.status, context);
    if (a.headers.get('content-type')?.includes('application/json')) assert.deepEqual(JSON.parse(b.body), JSON.parse(a.body), context);
    assert.equal(b.body, a.body, context);
    for (const key of ['content-type', 'cache-control', 'content-disposition', 'x-next-offset']) assert.equal(b.headers.get(key), a.headers.get(key), `${context}: ${key}`);
    compared++;
    return a.headers.get('content-type')?.includes('application/json') ? JSON.parse(b.body) : b.body;
  }
  const paths = ['/dispatch/offers', '/claims', '/claims/claim_a_active', '/claims/missing', '/claims/claim_review',
    '/issues', '/issues/issue_a_active', '/issues/issue_unrelated', '/issues/issue_review', '/issues/review_hidden_claim', '/issues/missing',
    '/escalations', '/users', '/users?role=supplier', '/users?role=rider', '/users?role=client', '/users?foundingTester=true',
    '/users/client', '/users/review_client', '/users/other', '/users/supplier', '/users/review_supplier', '/users/missing', '/users/supplier/verification-documents',
    '/users/missing/verification-documents', '/users/client/verification-documents', '/users/supplier/payout-account',
    '/users/client/payout-account', '/users/missing/payout-account', '/audit', '/audit?action=order.production_override',
    '/orders/a_active/audit', '/orders/missing/audit', '/ops/catalog-items/item_supplier', '/ops/catalog-items/item_replacement', '/ops/catalog-items/item_colour', '/ops/catalog-items/missing'];
  for (const who of [null, 'client', 'other', 'supplier', 'replacement', 'rider', 'ops', 'admin', 'staff', 'test_ops', 'dual', 'suspended']) {
    for (const path of paths) await compare(who, path);
  }
  for (const who of ['ops', 'admin', 'test_ops', 'client', 'supplier']) {
    for (const path of ['/claims', '/issues', '/escalations']) {
      for (const query of ['status=open', 'status=resolved', 'status=invalid', 'status=', 'orderId=a_active', 'orderId=review', 'orderId=missing',
        'orderId=order&status=open', 'includeReviewData=1', 'includeReviewData=0', 'status=%00', 'orderId=%00', 'orderId=review&includeReviewData=1']) {
        await compare(who, `${path}?${query}`);
      }
    }
  }
  for (const who of ['dual', 'ops', 'rider', 'test_ops']) for (const role of ['client', 'supplier', 'rider', 'ops_admin', 'super_admin', 'bad']) {
    for (const path of ['/dispatch/offers', '/claims', '/issues', '/users?role=supplier', '/users/client', '/audit?action=order.production_override', '/ops/catalog-items/item_supplier']) {
      await compare(who, path, { headers: { 'X-Gridgo-Role': role } });
    }
  }
  for (const query of ['role=bad', 'role=', 'role=%00', 'foundingTester=bad', 'foundingTester=false', 'role=client&foundingTester=true']) await compare('ops', `/users?${query}`);
  for (const who of ['ops', 'admin']) for (const query of ['limit=1', 'limit=2&offset=1', 'limit=0', 'offset=-1', 'format=csv&limit=3',
    'format=bad', 'action=order.production_override', 'entityType=file&entityId=verification', 'from=2026-10-01&to=2026-10-31',
    'from=invalid', 'person=ops', 'q=Fixture', 'orderId=review&includeReviewData=1']) {
    await compare(who, `/audit?${query}`); await compare(who, `/orders/a_active/audit?${query}`);
  }
  for (const path of ['/claims/%00', '/issues/%00', '/users/%00', '/ops/catalog-items/%00', '/ops/catalog-items/%E0%A4%A']) await compare('ops', path);
  const offers = await compare('rider', '/dispatch/offers');
  assert.ok(offers.offers.some(row => row.id === 'm_offer')); assert.ok(!offers.offers.some(row => row.id === 'held_offer'));
  assert.equal((await compare('client', '/issues')).issues[0].evidenceSnapshot, undefined);
  // Each independent dispatch hold must be read before deciding visibility.
  for (const patch of [{ shopRecovery: { status: 'ops_review' } },
    { rescheduleRequest: { status: 'declined', resolution: 'operations_required' } },
    { deliveryPin: { change: { status: 'pending_confirmation' } } }]) {
    await database.query('UPDATE orders SET data = data || $1::jsonb WHERE id=\'m_offer\'', [JSON.stringify(patch)]);
    assert.ok(!(await compare('rider', '/dispatch/offers')).offers.some(row => row.id === 'm_offer'));
    assert.ok(!(await compare('ops', '/dispatch/offers')).offers.some(row => row.id === 'm_offer'));
    if (patch.rescheduleRequest) await database.query("UPDATE orders SET data=jsonb_set(data,'{rescheduleRequest,resolution}','\"resolved\"') WHERE id='m_offer'");
    else if (patch.deliveryPin) await database.query("UPDATE orders SET data=jsonb_set(data,'{deliveryPin,change,status}','\"rejected\"') WHERE id='m_offer'");
    else await database.query('UPDATE orders SET data = data - $1 WHERE id=\'m_offer\'', [Object.keys(patch)[0]]);
  }
  await database.query("UPDATE orders SET data=data || jsonb_build_object('operatingClock',$1::jsonb) WHERE id='m_offer'",
    [JSON.stringify({ version: 1, settingsVersion: 1, schedule: fixture.settings.operatingHours.schedule })]);
  const closedDay = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  await database.query("UPDATE platform_settings SET settings=jsonb_set(settings,'{operatingHours,schedule,closures}',$1::jsonb)",
    [JSON.stringify([{ startDay: closedDay, endDay: closedDay }])]);
  assert.ok(!(await compare('rider', '/dispatch/offers')).offers.some(row => row.id === 'm_offer'));
  await database.query("UPDATE orders SET data=data-'operatingClock' WHERE id='m_offer'");
  const before = await compare('ops', '/claims?orderId=a_active');
  await database.query("UPDATE claims SET status='released' WHERE id='claim_a_active'");
  assert.notDeepEqual(await compare('ops', '/claims?orderId=a_active'), before);
  await database.query('TRUNCATE supplier_catalog_items CASCADE');
  await compare('ops', '/ops/catalog-items/%E0%A4%A');
  t.diagnostic(`${compared} exact HTTP comparisons`);
});

test('Operations scoped reads reject saves and keep identical SQL/rows under unrelated domain growth', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close()); await setupOperationsReads(database);
  const paths = ['/dispatch/offers', '/claims?orderId=a_active', '/claims/claim_a_active', '/issues?orderId=a_active', '/issues/issue_a_active',
    '/escalations?orderId=a_active', '/users?role=supplier', '/users/client', '/users/supplier/verification-documents', '/users/supplier/payout-account', '/audit', '/orders/a_active/audit', '/ops/catalog-items/item_supplier'];
  // Dispatch's Operations projection now includes one order-scoped actor-history read.
  const budgets = [35, 6, 6, 7, 7, 6, 10, 24, 10, 11, 4, 5, 27];
  let beforeClientOrderIds;
  async function sample(reverseClientOrders = false) {
    const out = {};
    let reordered = 0;
    const sampledDatabase = { ...database, query: async (sql, values) => {
      const result = await database.query(sql, values);
      if (!sql.includes('FROM orders WHERE client_id = ANY($1::text[])')) return result;
      // SQL has no ORDER BY here. Force opposite valid result orders so the
      // growth proof cannot depend on PostgreSQL choosing the same scan plan.
      const rows = [...result.rows].sort((a, b) => a.id.localeCompare(b.id));
      if (reverseClientOrders) rows.reverse();
      const ids = rows.map(row => row.id);
      assert.ok(ids.length > 1);
      if (reverseClientOrders) assert.notDeepEqual(ids, beforeClientOrderIds);
      else beforeClientOrderIds = ids;
      reordered++;
      return { ...result, rows };
    } };

    for (const path of paths) {
      const url = new URL(path, 'http://api.test'); assert.ok(isHotReadPath(url.pathname));
      const { db, queries } = instrument(sampledDatabase);
      const store = await loadHotReadStore(db, 'clerk_ops', url.pathname, { searchParams: url.searchParams });
      await assert.rejects(database.transaction(() => saveStore(database, store)), /read-only/);
      assert.ok(queries.length <= budgets[paths.indexOf(path)], `${path}: query budget`);
      assert.ok(!queries.some(q => /FROM (audit_log|notifications|location_pings|notification_push_outbox)\b/.test(q.sql)));
      out[path] = { queries: comparableQueries(queries), projection: JSON.stringify(store, (_, value) => value instanceof Map ? [...value] : value) };
    }
    assert.equal(reordered, 1, 'forced the client order selection once per sample');
    return out;
  }
  const before = await sample();
  // Clone unrelated order/queue/catalog/file rows through SQL without any route writes.
  const columns = (await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND table_schema='public' AND is_generated='NEVER' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  await database.query(`INSERT INTO orders (${columns.join(',')}) SELECT ${columns.map(c => `clone.${c}`).join(',')}
    FROM orders o CROSS JOIN generate_series(1,1000) i CROSS JOIN LATERAL jsonb_populate_record(NULL::orders,
      to_jsonb(o) || jsonb_build_object('id','growth_'||i,'position',1000+i,'data',o.data-'shopHandover')) clone WHERE o.id='unrelated'`);
  for (const table of ['claims', 'issues', 'escalations']) await database.query(`INSERT INTO ${table} SELECT
    (jsonb_populate_record(NULL::${table}, to_jsonb(q) || jsonb_build_object('id','growth_'||i,'order_id','growth_'||i,'claim_id',NULL,'position',1000+i))).*
    FROM ${table} q CROSS JOIN generate_series(1,1000) i WHERE q.id=$1`, [`${table === 'claims' ? 'claim' : table === 'issues' ? 'issue' : 'escalation'}_unrelated`]);
  assert.deepEqual(await sample(true), before);
  for (const [path, { queries }] of Object.entries(before)) t.diagnostic(`${path}: ${queries.length} SELECTs / ${queries.reduce((n,q) => n+q.rows,0)} rows`);
});

test('queue authorization facts and directory profiles share repeatable-read snapshots with their candidates', { skip }, async t => {
  const database = createDatabase(process.env), writer = createDatabase(process.env);
  t.after(() => database.close()); t.after(() => writer.close()); await setupOperationsReads(database);
  let changed = false;
  let db = { ...database, query: async (sql, values) => {
    const result = await database.query(sql, values);
    if (!changed && sql.includes('FROM issues WHERE')) {
      changed = true;
      await writer.transaction(() => writer.query("UPDATE orders SET data=jsonb_set(data,'{fileCheck}','{\"status\":\"pending\"}') WHERE id='a_active'"));
    }
    return result;
  } };
  const params = { searchParams: new URLSearchParams('orderId=a_active') };
  const before = await loadHotReadStore(db, 'clerk_supplier', '/issues', params);
  assert.ok(changed); assert.notEqual(before.orders.find(row => row.id === 'a_active').fileCheck?.status, 'pending');
  const after = await loadHotReadStore(database, 'clerk_supplier', '/issues', params);
  assert.equal(after.orders.find(row => row.id === 'a_active').fileCheck.status, 'pending');
  changed = false;
  db = { ...database, query: async (sql, values) => {
    const result = await database.query(sql, values);
    if (!changed && sql.includes('FROM users WHERE (id = ANY')) {
      changed = true;
      await writer.transaction(() => writer.query("UPDATE supplier_profiles SET shop_name='Concurrent rename' WHERE user_id='supplier'"));
    }
    return result;
  } };
  const directory = await loadHotReadStore(db, 'clerk_ops', '/users', { searchParams: new URLSearchParams('role=supplier') });
  assert.ok(changed); assert.notEqual(directory.supplierProfiles.find(row => row.userId === 'supplier').shopName, 'Concurrent rename');
  const refreshed = await loadHotReadStore(database, 'clerk_ops', '/users', { searchParams: new URLSearchParams('role=supplier') });
  assert.equal(refreshed.supplierProfiles.find(row => row.userId === 'supplier').shopName, 'Concurrent rename');
});
