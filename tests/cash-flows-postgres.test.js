import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { fixture, AT, id, audit } from './fixtures/reschedule.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { createPayoutMilestones } from '../src/operational-model.js';
import { routeCash, collectCash } from '../src/cash-routes.js';
import { cashWallet, reserveCash, reconcileCash, postCash } from '../src/cash-ledger.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { checkoutFixture, makeCart, AT as CART_AT } from './helpers/promotion-checkout.mjs';
import { issueVoucher } from '../src/vouchers.js';
import { publicOrderFor } from '../src/operational-model.js';
import { authorizeFileRead } from '../src/attachments.js';
import { assessProductionLapses } from '../src/production-penalties.js';
import { routeIssueDecisions } from '../src/issue-decisions.js';

async function setup(db,{shopMinor=10000,feeMinor=1000,fareMinor=1000,deductionMinor=0,cashEnabled=true}={}) {
  await resetDatabase(db,'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  const store=fixture(), order=store.orders[0];
  store.settings.cash.enabled=cashEnabled;
  Object.assign(order,{cash:{version:1,limitMinor:150000,noShowWaitSeconds:600},paymentPlan:'cash_delivery',riderCommissionBps:8000,
    payoutPlanVersion:3,onlineDueMinor:0,state:'rider_assigned',riderId:'rider',riderAssignedAt:AT,paymentStatus:'cash_due',shopHandoverVersion:2});
  order.payments.initial.method='cash'; order.payments.initial.status='not_submitted';
  Object.assign(order,{supplierSubtotalMinor:shopMinor,subtotalMinor:shopMinor,supplierPlatformPayoutMinor:shopMinor,serviceFeeMinor:feeMinor,
    deliveryFeeMinor:fareMinor,totalMinor:shopMinor+feeMinor+fareMinor});
  order.payments.initial.amountMinor=order.totalMinor;
  order.paymentAllocations=[['supplier_principal',shopMinor],['service_fee',feeMinor],['delivery_pass_through',fareMinor]]
    .filter(([,amount])=>amount>0).map(([component,amountMinor])=>({paymentCode:'initial',component,amountMinor}));
  order.payoutMilestones=createPayoutMilestones(order,{version:3});
  if (deductionMinor) {
    store.orderLineItems[0].turnaroundHoursSnapshot=24;
    store.orderLineItems[0].turnaroundMinutesSnapshot=1440;
    order.readyBy=new Date(Date.parse(AT)-2*3600000).toISOString();order.readyAt=AT;
    store.settings.productionPenalty.deductionsEnabled=true;
    assessProductionLapses(store,{at:AT,createId:id});
    assessProductionLapses(store,{at:new Date(Date.parse(AT)+1).toISOString(),createId:id});
    assert.equal(order.payoutMilestones[0].productionDeductionMinor,deductionMinor);
  }
  store.orderJobs[0].riderCommissionBps=8000;
  store.orderJobs[0].supplierSubtotalMinor=shopMinor;store.orderJobs[0].deliveryFeeMinor=fareMinor;
  Object.assign(store.orderLineItems[0],{quantity:1,lineSubtotalMinor:shopMinor,effectiveUnitPriceMinor:shopMinor,baseUnitPriceMinor:shopMinor});
  store.approvalCases.push({id:'case_rider',userId:'rider',kind:'rider',status:'approved',version:1,applicationRevision:1,createdAt:AT,updatedAt:AT});
  for (const [fileId,purpose,ownerId] of [['shop-receipt','cash_shop_receipt','rider'],['noshow','cash_no_show_photo','rider'],['returned','cash_return_photo','ops'],
    ['repayment','cash_repayment_proof','client'],['redelivery-payment','cash_repayment_proof','client'],['redelivery-payment-2','cash_repayment_proof','client'],['remedy-qr','cash_remedy_qr','client'],['remedy-receipt','cash_remedy_receipt','ops'],
    ['incident-photo','cash_incident_photo','ops'],['counter-return-1','cash_shop_return','rider'],['counter-return-2','cash_shop_return','rider']]) {
    store.files.push({fileId,purpose,ownerId,state:'ready',objectKey:`private/${fileId}`,originalFilename:'evidence.png',detectedContentType:'image/png',declaredContentType:'image/png',size:100,createdAt:AT,references:[]});
  }
  await db.transaction(()=>saveStore(db,store));
}
async function call(db,actor,path,body={},key=id('key'),at=AT) {
  return db.transaction(async()=>{
    const store=await loadStore(db), user=store.users.find(u=>u.id===actor);
    const result=await routeCash({req:{method:'POST',url:path,headers:{'idempotency-key':key}},url:new URL(path,'http://test'),db,store,user,
      readBody:async()=>body,id,now:()=>at,audit});
    if (result.mutated) await saveStore(db,store);
    return result;
  });
}
async function fund(db,reserveMinor=1200,amountMinor=20000) {
  const result=await call(db,'rider','/me/rider-wallet/topups',{amountMinor,reference:'wallet-topup'});
  await call(db,'ops',`/ops/cash/topups/${result.body.topup.id}/confirm`,{reason:'Verified bank transfer'});
  if (reserveMinor) await db.transaction(()=>reserveCash(db,'order','rider',reserveMinor));
}
async function payShop(db,amountMinor=10000) {
  return call(db,'rider','/dispatch/order/cash/shop-payment',{expectedVersion:1,amountMinor,receiptFileId:'shop-receipt'});
}
async function pickedUp(db) {
  await db.transaction(async()=>{const store=await loadStore(db); store.orders[0].state='out_for_delivery';
    store.orders[0].riderProgress={riderId:'rider',events:{arrived:AT}}; await saveStore(db,store);});
}

test('cash completion records exact shop payment, collection and one GRIDGO debit; retries cannot pay twice', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db); await fund(db);
    await assert.rejects(call(db,'rider','/dispatch/order/cash/shop-payment',{expectedVersion:1,amountMinor:9999,receiptFileId:'shop-receipt'}),{code:'cash_exact_shop_payment_required'});
    const key='same-shop-payment';
    const [a,b]=await Promise.all([call(db,'rider','/dispatch/order/cash/shop-payment',{expectedVersion:1,amountMinor:10000,receiptFileId:'shop-receipt'},key),call(db,'rider','/dispatch/order/cash/shop-payment',{expectedVersion:1,amountMinor:10000,receiptFileId:'shop-receipt'},key)]);
    assert.deepEqual(a.body,b.body);
    await pickedUp(db);
    await assert.rejects(db.transaction(async()=>{const store=await loadStore(db); await collectCash({db,store,order:store.orders[0],user:store.users.find(u=>u.id==='rider'),body:{cashReceived:true,amountReceivedMinor:11999},at:AT,id,audit});}),{code:'cash_exact_collection_required'});
    await db.transaction(async()=>{const store=await loadStore(db);await collectCash({db,store,order:store.orders[0],user:store.users.find(u=>u.id==='rider'),
      body:{cashReceived:true,amountReceivedMinor:12000,evidenceFileId:'delivery',acknowledgementSignature:{fileId:'client-signature'}},at:AT,id,audit});await saveStore(db,store);});
    assert.equal((await cashWallet(db,'rider')).balanceMinor,18800);
    assert.equal((await reconcileCash(db,{orderId:'order'})).ok,true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM cash_journals WHERE kind='gridgo_share_debited'")).rows[0].n,1);
  } finally {await db.close();}
});

test('pre-collection shop failure remains an outstanding rider claim; only evidenced supplier cash returns cancel it without GRIDGO funding or client bar', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);await fund(db);await payShop(db);
    const opened=await call(db,'ops','/ops/cash/orders/order/incident-open',{expectedVersion:2,photoFileId:'incident-photo',reason:'Wrong counts; shop cannot repair work'});
    assert.equal(opened.body.incident.status,'outstanding');
    assert.equal(opened.body.incident.remainingMinor,10000);
    await assert.rejects(db.transaction(async()=>{const store=await loadStore(db);await collectCash({db,store,order:store.orders[0],user:store.users.find(u=>u.id==='rider'),body:{cashReceived:true,amountReceivedMinor:12000},at:AT,id,audit});}),{code:'cash_incident_hold'});
    await assert.rejects(call(db,'ops','/ops/cash/orders/order/incident-return',{expectedVersion:3,resolutionType:'gridgo_advance',amountMinor:10000,receiptFileId:'counter-return-1',riderReceiptConfirmed:true}),{code:'cash_resolution_not_enabled'});
    assert.equal((await cashWallet(db,'rider')).balanceMinor,20000);
    const partial=await call(db,'ops','/ops/cash/orders/order/incident-return',{expectedVersion:3,resolutionType:'supplier_cash_return',amountMinor:4000,receiptFileId:'counter-return-1',riderReceiptConfirmed:true});
    assert.equal(partial.body.incident.remainingMinor,6000);
    assert.equal(partial.body.incident.status,'outstanding');
    assert.equal((await cashWallet(db,'rider')).reservedMinor,1200);
    const body={expectedVersion:4,resolutionType:'supplier_cash_return',amountMinor:6000,receiptFileId:'counter-return-2',riderReceiptConfirmed:true};
    const [a,b]=await Promise.all([call(db,'ops','/ops/cash/orders/order/incident-return',body,'counter-once'),call(db,'ops','/ops/cash/orders/order/incident-return',body,'counter-once')]);
    assert.deepEqual(a.body,b.body);assert.equal(a.body.incident.status,'resolved');
    const store=await loadStore(db),order=store.orders[0];
    assert.equal(order.state,'cancelled');assert.equal(order.payments.initial.status,'not_submitted');
    assert.equal(order.cashProgress.noShowApprovedAt,undefined);
    assert.equal(order.payoutMilestones[0].status,'released');assert.equal(order.payoutMilestones[0].amountMinor,10000);
    assert.deepEqual(await cashWallet(db,'rider'),{balanceMinor:20000,reservedMinor:0,availableMinor:20000,lowBalance:false,topupAmountsMinor:[20000,50000,100000]});
    const balances=(await db.query("SELECT id,balance_minor FROM cash_accounts WHERE id IN('gridgo_bank','rider_cash:rider','shop_cash:supplier') ORDER BY id")).rows;
    assert.deepEqual(balances,[{id:'gridgo_bank',balance_minor:20000},{id:'rider_cash:rider',balance_minor:0},{id:'shop_cash:supplier',balance_minor:0}]);
    assert.equal((await reconcileCash(db)).ok,true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_incident_resolutions')).rows[0].n,2);
  } finally {await db.close();}
});

test('an evidenced unproducible order with no cash advanced cancels once and releases its unused wallet hold without barring the client', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);await fund(db);
    await db.transaction(async()=>{const store=await loadStore(db);store.files.find(f=>f.fileId==='incident-photo').ownerId='rider';await saveStore(db,store);});
    const body={expectedVersion:1,reasonCode:'artwork_unproducible',noCashAdvancedConfirmed:true,shopObligationMinor:0,photoFileId:'incident-photo'};
    await assert.rejects(call(db,'ops','/ops/cash/orders/order/cancel-unpaid',{...body,noCashAdvancedConfirmed:false}),{code:'cash_unpaid_cancellation_not_available'});
    const [a,b]=await Promise.all([call(db,'ops','/ops/cash/orders/order/cancel-unpaid',body,'cancel-once'),call(db,'ops','/ops/cash/orders/order/cancel-unpaid',body,'cancel-once')]);
    assert.deepEqual(a.body,b.body);
    const order=(await loadStore(db)).orders[0];assert.equal(order.state,'cancelled');assert.equal(order.payoutMilestones[0].status,'superseded');
    assert.equal(order.cashProgress.noShowApprovedAt,undefined);assert.equal(order.payoutMilestones[0].amountMinor,10000);
    assert.equal((await cashWallet(db,'rider')).availableMinor,20000);assert.equal((await cashWallet(db,'rider')).reservedMinor,0);
    assert.equal((await reconcileCash(db)).ok,true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM cash_journals WHERE kind IN('shop_paid','cash_collected','no_show_returned')")).rows[0].n,0);
  } finally {await db.close();}
});

test('no-show enforces contact and server wait, returns exact shop principal once, and reconciles online debt repayment', {skip:!process.env.DATABASE_URL},async t=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);await fund(db);await payShop(db);await pickedUp(db);
    await call(db,'rider','/dispatch/order/cash/no-show-start',{expectedVersion:2,contactMethod:'call'});
    await assert.rejects(call(db,'rider','/dispatch/order/cash/no-show-report',{expectedVersion:3,reason:'No answer',photoFileId:'noshow'}),{code:'cash_wait_not_elapsed'});
    const later='2026-10-05T00:10:00.000Z';
    await call(db,'rider','/dispatch/order/cash/no-show-report',{expectedVersion:3,reason:'No answer',photoFileId:'noshow'},id('key'),later);
    await call(db,'ops','/ops/cash/orders/order/approve-no-show',{expectedVersion:4,reason:'Returned to GRIDGO',returnPhotoFileId:'returned'},id('key'),later);
    assert.equal((await cashWallet(db,'rider')).balanceMinor,30000);
    await call(db,'client','/orders/order/cash/repayment',{expectedVersion:5,amountMinor:12000,reference:'DEBT-1',proofFileId:'repayment'},id('key'),later);
    const body={expectedVersion:6}, key='repay';
    const results=await Promise.all([call(db,'ops','/ops/cash/orders/order/confirm-repayment',body,key,later),call(db,'ops','/ops/cash/orders/order/confirm-repayment',body,key,later)]);
    assert.deepEqual(results[0].body,results[1].body);
    assert.equal((await cashWallet(db,'rider')).balanceMinor,30800);
    assert.equal((await db.query("SELECT balance_minor FROM cash_accounts WHERE id='client_receivable:order'")).rows[0].balance_minor,0);
    assert.equal((await reconcileCash(db)).ok,true);
    const quote=await call(db,'client','/orders/order/cash/redelivery-quote',{expectedVersion:7},id('key'),later);
    assert.equal(quote.body.redelivery.feeMinor,8900);
    await call(db,'client','/orders/order/cash/redelivery-payment',{expectedVersion:8,redeliveryId:quote.body.redelivery.id,
      acceptCost:true,amountMinor:8900,reference:'REDELIVER-1',proofFileId:'redelivery-payment'},id('key'),later);
    await call(db,'ops','/ops/cash/orders/order/reject-redelivery',{expectedVersion:9,reason:'Transfer not found'},id('key'),later);
    assert.equal((await cashWallet(db,'rider')).balanceMinor,30800);
    await call(db,'client','/orders/order/cash/redelivery-payment',{expectedVersion:10,redeliveryId:quote.body.redelivery.id,
      acceptCost:true,amountMinor:8900,reference:'REDELIVER-2',proofFileId:'redelivery-payment-2'},id('key'),later);
    await call(db,'ops','/ops/cash/orders/order/confirm-redelivery',{expectedVersion:11},id('key'),later);
    const saved=await loadStore(db), order=saved.orders[0];
    assert.equal(order.state,'ready_for_dispatch');
    assert.equal(order.totalMinor,12000);
    assert.equal(order.deliveryFeeMinor,1000);
    assert.equal(order.pickup.lat,7.06);
    assert.equal(order.cashProgress.redelivery.pickup.label,'GRIDGO Office');
    assert.equal((await reconcileCash(db)).ok,true);
    await db.transaction(async()=>{const store=await loadStore(db);store.orders[0].handover={version:1,otp:'123456',createdAt:AT};await saveStore(db,store);});
    const api=await apiForTest(t),offers=await api('rider','GET','/dispatch/offers');
    assert.equal(offers.status,200,JSON.stringify(offers.body));
    const offer=offers.body.offers.find(o=>o.id==='order');
    assert.equal(offer.activeTrip.pickup.label,'GRIDGO Office');
    const accepted=await api('rider','POST','/dispatch/order/accept',{offerId:offer.dispatchOffer.id});
    assert.equal(accepted.status,200,JSON.stringify(accepted.body));
    await db.transaction(async()=>{
      const store=await loadStore(db),order=store.orders[0];order.state='out_for_delivery';
      order.riderProgress={riderId:'rider',assignedAt:order.riderAssignedAt,events:{arrived:new Date().toISOString()}};
      for (const [fileId,purpose,field] of [['redel-drop','delivery_photo','deliveryPhotoFileIds'],['redel-signature','acknowledgement_signature','acknowledgementSignatureFileIds']]) {
        store.files.push({fileId,purpose,ownerId:'rider',state:'ready',objectKey:`private/${fileId}`,originalFilename:'proof.png',size:100,
          detectedContentType:'image/png',declaredContentType:'image/png',createdAt:AT,references:[{type:'order',id:'order',field,riderId:'rider',assignedAt:order.riderAssignedAt}]});
        order[field]=[fileId];
      }
      await saveStore(db,store);
    });
    const prepared=await api('rider','POST','/orders/order/acknowledgement-receipt',{});
    assert.equal(prepared.status,201,JSON.stringify(prepared.body));
    assert.equal(prepared.body.receipt.grandTotalMinor,20900);
    assert.deepEqual(prepared.body.receipt.payments.map(p=>[p.type,p.amountMinor]),[['digital',12000],['digital',8900]]);
    const delivered=await api('rider','POST','/dispatch/order/delivery',{otp:'123456',evidenceType:'photo',evidenceFileId:'redel-drop',receiptMode:'digital',
      acknowledgementSignature:{fileId:'redel-signature',signerName:'Client Recipient',arNumber:prepared.body.receipt.arNumber}});
    assert.equal(delivered.status,200,JSON.stringify(delivered.body));
    assert.equal((await cashWallet(db,'rider')).balanceMinor,38365);
    assert.equal((await loadStore(db)).orders[0].handover.otp,'123456');
    assert.equal((await reconcileCash(db)).ok,true);
  } finally {await db.close();}
});

for (const fault of ['shop','rider','gridgo']) test(`cash-only ${fault} remedy reserves a payer, records external advance and retains protected shop/rider money`,{skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);await fund(db);await payShop(db);await pickedUp(db);
    await db.transaction(async()=>{const store=await loadStore(db),order=store.orders[0];
      await collectCash({db,store,order,user:store.users.find(u=>u.id==='rider'),body:{cashReceived:true,amountReceivedMinor:12000},at:AT,id,audit});
      store.issues.push({id:'issue',orderId:'order',clientId:'client',kind:'damage',status:'open',createdAt:AT,updatedAt:AT,
        faultDecision:{id:'decision',fault,remedy:'full_refund',costMinor:11000,gridgoCostMinor:fault==='shop'?10000:11000,status:'approved',evidenceIds:['shop_qa']}});
      await saveStore(db,store);});
    await call(db,'client','/orders/order/cash/remedy-destination',{expectedVersion:3,ownershipConfirmed:true,accountName:'Client',qrFileId:'remedy-qr'});
    const reserve={expectedVersion:4,issueId:'issue',decisionId:'decision',destinationRevision:1,destinationVerified:true,sourceWallet:'BANK',provider:'GCASH'};
    await call(db,'ops','/ops/cash/orders/order/remedy-reserve',reserve);
    await assert.rejects(call(db,'admin','/ops/cash/orders/order/remedy-reserve',{...reserve,expectedVersion:5}),{code:'cash_remedy_payer_reserved'});
    await call(db,'ops','/ops/cash/orders/order/remedy-reconcile',{expectedVersion:5,outcome:'unknown',reason:'Provider timed out'});
    const paidBody={expectedVersion:6,amountMinor:11000,reference:'REFUND-1',receiptFileId:'remedy-receipt'};
    const paid=await Promise.all([call(db,'ops','/ops/cash/orders/order/remedy-pay',paidBody,'pay-once'),call(db,'ops','/ops/cash/orders/order/remedy-pay',paidBody,'pay-once')]);
    assert.deepEqual(paid[0].body,paid[1].body);
    assert.equal((await cashWallet(db,'rider')).balanceMinor,18800);
    const store=await loadStore(db);
    assert.equal(store.orders[0].payoutMilestones[0].amountMinor,10000);
    assert.equal(store.orders[0].payoutMilestones[0].status,'released');
    assert.equal(store.refundSettlements.length,0);
    const receivable=(await db.query("SELECT balance_minor FROM cash_accounts WHERE id='shop_receivable:supplier'")).rows[0];
    assert.equal(receivable?.balance_minor ?? 0,fault==='shop'?10000:0);
    assert.equal((await reconcileCash(db)).ok,true);
  } finally {await db.close();}
});

test('HTTP cash collection issues a Cash AR, signed handover settles once, private evidence and online-route guards hold', {skip:!process.env.DATABASE_URL},async t=>{
  const db=createDatabase(process.env); t.after(()=>db.close());
  await setup(db);await fund(db);await payShop(db);await pickedUp(db);
  await db.transaction(async()=>{const store=await loadStore(db),order=store.orders[0];
    order.riderProgress.assignedAt=AT;
    for (const [fileId,purpose,field] of [['drop','delivery_photo','deliveryPhotoFileIds'],['recipient-signature','acknowledgement_signature','acknowledgementSignatureFileIds']]) {
      store.files.push({fileId,purpose,ownerId:'rider',state:'ready',objectKey:`private/${fileId}`,originalFilename:'proof.png',size:100,
        detectedContentType:'image/png',declaredContentType:'image/png',createdAt:AT,references:[{type:'order',id:'order',field,riderId:'rider',assignedAt:AT}]});
      order[field]=[fileId];
    }
    await saveStore(db,store);
  });
  const api=await apiForTest(t);
  const expect= (r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
  expect(await api('rider','GET','/me/rider-wallet'),200);
  expect(await api('client','GET','/me/rider-wallet'),403);
  expect(await api('ops','POST','/orders/order/payments/initial/confirm',{}),409);
  const collected=expect(await api('rider','POST','/dispatch/order/cash/collect',{expectedVersion:2,cashReceived:true,amountReceivedMinor:12000,evidenceFileId:'drop'}));
  assert.equal(collected.receipt.payments[0].type,'cash');
  assert.equal(collected.receipt.payments[0].amountReceivedMinor,12000);
  const unsigned=await api('rider','POST','/dispatch/order/delivery',{evidenceType:'photo',evidenceFileId:'drop'});
  expect(unsigned,400);assert.equal(unsigned.body.error,'cash_client_signature_required');
  const body={evidenceType:'photo',evidenceFileId:'drop',receiptMode:'digital',
    acknowledgementSignature:{fileId:'recipient-signature',signerName:'Client Recipient',arNumber:collected.receipt.arNumber}};
  const [first,retry]=await Promise.all([api('rider','POST','/dispatch/order/delivery',body,{key:'same-delivery'}),api('rider','POST','/dispatch/order/delivery',body,{key:'same-delivery'})]);
  expect(first);expect(retry);assert.deepEqual(first.body,retry.body);
  assert.equal(first.body.order.state,'issue_window_open');
  assert.equal((await cashWallet(db,'rider')).balanceMinor,18800);
  assert.equal((await reconcileCash(db)).ok,true);
  const receipt=expect(await api('client','GET','/orders/order/acknowledgement-receipt')).receipt;
  assert.equal(receipt.arNumber,collected.receipt.arNumber);
  const own=await api('rider','GET','/files/shop-receipt');expect(own);assert.match(own.headers.get('cache-control'),/no-store/);
  expect(await api('client','GET','/files/shop-receipt'),403);
});

test('cash top-ups remain pending until verified, reject without credit, normalize references and cover all three amounts', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);
    await db.transaction(async()=>{const store=await loadStore(db);store.orders[0].state='production';store.orders[0].riderId=null;await saveStore(db,store);});
    for (const [index,amountMinor] of [20000,50000,100000].entries()) {
      const made=await call(db,'rider','/me/rider-wallet/topups',{amountMinor,reference:` topup-${index} `});
      assert.equal(made.body.topup.reference,`TOPUP-${index}`);
      assert.equal((await cashWallet(db,'rider')).balanceMinor,index<2?0:50000);
      await call(db,'ops',`/ops/cash/topups/${made.body.topup.id}/${index===0?'reject':'confirm'}`,{reason:'Bank reviewed'});
    }
    assert.equal((await cashWallet(db,'rider')).balanceMinor,150000);
    const dup=await call(db,'rider','/me/rider-wallet/topups',{amountMinor:50000,reference:'TOPUP-1'});
    await assert.rejects(call(db,'ops',`/ops/cash/topups/${dup.body.topup.id}/confirm`,{reason:'Duplicate'}),{code:'cash_transfer_duplicate'});
    await assert.rejects(call(db,'rider','/me/rider-wallet/topups',{amountMinor:200.5,reference:'FLOAT'}),{code:'cash_topup_amount_invalid'});
    assert.equal((await reconcileCash(db)).ok,true);
  } finally {await db.close();}
});

for (const groups of [1,2]) test(`cash checkout persists ${groups} group(s), commits partial voucher funding once and collects each delivery independently`,{skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await resetDatabase(db,'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
    const store=checkoutFixture();store.settings.cash.enabled=true;store.vouchers.forEach(v=>v.status='void');
    const campaign={id:'cash-campaign',name:'Cash voucher',purpose:'manual',coversOrderTotal:false,code:'CASH500',status:'active',mode:'assigned',
      valueMinor:500,totalLimit:20,perAccountLimit:1,endsAt:null,validityDays:30,createdAt:CART_AT,updatedAt:CART_AT};
    store.voucherCampaigns.push(campaign);issueVoucher(store,campaign,'client',{id,at:CART_AT,actorId:'admin'});
    store.approvalCases.push({id:'case_rider',userId:'rider',kind:'rider',status:'approved',version:1,applicationRevision:1,createdAt:AT,updatedAt:AT});
    const {call:cartCall,path}=await makeCart(store,Array(groups).fill(1));
    const result=await cartCall('POST',`${path}/checkout`,{payment:{method:'cash'}});
    const ids=result.body.basket?.groups.map(g=>g.orderId)||[result.body.order.id];
    assert.equal(store.vouchers.find(v=>v.campaignId===campaign.id).status,'used');
    for(const [i,orderId]of ids.entries()){
      const order=store.orders.find(o=>o.id===orderId);order.state='rider_assigned';order.riderId='rider';order.riderAssignedAt=CART_AT;
      store.files.push({fileId:`cash-shop-${i}`,ownerId:'rider',purpose:'cash_shop_receipt',state:'ready',objectKey:`private/cash-shop-${i}`,originalFilename:'receipt.png',
        detectedContentType:'image/png',declaredContentType:'image/png',size:100,createdAt:CART_AT,references:[]});
      assert.equal(order.payments.initial.status,'not_submitted');
    }
    await db.transaction(()=>saveStore(db,store));
    const topup=await call(db,'rider','/me/rider-wallet/topups',{amountMinor:20000,reference:'VOUCHER-CASH'});
    await call(db,'ops',`/ops/cash/topups/${topup.body.topup.id}/confirm`,{reason:'Verified'});
    for(const [i,orderId]of ids.entries()){
      await db.transaction(()=>reserveCash(db,orderId,'rider',2230));
      await call(db,'rider',`/dispatch/${orderId}/cash/shop-payment`,{expectedVersion:1,amountMinor:1000,receiptFileId:`cash-shop-${i}`},id('key'),CART_AT);
      await db.transaction(async()=>{const latest=await loadStore(db),order=latest.orders.find(o=>o.id===orderId);
        await collectCash({db,store:latest,order,user:latest.users.find(u=>u.id==='rider'),body:{cashReceived:true,amountReceivedMinor:groups===1?9900:10100},at:CART_AT,id,audit});
        await saveStore(db,latest);});
      const saved=await loadStore(db);
      if(groups===2)assert.equal(saved.baskets[0].payment.status,i===0?'not_submitted':'confirmed');
    }
    assert.equal((await cashWallet(db,'rider')).balanceMinor,groups===1?18220:16040);
    assert.equal((await reconcileCash(db)).ok,true);
  } finally {await db.close();}
});

test('cash net deduction and zero GRIDGO share money paths reconcile without changing the rider fare', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db,{deductionMinor:500});await fund(db,1700);await payShop(db,9500);
    await db.transaction(async()=>{const store=await loadStore(db);await collectCash({db,store,order:store.orders[0],user:store.users.find(u=>u.id==='rider'),
      body:{cashReceived:true,amountReceivedMinor:12000},at:AT,id,audit});await saveStore(db,store);});
    assert.equal((await cashWallet(db,'rider')).balanceMinor,18300);assert.equal((await reconcileCash(db)).ok,true);
    await setup(db,{feeMinor:0,fareMinor:0});await payShop(db);
    await db.transaction(async()=>{const store=await loadStore(db);await collectCash({db,store,order:store.orders[0],user:store.users.find(u=>u.id==='rider'),
      body:{cashReceived:true,amountReceivedMinor:10000},at:AT,id,audit});await saveStore(db,store);});
    assert.equal((await cashWallet(db,'rider')).balanceMinor,0);assert.equal((await reconcileCash(db)).ok,true);
  } finally {await db.close();}
});

test('cash GRIDGO-funded reprint pays only the verified shop destination; its transfer evidence stays out of client/rider views', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);await fund(db);await payShop(db);
    await db.transaction(async()=>{const store=await loadStore(db),order=store.orders[0];
      await collectCash({db,store,order,user:store.users.find(u=>u.id==='rider'),body:{cashReceived:true,amountReceivedMinor:12000},at:AT,id,audit});
      store.files.push({fileId:'shop-qr',ownerId:'supplier',purpose:'supplier_payout_qr',state:'ready',objectKey:'private/shop-qr',originalFilename:'qr.png',size:100,
        detectedContentType:'image/png',declaredContentType:'image/png',createdAt:AT,references:[]});
      store.files.push({fileId:'reprint-receipt',ownerId:'ops',purpose:'cash_reprint_receipt',state:'ready',objectKey:'private/reprint-receipt',originalFilename:'transfer.png',size:100,
        detectedContentType:'image/png',declaredContentType:'image/png',createdAt:AT,references:[]});
      store.supplierPayoutAccounts.push({supplierId:'supplier',provider:'gcash',accountName:'Printer',accountNumber:'09171234567',qrFileId:'shop-qr',version:1,updatedAt:AT});
      store.issues.push({id:'reprint-issue',orderId:'order',clientId:'client',kind:'damage',status:'open',createdAt:AT,updatedAt:AT,
        faultDecision:{id:'reprint-decision',fault:'rider',remedy:'reprint',costMinor:2000,gridgoCostMinor:2000,status:'approved',evidenceIds:['rider_check']}});
      await saveStore(db,store);});
    await call(db,'ops','/ops/cash/orders/order/remedy-reserve',{expectedVersion:3,issueId:'reprint-issue',decisionId:'reprint-decision',supplierDestinationVersion:1,destinationVerified:true,sourceWallet:'OPS',provider:'GCASH'});
    await call(db,'ops','/ops/cash/orders/order/remedy-pay',{expectedVersion:4,amountMinor:2000,reference:'REPRINT-1',receiptFileId:'reprint-receipt'});
    const store=await loadStore(db),order=store.orders[0],file=store.files.find(f=>f.fileId==='reprint-receipt');
    authorizeFileRead(store.users.find(u=>u.id==='supplier'),store,file);
    for(const who of ['client','rider']) {
      assert.throws(()=>authorizeFileRead(store.users.find(u=>u.id===who),store,file));
      assert.equal(publicOrderFor(order,store.users.find(u=>u.id===who),store).cashRemedyPayouts,undefined);
    }
    assert.equal(publicOrderFor(order,store.users.find(u=>u.id==='supplier'),store).cashRemedyPayouts[0].amountMinor,2000);
    assert.equal((await cashWallet(db,'rider')).balanceMinor,18800);assert.equal((await reconcileCash(db)).ok,true);
  } finally {await db.close();}
});

test('a cash refund over PHP 1,000 cannot reserve until the evidence decision has Super Admin approval', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  const decision=async(actor,path,body)=>db.transaction(async()=>{const store=await loadStore(db);
    const response=await routeIssueDecisions({req:{method:'POST'},url:new URL(path,'http://test'),store,user:store.users.find(u=>u.id===actor),readBody:async()=>body,now:()=>AT,id,audit});
    await saveStore(db,store);return response.body.issue.faultDecision;});
  try {
    await setup(db,{shopMinor:120000});await fund(db);await payShop(db,120000);
    await db.transaction(async()=>{const store=await loadStore(db),order=store.orders[0];
      await collectCash({db,store,order,user:store.users.find(u=>u.id==='rider'),body:{cashReceived:true,amountReceivedMinor:122000},at:AT,id,audit});
      store.issues.push({id:'large-issue',orderId:'order',clientId:'client',supplierId:'supplier',kind:'quality',note:'Proven wrong work',status:'open',version:1,createdAt:AT,updatedAt:AT,
        evidenceSnapshot:{groups:[{id:'shop_qa'}],files:[]}});await saveStore(db,store);});
    await call(db,'client','/orders/order/cash/remedy-destination',{expectedVersion:3,ownershipConfirmed:true,accountName:'Client',qrFileId:'remedy-qr'});
    const pending=await decision('ops','/issues/large-issue/decision',{expectedVersion:1,fault:'rider',remedy:'full_refund',costMinor:122000,gridgoCostMinor:122000,evidenceIds:['shop_qa'],reason:'Evidence proves wrong order',alternativesReason:'Replacement cannot meet the deadline'});
    assert.equal(pending.status,'awaiting_approval');
    const reserve={expectedVersion:4,issueId:'large-issue',decisionId:pending.id,destinationRevision:1,destinationVerified:true,sourceWallet:'OPS',provider:'GCASH'};
    await assert.rejects(call(db,'ops','/ops/cash/orders/order/remedy-reserve',reserve),{code:'cash_funded_remedy_not_authorized'});
    await assert.rejects(decision('ops','/issues/large-issue/approve-decision',{expectedVersion:2,decisionId:pending.id,reason:'Operations cannot approve'}),{code:'fault_super_admin_required'});
    const approved=await decision('admin','/issues/large-issue/approve-decision',{expectedVersion:2,decisionId:pending.id,reason:'Reviewed evidence and advance'});
    assert.equal(approved.status,'approved');
    await call(db,'ops','/ops/cash/orders/order/remedy-reserve',reserve);
    await call(db,'ops','/ops/cash/orders/order/remedy-pay',{expectedVersion:5,amountMinor:122000,reference:'LARGE-REFUND',receiptFileId:'remedy-receipt'});
    assert.equal((await reconcileCash(db)).ok,true);assert.equal((await cashWallet(db,'rider')).balanceMinor,18800);
  } finally {await db.close();}
});

test('reconciliation rejects a balanced journal whose shop amount differs from the order snapshot', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);await fund(db);
    await db.transaction(()=>postCash(db,{key:'bad-shop',kind:'shop_paid',orderId:'order',riderId:'rider',actorId:'rider',
      entries:[['rider_cash:rider',-9999],['shop_cash:supplier',9999]],evidence:{amountMinor:9999,receiptFileId:'shop-receipt'}}));
    const result=await reconcileCash(db,{orderId:'order'});
    assert.equal(result.journals.every(j=>j.difference==='0'),true);
    assert.equal(result.ok,false);
    assert.ok(result.orderChecks[0].errors.some(e=>e.endsWith('amount_mismatch')));
  } finally {await db.close();}
});

test('cash fair rotation excludes insufficient wallets and concurrent HTTP accepts reserve once', {skip:!process.env.DATABASE_URL},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setup(db);
  await db.transaction(async()=>{
    const store=await loadStore(db),rider=store.users.find(u=>u.id==='rider');
    store.users.push({...rider,id:'rider2',clerkUserId:'clerk_rider2',email:'rider2@example.invalid'});
    store.userRoleMemberships.push({userId:'rider2',role:'rider',createdAt:AT});
    store.approvalCases.push({...store.approvalCases.find(c=>c.userId==='rider'),id:'case_rider2',userId:'rider2'});
    store.orders[0].state='ready_for_dispatch';store.orders[0].riderId=null;
    await saveStore(db,store);
  });
  const made=await call(db,'rider2','/me/rider-wallet/topups',{amountMinor:20000,reference:'RIDER2-FUNDS'});
  await call(db,'ops',`/ops/cash/topups/${made.body.topup.id}/confirm`,{reason:'Bank verified'});
  const api=await apiForTest(t),otherApi=await apiForTest(t);
  const noFunds=await api('rider','GET','/dispatch/offers');assert.equal(noFunds.body.offers.length,0);
  const offered=await api('rider2','GET','/dispatch/offers');assert.equal(offered.status,200,JSON.stringify(offered.body));
  const offer=offered.body.offers.find(o=>o.id==='order');assert.equal(offer.cashAmounts.gridgoMinor,1200);
  const missing=await api('rider2','POST','/dispatch/order/accept',{offerId:offer.dispatchOffer.id});assert.equal(missing.body.error,'cash_shop_funds_confirmation_required');
  const body={offerId:offer.dispatchOffer.id,shopCashConfirmed:true};
  const [a,b]=await Promise.all([api('rider2','POST','/dispatch/order/accept',body,{key:'accept-once'}),otherApi('rider2','POST','/dispatch/order/accept',body,{key:'accept-once'})]);
  assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(b.status,200,JSON.stringify(b.body));
  assert.deepEqual(a.body,b.body);assert.equal((await cashWallet(db,'rider2')).reservedMinor,1200);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cash_journals WHERE kind='wallet_reserved'")).rows[0].n,1);
  assert.equal((await reconcileCash(db)).ok,true);
});

test('cash rollout settings require Super Admin, audit and current version; partial changes preserve edited limits', {skip:!process.env.DATABASE_URL},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setup(db,{cashEnabled:false});const api=await apiForTest(t);
  const initial=await api('admin','GET','/settings');assert.equal(initial.body.settings.cash.enabled,false);
  assert.equal((await api('ops','PATCH','/settings',{expectedVersion:initial.body.version,cash:{enabled:true},reason:'Not allowed'})).status,403);
  assert.equal((await api('admin','PATCH','/settings',{expectedVersion:initial.body.version-1,cash:{enabled:true},reason:'Stale'})).status,409);
  const enabled=await api('admin','PATCH','/settings',{expectedVersion:initial.body.version,cash:{enabled:true,limitMinor:140000,noShowWaitSeconds:900},reason:'Reviewed rollout'});
  assert.equal(enabled.status,200,JSON.stringify(enabled.body));
  const disabled=await api('admin','PATCH','/settings',{expectedVersion:enabled.body.version,cash:{enabled:false},reason:'Disable only'});
  assert.equal(disabled.status,200,JSON.stringify(disabled.body));
  assert.deepEqual(disabled.body.settings.cash,{enabled:false,limitMinor:140000,noShowWaitSeconds:900});
  const store=await loadStore(db);assert.ok(store.auditLog.some(a=>a.reason==='Reviewed rollout'));
});
