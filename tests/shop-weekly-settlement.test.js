import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,id,actors} from './fixtures/reschedule.js';
import {createPayoutMilestones} from '../src/operational-model.js';
import {shopMoneySettings,validateShopMoneySettings} from '../src/shop-money-settings.js';
import {runShopSettlement,recordCounterCash,routeShopMoney,shopMoneyPaused,sweepShopMoney} from '../src/shop-money.js';
const AT='2026-11-23T08:00:00.000Z',ctx={at:AT,id,actor:actors.ops};
function setup(qr=21000,cashFee=34000) {
 const s=fixture(),o=s.orders[0];
 s.settings.shopMoney={...shopMoneySettings(),weeklyNettingEnabled:true,overduePauseEnabled:true,launchedAt:null};
 Object.assign(o,{orderType:'express',state:'delivered',payoutPlanVersion:4,supplierSubtotalMinor:qr,supplierPlatformPayoutMinor:qr,commercialCommittedAt:'2026-11-22T00:00:00.000Z',createdAt:'2026-11-22T00:00:00.000Z'});
 o.payoutMilestones=createPayoutMilestones(o,{version:4});o.paymentAllocations=[{paymentCode:'initial',component:'supplier_principal',amountMinor:qr}];
 const cash=structuredClone(o);Object.assign(cash,{id:'cash-order',paymentMethod:'counter_cash',clientPayment:{methods:['counter_cash']},supplierPlatformPayoutMinor:0,serviceFeeMinor:cashFee,totalMinor:cashFee+10000});s.orders.push(cash);
 recordCounterCash(s,cash,{amountMinor:cash.totalMinor,reason:'Counter handover'},{...ctx,at:'2026-11-22T01:00:00.000Z'});
 return s;
}
const call=(s,path,body={},user=actors.ops,at=AT,method='POST')=>routeShopMoney({req:{method},url:new URL(path,'http://api.test'),store:s,user,readBody:async()=>body,now:()=>at,id});
test('weekly netting uses cash handover fees and releasable QR earnings once, with Monday Manila due time',()=>{
 const s=setup(),run=runShopSettlement(s,ctx),shop=run.data.shops.find(x=>x.supplierId==='supplier');
 assert.equal(run.data.weekly,true);assert.equal(shop.amountMinor,0);assert.equal(shop.offsetMinor,21000);
 const request=s.shopMoneyEvents.find(e=>e.kind==='pay_request');assert.equal(request.data.amountMinor,13000);
 assert.equal(request.data.deadlineAt,'2026-11-23T15:59:59.999Z');
 assert.equal(runShopSettlement(s,{...ctx,at:'2026-11-24T08:00:00.000Z'}).id,run.id);
 assert.equal(s.shopMoneyEvents.filter(e=>e.kind==='pay_request').length,1);
 assert.equal(shopMoneyPaused(s,'supplier','2026-11-23T15:59:59.999Z'),false);
 assert.equal(shopMoneyPaused(s,'supplier','2026-11-23T16:00:00.000Z'),true);
 s.settings.shopMoney.overduePauseEnabled=false;assert.equal(shopMoneyPaused(s,'supplier','2026-11-23T16:00:00.000Z'),false);
});
test('weekly run pays a QR surplus and held principal cannot erase a cash balance',()=>{
 const s=setup(50000,34000),row=runShopSettlement(s,ctx).data.shops.find(x=>x.supplierId==='supplier');
 assert.equal(row.amountMinor,16000);assert.equal(row.offsetMinor,34000);
 const held=setup();held.orders[0].payoutHold=true;
 runShopSettlement(held,ctx);assert.equal(held.shopMoneyEvents.find(e=>e.kind==='pay_request').data.amountMinor,34000);
});
test('receipt submission is private, owner-only, idempotent, and only staff confirmation reopens overdue work',async()=>{
 const s=setup();runShopSettlement(s,ctx);const request=s.shopMoneyEvents.find(e=>e.kind==='pay_request');
 s.files.push({fileId:'fee-proof',ownerId:'supplier',purpose:'shop_payment_receipt',state:'ready',references:[]});
 const path=`/me/shop-money/payments/${request.id}/receipt`,body={receiptFileId:'fee-proof',reference:'PAY-EXAMPLE',amountMinor:13000};
 await assert.rejects(call(s,path,body,{...actors.supplier,shopRole:'staff'}),e=>e.status===403);
 const sent=await call(s,path,body,actors.supplier,'2026-11-24T00:00:00.000Z');
 assert.equal(sent.body.receipt.reviewBy,'2026-11-24T00:03:00.000Z');
 assert.equal((await call(s,path,body,actors.supplier)).body.replayed,true);
 assert.equal(shopMoneyPaused(s,'supplier','2026-11-24T00:01:00.000Z'),true);
 await assert.rejects(call(s,`/ops/shop-money/payments/${request.id}/confirm`,{amountMinor:13000,reference:'DIFFERENT',reason:'Checked'}),e=>e.code==='shop_payment_receipt_required');
 await call(s,`/ops/shop-money/payments/${request.id}/confirm`,{amountMinor:13000,reference:'PAY-EXAMPLE',reason:'Checked'},actors.ops,'2026-11-24T00:02:00.000Z');
 assert.equal(shopMoneyPaused(s,'supplier','2026-11-24T00:02:00.000Z'),false);
});
test('receipt review clocks start at the next review opening outside office hours',async()=>{
 const s=setup();runShopSettlement(s,ctx);const request=s.shopMoneyEvents.find(e=>e.kind==='pay_request');
 s.files.push({fileId:'fee-proof',ownerId:'supplier',purpose:'shop_payment_receipt',state:'ready',references:[]});
 const r=await call(s,`/me/shop-money/payments/${request.id}/receipt`,{receiptFileId:'fee-proof',reference:'AFTER-HOURS',amountMinor:13000},actors.supplier,'2026-11-23T10:00:00.000Z');
 assert.equal(r.body.receipt.reviewBy,'2026-11-24T00:03:00.000Z');
});
test('new money settings validate integers, clocks, weekdays and production release defaults',()=>{
 assert.equal(shopMoneySettings({}, {NODE_ENV:'production'}).weeklyNettingEnabled,false);
 assert.equal(shopMoneySettings({}, {NODE_ENV:'development'}).weeklyNettingEnabled,true);
 assert.equal(shopMoneySettings({}, {NODE_ENV:'test'}).overduePauseEnabled,true);
 for(const patch of [{weeklyDueWeekday:7},{weeklyDueTime:'24:00'},{missedJobLimit:0},{demandAlertsPerDay:1.5},{reviewMinutes:0},{reviewOpens:'18:00',reviewCloses:'17:00'},{openMinutes:[0]},{weeklyNettingEnabled:'yes'}])
  assert.throws(()=>validateShopMoneySettings({shopMoney:patch}));
});

test('cash and QR work after the weekly cutoff wait for the following period without reducing scheduled items',()=>{
 const s=setup(50000,34000),run=runShopSettlement(s,ctx),before=structuredClone(run);
 const cash={id:'later-cash',supplierId:'supplier',clientServiceFeeMinor:7000};
 recordCounterCash(s,cash,{amountMinor:17000,reason:'Later handover'},{...ctx,at:'2026-11-23T08:01:00.000Z'});
 assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='recovery_due').reduce((n,e)=>n+e.amountMinor,0),34000);
 const qr=structuredClone(s.orders[0]);qr.id='new-week-qr';qr.createdAt='2026-11-23T07:00:00.000Z';qr.commercialCommittedAt=qr.createdAt;s.orders.push(qr);
 assert.deepEqual(runShopSettlement(s,{...ctx,at:'2026-11-24T08:00:00.000Z'}),before);
 const next=runShopSettlement(s,{...ctx,at:'2026-11-30T08:00:00.000Z'});
 assert.equal(next.data.shops.find(x=>x.supplierId==='supplier').cashFeesMinor,7000);
 assert.deepEqual(run,before);
});
test('receipt review breach creates one durable escalation per receipt',async()=>{
 const s=setup();runShopSettlement(s,ctx);const request=s.shopMoneyEvents.find(e=>e.kind==='pay_request');
 s.files.push({fileId:'fee-proof',ownerId:'supplier',purpose:'shop_payment_receipt',state:'ready',references:[]});
 await call(s,`/me/shop-money/payments/${request.id}/receipt`,{receiptFileId:'fee-proof',reference:'WAITING',amountMinor:13000},actors.supplier,'2026-11-24T00:00:00.000Z');
 sweepShopMoney(s,{...ctx,at:'2026-11-24T00:03:00.000Z'});sweepShopMoney(s,{...ctx,at:'2026-11-24T00:04:00.000Z'});
 for(const userId of ['ops','admin'])assert.equal(s.notifications.filter(n=>n.type==='shop_money_review_overdue'&&n.userId===userId).length,1);
});
