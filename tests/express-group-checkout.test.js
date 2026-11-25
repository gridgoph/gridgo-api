import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, addShop } from './fixtures/scheduling.js';
import { routeExpressGroups } from '../src/express-group-routes.js';
import { routeOrderMatch } from '../src/order-match-routes.js';
import { publicOrderFor } from '../src/operational-model.js';
import { declineExpress, startExpressAcceptance } from '../src/express-orders.js';
import { sweepGroups } from '../src/express-groups.js';
import { assertRefundWorkAllowed } from '../src/refund-policy.js';
import { canReadOrderArtwork } from '../src/order-file-access.js';
const AT='2026-09-23T01:00:00.000Z';
function setup() {
 const {store,client}=fixture({express:true});store.version=3;
 for(const item of store.catalogItems)Object.assign(item,{express:true,printLayouts:['fit_to_paper'],pricingUnit:'per_page',subcategoryCode:'document_printing'});
 for(const service of store.supplierServices)service.categoryCode='document_publication';
 const member={...client,id:'member',clerkUserId:'clerk_member',name:'Member',email:'member@example.invalid'};store.users.push(member);
 const art=store.files.find(f=>f.fileId==='file_art');art.detected={pageCount:5};
 store.files.push({...structuredClone(art),fileId:'member_art',ownerId:'member'});
 let n=0;const id=p=>`${p}_${++n}`;
 const call=(user,method,path,body={},at=AT)=>routeExpressGroups({req:{method,headers:{}},url:new URL(`http://test${path}`),store,user,readBody:async()=>body,id,now:()=>at});
 return {store,client,member,call,id};
}
const print=fileId=>({fileId,copies:2,pageRange:'2-3',colour:'bw',paper:'a4',sides:'two',layout:'fit_to_paper',acceptedWarnings:[]});
async function groupFixture(){const f=setup(),{call,client,member}=f;const created=await call(client,'POST','/express/groups',{fulfillmentMode:'delivery',location:{lat:7.064,lng:125.6085},dropoff:{lat:7.065,lng:125.609,label:'Destination'},timeLimitMinutes:30});const g=created.body.group;await call(member,'POST',`/express/groups/invites/${created.body.inviteToken}/join`);await call(client,'PUT',`/express/groups/${g.id}/files`,{files:[print('file_art')]});await call(member,'PUT',`/express/groups/${g.id}/files`,{files:[print('member_art')]});return {...f,g};}
test('member files are independently owned and normal selected-page totals equal one Express checkout',async()=>{
 const {store,client,member,call,g,id}=await groupFixture();
 await assert.rejects(call(client,'PUT',`/express/groups/${g.id}/files`,{files:[print('member_art')]}),e=>e.code==='file_not_ready');
 // In-memory calls have no transaction rollback; restore the refused mutation as HTTP does.
 store.expressGroupMembers.find(m=>m.userId===client.id).files=[print('file_art')];
 const personal=(await call(member,'GET',`/express/groups/${g.id}`)).body.group;
 assert.equal(personal.me.files[0].fileId,'member_art');assert.equal(personal.members,undefined);assert.equal(personal.dropoff,undefined);
 await call(client,'POST',`/express/groups/${g.id}/close`);
 await assert.rejects(call(member,'PUT',`/express/groups/${g.id}/files`,{files:[]}),e=>e.code==='group_locked');
 const prepared=await call(client,'POST',`/express/groups/${g.id}/prepare`);
 const cartId=prepared.body.cartId;
 const refreshed=await call(client,'POST',`/express/groups/${g.id}/prepare`);assert.equal(refreshed.body.cartId,cartId);prepared.body.confirmation=refreshed.body.confirmation;
 await assert.rejects(routeOrderMatch({req:{method:'POST'},url:new URL(`http://test/me/carts/${cartId}/checkout`),store:{...store,expressGroups:[],expressGroupMembers:[]},user:client,readBody:async()=>({}),id,now:()=>AT}),e=>e.code==='group_checkout_required');
 const checkout=await call(client,'POST',`/express/groups/${g.id}/checkout`,{looksRight:true,expressConfirmation:prepared.body.confirmation,payment:{method:'qr_manual',reference:'GROUP-TEST',proofFileId:'file_qr'}});
 assert.equal(checkout.status,201);
 const group=store.expressGroups[0],order=store.orders.find(o=>o.id===group.orderId);
 assert.equal(order.supplierSubtotalMinor,2400);assert.equal(order.totalMinor,prepared.body.quote.totalMinor);
 assert.equal(group.amounts.reduce((n,a)=>n+a.amountOwedMinor,0),order.totalMinor);
 assert.deepEqual(group.amounts.map(a=>a.pageCount),[4,4]);
 assert.equal(order.groupOrder.memberCount,2);
 const lines=store.orderLineItems.filter(l=>l.orderId===order.id);assert.deepEqual(lines.map(l=>l.expressPrint.groupMemberId),[client.id,member.id]);
 assert.equal(canReadOrderArtwork(client,store,order,'member_art','artwork'),false);
 assert.equal(publicOrderFor(order,client,store).productionItems.length,1);
 assert.equal(JSON.stringify(publicOrderFor(order,{id:'shop_a',role:'supplier'},store).groupOrder).includes('backup'),false);
 await call(client,'PATCH',`/express/groups/${g.id}/members/member/paid-back`,{paidBack:true});
 assert.equal((await call(member,'GET',`/express/groups/${g.id}`)).body.group.me.paidBack,true);
});
test('group COD uses the full amount including fare and refuses 1500 exactly without changing solo policy',async()=>{
 const {store,client,call,g}=await groupFixture();await call(client,'POST',`/express/groups/${g.id}/close`);
 const prepared=await call(client,'POST',`/express/groups/${g.id}/prepare`);
 store.settings.deliveryFeeBands.forEach(b=>b.feeMinor=150000);
 await assert.rejects(call(client,'POST',`/express/groups/${g.id}/checkout`,{looksRight:true,expressConfirmation:prepared.body.confirmation,payment:{method:'cash'}}),e=>e.code==='group_cash_limit_exceeded');
});
test('replacement is same zone, holds work for host choice, defaults use, and three refusals request full existing-policy refund',async()=>{
 const {store,client,call,g,id}=await groupFixture();await call(client,'POST',`/express/groups/${g.id}/close`);const d=await call(client,'POST',`/express/groups/${g.id}/prepare`);
 await call(client,'POST',`/express/groups/${g.id}/checkout`,{looksRight:true,expressConfirmation:d.body.confirmation,payment:{method:'qr_manual',reference:'GROUP-TEST',proofFileId:'file_qr'}});
 const order=store.orders.at(-1);order.payments.initial.status='confirmed';order.fileCheck.status='passed';order.state='supplier_assigned';startExpressAcceptance(order,AT);
 const total=order.totalMinor;declineExpress(store,order,{at:AT,id});
 assert.equal(order.supplierId,'shop_b');assert.equal(order.totalMinor,total);assert.equal(order.groupOrder.shopDecision.status,'pending');
 assert.throws(()=>assertRefundWorkAllowed(store,order),e=>e.code==='group_shop_decision_pending');
 sweepGroups(store,{id,at:'2026-09-23T01:05:00Z'});assert.equal(order.groupOrder.shopDecision.status,'use');
 order.expressOrder.declines=2;startExpressAcceptance(order,'2026-09-23T01:05:00Z');declineExpress(store,order,{id,at:'2026-09-23T01:06:00Z'});
 assert.equal(order.state,'cancelled');assert.equal(store.refundRequests.length,1);assert.equal(store.refundRequests[0].beforeProduction,true);assert.equal(order.totalMinor,total);
 const {calculateRefundSettlement}=await import('../src/refund-policy.js');
 const amounts=calculateRefundSettlement(order,{store,beforeProduction:true,shopEntitlementMinor:0,riderEntitlementMinor:0});
 assert.equal(amounts.totalMinor,total);
});
test('host can use or cancel a replacement; member decisions are refused and refunds are idempotent',async()=>{
 const {store,client,member,call,g,id}=await groupFixture();await call(client,'POST',`/express/groups/${g.id}/close`);const d=await call(client,'POST',`/express/groups/${g.id}/prepare`);
 await call(client,'POST',`/express/groups/${g.id}/checkout`,{looksRight:true,expressConfirmation:d.body.confirmation,payment:{method:'qr_manual',reference:'GROUP-TEST',proofFileId:'file_qr'}});
 const o=store.orders.at(-1);o.payments.initial.status='confirmed';o.state='supplier_assigned';startExpressAcceptance(o,AT);declineExpress(store,o,{at:AT,id});
 await assert.rejects(call(member,'POST',`/express/groups/${g.id}/shop-decision`,{decision:'cancel'}),e=>e.code==='group_host_required');
 const cancelled=await call(client,'POST',`/express/groups/${g.id}/shop-decision`,{decision:'cancel'});
 assert.equal(cancelled.body.group.state,'cancelled');assert.equal(o.state,'cancelled');assert.equal(store.refundRequests.length,1);
 sweepGroups(store,{id,at:AT});sweepGroups(store,{id,at:AT});assert.equal(store.refundRequests.length,1);
 store.refundRequests[0].status='paid';sweepGroups(store,{id,at:AT});assert.equal(store.refundRequests.length,1);
});
test('member optional ratings stay own-only and do not change the solo shop review count',async()=>{
 const {store,client,member,call,g}=await groupFixture();await call(client,'POST',`/express/groups/${g.id}/close`);const d=await call(client,'POST',`/express/groups/${g.id}/prepare`);
 await call(client,'POST',`/express/groups/${g.id}/checkout`,{looksRight:true,expressConfirmation:d.body.confirmation,payment:{method:'qr_manual',reference:'GROUP-TEST',proofFileId:'file_qr'}});
 await assert.rejects(call(member,'POST',`/express/groups/${g.id}/review`,{qualityStars:5,speedStars:5,valueStars:5}),e=>e.code==='order_not_complete');
 store.orders.at(-1).state='completed';const r=await call(member,'POST',`/express/groups/${g.id}/review`,{qualityStars:5,speedStars:4,valueStars:5,riderStars:5});assert.equal(r.status,201);
 await assert.rejects(call(member,'POST',`/express/groups/${g.id}/review`,{qualityStars:5,speedStars:5,valueStars:5}),e=>e.code==='already_rated');
 assert.equal((await call(client,'GET',`/express/groups/${g.id}`)).body.group.me.review,null);
});
test('an unavailable printer quote cannot prevent a member leaving before checkout',async()=>{
 const {store,client,member,call,g}=await groupFixture();for(const p of store.supplierProfiles)p.isClosed=true;
 assert.equal((await call(member,'POST',`/express/groups/${g.id}/leave`)).status,200);
 const read=await call(client,'GET',`/express/groups/${g.id}`);assert.equal(read.body.group.people,1);assert.equal(read.body.group.quoteStatus,'pending');assert.equal(read.body.group.totalMinor,null);
});
test('group checkout uses approved listing controls while a private revision waits',async()=>{
 const {store,client,call,g}=await groupFixture();const {listingSnapshot}=await import('../src/catalog-review-state.js');
 for(const item of store.catalogItems){item.approvedSnapshot=listingSnapshot(store,item);item.reviewStatus='pending';item.printLayouts=['actual_size_centered'];}
 await call(client,'POST',`/express/groups/${g.id}/close`);const draft=await call(client,'POST',`/express/groups/${g.id}/prepare`);
 const paid=await call(client,'POST',`/express/groups/${g.id}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'GROUP-APPROVED',proofFileId:'file_qr'}});
 assert.equal(paid.status,201);assert.ok(store.catalogItems.every(item=>item.reviewStatus==='pending'&&item.printLayouts[0]==='actual_size_centered'));
});
test('the host member perk lowers one Express group total, is shared by printing and never changes shop or rider pay',async()=>{
 const {addPartner,addMember}=await import('./fixtures/organization-members.js');
 const run=async (perk)=>{
  const f=await groupFixture(),{store,client,member,call,g}=f;
  if(perk)addPartner(store,{at:AT,perk:{amountMinor:101}});
  // A joiner's own membership never prices the host's order.
  if(perk==='host')addMember(store,client.id,{at:AT});if(perk==='joiner')addMember(store,member.id,{at:AT});
  await call(client,'POST',`/express/groups/${g.id}/close`);const d=await call(client,'POST',`/express/groups/${g.id}/prepare`);
  await call(client,'POST',`/express/groups/${g.id}/checkout`,{looksRight:true,expressConfirmation:d.body.confirmation,payment:{method:'qr_manual',reference:'GROUP-TEST',proofFileId:'file_qr'}});
  return {store,order:store.orders.at(-1),group:store.expressGroups[0],quote:d.body.quote};
 };
 const plain=await run(null),host=await run('host'),joiner=await run('joiner');
 assert.equal(joiner.order.totalMinor,plain.order.totalMinor);assert.equal(joiner.store.memberPerkUses.length,0);
 assert.equal(host.order.memberPerkMinor,101);assert.equal(host.quote.totalMinor,host.order.totalMinor);assert.equal(host.order.totalMinor,plain.order.totalMinor-101);
 assert.equal(host.group.amounts.reduce((n,a)=>n+a.amountOwedMinor,0),host.order.totalMinor);
 for(const [i,a] of host.group.amounts.entries())assert.ok(a.amountOwedMinor<plain.group.amounts[i].amountOwedMinor);
 for(const key of ['supplierSubtotalMinor','supplierPlatformPayoutMinor','riderPayoutMinor','deliveryFeeMinor'])assert.equal(host.order[key],plain.order[key],key);
 assert.deepEqual(host.order.payoutMilestones.map(m=>m.amountMinor),plain.order.payoutMilestones.map(m=>m.amountMinor));
 assert.equal(host.store.memberPerkUses.length,1);
});
