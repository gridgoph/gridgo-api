/** Destructive fixture benchmark: isolated migrated *_test database only.
 * Measures API-own request-log timings and SQL transfer budgets at 1x/10x.
 * No Clerk, GitHub, shared storage or production calls.
 */
import './assert-test-database.mjs';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadHotReadStore } from '../src/postgres-store.js';
import { STAFF_LIST_PAGE, parseStaffPage } from '../src/staff-list-pages.js';
import { setupStaffDesks } from '../tests/fixtures/staff-desks.js';
import { apiForTest } from '../tests/fixtures/reschedule-http.js';
import { instrument } from '../tests/fixtures/order-reads.js';
import { resetDatabase } from '../tests/fixtures/reset-database.js';

const database = createDatabase(process.env), cleanup = [];
const base = Number(process.env.PERF_BASE_ROWS || 10000), samples = Number(process.env.PERF_SAMPLES || 5);
assert.ok(Number.isSafeInteger(base) && base >= 100 && Number.isSafeInteger(samples) && samples >= 3);
const paths = ['/admin/staff', '/admin/staff/invites', '/admin/staff/roles', '/admin/voucher-campaigns',
  '/ops/vouchers?clientId=client&tab=all', '/ops/vouchers?clientId=client&tab=available', '/ops/vouchers?clientId=client&tab=used', '/ops/vouchers?clientId=client&tab=expired',
  '/ops/hub/escalations', '/ops/hub/unclaimed', '/users/supplier/production-lapses', '/supplier-services',
  '/ops/shops/hours', '/ops/shops/performance', '/ops/reschedule-requests', '/ops/reschedule-requests?status=accepted', '/ops/reschedule-requests?supplierId=supplier',
  '/refund-requests', '/users', '/users?role=client', '/users?role=client&foundingTester=true', '/claims', '/escalations', '/admin/season-windows'];
const paged = path => `${path}${path.includes('?') ? '&' : '?'}limit=20`;
const cases = paths.flatMap(path => {
  const url = new URL(paged(path),'http://test'), page = parseStaffPage(url.pathname,url.searchParams), middle = Math.floor(base/2);
  const cursor = {v:1,path:url.pathname,scope:page.scope,id:`growth_${String(middle).padStart(7,'0')}`,
    ...(page.sort ? {k:page.ascending ? 10000+middle : '2000-01-01T00:00:00.000Z'} : {})};
  url.searchParams.set('cursor',Buffer.from(JSON.stringify(cursor)).toString('base64url'));
  return [{label:path,path:paged(path)},{label:`${path} [deep]`,path:url.pathname+url.search}];
});
const id = "'growth_'||lpad(i::text,7,'0')";
const old = "'2000-01-01T00:00:00.000Z'";

// Clone schema-valid relational fixtures. Exclude generated columns explicitly.
async function clone(table, source, from, to, overrides) {
  const columns = (await database.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [table])).rows.map(r => r.column_name);
  const result = await database.query(`INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.map(c => `copy.${c}`).join(',')}
    FROM (SELECT * FROM ${table} original WHERE ${source} LIMIT 1) original CROSS JOIN generate_series($1::int,$2::int) i
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},to_jsonb(original)||jsonb_build_object(${overrides})) copy`, [from, to]);
  assert.equal(result.rowCount,to-from+1,`${table}: growth fixture template`);
}
async function grow(from, to) {
  await clone('users', "original.id='supplier'", from, to, `'id',${id},'clerk_user_id',${id},'email',${id}||'@example.test','position',10000+i,'created_at',${old},'last_authenticated_at','2099-01-01'`);
  await database.query(`INSERT INTO user_role_memberships(user_id,role,created_at)
    SELECT ${id},role,'2000-01-01' FROM generate_series($1::int,$2::int) i CROSS JOIN (VALUES ('supplier'),('staff')) r(role)`, [from,to]);
  await clone('supplier_profiles', "original.user_id='supplier'", from,to, `'user_id',${id},'pickup_available',false`);
  await clone('staff_profiles', "original.user_id='staff'", from,to, `'user_id',${id},'updated_at',${old}`);
  await clone('staff_roles', "original.code='counter'", from,to, `'code',${id},'name',${id}`);
  await clone('staff_invites', "original.id='invite'", from,to, `'id',${id},'code_hash',${id},'created_at',${old}`);
  await clone('voucher_campaigns', "original.purpose='founding_tester'", from,to, `'id',${id},'purpose','manual','code',${id},'created_at',${old}`);
  await clone('vouchers', "original.client_id='client'", from,to, `'id',${id},'campaign_id',${id},'issued_at',${old},'expires_at','2030-01-01','status','available'`);
  await clone('supplier_services', "original.id='service_supplier'", from,to, `'id',${id},'position',10000+i`);
  const data = `jsonb_build_object('handover',jsonb_build_object('qrToken',${id},'escalation',jsonb_build_object('at',${old},'reason','Fixture')),
    'rescheduleRequest',jsonb_build_object('id',${id},'supplierId','supplier','status','pending','requestedAt',${old}))`;
  await clone('orders', "original.id='pickup_offer'", from,to, `'id',${id},'position',10000+i,'created_at',${old},'data',original.data||${data}`);
  await database.query(`INSERT INTO production_lapses(id,order_id,supplier_id,tier,deadline_at,detected_at,rate_bps,data)
    SELECT ${id},${id},'supplier','minor','2000-01-01','2000-01-01',500,'{"policy":{"deductionsEnabled":false},"warnings":[]}' FROM generate_series($1::int,$2::int) i`,[from,to]);
  await clone('refund_requests', "original.id='refund_hold'", from,to, `'id',${id},'order_id',${id},'created_at',${old}`);
  for (const [table, source] of [['claims','claim_unrelated'],['escalations','escalation_unrelated']]) {
    await clone(table, `original.id='${source}'`, from,to, `'id',${id},'order_id',${id},'position',10000+i,'created_at',${old}`);
  }
  await clone('season_windows', "original.id='season'", from,to, `'id',${id},'start_date','2000-01-01','end_date','2000-01-31'`);
  await database.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data)
    SELECT ${id},'client','general',now(),10000+i,'{}' FROM generate_series($1::int,$2::int) i`,[from,to]);
  await database.query(`INSERT INTO audit_log(id,at,action,position,data)
    SELECT ${id},now(),'benchmark.history',10000+i,'{}' FROM generate_series($1::int,$2::int) i`,[from,to]);
  await database.query(`INSERT INTO location_pings(id,order_id,rider_id,lat,lng,at,position,data)
    SELECT ${id},'z_history','rider',7,125,now(),10000+i,'{}' FROM generate_series($1::int,$2::int) i`,[from,to]);
  // The fixture is a completed bulk load, not concurrent ingestion. Refresh
  // statistics/visibility so count-only indexes model maintained production data.
  await database.query('VACUUM (ANALYZE)');
}

async function readers() {
  const out = {};
  for (const {label,path} of cases) {
    const url = new URL(path,'http://test'), {db,queries} = instrument(database);
    const store = await loadHotReadStore(db,'clerk_admin',url.pathname,{searchParams:url.searchParams});
    assert.ok(store[STAFF_LIST_PAGE].ids.length <= 20);
    const parent = queries.find(q => /LIMIT \$\d+/.test(q.sql));
    const plan = (await database.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${parent.sql}`, parent.values)).rows[0]['QUERY PLAN'][0];
    out[label] = { rows: queries.reduce((n,q)=>n+q.rows,0), queries:queries.length,
      parentPlan: { executionMs:plan['Execution Time'], nodes:[] } };
    const walk = node => { out[label].parentPlan.nodes.push({ type:node['Node Type'], index:node['Index Name'], rows:node['Actual Rows'], removed:node['Rows Removed by Filter'] || 0 }); (node.Plans || []).forEach(walk); };
    walk(plan.Plan);
  }
  return out;
}
async function measure(api, readOutput, scale) {
  const timings = {};
  for (const {label,path} of cases) {
    const warm = await api('admin','GET',path); assert.equal(warm.status,200,`${label}: ${JSON.stringify(warm.body)}`);
    await new Promise(resolve=>setTimeout(resolve,50));
    readOutput();
    for (let n=0;n<samples;n++) assert.equal((await api('admin','GET',path)).status,200,label);
    await new Promise(resolve=>setTimeout(resolve,50));
    const values = [...readOutput().matchAll(/\[gridgo-api\] GET (\S+) 200 (\d+)ms/g)]
      .filter(m=>m[1]===path.split('?')[0]).map(m=>Number(m[2])).sort((a,b)=>a-b);
    assert.equal(values.length,samples,path);
    timings[label]={medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};
  }
  const report={scale,rowsPerGrownTable:base*scale,samples,timings,reads:await readers()};
  console.log(JSON.stringify(report));
  return report;
}
try {
  await resetDatabase(database,'TRUNCATE staff_roles, voucher_campaigns, season_windows, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  await setupStaffDesks(database);
  let output='';
  // Observe, rather than disable, startup lifecycle work. Its real saves must
  // finish before SQL growth fixtures are inserted or they can compact their
  // artificial positions while the two sample populations are being built.
  const hook = `import {registerHooks} from 'node:module'; registerHooks({load(url,context,next){
    const result=next(url,context); if(!url.endsWith('/src/server.js'))return result;
    const source=String(result.source).replace('void runLifecycleWork();',
      'void runLifecycleWork().finally(()=>console.log("benchmark_startup_complete"));');
    if(source===String(result.source))throw new Error('Benchmark startup observer not installed');
    return {...result,source}; }});`;
  const api=await apiForTest({after:fn=>cleanup.push(fn)}, {NODE_OPTIONS:`--import=data:text/javascript,${encodeURIComponent(hook)}`,
    GRIDGO_FCM_SERVICE_ACCOUNT_FILE:'', GRIDGO_APNS_KEY_FILE:''}, {onOutput:chunk=>{output+=chunk;}});
  for(let n=0;!output.includes('benchmark_startup_complete');n++) {
    assert.ok(n<1200,'Startup lifecycle did not finish');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const readOutput=()=>{const result=output;output='';return result;};
  await grow(1,base); const before=await measure(api,readOutput,1);
  await grow(base+1,base*10); const after=await measure(api,readOutput,10);
  for(const {label} of cases) for(const field of ['rows','queries']) assert.equal(after.reads[label][field],before.reads[label][field],`${label}: ${field} budget grew`);
} finally {
  for(const close of cleanup.reverse()) await close();
  await database.close();
}
