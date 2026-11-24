import { distanceMetersBetween } from './operational-model.js';
import { collectedRefundComponents, noCashVoucherRemedy, ACTIVE_REFUND_STATUSES } from './refund-policy.js';
import { groupNotice } from './express-groups.js';

export function requestGroupRefund(store,order,{id,at}) {
  if(!order.groupOrder||order.state!=='cancelled'||order.cash||order.groupOrder.refundRequestId)return false;
  if((store.refundRequests||[]).some(r=>r.orderId===order.id&&r.kind==='cancellation'))return false;
  if((store.refundRequests||[]).some(r=>r.orderId===order.id&&ACTIVE_REFUND_STATUSES.includes(r.status)))return false;
  const collected=collectedRefundComponents(order,store);
  if(!Object.values(collected).some(n=>n>0)&&!noCashVoucherRemedy(order,store))return false;
  // Before production the existing settlement policy returns all verified funds.
  // A request never claims that a manual transfer has already occurred.
  const request={id:id('refund'),orderId:order.id,clientId:order.clientId,policyVersion:'available_funds_v1',status:'requested',version:1,kind:'cancellation',reason:'Group Express could not be placed or the host declined the replacement.',beforeProduction:true,late:false,filingDeadlineAt:null,orderStateAtFiling:order.state,evidenceFileIds:[],destination:null,createdAt:at,updatedAt:at};
  (store.refundRequests||=[]).push(request);
  (store.refundEvents||=[]).push({id:id('rfe'),requestId:request.id,requestVersion:1,actorId:order.clientId,kind:'requested',reason:request.reason,createdAt:at,data:{}});
  order.expressOrder.refundRequired=true;order.groupOrder.refundRequestId=request.id;
  return true;
}
export function cancelGroupExpressOrder(store,order,reason,ctx) {
  order.state='cancelled';order.cancelledAt=ctx.at;order.cancelledBy=null;order.cancellationReason='Group Express cancelled before production.';order.groupOrder.cancelReason=reason;
  if(order.groupOrder.shopDecision?.status==='pending')order.groupOrder.shopDecision.status='cancel';
  for(const job of store.orderJobs||[])if(job.orderId===order.id){job.state='cancelled';job.updatedAt=ctx.at;}
  (order.timeline||=[]).push({at:ctx.at,state:'cancelled',by:'system',note:order.cancellationReason});
  requestGroupRefund(store,order,ctx);
}
export function groupExpressMoved(store,order,ctx) {
  if(!order.groupOrder)return;
  const profile=store.supplierProfiles.find(p=>p.userId===order.supplierId);
  order.groupOrder.shopDecision={status:'pending',supplierId:order.supplierId,shopName:profile?.shopName||'Express shop',location:structuredClone(order.pickup),distanceMeters:distanceMetersBetween(order.pickup,order.fulfillmentMode==='delivery'?order.dropoff:order.expressOrder.location),openedAt:ctx.at,deadlineAt:new Date(Date.parse(ctx.at)+5*60000).toISOString()};
  const g=store.expressGroups?.find(g=>g.id===order.groupOrder.id);
  if(g)groupNotice(store,g,'shop_changed',{host:'The shop changed at the same price. Review the replacement within five minutes or it will be used.',member:'The shop changed. The group price is unchanged.'},ctx);
}
