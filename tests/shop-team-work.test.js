import test from 'node:test';
import assert from 'node:assert/strict';
import { routeShopTeam, supplierShopActor } from '../src/shop-team.js';
import { resolveShopWorker, managerRouteAllowed } from '../src/shop-team-work.js';
import { teamStats } from '../src/shop-team-stats.js';
import { fixture, AT, id, audit } from './fixtures/reschedule.js';
const request = (store, path, body, { method='POST', sid='device-one', userId='supplier', token }={}) => routeShopTeam({
  req:{method,headers:{'x-gridgo-role':'supplier','x-gridgo-shop-id':'supplier',...(token?{'x-gridgo-worker-token':token}:{})},gridgoVerifiedClaims:{claims:{sid}}},
  url:new URL(`http://local/me/shop-team${path}`),store,user:store.users.find(u=>u.id===userId),readBody:async()=>body,id,now:()=>AT,audit,
});
test('PIN people are shop records; contexts bind shop, person, session, reset and removal', async () => {
  const store=fixture(), count=store.users.length;
  const created=await request(store,'/pin-staff',{name:'Worker',pin:'1234'});
  assert.equal(created.status,201);assert.equal(store.users.length,count);
  const person=created.body.member;
  assert.equal(person.kind,'pin');assert.equal(JSON.stringify(created).includes('1234'),false);
  assert.notEqual(store.shopPinStaff[0].pinHash,'1234');
  const selected=await request(store,'/working/select',{pinStaffId:person.id,pin:'1234'});
  const req={headers:{'x-gridgo-worker-token':selected.body.token},gridgoVerifiedClaims:{claims:{sid:'device-one'}}};
  const member={shopId:'supplier',userId:'supplier',role:'owner',status:'active'};
  const owner=store.users.find(u=>u.id==='supplier');
  const worker=resolveShopWorker(store,req,owner,member,AT);
  assert.equal(worker.pinStaffId,person.id);assert.equal(worker.role,'staff');
  assert.throws(()=>resolveShopWorker(store,{...req,headers:{}},owner,member,AT),{code:'shop_worker_locked'});
  assert.throws(()=>resolveShopWorker(store,{...req,gridgoVerifiedClaims:{claims:{sid:'other'}}},owner,member,AT),{code:'shop_worker_invalid'});
  assert.throws(()=>resolveShopWorker(store,req,owner,{...member,shopId:'replacement'},AT),{code:'shop_worker_invalid'});
  store.shopWorkerSessions.push({...store.shopWorkerSessions[0],shopId:'replacement',expiresAt:null,pinStaffId:null,tokenHash:null});
  assert.throws(()=>resolveShopWorker(store,{...req,headers:{}},owner,{...member,shopId:'replacement'},AT),{code:'shop_worker_invalid'});
  assert.throws(()=>resolveShopWorker(store,req,owner,member,'2099-01-01T00:00:00Z'),{code:'shop_worker_locked'});
  // Management requires a separate owner's device after the shared device is locked.
  await request(store,`/pin-staff/${person.id}/reset`,{pin:'5678'},{sid:'owner-management'});
  assert.throws(()=>resolveShopWorker(store,req,owner,member,AT),{code:'shop_worker_locked'});
  await request(store,'/working/select',{pinStaffId:person.id,pin:'5678'});
  await request(store,`/pin-staff/${person.id}`,null,{method:'DELETE',sid:'owner-management'});
  assert.equal((await request(store,'/working/select',{pinStaffId:person.id,pin:'5678'})).body.error,'shop_pin_invalid');
});
test('failed PIN attempts persist as mutated responses, throttle across devices and never grant access', async () => {
  const store=fixture();const p=(await request(store,'/pin-staff',{name:'Worker',pin:'1234'})).body.member;
  for(let n=0;n<5;n++) {
    const result=await request(store,'/working/select',{pinStaffId:p.id,pin:'0000'},{sid:`device-${n}`});
    assert.equal(result.status,403);assert.equal(result.mutated,true);
  }
  const blocked=await request(store,'/working/select',{pinStaffId:p.id,pin:'1234'},{sid:'another'});
  assert.equal(blocked.status,429);assert.equal(blocked.body.error,'shop_pin_rate_limited');
});
test('manager allowlist permits products, hours and team but denies all finance, profile and future routes', () => {
  for(const [m,p] of [['PATCH','/me/shop-hours'],['POST','/me/catalog-items'],['PATCH','/me/catalog-items/item'],['POST','/me/shop-team/invites']]) assert.equal(managerRouteAllowed(m,p),true,p);
  for(const [m,p] of [['GET','/payouts'],['GET','/earnings'],['PATCH','/me/supplier-profile'],['PATCH','/me/supplier-payment-terms'],['GET','/me/future']]) assert.equal(managerRouteAllowed(m,p),false,p);
});
test('manager can manage staff only; owner-only settings and owner/manager changes are refused', async () => {
  const store=fixture();store.shopMemberships.push({shopId:'supplier',userId:'other',role:'staff',status:'active',createdAt:AT,updatedAt:AT});
  const promoted=await request(store,'/members/other',{role:'manager'},{method:'PATCH'});
  assert.equal(promoted.body.member.role,'manager');assert.equal(store.shopMemberships.find(m=>m.userId==='other').role,'staff');
  const actor=supplierShopActor(store,store.users.find(u=>u.id==='other'),store.shopMemberships.find(m=>m.userId==='other'));
  assert.equal(actor.shopRole,'manager');
  assert.equal((await request(store,'/invites',{kind:'link'},{userId:'other'})).status,201);
  await assert.rejects(request(store,'/members/supplier',{status:'removed'},{method:'PATCH',userId:'other'}),{code:'shop_owner_required'});
  await assert.rejects(request(store,'/settings',{showRankingToStaff:false},{method:'PATCH',userId:'other'}),{code:'shop_owner_required'});
});
test('weekly stats count distinct handled jobs, recorded acceptance only, shop scope and positive staff privacy', () => {
  const store=fixture();const at='2026-11-22T08:00:00.000Z';
  store.shopMemberships.push({shopId:'supplier',userId:'other',role:'staff',status:'active'});
  store.orders=[{id:'job',supplierId:'supplier'},{id:'job2',supplierId:'supplier'},{id:'foreign',supplierId:'replacement'}];
  store.orderActions=[
    {id:'a',orderId:'job',shopId:'supplier',actorUserId:'other',actorRole:'staff',action:'order.accepted',at:'2026-11-17T00:01:00Z',acceptanceMilliseconds:60000},
    {id:'b',orderId:'job',shopId:'supplier',actorUserId:'other',actorRole:'staff',action:'order.updated',at:'2026-11-17T00:02:00Z'},
    {id:'c',orderId:'job2',shopId:'supplier',actorUserId:'supplier',actorRole:'owner',action:'order.accepted',at:'2026-11-18T00:03:00Z',acceptanceMilliseconds:180000},
    {id:'d',orderId:'foreign',shopId:'replacement',actorUserId:'other',actorRole:'staff',action:'order.accepted',at:'2026-11-18T00:03:00Z',acceptanceMilliseconds:1},
  ];
  const full=teamStats(store,'supplier','owner',at);
  assert.equal(full.members.find(m=>m.userId==='other').jobsThisWeek,1);
  assert.equal(full.members.find(m=>m.userId==='other').averageAcceptSeconds,60);
  assert.equal(full.fastestThisWeek.userId,'other');assert.equal(full.mission.acceptedJobs,2);
  const staff=teamStats(store,'supplier','staff',at);
  assert.equal(staff.members,undefined);assert.equal(staff.fastestThisWeek.userId,'other');
  assert.equal(JSON.stringify(staff).includes('average'),false);assert.equal(JSON.stringify(staff).includes('Seconds'),false);
  store.shopTeamSettings=[{shopId:'supplier',showRankingToStaff:false}];
  assert.equal(teamStats(store,'supplier','staff',at).fastestThisWeek,null);
});

test('acceptance evidence snapshots PIN attribution and exact elapsed time once', async () => {
  const {withAuditRequest,setAuditActor}=await import('../src/audit.js');
  const {recordOrderActions}=await import('../src/shop-order-actions.js');
  const store=fixture();store.orders[0].shopAcceptance={supplierId:'supplier',status:'pending',assignedAt:AT};
  const before=structuredClone(store);
  const owner=store.users.find(u=>u.id==='supplier');
  const actor=supplierShopActor(store,owner,{shopId:'supplier',userId:owner.id,role:'owner',status:'active'},{pinStaffId:'pin-person',name:'Worker',role:'staff'});
  Object.assign(store.orders[0].shopAcceptance,{status:'accepted',acceptedAt:new Date(Date.parse(AT)+65000).toISOString()});
  withAuditRequest({url:'/orders/order/transition',method:'POST',headers:{}},()=>{setAuditActor(actor);recordOrderActions(store,before);});
  const accepted=store.orderActions.filter(a=>a.action==='order.accepted');
  assert.equal(accepted.length,1);assert.equal(accepted[0].actorPinStaffId,'pin-person');assert.equal(accepted[0].acceptanceMilliseconds,65000);
  const again=structuredClone(store);
  withAuditRequest({url:'/orders/order/transition',method:'POST',headers:{}},()=>{setAuditActor(actor);recordOrderActions(store,again);});
  assert.equal(store.orderActions.filter(a=>a.action==='order.accepted').length,1);
});
test('job alerts preference suppresses current inbox and queued delivery for account members', async () => {
  const {notificationVisible}=await import('../src/notifications.js');
  const {notifyShopStaff}=await import('../src/shop-team.js');
  const store=fixture();store.shopMemberships.push({shopId:'supplier',userId:'other',role:'staff',status:'active'});
  store.shopTeamMemberSettings=[{shopId:'supplier',userId:'other',jobAlerts:false},{shopId:'supplier',userId:'supplier',jobAlerts:false}];
  const n={id:'job',userId:'supplier',shopId:'supplier',orderId:'order',appRole:'supplier',type:'shop_job_assigned',at:AT};
  store.notifications=[n];notifyShopStaff(store,{notifications:[]},{id});
  assert.equal(store.notifications.length,1);
  assert.equal(notificationVisible(store,n,'supplier','supplier',{shopId:'supplier'}),false);
  const queued={...n,userId:'other',shopTeamCopy:true};
  assert.equal(notificationVisible(store,queued,'other','supplier',{shopId:'supplier'}),false);
});
test('new link and QR accounts require provider-verified mobile and a bounded name', async () => {
  for(const kind of ['link','qr']) {
    const store=fixture(), token='a'.repeat(43);
    store.shopInvites=[{id:'invite',shopId:'supplier',kind,tokenHash:(await import('../src/shop-team.js')).inviteHash(token),createdAt:AT,expiresAt:'2099-01-01T00:00:00Z'}];
    const {claimShopInvite}=await import('../src/shop-team.js');
    const args={store,claims:{sub:'new_subject'},clerkUser:{id:'new_subject',firstName:'Worker',emailAddresses:[],phoneNumbers:[]},body:{token,name:'New worker'},at:AT,id,audit};
    assert.throws(()=>claimShopInvite(args),{code:'shop_mobile_verification_required'});
    args.clerkUser.phoneNumbers=[{phoneNumber:'+639170000010',verification:{status:'verified'}}];
    assert.equal(claimShopInvite(args).member.name,'New worker');
  }
});

test('new PIN records and promotions are Staff only, while legacy PIN managers retain access', async () => {
  const store=fixture();
  await assert.rejects(request(store,'/pin-staff',{name:'Worker',pin:'1234',role:'manager'}),{code:'invalid_shop_member_update'});
  const created=await request(store,'/pin-staff',{name:'Worker',pin:'1234'});
  await assert.rejects(request(store,`/pin-staff/${created.body.member.id}`,{role:'manager'},{method:'PATCH'}),{code:'invalid_shop_member_update'});
  store.shopPinStaff[0].role='manager';
  const selected=await request(store,'/working/select',{pinStaffId:created.body.member.id,pin:'1234'});
  assert.equal(selected.body.worker.role,'manager');
});
