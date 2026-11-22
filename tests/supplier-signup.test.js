import test from 'node:test';
import assert from 'node:assert/strict';
import { routeSupplierSignup, routeSignupSetup } from '../src/supplier-signup.js';
import { enrollSupplier } from '../src/enrollment.js';
import { defaultTaxonomy } from '../src/taxonomy.js';
import { routeShopTeam, claimShopInvite, discoverShopInvites } from '../src/shop-team.js';
import { ensureShopOwners } from '../src/shop-team-store.js';

const AT = '2026-11-22T01:00:00.000Z';
const PHONE = '+639170000001';
function fixture() {
  const store = { users: [], userRoleMemberships: [], supplierProfiles: [], supplierServices: [], approvalCases: [], approvalCaseEvents: [],
    notifications: [], auditLog: [], taxonomy: defaultTaxonomy(), acceptedFileFormats: [{code:'pdf',active:true}], settings: {} };
  const claims = {sub:'clerk_signup'};
  const clerkUser = {id:claims.sub,firstName:'Contact',primaryEmailAddressId:'email',emailAddresses:[{id:'email',emailAddress:'contact@example.invalid'}],
    phoneNumbers:[{phoneNumber:PHONE,verification:{status:'verified'}}]};
  let n=0;
  const id=p=>`${p}_${++n}`;
  const call=(method,body)=>routeSupplierSignup({req:{method,headers:{}},url:new URL('http://test/auth/clerk/supplier-signup'),
    store,claims,clerkUser,readBody:async()=>body,now:()=>AT,id});
  return {store,claims,clerkUser,id,call};
}
async function draft(f,{manager=false}={}) {
  await f.call('PATCH',{expectedVersion:0,step:'eligibility',value:{shopKind:'print_shop',registrantRole:manager?'manager':'owner',adult:true}});
  await f.call('PATCH',{expectedVersion:1,step:'shop',value:{shopName:'Print shop',contactName:'Contact',phone:PHONE,...(manager?{ownerPhone:'+639170000002'}:{})}});
  const options=(await f.call('GET')).body;
  await f.call('PATCH',{expectedVersion:2,step:'location',value:{point:{lat:7.06,lng:125.6,label:'Pickup'},consent:{accepted:true,wording:options.locationConsentWording,at:'1900-01-01'}}});
  await f.call('PATCH',{expectedVersion:3,step:'prints',value:{groups:['documents'],documents:{papers:['short','a4','long','a3'],colours:['bw'],duplex:false,a3PricesMinor:{bw:1000},finishing:{binding:15000}}}});
}
test('signup resumes the first unfinished step and stores consent wording and server time',async()=>{
  const f=fixture(); await draft(f);
  const resumed=(await f.call('GET')).body;
  assert.equal(resumed.signup.nextStep,'enroll');
  assert.equal(resumed.signup.steps.location.consent.at,AT);
  assert.equal(resumed.signup.steps.location.consent.wording,resumed.locationConsentWording);
  assert.equal(resumed.signup.steps.shop.phone,PHONE);
  await assert.rejects(f.call('PATCH',{expectedVersion:0,step:'prints',value:{}}),e=>e.code==='supplier_signup_stale');
  const other=await routeSupplierSignup({req:{method:'GET'},url:new URL('http://test/auth/clerk/supplier-signup'),store:f.store,claims:{sub:'other'},now:()=>AT});
  assert.equal(other.body.signup.version,0); assert.deepEqual(other.body.signup.steps,{});
});
test('manager contact requires an owner mobile and the contact mobile must be Clerk verified',async()=>{
  const f=fixture();
  await f.call('PATCH',{expectedVersion:0,step:'eligibility',value:{shopKind:'home_printer',registrantRole:'manager',adult:true}});
  await assert.rejects(f.call('PATCH',{expectedVersion:1,step:'shop',value:{shopName:'Shop',contactName:'Contact',phone:PHONE}}),e=>e.code==='invalid_supplier_signup');
  f.clerkUser.phoneNumbers[0].verification.status='unverified';
  await assert.rejects(f.call('PATCH',{expectedVersion:1,step:'shop',value:{shopName:'Shop',contactName:'Contact',phone:PHONE,ownerPhone:'+639170000002'}}),e=>e.code==='shop_mobile_verification_required');
});
test('guided enrollment creates priced document services and keeps a manager out of ownership',async()=>{
  const f=fixture();await draft(f,{manager:true});
  const body={signupVersion:4};
  const result=enrollSupplier({store:f.store,clerkUserId:f.claims.sub,clerkUser:f.clerkUser,body,idempotencyKey:'signup',createId:f.id,now:()=>AT});
  assert.equal(result.status,201);assert.equal(result.approvalCase.status,'pending');
  assert.ok(result.supplierServices.length>0);
  assert.ok(result.supplierServices.every(s=>s.referenceRateMinor>0&&s.state==='pending_verification'));
  assert.ok(f.store.catalogItems.every(i=>i.basePriceMinor>0&&i.reviewStatus==='pending'));
  assert.equal(f.store.shopMemberships.find(m=>m.shopId===result.user.id&&m.userId===result.user.id).role,'staff');
  assert.equal(f.store.shopTeamMemberSettings[0].manager,true);
  assert.equal(f.store.supplierSignups[0].supplierId,result.user.id);
  assert.equal(f.store.supplierSignups[0].steps.shop.ownerPhone,'+639170000002');
  assert.equal((await f.call('GET')).body.signup.nextStep,'hours');
  assert.equal(enrollSupplier({store:f.store,clerkUserId:f.claims.sub,clerkUser:f.clerkUser,body,idempotencyKey:'signup',createId:f.id,now:()=>AT}).status,200);
});

test('owner invite is tied to saved mobile, claims directly as Owner and never promotes the manager',async()=>{
  const f=fixture();await draft(f,{manager:true});
  const result=enrollSupplier({store:f.store,clerkUserId:f.claims.sub,clerkUser:f.clerkUser,body:{signupVersion:4},idempotencyKey:'signup',createId:f.id,now:()=>AT});
  const issue=()=>routeShopTeam({req:{method:'POST',headers:{}},url:new URL('http://test/me/shop-team/invites'),store:f.store,user:result.user,
    readBody:async()=>({kind:'owner'}),id:f.id,now:()=>AT,audit:()=>{}});
  const invitation=await issue();assert.equal(invitation.body.invite.kind,'owner');assert.equal(invitation.body.invite.identity,'+639170000002');
  const claim=(clerkUser,body)=>claimShopInvite({store:f.store,claims:{sub:clerkUser.id},clerkUser,body,id:f.id,at:AT,audit:()=>{}});
  assert.throws(()=>claim(f.clerkUser,{token:invitation.body.token}),e=>e.code==='shop_invite_identity_mismatch');
  const owner={...f.clerkUser,id:'clerk_owner',emailAddresses:[{id:'email',emailAddress:'owner@example.invalid'}],phoneNumbers:[{phoneNumber:'+639170000002',verification:{status:'verified'}}]};
  assert.equal(discoverShopInvites(f.store,owner,AT)[0].kind,'owner');
  const claimed=claim(owner,{token:invitation.body.token});
  assert.equal(claimed.member.role,'owner');assert.equal(claimed.member.status,'active');
  assert.equal(f.store.shopTeamMemberSettings.find(s=>s.userId===result.user.id).manager,true);
  ensureShopOwners(f.store);
  assert.equal(f.store.shopMemberships.find(m=>m.userId===result.user.id).role,'staff');
  assert.throws(()=>claim(owner,{token:invitation.body.token}),e=>e.code==='shop_invite_used');
  assert.ok(!f.store.userRoleMemberships.some(m=>m.userId===claimed.member.userId&&m.role==='supplier'));
});

test('verified invited owner may reject ownership; the shop then stops taking new orders',async()=>{
  const f=fixture();await draft(f,{manager:true});
  const result=enrollSupplier({store:f.store,clerkUserId:f.claims.sub,clerkUser:f.clerkUser,body:{signupVersion:4},idempotencyKey:'signup',createId:f.id,now:()=>AT});
  const issued=await routeShopTeam({req:{method:'POST',headers:{}},url:new URL('http://test/me/shop-team/invites'),store:f.store,user:result.user,
    readBody:async()=>({kind:'owner'}),id:f.id,now:()=>AT,audit:()=>{}});
  const owner={...f.clerkUser,id:'clerk_owner',phoneNumbers:[{phoneNumber:'+639170000002',verification:{status:'verified'}}]};
  const rejection=claimShopInvite({store:f.store,claims:{sub:owner.id},clerkUser:owner,body:{token:issued.body.token,choice:'not_right'},id:f.id,at:AT,audit:()=>{}});
  assert.equal(rejection.paused,true);assert.equal(f.store.supplierProfiles[0].isClosed,true);
  assert.equal(f.store.shopInvites[0].revokedAt,AT);
  assert.equal(f.store.shopMemberships.some(m=>m.role==='owner'),false);
});

test('assisted product setup retains a private price-list photo and notifies privileged staff once',async()=>{
  const f=fixture();await draft(f);
  const result=enrollSupplier({store:f.store,clerkUserId:f.claims.sub,clerkUser:f.clerkUser,body:{signupVersion:4},idempotencyKey:'signup',createId:f.id,now:()=>AT});
  f.store.users.push({id:'admin',role:'super_admin'});f.store.userRoleMemberships.push({userId:'admin',role:'super_admin'});
  f.store.files=[{fileId:'prices',purpose:'supplier_price_list',ownerId:result.user.id,state:'ready',objectKey:'private/prices.png',references:[]}];
  const call=()=>routeSignupSetup({req:{method:'POST'},url:new URL('http://test/me/supplier-signup/setup-help'),store:f.store,user:result.user,
    readBody:async()=>({fileIds:['prices']}),now:()=>AT,id:f.id,audit:()=>{}});
  assert.equal((await call()).status,201);assert.equal((await call()).status,200);
  assert.equal(f.store.supplierSignups[0].steps.setupHelp.status,'requested');
  assert.equal(f.store.files[0].references[0].type,'supplier_signup');
  assert.equal(f.store.notifications.filter(n=>n.type==='supplier_setup_requested'&&n.userId==='admin').length,1);
});
