import test from 'node:test';
import assert from 'node:assert/strict';
import { staffRouteAllowed, supplierShopActor, assertStaffFile, claimShopInvite, inviteHash, routeShopTeam } from '../src/shop-team.js';
import { fixture, AT, id, audit } from './fixtures/reschedule.js';
import { staffOrderProjection } from '../src/shop-staff-order.js';
import { identityHasMembership } from '../src/authorization-context.js';

import { OWNER_ROUTES, STAFF_ROUTES } from './fixtures/shop-team-routes.js';

test('replacement invalidates only the selected invite and preserves its kind and recipient', async () => {
  for (const [kind, identity] of [['email', 'staff@example.invalid'], ['phone', '+639171234567'], ['qr', null], ['link', null]]) {
    const store = fixture(), oldToken = 'a'.repeat(43);
    const original = {id:'old',shopId:'supplier',kind,identity,tokenHash:inviteHash(oldToken),createdBy:'supplier',createdAt:AT,expiresAt:'2099-01-01T00:00:00.000Z'};
    store.shopInvites = [original, {...original,id:'unrelated',tokenHash:inviteHash('b'.repeat(43))}];
    const before = structuredClone(store.shopInvites[1]);
    const result = await routeShopTeam({req:{method:'POST',headers:{}},url:new URL('http://local/me/shop-team/invites/old/replace'),
      store,user:store.users.find(u=>u.id==='supplier'),readBody:async()=>({kind:'link',identity:'ignored@example.invalid'}),id,now:()=>AT,audit});
    assert.equal(result?.status,201);
    assert.equal(result.mutated,true);
    assert.equal(original.revokedAt,AT);
    assert.deepEqual(store.shopInvites[1],before);
    assert.equal(result.body.invite.kind,kind);
    assert.equal(result.body.invite.identity,identity);
    assert.equal(result.body.delivery,'share_link');
    assert.equal(Date.parse(result.body.invite.expiresAt)-Date.parse(AT),86400000);
    assert.match(result.body.token,/^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(result.body.token,oldToken);
    assert.equal(JSON.stringify(result.body.invite).includes('tokenHash'),false);
  }
});

test('staff capabilities fail closed for every owner route and any future route', () => {
  for (const [method,path] of OWNER_ROUTES) assert.equal(staffRouteAllowed(method,path),false,`${method} ${path}`);
  for (const [method,path] of STAFF_ROUTES) assert.equal(staffRouteAllowed(method,path),true,`${method} ${path}`);
  assert.equal(staffRouteAllowed('POST','/me/future-owner-feature'),false);
});
test('shop facade retains person and strips privileged owner roles without mutating identity', () => {
  const store = fixture(), user = store.users.find(row=>row.id==='other');
  store.userRoleMemberships.push({userId:'supplier',role:'super_admin',createdAt:AT});
  const actor = supplierShopActor(store,user,{shopId:'supplier',userId:'other',role:'staff',status:'active'});
  assert.equal(actor.id,'supplier'); assert.equal(actor.actorUserId,'other'); assert.equal(actor.shopRole,'staff');
  assert.equal(identityHasMembership(actor,'supplier'),true); assert.equal(identityHasMembership(actor,'super_admin'),false);
  assert.equal(user.role,'client'); assert.equal(store.users.find(row=>row.id==='supplier').actorUserId,undefined);
  for (const purpose of ['supplier_payout_qr','supplier_verification_document','supplier_invoice','catalog_item_photo']) {
    assert.throws(()=>assertStaffFile(actor,store,null,{upload:true,purpose}),{code:'shop_owner_required'});
  }
  assert.throws(()=>assertStaffFile(actor,store,{purpose:'artwork',ownerId:'supplier',references:[]}),{code:'forbidden'});
});
test('staff order projection drops money recursively and raw timeline notes', () => {
  const result = staffOrderProjection({id:'order',supplierSubtotalMinor:10000,acceptedQuote:{totalMinor:12000},
    productionItems:[{name:'Flyer',quantity:10,priceMinor:100,snapshot:{priceModifierMinor:50}}],
    shopRecovery:{status:'pending',previousPriceMinor:500},timeline:[{at:AT,state:'production',note:'Paid 100 PHP',actor:{userId:'other',name:'Pat',role:'staff'}}]});
  assert.equal(JSON.stringify(result).includes('Minor'),false); assert.equal(JSON.stringify(result).includes('PHP'),false);
  assert.equal(result.productionItems[0].name,'Flyer'); assert.equal(result.timeline[0].actor.role,'staff');
});
test('claim uses verified provider identity, never stored email or token claims', () => {
  const store=fixture(), token='a'.repeat(43);
  store.shopInvites=[{id:'invite',shopId:'supplier',kind:'email',identity:'other@example.invalid',tokenHash:inviteHash(token),createdAt:AT,expiresAt:'2099-01-01T00:00:00.000Z'}];
  const args={store,claims:{sub:'clerk_other',email:'other@example.invalid'},clerkUser:{id:'clerk_other',emailAddresses:[{emailAddress:'other@example.invalid',verification:{status:'unverified'}}]},body:{token},id,at:AT,audit};
  assert.throws(()=>claimShopInvite(args),{code:'shop_invite_identity_mismatch'});
  args.clerkUser.emailAddresses[0].verification.status='verified';
  assert.equal(claimShopInvite(args).member.status,'pending');
  assert.throws(()=>claimShopInvite(args),{code:'shop_invite_used'});
});

test('action capture retains system authors and never attributes unrelated maintenance to the shop worker', async () => {
  const { withAuditRequest, setAuditActor } = await import('../src/audit.js');
  const { recordOrderActions } = await import('../src/shop-order-actions.js');
  const store=fixture();store.orders.push({...structuredClone(store.orders[0]),id:'unrelated'});
  const baseline=structuredClone(store);
  const actor=supplierShopActor(store,store.users.find(row=>row.id==='other'),{shopId:'supplier',userId:'other',role:'staff',status:'active'});
  store.orders[0].timeline.push({at:AT,state:'production',by:'supplier'},{at:AT,state:'production',by:'system'});
  store.orders[1].updatedAt=new Date().toISOString();
  withAuditRequest({url:'/orders/order/transition',method:'POST',headers:{}},()=>{setAuditActor(actor);recordOrderActions(store,baseline);});
  assert.equal(store.orders[0].timeline.at(-2).actor.userId,'other');
  assert.deepEqual(store.orders[0].timeline.at(-1).actor,{userId:null,name:'System',role:'system'});
  assert.equal(store.orderActions.length,1);assert.equal(store.orderActions[0].orderId,'order');
  assert.equal(store.orderActions[0].actorRole,'staff');
  assert.deepEqual(store.auditLog,[], 'capturing actor history does not create incidental shared audit rows');
});

const teamRequest = (store, body, { userId='supplier', path='/me/shop-team/invites', method='POST', at=AT }={}) => routeShopTeam({
  req:{method,headers:{'x-gridgo-shop-id':'supplier'}},url:new URL(`http://local${path}`),store,
  user:store.users.find(u=>u.id===userId),readBody:async()=>body,id,now:()=>at,audit,
});
const qrClaim = (store, token, subject='clerk_other', at=AT) => claimShopInvite({store,claims:{sub:subject},
  clerkUser:{id:subject,emailAddresses:[{emailAddress:`${subject}@example.invalid`,verification:{status:'verified'}}]},body:{token},id,at,audit});

test('role QR grants exactly its role immediately on the existing account, once, with a 60-second deadline', async () => {
  for(const role of ['staff','manager']) {
    const store=fixture(), before=structuredClone(store.users);
    const result=await teamRequest(store,{kind:'qr',role});
    assert.equal(result.body.invite.role,role);
    assert.equal(result.body.delivery,'scan_qr');
    assert.equal(result.body.refreshSeconds,60);
    assert.equal(Date.parse(result.body.invite.expiresAt)-Date.parse(AT),60000);
    const claim=qrClaim(store,result.body.token);
    assert.equal(claim.member.role,role);assert.equal(claim.member.status,'active');assert.equal(claim.member.userId,'other');
    assert.deepEqual(store.users,before);
    assert.throws(()=>qrClaim(store,result.body.token),{code:'shop_invite_used'});
    assert.equal(JSON.stringify(claim).includes('clerk_'),false);
  }
});
test('role QR refresh replaces only its role, settings snapshot expiry, and deadline is exclusive', async () => {
  const store=fixture();
  const manager=await teamRequest(store,{kind:'qr',role:'manager'});
  const first=await teamRequest(store,{kind:'qr',role:'staff'});
  store.settings.shopTeamJoinQrRefreshSeconds=90;
  const next=await teamRequest(store,{kind:'qr',role:'staff'});
  assert.equal(next.body.refreshSeconds,90);
  assert.equal(store.shopInvites.find(i=>i.id===first.body.invite.id).revokedAt,AT);
  assert.equal(store.shopInvites.find(i=>i.id===manager.body.invite.id).revokedAt,undefined);
  assert.throws(()=>qrClaim(store,first.body.token),{code:'shop_invite_revoked'});
  assert.throws(()=>qrClaim(store,manager.body.token,'clerk_other',new Date(Date.parse(AT)+60000).toISOString()),{code:'shop_invite_expired'});
  assert.equal(qrClaim(store,next.body.token,'clerk_other',new Date(Date.parse(AT)+89000).toISOString()).member.status,'active');
});
test('manager QR creation and replacement require owner; issuer removal or demotion prevents claims', async () => {
  const store=fixture();store.shopMemberships.push({shopId:'supplier',userId:'other',role:'staff',status:'active',createdAt:AT,updatedAt:AT});
  store.shopTeamMemberSettings=[{shopId:'supplier',userId:'other',manager:true}];
  const managerQr=await teamRequest(store,{kind:'qr',role:'manager'});
  for(const body of [{kind:'qr',role:'manager'},{kind:'link',role:'manager'}]) await assert.rejects(teamRequest(store,body,{userId:'other'}),{code:body.kind==='qr'?'shop_owner_required':'invalid_invite_role'});
  await assert.rejects(teamRequest(store,{}, {userId:'other',path:`/me/shop-team/invites/${managerQr.body.invite.id}/replace`}),{code:'shop_owner_required'});
  const staff=await teamRequest(store,{kind:'qr',role:'staff'},{userId:'other'});
  store.shopTeamMemberSettings[0].manager=false;
  assert.throws(()=>qrClaim(store,staff.body.token,'clerk_client'),{code:'shop_invite_issuer_unavailable'});
  store.shopMemberships.find(m=>m.userId==='supplier').status='removed';
  assert.throws(()=>qrClaim(store,managerQr.body.token,'clerk_client'),{code:'shop_invite_issuer_unavailable'});
});
test('removed people rejoin on a fresh QR with a fresh role; a new person gets a separate Clerk-mapped identity', async () => {
  const store=fixture();
  const first=await teamRequest(store,{kind:'qr',role:'manager'});
  qrClaim(store,first.body.token);
  const beforeRemoval=await teamRequest(store,{kind:'qr',role:'staff'});
  await teamRequest(store,null,{method:'DELETE',path:'/me/shop-team/members/other'});
  assert.throws(()=>qrClaim(store,beforeRemoval.body.token),{code:'shop_invite_revoked'});
  assert.throws(()=>supplierShopActor(store,store.users.find(u=>u.id==='other'),store.shopMemberships.find(m=>m.userId==='other')),{code:'shop_access_removed'});
  const rejoin=await teamRequest(store,{kind:'qr',role:'staff'});
  assert.equal(qrClaim(store,rejoin.body.token).member.role,'staff');
  const count=store.users.length, fresh=await teamRequest(store,{kind:'qr',role:'staff'});
  const result=qrClaim(store,fresh.body.token,'clerk_fresh');
  assert.equal(store.users.length,count+1);assert.equal(result.member.status,'active');
  assert.equal(store.users.find(u=>u.id===result.member.userId).clerkUserId,'clerk_fresh');
});

test('role QR rejects requested owner grants and claim-side roles or PINs without consuming the code', async () => {
  const store=fixture();
  for(const role of ['owner','super_admin','',null,{},1]) await assert.rejects(teamRequest(store,{kind:'qr',role}),{code:'invalid_invite_role'});
  const issued=await teamRequest(store,{kind:'qr',role:'staff'});
  for(const field of [{role:'manager'},{pin:'1234'},{shopId:'replacement'}]) {
    assert.throws(()=>claimShopInvite({store,claims:{sub:'clerk_other'},clerkUser:{id:'clerk_other'},body:{token:issued.body.token,...field},id,at:AT,audit}),{code:'invalid_shop_invite_claim'});
    assert.equal(store.shopInvites.find(i=>i.id===issued.body.invite.id).claimedAt,undefined);
  }
  assert.equal(qrClaim(store,issued.body.token).member.role,'staff');
});
