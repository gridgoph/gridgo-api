import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { isHotReadPath, loadHotReadStore, saveStore } from '../src/postgres-store.js';
import { parityApiForTest } from './fixtures/read-parity.js';
import { setupStaffDesks } from './fixtures/staff-desks.js';
import { instrument } from './fixtures/order-reads.js';
import { AT } from './fixtures/reschedule.js';

export const desks = ['/credits/balance?clientId=client', '/baskets', '/baskets/basket_staff', '/baskets/missing','/ops/tester-invites', '/ops/tester-rewards', '/admin/featured-prints', '/admin/season-windows', '/admin/season-windows/push-settings', '/ops/catalog-items', '/approval-cases', '/approval-cases/case_rider',
  '/supplier-services', '/supplier-services/service_supplier', '/supplier-payment-terms',
  '/users/supplier/production-lapses', '/ops/shops/hours', '/ops/shops/supplier/hours',
  '/ops/shops/performance', '/ops/shops/supplier/performance', '/ops/riders/locations',
  '/ops/orders/a_active/location-diagnostics', '/ops/special-instructions', '/ops/reschedule-requests',
  '/ops/hub', '/ops/hub/escalations', '/ops/hub/unclaimed', '/ops/hub/handouts', '/ops/hub/receipt-scans',
  '/staff/me', '/staff/hub', '/staff/hub/handouts', '/admin/staff', '/admin/staff/roles', '/admin/staff/invites',
  '/ops/finance/supplier-invoices?month=2026-10', '/ops/finance/supplier-invoices/a_active',
  '/ops/organizations', '/ops/organizations/client', '/ops/organizations/client/statements', '/ops/organizations/other', '/ops/organizations/other/statements?from=2026-10-01&to=2026-10-31',
  '/ops/vouchers?clientId=client', '/admin/voucher-campaigns', '/admin/voucher-campaigns/missing',
  '/admin/voucher-redemptions', '/admin/promotions', '/ops/founding-testers',
  '/admin/survey-responses', '/admin/pricing-feedback', '/admin/checkout-exit-feedback', '/admin/files/retention', '/admin/shop-rankings',
  '/admin/pricing', '/ops/push/stats', '/ops/account-deletion-requests', '/ops/issue-reports', '/ops/issue-reports/11111111-1111-4111-8111-111111111111',
  '/admin/legal/documents', '/admin/privacy-requests', '/admin/legal/acceptances',
  '/support-chat/threads', '/support-chat/people', '/ops/client-shop-chats', '/refund-requests', '/refund-requests/refund_hold'];

test('every staff desk has a targeted dispatcher entry', () => {
  assert.ok(isHotReadPath('/support-chat/stream'));
  for (const path of desks) assert.ok(isHotReadPath(new URL(path, 'http://test').pathname), path);
});

test('staff desks preserve full-store HTTP projections and headers across identities', { skip: !process.env.DATABASE_URL }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupStaffDesks(database);
  const at = Date.now() + 120000;
  const old = await parityApiForTest(t, true, at), current = await parityApiForTest(t, false, at);
  let comparisons = 0;
  const failures = [];
  async function compare(who, path, opts = {}) {
      const a = await old(who, 'GET', path, null, { raw: true, ...opts });
      const b = await current(who, 'GET', path, null, { raw: true, ...opts });
      if (/^\/users\/[^/]+\/production-lapses$/.test(new URL(path, 'http://test').pathname)) {
        // This route already used targeted SQL on dev. A forced index scan
        // need not enumerate equal detectedAt keys like a complete heap scan.
        // Preserve the sequence of timestamps and every row/field; compare
        // only ties by ID here. The actual-dev matrix checks native order.
        for (const response of [a, b]) if (response.status === 200) {
          const body = JSON.parse(response.body), rows = body.lapses;
          for (let start = 0; start < rows.length;) {
            let end = start + 1;
            while (end < rows.length && rows[end].detectedAt === rows[start].detectedAt) end++;
            rows.splice(start, end - start, ...rows.slice(start, end).sort((left, right) => left.id.localeCompare(right.id)));
            start = end;
          }
          response.body = JSON.stringify(body);
        }
      }
      if (b.status !== a.status || b.body !== a.body) failures.push({ who, path, old: a.body, current: b.body, statuses: [a.status, b.status] });
      for (const key of ['content-type', 'cache-control', 'content-disposition', 'x-next-offset']) assert.equal(b.headers.get(key), a.headers.get(key), `${who} ${path}: ${key}`);
      comparisons++;
      return b.headers.get('content-type')?.includes('application/json') ? JSON.parse(b.body) : b.body;
  }
  for (const who of [null, 'client', 'supplier', 'rider', 'ops', 'admin', 'test_ops', 'staff', 'dual', 'suspended']) {
    for (const path of desks) if (path !== '/ops/push/stats') await compare(who,path);
  }
  for (const who of ['ops','admin','test_ops']) {
    for (const q of ['Print', 'Print cards', 'caf special', 'Fixture shop', 'special%_', 'İA', 'ΟΣ', 'i̇a', '\u00a0', 'missing', '']) await compare(who,`/ops/catalog-items?q=${encodeURIComponent(q)}&limit=2`);
    for (const query of ['limit=0','limit=51','q=%00','cursor=bad','productionTimeReview=required','subcategoryCode=flyers','supplierId=replacement&minPriceMinor=110&maxPriceMinor=120','supplierId=%00','productionTimeReview=bad','minPriceMinor=-1','minPriceMinor=100&maxPriceMinor=2']) await compare(who,`/ops/catalog-items?${query}`);
    let cursor;
    do { const body=await compare(who,`/ops/catalog-items?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);cursor=body.nextCursor;} while(cursor);
    for (const path of ['/ops/hub/handouts?limit=1','/ops/hub/handouts?before=2026-10-05T00:00:00.000Z|handout_review','/ops/hub/receipt-scans?month=2026-10&limit=1','/ops/hub/receipt-scans?month=bad','/ops/finance/supplier-invoices?month=2026-10&limit=1&after=a_active','/ops/finance/supplier-invoices?month=2026-10&supplierId=supplier','/ops/reschedule-requests?status=pending','/ops/reschedule-requests?supplierId=supplier','/ops/special-instructions?q=colour','/approval-cases?status=approved','/approval-cases?kind=rider&status=approved','/approval-cases?cursor=bad','/approval-cases/missing','/supplier-services?state=live','/supplier-payment-terms?supplierId=supplier','/ops/shops/missing/hours','/ops/shops/missing/performance','/ops/vouchers?clientId=other&tab=all','/ops/vouchers?clientId=client&tab=invalid','/admin/voucher-redemptions?format=csv','/admin/survey-responses?from=2026-10-01&to=2026-10-31&limit=1','/admin/survey-responses?format=csv','/admin/pricing-feedback?format=csv','/admin/checkout-exit-feedback?format=csv','/admin/pricing?from=2026-10-01&to=2026-10-31','/admin/pricing?from=2026-10-01&to=2026-10-31&cohort=new','/admin/pricing?category=flyers&accountType=individual&bracket=under_500&cohort=repeat','/admin/pricing?from=bad', '/ops/issue-reports?limit=1', '/ops/issue-reports?status=new&before=22222222-2222-4222-8222-222222222222']) await compare(who,path);
  }
  for (const role of ['client','ops_admin','super_admin','bad']) for (const path of ['/ops/catalog-items','/supplier-services','/ops/shops/performance','/admin/staff','/ops/hub','/approval-cases']) await compare('dual',path,{headers:{'X-Gridgo-Role':role}});
  if (failures.length && process.env.STAFF_PARITY_FAILURES) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.STAFF_PARITY_FAILURES, JSON.stringify(failures, null, 2));
  }
  assert.equal(failures.length, 0, JSON.stringify(failures.map(({ who, path, statuses }) => ({ who, path, statuses }))));
  t.diagnostic(`${comparisons} HTTP comparisons; only equal-time lapse ties canonicalized (exact native ordering has an actual-dev oracle)`);
});

test('staff desks preserve empty filters and NUL-containing binary cursors', { skip: !process.env.DATABASE_URL }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupStaffDesks(database);
  const at = Date.now() + 120000;
  const old = await parityApiForTest(t, true, at), current = await parityApiForTest(t, false, at);
  const paths = [
    '/supplier-services?supplierId=', '/supplier-services?state=', '/supplier-services?supplierId=&state=',
    '/ops/hub/receipt-scans?month=', '/ops/hub/receipt-scans?supplierId=', '/ops/hub/receipt-scans?month=&supplierId=',
    '/ops/reschedule-requests?supplierId=', '/ops/reschedule-requests?status=',
    '/approval-cases?status=', '/approval-cases?kind=', '/approval-cases?cursor=',
    '/ops/finance/supplier-invoices?month=2026-10&supplierId=', '/ops/finance/supplier-invoices?month=',
    '/credits/balance?clientId=', '/supplier-payment-terms?supplierId=', '/refund-requests?status=',
    '/ops/vouchers?clientId=', '/ops/tester-invites?inviterId=', '/ops/tester-invites?status=',
    '/ops/tester-rewards?clientId=', '/ops/tester-rewards?status=',
    '/admin/voucher-redemptions?campaignId=', '/admin/voucher-redemptions?clientId=', '/admin/voucher-redemptions?kind=',
    '/admin/voucher-redemptions?from=', '/admin/survey-responses?to=',
    '/ops/catalog-items?supplierId=', '/ops/catalog-items?subcategoryCode=', '/ops/catalog-items?productionTimeReview=',
    '/ops/catalog-items?q=', '/ops/organizations?after=',
  ];
  // NUL is accepted by the existing cursor contract, but cannot be bound as PG text.
  // Cover leading/interior NULs and the exact stored-ID prefix on each binary cursor.
  for (const after of ['\0', '\0other', 'o\0ther', 'other\0', 'other\0suffix', 'z\0']) {
    paths.push(`/ops/organizations?${new URLSearchParams({ after })}`);
  }
  for (const id of ['\0', '\0case_org', 'case_\0org', 'case_org\0', 'case_org\0suffix', 'z\0']) {
    const cursor = Buffer.from(JSON.stringify({ submittedAt: AT, id })).toString('base64url');
    paths.push(`/approval-cases?status=approved&cursor=${cursor}`);
  }
  const failures = [];
  for (const who of ['ops', 'admin', 'test_ops', 'dual', 'supplier']) for (const path of paths) {
    const a = await old(who, 'GET', path, null, { raw: true });
    const b = await current(who, 'GET', path, null, { raw: true });
    if (b.status !== a.status || b.body !== a.body) failures.push({ who, path, old: a.body, current: b.body, statuses: [a.status, b.status] });
    for (const key of ['content-type', 'cache-control', 'content-disposition', 'x-next-offset']) assert.equal(b.headers.get(key), a.headers.get(key), `${who} ${path}: ${key}`);
  }
  if (failures.length && process.env.STAFF_PARITY_FAILURES) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.STAFF_PARITY_FAILURES, JSON.stringify(failures, null, 2));
  }
  assert.equal(failures.length, 0, JSON.stringify(failures.map(({ who, path, statuses }) => ({ who, path, statuses }))));
  t.diagnostic(`${paths.length * 5} exact HTTP comparisons for empty filters and binary cursors`);
});

test('staff desk graphs are read-only and do not transfer unrelated inbox, audit or ping history', { skip: !process.env.DATABASE_URL }, async t => {
  const database = createDatabase(process.env); t.after(() => database.close());
  await setupStaffDesks(database);
  for (const path of desks) {
    const url = new URL(path, 'http://test'), { db, queries } = instrument(database);
    const store = await loadHotReadStore(db, path.startsWith('/admin/') || path.startsWith('/approval-cases') ? 'clerk_admin' : 'clerk_ops', url.pathname, { searchParams: url.searchParams });
    await assert.rejects(database.transaction(() => saveStore(database, store)), /read-only/);
    assert.ok(!queries.some(q => /FROM (notifications|audit_log|location_pings)\s*(?:$|ORDER BY)/.test(q.sql)), path);
    assert.ok(queries.length < 60, `${path}: ${queries.length} SELECTs`);
  }
});

test('staff and delivery graphs stay flat at 10,000 and 100,000 unrelated history rows', { skip: !process.env.DATABASE_URL }, async t => {
  const database=createDatabase(process.env);t.after(()=>database.close());await setupStaffDesks(database);
  const { loadDeliveryStore,loadPushDeliveryStore }=await import('../src/postgres-store.js');
  await database.query("INSERT INTO audit_log(id,at,actor_id,actor_role,action,position,data) VALUES ('session_probe',now(),'ops','ops_admin','staff.sign_in',8999,'{\"detail\":{\"sessionHash\":\"staff_probe\"}}')");
  await database.query("INSERT INTO device_tokens(id,user_id,token,platform,created_at,updated_at,position,data) VALUES ('growth_device','client','growth_token','android',now(),now(),9000,'{}')");
  async function grow(from,to) {
    await database.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data)
      SELECT 'growth_notice_'||i,'client','general',now(),9000+i,'{}' FROM generate_series($1::int,$2::int) i`,[from,to]);
    await database.query(`INSERT INTO audit_log(id,at,action,position,data)
      SELECT 'growth_audit_'||i,now(),'unrelated.history',9000+i,'{}' FROM generate_series($1::int,$2::int) i`,[from,to]);
    await database.query(`INSERT INTO location_pings(id,order_id,rider_id,lat,lng,at,position,data)
      SELECT 'growth_ping_'||i,'z_history','rider',7,125,now(),9000+i,'{}' FROM generate_series($1::int,$2::int) i`,[from,to]);
    await database.query(`INSERT INTO notification_push_outbox(notification_id,device_id,user_id,status)
      SELECT 'growth_notice_'||i,'growth_device','client','delivered' FROM generate_series($1::int,$2::int) i`,[from,to]);
    await database.query('ANALYZE');
  }
  async function sample() {
    const results={};
    const paths=[...desks,'/ops/catalog-items?limit=1','/ops/catalog-items?q=cards&limit=1','/admin/pricing?from=2026-10-01&to=2026-10-31&cohort=new'];
    for(const path of paths) {
      const url=new URL(path,'http://test'),{db,queries}=instrument(database);
      const subject=path.startsWith('/admin/')||path.startsWith('/approval-cases')?'clerk_admin':'clerk_ops';
      const store=await loadHotReadStore(db,subject,url.pathname,{searchParams:url.searchParams,sessionHash:url.pathname==='/staff/me'?'staff_probe':null});
      if(url.pathname==='/staff/me') assert.equal(store.auditLog.length,1);
      if(store.prepareIssueReporterFacts) await store.prepareIssueReporterFacts(['client','review_client']);
      if(url.pathname==='/ops/catalog-items' && url.searchParams.get('limit')==='1') assert.equal(store.catalogItems.length,1);
      if(url.pathname.endsWith('/location-diagnostics')) assert.ok(store.locationPings.length<=101);
      results[path]=queries.map(({sql,rows})=>({sql,rows}));
    }
    for(const [name,loader] of [['realtime',db=>loadDeliveryStore(db,{userIds:['ops'],subjectId:'a_active'})],
      ['push',db=>loadPushDeliveryStore(db,[{user_id:'client',notification_id:'growth_notice_1',device_id:'growth_device'}])]]) {
      const {db,queries}=instrument(database);await loader(db);results[name]=queries.map(({sql,rows})=>({sql,rows}));
    }
    return results;
  }
  await grow(1,10000);const before=await sample();await grow(10001,100000);assert.deepEqual(await sample(),before);
  for(const [path,queries] of Object.entries(before))t.diagnostic(`${path}: ${queries.length} SELECTs / ${queries.reduce((n,q)=>n+q.rows,0)} rows at both scales`);
});

test('staff catalogue cursors keep legacy string comparisons for opaque and control-character input', { skip: !process.env.DATABASE_URL }, async t => {
  const database=createDatabase(process.env);t.after(()=>database.close());const full=await setupStaffDesks(database);
  const {listStaffCatalogItemsFromGraph}=await import('../src/supplier-catalog.js');
  const {parseStaffCatalogQuery}=await import('../src/catalog-routes.js');
  for(const q of ['caf special','ΟΣ special','İA Café']) {
    const params=new URLSearchParams({q,limit:'2'}), expected=listStaffCatalogItemsFromGraph(full,parseStaffCatalogQuery({searchParams:params}));
    const scoped=await loadHotReadStore(database,'clerk_ops','/ops/catalog-items',{searchParams:params}),actual=await scoped.listStaffCatalogItems();
    assert.deepEqual({...actual,items:actual.items.map(r=>r.id)},{...expected,items:expected.items.map(r=>r.id)},q);
  }
  for(const cursor of [{at:'2026-10-05T00:00:00.000Z',id:'\0staff_item_001'},
    {at:'2026-10-05T00:00:00.000Z',id:'\u0001staff_item_001'},
    {at:'2026-10-05T00:00:00.000Z',id:'\ufeffstaff_item_001'},
    {at:'\0',id:'anything'}, {at:'2026-10-05T00:00:00.000Z\0',id:'staff_item_001'}]) {
    const params=new URLSearchParams({limit:'2',cursor:Buffer.from(JSON.stringify(cursor)).toString('base64url')});
    const expected=listStaffCatalogItemsFromGraph(full,parseStaffCatalogQuery({searchParams:params}));
    const scoped=await loadHotReadStore(database,'clerk_ops','/ops/catalog-items',{searchParams:params});
    const actual=await scoped.listStaffCatalogItems(parseStaffCatalogQuery({searchParams:params}));
    assert.deepEqual({...actual,items:actual.items.map(r=>r.id)},{...expected,items:expected.items.map(r=>r.id)},JSON.stringify(cursor));
  }
});
