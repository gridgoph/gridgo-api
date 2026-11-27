import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore,loadHotReadStore} from '../src/postgres-store.js';
import {setupVerification} from './fixtures/supplier-verification.js';
import {apiForTest} from './fixtures/reschedule-http.js';
import {id} from './fixtures/reschedule.js';
import {createPayoutMilestones} from '../src/operational-model.js';
import {shopMoneySettings} from '../src/shop-money-settings.js';
import {recordCounterCash,runShopSettlement,shopMoneyPaused} from '../src/shop-money.js';
const AT='2026-11-23T08:00:00.000Z';
async function setup(db) {
 await setupVerification(db,s=>{
  s.approvalCases.find(c=>c.userId==='supplier').status='approved';
  const o=s.orders[0];Object.assign(o,{orderType:'express',state:'delivered',payoutPlanVersion:4,createdAt:'2026-11-22T00:00:00.000Z',commercialCommittedAt:'2026-11-22T00:00:00.000Z'});
  o.expressOrder={version:1,originalSupplierId:'supplier',pickupCode:'123456',printSettings:[],events:[]};
  o.payoutMilestones=createPayoutMilestones(o,{version:4});
  s.settings.shopMoney={...shopMoneySettings(),weeklyNettingEnabled:true,overduePauseEnabled:true,launchedAt:null};
  s.files.push({fileId:'fee-proof',ownerId:'supplier',purpose:'shop_payment_receipt',state:'ready',objectKey:'private/fee-proof',originalFilename:'receipt.png',size:100,declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[]});
  recordCounterCash(s,{id:'cash-example',supplierId:'supplier',clientServiceFeeMinor:15000},{amountMinor:25000,reason:'Counter handover'},{at:'2026-11-22T01:00:00.000Z',id});
  runShopSettlement(s,{at:AT,id});
 });
}
test('weekly net, private receipt, owner control and confirmation persist atomically with bounded overdue reads',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env);t.after(()=>db.close());await setup(db);
 const api=await apiForTest(t),read=await api('supplier','GET','/me/shop-money');assert.equal(read.status,200,JSON.stringify(read.body));
 assert.equal(read.body.payGridgo.amountMinor,5000);assert.equal(read.body.balances.paused,true);
 assert.equal(shopMoneyPaused(await loadHotReadStore(db,'clerk_supplier','/auth/me/supplier'),'supplier'),true);
 const request=read.body.payGridgo.requestId,path=`/me/shop-money/payments/${request}/receipt`,body={amountMinor:5000,receiptFileId:'fee-proof',reference:'QR-EXAMPLE'};
 assert.equal((await api('other','POST',path,body, {headers:{'x-gridgo-role':'supplier','x-gridgo-shop-id':'supplier'}})).status,403);
 assert.equal((await api('client','GET','/files/fee-proof')).status,403);
 const submitted=await api('supplier','POST',path,body);assert.equal(submitted.status,200,JSON.stringify(submitted.body));
 assert.equal((await api('supplier','POST',path,body)).body.replayed,true);
 assert.equal((await api('ops','GET','/files/fee-proof')).status,200);
 assert.equal((await api('other','GET','/files/fee-proof',null,{headers:{'x-gridgo-role':'supplier','x-gridgo-shop-id':'supplier'}})).status,403);
 assert.equal((await api('ops','POST',`/ops/shop-money/payments/${request}/confirm`,{amountMinor:5000,reference:'QR-EXAMPLE',reason:'Receipt checked'})).status,200);
 assert.equal(shopMoneyPaused(await loadHotReadStore(db,'clerk_supplier','/auth/me/supplier'),'supplier'),false);
 const loaded=await loadStore(db);assert.ok(loaded.shopMoneyEvents.some(e=>e.kind==='payment_receipt'));
 assert.ok(loaded.notifications.some(n=>n.userId==='admin'&&n.type==='shop_money_receipt'));
 assert.equal(loaded.orders[0].payoutMilestones[0].amountMinor,10000);
 const before=(await db.query('SELECT count(*)::int AS n FROM shop_money_events')).rows[0].n;
 await assert.rejects(db.transaction(async()=>{const s=await loadStore(db);runShopSettlement(s,{at:'2026-11-30T08:00:00.000Z',id});await saveStore(db,s);throw new Error('abort');}),/abort/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM shop_money_events')).rows[0].n,before);
});
