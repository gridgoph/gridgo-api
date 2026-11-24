import test from 'node:test';
import assert from 'node:assert/strict';
import * as home from '../src/home-printers.js';
import { fixture } from './fixtures/scheduling.js';
import { publicOrderFor } from '../src/operational-model.js';
const AT='2026-11-24T14:00:00.000Z';
const later=ms=>new Date(Date.parse(AT)+ms).toISOString();
function setup() {
 const {store,client}=fixture({express:true});
 const profile=store.supplierProfiles[0];
 profile.contactName='Private contact';profile.shopName='Private shop';
 profile.homePrinter={barangay:'Test barangay',street:'Private street',propertyType:'house',landmark:'Private landmark',
  pinConsent:{at:AT,accepted:true},privacyAgreement:{at:AT,accepted:true},startedAt:AT,starterApprovedAt:AT,online:true,
  location:{...profile.shop,at:AT},consecutiveMisses:0};
 profile.supplierType='home';profile.barangay=profile.homePrinter.barangay;
 store.approvalCases[0].status='pending';
 store.supplierPayoutAccounts=[{supplierId:profile.userId,qrFileId:'home_qr'}];
 for(const type of ['business_permit','tin'])store.files.push({fileId:`level_${type}`,ownerId:profile.userId,purpose:'verification_document',state:'ready',verificationDocumentType:type,references:[{type:'user',id:profile.userId}]});
 store.files.push({fileId:'home_qr',ownerId:profile.userId,purpose:'supplier_payout_qr',state:'ready'});
 return {store,client,profile};
}
test('Starter policy enforces weekly cap and exact deadline; Verified lifts both',()=>{
 const {store,profile}=setup();
 assert.equal(home.homePrinterStatus(store,profile,AT).newOrdersPaused,false);
 store.orders=Array.from({length:30},(_,i)=>({id:`o${i}`,expressOrder:{events:[{state:'accepted',supplierId:'shop_a',at:AT}]}}));
 assert.equal(home.homePrinterStatus(store,profile,AT).reason,'home_weekly_cap');
 store.orders=[];
 assert.equal(home.homePrinterStatus(store,profile,later(30*86400000)).reason,'home_verification_deadline');
 store.approvalCases[0].status='approved';
 assert.equal(home.homePrinterStatus(store,profile,later(30*86400000)).level,'verified');
 assert.equal(home.homePrinterStatus(store,profile,later(30*86400000)).newOrdersPaused,false);
});
test('online location pause uses 300m and two consecutive misses switch offline',()=>{
 const {store,profile}=setup();
 profile.homePrinter.location.lat+=0.003;
 assert.equal(home.homePrinterStatus(store,profile,AT).reason,'home_away_from_pin');
 profile.homePrinter.location.lat=profile.shop.lat;
 home.recordHomeOffer(store,'shop_a','timed_out',AT);
 assert.equal(profile.homePrinter.online,true);
 home.recordHomeOffer(store,'shop_a','accepted',AT);
 home.recordHomeOffer(store,'shop_a','timed_out',AT);
 assert.equal(profile.homePrinter.online,true);
 home.recordHomeOffer(store,'shop_a','timed_out',AT);
 assert.equal(profile.homePrinter.online,false);
});
test('give-back exactly five minutes is free; third late return holds 24h and fourth revokes Starter',()=>{
 const {store,profile}=setup();
 const order={shopAcceptance:{acceptedAt:AT}};
 home.recordHomeGiveBack(store,profile,order,later(5*60000));
 assert.equal(profile.homePrinter.lateGiveBacks?.length||0,0);
 for(let i=0;i<3;i++)home.recordHomeGiveBack(store,profile,order,later(5*60000+1+i));
 assert.equal(home.homePrinterStatus(store,profile,later(6*60000)).reason,'home_fair_play_hold');
 assert.equal(profile.homePrinter.offlineUntil,later(5*60000+3+86400000));
 home.recordHomeGiveBack(store,profile,order,later(6*60000));
 assert.ok(profile.homePrinter.starterRevokedAt);
});
test('home response removes nested pins and names; paid pickup reveals street alone and only active assigned rider sees pin',()=>{
 const {store,client,profile}=setup();
 const order={id:'private',supplierId:'shop_a',clientId:client.id,riderId:'rider',state:'rider_assigned',orderType:'express',fulfillmentMode:'pickup',
  pickup:{...profile.shop},payments:{initial:{status:'pending_confirmation'},final_online:{status:'not_required'}},timeline:[],
  acceptedQuote:{supplierShop:{...profile.shop},contactName:profile.contactName},supplierName:profile.shopName};
 store.orders=[order];home.snapshotHomePrinter(store,order);
 const serialized=JSON.stringify(home.homePrinterResponse(store,{order,jobs:[{orderId:order.id,pickup:profile.shop}]},client));
 for(const secret of [String(profile.shop.lat),String(profile.shop.lng),profile.shop.label,profile.contactName,profile.shopName,'Private street','Private landmark'])assert.equal(serialized.includes(secret),false,secret);
 order.payments.initial.status='confirmed';
 const paid=home.homePrinterResponse(store,{order},client).order;
 assert.equal(paid.pickup.street,'Private street');assert.equal(paid.pickup.lat,undefined);assert.equal(paid.homePrinter,undefined);
 const rider={id:'rider',role:'rider'};
 assert.equal(home.homePrinterResponse(store,{order},rider).order.pickup.lat,profile.shop.lat);
 order.state='completed';assert.equal(home.homePrinterResponse(store,{order},rider).order.pickup.lat,undefined);
 order.state='rider_assigned';assert.equal(home.homePrinterResponse(store,{order},{id:'other',role:'rider'}).order.pickup.lat,undefined);
 assert.equal(publicOrderFor(order,client,store).pickup.lat,undefined);
 profile.shop={lat:8,lng:126,label:'Moved'};profile.homePrinter.barangay='Moved barangay';
 assert.equal(home.homePrinterResponse(store,{order},client).order.pickup.street,'Private street');
 assert.equal(home.homePrinterResponse(store,{order},client).order.barangay,'Test barangay');
});
test('Starter review binds adult evidence; Verified requires permit and TIN; pin edits cannot evade monthly limit',async()=>{
 const {store,profile}=setup();delete profile.homePrinter.starterApprovedAt;
 store.files=['valid_id','id_selfie','sample_work','business_permit','tin'].map(type=>({fileId:type,ownerId:'shop_a',purpose:'verification_document',state:'ready',objectKey:type,verificationDocumentType:type,references:[{type:'user',id:'shop_a',documentType:type}]}));
 const route=await import('../src/home-printer-routes.js');
 const call=(path,body,user={id:'admin',role:'super_admin'},at=AT)=>route.routeHomePrinters({req:{method:'POST'},url:new URL(`http://test${path}`),store,user,readBody:async()=>body,now:()=>at,id:p=>p,audit:()=>{}});
 await assert.rejects(call('/ops/home-printers/shop_a/starter',{expectedVersion:1,dateOfBirth:'2010-01-01',reviewedFileIds:['valid_id','id_selfie','sample_work']}),e=>e.code==='home_adult_id_required');
 await call('/ops/home-printers/shop_a/starter',{expectedVersion:1,dateOfBirth:'2000-01-01',reviewedFileIds:['valid_id','id_selfie','sample_work']});
 assert.ok(profile.homePrinter.starterApprovedAt);
 assert.deepEqual(home.homeVerificationMissing(store,profile),[]);
 store.files.pop();assert.deepEqual(home.homeVerificationMissing(store,profile),['tin']);
 profile.homePrinter.pinChangedAt=AT;
 const patch=body=>route.routeHomePrinters({req:{method:'PATCH'},url:new URL('http://test/me/home-printer'),store,user:{id:'shop_a',role:'supplier'},readBody:async()=>body,now:()=>later(DAY),audit:()=>{}});
 const DAY=86400000;
 await assert.rejects(patch({expectedVersion:2,pin:{point:{lat:7.1,lng:125.6},barangay:'New barangay',street:'New street',propertyType:'boarding_house',consent:{accepted:true,wording:home.HOME_PIN_CONSENT}}}),e=>e.code==='home_pin_change_limited');
});
test('home printers join nearest Express matching at night, remain documents-only and pickup is Verified opt-in',async()=>{
 const {store,client,profile}=setup();
 const {expressShopList}=await import('../src/express-orders.js');
 const {caller}=await import('./fixtures/scheduling.js');
 for(const item of store.catalogItems){item.express=true;item.pricingUnit='per_page';item.subcategoryCode='document_printing';}
 for(const service of store.supplierServices){service.categoryCode='document_publication';service.turnaroundHours=0.1;service.standardTurnaroundHours=0.1;}
 const options={location:{lat:7.064,lng:125.6085},fulfillmentMode:'delivery'};
 // Delivery still uses the platform's rider hours; home production has no fixed shop hours.
 const day='2026-11-24T01:00:00.000Z';profile.homePrinter.startedAt=day;
 assert.equal(expressShopList(store,client,options,day)[0]?.supplierId,'shop_a');
 assert.equal(expressShopList(store,client,{...options,fulfillmentMode:'pickup'},AT).some(r=>r.supplierId==='shop_a'),false);
 store.approvalCases[0].status='approved';profile.pickupAvailable=true;
 assert.equal(expressShopList(store,client,{...options,fulfillmentMode:'pickup'},AT)[0]?.supplierId,'shop_a');
 const call=caller(store,client,AT);
 await assert.rejects(call('POST','/express/drafts',{supplierId:'shop_a',location:options.location,fulfillmentMode:'pickup',files:[{fileId:'file_art',copies:1,colour:'bw',paper:'a3',sides:'one',layout:'fit_to_paper'}]}),e=>e.code==='home_documents_only');
 profile.homePrinter.online=false;
 assert.equal(expressShopList(store,client,options,day).some(r=>r.supplierId==='shop_a'),false);
});
test('home accepted give-back reoffers unchanged money and resets the replacement acceptance window',async()=>{
 const {store,profile}=setup();
 const {routeExpressOrders}=await import('../src/express-routes.js');
 const day='2026-11-24T01:00:00.000Z';profile.homePrinter.startedAt=day;
 for(const item of store.catalogItems){item.express=true;item.pricingUnit='per_page';item.subcategoryCode='document_printing';}
 for(const service of store.supplierServices)service.categoryCode='document_publication';
 const order={id:'giveback',clientId:'user_client',supplierId:'shop_a',orderType:'express',state:'payment_authorized',fulfillmentMode:'delivery',
  shopAcceptance:{status:'accepted',acceptedAt:day},pickup:profile.shop,dropoff:profile.shop,totalMinor:990,supplierSubtotalMinor:900,
  payments:{initial:{status:'confirmed'}},payoutMilestones:[],timeline:[],fileCheck:{status:'passed'},expressOrder:{version:1,location:profile.shop,originalSupplierId:'shop_a',declines:0,events:[]}};
 store.orders.push(order);
 const result=await routeExpressOrders({req:{method:'POST'},url:new URL('http://test/orders/giveback/express/give-back'),store,user:{id:'shop_a',role:'supplier'},readBody:async()=>({reason:'Unavailable'}),now:()=>day,id:p=>p});
 assert.equal(result.status,200);assert.equal(order.supplierId,'shop_b');assert.equal(order.totalMinor,990);
 assert.equal(order.shopAcceptance.status,'pending');assert.equal(order.state,'supplier_assigned');assert.equal(order.homePrinter,undefined);
 assert.equal(profile.homePrinter.lateGiveBacks?.length||0,0);
});
test('home signup persists private type and rejects A3 or other product groups',async()=>{
 const {routeSupplierSignup,completeSignupEnrollment}=await import('../src/supplier-signup.js');
 const {store,profile}=setup();store.supplierSignups=[];let version=0;
 const call=(step,value)=>routeSupplierSignup({req:{method:'PATCH'},url:new URL('http://test/auth/clerk/supplier-signup'),store,claims:{sub:'new_home'},readBody:async()=>({expectedVersion:version,step,value}),now:()=>AT});
 await call('eligibility',{shopKind:'home_printer',registrantRole:'owner',adult:true});version++;
 await assert.rejects(call('prints',{groups:['marketing']}),e=>e.code==='home_documents_only');
 await assert.rejects(call('prints',{groups:['documents'],documents:{papers:['a3'],colours:['bw'],duplex:false,a3PricesMinor:{bw:100}}}),e=>e.code==='home_documents_only');
 const row=store.supplierSignups[0];row.steps.location={...home.homePin({point:profile.shop,barangay:'Barangay',street:'Street',propertyType:'house',consent:{accepted:true,wording:home.HOME_PIN_CONSENT}},AT)};
 completeSignupEnrollment(store,row,profile.userId,AT);
 assert.equal(profile.supplierType,'home');assert.equal(profile.homePrinter.online,false);assert.equal(profile.pickupAvailable,false);
});
test('a rejected home membership cannot match even with reviewed Starter evidence',async()=>{
 const {store,profile}=setup();store.approvalCases[0].status='rejected';
 const {supplierMatchBlockersFor}=await import('../src/supplier-eligibility.js');
 assert.ok(supplierMatchBlockersFor(store,AT)('shop_a',profile).includes('supplier_not_approved'));
});
test('paid pickup street projection is idempotent; public product names remain intact',()=>{
 const {store,profile,client}=setup();
 const order={id:'twice',supplierId:'shop_a',clientId:client.id,state:'production',fulfillmentMode:'pickup',pickup:profile.shop,
  payments:{initial:{status:'confirmed'},final_online:{status:'not_required'}},productionItems:[{name:'A4 documents'}]};
 store.orders=[order];home.snapshotHomePrinter(store,order);
 const projected=home.homePrinterResponse(store,{order},client);
 assert.deepEqual(home.homePrinterResponse(store,projected,client),projected);
 assert.equal(projected.order.productionItems[0].name,'A4 documents');
});
test('legacy home orders keep old pickup coordinates private after the profile moves',()=>{
 const {store,profile,client}=setup();
 const old={lat:7.077777,lng:125.677777,label:'Old private street'};
 const order={id:'legacy_home',supplierId:'shop_a',clientId:client.id,state:'production',fulfillmentMode:'pickup',pickup:old,
  acceptedQuote:{supplierShop:old},payments:{initial:{status:'confirmed'},final_online:{status:'not_required'}}};
 store.orders=[order];
 const result=JSON.stringify(home.homePrinterResponse(store,{order},client));
 assert.equal(result.includes('7.077777'),false);assert.equal(result.includes('125.677777'),false);assert.equal(result.includes('Old private street'),false);
});
test('home names and address interpolated in legacy text are redacted without corrupting role or IDs',()=>{
 const {store,profile,client}=setup();
 profile.contactName='Private named contact';
 const body={supplierId:profile.userId,supplier:{id:profile.userId,role:'supplier',name:profile.contactName},note:`Ask ${profile.contactName} at ${profile.shop.label}`};
 const result=home.homePrinterResponse(store,body,client);
 assert.equal(JSON.stringify(result).includes(profile.contactName),false);assert.equal(JSON.stringify(result).includes(profile.shop.label),false);
 assert.equal(result.supplier.id,profile.userId);assert.equal(result.supplier.role,'supplier');
});
test('home shop imagery stays private even when a client retains old media or file IDs',async()=>{
 const {store,profile,client}=setup();store.approvalCases[0].status='approved';
 for(const item of store.catalogItems)Object.assign(item,{subcategoryCode:'document_printing',pricingUnit:'per_page',express:true});
 const file={fileId:'private_house',ownerId:profile.userId,purpose:'supplier_shop_image',state:'ready',objectKey:'private/house',references:[{type:'supplier_shop_media',id:profile.userId,field:'cover'}]};
 store.files.push(file);store.supplierShopMedia=[{supplierId:profile.userId,fileId:file.fileId,slot:'cover'}];
 const {publicCatalogMediaFile}=await import('../src/supplier-catalog.js');
 const {authorizeFileRead}=await import('../src/attachments.js');
 assert.equal(publicCatalogMediaFile(store,file.fileId),null);
 assert.throws(()=>authorizeFileRead(client,store,file),e=>e.status===403);
 assert.doesNotThrow(()=>authorizeFileRead({id:profile.userId,role:'supplier'},store,file));
});
test('untrusted home names cannot corrupt signed URLs or unrelated client text',()=>{
 const {store,profile,client}=setup();profile.shopName='https';profile.contactName='client';
 const url='https://storage.example.invalid/private/file?signature=opaque';
 const body={supplierId:profile.userId,photos:[{downloadUrl:url}],artworkLink:'https://design.example.invalid/view',reference:'https',layout:'client',
  unrelated:{id:client.id,role:'client',name:'client'}};
 const result=home.homePrinterResponse(store,body,client);
 assert.equal(result.photos[0].downloadUrl,url);
 assert.equal(result.artworkLink,body.artworkLink);
 assert.equal(result.reference,'https');assert.equal(result.layout,'client');
 const unrelated=home.homePrinterResponse(store,{title:'client document',user:{id:client.id,role:'client',name:'client'}},client);
 assert.equal(unrelated.title,'client document');assert.equal(unrelated.user.name,'client');
});
