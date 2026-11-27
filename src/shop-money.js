import {randomUUID} from 'node:crypto';
import {appendAudit} from './audit.js';
import {privilegedAdminMemberships,queueInvalidate} from './notifications.js';
import {releaseMilestone,activePayoutHold} from './operational-model.js';
import {prepareVerificationPayout,completeVerificationPayout,verificationSummary,verificationReservationsForOrder,cancelVerificationReservation,markVerificationTransferUnknown,recordShopRecovery,supplierVerified} from './supplier-verification.js';
import {recordPreparedSupplierTransfer} from './supplier-transfer-reconciliation.js';
import {resolvePayoutReceipt} from './payout-receipt.js';
import {opsPayoutAccountProjection} from './payout-account.js';
import {changePaymentsFor,changePayoutsFor} from './order-change-policy.js';
import {shopMoneySettings,manilaClock,businessDate,nextShopPayout} from './shop-money-settings.js';
import {shopMoneyPolicy,shopMoneyPaused,payRequestClosed} from './shop-money-policy.js';
import {clientPaymentSnapshot} from './shop-payment-method.js';
import {identityHasMembership,selectActorRole} from './authorization-context.js';
import {refundSettlementFor} from './refund-policy.js';
import {supplierPayoutStatus,assertSupplierPayoutAllowed} from './supplier-payout-policy.js';
export {clientPaymentSnapshot} from './shop-payment-method.js';
export {shopMoneySettings} from './shop-money-settings.js';
export {shopMoneyPolicy,shopMoneyPaused} from './shop-money-policy.js';

const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const safe=n=>{if(!Number.isSafeInteger(n))fail('invalid_money',400);return n;};
const total=values=>safe(Number(values.reduce((n,v)=>n+BigInt(v),0n)));
const context=ctx=>({...ctx,at:ctx?.at||new Date().toISOString(),id:ctx?.id||((p)=>`${p}_${randomUUID()}`),actor:ctx?.actor||{role:'system'}});
const ledger=store=>store.shopMoneyLedger||=[];
const events=store=>store.shopMoneyEvents||=[];
function append(store,entry,ctx,event=false) {
  const rows=event?events(store):ledger(store),previous=rows.find(e=>e.key===entry.key);
  if(previous)return previous;
  const c=context(ctx),row={id:c.id('money'),at:c.at,...entry};
  if(!event){row.owedDeltaMinor=safe(entry.owedDeltaMinor||0);row.owingDeltaMinor=safe(entry.owingDeltaMinor||0);}
  rows.push(row);
  appendAudit(store,{actor:c.actor,action:`shop_money.${entry.kind}`,entityType:'user',entityId:entry.supplierId||null,orderId:entry.orderId,detail:row},c);
  return row;
}
function notify(store,supplierId,type,title,body,ctx) {
  const c=context(ctx);
  for(const r of [{userId:supplierId,role:'supplier'},...privilegedAdminMemberships(store)])(store.notifications||=[]).push({id:c.id('ntf'),at:c.at,userId:r.userId,appRole:r.role,type,title,body,read:false});
  for(const resource of ['payouts','availability'])queueInvalidate(store,{resource,supplierId,userIds:[supplierId,...privilegedAdminMemberships(store).map(r=>r.userId)]});
}
/** Reconcile canonical entitlements/actual payments into an append-only journal.
 * Holds affect availability, never the recorded gross amount owed. */
export function syncShopMoney(store,ctx) {
  const c=context(ctx),policy=shopMoneySettings(store.settings);
  const before=ledger(store).length;
  const orders=[...(store.orders||[])].filter(o=>o.supplierId&&!o.reviewData&&o.commercialCommittedAt).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const first=new Map();
  for(const e of events(store).filter(e=>e.kind==='first_order'))first.set(e.supplierId,e.data.startedAt);
  for(const o of orders)if(!first.has(o.supplierId)) {first.set(o.supplierId,o.createdAt);append(store,{key:`first-order:${o.supplierId}`,supplierId:o.supplierId,kind:'first_order',data:{startedAt:o.createdAt}},c,true);}
  for(const order of orders) {
    // Unpaid reviewed rematches move entitlement to the new beneficiary; retain both journal facts.
    const priorShops=new Set(ledger(store).filter(e=>e.orderId===order.id&&e.supplierId!==order.supplierId).map(e=>e.supplierId));
    for(const supplierId of priorShops) {
      const previous=total(ledger(store).filter(e=>e.orderId===order.id&&e.supplierId===supplierId&&e.kind==='entitlement').map(e=>e.owedDeltaMinor));
      const paid=total(ledger(store).filter(e=>e.orderId===order.id&&e.supplierId===supplierId&&e.kind==='payout').map(e=>-e.owedDeltaMinor));
      if(previous>paid)append(store,{key:`rematched:${order.id}:${supplierId}:${ledger(store).length}`,supplierId,orderId:order.id,kind:'entitlement',owedDeltaMinor:paid-previous},c);
      const award=ledger(store).find(e=>e.key===`bonus-award:${order.id}:${supplierId}`);
      if(award&&!ledger(store).some(e=>e.key===`bonus-paid:${order.id}:${supplierId}`))append(store,{key:`bonus-void:${order.id}:${supplierId}`,supplierId,orderId:order.id,kind:'bonus_void',owedDeltaMinor:-award.owedDeltaMinor},c);
    }
    order.clientPayment??=clientPaymentSnapshot(order);
    if(!ledger(store).some(e=>e.key===`bonus-award:${order.id}:${order.supplierId}`)&&policy.launchedAt&&order.createdAt>=policy.launchedAt) {
      const used=total(ledger(store).filter(e=>e.supplierId===order.supplierId&&['bonus_award','bonus_void'].includes(e.kind)).map(e=>e.owedDeltaMinor));
      const eligible=Date.parse(order.createdAt)<Date.parse(first.get(order.supplierId))+policy.bonusDays*86400000;
      const principal=order.cash||order.clientPayment.methods.includes('counter_cash')?order.supplierSubtotalMinor||0:order.supplierPlatformPayoutMinor||0;
      const amountMinor=eligible?Math.min(Math.max(0,policy.bonusCapMinor-used),Number((BigInt(principal)*BigInt(policy.bonusRateBps)+5000n)/10000n)):0;
      append(store,{key:`bonus-award:${order.id}:${order.supplierId}`,supplierId:order.supplierId,orderId:order.id,kind:'bonus_award',owedDeltaMinor:amountMinor,at:order.createdAt,
        data:{amountMinor,firstOrderAt:first.get(order.supplierId),rateBps:policy.bonusRateBps,days:policy.bonusDays,capMinor:policy.bonusCapMinor,waiveCounterFee:eligible}},c);
    }
    const settlement=refundSettlementFor(store,order);
    // Paid stages retain their entitlement under a cancellation; recovery is a separate debt.
    const stageAmount=total((order.payoutMilestones||[]).filter(m=>m.status==='released'||(!settlement&&order.state!=='cancelled'&&m.status!=='superseded')).map(m=>m.amountMinor));
    const changes=total((store.orderChangePayments||[]).filter(p=>p.orderId===order.id&&(!settlement||changePayoutsFor(store,order).some(r=>r.changeId===p.changeId))).map(p=>p.principalMinor));
    const remainders=total((store.refundSupplierPayouts||[]).filter(p=>p.orderId===order.id&&p.status!=='superseded').map(p=>p.amountMinor));
    const desired=order.cash||order.clientPayment.methods.includes('counter_cash')?0:total([stageAmount,changes,remainders]);
    const prior=total(ledger(store).filter(e=>e.orderId===order.id&&e.supplierId===order.supplierId&&e.kind==='entitlement').map(e=>e.owedDeltaMinor));
    if(desired!==prior)append(store,{key:`entitlement:${order.id}:${order.supplierId}:${ledger(store).filter(e=>e.orderId===order.id&&e.supplierId===order.supplierId&&e.kind==='entitlement').length}`,supplierId:order.supplierId,orderId:order.id,kind:'entitlement',owedDeltaMinor:desired-prior,at:ledger(store).some(e=>e.orderId===order.id&&e.supplierId===order.supplierId&&e.kind==='entitlement')?c.at:order.commercialCommittedAt,data:{amountMinor:desired,clientPayment:order.clientPayment}},c);
    const bonus=ledger(store).find(e=>e.key===`bonus-award:${order.id}:${order.supplierId}`);
    if(bonus)order.shopLaunchBonus={amountMinor:bonus.data.amountMinor,firstOrderAt:bonus.data.firstOrderAt,days:bonus.data.days,rateBps:bonus.data.rateBps,capMinor:bonus.data.capMinor};
    if(bonus&&order.state==='cancelled'&&!ledger(store).some(e=>e.key===`bonus-paid:${order.id}:${order.supplierId}`))append(store,{key:`bonus-void:${order.id}:${order.supplierId}`,supplierId:order.supplierId,orderId:order.id,kind:'bonus_void',owedDeltaMinor:-bonus.owedDeltaMinor},c);
    for(const stage of order.payoutMilestones||[])if(stage.status==='released'&&!order.cash&&!order.clientPayment.methods.includes('counter_cash')) {
      const paid=(store.supplierVerificationLedger||[]).find(e=>e.kind==='released'&&e.payoutKey===`stage:${order.id}:${stage.code}`);
      append(store,{key:`paid:stage:${order.id}:${stage.code}`,supplierId:order.supplierId,orderId:order.id,kind:'payout',owedDeltaMinor:-stage.amountMinor,at:stage.releasedAt||c.at,data:{reference:stage.reference||null,transferredMinor:paid?.data.netAmountMinor??stage.amountMinor}},c);
    }
  }
  for(const [collection,prefix] of [['orderChangePayouts','change'],['refundSupplierPayouts','settlement']])for(const p of store[collection]||[]) {
    const order=orders.find(o=>o.id===p.orderId);if(!order||order.cash||p.status&&p.status!=='released')continue;
    const paid=(store.supplierVerificationLedger||[]).find(e=>e.kind==='released'&&e.payoutKey===(prefix==='change'?`change:${p.orderId}:${p.changeId}`:`settlement:${p.id}`));
    append(store,{key:`paid:${prefix}:${p.id}`,supplierId:p.supplierId,orderId:p.orderId,kind:'payout',owedDeltaMinor:-p.amountMinor,at:p.releasedAt||p.createdAt||c.at,data:{reference:p.reference,transferredMinor:paid?.data.netAmountMinor??p.amountMinor}},c);
  }
  for(const e of store.supplierVerificationLedger||[]) {
    if(!['recovery_due','recovered','released'].includes(e.kind))continue;
    if(e.kind==='released') {
      if(e.payoutKey.startsWith('bonus:'))append(store,{key:`bonus-paid:${e.orderId}:${e.supplierId}`,supplierId:e.supplierId,orderId:e.orderId,kind:'bonus_payout',owedDeltaMinor:-e.amountMinor,at:e.data.transferPaidAt||e.at,data:{reference:e.data.transferReference,transferredMinor:e.data.netAmountMinor}},c);
    } else append(store,{key:`verification:${e.id}`,supplierId:e.supplierId,orderId:e.orderId,kind:e.kind,at:e.at,owingDeltaMinor:e.kind==='recovery_due'?e.amountMinor:-e.amountMinor,data:{payoutKey:e.payoutKey}},c);
  }
  for(const request of events(store).filter(e=>e.kind==='pay_request'&&!payRequestClosed(store,e.id))) {
    if(verificationSummary(store,request.supplierId,c.at).recoveryDueMinor===0)append(store,{key:`pay-offset:${request.id}`,supplierId:request.supplierId,kind:'pay_offset',data:{requestId:request.id}},c,true);
  }
  return ledger(store).length!==before;
}
/** Incidental full saves must not initialize unrelated financial history. The
 * independent journal sweep handles backfill; actual money changes sync here. */
/** Cash the shop took at its counter: the shop keeps its price and owes GRIDGO's
 * share, recorded once per order. Used by staff and by the Express pickup PIN. */
export function recordCounterCash(store,order,{amountMinor,reason},ctx) {
  const c=context(ctx);
  const existing=events(store).find(e=>e.key===`counter:${order.id}`);if(existing)return existing;
  syncShopMoney(store,c);
  const award=ledger(store).find(e=>e.key===`bonus-award:${order.id}:${order.supplierId}`);
  const shareMinor=award?.data.waiveCounterFee?0:order.clientServiceFeeMinor??order.serviceFeeMinor;
  recordShopRecovery(store,order.supplierId,`counter:${order.id}`,shareMinor,c,{debt:true});
  const row=append(store,{key:`counter:${order.id}`,supplierId:order.supplierId,kind:'counter_cash',data:{orderId:order.id,amountMinor,shareMinor,reason}},c,true);
  syncShopMoney(store,c);
  return row;
}
export function shopMoneyChanged(store,before) {
  if(!before)return true;
  const financial=s=>({orders:(s.orders||[]).map(o=>({id:o.id,supplierId:o.supplierId,createdAt:o.createdAt,commercialCommittedAt:o.commercialCommittedAt,
    cancelled:o.state==='cancelled',supplierPlatformPayoutMinor:o.supplierPlatformPayoutMinor,
    milestones:(o.payoutMilestones||[]).map(m=>({code:m.code,amountMinor:m.amountMinor,status:m.status,releasedAt:m.releasedAt,reference:m.reference}))})),
    changes:s.orderChangePayments,payouts:s.orderChangePayouts,settlements:s.refundSettlements,remainders:s.refundSupplierPayouts,
    verification:(s.supplierVerificationLedger||[]).filter(e=>['released','recovery_due','recovered'].includes(e.kind))});
  return JSON.stringify(financial(store))!==JSON.stringify(financial(before));
}
export function shopMoneyBalances(store,supplierId,at=new Date().toISOString()) {
  const entries=ledger(store).filter(e=>e.supplierId===supplierId);
  const owedMinor=total(entries.map(e=>e.owedDeltaMinor)),owingMinor=total(entries.map(e=>e.owingDeltaMinor));
  return {owedMinor,owingMinor,netMinor:total([owedMinor,-owingMinor]),paidMinor:total(entries.filter(e=>['payout','bonus_payout'].includes(e.kind)).map(e=>e.data?.transferredMinor??-e.owedDeltaMinor)),
    overdue:shopMoneyPaused(store,supplierId,at),paused:shopMoneyPaused(store,supplierId,at),nextPayoutAt:nextShopPayout(store.settings,at)};
}
const finalCode=o=>o.payoutPlanVersion===4?'delivered':o.payoutPlanVersion===2?'issue_window':'retention';
const settlementPayoutHeld=(s,o)=>Boolean(o.payoutHold||(s.claims||[]).some(cl=>cl.orderId===o.id&&['open','payout_held'].includes(cl.status))
  ||(s.issues||[]).some(issue=>issue.orderId===o.id&&!['resolved','dismissed'].includes(issue.status))
  ||(s.refundRequests||[]).some(r=>r.orderId===o.id&&['requested','reviewed'].includes(r.status)));
/** A dry run uses the exact proof/collection/hold checks and sequential cap reservations. */
function prepareItems(store,supplierId,ctx,{dry=false,keys}={}) {
  const s=dry?structuredClone(store):store,c=context(ctx),items=[],held=[];
  const payoutStatus=supplierPayoutStatus(s,supplierId,c.at);
  if(payoutStatus.held)return {items,held:[{key:`supplier:${supplierId}`,reason:payoutStatus.reason}],netAmountMinor:0,grossAmountMinor:0};
  for(const o of s.orders||[]) {
    if(o.supplierId!==supplierId||o.reviewData||!o.commercialCommittedAt)continue;
    const externalPrincipal=o.cash||o.clientPayment?.methods.includes('counter_cash');
    for(const m of externalPrincipal?[]:o.payoutMilestones||[]) {
      const key=`stage:${o.id}:${m.code}`;
      if(m.status==='released'||m.status==='superseded'||keys&&!keys.includes(key))continue;
      if(verificationReservationsForOrder(s,o).some(e=>e.payoutKey===key)){held.push({key,reason:'transfer_pending'});continue;}
      const checked=structuredClone(o);
      for(const stage of checked.payoutMilestones)if(items.some(i=>i.key===`stage:${o.id}:${stage.code}`))stage.status='released';
      try {releaseMilestone(checked,m.code,{...c.actor,role:'ops_admin'},c.at,s);}catch(e){if(!e.code)throw e;held.push({key,reason:e.code});continue;}
      const lengths={ledger:(s.supplierVerificationLedger||[]).length,notifications:(s.notifications||[]).length,audit:(s.auditLog||[]).length,items:items.length};
      const p=prepareVerificationPayout(s,o,{key,amountMinor:m.amountMinor,...c});
      if(p.status==='held'){held.push({key,reason:p.reason});continue;}
      items.push({...p,orderId:o.id});
      if(m.code===finalCode(o)) {
        for(const extra of changePaymentsFor(s,o).filter(p=>!changePayoutsFor(s,o).some(r=>r.changeId===p.changeId))) {
          const q=prepareVerificationPayout(s,o,{key:`change:${o.id}:${extra.changeId}`,amountMinor:extra.principalMinor,...c,attemptId:p.attemptId,sharedAttempt:true});
          if(q.status==='held') {
            s.supplierVerificationLedger.splice(lengths.ledger);s.notifications.splice(lengths.notifications);s.auditLog.splice(lengths.audit);items.splice(lengths.items);
            held.push({key,reason:q.reason});break;
          }
          items.push({...q,orderId:o.id});
        }
      }
    }
    for(const remainder of s.refundSupplierPayouts||[]) {
      const key=`settlement:${remainder.id}`;
      if(externalPrincipal||remainder.orderId!==o.id||remainder.supplierId!==supplierId||remainder.status!=='pending'||keys&&!keys.includes(key))continue;
      if(verificationReservationsForOrder(s,o).some(e=>e.payoutKey===key)){held.push({key,reason:'transfer_pending'});continue;}
      if(settlementPayoutHeld(s,o)) {held.push({key,reason:'payout_held'});continue;}
      const p=prepareVerificationPayout(s,o,{key,amountMinor:remainder.amountMinor,...c});
      if(p.status==='held')held.push({key,reason:p.reason});else items.push({...p,orderId:o.id});
    }
    const award=ledger(s).find(e=>e.key===`bonus-award:${o.id}:${o.supplierId}`),key=`bonus:${o.id}:${o.supplierId}`;
    const terminal=refundSettlementFor(s,o);
    const fulfilled=terminal?.disposition==='fulfilled_with_refund'&&o.state==='completed'
      &&(o.payoutMilestones||[]).every(m=>['released','superseded'].includes(m.status))
      &&(s.refundSupplierPayouts||[]).filter(p=>p.orderId===o.id&&p.settlementId===terminal.id&&p.status!=='superseded')
        .every(p=>p.status==='released'||items.some(i=>i.key===`settlement:${p.id}`));
    const principalComplete=externalPrincipal?['delivered','issue_window_open','completed','payout_released'].includes(o.state)
      &&(o.cash?o.cashProgress?.collectedAt||o.cashProgress?.repaymentConfirmedAt:events(s).some(e=>e.key===`counter:${o.id}`))
      :fulfilled||(o.payoutMilestones||[]).every(m=>m.status==='released'||items.some(i=>i.key===`stage:${o.id}:${m.code}`));
    if(award?.owedDeltaMinor>0&&!ledger(s).some(e=>e.key===`bonus-void:${o.id}:${o.supplierId}`)&&o.state!=='cancelled'&&principalComplete
      &&!ledger(s).some(e=>e.key===`bonus-paid:${o.id}:${o.supplierId}`)&&(!keys||keys.includes(key))&&!verificationReservationsForOrder(s,o).some(e=>e.payoutKey===key)) {
      const stage=(o.payoutMilestones||[]).find(m=>m.code===finalCode(o));
      try {
        if(fulfilled) {if(settlementPayoutHeld(s,o))fail('payout_held');}
        else if(externalPrincipal) {if(activePayoutHold(s,o))fail('payout_held');}
        else {const copy=structuredClone(o);copy.payoutMilestones.find(m=>m.code===stage.code).status='pending';releaseMilestone(copy,stage.code,{...c.actor,role:'ops_admin'},c.at,s);}
      }catch(e){if(!e.code)throw e;held.push({key,reason:e.code});continue;}
      const p=prepareVerificationPayout(s,o,{key,amountMinor:award.owedDeltaMinor,...c});
      if(p.status==='held')held.push({key,reason:p.reason});else items.push({...p,orderId:o.id});
    }
  }
  return {items,held,netAmountMinor:total(items.map(i=>i.netAmountMinor)),grossAmountMinor:total(items.map(i=>i.amountMinor))};
}
export function runShopSettlement(store,ctx) {
  const c=context(ctx),p=shopMoneySettings(store.settings),clock=manilaClock(c.at),key=`run:${clock.date}`;
  const previous=events(store).find(e=>e.key===key);if(previous)return previous;
  if(clock.time<p.payoutTime||!businessDate(clock.date,p))return null;
  syncShopMoney(store,c);
  const shops=[];
  for(const supplierId of new Set((store.userRoleMemberships||[]).filter(m=>m.role==='supplier').map(m=>m.userId))) {
    const prepared=prepareItems(store,supplierId,c,{dry:true}),balances=shopMoneyBalances(store,supplierId,c.at);
    const available=prepared.netAmountMinor;
    const eligible=available>=p.minimumMinor||available===0&&prepared.items.some(i=>i.recoveryMinor>0);
    shops.push({supplierId,...balances,availableMinor:available,rolloverMinor:eligible?0:available,amountMinor:eligible?available:0,
      items:eligible?prepared.items.map(i=>({key:i.key,orderId:i.orderId,amountMinor:i.amountMinor,netAmountMinor:i.netAmountMinor})):[],held:prepared.held});
    if(shopMoneyPolicy(store,supplierId).counterCashEnabled&&balances.netMinor<0&&!events(store).some(e=>e.kind==='pay_request'&&e.supplierId===supplierId&&!payRequestClosed(store,e.id))) {
      append(store,{key:`pay:${clock.date}:${supplierId}`,supplierId,kind:'pay_request',data:{amountMinor:-balances.netMinor,reference:`GG-${c.id('pay').replace(/[^a-z0-9]/gi,'').slice(-24).toUpperCase()}`,
        deadlineAt:new Date(`${clock.date}T${p.payDeadline}:00+08:00`).toISOString()}},c,true);
    }
    if(balances.owedMinor||balances.owingMinor)notify(store,supplierId,'shop_money_settlement','Daily shop settlement','Your daily balances and payout status are ready in Money.',c);
  }
  return append(store,{key,kind:'settlement_run',data:{date:clock.date,minimumMinor:p.minimumMinor,payoutTime:p.payoutTime,shops}},c,true);
}
export function sweepShopMoney(store,ctx) {
  const c=context(ctx),before=events(store).length;
  const journalChanged=syncShopMoney(store,c);
  runShopSettlement(store,c);
  const clock=manilaClock(c.at),p=shopMoneySettings(store.settings);
  for(const request of events(store).filter(e=>e.kind==='pay_request'&&!payRequestClosed(store,e.id))) {
    for(const [kind,condition] of [['reminder',clock.time>=p.reminderTime&&request.at.slice(0,10)<=c.at.slice(0,10)],['paused',request.data.deadlineAt<=c.at]]) {
      const key=`${kind}:${request.id}`;
      if(condition&&!events(store).some(e=>e.key===key)) {
        append(store,{key,supplierId:request.supplierId,kind,data:{requestId:request.id}},c,true);
        notify(store,request.supplierId,`shop_money_${kind}`,kind==='paused'?'New orders paused':'Pay GRIDGO reminder',kind==='paused'?'Accepted jobs can finish. New orders reopen after your payment is confirmed.':'Open Money to pay the outstanding amount before the deadline.',c);
      }
    }
  }
  return journalChanged||events(store).length!==before;
}

/** Cheap lifecycle preflight; avoid loading the domain graph every tick. */
export async function shopMoneyWorkDue(database,at) {
  const settings=(await database.query('SELECT settings FROM platform_settings WHERE singleton')).rows[0]?.settings||{};
  const p=shopMoneySettings(settings),clock=manilaClock(at);
  if(clock.time>=p.payoutTime&&businessDate(clock.date,p)&&!(await database.query('SELECT 1 FROM shop_money_events WHERE event_key=$1',[`run:${clock.date}`])).rowCount)return true;
  if((await database.query(`SELECT 1 FROM shop_money_events r WHERE r.kind='pay_request'
    AND NOT EXISTS(SELECT 1 FROM shop_money_events c WHERE c.kind IN ('pay_confirmed','pay_offset') AND c.data->>'requestId'=r.id)
    AND (($2::boolean AND NOT EXISTS(SELECT 1 FROM shop_money_events m WHERE m.event_key='reminder:'||r.id))
      OR ((r.data->>'deadlineAt')::timestamptz<=$1::timestamptz AND NOT EXISTS(SELECT 1 FROM shop_money_events m WHERE m.event_key='paused:'||r.id))) LIMIT 1`,[at,clock.time>=p.reminderTime])).rowCount)return true;
  return (await database.query(`SELECT 1 FROM orders o WHERE o.supplier_id IS NOT NULL AND o.commercial_committed_at IS NOT NULL
    AND o.supplier_platform_payout_minor>0 AND NOT o.review_data AND o.state<>'cancelled'
    AND jsonb_typeof(o.data->'cash') IS DISTINCT FROM 'object' AND o.data->>'paymentMethod' IS DISTINCT FROM 'counter_cash'
    AND NOT EXISTS(SELECT 1 FROM order_removals r WHERE r.order_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM shop_money_ledger l WHERE l.order_id=o.id AND l.kind='entitlement') LIMIT 1`)).rowCount>0;
}

export async function routeShopMoney({req,url,store,user,readBody,now,id,database}) {
  const path=url.pathname;
  if(!path.startsWith('/ops/shop-money')&&path!=='/me/shop-money')return null;
  const superAdmin=identityHasMembership(user,'super_admin'),ops=superAdmin||identityHasMembership(user,'ops_admin'),mine=path==='/me/shop-money';
  if(mine?!identityHasMembership(user,'supplier')||['staff','manager'].includes(user?.shopRole):!ops)fail('forbidden',403);
  if(!mine&&ops&&!['ops_admin','super_admin'].includes(user.role))user=selectActorRole(store,user,superAdmin?'super_admin':'ops_admin');
  const c={at:now(),id,actor:user};
  if(req.method==='GET') {
    const supplierId=mine?user.id:/^\/ops\/shop-money\/shops\/([^/]+)$/.exec(path)?.[1];
    if(supplierId) {
      if(!(store.userRoleMemberships||[]).some(m=>m.userId===supplierId&&m.role==='supplier'))fail('supplier_not_found',404);
      const query=url.searchParams,period=query.get('period')||'month';
      if(!['week','month'].includes(period))fail('invalid_money_period',400);
      const from=query.get('from')||new Date(Date.parse(c.at)-(period==='week'?7:31)*86400000).toISOString();
      if(!Number.isFinite(Date.parse(from)))fail('invalid_money_period',400);
      const history=ledger(store).filter(e=>e.supplierId===supplierId&&e.at>=from&&(!query.get('kind')||e.kind===query.get('kind'))&&(!query.get('orderId')||e.orderId===query.get('orderId'))
        &&(!query.get('method')||(store.orders||[]).find(o=>o.id===e.orderId)?.clientPayment?.methods.includes(query.get('method'))));
      const jobs=(store.orders||[]).filter(o=>o.supplierId===supplierId&&!o.reviewData&&o.createdAt>=from).map(o=>({orderId:o.id,createdAt:o.createdAt,clientPayment:o.clientPayment||clientPaymentSnapshot(o),shopPayMinor:o.supplierPlatformPayoutMinor,bonus:o.shopLaunchBonus||null}));
      const days={};for(const e of history.filter(e=>['entitlement','bonus_award','bonus_void'].includes(e.kind))){const date=manilaClock(e.at).date;days[date]=total([days[date]||0,e.owedDeltaMinor]);}
      const methods={};for(const j of jobs)for(const method of j.clientPayment.methods)methods[method]=(methods[method]||0)+1;
      const pending=events(store).find(e=>e.kind==='pay_request'&&e.supplierId===supplierId&&!payRequestClosed(store,e.id));
      return {status:200,body:{balances:shopMoneyBalances(store,supplierId,c.at),policy:shopMoneyPolicy(store,supplierId),history,jobs,earningsByDay:days,paymentMethods:methods,
        payGridgo:pending?{requestId:pending.id,...pending.data,amountMinor:Math.min(pending.data.amountMinor,verificationSummary(store,supplierId,c.at).recoveryDueMinor),confirmation:'manual',qrImageUrl:store.settings.paymentQrFileId?`/public/payment-qr?v=${encodeURIComponent(store.settings.paymentQrFileId)}`:null}:null}};
    }
    if(path==='/ops/shop-money') {
      const all=events(store).filter(e=>e.kind==='transfer_reserved'),recent=new Set(all.slice(-100).map(e=>e.id));
      const transfers=all.map(e=>({...e,status:events(store).findLast(x=>x.data?.transferId===e.id)?.kind||'transfer_reserved'}))
        .filter(e=>recent.has(e.id)||!['transfer_paid','transfer_cancelled'].includes(e.status));
      const suppliers=new Set([...(store.userRoleMemberships||[]).filter(m=>m.role==='supplier').map(m=>m.userId),...ledger(store).map(e=>e.supplierId)]);
      return {status:200,body:{shops:[...suppliers].map(supplierId=>({supplierId,...shopMoneyBalances(store,supplierId,c.at)})),runs:events(store).filter(e=>e.kind==='settlement_run').slice(-31),transfers}};
    }
    return null;
  }
  if(req.method!=='POST'&&req.method!=='PATCH')return null;
  if(!ops)fail('forbidden',403);
  const body=await readBody(req);
  const counter=/^\/ops\/shop-money\/shops\/([^/]+)\/counter-cash$/.exec(path);
  if(counter&&req.method==='POST') {
    const o=(store.orders||[]).find(o=>o.id===body.orderId&&o.supplierId===counter[1]&&!o.reviewData);
    if(!shopMoneyPolicy(store,counter[1]).counterCashEnabled)fail('counter_cash_disabled');
    if(!o||!o.commercialCommittedAt||o.paymentMethod!=='counter_cash'||!o.clientPayment?.methods.includes('counter_cash'))fail('counter_cash_order_required');
    if(body.amountMinor!==o.totalMinor||body.cashReceivedConfirmed!==true||typeof body.reason!=='string'||!body.reason.trim())fail('counter_cash_confirmation_required',400);
    const existing=events(store).find(e=>e.key===`counter:${o.id}`);if(existing)return {status:200,body:{collection:existing,replayed:true}};
    return {status:200,body:{collection:recordCounterCash(store,o,{amountMinor:body.amountMinor,reason:body.reason},c)},mutated:true};
  }
  if(path==='/ops/shop-money/run'&&req.method==='POST')return {status:200,body:{run:runShopSettlement(store,c)},mutated:true};
  const policy=/^\/ops\/shop-money\/shops\/([^/]+)\/policy$/.exec(path);
  if(policy&&req.method==='PATCH') {
    if(!superAdmin)fail('forbidden',403);
    if(!(store.userRoleMemberships||[]).some(m=>m.userId===policy[1]&&m.role==='supplier'))fail('supplier_not_found',404);
    if(typeof body.counterCashEnabled!=='boolean'||(typeof body.reason!=='string'||!body.reason.trim()))fail('invalid_shop_money_policy',400);
    if(body.counterCashEnabled&&!supplierVerified(store,policy[1]))fail('cash_supplier_verification_required');
    if(body.expectedVersion!==events(store).filter(e=>e.supplierId===policy[1]&&e.kind==='policy').length)fail('shop_money_stale');
    if(body.counterCashEnabled&&!store.settings.paymentQrFileId)fail('payment_qr_required');
    const row=append(store,{key:`policy:${policy[1]}:${body.expectedVersion+1}`,supplierId:policy[1],kind:'policy',data:{counterCashEnabled:body.counterCashEnabled,reason:body.reason,version:body.expectedVersion+1}},c,true);
    notify(store,policy[1],'shop_money_policy','Shop payment policy updated','Your shop payment policy was updated. Open Money for the current policy.',c);
    return {status:200,body:{policy:row.data},mutated:true};
  }
  const prepare=/^\/ops\/shop-money\/runs\/([^/]+)\/shops\/([^/]+)\/prepare$/.exec(path);
  if(prepare&&req.method==='POST') {
    const run=events(store).find(e=>e.id===prepare[1]&&e.kind==='settlement_run'),row=run?.data.shops.find(s=>s.supplierId===prepare[2]);
    if(!row)fail('settlement_not_found',404);
    assertSupplierPayoutAllowed(store,row.supplierId,c.at);
    const key=`transfer:${run.id}:${row.supplierId}`,existing=events(store).find(e=>e.key===key);
    if(existing) {if(existing.data.payerId!==user.id)fail('verification_payer_required',403);return {status:200,body:{transfer:existing,status:events(store).findLast(e=>e.data?.transferId===existing.id)?.kind||'reserved'}};}
    const account=opsPayoutAccountProjection(store,row.supplierId);if(!account?.qr)fail('payout_qr_required');
    const transferId=id('money');
    if(database)await database.query("SELECT set_config('gridgo.shop_money_transfer',$1,true)",[transferId]);
    const prepared=prepareItems(store,row.supplierId,{...c,dailyTransferId:transferId},{keys:row.items.map(i=>i.key)});
    if(!prepared.items.length||prepared.netAmountMinor>0&&prepared.netAmountMinor<run.data.minimumMinor)fail('settlement_minimum_not_met');
    const transfer=append(store,{id:transferId,key,supplierId:row.supplierId,kind:'transfer_reserved',data:{...prepared,runId:run.id,payerId:user.id,payoutAccount:account}},c,true);
    notify(store,row.supplierId,'shop_money_prepared','Shop payout prepared','Your daily transfer is being processed. Open Money for its status.',c);
    return {status:200,body:{transfer},mutated:true};
  }
  const transferAction=/^\/ops\/shop-money\/transfers\/([^/]+)\/(confirm|unknown|cancel)$/.exec(path);
  if(transferAction&&req.method==='POST') {
    const transfer=events(store).find(e=>e.id===transferAction[1]&&e.kind==='transfer_reserved');if(!transfer)fail('transfer_not_found',404);
    if(transfer.data.payerId!==user.id&&user.role!=='super_admin')fail('verification_payer_required',403);
    c.dailyTransferId=transfer.id;
    if(database)await database.query("SELECT set_config('gridgo.shop_money_transfer',$1,true)",[transfer.id]);
    const action=transferAction[2],terminal=events(store).find(e=>['transfer_paid','transfer_cancelled'].includes(e.kind)&&e.data.transferId===transfer.id);
    if(action==='confirm')body.reference=body.amountMinor===0?null:typeof body.reference==='string'?body.reference.trim().toUpperCase():body.reference;
    if(terminal) {
      if(action==='confirm'&&terminal.kind==='transfer_paid'&&terminal.data.reference===body.reference&&terminal.data.amountMinor===body.amountMinor&&terminal.data.paidAt===body.paidAt)return {status:200,body:{transfer:terminal,replayed:true}};
      fail('transfer_reconciliation_required');
    }
    if((typeof body.reason!=='string'||!body.reason.trim()))fail('reason_required',400);
    if(action==='confirm') {
      if(body.amountMinor>0&&events(store).some(e=>e.kind==='transfer_paid'&&e.data.reference===body.reference))fail('payment_reference_conflict');
      if(body.amountMinor!==transfer.data.netAmountMinor||(body.amountMinor>0?body.fundsSentConfirmed!==true:body.offsetConfirmed!==true))fail('verification_net_payout_amount_required');
      const receipt=body.amountMinor>0?resolvePayoutReceipt(store,body.receiptFileId,user):null;
      if(body.amountMinor>0&&(!receipt||typeof body.reference!=='string'||!body.reference.trim()||body.reference.length>80))fail('verification_actual_transfer_evidence_required');
      if(typeof body.paidAt!=='string'||!Number.isFinite(Date.parse(body.paidAt))||Date.parse(body.paidAt)>Date.parse(c.at))fail('invalid_supplier_transfer_paid_at');
      for(const orderId of new Set(transfer.data.items.map(i=>i.orderId))) {
        const o=store.orders.find(o=>o.id===orderId),groups=new Map();
        for(const i of transfer.data.items.filter(i=>i.orderId===orderId)){if(!groups.has(i.attemptId))groups.set(i.attemptId,[]);groups.get(i.attemptId).push(i);}
        for(const [attemptId,items] of groups) {
          const amountMinor=total(items.map(i=>i.netAmountMinor));
          if(amountMinor>0)recordPreparedSupplierTransfer(store,o,{...c,payoutKey:items[0].key,attemptId,amountMinor,receipt,reference:body.reference,paidAt:body.paidAt,fundsSentConfirmed:true,reason:body.reason});
          else for(const item of items) {
            if(item.key.startsWith('bonus:')&&(refundSettlementFor(store,o)?.disposition==='fulfilled_with_refund'?settlementPayoutHeld(store,o):activePayoutHold(store,o)))fail('payout_held');
            if(item.key.startsWith('settlement:')&&(o.payoutHold||(store.claims||[]).some(cl=>cl.orderId===o.id&&['open','payout_held'].includes(cl.status))
              ||(store.issues||[]).some(issue=>issue.orderId===o.id&&!['resolved','dismissed'].includes(issue.status))
              ||(store.refundRequests||[]).some(r=>r.orderId===o.id&&['requested','reviewed'].includes(r.status))))fail('payout_held');
            const prepared=prepareVerificationPayout(store,o,{...c,key:item.key,amountMinor:item.amountMinor,attemptId,recording:true,reconciling:true});
            if(item.key.startsWith('stage:')){const m=o.payoutMilestones.find(m=>`stage:${o.id}:${m.code}`===item.key);releaseMilestone(o,m.code,user,c.at,store);}
            else if(item.key.startsWith(`change:${o.id}:`)) {
              const changeId=item.key.slice(`change:${o.id}:`.length);
              const payment=(store.orderChangePayments||[]).find(p=>p.orderId===o.id&&p.changeId===changeId);
              if(!payment||payment.principalMinor!==item.amountMinor)fail('verification_payout_changed');
              (store.orderChangePayouts||=[]).push({id:id('chgpayout'),orderId:o.id,changeId,supplierId:o.supplierId,amountMinor:item.amountMinor,
                reference:`verification-offset:${changeId}`,receiptFileId:null,releasedBy:user.id,createdAt:c.at});
            } else if(item.key.startsWith('settlement:')) {
              const remainder=(store.refundSupplierPayouts||[]).find(p=>`settlement:${p.id}`===item.key&&p.orderId===o.id&&p.supplierId===o.supplierId);
              if(!remainder||remainder.status!=='pending'||remainder.amountMinor!==item.amountMinor)fail('verification_payout_changed');
              Object.assign(remainder,{status:'released',reference:`verification-offset:${remainder.id}`,receiptFileId:null,releasedAt:c.at,releasedBy:user.id});
            } else if(!item.key.startsWith('bonus:'))fail('verification_payout_identity_mismatch');
            completeVerificationPayout(store,o,prepared,{...c,transferReference:null,transferAmountMinor:0});
            appendAudit(store,{actor:user,action:'shop_money.offset',entityType:'order',entityId:o.id,orderId:o.id,detail:{payoutKey:item.key,amountMinor:item.amountMinor}},c);
          }
        }
      }
      const paid=append(store,{key:`paid:${transfer.id}`,supplierId:transfer.supplierId,kind:'transfer_paid',data:{transferId:transfer.id,amountMinor:body.amountMinor,reference:body.reference,receiptFileId:receipt?.fileId||null,paidAt:body.paidAt,reason:body.reason}},c,true);
      syncShopMoney(store,c);notify(store,transfer.supplierId,'shop_money_paid','Shop payout recorded','Your daily transfer has been recorded. Open Money for its reference.',c);
      return {status:200,body:{transfer:paid},mutated:true};
    }
    if(action==='cancel'&&body.noFundsSentConfirmed!==true)fail('verification_reservation_confirmation_required',400);
    for(const i of transfer.data.items) {
      const o=store.orders.find(o=>o.id===i.orderId);
      (action==='cancel'?cancelVerificationReservation:markVerificationTransferUnknown)(store,o,i.key,{...c,attemptId:i.attemptId,reason:body.reason});
    }
    const row=append(store,{key:`${action}:${transfer.id}`,supplierId:transfer.supplierId,kind:action==='cancel'?'transfer_cancelled':'transfer_unknown',data:{transferId:transfer.id,reason:body.reason}},c,true);
    notify(store,transfer.supplierId,'shop_money_transfer_update','Shop payout update',action==='cancel'?'The team confirmed that this transfer was not sent. Your balance remains available for a later run.':'The team is reconciling this transfer. It must not be sent again until its outcome is known.',c);
    return {status:200,body:{transfer:row},mutated:true};
  }
  const payment=/^\/ops\/shop-money\/payments\/([^/]+)\/confirm$/.exec(path);
  if(payment&&req.method==='POST') {
    const request=events(store).find(e=>e.id===payment[1]&&e.kind==='pay_request');if(!request)fail('payment_request_not_found',404);
    if(!Number.isSafeInteger(body.amountMinor)||body.amountMinor<=0||typeof body.reason!=='string'||!body.reason.trim()||typeof body.reference!=='string'||!body.reference.trim()||body.reference.length>80)fail('invalid_shop_payment',400);
    const previous=events(store).find(e=>e.kind==='pay_confirmed'&&e.data.requestId===request.id);
    if(previous){if(previous.data.reference!==body.reference.trim().toUpperCase()||previous.data.amountMinor!==body.amountMinor)fail('payment_reference_conflict');return {status:200,body:{payment:previous,replayed:true}};}
    if(events(store).some(e=>e.kind==='pay_confirmed'&&e.data.reference===body.reference.trim().toUpperCase()))fail('payment_reference_conflict');
    const outstanding=verificationSummary(store,request.supplierId,c.at).recoveryDueMinor;
    if(body.amountMinor!==Math.min(request.data.amountMinor,outstanding))fail('payment_amount_changed');
    if((store.orders||[]).some(o=>o.supplierId===request.supplierId&&verificationReservationsForOrder(store,o).some(e=>e.data.recoveryMinor>0)))fail('verification_transfer_reconciliation_required');
    recordShopRecovery(store,request.supplierId,request.id,body.amountMinor,c);
    const row=append(store,{key:`pay-confirmed:${request.id}`,supplierId:request.supplierId,kind:'pay_confirmed',data:{requestId:request.id,amountMinor:body.amountMinor,reference:body.reference.trim().toUpperCase(),reason:body.reason}},c,true);
    syncShopMoney(store,c);notify(store,request.supplierId,'shop_money_reopened','Pay GRIDGO confirmed','Your payment was confirmed. Your shop can receive new orders under its current eligibility.',c);
    return {status:200,body:{payment:row},mutated:true};
  }
  return null;
}
