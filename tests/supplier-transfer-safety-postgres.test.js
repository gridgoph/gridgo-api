import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore} from '../src/postgres-store.js';
import {prepareVerificationPayout,completeVerificationPayout,cancelVerificationReservation,recordVerificationRecovery} from '../src/supplier-verification.js';
import {apiForTest} from './fixtures/reschedule-http.js';
import {setupVerification} from './fixtures/supplier-verification.js';
import {AT,ORIGINAL,PROPOSED,id,request,answer,call} from './fixtures/reschedule.js';
const skip=!process.env.DATABASE_URL;
async function mutate(db,fn){return db.transaction(async()=>{const s=await loadStore(db);const result=await fn(s);await saveStore(db,s);return result;});}

test('one manual payer/attempt wins concurrent preparation; unknown transfers cannot authorize a resend or a changed-reference replay',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setupVerification(db,s=>{for(const ownerId of ['ops','admin'])s.files.push({fileId:`receipt-${ownerId}`,ownerId,purpose:'payout_receipt',state:'ready',objectKey:`private/receipt-${ownerId}`,originalFilename:'receipt.png',declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,references:[]});});const api=await apiForTest(t);
  const base='/orders/order/milestones/production_started';
  const results=await Promise.all(['ops','admin'].map(async actor=>({actor,...await api(actor,'POST',`${base}/prepare`,{})})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);
  const winner=results.find(r=>r.status===200),attemptId=winner.body.payout.attemptId;
  assert.ok(attemptId);assert.equal(winner.body.payout.payerId,winner.actor);
  assert.equal((await api(winner.actor,'POST',`${base}/release`,{amountMinor:4000,reference:'TRANSFER-A'})).body.error,'verification_payout_attempt_required');
  assert.equal((await api(winner.actor,'POST','/orders/order/payout-reservations/reconcile',{payoutKey:'stage:order:production_started',attemptId,outcome:'unknown',reason:'Transfer outcome uncertain'})).status,200);
  assert.equal((await api(winner.actor,'POST',`${base}/prepare`,{})).body.error,'verification_transfer_unknown');
  assert.equal((await db.query("SELECT count(*)::int n FROM supplier_verification_capacity_items WHERE capacity_kind='reserved'")).rows[0].n,1);
  const body={attemptId,amountMinor:4000,reference:'TRANSFER-A'};
  assert.equal((await api(winner.actor,'POST',`${base}/release`,body)).body.error,'verification_transfer_unknown');
  const paid=await api(winner.actor,'POST','/orders/order/payout-reservations/reconcile',{...body,payoutKey:'stage:order:production_started',outcome:'paid',fundsSentConfirmed:true,paidAt:new Date().toISOString(),receiptFileId:`receipt-${winner.actor}`,reason:'Original transfer confirmed'});assert.equal(paid.status,200,JSON.stringify(paid.body));
  assert.equal((await api(winner.actor,'POST',`${base}/release`,body)).body.replayed,true);
  const other=winner.actor==='ops'?'admin':'ops';
  assert.equal((await api(other,'POST',`${base}/release`,{...body,reference:'TRANSFER-B'})).body.error,'verification_transfer_reconciliation_required');
  assert.equal((await db.query("SELECT count(*)::int n FROM supplier_verification_ledger WHERE kind='released'")).rows[0].n,1);
});

test('explicit not-sent reconciliation retires an attempt without allowing stale completion',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setupVerification(db);const api=await apiForTest(t),base='/orders/order/milestones/production_started';
  const first=(await api('ops','POST',`${base}/prepare`,{})).body.payout;
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',{payoutKey:'stage:order:production_started',attemptId:first.attemptId,outcome:'not_sent',reason:'Confirmed no transfer'})).status,400);
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',{payoutKey:'stage:order:production_started',attemptId:first.attemptId,outcome:'not_sent',noFundsSentConfirmed:true,reason:'Confirmed no transfer'})).status,200);
  assert.equal((await api('ops','POST',`${base}/release`,{attemptId:first.attemptId,amountMinor:4000})).body.error,'verification_payout_attempt_required');
  const second=(await api('admin','POST',`${base}/prepare`,{})).body.payout;assert.notEqual(second.attemptId,first.attemptId);
  assert.equal((await api('admin','POST',`${base}/release`,{attemptId:first.attemptId,amountMinor:4000})).body.error,'verification_payout_attempt_required');
});

test('prepared legacy standalone deadline rematches stay with the beneficiary, including a stale offer',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
  for(const reserveFirst of [true,false]) {
    await setupVerification(db,s=>{s.approvalCases.find(c=>c.userId==='supplier').status='approved';s.orderJobs=[];delete s.orderLineItems[0].jobId;s.orders[0].readyBy=ORIGINAL;});
    const reserve=()=>mutate(db,s=>prepareVerificationPayout(s,s.orders[0],{key:'stage:order:production_started',amountMinor:4000,at:AT,actor:s.users.find(u=>u.id==='ops'),id}));
    if(reserveFirst)await reserve();
    await mutate(db,s=>request(s));await mutate(db,s=>answer(s,'decline'));
    if(!reserveFirst)await reserve();
    const s=await loadStore(db),r=s.orders[0].rescheduleRequest;
    if(reserveFirst)assert.equal(r.resolution,'operations_required');
    else {assert.equal(r.resolution,'rematch_offered');assert.equal(r.offer.supplierId,'replacement');}
    await assert.rejects(mutate(db,s=>call(s,'client','rematch',{requestId:r.id,offerId:r.offer?.id,action:'accept'})),e=>e.code===(reserveFirst?'reschedule_rematch_unavailable':'reschedule_operations_required'));
    await assert.rejects(db.transaction(()=>db.query("UPDATE orders SET supplier_id='replacement' WHERE id='order'")),/supplier_transfer_reconciliation_required/);
    assert.equal((await loadStore(db)).orders[0].supplierId,'supplier');
  }
});

test('historical writer cannot spend reserved cap capacity; exact matching release consumes its own reservation once',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setupVerification(db);
  await mutate(db,s=>{s.settings.supplierVerification.payoutCapMinor=5000;return prepareVerificationPayout(s,s.orders[0],{key:'stage:order:production_started',amountMinor:4000,at:AT,actor:s.users.find(u=>u.id==='ops'),id});});
  const hook=`import{registerHooks}from'node:module';import{execFileSync}from'node:child_process';registerHooks({load(url,ctx,next){const name=['postgres-store.js','operational-model.js'].find(n=>url.endsWith('/src/'+n));return name?{format:'module',source:execFileSync('git',['show','c5f55db680e5d35ad6904d5526ace6710c960e92:src/'+name],{encoding:'utf8'}),shortCircuit:true}:next(url,ctx);}});`;
  const script=`import{createDatabase}from'./src/database.js';import{loadStore,saveStore}from'./src/postgres-store.js';import{releaseMilestone}from'./src/operational-model.js';const db=createDatabase(process.env);try{await db.transaction(async()=>{const s=await loadStore(db),o=s.orders[0];o.state='delivered';o.payoutMilestones.find(m=>m.code==='delivered').pofFileIds=['proof'];releaseMilestone(o,'delivered',s.users.find(u=>u.id==='ops'),'${AT}',s);await saveStore(db,s);});process.exitCode=2;}catch(e){if(e.code!=='23514'||e.message!=='verification_payout_cap')throw e;console.log(e.message);}finally{await db.close();}`;
  const result=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(hook)}`,'--input-type=module','-e',script],{env:{PATH:process.env.PATH,HOME:process.env.HOME,DATABASE_URL:process.env.DATABASE_URL},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/verification_payout_cap/);
  await assert.rejects(db.transaction(()=>db.query("UPDATE payout_milestones SET status='released' WHERE order_id='order' AND code='delivered'")),e=>e.code==='23514'&&e.message==='verification_payout_cap');
  await assert.rejects(db.transaction(()=>db.query("UPDATE payout_milestones SET status='superseded' WHERE order_id='order' AND code='production_started'")),/supplier_transfer_reconciliation_required/);
  await assert.rejects(db.transaction(()=>db.query("UPDATE payout_milestones SET amount_minor=3900 WHERE order_id='order' AND code='production_started'")),/supplier_transfer_reconciliation_required/);
  await db.transaction(()=>db.query("UPDATE payout_milestones SET status='released' WHERE order_id='order' AND code='production_started'"));
  assert.equal((await db.query('SELECT sum(amount_minor)::int n FROM supplier_verification_capacity_items')).rows[0].n,4000);
});

test('already-sent preparation reconciles under a refund hold before settlement is calculated, with no resend and no work resumption',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setupVerification(db,s=>{
    for(const [fileId,ownerId,purpose] of [['refund-qr','client','refund_qr'],['transfer-receipt','ops','payout_receipt']])s.files.push({fileId,ownerId,purpose,state:'ready',objectKey:`private/${fileId}`,originalFilename:`${fileId}.png`,declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,references:[]});
  });const api=await apiForTest(t);
  const prepared=await api('ops','POST','/orders/order/milestones/production_started/prepare',{}),attemptId=prepared.body.payout.attemptId;
  const filed=await api('client','POST','/orders/order/refund-requests',{kind:'cancellation',reason:'Request cancellation',destination:{provider:'other',accountName:'Client',qrFileId:'refund-qr',ownershipConfirmed:true}});
  assert.equal(filed.status,201,JSON.stringify(filed.body));
  const path=`/refund-requests/${filed.body.refund.id}`;
  const reviewed=await api('ops','POST',`${path}/review`,{expectedVersion:filed.body.refund.version,reason:'Verified client QR',destinationVerified:true});assert.equal(reviewed.status,200,JSON.stringify(reviewed.body));
  const terms={expectedVersion:reviewed.body.refund.version,shopEntitlementMinor:2000,riderEntitlementMinor:0,totalMinor:9800,workStopped:true,reason:'Agreed settlement',shopAgreement:'Shop agrees the final entitlement',deliveryEvidence:'Delivery obligation reconciled'};
  assert.equal((await api('ops','POST',`${path}/settle`,terms)).body.error,'supplier_transfer_reconciliation_required');
  const forged={attemptId,reference:'TRANSFER-SENT',receiptFileId:'transfer-receipt',amountMinor:4000,fundsSentConfirmed:true};
  await assert.rejects(db.transaction(()=>db.query("UPDATE payout_milestones SET status='released',data=data||jsonb_build_object('transferReconciliation',$1::jsonb) WHERE order_id='order' AND code='production_started'",[JSON.stringify(forged)])),/supplier_transfer_reconciliation_ledger_required/);
  assert.equal((await api('ops','POST','/orders/order/milestones/production_started/release',{attemptId,amountMinor:4000,reference:'TRANSFER-SENT'})).body.error,'refund_fulfillment_stopped');
  const record={payoutKey:'stage:order:production_started',attemptId,outcome:'paid',fundsSentConfirmed:true,paidAt:new Date().toISOString(),amountMinor:4000,reference:'TRANSFER-SENT',receiptFileId:'transfer-receipt',reason:'Evidence confirms the original transfer was already sent'};
  const reconciled=await api('ops','POST','/orders/order/payout-reservations/reconcile',record);assert.equal(reconciled.status,200,JSON.stringify(reconciled.body));
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',record)).body.replayed,true);
  assert.equal((await api('ops','POST','/orders/order/payout-reservations/reconcile',{...record,reference:'OTHER-TRANSFER'})).body.error,'verification_transfer_reconciliation_required');
  const s=await loadStore(db);assert.equal(s.refundRequests[0].status,'reviewed');assert.equal(s.orders[0].state,'production');assert.equal(s.orders[0].payoutMilestones[0].status,'released');
  assert.equal(s.supplierVerificationLedger.filter(e=>e.kind==='released').length,1);assert.equal(s.auditLog.filter(e=>e.action==='supplier_transfer.reconcile_paid').length,1);
  const preview=await api('ops','POST',`${path}/settlement-preview`,{...terms,shopEntitlementMinor:4000,totalMinor:undefined});assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.ok(preview.body.availableTotalMinor<=8000);
  const settled=await api('ops','POST',`${path}/settle`,{...terms,shopEntitlementMinor:4000,totalMinor:preview.body.availableTotalMinor});assert.equal(settled.status,200,JSON.stringify(settled.body));
});

test('reserved regular-job slots stop an old third-job release; delivery frees a slot',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setupVerification(db,s=>{s.settings.supplierVerification.payoutCapMinor=500000;const original=s.orders[0];s.orderJobs=[];s.orderLineItems=[];
    for(const key of ['second','third']){const o=structuredClone(original);o.id=key;s.orders.push(o);}
    for(const o of s.orders.slice(0,2))prepareVerificationPayout(s,o,{key:`stage:${o.id}:production_started`,amountMinor:4000,at:AT,actor:s.users.find(u=>u.id==='ops'),id});});
  await assert.rejects(db.transaction(()=>db.query("UPDATE payout_milestones SET status='released' WHERE order_id='third' AND code='production_started'")),e=>e.code==='23514'&&e.message==='verification_open_jobs');
  await db.transaction(()=>db.query("UPDATE orders SET state='delivered' WHERE id='order'"));
  await db.transaction(()=>db.query("UPDATE payout_milestones SET status='released' WHERE order_id='third' AND code='production_started'"));
});

test('a cap edit cannot invalidate a ready transfer; historical paid amounts do not block a zero-net recovery',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setupVerification(db);
  const prepared=await mutate(db,s=>prepareVerificationPayout(s,s.orders[0],{key:'stage:order:production_started',amountMinor:4000,at:AT,actor:s.users.find(u=>u.id==='ops'),id}));
  const api=await apiForTest(t),version=(await loadStore(db)).version;
  assert.equal((await api('admin','PATCH','/settings',{expectedVersion:version,reason:'Reviewed cap',supplierVerification:{payoutCapMinor:1000,windowDays:30}})).body.error,'verification_policy_reconciliation_required');
  const lower=()=>db.transaction(()=>db.query("UPDATE platform_settings SET settings=jsonb_set(settings,'{supplierVerification,payoutCapMinor}','1000') WHERE singleton"));
  await assert.rejects(lower(),/verification_policy_reconciliation_required/);
  await mutate(db,s=>{const o=s.orders[0],ctx={at:AT,actor:s.users.find(u=>u.id==='ops'),id};
    completeVerificationPayout(s,o,prepared,ctx);o.payoutMilestones[0].status='released';recordVerificationRecovery(s,o,ctx);});
  await lower();
  await mutate(db,s=>{const o=s.orders[0],ctx={at:AT,actor:s.users.find(u=>u.id==='ops'),id};o.state='delivered';
    const offset=prepareVerificationPayout(s,o,{key:'stage:order:delivered',amountMinor:3500,...ctx});assert.equal(offset.netAmountMinor,0);
    completeVerificationPayout(s,o,offset,ctx);o.payoutMilestones[1].status='released';});
});

for(const age of [0,31])test(`pending supplier aged ${age} days uses existing change, deadline and invoice tools with party boundaries`,{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
    await setupVerification(db,s=>{s.userRoleMemberships.find(m=>m.userId==='supplier').createdAt=new Date(Date.now()-age*86400000).toISOString();
      s.supplierInvoices.push({orderId:'order',supplierId:'supplier',expectedAt:AT,month:'2026-10',version:0,collectedAt:null,collectedBy:null});
      s.files.push({fileId:'invoice-scan',ownerId:'supplier',purpose:'supplier_invoice',state:'ready',objectKey:'private/invoice-scan',originalFilename:'invoice.png',declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,references:[]});});
    const api=await apiForTest(t);
    assert.equal((await api('supplier','GET','/jobs')).status,200);
    assert.equal((await api('supplier','GET','/orders/order/change-requests')).status,200);
    const change=await api('supplier','POST','/orders/order/change-requests',{lineItemId:'line',proposedSpec:'Revised print finish',reason:'Client specification clarification',extraPrincipalMinor:0});
    assert.equal(change.status,201,JSON.stringify(change.body));
    assert.equal((await api('client','POST',`/orders/order/change-requests/${change.body.changeRequest.id}/answer`,{expectedVersion:1,answer:'decline'})).status,200);
    const deadline=await api('supplier','POST','/orders/order/reschedule-request',{reason:'Production needs more time',proposedReadyBy:'2099-01-01T00:00:00.000Z'});
    assert.equal(deadline.status,201,JSON.stringify(deadline.body));
    assert.equal((await api('other','GET','/orders/order/change-requests')).status,403);
    assert.equal((await api('replacement','POST','/orders/order/reschedule-request',{reason:'Another shop',proposedReadyBy:'2099-01-02T00:00:00.000Z'})).status,403);
    assert.equal((await api('supplier','POST','/files/invoice-scan/attach',{orderId:'order'})).status,200);
    const invoice=await api('supplier','PUT','/me/supplier-invoices/order',{fileId:'invoice-scan',number:'INV-TEST',date:'2026-10-01',amountMinor:10000,expectedVersion:0});
    assert.equal(invoice.status,200,JSON.stringify(invoice.body));
    await mutate(db,s=>{Object.assign(s.users.find(u=>u.id==='supplier'),{accountStatus:'suspended',accountStatusReason:'Standing review',accountStatusAt:AT,accountStatusBy:'admin'});});
    assert.equal((await api('supplier','GET','/orders/order/change-requests')).status,403);
    assert.equal((await api('supplier','GET','/me/supplier-invoices/order')).status,403);
});

test('eligible pending shops expose their public shop, directory and media with only a positive verified flag',{skip},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setupVerification(db,s=>{
    s.files.push({fileId:'shop-qr',ownerId:'supplier',purpose:'supplier_payout_qr',state:'ready',objectKey:'private/shop-qr',originalFilename:'qr.png',declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,references:[]});
    s.supplierPayoutAccounts.push({supplierId:'supplier',provider:'other',accountName:'Shop',qrFileId:'shop-qr',version:1,updatedAt:AT});
    s.files.push({...s.files.find(f=>f.fileId==='photo_supplier'),fileId:'shop-photo',objectKey:'private/shop-photo',purpose:'supplier_shop_image'});
    s.supplierShopMedia.push({supplierId:'supplier',fileId:'shop-photo',slot:'cover',updatedAt:AT});
  });const api=await apiForTest(t);
  assert.equal((await api('client','GET','/catalog/items/item_supplier')).status,200);
  const shop=await api('client','GET','/catalog/shops/supplier');assert.equal(shop.status,200,JSON.stringify(shop.body));assert.equal(shop.body.shop.verified,false);
  const directory=await api('client','GET','/catalog/shops');assert.equal(directory.body.shops.find(s=>s.supplierId==='supplier').verified,false);
  assert.equal((await api('client','GET','/catalog/media/shop-photo')).status,200);
  await mutate(db,s=>{s.supplierPayoutAccounts=[];});
  assert.equal((await api('client','GET','/catalog/shops/supplier')).status,404);
  assert.equal((await api('client','GET','/catalog/items/item_supplier')).status,404);
});
