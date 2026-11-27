import test from 'node:test';
import assert from 'node:assert/strict';
import { documentCapabilities, createSignupDocuments } from '../src/document-capabilities.js';
import { routeSupplierSignup, routeSignupSetup } from '../src/supplier-signup.js';
import { enrollSupplier } from '../src/enrollment.js';
import { defaultTaxonomy } from '../src/taxonomy.js';
import { defaultShopSchedule } from '../src/availability.js';
import { catalogItemBlockers } from '../src/supplier-catalog.js';
import { supplierReadinessDetails } from '../src/supplier-readiness.js';
import { prepareVerificationPayout } from '../src/supplier-verification.js';

const AT='2026-11-28T01:00:00.000Z';
const prices={a4:{bw:200,light:500,full:900},long:{bw:400,light:700,full:1200},a3:{bw:1000,light:1500,full:2000}};
const documents=()=>({papers:['a4','long','a3'],colours:['bw','colour'],duplex:true,pricesMinor:structuredClone(prices),a3PricesMinor:{bw:1000,colour:2000},finishing:{binding:20000}});
function setup(enabled=true) {
 let n=0;const id=p=>`${p}_${++n}`;
 const store={users:[{id:'person',clerkUserId:'subject',role:'client',accountStatus:'active',email:'person@example.invalid',name:'Contact'}],
  userRoleMemberships:[{userId:'person',role:'client',createdAt:AT}],supplierProfiles:[],supplierServices:[],approvalCases:[],approvalCaseEvents:[],
  notifications:[],auditLog:[],files:[],taxonomy:defaultTaxonomy(),acceptedFileFormats:[{code:'pdf',active:true}],
  settings:{supplierOnboarding:{autoApproveDocuments:enabled,unverifiedShopsEnabled:enabled}}};
 const clerkUser={id:'subject',phoneNumbers:[{phoneNumber:'+639170000001',verification:{status:'verified'}}]};
 const call=body=>routeSupplierSignup({req:{method:body?'PATCH':'GET'},url:new URL('http://test/auth/clerk/supplier-signup'),store,claims:{sub:'subject'},clerkUser,readBody:async()=>body,now:()=>AT});
 const finish=(body={expectedVersion:store.supplierSignups[0].version})=>routeSignupSetup({req:{method:'POST'},url:new URL('http://test/me/supplier-signup/finish'),store,user:{...store.users[0],role:'supplier',shopRole:'owner'},readBody:async()=>body,now:()=>AT,id,audit:(s,e)=>s.auditLog.push(e)});
 return {store,id,clerkUser,call,finish};
}
async function enroll(f) {
 await f.call({step:'eligibility',expectedVersion:0,value:{shopKind:'print_shop',registrantRole:'owner',adult:true}});
 await f.call({step:'shop',expectedVersion:1,value:{shopName:'Copper Print Studio',contactName:'Contact',phone:'+639170000001'}});
 const wording=(await f.call()).body.locationConsentWording;
 await f.call({step:'location',expectedVersion:2,value:{point:{lat:7.06,lng:125.6,label:'Shop pickup'},consent:{accepted:true,wording}}});
 await f.call({step:'prints',expectedVersion:3,value:{groups:['documents'],documents:documents()}});
 return enrollSupplier({store:f.store,clerkUserId:'subject',clerkUser:f.clerkUser,body:{signupVersion:4},idempotencyKey:'one',createId:f.id,now:()=>AT});
}
function ready(f) {
 f.store.supplierProfiles[0].schedule=defaultShopSchedule();
 f.store.files.push({fileId:'receiving',ownerId:'person',purpose:'supplier_payout_qr',state:'ready',objectKey:'private/qr'});
 f.store.supplierPayoutAccounts=[{supplierId:'person',qrFileId:'receiving'}];
 f.store.supplierPayoutPolicies=[{supplierId:'person',holder:'business',consent:{accepted:true,wording:'saved',at:AT}}];
}
test('signup preserves whole-peso shop tier prices and refuses incomplete, fractional or unsafe prices',()=>{
 assert.deepEqual(documentCapabilities(documents()).pricesMinor,prices);
 for(const bad of [201,0,Number.MAX_SAFE_INTEGER+1]) {
  const input=documents();input.pricesMinor.a4.light=bad;
  assert.throws(()=>documentCapabilities(input),e=>e.code==='invalid_supplier_signup');
 }
 const missing=documents();delete missing.pricesMinor.long.full;
 assert.throws(()=>documentCapabilities(missing),e=>e.code==='invalid_supplier_signup');
 const store={settings:{},supplierServices:[]};let n=0;
 createSignupDocuments(store,'shop',documentCapabilities(documents()),{id:p=>`${p}_${++n}`,at:AT});
 assert.deepEqual(store.catalogItems.find(i=>i.name==='A4 Colour documents').expressPricing.a4,prices.a4);
 assert.equal(store.catalogItems.find(i=>i.name==='LONG B&W documents').basePriceMinor,400);
});
test('finish requires hours and ready payout QR then publishes standard documents only on the same client identity',async()=>{
 const f=setup();const result=await enroll(f);
 assert.equal(result.user.id,'person');assert.equal(result.supplierProfile.shopName,'Copper Print Studio');
 assert.equal(result.supplierProfile.pickupAvailable,true);
 assert.deepEqual(f.store.userRoleMemberships.map(m=>m.role),['client','supplier']);
 assert.equal(result.approvalCase.status,'pending');
 await assert.rejects(f.finish(),e=>e.code==='supplier_signup_incomplete');
 ready(f);const response=await f.finish();assert.equal(response.status,200);
 const standard=f.store.catalogItems.filter(i=>i.signupDocumentStandard);
 assert.equal(standard.length,4);assert.ok(standard.every(i=>i.reviewStatus==='approved'&&i.express));
 assert.equal(f.store.supplierServices[0].state,'live');
 assert.ok(f.store.catalogItems.filter(i=>!i.signupDocumentStandard).every(i=>i.reviewStatus==='pending'));
 assert.ok(standard.every(i=>!catalogItemBlockers(f.store,i,{publicOnly:true,at:AT}).length));
 assert.equal((await f.call()).body.signup.nextStep,'complete');
 assert.equal((await f.finish()).status,200);
 assert.equal(f.store.auditLog.filter(e=>e.action==='supplier_signup.finished').length,1);
 assert.throws(()=>enrollSupplier({store:f.store,clerkUserId:'subject',body:{signupVersion:4},idempotencyKey:'two',createId:f.id,now:()=>AT}),e=>['supplier_signup_stale','application_already_exists'].includes(e.code));
});
test('production-off switches keep Operations review and hold newly enrolled unverified payouts',async()=>{
 const f=setup(false);await enroll(f);ready(f);await f.finish();
 assert.ok(f.store.catalogItems.every(i=>i.reviewStatus==='pending'));
 assert.equal(f.store.supplierServices[0].state,'pending_verification');
 const payout=prepareVerificationPayout(f.store,{id:'order',supplierId:'person',orderType:'express',state:'completed'},
  {key:'stage:order:delivered',amountMinor:100,at:AT,actor:{id:'ops'},id:f.id});
 assert.equal(payout.status,'held');assert.equal(payout.reason,'supplier_verification_required');
});
test('legacy shop readiness exposes one actionable missing item and treats the placeholder as missing name',()=>{
 const f=setup();f.store.supplierProfiles=[{userId:'person',shopName:'Temporary',contactName:'Contact',shop:{lat:7,lng:125,label:'Pickup'}}];
 f.store.userRoleMemberships.push({userId:'person',role:'supplier',createdAt:AT});
 f.store.approvalCases=[{id:'case',userId:'person',kind:'supplier',status:'pending',createdAt:AT}];
 const readiness=supplierReadinessDetails(f.store,'person',null,AT);
 assert.equal(readiness.onboarding.nextMissing.code,'shop_name');assert.ok(readiness.onboarding.remainingCount>1);
});

test('home signup saves a consented meeting point and becomes selectable without a Starter approval',async()=>{
 const {HOME_PIN_CONSENT,HOME_PICKUP_POINT_CONSENT,HOME_FILE_AGREEMENT,homePrinterStatus}=await import('../src/home-printers.js');
 const {supplierMatchBlockersFor}=await import('../src/supplier-eligibility.js');
 const f=setup();
 await f.call({step:'eligibility',expectedVersion:0,value:{shopKind:'home_printer',registrantRole:'owner',adult:true}});
 await f.call({step:'shop',expectedVersion:1,value:{shopName:'Oak Home Prints',contactName:'Contact',phone:'+639170000001'}});
 await f.call({step:'location',expectedVersion:2,value:{point:{lat:7.06,lng:125.6,label:'Private home'},barangay:'District North',street:'Private street',propertyType:'house',consent:{accepted:true,wording:HOME_PIN_CONSENT}}});
 await f.call({step:'pickup',expectedVersion:3,value:{mode:'guardhouse',point:{lat:7.0602,lng:125.6002},description:'Entrance waiting area',
  consent:{accepted:true,wording:HOME_PICKUP_POINT_CONSENT},privacyAgreement:{accepted:true,wording:HOME_FILE_AGREEMENT}}});
 const docs=documents();docs.papers=['a4','long'];delete docs.pricesMinor.a3;docs.finishing={};
 await f.call({step:'prints',expectedVersion:4,value:{groups:['documents'],documents:docs}});
 enrollSupplier({store:f.store,clerkUserId:'subject',clerkUser:f.clerkUser,body:{signupVersion:5},idempotencyKey:'one',createId:f.id,now:()=>AT});
 ready(f);await f.finish();
 const profile=f.store.supplierProfiles[0];
 assert.equal(profile.homePrinter.pickupPoint.kind,'guardhouse');assert.equal(profile.homePrinter.pickupPoint.consent.at,AT);
 assert.equal(homePrinterStatus(f.store,profile,AT).newOrdersPaused,false);
 assert.equal(homePrinterStatus(f.store,profile,AT).allowHomePickup,true);
 assert.deepEqual(supplierMatchBlockersFor(f.store,AT)('person',profile),[]);
 assert.equal(homePrinterStatus(f.store,profile,'2026-12-28T01:00:00.000Z').newOrdersPaused,true);
});
test('onboarding hint returns only configured ranges near the saved pin and never sets shop prices',async()=>{
 const f=setup();f.store.settings.areaPriceGuides=[{name:'Central district',lat:7.06,lng:125.6,radiusMeters:1000,ranges:[{paper:'a4',tier:'bw',minMinor:100,maxMinor:400}]}];
 await enroll(f);
 assert.deepEqual((await f.call()).body.areaPriceGuides,[{name:'Central district',ranges:[{paper:'a4',tier:'bw',minMinor:100,maxMinor:400}]}]);
 assert.equal(f.store.catalogItems[0].basePriceMinor,200);
 f.store.supplierSignups[0].steps.location.point.lat=8;
 assert.deepEqual((await f.call()).body.areaPriceGuides,[]);
});
test('finish cannot override a suspended listing or pending private revision',async()=>{
 for(const change of [i=>i.suspendedAt=AT,i=>i.version=2,i=>i.reviewStatus='rejected']) {
  const f=setup();await enroll(f);ready(f);change(f.store.catalogItems[0]);
  await assert.rejects(f.finish(),e=>e.code==='supplier_signup_review_required');
  assert.ok(f.store.catalogItems.every(i=>i.reviewStatus!=='approved'));
 }
});
test('production-off controls and area guide ranges validate through ordinary settings validation',async()=>{
 const {validateOperationalSettings,defaultOperationalSettings}=await import('../src/operational-model.js');
 for(const supplierOnboarding of [{autoApproveDocuments:'yes'},{unverifiedShopsEnabled:1},{other:true},null]) {
  assert.throws(()=>validateOperationalSettings({...defaultOperationalSettings(),supplierOnboarding}),e=>e.code==='invalid_supplier_onboarding_settings');
 }
 assert.throws(()=>validateOperationalSettings({...defaultOperationalSettings(),areaPriceGuides:[{name:'Area',lat:0,lng:0,radiusMeters:1,ranges:[{paper:'a4',tier:'bw',minMinor:101,maxMinor:400}]}]}),e=>e.code==='invalid_area_price_guides');
});

test('the verification allowance is shared by all online payout keys and cash bonus reservations',async()=>{
 const {completeVerificationPayout,verificationSummary,assertOnboardingCashShop}=await import('../src/supplier-verification.js');
 for(const key of ['stage:last:delivered','settlement:last','change:last:extra','bonus:last:person']) {
  const f=setup();await enroll(f);ready(f);await f.finish();
  const order={id:'paid',supplierId:'person',orderType:'express',state:'completed'};
  const ctx={at:AT,actor:{id:'ops',role:'ops_admin'},id:f.id};
  const p=prepareVerificationPayout(f.store,order,{...ctx,key:'stage:paid:delivered',amountMinor:400000});
  completeVerificationPayout(f.store,order,p,ctx);
  const cash={id:'cash',supplierId:'person',orderType:'express',state:'completed',cash:{}};
  assert.equal(prepareVerificationPayout(f.store,cash,{...ctx,key:'bonus:cash:person',amountMinor:100000}).status,'ready');
  assert.equal(verificationSummary(f.store,'person',AT).remainingCapMinor,0);
  assert.equal(prepareVerificationPayout(f.store,{...order,id:'last'},{...ctx,key,amountMinor:1}).reason,'verification_payout_cap');
  assert.throws(()=>assertOnboardingCashShop(f.store,'person'),e=>e.code==='cash_supplier_verification_required');
  f.store.approvalCases[0].status='approved';
  assert.equal(prepareVerificationPayout(f.store,{...order,id:'last'},{...ctx,key,amountMinor:1}).status,'ready');
 }
});
test('signup service reference rate uses the shop price instead of the platform legacy rate',()=>{
 const f=setup();createSignupDocuments(f.store,'person',documentCapabilities(documents()),{id:f.id,at:AT});
 assert.equal(f.store.supplierServices[0].referenceRateMinor,200);
});

test('finishing a home printer honors its saved hours on the printer map',async()=>{
 const {expressAvailability}=await import('../src/shop-availability.js');
 const profile={pickupAvailable:true,schedule:{utcOffsetMinutes:480,week:[{weekday:1,opensMinute:480,closesMinute:1020}],closures:[]},homePrinter:{online:true,onboardingLiveAt:AT}};
 assert.equal(expressAvailability(profile,{},AT,'pickup'),null);
});

test('a new unverified shop cannot use the cash exemption at the shared preparation boundary',async()=>{
 const f=setup();await enroll(f);ready(f);await f.finish();
 assert.throws(()=>prepareVerificationPayout(f.store,{id:'cash',supplierId:'person',cash:{},orderType:'express',state:'completed'},
  {key:'stage:cash:delivered',amountMinor:100,at:AT,id:f.id,actor:{id:'ops'}}),e=>e.code==='cash_supplier_verification_required');
});

test('an already matchable shop has no onboarding prompt for its optional pending A3 and finishing listings',async()=>{
 const f=setup();await enroll(f);ready(f);await f.finish();
 const readiness=supplierReadinessDetails(f.store,'person',null,AT);
 assert.equal(readiness.operational.ready,true);assert.equal(readiness.onboarding.nextMissing,null);
});

test('verification status exposes the production-off new-order hold for completed tier-price shops',async()=>{
 const {verificationSummary}=await import('../src/supplier-verification.js');
 const f=setup(false);await enroll(f);ready(f);await f.finish();
 assert.equal(verificationSummary(f.store,'person',AT).newOrdersPaused,true);
});
