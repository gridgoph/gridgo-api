import {expressAcceptRate,expressOfferOutcomes,isAcceptFirst} from './express-checkout-rules.js';
import {shopMoneySettings} from './shop-money-settings.js';
import {manilaDay} from './shop-availability.js';
import {notifyShopAvailability,queueInvalidate} from './notifications.js';
import {appendAudit} from './audit.js';

/** Same offer population and acceptance arithmetic as the shared accept rate. */
export function shopJobPerformance(store,supplierId,at) {
  const profile=store.supplierProfiles?.find(p=>p.userId===supplierId);
  const reset=Date.parse(profile?.availability?.missedJobsResetAt)||0;
  const terminal=expressOfferOutcomes(store,supplierId,at,{since:0})
    .map(({order,status})=>({...order,shopAcceptance:{...order.shopAcceptance,status}}))
    .sort((a,b)=>Date.parse(b.shopAcceptance.assignedAt)-Date.parse(a.shopAcceptance.assignedAt)||b.id.localeCompare(a.id));
  let consecutiveMisses=0;
  for(const o of terminal) {
    if(Date.parse(o.shopAcceptance.assignedAt)<=reset||o.shopAcceptance.status!=='timed_out')break;
    consecutiveMisses++;
  }
  const day=manilaDay(at),weekday=new Date(`${day}T00:00:00Z`).getUTCDay();
  const monday=new Date(Date.parse(`${day}T00:00:00+08:00`)-((weekday+6)%7)*86400000).toISOString();
  const acceptance=expressAcceptRate(store,supplierId,at,{since:Date.parse(monday)});
  return {consecutiveMisses,acceptance,paused:profile?.availability?.missedJobPause?.active===true,
    missedToday:terminal.filter(o=>o.shopAcceptance.status==='timed_out'&&manilaDay(o.shopAcceptance.deadlineAt)===day)
      .map(o=>({orderId:o.id,at:o.shopAcceptance.deadlineAt,rerouted:o.expressOrder?.reroute?.status==='moved'}))};
}

/** Called at the timeout transition, before rerouting and the atomic save. */
export function recordMissedOffer(store,order,{at,id}) {
  if(!isAcceptFirst(order)||order.reviewData||order.shopAcceptance?.status!=='timed_out')return;
  const key=`missed-offer:${order.id}`;
  if((store.notifications||[]).some(n=>n.occurrenceKey===key))return;
  const p=store.supplierProfiles?.find(p=>p.userId===order.supplierId);if(!p)return;
  const count=shopJobPerformance(store,p.userId,at).consecutiveMisses,limit=shopMoneySettings(store.settings).missedJobLimit;
  if(count>=limit) {
    p.availability={...p.availability,missedJobPause:{active:true,at,orderId:order.id,limit}};
    p.version=(p.version||1)+1;p.updatedAt=at;
  }
  notifyShopAvailability(store,p.userId,{type:'shop_missed_job',title:count>=limit?'We paused your shop':'You missed an Express job',
    body:count>=limit?'Accepted jobs can continue. Open Jobs to resume orders or stay closed today.':'A job received no answer. Open Jobs when you are ready for new orders.',occurrenceKey:key},{at,id});
  appendAudit(store,{actor:{role:'system'},action:'shop.missed_offer',entityType:'supplier_profile',entityId:p.userId,detail:{orderId:order.id,count,limit,paused:count>=limit}},{at,id});
  queueInvalidate(store,{resource:'catalog',supplierId:p.userId,userIds:[p.userId]});
}
