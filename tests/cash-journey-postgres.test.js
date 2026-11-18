import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { saveStore, loadStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { checkoutFixture, AT } from './helpers/promotion-checkout.mjs';
import { parityApiForTest } from './fixtures/read-parity.js';
import { PICKUP_CHECK_CODES } from '../src/operational-model.js';

const skip=!process.env.DATABASE_URL;
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
async function setup(t) {
  const db=createDatabase(process.env);t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE users, platform_settings RESTART IDENTITY CASCADE');
  const store=checkoutFixture();store.vouchers.forEach(v=>v.status='void');
  store.approvalCases.push({id:'case_rider',userId:'rider',kind:'rider',status:'approved',version:1,applicationRevision:1,createdAt:AT,updatedAt:AT});
  for(const [fileId,purpose,ownerId]of [
    ['finished','finished_product_photo','supplier'],['start','production_photo','supplier'],['packed','packing_photo','rider'],
    ['shop-sign','handoff_signature','rider'],['drop','delivery_photo','rider'],['client-sign','acknowledgement_signature','rider'],
    ['cash-shop','cash_shop_receipt','rider'],['no-show','cash_no_show_photo','rider'],['returned','cash_return_photo','ops'],
    ['new-artwork','artwork','client'],['shop-qr','supplier_payout_qr','supplier'],['shop-new-qr','supplier_payout_qr','supplier'],
    ['problem','refund_evidence','client'],['reprint-paid','cash_reprint_receipt','ops'],
  ])store.files.push({fileId,purpose,ownerId,state:'ready',objectKey:`private/${fileId}`,originalFilename:`${fileId}.png`,
    declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,references:[],
    ...(purpose==='artwork'?{artworkCheck:{status:'passed',checkedAt:AT}}:{})});
  await db.transaction(()=>saveStore(db,store));
  const api=await parityApiForTest(t,false,Date.parse(AT));
  return {db,api};
}
async function cashSetting(api,enabled) {
  const current=ok(await api('admin','GET','/settings'));
  return ok(await api('admin','PATCH','/settings',{expectedVersion:current.version,reason:'Cash journey rollout test',cash:{enabled}}));
}
async function cashPost(api,actor,orderId,action,body={}) {
  const current=ok(await api(actor,'GET',`/orders/${orderId}/cash`));
  const prefix=actor==='ops'||actor==='admin'?'/ops/cash/orders':actor==='rider'?'/dispatch':'/orders';
  const suffix=actor==='ops'||actor==='admin'?action:`cash/${action}`;
  return api(actor,'POST',`${prefix}/${orderId}/${suffix}`,{expectedVersion:current.cash.version,...body});
}
async function checkout(api) {
  await cashSetting(api,true);
  const made=ok(await api('client','POST','/me/carts',{fulfillmentMode:'delivery',defaultDropoff:{lat:7.07,lng:125.61,label:'Client'}}),201);
  const cartId=made.cart.id;
  ok(await api('client','POST',`/me/carts/${cartId}/lines`,{catalogItemId:'item_supplier',quantity:1,optionIds:[],artworkFileId:'artwork',deadline:'2026-10-30T10:00:00.000Z'}),201);
  const placed=ok(await api('client','POST',`/me/carts/${cartId}/checkout`,{payment:{method:'cash'}}),201);
  assert.equal(placed.order.state,'needs_qa');assert.equal(placed.order.totalMinor,10350);
  assert.equal(ok(await api('client','GET',`/orders/${placed.order.id}/invoice`)).invoice.paymentPlan.method,'cash');
  return placed.order.id;
}
async function produceAndPickUp(api,orderId) {
  const transition=(actor,state,extra={})=>api(actor,'POST',`/orders/${orderId}/transition`,{state,...extra});
  const attach=(actor,fileId)=>api(actor,'POST',`/files/${fileId}/attach`,{orderId});
  ok(await transition('ops','supplier_assigned',{qaChecklist:{artwork:true,spec:true,quantity:true,address:true}}));
  ok(await transition('supplier','payment_authorized'));
  ok(await transition('supplier','production'));
  ok(await attach('supplier','start'));ok(await attach('supplier','finished'));
  ok(await api('supplier','POST',`/orders/${orderId}/production-finished`,{}));
  ok(await api('ops','POST',`/orders/${orderId}/production-review`,{decision:'approved'}));
  ok(await transition('supplier','ready_for_dispatch'));
  const pending=ok(await api('rider','POST','/me/rider-wallet/topups',{amountMinor:20000,reference:'JOURNEY-FUND'}),201);
  ok(await api('ops','POST',`/ops/cash/topups/${pending.topup.id}/confirm`,{reason:'Bank verified'}));
  const offered=ok(await api('rider','GET','/dispatch/offers')).offers.find(o=>o.id===orderId);
  assert.ok(offered);assert.deepEqual(offered.cashAmounts,{shopMinor:1000,collectMinor:10350,gridgoMinor:2230,riderMinor:7120});
  ok(await api('rider','POST',`/dispatch/${orderId}/accept`,{offerId:offered.dispatchOffer.id,shopCashConfirmed:true}));
  ok(await cashPost(api,'rider',orderId,'shop-payment',{amountMinor:1000,receiptFileId:'cash-shop'}));
  for(const path of [`/orders/${orderId}/payments/initial/confirm`,`/orders/${orderId}/milestones/cash_shop/release`]) {
    assert.equal((await api('ops','POST',path,{})).body.error,'cash_route_required');
  }
  for(const state of ['rider_assigned','cancelled','delivered']) {
    assert.equal((await api('ops','POST',`/orders/${orderId}/transition`,{state})).body.error,'cash_governed_handover_required');
  }
  for(const milestone of ['heading_to_shop','at_shop'])ok(await api('rider','POST',`/dispatch/${orderId}/milestones`,{milestone}));
  const item=ok(await api('rider','GET',`/orders/${orderId}`)).order.pickupCountItems[0];
  ok(await api('rider','POST',`/dispatch/${orderId}/pickup-checklist`,{checks:PICKUP_CHECK_CODES.map(code=>({code,passed:true})),counts:[{lineItemId:item.lineItemId,countedQuantity:1}]}));
  ok(await attach('rider','packed'));ok(await attach('rider','shop-sign'));
  assert.equal(ok(await api('rider','POST',`/dispatch/${orderId}/pickup-confirm`,{signature:{fileId:'shop-sign',signerName:'Shop Person'}})).order.state,'picked_up');
  assert.equal(ok(await transition('rider','out_for_delivery')).order.state,'out_for_delivery');
  ok(await api('rider','POST',`/dispatch/${orderId}/milestones`,{milestone:'arrived'}));
}
async function complete(api,orderId) {
  ok(await api('rider','POST','/files/drop/attach',{orderId}));
  const collected=ok(await cashPost(api,'rider',orderId,'collect',{cashReceived:true,amountReceivedMinor:10350,evidenceFileId:'drop'}));
  assert.equal(collected.receipt.payments[0].type,'cash');
  ok(await api('rider','POST','/files/client-sign/attach',{orderId}));
  const body={evidenceType:'photo',evidenceFileId:'drop',receiptMode:'digital',acknowledgementSignature:{fileId:'client-sign',signerName:'Client',arNumber:collected.receipt.arNumber}};
  const first=await api('rider','POST',`/dispatch/${orderId}/delivery`,body,{key:'journey-delivery'});
  assert.equal(ok(first).order.state,'issue_window_open');
  assert.deepEqual(await api('rider','POST',`/dispatch/${orderId}/delivery`,body,{key:'journey-delivery'}),first);
  return collected;
}

test('cash checkout reaches signed collection through real QA, offer, shop payment, pickup and rider milestones; every movement reconciles',{skip},async t=>{
  const {db,api}=await setup(t),orderId=await checkout(api);
  await produceAndPickUp(api,orderId);await cashSetting(api,false);await complete(api,orderId);
  assert.equal(ok(await api('client','POST',`/orders/${orderId}/confirm`,{})).order.state,'completed');
  assert.equal(ok(await api('ops','POST',`/orders/${orderId}/transition`,{state:'payout_released'})).order.state,'payout_released');
  const wallet=ok(await api('rider','GET','/me/rider-wallet')).wallet;
  assert.equal(wallet.balanceMinor,17770);assert.equal(wallet.reservedMinor,0);
  assert.equal(ok(await api('ops','GET',`/ops/cash/reconciliation?orderId=${orderId}`)).ok,true);
  const store=await loadStore(db);
  for(const actor of ['ops','admin'])assert.ok(store.notifications.some(n=>n.userId===actor&&n.type==='rider_delivery_milestone'&&n.orderId===orderId));
  assert.equal((await db.query("SELECT count(*)::int n FROM cash_journals WHERE order_id=$1 AND kind='gridgo_share_debited'",[orderId])).rows[0].n,1);
});

test('cash artwork correction and client resubmission preserve the normal QA lifecycle',{skip},async t=>{
  const {api}=await setup(t),orderId=await checkout(api);
  const correction=ok(await api('ops','POST',`/orders/${orderId}/transition`,{state:'client_correction',note:'Replace the low-resolution artwork',qaAction:'request_file',qaChecklist:{artwork:false,spec:true,quantity:true,address:true}}));
  assert.equal(correction.order.state,'client_correction');
  ok(await api('client','POST','/files/new-artwork/attach',{orderId}));
  const submitted=ok(await api('client','POST',`/orders/${orderId}/transition`,{state:'needs_qa'}));
  assert.equal(submitted.order.fileCheck.status,'pending');
  assert.equal(submitted.order.cash.status,'due');
  await produceAndPickUp(api,orderId);await complete(api,orderId);
  assert.equal(ok(await api('ops','GET','/ops/cash/reconciliation')).ok,true);
});

test('cash no-show follows real checkout and arrival, enforces server wait, and returns the exact shop advance once',{skip},async t=>{
  const {api}=await setup(t),orderId=await checkout(api);await produceAndPickUp(api,orderId);
  ok(await cashPost(api,'rider',orderId,'no-show-start',{contactMethod:'call'}));
  const early=await cashPost(api,'rider',orderId,'no-show-report',{reason:'No answer',photoFileId:'no-show'});
  assert.equal(early.body.error,'cash_wait_not_elapsed');
  const later=await parityApiForTest(t,false,Date.parse(AT)+600000);
  ok(await cashPost(later,'rider',orderId,'no-show-report',{reason:'No answer',photoFileId:'no-show'}));
  const current=ok(await later('ops','GET',`/orders/${orderId}/cash`));
  const body={expectedVersion:current.cash.version,reason:'Print returned to GRIDGO',returnPhotoFileId:'returned'};
  const approved=await later('ops','POST',`/ops/cash/orders/${orderId}/approve-no-show`,body,{key:'journey-no-show'});ok(approved);
  assert.deepEqual(await later('ops','POST',`/ops/cash/orders/${orderId}/approve-no-show`,body,{key:'journey-no-show'}),approved);
  const wallet=ok(await later('rider','GET','/me/rider-wallet')).wallet;
  assert.equal(wallet.balanceMinor,21000);assert.equal(wallet.reservedMinor,0);
  assert.equal(ok(await later('ops','GET',`/ops/cash/reconciliation?orderId=${orderId}`)).ok,true);
});

test('cash OFF refuses new wallet funding but keeps balances readable and existing pending decisions resolvable',{skip},async t=>{
  const {db,api}=await setup(t);
  assert.equal(ok(await api('admin','GET','/settings')).settings.cash.enabled,false);
  const off=await api('rider','POST','/me/rider-wallet/topups',{amountMinor:20000,reference:'OFF-FUND'});
  assert.equal(off.status,409,JSON.stringify(off.body));assert.equal(off.body.error,'cash_disabled');
  assert.equal((await db.query('SELECT count(*)::int n FROM cash_journals')).rows[0].n,0);
  await cashSetting(api,true);
  const pending=[];
  const original=[];
  for(const amountMinor of [20000,50000,100000]) {
    const response=await api('rider','POST','/me/rider-wallet/topups',{amountMinor,reference:`ON-${amountMinor}`},{key:`fund-${amountMinor}`});
    original.push(response.body);pending.push(ok(response,201).topup.id);
  }
  ok(await api('ops','POST',`/ops/cash/topups/${pending[0]}/confirm`,{reason:'Verified before shutdown'}));
  await cashSetting(api,false);
  assert.deepEqual(ok(await api('rider','POST','/me/rider-wallet/topups',{amountMinor:20000,reference:'ON-20000'},{key:'fund-20000'}),201),original[0]);
  assert.equal(ok(await api('rider','GET','/me/rider-wallet')).wallet.balanceMinor,20000);
  ok(await api('ops','POST',`/ops/cash/topups/${pending[1]}/confirm`,{reason:'Previously submitted transfer verified'}));
  ok(await api('ops','POST',`/ops/cash/topups/${pending[2]}/reject`,{reason:'No bank transfer'}));
  assert.equal(ok(await api('rider','GET','/me/rider-wallet')).wallet.balanceMinor,70000);
  assert.equal((await api('rider','POST','/me/rider-wallet/topups',{amountMinor:50000,reference:'OFF-AGAIN'})).body.error,'cash_disabled');
  assert.equal(ok(await api('ops','GET','/ops/cash/reconciliation')).ok,true);
});

test('reserved and unknown cash reprint transfers lock the shop receiving account until confirmed not sent or paid',{skip},async t=>{
  const {db,api}=await setup(t),orderId=await checkout(api);
  await produceAndPickUp(api,orderId);await complete(api,orderId);
  const issue=ok(await api('client','POST',`/orders/${orderId}/issues`,{problemType:'damage',description:'Packed work was damaged in transit',photoFileIds:['problem']}),201).issue;
  const decision=ok(await api('ops','POST',`/issues/${issue.id}/decision`,{expectedVersion:1,fault:'rider',remedy:'reprint',costMinor:2000,gridgoCostMinor:2000,
    evidenceIds:['rider_check'],reason:'Pickup was undamaged; delivery evidence shows damage'})).issue.faultDecision;
  ok(await api('supplier','PATCH','/me/payout-account',{expectedVersion:0,provider:'gcash',accountName:'Printer',accountNumber:'09171234567',qrFileId:'shop-qr'}),201);
  const reserve={issueId:issue.id,decisionId:decision.id,destinationVerified:true,supplierDestinationVersion:1,sourceWallet:'OPERATIONS',provider:'GCASH'};
  ok(await cashPost(api,'ops',orderId,'remedy-reserve',reserve));
  for(const status of ['reserved','unknown']) {
    if(status==='unknown')ok(await cashPost(api,'ops',orderId,'remedy-reconcile',{outcome:'unknown',reason:'Provider timed out'}));
    for(const body of [{accountName:'Changed recipient'},{qrFileId:'shop-new-qr'},{qrFileId:null}]) {
      const blocked=await api('supplier','PATCH','/me/payout-account',{expectedVersion:1,...body});
      assert.equal(blocked.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error,'cash_remedy_destination_locked');
    }
    assert.equal((await api('supplier','DELETE','/me/payout-account?expectedVersion=1')).body.error,'cash_remedy_destination_locked');
    const account=ok(await api('supplier','GET','/me/payout-account')).payoutAccount;
    assert.equal(account.version,1);assert.equal(account.accountName,'Printer');assert.equal(account.qr.fileId,'shop-qr');
    assert.equal(ok(await api('ops','GET',`/orders/${orderId}/cash`)).cash.progress.remedy.destination.qrFileId,'shop-qr');
  }
  ok(await cashPost(api,'ops',orderId,'remedy-reconcile',{outcome:'not_sent',noTransferConfirmed:true,reason:'Bank confirmed no transfer'}));
  assert.equal(ok(await api('supplier','PATCH','/me/payout-account',{expectedVersion:1,qrFileId:'shop-new-qr'})).payoutAccount.version,2);
  ok(await cashPost(api,'ops',orderId,'remedy-reserve',{...reserve,supplierDestinationVersion:2}));
  ok(await cashPost(api,'ops',orderId,'remedy-pay',{amountMinor:2000,reference:'REPRINT-JOURNEY',receiptFileId:'reprint-paid'}));
  assert.equal(ok(await api('supplier','DELETE','/me/payout-account?expectedVersion=2')).payoutAccount,null);
  const paid=(await db.query("SELECT evidence FROM cash_journals WHERE order_id=$1 AND kind='remedy_paid'",[orderId])).rows[0].evidence;
  assert.equal(paid.destination.qrFileId,'shop-new-qr');
  assert.equal(ok(await api('rider','GET','/me/rider-wallet')).wallet.balanceMinor,17770);
  assert.equal(ok(await api('ops','GET',`/ops/cash/reconciliation?orderId=${orderId}`)).ok,true);
});
