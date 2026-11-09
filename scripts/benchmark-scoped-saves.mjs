/** Destructive, isolated test DB only. Server request-log timings and 10x
 * unrelated-history query/row invariants for match and draft line saves. */
import './assert-test-database.mjs';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadClientSaveStore } from '../src/postgres-store.js';
import { assertStoredSupplementUnique, assertStoredOrderPaymentGuards } from '../src/save-guards.js';
import { instrument } from '../tests/fixtures/order-reads.js';
import { setupSaveParity, saveParityApi } from '../tests/fixtures/save-parity.js';
import { AT } from '../tests/fixtures/reschedule.js';
const db=createDatabase(process.env),cleanup=[];
const t={after:fn=>cleanup.push(fn)};
const samples=Number(process.env.PERF_SAMPLES||5);
let logs='';
const stats=values=>{const sorted=values.slice().sort((a,b)=>a-b);return {median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],samples:sorted.length};};
async function grow(from,to){
  await db.query(`INSERT INTO notifications(id,user_id,type,created_at,position,data) SELECT 'save_perf_notice_'||i,'other','history',$3,i,jsonb_build_object('title','Historical notice','body',repeat('x',100)) FROM generate_series($1::int,$2::int)i`,[from,to,AT]);
  await db.query(`INSERT INTO audit_log(id,at,action,position,data) SELECT 'save_perf_audit_'||i,$3,'benchmark.history',i,jsonb_build_object('detail',repeat('x',100)) FROM generate_series($1::int,$2::int)i`,[from,to,AT]);
  await db.query(`INSERT INTO location_pings(id,order_id,rider_id,lat,lng,at,position) SELECT 'save_perf_ping_'||i,'unrelated','rider',7,125,$3,i FROM generate_series($1::int,$2::int)i`,[from,to,AT]);
  await db.query(`INSERT INTO notification_push_outbox(notification_id,device_id,user_id,status) SELECT 'save_perf_notice_'||i,'save_perf_device','other','delivered' FROM generate_series($1::int,$2::int)i`,[from,to]);
  await db.query('ANALYZE');
}
async function budget(){return db.transaction(async()=>{
  const {db:traced,queries}=instrument(db);
  await loadClientSaveStore(traced,'clerk_client','/me/matches',{subcategoryCode:'flyers'});
  await assertStoredSupplementUnique(traced);await assertStoredOrderPaymentGuards(traced);
  assert.ok(!queries.some(q=>/FROM (audit_log|location_pings|notification_push_outbox)\b/.test(q.sql)));
  return {queries:queries.length,rows:queries.reduce((sum,q)=>sum+q.rows,0),sql:queries.map(q=>q.sql)};
});}
async function measure(api){
  logs='';
  for(let i=0;i<samples+1;i++){
    for(const [method,path,body] of [['POST','/me/matches',{subcategoryCode:'flyers'}],['POST','/me/matches/next',{subcategoryCode:'flyers',excludedSupplierIds:['supplier']}],['PATCH','/me/carts/save_cart/lines/save_line',{quantity:20+i}]]){
      const r=await api('client',method,path,body);assert.equal(r.status,200,JSON.stringify(r.body));
    }
    const added=await api('client','POST','/me/carts/save_cart/lines',{catalogItemId:'item_supplier',optionIds:[],quantity:5});assert.equal(added.status,201,JSON.stringify(added.body));
    const newLine=added.body.cart.lines.find(line=>line.id!=='save_line');assert.ok(newLine);
    assert.equal((await api('client','DELETE',`/me/carts/save_cart/lines/${newLine.id}`)).status,200);
  }
  // stdout delivery may follow the HTTP finish by one event-loop turn.
  await new Promise(resolve=>setTimeout(resolve,25));
  const grouped={};
  for(const match of logs.matchAll(/\[gridgo-api\] (POST|PATCH|DELETE) (\S+) (\d+) (\d+)ms/g)){
    const key=match[1]+' '+match[2].replace(/\/lines\/[^/]+$/,'/lines/:id');(grouped[key]||=[]).push(Number(match[4]));
  }
  return Object.fromEntries(Object.entries(grouped).map(([key,values])=>[key,stats(values.slice(1))]));
}
try{
  await setupSaveParity(db);
  await db.query(`INSERT INTO founding_testers(client_id,added_at) VALUES('client',$1) ON CONFLICT(client_id) DO UPDATE SET added_at=EXCLUDED.added_at`,[AT]);
  await db.query(`INSERT INTO device_tokens(id,user_id,token,platform,created_at,updated_at,position,data) VALUES('save_perf_device','other','save_perf_token','android',$1,$1,0,'{"appRole":"client"}')`,[AT]);
  const api=await saveParityApi(t,false,{timing:true,onOutput:chunk=>{logs+=chunk;}});
  let first;
  for(const [label,from,to]of [['1x',1,10000],['10x',10001,100000]]){
    await grow(from,to);await db.query('TRUNCATE client_match_selections');
    const current=await budget();if(first)assert.deepEqual(current,first,'unrelated 10x history must not change query/row budget');else first=current;
    console.log(JSON.stringify({label,historyRowsPerTable:to,budget:{queries:current.queries,rows:current.rows},timings:await measure(api)}));
    if(process.env.PERF_BASELINE==='1'){
      const full=await saveParityApi(t,true,{timing:true,onOutput:chunk=>{logs+=chunk;}});logs='';
      assert.equal((await full('client','POST','/me/matches',{subcategoryCode:'flyers'})).status,200);await new Promise(resolve=>setTimeout(resolve,25));
      console.log(JSON.stringify({label,fullSaveRequestLogs:logs.split('\n').filter(line=>line.startsWith('[gridgo-api]'))}));
    }
  }
}finally{for(const fn of cleanup.reverse())await fn();await db.close();}
