import { notifyAdmins } from './domain-events.js';
import { queueInvalidate } from './notifications.js';
import { actorUserId, isShopStaff } from './shop-team.js';
import { createInviteCode, publicTesterInvites } from './tester-invites.js';
import { timingSafeEqual } from 'node:crypto';
import { expressFail as fail, publicExpress, declineExpress, expressEvent, startExpressAcceptance } from './express-orders.js';
import { supplierMatchBlockersFor } from './supplier-eligibility.js';
import { assertRefundWorkAllowed } from './refund-policy.js';
import { paymentSettled } from './operational-model.js';
import { completeHandover } from './hub-handover.js';
import { claimBlocksHandover } from './shop-handover.js';
import { acknowledgeInstructions } from './special-instructions.js';
import { isReviewData } from './review-data.js';

export async function routeExpressOrders({req,url,store,user,readBody,id,now,audit}) {
 if(url.pathname==='/me/express-settings' && ['GET','PATCH'].includes(req.method)) {
   if(user?.role!=='supplier' || isShopStaff(user))fail(403,'shop_owner_required');
   const profile=store.supplierProfiles.find(profile=>profile.userId===user.id);
   if(!profile)fail(404,'shop_not_found');
   const response=()=>({expressEnabled:profile.expressEnabled!==false,version:profile.version||1});
   if(req.method==='GET')return {status:200,body:response()};
   const body=await readBody(req);
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['expressEnabled','expectedVersion'].includes(key))
     ||typeof body.expressEnabled!=='boolean'||!Number.isSafeInteger(body.expectedVersion))fail(400,'invalid_express_settings');
   if(body.expectedVersion!==(profile.version||1))fail(409,'shop_profile_stale');
   const before=response();profile.expressEnabled=body.expressEnabled;profile.version=(profile.version||1)+1;profile.updatedAt=now();
   audit(store,{actor:user,action:'shop.express_settings_updated',entityType:'supplier_profile',entityId:user.id,before,after:response()});
   notifyAdmins(store,'ops_express_settings_updated','Shop Express availability changed',null,`${user.id}:${profile.version}`,{createId:id,at:profile.updatedAt});
   queueInvalidate(store,{resource:'catalog',userIds:[user.id]});
   return {status:200,body:response(),mutated:true};
 }

 if(url.pathname==='/me/express-friend-pass' && ['GET','POST'].includes(req.method)) {
   if(!store.userRoleMemberships.some(m=>m.userId===user?.id&&m.role==='client'))fail(403,'forbidden');
   if(req.method==='POST')createInviteCode(store,user.id,{at:now()});
   const invitation=publicTesterInvites(store,user.id);
   const successful=(store.testerInvites||[]).filter(i=>i.inviterId===user.id&&(store.voucherCampaigns||[]).some(c=>c.id===`express_friend_${i.id}`)).length;
   return {status:200,body:{friendPass:{link:invitation.link,signups:invitation.joined,successful}},mutated:req.method==='POST'};
 }
 if(url.pathname==='/ops/express/daily' && req.method==='GET') {
   if(!['ops_admin','super_admin'].includes(user?.role)||!store.userRoleMemberships.some(m=>m.userId===user.id&&m.role===user.role))fail(403,'forbidden');
   const date=url.searchParams.get('date')||new Date(Date.parse(now())+8*3600000).toISOString().slice(0,10);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(`${date}T00:00:00Z`)))fail(400,'invalid_date');
   const orders=store.orders.filter(o=>o.orderType==='express'&&!isReviewData(o)&&new Date(Date.parse(o.createdAt)+8*3600000).toISOString().slice(0,10)===date);
   const totalMinor=orders.reduce((n,o)=>n+BigInt(o.totalMinor),0n);if(totalMinor>BigInt(Number.MAX_SAFE_INTEGER))fail(409,'report_amount_overflow');
   return {status:200,body:{date,orderCount:orders.length,cancelledCount:orders.filter(o=>o.state==='cancelled').length,totalMinor:Number(totalMinor),
    lowRatings:(store.shopReviews||[]).filter(r=>r.qualityStars<=2&&orders.some(o=>o.id===r.orderId)).map(r=>({orderId:r.orderId,supplierId:r.supplierId,qualityStars:r.qualityStars,at:r.createdAt}))}};
 }
 const match=/^\/orders\/([^/]+)\/express\/(accept|decline|pickup)$/.exec(url.pathname);
 if(!match||req.method!=='POST')return null;
 if(user?.role!=='supplier')fail(403,'forbidden');
 const order=store.orders.find(o=>o.id===match[1]&&o.orderType==='express');
 if(!order)fail(404,'order_not_found');
 if(order.supplierId!==user.id)fail(403,'forbidden');
 const profile=store.supplierProfiles.find(p=>p.userId===user.id);
 // A shop may finish an already accepted order while temporarily closed, but
 // approval and account standing remain mandatory.
 if(supplierMatchBlockersFor(store)(user.id,{...profile,isClosed:false,availability:{...profile?.availability,pausedUntil:null}}).length)fail(403,'supplier_not_approved');
 const at=now(),body=await readBody(req),action=match[2];
 if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_request');
 assertRefundWorkAllowed(store,order);
 const response=()=>({status:200,body:{orderId:order.id,state:order.state,expressOrder:publicExpress(order,user)},mutated:true});
 if(action==='pickup') {
   if(order.fulfillmentMode!=='pickup')fail(409,'express_pickup_required');
   if(order.expressOrder.pickedUpAt)return response();
   if(order.state!=='ready_for_dispatch')fail(409,'express_not_ready');
   if(!paymentSettled(order.payments?.initial)||!paymentSettled(order.payments?.final_online))fail(409,'payment_required');
   if(claimBlocksHandover(store,order))fail(409,'payout_held');
   const e=order.expressOrder;
   if(Date.parse(e.retryAfter||'')>Date.parse(at))return {status:429,body:{error:'express_pickup_attempts_exceeded',retryAfter:e.retryAfter},mutated:false};
   if(e.retryAfter){delete e.retryAfter;e.failedAttempts=0;}
   const code=typeof body.code==='string'?body.code:'';
   if(!/^\d{6}$/.test(code)||!timingSafeEqual(Buffer.from(code),Buffer.from(e.pickupCode))) {
     e.failedAttempts=(e.failedAttempts||0)+1;
     if(e.failedAttempts>=5)e.retryAfter=new Date(Date.parse(at)+15*60000).toISOString();
     return {status:409,body:{error:'express_pickup_code_mismatch'},mutated:true};
   }
   e.pickedUpAt=at;
   completeHandover(store,order,{actor:{...user,id:actorUserId(user)},at,id,note:'Client collected Express order using the counter code.'});
   for(const job of store.orderJobs||[])if(job.orderId===order.id){job.state='delivered';job.updatedAt=at;}
   expressEvent(store,order,'picked_up',{at,id,actorId:actorUserId(user)});
   return response();
 }
 if(action==='accept'&&order.shopAcceptance?.status==='accepted')return response();
 if(order.state!=='supplier_assigned')fail(409,'express_acceptance_not_pending');
 if(!order.shopAcceptance)startExpressAcceptance(order,at);
 if(Date.parse(at)>=Date.parse(order.shopAcceptance.deadlineAt)) {
   declineExpress(store,order,{at,id,kind:'timed_out',actorId:actorUserId(user)});
   return {status:409,body:{error:'shop_acceptance_expired'},mutated:true};
 }
 if(action==='decline') {
   if(typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>2000)fail(400,'shop_cancel_reason_required');
   declineExpress(store,order,{at,id,kind:'declined',actorId:actorUserId(user),reason:body.reason.trim()});return response();
 }
 if(order.fileCheck?.status!=='passed')fail(409,'artwork_file_check_required');
 if(!order.cash&&!paymentSettled(order.payments?.initial))fail(409,'payment_required');
 acknowledgeInstructions(store,order,user,body,at,(_store,event)=>store.auditLog.push({id:id('aud'),at,actorId:actorUserId(user),actorRole:'supplier',...event,actor:undefined}));
 order.shopAcceptance.status='accepted';order.shopAcceptance.acceptedAt=at;order.shopAcceptance.acceptedBy=actorUserId(user);
 order.state='payment_authorized';order.timeline.push({at,state:order.state,by:actorUserId(user),note:'Shop accepted Express order.'});
 expressEvent(store,order,'accepted',{at,id,actorId:actorUserId(user)});return response();
}
