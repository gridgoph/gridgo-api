import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,id,actors} from './fixtures/reschedule.js';
import {syncShopMoney,shopMoneyBalances,runShopSettlement,sweepShopMoney,routeShopMoney,clientPaymentSnapshot,shopMoneyPaused} from '../src/shop-money.js';
import {shopMoneySettings,validateShopMoneySettings,nextShopPayout} from '../src/shop-money-settings.js';
import {recordShopRecovery,verificationSummary,prepareVerificationPayout,completeVerificationPayout} from '../src/supplier-verification.js';
import {supplierMatchBlockersFor} from '../src/supplier-eligibility.js';
import {defaultOperationalSettings,deliverySplit,createPayoutMilestones,publicOrderFor} from '../src/operational-model.js';
const AT='2026-11-23T08:00:00.000Z',ctx={at:AT,id,actor:actors.ops};
function setup({amount=30000,bonus=false}={}) {
 const s=fixture(),o=s.orders[0];o.createdAt='2026-11-23T00:00:00.000Z';o.commercialCommittedAt=o.createdAt;
 o.supplierPlatformPayoutMinor=amount;o.supplierSubtotalMinor=amount;o.orderType='express';o.state='delivered';o.payoutPlanVersion=4;
 o.payoutMilestones=createPayoutMilestones(o,{version:4});o.payments.initial.amountMinor=amount;o.paymentAllocations=[{paymentCode:'initial',component:'supplier_principal',amountMinor:amount}];
 s.settings.shopMoney={...shopMoneySettings(),launchedAt:bonus?'2026-11-23T00:00:00.000Z':'2027-01-01T00:00:00.000Z'};
 s.files.push({fileId:'qr',ownerId:'supplier',purpose:'supplier_payout_qr',state:'ready',objectKey:'private/qr',references:[]});
 s.supplierPayoutAccounts=[{supplierId:'supplier',provider:'other',accountName:'Shop',qrFileId:'qr',version:1,updatedAt:AT}];
 return s;
}
const call=(store,path,body={},actor=actors.ops,at=AT,method='POST')=>routeShopMoney({req:{method,headers:{}},url:new URL(path,'http://api.test'),store,user:actor,readBody:async()=>body,now:()=>at,id});
function receipt(s){s.files.push({fileId:'receipt',ownerId:'ops',purpose:'payout_receipt',state:'ready',objectKey:'private/receipt',references:[]});}
const rowFor=run=>run.data.shops.find(s=>s.supplierId==='supplier');

test('ledger accrual, actual payouts, both balances and recovery offsets are idempotent',()=>{
 const s=setup();syncShopMoney(s,ctx);assert.equal(shopMoneyBalances(s,'supplier',AT).owedMinor,30000);
 recordShopRecovery(s,'supplier','fault',5000,ctx,{debt:true});syncShopMoney(s,ctx);
 assert.equal(shopMoneyBalances(s,'supplier',AT).owingMinor,5000);
 const o=s.orders[0],p=prepareVerificationPayout(s,o,{...ctx,key:'stage:order:delivered',amountMinor:30000});assert.equal(p.netAmountMinor,25000);
 completeVerificationPayout(s,o,p,ctx);o.payoutMilestones[0].status='released';syncShopMoney(s,ctx);
 const before=s.shopMoneyLedger.length;syncShopMoney(s,ctx);assert.equal(s.shopMoneyLedger.length,before);
 assert.equal(shopMoneyBalances(s,'supplier',AT).owedMinor,0);assert.equal(shopMoneyBalances(s,'supplier',AT).owingMinor,0);
 assert.equal(s.auditLog.filter(e=>e.action.startsWith('shop_money.')).length,s.shopMoneyLedger.length+s.shopMoneyEvents.length);
});
test('4 PM Manila business day, holiday, and configurable calendar',()=>{
 const s=setup();assert.equal(runShopSettlement(s,{...ctx,at:'2026-11-23T07:59:59Z'}),null);
 assert.equal(runShopSettlement(s,{...ctx,at:'2026-11-22T08:00:00Z'}),null);
 s.settings.shopMoney.holidays=['2026-11-23'];assert.equal(runShopSettlement(s,ctx),null);
 s.settings.shopMoney.extraBusinessDates=['2026-11-23'];assert.ok(runShopSettlement(s,ctx));
 assert.equal(nextShopPayout(s.settings,AT),'2026-11-24T08:00:00.000Z');
});
test('minimum and roll-over count the combined shop amount; retry never duplicates a run or notice',()=>{
 const s=setup({amount:9000});syncShopMoney(s,ctx);const run=runShopSettlement(s,ctx);
 assert.equal(rowFor(run).amountMinor,0);assert.equal(rowFor(run).rolloverMinor,9000);
 const notices=s.notifications.length;assert.equal(runShopSettlement(s,ctx),run);assert.equal(s.notifications.length,notices);
 const next=structuredClone(s.orders[0]);next.id='second';next.supplierPlatformPayoutMinor=5000;next.payoutMilestones[0].amountMinor=5000;next.paymentAllocations[0].amountMinor=5000;s.orders.push(next);
 syncShopMoney(s,ctx);const tomorrow=runShopSettlement(s,{...ctx,at:'2026-11-24T08:00:00Z'});
 assert.equal(rowFor(tomorrow).amountMinor,14000);assert.equal(rowFor(tomorrow).items.length,2);
});
test('launch bonus: 20%, seven days, cap per shop, per-job snapshot and legacy exclusion',()=>{
 const s=setup({amount:200000,bonus:true});syncShopMoney(s,ctx);assert.equal(s.orders[0].shopLaunchBonus.amountMinor,40000);
 for(const [name,date,amount] of [['two','2026-11-24',100000],['three','2026-11-25',100000],['late','2026-11-30',100000]]) {
  const o=structuredClone(s.orders[0]);o.id=name;o.createdAt=`${date}T00:00:00.000Z`;o.supplierPlatformPayoutMinor=amount;o.payoutMilestones[0].amountMinor=amount;s.orders.push(o);
 }
 syncShopMoney(s,ctx);assert.deepEqual(s.orders.map(o=>o.shopLaunchBonus.amountMinor),[40000,10000,0,0]);
 s.settings.shopMoney.bonusRateBps=5000;syncShopMoney(s,ctx);assert.equal(s.orders[0].shopLaunchBonus.amountMinor,40000);
 const old=setup();syncShopMoney(old,ctx);assert.equal(old.orders[0].shopLaunchBonus,null);
});
test('regular stages keep their gross split, proof and claim holds; verification cap is respected',()=>{
 const s=setup(),o=s.orders[0];o.orderType='regular';o.payoutPlanVersion=2;o.state='production';o.payoutMilestones=createPayoutMilestones(o,{version:2});
 const amounts=o.payoutMilestones.map(m=>m.amountMinor);syncShopMoney(s,ctx);
 assert.equal(rowFor(runShopSettlement(s,ctx)).amountMinor,0);
 assert.deepEqual(o.payoutMilestones.map(m=>m.amountMinor),amounts);
 const cap=setup();cap.approvalCases.find(c=>c.userId==='supplier').status='pending';cap.settings.supplierVerification={payoutCapMinor:20000,windowDays:30};
 syncShopMoney(cap,ctx);const row=rowFor(runShopSettlement(cap,ctx));assert.equal(row.amountMinor,0);assert.equal(row.held[0].reason,'verification_payout_cap');
 const hold=setup();hold.orders[0].payoutHold=true;assert.equal(rowFor(runShopSettlement(hold,ctx)).amountMinor,0);
});
test('daily transfer reservation, payment evidence, unknown status, idempotent paid retry',async()=>{
 const s=setup({bonus:true});syncShopMoney(s,ctx);const run=runShopSettlement(s,ctx);receipt(s);
 const path=`/ops/shop-money/runs/${run.id}/shops/supplier/prepare`;
 const prepared=await call(s,path);const transfer=prepared.body.transfer;assert.equal(transfer.data.netAmountMinor,36000);
 assert.equal((await call(s,path)).body.transfer.id,transfer.id);
 await assert.rejects(call(s,path,{},actors.admin),e=>e.code==='verification_payer_required');
 await call(s,`/ops/shop-money/transfers/${transfer.id}/unknown`,{reason:'Checking bank'});
 const pay={amountMinor:36000,reference:'REF-001',receiptFileId:'receipt',fundsSentConfirmed:true,paidAt:AT,reason:'Bank verified'};
 await call(s,`/ops/shop-money/transfers/${transfer.id}/confirm`,pay);
 assert.equal(shopMoneyBalances(s,'supplier',AT).owedMinor,0);
 assert.equal((await call(s,`/ops/shop-money/transfers/${transfer.id}/confirm`,pay)).body.replayed,true);
 await assert.rejects(call(s,`/ops/shop-money/transfers/${transfer.id}/confirm`,{...pay,reference:'OTHER'}),e=>e.code==='transfer_reconciliation_required');
});
test('unverified bonus and stages share the cumulative cap',()=>{
 const s=setup({amount:30000,bonus:true});s.approvalCases.find(c=>c.userId==='supplier').status='pending';s.settings.supplierVerification.payoutCapMinor=32000;
 const row=rowFor(runShopSettlement(s,ctx));assert.equal(row.amountMinor,30000);assert.ok(row.held.some(i=>i.key==='bonus:order:supplier'&&i.reason==='verification_payout_cap'));
});
test('new deliveries default to 80%; existing snapshots stay at accepted rates',()=>{
 const s=setup();const old=structuredClone(s.orders[0]);assert.equal(defaultOperationalSettings().riderCommissionBps,8000);
 assert.deepEqual(deliverySplit(8900,defaultOperationalSettings().riderCommissionBps),{riderCommissionBps:8000,riderPayoutMinor:7120,platformDeliveryShareMinor:1780});
 s.settings.riderCommissionBps=8000;syncShopMoney(s,ctx);assert.equal(s.orders[0].riderCommissionBps,old.riderCommissionBps);
});
test('payment classification retains voucher + QR and cash facts',()=>{
 assert.deepEqual(clientPaymentSnapshot({voucherDiscountMinor:500}).methods,['in_app_qr','voucher']);
 assert.deepEqual(clientPaymentSnapshot({coversOrderTotal:true}).methods,['voucher']);
 assert.deepEqual(clientPaymentSnapshot({cash:{}}).methods,['cash_to_rider']);
 assert.deepEqual(clientPaymentSnapshot({paymentMethod:'counter_cash'}).methods,['counter_cash']);
});
test('Pay GRIDGO manual confirmation pauses new work at deadline, preserves jobs and immediately reopens',async()=>{
 const s=setup();s.orders=[];s.settings.paymentQrFileId='platform';
 await call(s,'/ops/shop-money/shops/supplier/policy',{expectedVersion:0,counterCashEnabled:true,reason:'Controlled rollout'},actors.admin,AT,'PATCH');
 recordShopRecovery(s,'supplier','counter',15000,ctx,{debt:true});syncShopMoney(s,ctx);const run=runShopSettlement(s,ctx);
 const request=s.shopMoneyEvents.find(e=>e.kind==='pay_request');assert.ok(request);assert.equal(rowFor(run).netMinor,-15000);
 assert.equal(shopMoneyPaused(s,'supplier','2026-11-23T09:59:59.000Z'),false);
 assert.equal(shopMoneyPaused(s,'supplier','2026-11-23T10:00:00.000Z'),true);
 const profile=s.supplierProfiles.find(p=>p.userId==='supplier');assert.ok(supplierMatchBlockersFor(s,'2026-11-23T10:00:00.000Z')('supplier',profile).includes('shop_payment_overdue'));
 sweepShopMoney(s,{...ctx,at:'2026-11-23T09:00:00.000Z'});const notices=s.notifications.length;sweepShopMoney(s,{...ctx,at:'2026-11-23T09:00:00.000Z'});assert.equal(s.notifications.length,notices);
 const body={amountMinor:15000,reference:'BANK001',reason:'Bank verified'};await call(s,`/ops/shop-money/payments/${request.id}/confirm`,body,actors.ops,'2026-11-23T10:01:00Z');
 assert.equal(shopMoneyPaused(s,'supplier','2026-11-23T10:01:00Z'),false);assert.equal(shopMoneyBalances(s,'supplier',AT).owingMinor,0);
 assert.equal((await call(s,`/ops/shop-money/payments/${request.id}/confirm`,body)).body.replayed,true);
});
test('owner and administrator money reads agree; staff denied; no client/rider bonus leak',async()=>{
 const s=setup({bonus:true});syncShopMoney(s,ctx);
 const mine=await call(s,'/me/shop-money',{},actors.supplier,AT,'GET'),admin=await call(s,'/ops/shop-money/shops/supplier',{},actors.ops,AT,'GET');
 assert.deepEqual(mine.body.balances,admin.body.balances);
 await assert.rejects(call(s,'/me/shop-money',{}, {...actors.supplier,shopRole:'staff'},AT,'GET'),e=>e.status===403);
 assert.equal(publicOrderFor(s.orders[0],actors.client,s).shopLaunchBonus,undefined);assert.equal(publicOrderFor(s.orders[0],actors.rider,s).shopLaunchBonus,undefined);
});
test('settings reject fractional money, invalid calendar/time, and unknown fields',()=>{
 for(const change of [{minimumMinor:1.5},{bonusRateBps:10001},{payDeadline:'15:00'},{holidays:['2026-02-30']},{businessWeekdays:[]},{unexpected:true}])assert.throws(()=>validateShopMoneySettings({shopMoney:change}));
});

test('full recovery offsets settle a stage without a transfer or invented receipt',async()=>{
 const s=setup();recordShopRecovery(s,'supplier','fault',30000,ctx,{debt:true});syncShopMoney(s,ctx);const run=runShopSettlement(s,ctx);
 const transfer=(await call(s,`/ops/shop-money/runs/${run.id}/shops/supplier/prepare`)).body.transfer;
 assert.equal(transfer.data.netAmountMinor,0);
 await call(s,`/ops/shop-money/transfers/${transfer.id}/confirm`,{amountMinor:0,offsetConfirmed:true,paidAt:AT,reason:'Full recovery offset'});
 assert.equal(s.orders[0].payoutMilestones[0].status,'released');assert.equal(shopMoneyBalances(s,'supplier',AT).owedMinor,0);assert.equal(shopMoneyBalances(s,'supplier',AT).owingMinor,0);assert.equal(shopMoneyBalances(s,'supplier',AT).paidMinor,0);
});
test('counter cash stays off, collection is audited once, and launch-week platform share is waived',async()=>{
 const s=setup({bonus:true}),o=s.orders[0];o.paymentMethod='counter_cash';o.clientPayment=clientPaymentSnapshot(o);s.settings.paymentQrFileId='platform';
 const path='/ops/shop-money/shops/supplier/counter-cash',body={orderId:o.id,amountMinor:o.totalMinor,cashReceivedConfirmed:true,reason:'Counter collection'};
 await assert.rejects(call(s,path,body),e=>e.code==='counter_cash_disabled');
 await call(s,'/ops/shop-money/shops/supplier/policy',{expectedVersion:0,counterCashEnabled:true,reason:'Controlled rollout'},actors.admin,AT,'PATCH');
 const collected=await call(s,path,body);assert.equal(collected.body.collection.data.shareMinor,0);assert.equal((await call(s,path,body)).body.replayed,true);
 assert.equal(shopMoneyBalances(s,'supplier',AT).owedMinor,6000);assert.equal(shopMoneyBalances(s,'supplier',AT).owingMinor,0);
});
test('daily preview cannot spend more principal than confirmed collection across multiple stages',()=>{
 const s=setup(),o=s.orders[0];o.orderType='regular';o.payoutPlanVersion=2;o.state='completed';o.payoutMilestones=createPayoutMilestones(o,{version:2});
 o.payoutMilestones.forEach(m=>m.pofFileIds=['proof']);o.paymentAllocations[0].amountMinor=22500;
 const run=runShopSettlement(s,ctx),row=rowFor(run);assert.equal(row.availableMinor,22500);assert.ok(row.held.some(i=>i.reason==='supplier_principal_not_collected'));
});
test('unpaid reviewed rematch reverses the old shop and starts the new beneficiary without resetting the first-order clock',()=>{
 const s=setup({bonus:true});syncShopMoney(s,ctx);assert.equal(shopMoneyBalances(s,'supplier',AT).owedMinor,36000);
 const originalClock=s.shopMoneyEvents.find(e=>e.kind==='first_order'&&e.supplierId==='supplier').data.startedAt;
 s.orders[0].supplierId='replacement';syncShopMoney(s,ctx);
 assert.equal(shopMoneyBalances(s,'supplier',AT).owedMinor,0);assert.equal(shopMoneyBalances(s,'replacement',AT).owedMinor,36000);
 syncShopMoney(s,ctx);assert.equal(shopMoneyBalances(s,'replacement',AT).owedMinor,36000);
 assert.equal(s.shopMoneyEvents.find(e=>e.kind==='first_order'&&e.supplierId==='supplier').data.startedAt,originalClock);
});
