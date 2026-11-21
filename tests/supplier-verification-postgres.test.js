import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore} from '../src/postgres-store.js';
import {fixture,AT,id} from './fixtures/reschedule.js';
import {resetDatabase} from './fixtures/reset-database.js';
import {apiForTest} from './fixtures/reschedule-http.js';
import {prepareVerificationPayout,completeVerificationPayout,recordVerificationRecovery,verificationSummary} from '../src/supplier-verification.js';

async function setup(db) {
  await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories RESTART IDENTITY CASCADE');
  const store=fixture(),now=new Date().toISOString();
  store.settings.supplierVerification={payoutCapMinor:4000,windowDays:30};
  store.userRoleMemberships.find(m=>m.userId==='supplier').createdAt=now;
  Object.assign(store.approvalCases.find(c=>c.userId==='supplier'),{status:'pending',createdAt:now,decidedAt:null});
  store.users.find(u=>u.id==='supplier').verificationStatus='pending';
  store.taxonomy.categories.push({id:'documents',code:'document_publication',name:'Documents',active:true});
  store.supplierServices.push({...store.supplierServices[0],id:'documents',categoryCode:'document_publication',state:'live'});
  const order=store.orders[0];order.readyBy=new Date(Date.now()+86400000).toISOString();order.promisedDate=order.readyBy;
  order.payoutMilestones[0].pofFileIds=['proof'];
  store.files.push({fileId:'proof',ownerId:'supplier',purpose:'fulfilment_proof',state:'ready',objectKey:'proof',originalFilename:'proof.png',size:100,
    declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[{type:'order',id:'order',field:'pofFileIds',milestoneCode:'production_started'}]});
  store.files.push({fileId:'id-selfie',ownerId:'supplier',purpose:'verification_document',state:'ready',objectKey:'verification/id-selfie',originalFilename:'id-selfie.png',size:100,
    declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[]});
  store.shopMemberships.push({shopId:'supplier',userId:'other',role:'staff',status:'active',createdAt:AT,updatedAt:AT});
  await db.transaction(()=>saveStore(db,store));
}

test('HTTP reservation/release retries pay once; cap hold persists and verification lifts it; expired shop finishes existing work', {skip:!process.env.DATABASE_URL},async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());await setup(db);
  const types=await db.query("SELECT data_type FROM information_schema.columns WHERE table_name='supplier_verification_ledger' AND column_name IN ('amount_minor','net_amount_minor','recovery_minor')");
  assert.deepEqual(types.rows.map(r=>r.data_type),['bigint','bigint','bigint']);
  const call=await apiForTest(t);
  assert.equal((await call('ops','PATCH','/settings',{expectedVersion:3,reason:'Review',supplierVerification:{payoutCapMinor:1,windowDays:30}})).status,403);
  assert.equal((await call('other','GET','/me/supplier-verification',null,{headers:{'x-gridgo-role':'supplier','x-gridgo-shop-id':'supplier'}})).status,403);
  const attached=await call('supplier','POST','/files/id-selfie/attach',{documentType:'id_selfie'});
  assert.equal(attached.status,200,JSON.stringify(attached.body));
  const checking=await call('supplier','GET','/me/supplier-verification');assert.equal(checking.body.verification.verificationState,'being_checked');
  const base='/orders/order/milestones/production_started';
  const prepared=await call('ops','POST',`${base}/prepare`,{});
  assert.equal(prepared.status,200,JSON.stringify(prepared.body));assert.equal(prepared.body.payout.netAmountMinor,4000);
  const again=await call('ops','POST',`${base}/prepare`,{});assert.deepEqual(again.body,prepared.body);
  const cancelled=await call('ops','POST',`${base}/cancel-reservation`,{noFundsSentConfirmed:true,reason:'No funds were sent; prepare again'});
  assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));
  assert.equal((await call('ops','POST',`${base}/prepare`,{})).status,200);
  assert.equal((await call('ops','POST',`${base}/release`,{amountMinor:3999})).body.error,'verification_net_payout_amount_required');
  const [one,two]=await Promise.all([call('ops','POST',`${base}/release`,{amountMinor:4000}),call('ops','POST',`${base}/release`,{amountMinor:4000})]);
  assert.equal(one.status,200,JSON.stringify(one.body));assert.equal(two.status,200,JSON.stringify(two.body));
  assert.equal((await db.query("SELECT count(*)::int n FROM supplier_verification_ledger WHERE kind='released'")).rows[0].n,1);
  await db.transaction(async()=>{const s=await loadStore(db);const o=s.orders[0];o.state='delivered';o.payoutMilestones.find(m=>m.code==='delivered').pofFileIds=['proof'];await saveStore(db,s);});
  const held=await call('ops','POST','/orders/order/milestones/delivered/prepare',{});
  assert.equal(held.status,202,JSON.stringify(held.body));assert.equal(held.body.payout.items[0].reason,'verification_payout_cap');
  const queue=await call('admin','GET','/approval-cases?kind=supplier');
  assert.equal(queue.status,200,JSON.stringify(queue.body));assert.equal(queue.body.approvalCases[0].verification.paidBeforeVerificationMinor,4000);assert.equal(queue.body.approvalCases[0].verificationDocuments[0].fileId,'id-selfie');
  const opsQueue=await call('ops','GET','/ops/supplier-verification');
  assert.equal(opsQueue.status,200,JSON.stringify(opsQueue.body));assert.equal(opsQueue.body.suppliers[0].verification.paidBeforeVerificationMinor,4000);
  assert.equal(opsQueue.body.suppliers[0].history,undefined);
  assert.equal((await call('client','GET','/ops/supplier-verification')).status,403);
  assert.equal((await call('ops','GET','/approval-cases')).status,403);
  const opsDetail=await call('ops','GET','/ops/supplier-verification/supplier');assert.equal(opsDetail.status,200);assert.ok(opsDetail.body.supplier.ledger.length>0);
  const approval=await call('admin','POST','/approval-cases/case_supplier/approve',{expectedVersion:1,requestId:'verify-shop'});
  assert.equal(approval.status,200,JSON.stringify(approval.body));
  const released=await call('ops','POST','/orders/order/milestones/delivered/release',{});
  assert.equal(released.status,200,JSON.stringify(released.body));
  assert.equal((await db.query("SELECT count(*)::int n FROM supplier_verification_ledger WHERE kind='available'")).rows[0].n,1);
  // A separate pending case passes its deadline; existing job reads still work.
  await db.transaction(async()=>{const s=await loadStore(db);s.approvalCases.find(c=>c.userId==='supplier').status='pending';
    s.userRoleMemberships.find(m=>m.userId==='supplier').createdAt=new Date(Date.now()-31*86400000).toISOString();await saveStore(db,s);});
  const status=await call('supplier','GET','/me/supplier-verification');assert.equal(status.status,200);assert.equal(status.body.verification.newOrdersPaused,true);
  const jobs=await call('supplier','GET','/jobs');assert.equal(jobs.status,200,JSON.stringify(jobs.body));assert.equal(jobs.body.jobs[0].id,'order');
});

test('ledger persists recovery offsets and cap reserves under the transaction lock; old-shaped payout write cannot exceed cap', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await setup(db);
    await db.transaction(async()=>{const s=await loadStore(db),o=s.orders[0],ctx={at:AT,actor:s.users.find(u=>u.id==='ops'),id};
      const prepared=prepareVerificationPayout(s,o,{key:'stage:order:production_started',amountMinor:4000,...ctx});
      completeVerificationPayout(s,o,prepared,ctx);o.payoutMilestones[0].status='released';o.payoutMilestones[0].releasedAt=AT;
      recordVerificationRecovery(s,o,ctx);await saveStore(db,s);});
    await assert.rejects(db.transaction(()=>db.query("UPDATE payout_milestones SET status='released' WHERE order_id='order' AND code='delivered'")),/verification_payout_cap/);
    await db.transaction(async()=>{const s=await loadStore(db),o=s.orders[0],ctx={at:AT,actor:s.users.find(u=>u.id==='ops'),id};
      assert.equal(verificationSummary(s,'supplier',AT).recoveryDueMinor,4000);
      const prepared=prepareVerificationPayout(s,o,{key:'stage:order:delivered',amountMinor:3500,...ctx});
      assert.equal(prepared.netAmountMinor,0);completeVerificationPayout(s,o,prepared,ctx);o.payoutMilestones[1].status='released';await saveStore(db,s);});
    await db.transaction(async()=>{const s=await loadStore(db);assert.equal(verificationSummary(s,'supplier',AT).recoveryDueMinor,500);});
    await assert.rejects(db.transaction(()=>db.query("UPDATE supplier_verification_ledger SET amount_minor=0 WHERE kind='recovery_due'")),/immutable/);
  } finally {await db.close();}
});

test('Express plan 4 persists independently of frozen regular plans', {skip:!process.env.DATABASE_URL},async()=>{
  const db=createDatabase(process.env);
  try {
    await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories RESTART IDENTITY CASCADE');
    const s=fixture(),o=s.orders[0];o.orderType='express';o.expressOrder={version:1,originalSupplierId:'supplier',pickupCode:'123456',printSettings:[]};
    const {snapshotPayoutPlan}=await import('../src/operational-model.js');snapshotPayoutPlan(o);
    await db.transaction(()=>saveStore(db,s));
    const loaded=await loadStore(db);assert.equal(loaded.orders[0].payoutPlanVersion,4);assert.equal(loaded.orders[0].payoutMilestones.length,1);
    await assert.rejects(db.transaction(()=>db.query("UPDATE payout_milestones SET amount_minor=9999 WHERE order_id='order'")),/invalid Express payout plan/);
  } finally {await db.close();}
});

test('pending shop demand delivery reloads setup eligibility and retains the shared pause gate', {skip:!process.env.DATABASE_URL},async()=>{
  const {loadDeliveryStore}=await import('../src/postgres-store.js');
  const {deviceAcceptsNotification}=await import('../src/push-outbox.js');
  const db=createDatabase(process.env),at='2026-11-23T19:00:00+08:00';
  try {
    await setup(db);
    await db.transaction(async()=>{const s=await loadStore(db),profile=s.supplierProfiles.find(p=>p.userId==='supplier');
      s.userRoleMemberships.find(m=>m.userId==='supplier').createdAt='2026-11-22T00:00:00.000Z';
      profile.availability={nightJobs:'until_21',printerDemandPings:true};
      s.files.push({fileId:'demand-qr',ownerId:'supplier',purpose:'supplier_payout_qr',state:'ready',objectKey:'private/demand-qr',originalFilename:'qr.png',size:100,
        declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[{type:'supplier_payout_account',id:'supplier',field:'qr'}]});
      s.supplierPayoutAccounts.push({supplierId:'supplier',provider:'other',accountName:'Shop',qrFileId:'demand-qr',version:1,updatedAt:AT});
      s.notifications.push({id:'pending-demand',userId:'supplier',shopId:'supplier',appRole:'supplier',type:'printer_demand',night:'2026-11-23',expiresAt:'2026-11-23T21:00:00+08:00',at,title:'Printing demand',body:'Nearby demand'});
      await saveStore(db,s);});
    const loaded=await loadDeliveryStore(db,{userIds:['supplier'],notificationIds:['pending-demand']}),device={userId:'supplier',appRole:'supplier',platform:'android'};
    assert.equal(deviceAcceptsNotification(loaded,device,loaded.notifications[0],at),true);
    loaded.supplierProfiles[0].availability.pausedUntil=new Date(Date.parse(at)+3600000).toISOString();
    assert.equal(deviceAcceptsNotification(loaded,device,loaded.notifications[0],at),false);
  }finally{await db.close();}
});
