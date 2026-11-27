import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore,loadHotReadStore} from '../src/postgres-store.js';
import {setupVerification} from './fixtures/supplier-verification.js';
import {apiForTest} from './fixtures/reschedule-http.js';
import {id} from './fixtures/reschedule.js';
import {createPayoutMilestones} from '../src/operational-model.js';
import {shopMoneySettings} from '../src/shop-money-settings.js';
import {syncShopMoney,runShopSettlement,shopMoneyBalances} from '../src/shop-money.js';
const AT='2026-11-23T08:00:00.000Z';
async function setup(db,configure=()=>{}) {
 await setupVerification(db,s=>{
  const o=s.orders[0];o.orderType='express';o.expressOrder={version:1,originalSupplierId:'supplier',pickupCode:'123456',printSettings:[],events:[]};o.state='delivered';o.payoutPlanVersion=4;o.createdAt='2026-11-23T00:00:00.000Z';o.payoutMilestones=createPayoutMilestones(o,{version:4});
  s.settings.supplierVerification.payoutCapMinor=50000;s.settings.shopMoney={...shopMoneySettings(),launchedAt:'2026-11-23T00:00:00.000Z'};
  s.files.push({fileId:'qr',ownerId:'supplier',purpose:'supplier_payout_qr',state:'ready',objectKey:'private/qr',originalFilename:'qr.png',size:100,declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[]});
  s.supplierPayoutAccounts=[{supplierId:'supplier',provider:'other',accountName:'Fixture shop',qrFileId:'qr',version:1,updatedAt:AT}];
  s.files.push({fileId:'receipt',ownerId:'ops',purpose:'payout_receipt',state:'ready',objectKey:'private/receipt',originalFilename:'receipt.png',size:100,declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[]});
  configure(s);syncShopMoney(s,{at:AT,id});runShopSettlement(s,{at:AT,id});
 });
}
test('PostgreSQL daily transfer persists once with evidence, bonus cap accounting, private reads and mixed-version upsert safety',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env);t.after(()=>db.close());await setup(db);
 let output='';const call=await apiForTest(t,{}, {onOutput:chunk=>{output+=chunk;}});
 const read=await call('supplier','GET','/me/shop-money');assert.equal(read.status,200);assert.equal(read.body.balances.owedMinor,12000);
 assert.equal((await call('other','GET','/me/shop-money',null,{headers:{'x-gridgo-role':'supplier','x-gridgo-shop-id':'supplier'}})).status,403);
 assert.equal((await call('client','GET','/ops/shop-money')).status,403);
 const staff=await call('ops','GET','/ops/shop-money');assert.equal(staff.status,200);
 const run=staff.body.runs[0];
 const preparePath=`/ops/shop-money/runs/${run.id}/shops/supplier/prepare`;
 const prepared=await call('ops','POST',preparePath,{});assert.equal(prepared.status,200,JSON.stringify(prepared.body)+output);
 const transfer=prepared.body.transfer;assert.equal(transfer.data.netAmountMinor,12000);
 const replay=await call('ops','POST',preparePath,{});assert.equal(replay.body.transfer.id,transfer.id);
 assert.equal((await call('ops','POST','/orders/order/milestones/delivered/release',{})).body.error,'shop_money_transfer_route_required');
 const locked=await call('supplier','DELETE','/me/payout-account');assert.equal(locked.body.error,'shop_money_destination_locked');
 const bad=await call('ops','POST',`/ops/shop-money/transfers/${transfer.id}/confirm`,{amountMinor:12001,reason:'Verify',fundsSentConfirmed:true});assert.equal(bad.status,409);
 const paidAt=new Date().toISOString(),body={amountMinor:12000,reference:'DAILY-001',receiptFileId:'receipt',fundsSentConfirmed:true,paidAt,reason:'Verified transfer'};
 const paid=await call('ops','POST',`/ops/shop-money/transfers/${transfer.id}/confirm`,body);assert.equal(paid.status,200,JSON.stringify(paid.body));
 const paidAgain=await call('ops','POST',`/ops/shop-money/transfers/${transfer.id}/confirm`,body);assert.equal(paidAgain.body.replayed,true);
 const loaded=await loadStore(db);assert.equal(shopMoneyBalances(loaded,'supplier',AT).owedMinor,0);
 const capacity=await db.query("SELECT sum(amount_minor)::bigint AS amount FROM supplier_verification_capacity_items WHERE supplier_id='supplier'");assert.equal(capacity.rows[0].amount,12000);
 const entryCount=loaded.shopMoneyLedger.length;
 await db.transaction(async()=>{const s=await loadStore(db);syncShopMoney(s,{at:AT,id});await saveStore(db,s);});
 assert.equal((await loadStore(db)).shopMoneyLedger.length,entryCount);
 await assert.rejects(db.transaction(()=>db.query("UPDATE shop_money_ledger SET owed_delta_minor=1")),/immutable/);
 await assert.rejects(db.transaction(()=>db.query("DELETE FROM shop_money_events")),/immutable/);
 // Historical upsert shape can update a new-release order without proposing any new required column.
 await db.transaction(()=>db.query("UPDATE orders SET data=data-'clientPayment'-'shopLaunchBonus' WHERE id='order'"));
 await db.transaction(async()=>{const s=await loadStore(db);syncShopMoney(s,{at:AT,id});await saveStore(db,s);});
 assert.equal((await loadStore(db)).orders[0].clientPayment.methods[0],'in_app_qr');
});
test('PostgreSQL holds and recovery feed the settlement net without changing published principal',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env);t.after(()=>db.close());
 const {recordShopRecovery}=await import('../src/supplier-verification.js');
 await setup(db,s=>{recordShopRecovery(s,'supplier','previous-job',3000,{at:AT,id,actor:s.users.find(u=>u.id==='ops')},{debt:true});});
 const call=await apiForTest(t),read=await call('ops','GET','/ops/shop-money'),run=read.body.runs[0];
 assert.equal(run.data.shops.find(s=>s.supplierId==='supplier').availableMinor,9000);
 assert.equal(run.data.shops.find(s=>s.supplierId==='supplier').rolloverMinor,9000);
 assert.equal((await loadStore(db)).orders[0].payoutMilestones[0].amountMinor,10000);
});
test('manual Pay GRIDGO confirmation persists a deadline hold and reopens immediately; only Super Admin edits money settings',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env);t.after(()=>db.close());
 await setup(db,s=>{s.approvalCases.find(c=>c.userId==='supplier').status='approved';});
 const {routeShopMoney}=await import('../src/shop-money.js');const {recordShopRecovery}=await import('../src/supplier-verification.js');
 const past='2026-11-20T08:00:00.000Z';
 await db.transaction(async()=>{
  const s=await loadStore(db);s.settings.paymentQrFileId='qr';
  await routeShopMoney({req:{method:'PATCH'},url:new URL('http://api.test/ops/shop-money/shops/supplier/policy'),store:s,user:s.users.find(u=>u.id==='admin'),readBody:async()=>({expectedVersion:0,counterCashEnabled:true,reason:'Reviewed rollout'}),now:()=>past,id});
  recordShopRecovery(s,'supplier','counter-cash',25000,{at:past,id,actor:s.users.find(u=>u.id==='ops')},{debt:true});syncShopMoney(s,{at:past,id});runShopSettlement(s,{at:past,id});await saveStore(db,s);
 });
 const api=await apiForTest(t),mine=await api('supplier','GET','/me/shop-money');assert.equal(mine.status,200);assert.equal(mine.body.balances.paused,true);
 assert.equal(mine.body.payGridgo.amountMinor,13000);
 const disabled=await api('admin','PATCH','/ops/shop-money/shops/supplier/policy',{expectedVersion:1,counterCashEnabled:false,reason:'Stop future counter collections'});
 assert.equal(disabled.status,200);
 const {shopMoneyPaused}=await import('../src/shop-money-policy.js');
 assert.equal(shopMoneyPaused(await loadHotReadStore(db,'clerk_supplier','/auth/me/supplier'),'supplier'),true,'bounded supplier reads retain an issued hold with counter cash disabled');
 const settings=await api('admin','GET','/settings');
 const update={expectedVersion:settings.body.version,reason:'Reviewed minimum',shopMoney:{minimumMinor:15000}};
 assert.equal((await api('ops','PATCH','/settings',update)).status,403);
 const changed=await api('admin','PATCH','/settings',update);assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(changed.body.settings.shopMoney.payoutTime,'16:00');
 const body={amountMinor:13000,reference:'incoming-001',reason:'Bank verified'};
 const confirmed=await api('ops','POST',`/ops/shop-money/payments/${mine.body.payGridgo.requestId}/confirm`,body);assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
 const reloaded=await api('supplier','GET','/me/shop-money');assert.equal(reloaded.body.balances.paused,false);assert.equal(reloaded.body.payGridgo,null);
 assert.equal(shopMoneyPaused(await loadHotReadStore(db,'clerk_supplier','/auth/me/supplier'),'supplier'),false);
 assert.equal(reloaded.body.balances.owingMinor,12000);
 assert.equal((await api('ops','POST',`/ops/shop-money/payments/${mine.body.payGridgo.requestId}/confirm`,body)).body.replayed,true);
});
test('historical runtime cannot separately prepare, record or cancel an active daily batch item',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env);t.after(()=>db.close());await setup(db,s=>s.files.push({fileId:'admin-receipt',ownerId:'admin',purpose:'payout_receipt',state:'ready',objectKey:'private/admin-receipt',originalFilename:'receipt.png',size:100,declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[]}));
 const api=await apiForTest(t),read=await api('ops','GET','/ops/shop-money'),run=read.body.runs[0];
 const transfer=(await api('ops','POST',`/ops/shop-money/runs/${run.id}/shops/supplier/prepare`,{})).body.transfer;
 assert.equal(transfer.data.netAmountMinor,12000);
 const {saveParityApi}=await import('./fixtures/save-parity.js');
 let oldOutput='';
 const old=await saveParityApi(t,false,{sourceRef:'5bc15b6502c5d14675b069c03880b63f57d9114c',timing:true,onOutput:chunk=>{oldOutput+=chunk;}});
 const preparation=await old('ops','POST','/orders/order/milestones/delivered/prepare',{});
 assert.equal(preparation.status,403,'old payer must not receive a second ready instruction');
 const item=transfer.data.items.find(i=>i.key==='stage:order:delivered');
 const partial=await old('admin','POST','/orders/order/milestones/delivered/release',{amountMinor:10000,attemptId:item.attemptId,reference:'LEGACY-PARTIAL',receiptFileId:'admin-receipt'});
 assert.notEqual(partial.status,200,'even an old privileged writer cannot partially record the batch');
 assert.match(oldOutput,/shop_money_transfer_route_required/,'the database batch guard, not an unrelated failure, rejects the historical recording');
 oldOutput='';
 const cancellation=await old('admin','POST','/orders/order/payout-reservations/cancel',{payoutKey:item.key,attemptId:item.attemptId,noFundsSentConfirmed:true,reason:'Legacy cancellation'});
 assert.notEqual(cancellation.status,200,'old privileged cancellation must preserve the whole batch');
 assert.match(oldOutput,/shop_money_transfer_route_required/);
 assert.notEqual((await loadStore(db)).orders[0].payoutMilestones[0].status,'released');
 const confirmation=await api('ops','POST',`/ops/shop-money/transfers/${transfer.id}/confirm`,{amountMinor:12000,reference:'WHOLE-BATCH',receiptFileId:'receipt',fundsSentConfirmed:true,paidAt:new Date().toISOString(),reason:'Verified whole transfer'});
 assert.equal(confirmation.status,200,JSON.stringify(confirmation.body));assert.equal(shopMoneyBalances(await loadStore(db),'supplier',AT).owedMinor,0);
});

test('scheduled run amounts survive later cash fees, including a historical writer attempt',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env);t.after(()=>db.close());await setup(db);
 const {recordShopRecovery,prepareVerificationPayout}=await import('../src/supplier-verification.js');
 const {routeShopMoney}=await import('../src/shop-money.js');
 await db.transaction(async()=>{const s=await loadStore(db);recordShopRecovery(s,'supplier','later-cash-fee',5000,{at:AT,id},{debt:true});await saveStore(db,s);});
 await assert.rejects(db.transaction(async()=>{
  const s=await loadStore(db),events=s.shopMoneyEvents;s.shopMoneyEvents=[];
  prepareVerificationPayout(s,s.orders[0],{key:'stage:order:delivered',amountMinor:10000,at:AT,id,actor:s.users.find(u=>u.id==='ops')});
  s.shopMoneyEvents=events;await saveStore(db,s);
 }),/scheduled_payout_reconciliation_required/);
 await db.transaction(async()=>{
  const s=await loadStore(db),run=s.shopMoneyEvents.find(e=>e.kind==='settlement_run');
  const call=()=>routeShopMoney({req:{method:'POST'},url:new URL(`http://api.test/ops/shop-money/runs/${run.id}/shops/supplier/prepare`),store:s,user:s.users.find(u=>u.id==='ops'),readBody:async()=>({}),now:()=>AT,id,database:db});
  assert.equal((await call()).body.transfer.data.netAmountMinor,12000);
  assert.equal((await call()).body.transfer.data.netAmountMinor,12000);
  await saveStore(db,s);
 });
});
