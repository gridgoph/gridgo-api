import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore} from '../src/postgres-store.js';
import {setupVerification} from './fixtures/supplier-verification.js';
import {apiForTest} from './fixtures/reschedule-http.js';
import {AT,id} from './fixtures/reschedule.js';
import {createPayoutMilestones} from '../src/operational-model.js';
const skip=!process.env.DATABASE_URL;

async function setup(db,configure=()=>{}) {
  await setupVerification(db,s=>{
    s.settings.supplierVerification.payoutCapMinor=500000;
    for(const [fileId,ownerId,purpose] of [['qr','supplier','supplier_payout_qr'],['receipt','ops','payout_receipt']])
      s.files.push({fileId,ownerId,purpose,state:'ready',objectKey:`private/${fileId}`,originalFilename:`${fileId}.png`,declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,references:[]});
    s.supplierPayoutAccounts.push({supplierId:'supplier',provider:'other',accountName:'Shop',qrFileId:'qr',version:1,updatedAt:AT});
    const next=structuredClone(s.orders[0]);next.id='nextorder';next.payoutMilestones[0].pofFileIds=['next-proof'];s.orders.push(next);
    s.files.push({...structuredClone(s.files.find(f=>f.fileId==='proof')),fileId:'next-proof',objectKey:'private/next-proof',references:[{type:'order',id:'nextorder',field:'pofFileIds',milestoneCode:'production_started'}]});
    configure(s);
  });
}

for(const verifyBeforeRecording of [false,true])test(`paid reconciliation after an unverified shop cancellation recovers once, verification before recording=${verifyBeforeRecording}`,{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setup(db);const api=await apiForTest(t);
  const base='/orders/order/milestones/production_started';
  const prepared=await api('ops','POST',`${base}/prepare`,{});assert.equal(prepared.status,200,JSON.stringify(prepared.body));
  const paidAt=new Date().toISOString();
  const cancelled=await api('supplier','POST','/orders/order/shop-cancel',{reason:'Printer failed after the prepared advance'});assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));
  if(verifyBeforeRecording) {
    const verified=await api('admin','POST','/approval-cases/case_supplier/approve',{expectedVersion:1,requestId:id('verify')});assert.equal(verified.status,200,JSON.stringify(verified.body));
  }
  const body={payoutKey:'stage:order:production_started',attemptId:prepared.body.payout.attemptId,outcome:'paid',fundsSentConfirmed:true,paidAt,amountMinor:4000,reference:'SENT-BEFORE-DROP',receiptFileId:'receipt',reason:'Original transfer confirmed after cancellation'};
  const recorded=await api('ops','POST','/orders/order/payout-reservations/reconcile',body);assert.equal(recorded.status,200,JSON.stringify(recorded.body));
  const summary=(await api('supplier','GET','/me/supplier-verification')).body.verification;
  assert.equal(summary.recoveryDueMinor,4000);
  assert.equal(summary.newOrdersPaused,!verifyBeforeRecording);
  assert.equal((await api('client','GET','/catalog/items/item_supplier')).status,verifyBeforeRecording?200:404);
  const queue=await api('ops','GET','/ops/supplier-verification/supplier');assert.equal(queue.body.supplier.verification.recoveryDueMinor,4000);
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',body)).body.replayed,true);
  const s=await loadStore(db);assert.equal(s.orders[0].shopRecovery.status,'ops_review');assert.equal(s.orders[0].state,'production');
  const debts=s.supplierVerificationLedger.filter(e=>e.kind==='recovery_due'&&e.orderId==='order');assert.equal(debts.length,1);assert.equal(debts[0].amountMinor,4000);
  const next=await api('ops','POST','/orders/nextorder/milestones/production_started/prepare',{});assert.equal(next.status,200,JSON.stringify(next.body));
  assert.equal(next.body.payout.netAmountMinor,0);assert.equal(next.body.payout.items[0].recoveryMinor,4000);
  const offset={attemptId:next.body.payout.attemptId,amountMinor:0};
  assert.equal((await api('ops','POST','/orders/nextorder/milestones/production_started/release',offset)).status,200);
  assert.equal((await api('ops','POST','/orders/nextorder/milestones/production_started/release',offset)).body.replayed,true);
  assert.equal((await api('supplier','GET','/me/supplier-verification')).body.verification.recoveryDueMinor,0);
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',body)).body.replayed,true);
  assert.equal((await api('supplier','GET','/me/supplier-verification')).body.verification.recoveryDueMinor,0);
  const final=await loadStore(db);assert.equal(final.supplierVerificationLedger.filter(e=>e.kind==='recovery_due'&&e.orderId==='order').length,1);
  assert.equal(final.supplierVerificationLedger.filter(e=>e.kind==='recovered').length,1);
});

test('a partially assessed legacy job adds its late stage once after verification and offsets future money',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setup(db,s=>{
    const order=s.orders[0];order.payoutPlanVersion=1;order.payoutMilestones=createPayoutMilestones(order,{version:1});order.state='supplier_self_qc';
    order.payoutMilestones.find(m=>m.code==='printing').pofFileIds=['proof'];
    order.payoutMilestones.find(m=>m.code==='packaging_qc').pofFileIds=['packaging-proof'];
    s.files.push({...structuredClone(s.files.find(f=>f.fileId==='proof')),fileId:'packaging-proof',objectKey:'private/packaging-proof',references:[{type:'order',id:'order',field:'pofFileIds',milestoneCode:'packaging_qc'}]});
  });const api=await apiForTest(t);
  const printing='/orders/order/milestones/printing',packaging='/orders/order/milestones/packaging_qc';
  const first=await api('ops','POST',`${printing}/prepare`,{});assert.equal(first.status,200,JSON.stringify(first.body));
  const released=await api('ops','POST',`${printing}/release`,{attemptId:first.body.payout.attemptId,amountMinor:5000,reference:'PRINTING-SENT'});assert.equal(released.status,200,JSON.stringify(released.body));
  const late=await api('ops','POST',`${packaging}/prepare`,{});assert.equal(late.status,200,JSON.stringify(late.body));
  const paidAt=new Date().toISOString();
  assert.equal((await api('supplier','POST','/orders/order/shop-cancel',{reason:'Shop cannot finish after the advance'})).status,200);
  assert.equal((await api('supplier','GET','/me/supplier-verification')).body.verification.recoveryDueMinor,5000);
  const verified=await api('admin','POST','/approval-cases/case_supplier/approve',{expectedVersion:1,requestId:id('verify')});assert.equal(verified.status,200,JSON.stringify(verified.body));
  const body={payoutKey:'stage:order:packaging_qc',attemptId:late.body.payout.attemptId,outcome:'paid',fundsSentConfirmed:true,paidAt,amountMinor:1500,reference:'PACKAGING-SENT',receiptFileId:'receipt',reason:'Earlier packaging transfer confirmed after the fault'};
  const recorded=await api('ops','POST','/orders/order/payout-reservations/reconcile',body);assert.equal(recorded.status,200,JSON.stringify(recorded.body));
  assert.equal((await api('supplier','GET','/me/supplier-verification')).body.verification.recoveryDueMinor,6500);
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',body)).body.replayed,true);
  const debts=(await loadStore(db)).supplierVerificationLedger.filter(e=>e.orderId==='order'&&e.kind==='recovery_due');assert.deepEqual(debts.map(e=>e.amountMinor).sort((a,b)=>a-b),[1500,5000]);
  const next=await api('ops','POST','/orders/nextorder/milestones/production_started/prepare',{});assert.equal(next.body.payout.netAmountMinor,0);assert.equal(next.body.payout.items[0].recoveryMinor,4000);
  assert.equal((await api('ops','POST','/orders/nextorder/milestones/production_started/release',{attemptId:next.body.payout.attemptId,amountMinor:0})).status,200);
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',body)).body.replayed,true);
  assert.equal((await api('supplier','GET','/me/supplier-verification')).body.verification.recoveryDueMinor,2500);
});

test('a confirmed not-sent preparation after shop cancellation creates no recovery debt',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setup(db);const api=await apiForTest(t);
  const prepared=await api('ops','POST','/orders/order/milestones/production_started/prepare',{});
  assert.equal((await api('supplier','POST','/orders/order/shop-cancel',{reason:'Cannot produce the job'})).status,200);
  const body={payoutKey:'stage:order:production_started',attemptId:prepared.body.payout.attemptId,outcome:'not_sent',noFundsSentConfirmed:true,reason:'No money was sent'};
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',body)).status,200);
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',body)).status,200);
  const s=await loadStore(db);assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='recovery_due').length,0);
  assert.equal((await api('supplier','GET','/me/supplier-verification')).body.verification.recoveryDueMinor,0);
});
