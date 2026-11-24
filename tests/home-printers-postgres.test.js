import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT, id } from './fixtures/reschedule.js';
import { parityApiForTest } from './fixtures/read-parity.js';
import { defaultTaxonomy } from '../src/taxonomy.js';
import { startExpressAcceptance } from '../src/express-orders.js';
import { HOME_FILE_AGREEMENT, HOME_PIN_CONSENT } from '../src/home-printers.js';
const skip=!process.env.DATABASE_URL;
const supplier={headers:{'X-GRIDGO-Role':'supplier'}};
const ok=r=>{assert.ok(r.status>=200&&r.status<300,JSON.stringify(r.body));return r.body;};
async function setup(t) {
 const db=createDatabase(process.env);t.after(()=>db.close());
 await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
 const store=fixture();store.taxonomy=defaultTaxonomy();
 for(const key of ['orders','orderJobs','orderLineItems','orderLineItemOptions','orderInvoices','catalogOptionGroups','catalogOptions'])store[key]=[];
 for(const item of store.catalogItems)Object.assign(item,{subcategoryCode:'document_printing',express:true,pricingUnit:'per_page',printLayouts:['fit_to_paper'],basePriceMinor:300});
 for(const service of store.supplierServices)Object.assign(service,{categoryCode:'document_publication',turnaroundHours:1,standardTurnaroundHours:1});
 const profile=store.supplierProfiles[0];
 Object.assign(profile,{shopName:'Private printer name',contactName:'Private contact',shop:{lat:7.061234,lng:125.601234,label:'Private street'},version:1,
  homePrinter:{barangay:'Test barangay',street:'Private street',propertyType:'boarding_house',landmark:'Private landmark',startedAt:AT,pinChangedAt:AT,
   starterApprovedAt:AT,online:true,location:{lat:7.061234,lng:125.601234,at:AT},privacyAgreement:{accepted:true,wording:HOME_FILE_AGREEMENT,at:AT},pinConsent:{accepted:true,wording:HOME_PIN_CONSENT,at:AT}}});
 for(const type of ['business_permit','tin'])store.files.push({fileId:`level_${type}`,ownerId:profile.userId,purpose:'verification_document',state:'ready',objectKey:`private/${type}`,declaredContentType:'image/png',detectedContentType:'image/png',originalFilename:'evidence.png',size:100,createdAt:AT,verificationDocumentType:type,references:[{type:'user',id:profile.userId,field:'verificationDocumentFileIds',documentType:type}]});
 const user=store.users.find(u=>u.id==='supplier');Object.assign(user,{name:'Private person',supplierName:profile.shopName,shop:profile.shop});
 store.supplierProfiles[1].shop={lat:7.09,lng:125.62,label:'Public shop address'};
 store.files.push({fileId:'home_art',ownerId:'client',purpose:'artwork',state:'ready',objectKey:'home/art.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',originalFilename:'art.pdf',size:100,createdAt:AT,detected:{pageCount:2},artworkCheck:{status:'passed'},references:[]},
  {fileId:'home_payment',ownerId:'client',purpose:'payment_proof',state:'ready',objectKey:'home/payment.png',declaredContentType:'image/png',detectedContentType:'image/png',originalFilename:'payment.png',size:100,createdAt:AT,references:[]});
 await db.transaction(()=>saveStore(db,store));
 const api=await parityApiForTest(t,false,Date.parse(AT),{onOutput:chunk=>{if(/error|constraint|Error/.test(chunk))process.stderr.write(chunk);}});
 return {db,api,request:{supplierId:'supplier',location:{lat:7.06,lng:125.6},fulfillmentMode:'pickup',files:[{fileId:'home_art',copies:1,colour:'bw',paper:'a4',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]}]}};
}
function privateResponse(body,{street=false}={}) {
 const text=JSON.stringify(body);
 for(const secret of ['7.061234','125.601234','Private printer name','Private contact','Private person','Private landmark',...(street?[]:['Private street'])])assert.equal(text.includes(secret),false,`${secret} in ${text}`);
}
async function checkout(api,request) {
 const draft=ok(await api('client','POST','/express/drafts',request));privateResponse(draft);
 const placed=ok(await api('client','POST',`/me/carts/${draft.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.confirmation,payment:{method:'qr_manual',reference:'HOME',proofFileId:'home_payment'}}));
 privateResponse(placed);return placed.order.id;
}
test('HTTP home catalog, quotes, cart, unpaid/paid pickup and order lists keep the pin private; active rider scope is exact',{skip},async t=>{
 const {db,api,request}=await setup(t);
 privateResponse(ok(await api('client','POST','/express/shops',request)));
 privateResponse(ok(await api('client','GET','/catalog/shops/supplier')));
 const orderId=await checkout(api,request),path=`/orders/${orderId}`;
 privateResponse(ok(await api('client','GET',path)));
 ok(await api('ops','POST',`${path}/payments/initial/confirm`,{}));
 const paid=ok(await api('client','GET',path));privateResponse(paid,{street:true});assert.equal(paid.order.pickup.street,'Private street');
 privateResponse(ok(await api('client','GET','/orders')),{street:true});
 // Use a delivery order for the assigned rider. No unassigned rider may see the pin.
 const store=await loadStore(db),order=store.orders.find(o=>o.id===orderId);
 order.state='rider_assigned';order.riderId='rider';
 await db.transaction(()=>saveStore(db,store));
 const rider=ok(await api('rider','GET',path));assert.equal(rider.order.pickup.lat,7.061234);
 assert.equal(JSON.stringify(rider).includes('Private person'),false);
 store.orders.find(o=>o.id===orderId).state='completed';
 await db.transaction(()=>saveStore(db,store));
 privateResponse(ok(await api('rider','GET',path)));
});
test('group Express home pickup keeps host and member responses private before and after payment',{skip},async t=>{
 const {api,request}=await setup(t);
 const created=ok(await api('client','POST','/express/groups',{fulfillmentMode:'pickup',location:request.location,timeLimitMinutes:30}));
 privateResponse(created);
 privateResponse(ok(await api('other','POST',`/express/groups/invites/${created.inviteToken}/join`,{})));
 const path=`/express/groups/${created.group.id}`;
 privateResponse(ok(await api('client','PUT',`${path}/files`,{files:request.files})));
 privateResponse(ok(await api('client','POST',`${path}/close`,{})));
 const prepared=ok(await api('client','POST',`${path}/prepare`,{supplierId:'supplier'}));privateResponse(prepared);
 privateResponse(ok(await api('client','GET',`/me/carts/${prepared.cartId}`)));
 const placed=ok(await api('client','POST',`${path}/checkout`,{looksRight:true,expressConfirmation:prepared.confirmation,payment:{method:'qr_manual',reference:'HOME-GROUP',proofFileId:'home_payment'}}));
 privateResponse(placed);privateResponse(ok(await api('client','GET',`/orders/${placed.orderId}`)));
 for(const actor of ['client','other'])for(const endpoint of [path,`${path}/tracking`])privateResponse(ok(await api(actor,'GET',endpoint)));
 ok(await api('ops','POST',`/orders/${placed.orderId}/payments/initial/confirm`,{}));
 const paid=ok(await api('client','GET',`/orders/${placed.orderId}`));privateResponse(paid,{street:true});assert.equal(paid.order.pickup.street,'Private street');
 for(const actor of ['client','other'])for(const endpoint of [path,`${path}/tracking`])privateResponse(ok(await api(actor,'GET',endpoint)),{street:actor==='client'});
});
test('persisted home give-back reoffers unchanged money; home state survives legacy profile upserts',{skip},async t=>{
 const {db,api,request}=await setup(t);request.fulfillmentMode='delivery';request.dropoff={lat:7.065,lng:125.605,label:'Client destination'};
 const orderId=await checkout(api,request);ok(await api('ops','POST',`/orders/${orderId}/payments/initial/confirm`,{}));
 let store=await loadStore(db),order=store.orders.find(o=>o.id===orderId);
 order.state='supplier_assigned';order.fileCheck={status:'passed'};startExpressAcceptance(order,AT);
 await db.transaction(()=>saveStore(db,store));
 ok(await api('supplier','POST',`/orders/${orderId}/express/accept`,{},supplier));
 const before=await loadStore(db),money=before.orders.find(o=>o.id===orderId).totalMinor;
 ok(await api('supplier','POST',`/orders/${orderId}/express/give-back`,{reason:'Cannot finish'},supplier));
 store=await loadStore(db);order=store.orders.find(o=>o.id===orderId);
 assert.equal(order.supplierId,'replacement');assert.equal(order.totalMinor,money);assert.equal(order.state,'supplier_assigned');
 assert.equal(store.orderJobs.find(j=>j.orderId===orderId).state,'approved_for_production');
 assert.equal(store.supplierProfiles.find(p=>p.userId==='supplier').homePrinter.lateGiveBacks?.length||0,0);
 const homeBefore=(await db.query("SELECT home_printer FROM supplier_profiles WHERE user_id='supplier'")).rows[0].home_printer;
 // Exact historical insert column shape omits the additive column, as old saveStore does.
 await db.query(`INSERT INTO supplier_profiles (user_id,shop_name,contact_name,shop_lat,shop_lng,shop_label,pickup_available,is_closed,express_enabled,availability,schedule,version,updated_at)
 SELECT user_id,shop_name,contact_name,shop_lat,shop_lng,shop_label,pickup_available,is_closed,express_enabled,availability,schedule,version,updated_at FROM supplier_profiles WHERE user_id='supplier'
 ON CONFLICT(user_id) DO UPDATE SET shop_name=EXCLUDED.shop_name,updated_at=EXCLUDED.updated_at`);
 assert.deepEqual((await db.query("SELECT home_printer FROM supplier_profiles WHERE user_id='supplier'")).rows[0].home_printer,homeBefore);
 privateResponse(ok(await api('client','GET',`/orders/${orderId}`)));
});
test('Starter evidence review and existing approval decision enforce adult ID, permit/TIN, versioned online and legacy pin guards',{skip},async t=>{
 const {db,api}=await setup(t);
 let store=await loadStore(db),profile=store.supplierProfiles.find(p=>p.userId==='supplier');
 delete profile.homePrinter.starterApprovedAt;profile.homePrinter.online=false;
 store.files=store.files.filter(f=>!f.fileId.startsWith('level_'));
 store.approvalCases.find(c=>c.id==='case_supplier').status='pending';
 for(const type of ['valid_id','id_selfie','sample_work','barangay_clearance','tin'])store.files.push({fileId:`doc_${type}`,ownerId:'supplier',purpose:'verification_document',state:'ready',objectKey:`home/${type}`,declaredContentType:'image/png',detectedContentType:'image/png',originalFilename:'evidence.png',size:100,createdAt:AT,references:[]});
 await db.transaction(()=>saveStore(db,store));
 const path='/ops/home-printers/supplier/starter',files=['valid_id','id_selfie','sample_work'];
 assert.equal((await api('client','GET','/me/home-printer')).status,403);
 assert.equal((await api('supplier','POST',path,{},supplier)).status,403);
 for(const type of files)ok(await api('supplier','POST',`/files/doc_${type}/attach`,{documentType:type},supplier));
 const review={expectedVersion:1,dateOfBirth:'2010-01-01',reviewedFileIds:files.map(v=>`doc_${v}`)};
 assert.equal((await api('ops','POST',path,review)).body.error,'home_adult_id_required');
 ok(await api('ops','POST',path,{...review,dateOfBirth:'2000-01-01'}));
 let own=ok(await api('supplier','GET','/me/home-printer',null,supplier));assert.equal(own.homePrinter.level,'starter');
 assert.equal(own.pin.point.lat,7.061234);
 assert.equal((await api('supplier','PATCH','/me/home-printer',{expectedVersion:2,online:true,location:{lat:7.1,lng:125.6}},supplier)).body.error,'home_away_from_pin');
 ok(await api('supplier','PATCH','/me/home-printer',{expectedVersion:2,online:true,location:own.pin.point},supplier));
 assert.equal((await api('supplier','PATCH','/me/supplier-profile',{expectedVersion:3,shop:{lat:7.1,lng:125.6,label:'Moved'}},supplier)).body.error,'home_pin_route_required');
 assert.equal((await api('supplier','PATCH','/users/supplier/shop',{shop:{lat:7.1,lng:125.6,label:'Moved'}},supplier)).body.error,'home_pin_route_required');
 const approve=()=>api('admin','POST','/approval-cases/case_supplier/approve',{expectedVersion:1,requestId:id('decision')});
 assert.equal((await approve()).body.error,'supplier_profile_incomplete');
 for(const type of ['barangay_clearance','tin'])ok(await api('supplier','POST',`/files/doc_${type}/attach`,{documentType:type},supplier));
 ok(await approve());
 own=ok(await api('supplier','GET','/me/home-printer',null,supplier));assert.equal(own.homePrinter.level,'verified');assert.equal(own.homePrinter.weeklyJobCap,null);
 assert.equal((await api('client','GET','/files/doc_valid_id')).status,403);
 ok(await api('supplier','PATCH','/me/home-printer',{expectedVersion:3,allowHomePickup:true},supplier));
 store=await loadStore(db);assert.equal(store.supplierProfiles.find(p=>p.userId==='supplier').pickupAvailable,true);
});
test('two persisted offer timeouts switch a home printer offline; new matching excludes it',{skip},async t=>{
 const {db,api,request}=await setup(t);request.fulfillmentMode='delivery';request.dropoff={lat:7.065,lng:125.605,label:'Destination'};
 const ids=[await checkout(api,request),await checkout(api,request)];
 for(const orderId of ids)ok(await api('ops','POST',`/orders/${orderId}/payments/initial/confirm`,{}));
 const {expireShopAcceptances}=await import('../src/shop-recovery.js');
 await db.transaction(async()=>{
  const store=await loadStore(db);
  for(const order of store.orders){order.state='supplier_assigned';order.fileCheck={status:'passed'};startExpressAcceptance(order,AT);}
  assert.equal(expireShopAcceptances(store,{at:new Date(Date.parse(AT)+5*60000).toISOString(),createId:id}),true);
  await saveStore(db,store);
 });
 const store=await loadStore(db),h=store.supplierProfiles.find(p=>p.userId==='supplier').homePrinter;
 assert.equal(h.online,false);assert.equal(h.consecutiveMisses,2);
 const choices=ok(await api('client','POST','/express/shops',request));assert.equal(choices.shops.some(s=>s.supplierId==='supplier'),false);
});
test('concurrent acceptances serialize the thirtieth Starter job and keep the cap after reload',{skip},async t=>{
 const {db,api,request}=await setup(t);request.fulfillmentMode='delivery';request.dropoff={lat:7.065,lng:125.605,label:'Destination'};
 const ids=[await checkout(api,request),await checkout(api,request)];
 for(const orderId of ids)ok(await api('ops','POST',`/orders/${orderId}/payments/initial/confirm`,{}));
 await db.transaction(async()=>{
  const store=await loadStore(db),base=store.orders[0];
  store.approvalCases.find(c=>c.id==='case_supplier').status='pending';
  for(const order of store.orders){order.state='supplier_assigned';order.fileCheck={status:'passed'};startExpressAcceptance(order,AT);}
  for(let i=0;i<29;i++) {
   const historical=structuredClone(base);historical.id=`prior_${i}`;historical.state='completed';
   historical.expressOrder.events.push({state:'accepted',supplierId:'supplier',at:AT});store.orders.push(historical);
  }
  await saveStore(db,store);
 });
 const responses=await Promise.all(ids.map(orderId=>api('supplier','POST',`/orders/${orderId}/express/accept`,{},supplier)));
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal(responses.find(r=>r.status===409).body.error,'home_weekly_cap');
 const own=ok(await api('supplier','GET','/me/home-printer',null,supplier));assert.equal(own.homePrinter.weeklyJobs,30);assert.equal(own.homePrinter.reason,'home_weekly_cap');
});
test('rider offer and unrelated reads hide the home pin; real dispatch acceptance reveals only the active frozen pickup',{skip},async t=>{
 const {db,api,request}=await setup(t);request.fulfillmentMode='delivery';request.dropoff={lat:7.065,lng:125.605,label:'Destination'};
 const orderId=await checkout(api,request);ok(await api('ops','POST',`/orders/${orderId}/payments/initial/confirm`,{}));
 await db.transaction(async()=>{
  const store=await loadStore(db),order=store.orders.find(o=>o.id===orderId);order.state='ready_for_dispatch';
  for(const job of store.orderJobs)if(job.orderId===orderId)job.state='ready_for_dispatch';
  await saveStore(db,store);
 });
 const offers=ok(await api('rider','GET','/dispatch/offers'));privateResponse(offers);
 const offer=offers.offers.find(o=>o.id===orderId);assert.ok(offer,JSON.stringify(offers));
 const accepted=ok(await api('rider','POST',`/dispatch/${orderId}/accept`,{offerId:offer.dispatchOffer.id}));
 assert.equal(accepted.order.pickup.lat,7.061234);assert.equal(accepted.order.pickup.landmark,'Private landmark');
 privateResponse(ok(await api('client','GET',`/orders/${orderId}`)));
 assert.equal((await api('other','GET',`/orders/${orderId}`)).status,403);
});
test('home policy settings are Super Admin only, and legacy transition cannot bypass the cap or Starter acceptance',{skip},async t=>{
 const {db,api,request}=await setup(t),orderId=await checkout(api,request);
 ok(await api('ops','POST',`/orders/${orderId}/payments/initial/confirm`,{}));
 await db.transaction(async()=>{
  const store=await loadStore(db),order=store.orders.find(o=>o.id===orderId);order.state='supplier_assigned';order.fileCheck={status:'passed'};startExpressAcceptance(order,AT);await saveStore(db,store);
 });
 assert.equal((await api('supplier','POST',`/orders/${orderId}/transition`,{state:'payment_authorized'},supplier)).body.error,'home_express_accept_required');
 const frozenTotal=(await loadStore(db)).orders.find(o=>o.id===orderId).totalMinor;
 const settings=ok(await api('admin','GET','/settings'));
 const body={expectedVersion:settings.version,reason:'Reviewed home policy',homePrinter:{minimumAgeYears:18,starterWeeklyJobCap:12,verificationWindowDays:45}};
 assert.equal((await api('ops','PATCH','/settings',body)).status,403);
 ok(await api('admin','PATCH','/settings',body));
 const own=ok(await api('supplier','GET','/me/home-printer',null,supplier));assert.equal(own.homePrinter.deadlineAt,new Date(Date.parse(AT)+45*86400000).toISOString());
 const store=await loadStore(db);assert.equal(store.orders.find(o=>o.id===orderId).totalMinor,frozenTotal);
});
test('migration marks earlier guided home-kind profiles offline until new privacy consent and review',{skip},async t=>{
 const {db,api}=await setup(t);
 await db.query("UPDATE supplier_profiles SET home_printer=NULL WHERE user_id='supplier'");
 await db.query(`INSERT INTO supplier_signups(clerk_user_id,supplier_id,version,steps,updated_at)
  VALUES('clerk_supplier','supplier',4,$1,$2)`,[{eligibility:{shopKind:'home_printer',adult:true}},AT]);
 const migration=await import('../migrations/1795474800000_home_printers.js');let sql;
 await migration.up({addColumns:()=>{},sql:query=>{sql=query;}});await db.query(sql);
 const profile=(await loadStore(db)).supplierProfiles.find(p=>p.userId==='supplier');
 assert.equal(profile.supplierType,'home');assert.equal(profile.homePrinter.online,false);assert.equal(profile.homePrinter.pinConsent,undefined);
 assert.equal(Date.parse(profile.homePrinter.startedAt),Date.parse(AT));
 const own=ok(await api('supplier','GET','/me/home-printer',null,supplier));assert.equal(own.homePrinter.reason,'home_pin_consent_required');
 privateResponse(ok(await api('client','GET','/catalog/shops/supplier')));
});
