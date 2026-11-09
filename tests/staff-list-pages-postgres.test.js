import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore, saveStore } from '../src/postgres-store.js';
import { parseStaffPage, STAFF_LIST_PAGE } from '../src/staff-list-pages.js';
import { setupStaffDesks } from './fixtures/staff-desks.js';
import { parityApiForTest } from './fixtures/read-parity.js';
import { instrument } from './fixtures/order-reads.js';
import { AT } from './fixtures/reschedule.js';
import { voucherTables } from '../src/voucher-store.js';

const skip = !process.env.DATABASE_URL;
// Override when comparing a newer baseline. Shallow CI checkouts still run the
// SQL/HTTP wallet regression below; the historical-source matrix needs this ref.
const devRef = process.env.STAFF_LIST_DEV_REF || '14aaf31611c02eeef1e175864b00d11678f68b47';
const hasDevRef = spawnSync('git', ['cat-file', '-e', `${devRef}:src/server.js`]).status === 0;
const paths = ['/admin/staff', '/admin/staff/invites', '/admin/staff/roles', '/admin/voucher-campaigns',
  '/ops/vouchers?clientId=client&tab=all', '/ops/hub/escalations', '/ops/hub/unclaimed',
  '/users/supplier/production-lapses', '/supplier-services', '/ops/shops/hours', '/ops/shops/performance',
  '/ops/reschedule-requests', '/refund-requests', '/users', '/claims', '/escalations', '/admin/season-windows'];
const pagePath = (path, entries) => {
  const url = new URL(path, 'http://test');
  for (const [k, v] of Object.entries(entries)) url.searchParams.set(k, v);
  return url.pathname + url.search;
};
async function fixture(database) {
  const store = await setupStaffDesks(database);
  const staff = store.users.find(u => u.id === 'staff');
  for (let i = 0; i < 6; i++) {
    const userId = `page_staff_${i}`;
    store.users.push({ ...staff, id: userId, email: `${userId}@example.test`, clerkUserId: `clerk_${userId}` });
    store.userRoleMemberships.push({ userId, role: 'staff', createdAt: AT });
    store.staffProfiles.push({ userId, roleCode: 'counter', active: i % 2 === 0, updatedAt: AT });
    store.staffInvites.push({ ...store.staffInvites[0], id: `page_invite_${i}`, codeHash: `private_hash_${i}`, createdAt: AT });
    store.staffRoles.push({ code: `page_role_${i}`, name: `Role ${i}`, canHandout: false });
    store.vouchers.push({ ...store.vouchers[0], id: `page_voucher_${i}`, campaignId: `page_campaign_${i}`, issuedAt: AT,
      status: ['available', 'used', 'void'][i % 3], expiresAt: i < 3 ? '2026-10-06T00:00:00.000Z' : '2030-01-01T00:00:00.000Z' });
    store.voucherCampaigns.push({ ...store.voucherCampaigns[0], id: `page_campaign_${i}`, code: `PAGE-${i}`, createdAt: AT });
    store.seasonWindows.push({ ...store.seasonWindows[0], id: `page_season_${i}` });
  }
  const orders = store.orders.filter(o => o.supplierId === 'supplier').slice(0, 4);
  // Insert a recovered snapshot; never rewrite a persisted request's owner.
  store.orders.push({...structuredClone(store.orders.find(o=>o.id==='a_active')),
    id:'page_historical_request',supplierId:'replacement'});
  for (const [i, order] of orders.entries()) store.productionLapses.push({ id: `page_lapse_${i}`, orderId: order.id, supplierId: 'supplier', tier: 'minor',
    deadlineAt: AT, detectedAt: AT, rateBps: 500, deductionMinor: 0, remainingBalanceMinor: 0, appliedAt: null,
    policy: { warningsOnly: true, deductionsEnabled: false }, warnings: [] });
  for (const [i, value] of [null, false, 0].entries()) store.orders.push({ ...structuredClone(store.orders.find(o => o.id === 'pickup_offer')),
    id: `page_falsy_${i}`, rescheduleRequest: value, handover: { qrToken: value, escalation: value } });
  await database.transaction(() => saveStore(database, store));
  // Equal millisecond keys with unequal database microseconds must not skip rows.
  await database.query("UPDATE staff_invites SET created_at=$1::timestamptz + interval '0.0009 second' WHERE id='page_invite_1'", [AT]);
}

test('staff list page parameters are opt-in, bounded and scope-bound', () => {
  assert.equal(parseStaffPage('/admin/staff', new URLSearchParams()), null);
  assert.equal(parseStaffPage('/admin/staff', new URLSearchParams('limit=2')).limit, 2);
  for (const limit of ['', '0', '-1', '51', '1.5', 'NaN', 'Infinity', '1e1']) {
    assert.throws(() => parseStaffPage('/admin/staff', new URLSearchParams({ limit })), { code: 'invalid_limit' });
  }
  for (const cursor of ['', 'bad', 'e30', '***', Buffer.from('{"v":1}').toString('base64url')]) {
    assert.throws(() => parseStaffPage('/admin/staff', new URLSearchParams({ cursor })), { code: 'invalid_cursor' });
  }
  const encode = cursor => Buffer.from(JSON.stringify(cursor)).toString('base64url');
  for (const k of [-1, 2147483648, Number.MAX_SAFE_INTEGER, 1.5]) {
    assert.throws(() => parseStaffPage('/ops/hub/unclaimed', new URLSearchParams({ cursor: encode({v:1,path:'/ops/hub/unclaimed',scope:'[]',id:'x',k}) })), {code:'invalid_cursor'});
  }
  for (const k of ['-010000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z', 'not-a-date']) {
    assert.throws(() => parseStaffPage('/admin/staff', new URLSearchParams({ cursor: encode({v:1,path:'/admin/staff',scope:'[]',id:'x',k}) })), {code:'invalid_cursor'});
  }
});

test('unpaged staff lists retain actual-dev targeted HTTP bodies, order and headers', { skip: skip || (!hasDevRef && 'historical dev source is unavailable; set STAFF_LIST_DEV_REF') }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close()); await fixture(database);
  const at = Date.now() + 120000;
  const old = await parityApiForTest(t, false, at, { sourceRef: devRef, stableFixture: true });
  const current = await parityApiForTest(t, false, at, { stableFixture: true });
  let comparisons = 0;
  for (const who of [null, 'client', 'supplier', 'rider', 'ops', 'admin', 'test_ops', 'staff', 'dual', 'suspended']) {
    for (const path of [...paths, '/me/vouchers?tab=all', '/me/production-lapses', '/ops/vouchers?clientId=client&tab=available', '/ops/vouchers?clientId=client&tab=used', '/ops/vouchers?clientId=client&tab=expired',
      '/users?role=client&foundingTester=true', '/users?role=client&foundingTester=false', '/ops/reschedule-requests?status=accepted']) {
      const a = await old(who, 'GET', path, null, { raw: true }), b = await current(who, 'GET', path, null, { raw: true });
      assert.equal(b.status, a.status, `${who} ${path}`); assert.equal(b.body, a.body, `${who} ${path}`);
      for (const key of ['content-type', 'cache-control']) assert.equal(b.headers.get(key), a.headers.get(key));
      comparisons++;
    }
  }
  t.diagnostic(`${comparisons} exact unpaged HTTP comparisons against targeted dev ${devRef}`);
});

test('unpaged voucher enumeration retains dev SQL under sequential and selective indexed plans', { skip }, async t => {
  const database = createDatabase(process.env);
  t.after(async () => {
    try {
      await database.query("DELETE FROM vouchers WHERE id LIKE 'repro_voucher_%'");
      await database.query("DELETE FROM voucher_campaigns WHERE id LIKE 'repro_campaign_%'");
      await database.query('VACUUM ANALYZE vouchers');
      await database.query('VACUUM ANALYZE voucher_campaigns');
    } finally { await database.close(); }
  });
  await setupStaffDesks(database);
  await database.query(`INSERT INTO voucher_campaigns
    (id,name,code,mode,status,value_minor,total_limit,per_account_limit,validity_days,created_at,updated_at)
    SELECT 'repro_campaign_'||i,'Review','REPRO-'||i,'assigned','active',100,1000000,1,7,'2026-10-05','2026-10-05'
    FROM generate_series(1,20000) i`);
  await database.query(`INSERT INTO vouchers
    (id,campaign_id,client_id,status,value_minor,issued_at,expires_at)
    SELECT 'repro_voucher_'||i,'repro_campaign_'||i,CASE WHEN i<=6 THEN 'client' ELSE 'other' END,
      CASE i%3 WHEN 1 THEN 'used' WHEN 2 THEN 'available' ELSE 'void' END,100,'2026-10-05','2030-01-01'
    FROM generate_series(1,20000) i`);
  await database.query('VACUUM ANALYZE vouchers');
  // This is dev's exact targeted query, including its projection width. A
  // full-store oracle would silently substitute a different enumeration.
  const sql = `SELECT ${voucherTables.find(table => table.name === 'vouchers').columns.join(', ')} FROM vouchers WHERE client_id=$1`;
  const indexes = (await database.query(`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexname IN ('vouchers_client_page_idx','vouchers_client_status_page_idx','vouchers_client_expiry_idx')`)).rows;
  assert.equal(indexes.length, 3);
  const at = Date.now() + 120000;
  let devBody, oldIds;
  try {
    for (const index of indexes) await database.query(`DROP INDEX ${index.indexname}`);
    const plan = (await database.query(`EXPLAIN ${sql}`, ['client'])).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(plan, /Index Scan using vouchers_wallet_idx/);
    oldIds = (await database.query(sql, ['client'])).rows.map(row => row.id);
    const heapIds = (await database.query(`${sql} ORDER BY ctid`, ['client'])).rows.map(row => row.id);
    assert.notDeepEqual(oldIds, heapIds, 'fixture must distinguish native dev enumeration from heap order');
    if (hasDevRef) {
      const old = await parityApiForTest(t, false, at, { sourceRef: devRef, stableFixture: true });
      devBody = await old('ops', 'GET', '/ops/vouchers?clientId=client&tab=all', null, { raw: true });
    }
  } finally {
    for (const index of indexes) await database.query(index.indexdef);
  }
  const current = await parityApiForTest(t, false, at, { stableFixture: true });
  const body = await current('ops', 'GET', '/ops/vouchers?clientId=client&tab=all', null, { raw: true });
  assert.equal(body.status, 200);
  assert.deepEqual(JSON.parse(body.body).vouchers.map(row => row.id), oldIds, 'migration must preserve the selective dev response');
  if (devBody) assert.equal(body.body, devBody.body, 'actual dev before indexes vs current after indexes');
  for (const [label, planner] of [['sequential', '-c enable_indexscan=off -c enable_bitmapscan=off'], ['indexed', '-c enable_seqscan=off -c enable_bitmapscan=off']]) {
    const url = new URL(process.env.DATABASE_URL); url.searchParams.set('options', planner);
    const planned = createDatabase({ ...process.env, DATABASE_URL: url.href });
    try {
      const plan = (await planned.query(`EXPLAIN ${sql}`, ['client'])).rows.map(row => row['QUERY PLAN']).join('\n');
      assert.match(plan, label === 'sequential' ? /Seq Scan on vouchers/ : /Index Scan using/);
      const expected = (await planned.query(sql, ['client'])).rows.map(row => row.id);
      const { db, queries } = instrument(planned);
      const store = await loadHotReadStore(db, 'clerk_ops', '/ops/vouchers', { searchParams: new URLSearchParams('clientId=client&tab=all') });
      assert.equal(queries.find(query => query.sql.includes('FROM vouchers ')).sql, sql, label);
      assert.deepEqual(store.vouchers.map(row => row.id), expected, label);
      const api = await parityApiForTest(t, false, at, { stableFixture: true, planner });
      const result = await api('ops', 'GET', '/ops/vouchers?clientId=client&tab=all');
      assert.equal(result.status, 200); assert.deepEqual(result.body.vouchers.map(row => row.id), expected, label);
    } finally { await planned.close(); }
  }
  t.diagnostic('20,000-voucher regression: native wallet order before/after indexes and sequential/indexed SQL + HTTP order match');
});

test('keyset pages cover equal keys, filters, last/empty pages, cursor errors and authorization', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close()); await fixture(database);
  const api = await parityApiForTest(t, false, Date.now() + 120000);
  for (const path of [...paths, '/ops/vouchers?clientId=client&tab=available', '/ops/vouchers?clientId=client&tab=used', '/ops/vouchers?clientId=client&tab=expired',
    '/users?role=client&foundingTester=true', '/users?role=client&foundingTester=false', '/supplier-services?state=live', '/ops/reschedule-requests?status=accepted',
    '/supplier-services?supplierId=%00', '/supplier-services?state=%00', '/users?role=%00', '/refund-requests?status=%00', '/ops/reschedule-requests?supplierId=%00', '/ops/reschedule-requests?status=%00']) {
    const plan = parseStaffPage(new URL(path, 'http://test').pathname, new URLSearchParams('limit=2'));
    const full = await api('admin', 'GET', path); assert.equal(full.status, 200, path);
    let cursor, lastCursor, count = 0; const rows = [];
    do {
      const result = await api('admin', 'GET', pagePath(path, { limit: '2', ...(cursor ? { cursor } : {}) }));
      assert.equal(result.status, 200, `${path} ${JSON.stringify(result.body)}`);
      assert.ok(result.body[plan.collection].length <= 2, path);
      if (result.body.nextCursor) assert.equal(result.body[plan.collection].length, 2, path);
      if ('totalRequests' in full.body) assert.equal(result.body.totalRequests, full.body.totalRequests);
      if ('banners' in full.body) assert.deepEqual(result.body.banners, full.body.banners);
      rows.push(...result.body[plan.collection]); lastCursor = cursor; cursor = result.body.nextCursor;
      assert.ok(++count < 100, path);
    } while (cursor);
    assert.equal(new Set(rows.map(r => r[plan.publicId])).size, rows.length, path);
    const byId = list => [...list].sort((a, b) => String(a[plan.publicId]).localeCompare(String(b[plan.publicId])));
    assert.deepEqual(byId(rows), byId(full.body[plan.collection]), path);
    if (plan.sort !== 'position') {
      const expected = [...full.body[plan.collection]].sort((a, b) => {
        const key = plan.field && String(b[plan.field]).localeCompare(String(a[plan.field]));
        if (key) return key;
        const left = a[plan.publicId], right = b[plan.publicId];
        return (left < right ? -1 : left > right ? 1 : 0) * (plan.sort ? -1 : 1);
      });
      assert.deepEqual(rows, expected, `${path}: declared page ordering`);
    }
    const first = await api('admin', 'GET', pagePath(path, { limit: '1' }));
    if (first.body.nextCursor) {
      const decoded = JSON.parse(Buffer.from(first.body.nextCursor, 'base64url'));
      for (const altered of [{ ...decoded, path: '/wrong' }, { ...decoded, scope: 'wrong' }, { ...decoded, id: '\0bad' }, ...(plan.sort ? [{ ...decoded, k: {} }] : [])]) {
        assert.equal((await api('admin', 'GET', pagePath(path, { cursor: Buffer.from(JSON.stringify(altered)).toString('base64url') }))).status, 400, path);
      }
      // A valid cursor beyond the end yields an empty final page.
      const end = { ...decoded, id: '\uffff', ...(plan.sort ? { k: plan.ascending ? 2147483647 : plan.field === 'requestedAt' ? '0001' : '0001-01-01T00:00:00.000Z' } : {}) };
      const empty = await api('admin', 'GET', pagePath(path, { cursor: Buffer.from(JSON.stringify(end)).toString('base64url') }));
      assert.equal(empty.status, 200, path); assert.deepEqual(empty.body[plan.collection], [], path); assert.equal(empty.body.nextCursor, null);
    }
    for (const query of [{ limit: '0' }, { limit: '51' }, { cursor: 'bad' }, { cursor: '' }]) {
      assert.equal((await api('admin', 'GET', pagePath(path, query))).status, 400, path);
      assert.equal((await api(null, 'GET', pagePath(path, query))).status, 401, path);
    }
    if (lastCursor) assert.equal((await api('admin', 'GET', pagePath(path, { cursor: lastCursor, limit: '50' }))).body.nextCursor, null);
  }
});

test('paged selection retains review-only, party and explicit role-header scopes', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close()); await fixture(database);
  const api = await parityApiForTest(t, false, Date.now() + 120000);
  for (const who of ['ops', 'test_ops', 'supplier', 'client', 'dual']) for (const path of paths) {
    const url = new URL(path, 'http://test'), plan = parseStaffPage(url.pathname, new URLSearchParams('limit=1'));
    const full = await api(who, 'GET', path), collected = [];
    let cursor, pages = 0;
    do {
      const result = await api(who, 'GET', pagePath(path, { limit: '1', ...(cursor ? { cursor } : {}) }));
      assert.equal(result.status, full.status, `${who} ${path}: ${JSON.stringify(result.body)}`);
      if (full.status !== 200) { assert.deepEqual(result.body, full.body); break; }
      collected.push(...result.body[plan.collection]); cursor = result.body.nextCursor;
      if (cursor) assert.equal(result.body[plan.collection].length, 1, `${who} ${path}: no hidden rows in page`);
      assert.ok(++pages < 100, path);
    } while (cursor);
    if (full.status === 200) {
      const ids = list => list.map(r => r[plan.publicId]).sort();
      assert.deepEqual(ids(collected), ids(full.body[plan.collection]), `${who} ${path}`);
    }
  }
  for (const role of ['ops_admin', 'supplier', 'client', 'super_admin', 'invalid']) {
    const headers = { 'X-Gridgo-Role': role };
    for (const path of ['/users', '/admin/staff', '/supplier-services', '/claims']) {
      const full = await api('dual', 'GET', path, null, { headers });
      const page = await api('dual', 'GET', pagePath(path, { limit: '1' }), null, { headers });
      assert.equal(page.status, full.status, `${role} ${path}`);
    }
  }
});

test('paged readers hydrate at most one page of parent rows before related facts', { skip }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close()); await fixture(database);
  for (const path of paths) {
    const url = new URL(pagePath(path, { limit: '2' }), 'http://test'), { db, queries } = instrument(database);
    const store = await loadHotReadStore(db, 'clerk_admin', url.pathname, { searchParams: url.searchParams });
    assert.ok(store[STAFF_LIST_PAGE]); assert.ok(store[STAFF_LIST_PAGE].ids.length <= 2);
    const parent = parseStaffPage(url.pathname, url.searchParams).table;
    const pageQuery = queries.find(q => q.sql.includes(`FROM ${parent} `) && /LIMIT \$\d+/.test(q.sql));
    assert.ok(pageQuery, path); assert.ok(pageQuery.rows <= 3, path);
    await assert.rejects(database.transaction(() => saveStore(database, store)), /read-only/);
  }
});

test('reschedule page totals exclude retained removals across filters and review scopes', { skip }, async t => {
  const database=createDatabase(process.env); t.after(()=>database.close()); await fixture(database);
  const api=await parityApiForTest(t,false,Date.now()+120000);
  const historical=await api('admin','GET','/ops/reschedule-requests?supplierId=supplier');
  const historicalPage=await api('admin','GET','/ops/reschedule-requests?supplierId=supplier&limit=1');
  assert.ok(historical.body.requests.some(row=>row.orderId==='page_historical_request'));
  assert.equal(historicalPage.body.totalRequests,historical.body.totalRequests);
  await database.query("INSERT INTO order_removals(order_id,removed_at,removed_by,reason) VALUES ('a_active',now(),'admin','Fixture retained removal'),('review',now(),'admin','Fixture retained removal'),('page_historical_request',now(),'admin','Fixture retained removal')");
  for(const who of ['admin','ops','test_ops']) for(const query of ['', '?status=pending', '?status=accepted', '?supplierId=supplier', '?supplierId=replacement', '?supplierId=review_supplier', '?supplierId=%00']) {
    const path='/ops/reschedule-requests'+query, full=await api(who,'GET',path), page=await api(who,'GET',pagePath(path,{limit:'1'}));
    assert.equal(full.status,200); assert.equal(page.status,200);
    assert.equal(page.body.totalRequests,full.body.totalRequests,`${who} ${path}`);
    assert.ok(page.body.requests.every(row=>!['a_active','review','page_historical_request'].includes(row.orderId)));
  }
});
