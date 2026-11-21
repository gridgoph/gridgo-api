import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierMatchBlockersFor } from '../src/supplier-eligibility.js';
import { supplierCanWork, verificationSummary, prepareVerificationPayout, completeVerificationPayout,
  recordVerificationRecovery, reconcileVerificationHolds, remindSupplierVerification, rankVerifiedWithinDistance,
  assertVerifiedCashShop } from '../src/supplier-verification.js';

const AT = '2026-11-01T00:00:00.000Z';
const when = day => new Date(Date.parse(AT) + day * 86400000).toISOString();
let serial = 0;
const id = prefix => `${prefix}_${++serial}`;
const actor = { id: 'ops', role: 'ops_admin' };
function fixture() {
  return { users: [{id:'shop',role:'supplier',createdAt:AT}],
    userRoleMemberships: [{userId:'shop',role:'supplier',createdAt:AT}],
    approvalCases: [{id:'case',userId:'shop',kind:'supplier',status:'pending',createdAt:AT}],
    supplierProfiles: [{userId:'shop',shop:{lat:7,lng:125,label:'Address'}}],
    supplierServices: [{id:'svc',supplierId:'shop',state:'live',categoryCode:'documents'}],
    supplierPayoutAccounts: [{supplierId:'shop',qrFileId:'qr'}],
    files:[{fileId:'qr',ownerId:'shop',purpose:'supplier_payout_qr',state:'ready'}],
    settings:{supplierVerification:{payoutCapMinor:500000,windowDays:30}},
    orders:[], supplierVerificationLedger:[], notifications:[],auditLog:[] };
}
function order(store,key,amount=200000) {
  const row={id:key,supplierId:'shop',state:'production',payoutPlanVersion:2,
    payoutMilestones:[{code:'production',amountMinor:amount,status:'pending'}]};
  store.orders.push(row);return row;
}
function prepare(store,row,amount=row.payoutMilestones[0].amountMinor) {
  return prepareVerificationPayout(store,row,{key:`stage:${row.id}:production`,amountMinor:amount,at:when(1),actor,id});
}
function pay(store,row,amount) {
  const result=prepare(store,row,amount);
  if(result.status==='held')return result;
  completeVerificationPayout(store,row,result,{at:when(1),actor,id});
  row.payoutMilestones[0].status='released';return result;
}
test('completed pending shop matches until exact deadline; standing and setup blockers stay',()=>{
  const s=fixture(),profile=s.supplierProfiles[0];
  assert.deepEqual(supplierMatchBlockersFor(s,{at:when(0)})('shop',profile),[]);
  assert.ok(supplierMatchBlockersFor(s,{at:when(30)})('shop',profile).includes('verification_deadline'));
  assert.equal(supplierCanWork(s,'shop'),true);
  profile.isClosed=true;s.users[0].accountStatus='suspended';s.supplierPayoutAccounts=[];
  const blockers=supplierMatchBlockersFor(s,{at:when(0)})('shop',profile);
  for(const code of ['account_inactive','shop_closed','payout_qr'])assert.ok(blockers.includes(code));
});
test('every stage counts; whole over-cap stage waits, verification lifts it without fabricating a transfer',()=>{
  const s=fixture(),a=order(s,'a',300000),b=order(s,'b',200000),c=order(s,'c',1);
  pay(s,a);a.state='completed';pay(s,b);b.state='completed';
  assert.equal(verificationSummary(s,'shop',when(2)).paidBeforeVerificationMinor,500000);
  assert.equal(pay(s,c).status,'held');assert.equal(pay(s,c).status,'held');
  assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='held').length,1);
  s.approvalCases[0].status='approved';reconcileVerificationHolds(s,{at:when(3),actor,id});
  assert.equal(c.payoutMilestones[0].status,'pending');
  assert.equal(pay(s,c).status,'ready');
  assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='released').length,3);
});
test('two paid-open regular jobs block another stage, but delivery and Express do not occupy slots',()=>{
  const s=fixture(),a=order(s,'a',100),b=order(s,'b',100),c=order(s,'c',100);
  pay(s,a);pay(s,b);assert.equal(prepare(s,c).reason,'verification_open_jobs');
  c.orderType='express';assert.equal(prepare(s,c).status,'ready');
  c.orderType='regular';a.state='delivered';assert.equal(prepare(s,c).status,'ready');
});
test('cancellation creates one recoverable debt; future payout offsets it once without reshaping gross stages',()=>{
  const s=fixture(),a=order(s,'a',100000);pay(s,a);
  a.state='cancelled';recordVerificationRecovery(s,a,{at:when(2),actor,id});recordVerificationRecovery(s,a,{at:when(2),actor,id});
  assert.equal(verificationSummary(s,'shop',when(2)).recoveryDueMinor,100000);
  assert.ok(supplierMatchBlockersFor(s,{at:when(2)})('shop',s.supplierProfiles[0]).includes('verification_recovery'));
  const b=order(s,'b',150000),result=pay(s,b);
  assert.equal(result.netAmountMinor,50000);assert.equal(b.payoutMilestones[0].amountMinor,150000);
  completeVerificationPayout(s,b,result,{at:when(2),actor,id});
  assert.equal(verificationSummary(s,'shop',when(2)).recoveryDueMinor,0);
  assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='recovered').length,1);
});
test('cash checkout needs verification; existing cash never consumes cap or creates recovery debt',()=>{
  const s=fixture();assert.throws(()=>assertVerifiedCashShop(s,'shop'),{code:'cash_supplier_verification_required'});
  const cash=order(s,'cash',600000);cash.cash={};cash.payoutMilestones[0].status='released';
  cash.state='cancelled';recordVerificationRecovery(s,cash,{at:when(1),actor,id});
  assert.equal(verificationSummary(s,'shop',when(1)).paidBeforeVerificationMinor,0);
  assert.equal(verificationSummary(s,'shop',when(1)).recoveryDueMinor,0);
  s.approvalCases[0].status='approved';assert.doesNotThrow(()=>assertVerifiedCashShop(s,'shop'));
});
test('day 7/20/27 reminders are durable and deduplicated; countdown only in last seven days',()=>{
  const s=fixture();
  for(const day of [0,6,7,7,19,20,20,26,27,27,30])remindSupplierVerification(s,{at:when(day),id});
  assert.equal(s.notifications.filter(n=>n.userId==='shop').length,3);
  assert.equal(verificationSummary(s,'shop',when(20)).countdownDays,null);
  assert.equal(verificationSummary(s,'shop',when(23)).countdownDays,7);
  assert.equal(verificationSummary(s,'shop',when(30)).newOrdersPaused,true);
});
test('verified shops rank first only in the same distance band; badge is positive only',()=>{
  const a={id:'a',verified:false,distanceZone:{key:'nearby'}},b={id:'b',verified:true,distanceZone:{key:'away'}},c={id:'c',verified:true,distanceZone:{key:'nearby'}};
  assert.deepEqual(rankVerifiedWithinDistance([a,b,c]).map(r=>r.id),['c','b','a']);
});
test('settings determine cap and window; rejected/suspended identities never gain probation access',()=>{
  const s=fixture();s.settings.supplierVerification={payoutCapMinor:100,windowDays:10};
  assert.equal(prepare(s,order(s,'a',101)).status,'held');
  assert.equal(verificationSummary(s,'shop',when(10)).newOrdersPaused,true);
  for(const status of ['rejected','suspended']) {s.approvalCases[0].status=status;assert.equal(supplierCanWork(s,'shop'),false);}
});

test('Express uses a new immutable single-stage plan after delivery; regular work retains 40/35/25',async()=>{
  const {snapshotPayoutPlan,releaseMilestone}=await import('../src/operational-model.js');
  const regular={supplierPlatformPayoutMinor:10000};snapshotPayoutPlan(regular);
  assert.equal(regular.payoutPlanVersion,2);assert.deepEqual(regular.payoutMilestones.map(s=>s.amountMinor),[4000,3500,2500]);
  const express={supplierId:'shop',orderType:'express',state:'production',supplierPlatformPayoutMinor:10000,
    payments:{initial:{status:'confirmed'}},paymentAllocations:[{paymentCode:'initial',component:'supplier_principal',amountMinor:10000}]};
  snapshotPayoutPlan(express);assert.equal(express.payoutPlanVersion,4);assert.equal(express.payoutMilestones.length,1);
  assert.equal(express.payoutMilestones[0].amountMinor,10000);
  assert.throws(()=>releaseMilestone(express,'delivered',actor,when(1),fixture()),{code:'delivery_required'});
  express.state='delivered';assert.equal(releaseMilestone(express,'delivered',actor,when(1),fixture()).status,'released');
});

test('cap reservations serialize competing stages and cancellation frees unused capacity',async()=>{
  const {cancelVerificationReservation}=await import('../src/supplier-verification.js');
  const s=fixture(),a=order(s,'reserved-a',400000),b=order(s,'reserved-b',200000);
  assert.equal(prepare(s,a).status,'ready');assert.equal(prepare(s,b).status,'held');
  cancelVerificationReservation(s,a,'stage:reserved-a:production',{at:when(1),actor,id,reason:'No transfer sent'});
  assert.equal(prepare(s,b).status,'ready');
});

test('reminders catch up the latest overdue milestone once and stop at a configurable deadline',()=>{
  const s=fixture();remindSupplierVerification(s,{at:when(21),id});remindSupplierVerification(s,{at:when(21),id});
  assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='reminder').length,1);
  assert.equal(s.supplierVerificationLedger.find(e=>e.kind==='reminder').data.day,20);
  s.settings.supplierVerification.windowDays=22;remindSupplierVerification(s,{at:when(27),id});
  assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='reminder').length,1);
});


test('legacy automatic retention is held at the cap while the order still completes',async()=>{
  const {createPayoutMilestones,expireIssueWindows}=await import('../src/operational-model.js');
  const s=fixture(),o={id:'legacy',supplierId:'shop',state:'issue_window_open',issueWindowExpiresAt:when(1),
    payoutPlanVersion:1,supplierPlatformPayoutMinor:10000,supplierSubtotalMinor:10000,
    payments:{initial:{status:'confirmed'}},paymentAllocations:[{paymentCode:'initial',component:'supplier_principal',amountMinor:10000}],
    payoutMilestones:createPayoutMilestones({supplierPlatformPayoutMinor:10000},{version:1})};
  s.settings.supplierVerification.payoutCapMinor=9000;
  for(const stage of o.payoutMilestones){stage.pofFileIds=['proof'];if(stage.code!=='retention')stage.status='released';}
  s.orders.push(o);assert.equal(expireIssueWindows(s,when(2)),true);assert.equal(o.state,'completed');
  assert.notEqual(o.payoutMilestones.at(-1).status,'released');assert.equal(s.supplierVerificationLedger.at(-1).kind,'held');
});

test('a shop failure cannot free cap reserved for a transfer whose outcome is not yet recorded',async()=>{
  const {fixture:domainFixture,AT:at}=await import('./fixtures/reschedule.js');
  const {recordShopFailure}=await import('../src/shop-recovery.js');
  const {hasVerificationReservation}=await import('../src/supplier-verification.js');
  const s=domainFixture(),o=s.orders[0];s.approvalCases.find(c=>c.userId==='supplier').status='pending';
  prepareVerificationPayout(s,o,{key:'stage:order:production_started',amountMinor:4000,at,actor:s.users.find(u=>u.id==='ops'),id});
  recordShopFailure(s,o,{kind:'cancelled',reason:'Cannot finish this job',at,createId:id,actorId:'supplier',actorRole:'supplier'});
  assert.equal(o.shopRecovery.status,'ops_review');assert.equal(hasVerificationReservation(s,o),true);
});
