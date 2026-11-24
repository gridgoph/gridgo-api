import { releaseVoucherReservations } from './vouchers.js';
import { assignmentTime } from './rider-tracking.js';
import { requestGroupRefund } from './group-express-recovery.js';
import { randomBytes, createHash } from 'node:crypto';
import { expressFail as fail, expressPoint } from './express-orders.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

const hash = token => createHash('sha256').update(token).digest('hex');
const terminal = new Set(['cancelled','completed']);
export function formatGroupMinor(value) {
  const amount=BigInt(value),absolute=amount<0n?-amount:amount;
  return `${amount<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;
}
export function groupDeliveryShare(fare,count) {
  if(!count)return 0;
  const denominator=BigInt(count)*100n;
  const share=Number((BigInt(fare)+denominator-1n)/denominator*100n);
  if(!Number.isSafeInteger(share))fail(400,'invalid_money');
  return share;
}
export const groupMembers = (store, group) => (store.expressGroupMembers || []).filter(m => m.groupId === group.id && m.active);
export const isOpenGroup = group => ['open','checkout_open'].includes(group.state);
export function groupPaymentMinutes(settings) { return settings?.groupPaymentTimeoutMinutes ?? 10; }
export function validateGroupSettings(settings) {
  const n=Object.hasOwn(settings||{},'groupPaymentTimeoutMinutes')?settings.groupPaymentTimeoutMinutes:10;
  if(!Number.isInteger(n)||n<1||n>60)fail(400,'invalid_group_payment_timeout');
}
function audit(store,g,action,{id,at},actorId=null) {
  (store.auditLog ||= []).push({id:id('aud'),at,actorId,actorRole:actorId?'client':'system',action:`express_group.${action}`,entityType:'express_group',entityId:g.id,orderId:g.orderId||null});
}
export function assertGroupHost(g,user) { if(g.hostId!==user?.id)fail(403,'group_host_required'); }
export function assertGroupMember(store,g,user) {
  const member=groupMembers(store,g).find(m=>m.userId===user?.id);
  if(!member)fail(403,'group_membership_required');
  return member;
}
export function assertGroupEditable(g,at) { if(g.state!=='open'||Date.parse(at)>=Date.parse(g.closesAt))fail(409,'group_locked'); }
function assertNoOpenGroup(store,userId,except=null) {
  if((store.expressGroups||[]).some(g=>g.id!==except && isOpenGroup(g)&&groupMembers(store,g).some(m=>m.userId===userId)))fail(409,'group_already_open');
}
export function createGroup(store,user,body,ctx) {
  if(user?.role!=='client')fail(403,'forbidden');
  assertNoOpenGroup(store,user.id);
  if(!['pickup','delivery'].includes(body.fulfillmentMode)||![15,30,60].includes(body.timeLimitMinutes??30))fail(400,'invalid_group_setup');
  const location=expressPoint(body.location),dropoff=body.fulfillmentMode==='delivery'?expressPoint(body.dropoff):null;
  if(dropoff&&!dropoff.label)fail(400,'invalid_group_setup');
  let backupReceiver=null;
  if(body.backupReceiver!=null) {
    const b=body.backupReceiver;
    if(body.fulfillmentMode!=='delivery'||typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.phone!=='string'||!/^\+?[0-9 ()-]{7,24}$/.test(b.phone))fail(400,'invalid_group_backup');
    backupReceiver={name:b.name.trim(),phone:b.phone};
  }
  const token=randomBytes(32).toString('base64url');
  const g={id:ctx.id('grp'),hostId:user.id,state:'open',tokenHash:hash(token),closesAt:new Date(Date.parse(ctx.at)+(body.timeLimitMinutes??30)*60000).toISOString(),createdAt:ctx.at,updatedAt:ctx.at,
    fulfillmentMode:body.fulfillmentMode,location,dropoff,backupReceiver,orderId:null,cartId:null,version:1};
  (store.expressGroups ||= []).push(g);
  (store.expressGroupMembers ||= []).push({groupId:g.id,userId:user.id,active:true,files:[],joinedAt:ctx.at,paidBack:false,pushPending:[]});
  audit(store,g,'created',ctx,user.id);
  // Raw invitations are returned once; only the digest is persisted.
  Object.defineProperty(g,'inviteToken',{value:token});
  return g;
}
export function lookupGroupInvite(store,token,at) {
  if(typeof token!=='string'||!/^[-\w]{43}$/.test(token))fail(404,'group_not_found');
  const g=(store.expressGroups||[]).find(g=>g.tokenHash===hash(token));
  if(!g)fail(404,'group_not_found');
  if(g.state!=='open'||Date.parse(at)>=Date.parse(g.closesAt)||groupMembers(store,g).length>=15)fail(409,'group_closed');
  return g;
}
export function joinGroup(store,g,user,ctx) {
  if(g.state!=='open'||Date.parse(ctx.at)>=Date.parse(g.closesAt))fail(409,'group_closed');
  if(groupMembers(store,g).some(m=>m.userId===user.id))return;
  if(groupMembers(store,g).length>=15)fail(409,'group_full');
  assertNoOpenGroup(store,user.id,g.id);
  let m=(store.expressGroupMembers||=[]).find(m=>m.groupId===g.id&&m.userId===user.id);
  if(!m){m={groupId:g.id,userId:user.id};store.expressGroupMembers.push(m);}
  Object.assign(m,{active:true,files:[],paidBack:false,joinedAt:ctx.at,pushPending:[]});
  g.updatedAt=ctx.at;g.version++;
  audit(store,g,'joined',ctx,user.id);
  groupNotice(store,g,'joined',{host:`Someone joined your group.${g.deliveryFeeMinor!=null&&groupMembers(store,g).some(m=>m.files.length)?` Delivery share per printing person: PHP ${formatGroupMinor(groupDeliveryShare(g.deliveryFeeMinor,groupMembers(store,g).filter(m=>m.files.length).length))}.`:' Add files to see the delivery share.'}`,member:`You joined the group. Files close at ${g.closesAt}.`},ctx,{userIds:[g.hostId,user.id]});
}
export function removeGroupMember(store,g,user,userId,ctx) {
  assertGroupEditable(g,ctx.at);
  if(user.id!==userId)assertGroupHost(g,user);
  if(g.hostId===userId)fail(409,'group_host_cannot_leave');
  const member=assertGroupMember(store,g,{id:userId});
  groupNotice(store,g,'removed',{host:'A person left the group. Their files were removed.',member:'You left or were removed from the group. Your files were not ordered.'},ctx,{userIds:[g.hostId,userId]});
  member.active=false;member.files=[];g.updatedAt=ctx.at;g.version++;
  audit(store,g,'member_removed',ctx,user.id);
}
export function openGroupCheckout(store,g,ctx) {
  if(g.state==='checkout_open')return;
  if(g.state!=='open')fail(409,'group_locked');
  validateGroupSettings(store.settings);
  g.state='checkout_open';g.checkoutOpenedAt=ctx.at;g.payBy=new Date(Date.parse(ctx.at)+groupPaymentMinutes(store.settings)*60000).toISOString();g.updatedAt=ctx.at;g.version++;
  audit(store,g,'checkout_opened',ctx);
  groupNotice(store,g,'checkout_due',{host:'Time to check out. Pay for the group before the payment deadline.',member:'Files are locked. The host can now check out.'},ctx);
}
export function cancelGroup(store,g,reason,ctx) {
  if(terminal.has(g.state))return;
  if(!g.orderId&&g.cartId)releaseVoucherReservations(store,ctx,r=>r.cartId===g.cartId);
  g.state='cancelled';g.cancelReason=reason;g.updatedAt=ctx.at;g.version++;
  audit(store,g,'cancelled',ctx);
  groupNotice(store,g,'cancelled',{host:`Group cancelled: ${reason}.`,member:`Group cancelled: ${reason}.`},ctx);
}
// Allocate a complete checkout amount, never a sum of independently marked-up pages.
function proportional(total,weights) {
  const sum=weights.reduce((n,w)=>n+BigInt(w),0n);
  if(!sum)return weights.map(()=>0);
  const parts=weights.map(w=>BigInt(total)*BigInt(w)/sum);
  let remaining=BigInt(total)-parts.reduce((n,w)=>n+w,0n);
  const ranked=weights.map((w,i)=>({i,remainder:BigInt(total)*BigInt(w)%sum})).filter(row=>weights[row.i]>0)
    .sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1);
  for(const row of ranked)if(remaining>0n){parts[row.i]++;remaining--;}
  return parts.map(Number);
}
export function groupAmounts(members,hostId,{printingMinor,deliveryMinor,totalMinor},principals) {
  if(![printingMinor,deliveryMinor,totalMinor,...principals].every(n=>Number.isSafeInteger(n)&&n>=0)||totalMinor<deliveryMinor)fail(400,'invalid_money');
  const host=members.findIndex(m=>m.userId===hostId),count=members.filter(m=>m.files.length).length;
  if(host<0)fail(409,'group_host_required');
  const chargedPrinting=totalMinor-deliveryMinor;
  const amounts=proportional(chargedPrinting,principals);
  const share=groupDeliveryShare(deliveryMinor,count);
  const delivery=members.map(m=>m.userId!==hostId&&m.files.length?share:0);
  delivery[host]=deliveryMinor-delivery.reduce((a,b)=>a+b,0);
  return members.map((m,i)=>({userId:m.userId,fileCount:m.files.length,pageCount:0,printSubtotalMinor:amounts[i],deliveryShareMinor:delivery[i],amountOwedMinor:amounts[i]+delivery[i]}));
}
export function groupNotice(store,g,event,copy,ctx,{userIds=null}={}) {
  const members=(store.expressGroupMembers||[]).filter(m=>m.groupId===g.id&&(!userIds?m.active:userIds.includes(m.userId)));
  for(const m of members) {
    const text=m.userId===g.hostId?copy.host:copy.member;
    const body=typeof text==='function'?text(m):text;
    if(!body)continue;
    const n={id:ctx.id('ntf'),at:ctx.at,userId:m.userId,appRole:'client',type:`group_${event}`,groupId:g.id,orderId:g.orderId||null,title:'Group order',body,read:false,push:false};
    (store.notifications ||= []).push(n);
    (m.pushPending ||= []).push({title:n.title,body:n.body});
    if(m.pushPending.length>20)m.pushPending.splice(0,m.pushPending.length-20);
  }
  for(const membership of privilegedAdminMemberships(store)) (store.notifications ||= []).push({id:ctx.id('ntf'),at:ctx.at,userId:membership.userId,appRole:membership.role,type:`ops_group_${event}`,groupId:g.id,orderId:g.orderId||null,title:'Group order update',body:`Group event: ${event.replaceAll('_',' ')}.`,read:false});
  queueInvalidate(store,{resource:'orders',id:g.orderId||g.id,userIds:members.map(m=>m.userId)});
  flushGroupPushes(store,ctx);
}
export function flushGroupPushes(store,ctx) {
  let changed=false;
  for(const m of store.expressGroupMembers||[]) {
    const last=Math.max(0,...(store.expressGroupMembers||[]).filter(other=>other.userId===m.userId).map(other=>Date.parse(other.lastPushAt||'1970-01-01T00:00:00Z')));
    if(!m.pushPending?.length||Date.parse(ctx.at)<last+60000)continue;
    const g=store.expressGroups.find(g=>g.id===m.groupId);if(!g)continue;
    const events=m.pushPending.splice(0);
    for(const n of store.notifications||[])if(n.userId===m.userId&&n.type==='group_updates')n.push=false;
    (store.notifications ||= []).push({id:ctx.id('ntf'),at:ctx.at,userId:m.userId,appRole:'client',type:'group_updates',groupId:g.id,orderId:g.orderId||null,title:events.length===1?'Group order':'Group updates',body:[...new Set(events.reverse().map(e=>e.body))].join(' ').slice(0,2000),read:false});
    m.lastPushAt=ctx.at;changed=true;
  }
  return changed;
}
export function sweepGroups(store,ctx) {
  let changed=false;
  for(const g of store.expressGroups||[]) {
    if(g.state==='open'&&Date.parse(ctx.at)>=Date.parse(g.closesAt)) {openGroupCheckout(store,g,ctx);changed=true;}
    else if(g.state==='open'&&!g.closingNotifiedAt&&Date.parse(ctx.at)>=Date.parse(g.closesAt)-5*60000) {
      g.closingNotifiedAt=ctx.at;groupNotice(store,g,'closing',{host:'Five minutes left to add group files.',member:'Five minutes left to add your files.'},ctx);changed=true;
    }
    if(g.state==='checkout_open'&&Date.parse(ctx.at)>=Date.parse(g.payBy)) {cancelGroup(store,g,'not_paid',ctx);changed=true;}
    const order=store.orders?.find(o=>o.id===g.orderId);
    if(order?.groupOrder?.shopDecision?.status==='pending'&&Date.parse(ctx.at)>=Date.parse(order.groupOrder.shopDecision.deadlineAt)) {order.groupOrder.shopDecision.status='use';order.groupOrder.shopDecision.decidedAt=ctx.at;changed=true;}
    if(order?.state==='cancelled')changed=requestGroupRefund(store,order,ctx)||changed;
    if(order&&g.lastOrderState!==order.state) {
      g.lastOrderState=order.state;changed=true;
      queueInvalidate(store,{resource:'orders',id:order.id,userIds:groupMembers(store,g).map(m=>m.userId)});
      if(order.state==='cancelled')cancelGroup(store,g,order.groupOrder?.cancelReason||'order_cancelled',ctx);
      else {
        const event=order.state==='ready_for_dispatch'?'ready':['picked_up','out_for_delivery'].includes(order.state)?'on_the_way':['delivered','issue_window_open'].includes(order.state)?'delivered':null;
        if(event)groupNotice(store,g,event,{host:event==='ready'&&g.fulfillmentMode==='pickup'?`Ready. Your pickup code is ${order.expressOrder.pickupCode}.`:event==='delivered'?'Delivered. Remember to collect what the group owes you.':`Your group order is ${event.replaceAll('_',' ')}.${event==='on_the_way'&&order.riderId&&order.groupOrder.arrivalEstimate?.riderId===order.riderId?' Estimated arrival '+order.groupOrder.arrivalEstimate.at+'.':''}`,member:event==='ready'&&g.fulfillmentMode==='pickup'?'Ready. The host is collecting all prints.':`Your group order is ${event.replaceAll('_',' ')}.${event==='on_the_way'&&order.riderId&&order.groupOrder.arrivalEstimate?.riderId===order.riderId?' Estimated arrival '+order.groupOrder.arrivalEstimate.at+'.':''}`},ctx);
        if(['completed','payout_released'].includes(order.state))g.state='completed';
      }
    }
  }
  return flushGroupPushes(store,ctx)||changed;
}
export function groupTracking(store,g,user,at) {
  assertGroupMember(store,g,user);
  const o=store.orders?.find(o=>o.id===g.orderId);if(!o)return null;
  const host=user.id===g.hostId;
  return {orderId:o.id,state:o.state,fulfillmentMode:o.fulfillmentMode,updatedAt:o.updatedAt,
    ...(host&&o.fulfillmentMode==='pickup'&&['ready_for_dispatch','delivered','issue_window_open','completed'].includes(o.state)?{pickupCode:o.expressOrder.pickupCode}:{}),
    ...(host&&o.handover?.otp?{deliveryCode:o.handover.otp}:{}),
    ...(o.riderId?{riderId:o.riderId}:{}),
    estimatedArrivalAt:o.riderId&&o.groupOrder?.arrivalEstimate?.riderId===o.riderId?o.groupOrder.arrivalEstimate.at:null,
    ...(host&&o.groupOrder?.shopDecision?{shopDecision:structuredClone(o.groupOrder.shopDecision)}:{})};
}
export function backupReceiver(order,calls,at) {
  const backup=order.groupOrder?.backupReceiver;
  const arrived=order.riderProgress?.riderId===order.riderId&&order.riderProgress?.assignedAt===assignmentTime(order)?order.riderProgress.events?.arrived:null;
  const arrivedAt=typeof arrived==='string'?arrived:arrived?.at;
  const missed=new Set(calls.filter(c=>c.pair==='delivery'&&c.state==='missed'&&c.caller_id===order.riderId&&c.rider_id===order.riderId&&c.callee_id===order.clientId&&(!assignmentTime(order)||Date.parse(c.created_at)>=Date.parse(assignmentTime(order)))).map(c=>c.id)).size;
  const unlocked=!!backup&&['picked_up','out_for_delivery'].includes(order.state)&&(missed>=2||Date.parse(at)>=Date.parse(arrivedAt)+5*60000);
  return {unlocked,...(unlocked?{receiver:structuredClone(backup)}:{})};
}
