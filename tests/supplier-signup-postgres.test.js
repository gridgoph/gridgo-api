import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { PAYOUT_CONSENT_WORDING } from '../src/supplier-signup.js';
import { defaultTaxonomy } from '../src/taxonomy.js';
import { createSignupDocuments } from '../src/document-capabilities.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { startExpressAcceptance } from '../src/express-orders.js';
const skip=!process.env.DATABASE_URL;
const supplier={headers:{'X-GRIDGO-Role':'supplier'}};
const ok=r=>{assert.ok(r.status>=200&&r.status<300,JSON.stringify(r.body));return r.body;};
async function setup(t,emptyOrders=false) {
  const db=createDatabase(process.env);t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store=fixture();store.taxonomy=defaultTaxonomy();
  if(emptyOrders)for(const key of ['orders','orderJobs','orderLineItems','orderLineItemOptions','orderInvoices'])store[key]=[];
  await db.transaction(()=>saveStore(db,store));
  const clerk=http.createServer((req,res)=>{
    const subject=/^\/v1\/users\/([^/?]+)/.exec(req.url)?.[1];
    const key=subject?.replace('clerk_','');const mobile=key==='other'?'+639170000002':'+639170000001';
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({object:'user',id:subject,first_name:'Contact',last_name:'',
      primary_email_address_id:'email',primary_phone_number_id:'phone',email_addresses:[{object:'email_address',id:'email',email_address:`${key}@example.invalid`,verification:{status:'verified'},linked_to:[]}],
      phone_numbers:[{object:'phone_number',id:'phone',phone_number:mobile,verification:{status:'verified'},linked_to:[]}],external_accounts:[],web3_wallets:[],public_metadata:{},private_metadata:{},unsafe_metadata:{},created_at:0,updated_at:0}));
  });
  await new Promise(r=>clerk.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>clerk.close(r)));
  const env={CLERK_API_URL:`http://127.0.0.1:${clerk.address().port}`};
  const api=await apiForTest(t,env,{onOutput:chunk=>{if(/error|constraint|Error/.test(chunk))process.stderr.write(chunk);}});
  return {db,api,env};
}
async function enroll(api) {
  const path='/auth/clerk/supplier-signup';
  assert.equal((await api(null,'GET',path)).status,401);
  const sample=await api('client','GET',`${path}/document-sample`,null,{raw:true});
  assert.equal(sample.status,200);assert.equal(sample.headers.get('content-type'),'image/png');
  assert.ok(Number(sample.headers.get('content-length'))>100);
  ok(await api('client','PATCH',path,{expectedVersion:0,step:'eligibility',value:{shopKind:'home_printer',registrantRole:'manager',adult:true}}));
  ok(await api('client','PATCH',path,{expectedVersion:1,step:'shop',value:{shopName:'New shop',contactName:'Contact',phone:'+639170000001',ownerPhone:'+639170000002'}}));
  const wording=ok(await api('client','GET',path)).locationConsentWording;
  ok(await api('client','PATCH',path,{expectedVersion:2,step:'location',value:{point:{lat:7.06,lng:125.6,label:'Pickup'},consent:{accepted:true,wording}}}));
  ok(await api('client','PATCH',path,{expectedVersion:3,step:'prints',value:{groups:['documents'],documents:{papers:['short','a4','a3'],colours:['bw'],duplex:false,a3PricesMinor:{bw:1100},finishing:{}}}}));
  const body=ok(await api('client','POST','/auth/clerk/enroll/supplier',{signupVersion:4,jobsHandledBy:'me_and_staff'},{key:'guided-enrollment'}));
  assert.ok(body.supplierServices.every(s=>s.referenceRateMinor>0));return body;
}
test('HTTP manager signup resumes across processes; owner claim enables private QR setup and persisted destination holds',{skip},async t=>{
  const {db,api,env}=await setup(t);await enroll(api);
  const second=await apiForTest(t,env);
  const resumed=ok(await second('client','GET','/auth/clerk/supplier-signup'));
  assert.equal(resumed.signup.supplierId,'client');assert.equal(resumed.signup.nextStep,'hours');
  assert.equal(resumed.signup.steps.location.consent.wording,resumed.locationConsentWording);
  assert.ok(Date.parse(resumed.signup.steps.location.consent.at)>Date.parse('2026-11-01'));
  const manager=ok(await api('client','GET','/auth/me/supplier',null,supplier));assert.equal(manager.shop.role,'manager');
  assert.equal((await api('client','GET','/me/payout-account',null,supplier)).body.error,'shop_owner_required');
  assert.equal(ok(await api('client','GET','/me/payout-status',null,supplier)).payoutStatus.reason,'shop_owner_claim_required');
  const invite=ok(await api('client','POST','/me/shop-team/invites',{kind:'owner'},supplier));
  const issued=await db.query('SELECT * FROM shop_invites WHERE id=$1',[invite.invite.id]);
  assert.equal(issued.rows[0].lifetime_hours,24);
  await assert.rejects(db.query('UPDATE shop_invites SET claimed_by=$1,claimed_at=now() WHERE id=$2',['rider',invite.invite.id]),/explicit owner claim/);
  assert.equal((await api('client','POST','/auth/shop-invites/claim',{token:invite.token})).body.error,'shop_invite_identity_mismatch');
  const claimed=ok(await api('other','POST','/auth/shop-invites/claim',{token:invite.token}));assert.equal(claimed.member.role,'owner');assert.equal(claimed.member.status,'active');
  assert.equal(ok(await api('client','GET','/auth/me/supplier',null,supplier)).shop.role,'manager');
  const selected={headers:{'X-GRIDGO-Role':'supplier','X-GRIDGO-Shop-Id':'client'}};
  await db.transaction(async()=>{
    const store=await loadStore(db);
    for(const fileId of ['signup_qr_1','signup_qr_2'])store.files.push({fileId,ownerId:'client',createdByUserId:'other',purpose:'supplier_payout_qr',state:'ready',objectKey:fileId,
      declaredContentType:'image/png',detectedContentType:'image/png',originalFilename:'receiving-qr.png',size:100,createdAt:AT,readyAt:AT,references:[]});
    await saveStore(db,store);
  });
  const account={provider:'other',accountName:'Recipient',qrFileId:'signup_qr_1',holder:'family',consent:{accepted:true,wording:PAYOUT_CONSENT_WORDING}};
  assert.equal((await api('other','PATCH','/me/payout-account',{...account,consent:{accepted:false}},selected)).body.error,'payout_consent_required');
  ok(await api('other','PATCH','/me/payout-account',account,selected));
  const changed=ok(await api('other','PATCH','/me/payout-account',{...account,expectedVersion:1,qrFileId:'signup_qr_2'},selected)).payoutAccount;
  assert.equal(changed.payoutStatus.reason,'supplier_payout_paused');
  const staffAccount=ok(await api('ops','GET','/users/client/payout-account')).payoutAccount;
  assert.deepEqual(staffAccount.payoutStatus,changed.payoutStatus);
  assert.equal(staffAccount.consent.at,changed.consent.at);
  assert.equal(staffAccount.holder,'family');
  const state=await loadStore(db);
  assert.equal(state.shopMemberships.find(m=>m.shopId==='client'&&m.userId==='client').role,'staff');
  assert.equal(state.supplierPayoutPolicies.find(p=>p.supplierId==='client').pausedUntil,changed.payoutStatus.pausedUntil);
  assert.ok(state.notifications.some(n=>n.userId==='other'&&n.type==='supplier_payout_account_changed'));
  // Literal legacy upsert: its omitted policy columns cannot reset consent or the hold.
  await db.query(`INSERT INTO supplier_payout_accounts(supplier_id,provider,account_name,account_number,institution,qr_file_id,version,updated_at)
    VALUES('client','other','Recipient',NULL,NULL,'signup_qr_2',2,now()) ON CONFLICT(supplier_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`);
  assert.equal((await db.query("SELECT paused_until FROM supplier_payout_policies WHERE supplier_id='client'")).rows[0].paused_until,changed.payoutStatus.pausedUntil);
});

test('A3 payment is unavailable before acceptance, blocks production while unpaid, and confirms without a second artwork review',{skip},async t=>{
  const {db,api}=await setup(t,true);let sequence=0;const id=prefix=>`a3_${prefix}_${++sequence}`;
  const store=await loadStore(db);store.orders=[];store.orderJobs=[];store.orderLineItems=[];store.orderLineItemOptions=[];store.orderInvoices=[];
  const [service]=createSignupDocuments(store,'supplier',{papers:['a3'],colours:['bw'],duplex:true,a3PricesMinor:{bw:1200},finishing:{}},{id,at:AT});
  store.supplierServices.find(s=>s.supplierId==='replacement').documentCapabilities={papers:['a4'],colours:['bw'],duplex:false};
  service.state='live';const item=store.catalogItems.at(-1);item.reviewStatus='approved';
  store.files.push({...store.files.find(f=>f.fileId==='photo_supplier'),fileId:'a3_sample',objectKey:'a3_sample',references:[]});
  store.catalogItemPhotos.push({catalogItemId:item.id,fileId:'a3_sample',sortOrder:0,createdAt:AT});
  store.files.push({fileId:'signup_art',ownerId:'client',purpose:'artwork',state:'ready',objectKey:'art.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',originalFilename:'art.pdf',size:100,createdAt:AT,detected:{pageCount:2},artworkCheck:{status:'passed'},references:[]},
    {fileId:'signup_payment',ownerId:'client',purpose:'payment_proof',state:'ready',objectKey:'payment.png',declaredContentType:'image/png',detectedContentType:'image/png',originalFilename:'payment.png',size:100,createdAt:AT,references:[]});
  const call=(path,body)=>routeOrderMatch({req:{method:'POST'},url:new URL(`http://test${path}`),store,user:store.users.find(u=>u.id==='client'),readBody:async()=>body,id,now:()=>AT});
  const draft=await call('/express/drafts',{supplierId:'supplier',location:{lat:7.06,lng:125.6},fulfillmentMode:'pickup',files:[{fileId:'signup_art',copies:2,colour:'bw',paper:'a3',sides:'two',layout:'fit_to_paper',acceptedWarnings:[]}]});
  const placed=await call(`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation});
  const order=store.orders.find(o=>o.id===placed.body.order.id);const path=`/orders/${order.id}`;
  await db.transaction(()=>saveStore(db,store));
  const candidates=ok(await api('ops','GET',`${path}/eligible-suppliers`)).candidates;
  assert.equal(candidates.find(c=>c.supplier.id==='replacement').eligible,false);
  assert.ok(candidates.find(c=>c.supplier.id==='replacement').reasons.includes('document_capability_unavailable'));
  assert.equal((await api('client','POST',`${path}/payments/initial/submit`,{method:'qr_manual',reference:'A3',proofFileId:'signup_payment'})).body.error,'initial_payment_not_available');
  await db.transaction(async()=>{const current=await loadStore(db),o=current.orders.find(o=>o.id===order.id);o.fileCheck.status='passed';o.state='supplier_assigned';startExpressAcceptance(o,new Date().toISOString());await saveStore(db,current);});
  assert.equal((await api('supplier','POST',`${path}/transition`,{state:'payment_authorized'},supplier)).body.error,'payment_required');
  ok(await api('supplier','POST',`${path}/express/accept`,{},supplier));
  assert.equal((await api('supplier','POST',`${path}/transition`,{state:'production'},supplier)).body.error,'payment_required');
  ok(await api('client','POST',`${path}/payments/initial/submit`,{method:'qr_manual',reference:'A3',proofFileId:'signup_payment'}));
  ok(await api('ops','POST',`${path}/payments/initial/confirm`,{}));
  const paid=(await loadStore(db)).orders.find(o=>o.id===order.id);
  assert.equal(paid.state,'payment_authorized');assert.equal(paid.fileCheck.status,'passed');assert.equal(paid.supplierSubtotalMinor,4800);
  assert.equal(paid.payments.initial.status,'confirmed');
  await assert.rejects(db.query("UPDATE orders SET data=jsonb_set(data,'{expressOrder,paymentTiming}','\"checkout\"') WHERE id=$1",[order.id]),/payment timing is immutable/);
});

test('destination pause blocks payout preparation and recording without reserving verification capacity',{skip},async t=>{
  const {db,api}=await setup(t);
  await db.transaction(async()=>{
    const store=await loadStore(db);
    store.supplierPayoutPolicies=[{supplierId:'supplier',pausedUntil:new Date(Date.now()+86400000).toISOString(),updatedAt:new Date().toISOString()}];
    await saveStore(db,store);
  });
  const base='/orders/order/milestones/production_started';
  for(const action of ['prepare','release']) {
    const response=await api('ops','POST',`${base}/${action}`,{amountMinor:4000,reference:'PAYOUT'});
    assert.equal(response.status,409);
    assert.equal(response.body.error,'supplier_payout_paused');
  }
  const store=await loadStore(db);
  assert.equal(store.orders[0].payoutMilestones[0].status,'pending_pof');
  assert.equal(store.supplierVerificationLedger.length,0);
});
