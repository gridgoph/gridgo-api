import { homeSettings, homePrinterStatus, homeVerified } from './home-printers.js';
import { randomUUID } from 'node:crypto';
import { tierSignup, supplierOnboardingSettings } from './supplier-onboarding.js';
import { scheduledShopPayout } from './payout-plan.js';

const DAY = 86400000;
const CLOSED = new Set(['delivered','issue_window_open','completed','payout_released','cancelled']);
const fail = (code,status=409) => { throw Object.assign(new Error(code), {status,code}); };
const sum = values => {
  const result = values.reduce((n,value)=>n+BigInt(value || 0),0n);
  if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<0n)fail('invalid_money');
  return Number(result);
};
export function verificationSettings(settings) {
  return {payoutCapMinor:500000,windowDays:30,...settings?.supplierVerification};
}
export function validateVerificationSettings(settings) {
  const value=verificationSettings(settings);
  if(settings?.supplierVerification !== undefined && (!settings.supplierVerification || typeof settings.supplierVerification!=='object'
    || Array.isArray(settings.supplierVerification) || Object.keys(settings.supplierVerification).some(k=>!['payoutCapMinor','windowDays'].includes(k))))fail('invalid_supplier_verification_settings',400);
  if(!Number.isSafeInteger(value.payoutCapMinor)||value.payoutCapMinor<0||!Number.isSafeInteger(value.windowDays)||value.windowDays<1||value.windowDays>3650)fail('invalid_supplier_verification_settings',400);
  return value;
}
export function assertVerificationPolicyChange(store,next) {
  const cap=verificationSettings(next).payoutCapMinor;
  if(cap>=verificationSettings(store.settings).payoutCapMinor)return;
  for(const approval of store.approvalCases||[]) {
    if(approval.kind!=='supplier'||approval.status!=='pending')continue;
    const reserved=reservations(store,approval.userId);
    if(reserved.length&&sum([...paidEvents(store,approval.userId),...reserved].map(e=>e.data?.netAmountMinor??e.amountMinor))>cap)fail('verification_policy_reconciliation_required');
  }
}
export function supplierVerified(store,supplierId) {
  const home=store.supplierProfiles?.find(p=>p.userId===supplierId&&p.homePrinter);
  if(home)return homeVerified(store,home);
  return (store.approvalCases||[]).some(c=>c.userId===supplierId&&c.kind==='supplier'&&c.status==='approved');
}
/** Existing jobs survive the new-order deadline, closure and payout limits. */
export function supplierCanWork(store,supplierId) {
  const owner=store.users?.find(u=>u.id===supplierId);
  const approval=store.approvalCases?.find(c=>c.userId===supplierId&&c.kind==='supplier');
  return Boolean(owner && (owner.accountStatus??'active')==='active'
    && store.userRoleMemberships?.some(m=>m.userId===supplierId&&m.role==='supplier')
    && approval && ['pending','approved'].includes(approval.status));
}
const ledgerFor=(store,supplierId)=>(store.supplierVerificationLedger||[]).filter(e=>e.supplierId===supplierId);
function latest(store,key) {return (store.supplierVerificationLedger||[]).filter(e=>e.payoutKey===key).at(-1);}
function append(store,{supplierId,orderId=null,key,kind,amountMinor=0,data={}},{at,actor={role:'system'},id=()=>randomUUID()}) {
  store.supplierVerificationLedger||=[];store.auditLog||=[];
  const entry={id:id('svl'),supplierId,orderId,payoutKey:key,kind,amountMinor,at,actorId:(store.users||[]).some(u=>u.id===actor.id)?actor.id:null,data};
  store.supplierVerificationLedger.push(entry);
  if(['held','available','recovery_due','recovered','reserved','reservation_cancelled'].includes(kind)) {
    const recipients=[{userId:supplierId,role:'supplier'},...(store.userRoleMemberships||[]).filter(m=>['ops_admin','super_admin'].includes(m.role))];
    for(const recipient of recipients)(store.notifications||=[]).push({id:id('ntf'),userId:recipient.userId,appRole:recipient.role,at,
      type:'supplier_verification_update',partyUserId:supplierId,approvalCaseId:(store.approvalCases||[]).find(c=>c.userId===supplierId&&c.kind==='supplier')?.id,title:'Shop verification and payouts',
      body:kind==='reserved'?(data.transferState==='unknown'?'A supplier transfer needs reconciliation. Do not send it again.':'Operations prepared a payout. Open Money for its status.'):kind==='reservation_cancelled'?'An unsent payout preparation was cancelled. Open Money for its status.':kind==='held'?'A payout is waiting. Open Money for the verification requirement.':kind==='available'?'A verification payout hold was lifted. Operations will review the transfer.':kind==='recovery_due'?'New orders are paused while a paid-stage recovery is outstanding. Open Money or contact Operations.':'A recovery amount was applied to a payout.',read:false});
  }
  store.auditLog.push({id:id('aud'),at,actorId:(store.users||[]).some(u=>u.id===actor.id)?actor.id:null,actorRole:actor.role||'system',action:`supplier_verification.${kind}`,
    entityType:'user',entityId:supplierId,...(orderId?{orderId}:{}),detail:entry});
  return entry;
}
/** Shop-money counter receivables share the existing recovery reservation boundary. */
export function recordShopRecovery(store,supplierId,sourceId,amountMinor,ctx,{debt=false}={}) {
  const key=`shop-money:${debt?'due':'paid'}:${sourceId}`;
  if((store.supplierVerificationLedger||[]).some(e=>e.payoutKey===key))return;
  if(!Number.isSafeInteger(amountMinor)||amountMinor<0)fail('invalid_money');
  if(amountMinor===0)return;
  return append(store,{supplierId,key,kind:debt?'recovery_due':'recovered',amountMinor,data:{source:'shop_money'}},ctx);
}
function paidEvents(store,supplierId) {
  const recorded=new Map(ledgerFor(store,supplierId).filter(e=>e.kind==='released').map(e=>[e.payoutKey,e]));
  for(const o of store.orders||[]) {
    if(o.supplierId!==supplierId||o.cash||o.reviewData)continue;
    for(const stage of o.payoutMilestones||[])if(stage.status==='released') {
      const key=`stage:${o.id}:${stage.code}`;
      if(!recorded.has(key))recorded.set(key,{payoutKey:key,orderId:o.id,amountMinor:stage.amountMinor,at:stage.releasedAt,data:{netAmountMinor:stage.amountMinor}});
    }
  }
  for(const [collection,prefix] of [['refundSupplierPayouts','settlement'],['orderChangePayouts','change']])for(const p of store[collection]||[]) {
    if(store.orders?.find(o=>o.id===p.orderId)?.reviewData)continue;
    if(p.supplierId!==supplierId || (p.status && p.status!=='released') || store.orders?.find(o=>o.id===p.orderId)?.cash)continue;
    const key=prefix==='change'?`change:${p.orderId}:${p.changeId}`:`settlement:${p.id}`;
    if(!recorded.has(key))recorded.set(key,{payoutKey:key,orderId:p.orderId,amountMinor:p.amountMinor,at:p.releasedAt||p.createdAt,data:{netAmountMinor:p.amountMinor}});
  }
  return [...recorded.values()];
}
function reservations(store,supplierId) {
  return ledgerFor(store,supplierId).filter(e=>e.kind==='reserved' && latest(store,e.payoutKey)===e);
}
export function verificationSummary(store,supplierId,at=new Date().toISOString()) {
  const home=store.supplierProfiles?.find(p=>p.userId===supplierId&&p.homePrinter);
  const signup=(store.supplierSignups||[]).find(s=>s.supplierId===supplierId);
  const onboardingPaused=tierSignup(signup)&&(!signup.steps.finish||!supplierOnboardingSettings(store.settings).unverifiedShopsEnabled);
  const policy={...verificationSettings(store.settings),...(home?{windowDays:homeSettings(store.settings).verificationWindowDays}:{})},verified=supplierVerified(store,supplierId);
  const approval=store.approvalCases?.find(c=>c.userId===supplierId&&c.kind==='supplier');
  const membership=store.userRoleMemberships?.find(m=>m.userId===supplierId&&m.role==='supplier');
  const startedAt=home?.homePrinter.startedAt||membership?.createdAt||approval?.createdAt||store.users?.find(u=>u.id===supplierId)?.createdAt||null;
  const deadlineAt=startedAt&&Number.isFinite(Date.parse(startedAt))?new Date(Date.parse(startedAt)+policy.windowDays*DAY).toISOString():null;
  const daysLeft=deadlineAt?Math.max(0,Math.ceil((Date.parse(deadlineAt)-Date.parse(at))/DAY)):0;
  const ledger=ledgerFor(store,supplierId),events=paidEvents(store,supplierId);
  const paidBeforeVerificationMinor=sum(events.filter(e=>e.data?.beforeVerification===true
    || (e.data?.beforeVerification!==false&&(!verified||!approval.decidedAt||!e.at||Date.parse(e.at)<Date.parse(approval.decidedAt))))
    .map(e=>e.data?.netAmountMinor??e.amountMinor));
  const recoveryDueMinor=sum(ledger.filter(e=>e.kind==='recovery_due').map(e=>e.amountMinor))
    -sum(ledger.filter(e=>e.kind==='recovered').map(e=>e.amountMinor));
  const openJobs=new Set([...events,...reservations(store,supplierId)].map(e=>e.orderId).filter(orderId=>{
    const o=store.orders?.find(o=>o.id===orderId);
    return o && !o.cash && o.orderType!=='express' && !CLOSED.has(o.state);
  }));
  const held=ledger.filter(e=>e.kind==='held'&&latest(store,e.payoutKey)?.kind==='held');
  const documents=(store.files||[]).filter(f=>f.ownerId===supplierId&&f.purpose==='verification_document'&&f.state==='ready'
    &&!f.deleteRequestedAt&&!f.deletedAt&&f.references?.some(r=>r.type==='user'&&r.id===supplierId));
  return {verified,verificationState:verified?'verified':documents.length?'being_checked':'not_submitted',startedAt,deadlineAt,daysLeft,
    countdownDays:!verified&&daysLeft<=7?daysLeft:null,payoutCapMinor:policy.payoutCapMinor,paidBeforeVerificationMinor,
    capReached:!verified&&paidBeforeVerificationMinor>=policy.payoutCapMinor,
    remainingCapMinor:Math.max(0,policy.payoutCapMinor-paidBeforeVerificationMinor-sum(reservations(store,supplierId).map(e=>e.data.netAmountMinor))),
    heldMinor:sum(held.map(e=>e.amountMinor)),recoveryDueMinor,paidOpenRegularJobs:openJobs.size,
    newOrdersPaused:(home&&homePrinterStatus(store,home,at).newOrdersPaused)||!supplierCanWork(store,supplierId)||(!verified&&onboardingPaused)||(!verified&&recoveryDueMinor>0)||(!verified&&(!deadlineAt||Date.parse(at)>=Date.parse(deadlineAt)))};
}
export function assertVerifiedCashShop(store,supplierId) {if(!supplierVerified(store,supplierId))fail('cash_supplier_verification_required');}
/** New onboarding cannot use a historical cash protocol to bypass its cap. */
export function assertOnboardingCashShop(store,supplierId) {
  if(tierSignup((store.supplierSignups||[]).find(s=>s.supplierId===supplierId)))assertVerifiedCashShop(store,supplierId);
}
/** Reserve before a manual transfer. A retry returns the same frozen amount. */
function reservationData(entry) {
  return {...entry.data,attemptId:entry.data.attemptId||entry.id,payerId:entry.data.payerId??entry.actorId,
    requiresAttempt:entry.data.requiresAttempt??true};
}
function assertPayoutIdentity(entry,order) {
  if(entry.orderId!==order.id||entry.supplierId!==order.supplierId)fail('verification_payout_identity_mismatch');
}
function assertPayer(data,actor,recording=false,dailyTransferId) {
  if(data.dailyTransferId) {
    if(data.dailyTransferId!==dailyTransferId)fail('shop_money_transfer_route_required');
    data={...data,payerId:data.batchPayerId};
  }
  if(data.payerId!==(actor?.id||null) && !(recording&&actor?.role==='super_admin'))fail('verification_payer_required',403);
}
export function assertVerificationReplay(store,order,key,{attemptId,reference,amountMinor}={}) {
  const entry=latest(store,key);
  if(entry?.kind!=='released')return;
  assertPayoutIdentity(entry,order);
  if(entry.data.requiresAttempt && attemptId!==entry.data.attemptId)fail('verification_payout_attempt_required');
  if(Object.hasOwn(entry.data,'transferReference')&&(reference||null)!==entry.data.transferReference)fail('verification_transfer_reconciliation_required');
  if(amountMinor!==undefined&&entry.data.transferAmountMinor!==undefined&&amountMinor!==entry.data.transferAmountMinor)fail('verification_transfer_reconciliation_required');
}
export function prepareVerificationPayout(store,order,{key,amountMinor,at,actor,id,attemptId,recording=false,sharedAttempt=false,reconciling=false,dailyTransferId}) {
  if(!Number.isSafeInteger(amountMinor)||amountMinor<0)fail('invalid_money');
  if(order.cash&&!key.startsWith('bonus:')) {
    assertOnboardingCashShop(store,order.supplierId);
    return {status:'ready',key,amountMinor,netAmountMinor:amountMinor,recoveryMinor:0,exempt:true};
  }
  const previous=latest(store,key);
  if(previous&&['released','reserved'].includes(previous.kind))assertPayoutIdentity(previous,order);
  if(previous?.kind==='released')return {status:'released',key,...previous.data,amountMinor:previous.amountMinor};
  if(previous?.kind==='reserved') {
    if(previous.amountMinor!==amountMinor)fail('verification_payout_changed');
    const data=reservationData(previous);
    assertPayer(data,actor,recording,dailyTransferId);
    if((recording&&data.requiresAttempt || attemptId!==undefined)&&attemptId!==data.attemptId)fail('verification_payout_attempt_required');
    if(data.transferState==='unknown'&&!reconciling)fail('verification_transfer_unknown');
    return {status:'ready',key,amountMinor,...data};
  }
  if(attemptId && (!sharedAttempt || !reservations(store,order.supplierId).some(e=>e.orderId===order.id&&reservationData(e).attemptId===attemptId)))fail('verification_payout_attempt_required');
  const summary=verificationSummary(store,order.supplierId,at);
  const reservedRecovery=sum(reservations(store,order.supplierId).map(e=>e.data.recoveryMinor));
  const scheduled=scheduledShopPayout(store,order.supplierId,key);
  const availableRecovery=Math.max(0,summary.recoveryDueMinor-reservedRecovery);
  if(scheduled&&(scheduled.amountMinor!==amountMinor||scheduled.amountMinor-scheduled.netAmountMinor>availableRecovery))
    return {status:'held',key,amountMinor,reason:'scheduled_payout_reconciliation_required'};
  const recoveryMinor=scheduled?scheduled.amountMinor-scheduled.netAmountMinor:Math.min(amountMinor,availableRecovery);
  const netAmountMinor=amountMinor-recoveryMinor;
  const occupies=paidEvents(store,order.supplierId).some(e=>e.orderId===order.id)
    ||reservations(store,order.supplierId).some(e=>e.orderId===order.id);
  const signup=(store.supplierSignups||[]).find(s=>s.supplierId===order.supplierId);
  const reason=!summary.verified&&tierSignup(signup)&&(!signup.steps.finish||!supplierOnboardingSettings(store.settings).unverifiedShopsEnabled)?'supplier_verification_required'
    :!summary.verified && netAmountMinor>summary.remainingCapMinor?'verification_payout_cap'
    :!summary.verified&&order.orderType!=='express'&&!CLOSED.has(order.state)&&(summary.paidOpenRegularJobs>2||!occupies&&summary.paidOpenRegularJobs>=2)?'verification_open_jobs':null;
  const data={netAmountMinor,recoveryMinor,beforeVerification:!summary.verified,...(reason?{reason}:{})};
  if(reason) {
    if(previous?.kind!=='held')append(store,{supplierId:order.supplierId,orderId:order.id,key,kind:'held',amountMinor,data},{at,actor,id});
    return {status:'held',key,amountMinor,...data};
  }
  Object.assign(data,{attemptId:attemptId||id?.('sattempt')||randomUUID(),payerId:actor?.id||null,requiresAttempt:!recording,transferState:'in_progress'});
  // Historical runtimes compare payerId before returning an actionable amount.
  // This batch-only principal can never match an authenticated user identity.
  if(dailyTransferId)Object.assign(data,{dailyTransferId,batchPayerId:actor?.id||null,payerId:`daily-transfer:${dailyTransferId}`});
  append(store,{supplierId:order.supplierId,orderId:order.id,key,kind:'reserved',amountMinor,data},{at,actor,id});
  return {status:'ready',key,amountMinor,...data};
}
export function completeVerificationPayout(store,order,payout,ctx) {
  if(payout.exempt)return;
  const previous=latest(store,payout.key);
  if(previous?.kind==='released') {assertVerificationReplay(store,order,payout.key,{attemptId:payout.attemptId,reference:ctx.transferReference});return;}
  if(previous?.kind!=='reserved')fail('verification_reservation_not_pending');
  assertPayoutIdentity(previous,order);
  const data=reservationData(previous);assertPayer(data,ctx.actor,true,ctx.dailyTransferId);
  if(payout.attemptId!==data.attemptId||payout.amountMinor!==previous.amountMinor
    ||payout.netAmountMinor!==data.netAmountMinor||payout.recoveryMinor!==data.recoveryMinor)fail('verification_payout_attempt_required');
  if(payout.status!=='ready')fail('verification_payout_not_ready');
  if(payout.recoveryMinor)append(store,{supplierId:order.supplierId,orderId:order.id,key:`recovered:${payout.key}`,kind:'recovered',amountMinor:payout.recoveryMinor},ctx);
  const approval=(store.approvalCases||[]).find(c=>c.userId===order.supplierId&&c.kind==='supplier');
  append(store,{supplierId:order.supplierId,orderId:order.id,key:payout.key,kind:'released',amountMinor:payout.amountMinor,
    data:{...data,transferState:'paid',transferReference:ctx.transferReference||null,transferAmountMinor:ctx.transferAmountMinor??payout.netAmountMinor,
      ...(ctx.reconciled?{reconciled:true,transferReceiptFileId:ctx.receipt.fileId,transferPaidAt:ctx.paidAt}:{}),
      beforeVerification:!supplierVerified(store,order.supplierId)||Boolean(ctx.paidAt&&approval?.decidedAt&&Date.parse(ctx.paidAt)<Date.parse(approval.decidedAt))}},ctx);
}
export function recordVerificationRecovery(store,order,ctx) {
  if(order.cash||order.reviewData)return false;
  // Capture the policy at the fault, before money may be recorded or identity approved.
  // This zero-value fact is not debt and never changes eligibility by itself.
  if(!supplierVerified(store,order.supplierId)) {
    const key=`recovery-assessment:${order.id}:${order.supplierId}:${ctx.failureId||ctx.at}`;
    if(!ledgerFor(store,order.supplierId).some(e=>e.payoutKey===key))append(store,{
      supplierId:order.supplierId,orderId:order.id,key,kind:'recovery_assessment',
      data:{failedAt:ctx.at,failureId:ctx.failureId||null,unverifiedAtFault:true,
        paidKeys:paidEvents(store,order.supplierId).filter(e=>e.orderId===order.id).map(e=>e.payoutKey)}},ctx);
  }
  return reconcileVerificationRecovery(store,order,ctx);
}
/** Assess only pre-fault entitlements, including later-recorded gross offsets.
 * Compare to lifetime assessed debt, not its remaining (possibly collected) balance. */
export function reconcileVerificationRecovery(store,order,ctx) {
  if(order.cash||order.reviewData)return false;
  const ledger=(store.supplierVerificationLedger||[]).filter(e=>e.orderId===order.id);
  const suppliers=new Set(ledger.filter(e=>e.kind==='recovery_assessment'||e.kind==='recovery_due').map(e=>e.supplierId));
  let changed=false;
  for(const supplierId of suppliers) {
    const events=paidEvents(store,supplierId).filter(e=>e.orderId===order.id);
    const debts=ledger.filter(e=>e.supplierId===supplierId&&e.kind==='recovery_due');
    const assessments=ledger.filter(e=>e.supplierId===supplierId&&e.kind==='recovery_assessment'&&e.data.unverifiedAtFault)
      .map(e=>({id:e.id,failedAt:e.data.failedAt,paidKeys:e.data.paidKeys||[]}));
    // A legacy positive debt is immutable evidence that an eligible fault occurred.
    for(const debt of debts.filter(e=>!e.data.assessmentIds))assessments.push({id:debt.id,failedAt:debt.at,
      paidKeys:events.filter(e=>!e.at||Date.parse(e.at)<=Date.parse(debt.at)).map(e=>e.payoutKey)});
    const covered=events.filter(e=>assessments.some(a=>a.paidKeys.includes(e.payoutKey)
      ||Date.parse(e.data?.transferPaidAt||e.at)<=Date.parse(a.failedAt)));
    const paidMinor=sum(covered.map(e=>e.amountMinor)),assessedMinor=sum(debts.map(e=>e.amountMinor));
    if(paidMinor<=assessedMinor)continue;
    append(store,{supplierId,orderId:order.id,key:`recovery:${order.id}:${supplierId}:${paidMinor}`,kind:'recovery_due',amountMinor:paidMinor-assessedMinor,
      data:{assessmentIds:assessments.map(a=>a.id),paidEntitlementMinor:paidMinor,previouslyAssessedMinor:assessedMinor}},ctx);
    changed=true;
  }
  return changed;
}
export function reconcileVerificationHolds(store,ctx) {
  let changed=false;
  for(const entry of [...store.supplierVerificationLedger||[]]) {
    if(entry.kind!=='held'||latest(store,entry.payoutKey)!==entry)continue;
    const summary=verificationSummary(store,entry.supplierId,ctx.at);
    if(summary.verified || (entry.data.reason==='verification_open_jobs'&&summary.paidOpenRegularJobs<2)) {
      append(store,{supplierId:entry.supplierId,orderId:entry.orderId,key:entry.payoutKey,kind:'available',amountMinor:entry.amountMinor},ctx);changed=true;
    }
  }
  return changed;
}
export function remindSupplierVerification(store,{at,id}) {
  let changed=false;
  for(const member of store.userRoleMemberships||[]) {
    if(member.role!=='supplier')continue;
    const summary=verificationSummary(store,member.userId,at);
    if(summary.verified||!supplierCanWork(store,member.userId)||!summary.startedAt)continue;
    const day=Math.floor((Date.parse(at)-Date.parse(summary.startedAt))/DAY);
    if(day>=verificationSettings(store.settings).windowDays)continue;
    const reminderDay=[7,20,27].findLast(n=>n<=day);
    if(reminderDay===undefined)continue;
    const key=`reminder:${member.userId}:${reminderDay}`;
    if(ledgerFor(store,member.userId).some(e=>e.payoutKey===key))continue;
    append(store,{supplierId:member.userId,key,kind:'reminder',data:{day:reminderDay}},{at,id});
    const recipients=[{userId:member.userId,role:'supplier'},...(store.userRoleMemberships||[]).filter(m=>['ops_admin','super_admin'].includes(m.role))];
    for(const r of recipients)(store.notifications||=[]).push({id:id('ntf'),userId:r.userId,appRole:r.role,at,type:'supplier_verification_reminder',partyUserId:member.userId,approvalCaseId:(store.approvalCases||[]).find(c=>c.userId===member.userId&&c.kind==='supplier')?.id,
      title:'Complete shop verification',body:summary.countdownDays!==null?`Upload your verification documents. New orders pause in ${summary.countdownDays} day${summary.countdownDays===1?'':'s'} until verification.`:'Upload your ID with selfie and business permit to complete shop verification.',read:false});
    changed=true;
  }
  return changed;
}

/** Group within the existing distance bands after the strict factor sort.
 * This avoids a non-transitive comparator when quality wins across bands. */
export function rankVerifiedWithinDistance(rows) {
  const groups=new Map();
  rows.forEach((row,index)=>{const key=row.distanceZone?.key;if(key){if(!groups.has(key))groups.set(key,[]);groups.get(key).push(index);}});
  for(const positions of groups.values()) {
    const values=positions.map(index=>rows[index]).sort((a,b)=>Number(Boolean(b.verified))-Number(Boolean(a.verified)));
    positions.forEach((index,i)=>{rows[index]=values[i];});
  }
  return rows;
}

/** An abandoned manual preparation can be released only before any transfer. */
export function cancelVerificationReservation(store,order,key,ctx) {
  const previous=latest(store,key);
  if(previous?.kind==='reservation_cancelled')return;
  if(previous?.kind!=='reserved')fail('verification_reservation_not_pending');
  assertPayoutIdentity(previous,order);
  const data=reservationData(previous);assertPayer(data,ctx.actor,true,ctx.dailyTransferId);
  if(ctx.attemptId!==data.attemptId)fail('verification_payout_attempt_required');
  append(store,{supplierId:order.supplierId,orderId:order.id,key,kind:'reservation_cancelled',amountMinor:previous.amountMinor,
    data:{...data,reason:ctx.reason,transferState:'not_sent'}},ctx);
}

export function markVerificationTransferUnknown(store,order,key,ctx) {
  const previous=latest(store,key);
  if(previous?.kind!=='reserved')fail('verification_reservation_not_pending');
  assertPayoutIdentity(previous,order);
  const data=reservationData(previous);assertPayer(data,ctx.actor,true,ctx.dailyTransferId);
  if(ctx.attemptId!==data.attemptId)fail('verification_payout_attempt_required');
  if(data.transferState==='unknown')return;
  append(store,{supplierId:order.supplierId,orderId:order.id,key,kind:'reserved',amountMinor:previous.amountMinor,
    data:{...data,transferState:'unknown',reason:ctx.reason}},ctx);
}

export function hasVerificationReservation(store,order) {
  return (store.supplierVerificationLedger||[]).some(e=>e.orderId===order.id&&e.kind==='reserved'&&latest(store,e.payoutKey)===e);
}
export function verificationReservationsForOrder(store,order) {
  return (store.supplierVerificationLedger||[]).filter(e=>e.orderId===order.id&&e.kind==='reserved'&&latest(store,e.payoutKey)===e)
    .map(e=>({...e,data:reservationData(e)}));
}

export function hasSupplierTransferExposure(store,order) {
  return hasVerificationReservation(store,order)||(order.payoutMilestones||[]).some(s=>s.status==='released')
    ||(store.orderChangePayments||[]).some(p=>p.orderId===order.id&&p.amountMinor>0)
    ||(store.orderChangePayouts||[]).some(p=>p.orderId===order.id)
    ||(store.refundSupplierPayouts||[]).some(p=>p.orderId===order.id&&p.status==='released');
}
