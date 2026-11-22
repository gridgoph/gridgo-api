import {prepareVerificationPayout,completeVerificationPayout,verificationReservationsForOrder,assertVerificationReplay,reconcileVerificationRecovery} from './supplier-verification.js';
import {bindPayoutReceipt} from './payout-receipt.js';
import {privilegedAdminMemberships} from './notifications.js';
import {changesFor} from './order-change-policy.js';

const fail=code=>{throw Object.assign(new Error(code),{status:409,code});};
/** Records an already-sent frozen attempt; it never grants permission to transfer.
 * Work/payout holds stay in place. All items in a prepared transfer settle together. */
export function recordPreparedSupplierTransfer(store,order,ctx) {
  const {payoutKey,attemptId,actor,at,id,reference,receipt,amountMinor}=ctx;
  const active=verificationReservationsForOrder(store,order),entry=active.find(e=>e.payoutKey===payoutKey);
  if(!entry) {
    assertVerificationReplay(store,order,payoutKey,{attemptId,reference});
    const paid=(store.supplierVerificationLedger||[]).find(e=>e.payoutKey===payoutKey&&e.kind==='released');
    if(!paid||paid.data.attemptId!==attemptId||paid.data.transferAmountMinor!==amountMinor||paid.data.transferPaidAt!==ctx.paidAt)fail('verification_reservation_not_pending');
    reconcileVerificationRecovery(store,order,ctx);
    return {replayed:true};
  }
  if(!reference||!receipt||ctx.fundsSentConfirmed!==true)fail('verification_actual_transfer_evidence_required');
  if(typeof ctx.paidAt!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(ctx.paidAt)||!Number.isFinite(Date.parse(ctx.paidAt))||Date.parse(ctx.paidAt)>Date.parse(at))fail('invalid_supplier_transfer_paid_at');
  const entries=active.filter(e=>e.data.attemptId===entry.data.attemptId);
  const prepared=entries.map(e=>prepareVerificationPayout(store,order,{key:e.payoutKey,amountMinor:e.amountMinor,at,actor,id,attemptId,recording:true,reconciling:true}));
  const total=prepared.reduce((n,p)=>n+BigInt(p.netAmountMinor),0n);
  if(total<=0n||total!==BigInt(Number.isSafeInteger(amountMinor)?amountMinor:-1))fail('verification_net_payout_amount_required');
  const updates=[];
  for(const payout of prepared) {
    let row;
    if(payout.key.startsWith(`stage:${order.id}:`)) {
      row=order.payoutMilestones.find(m=>m.code===payout.key.slice(`stage:${order.id}:`.length));
      if(!row||row.status==='superseded'||row.amountMinor!==payout.amountMinor)fail('verification_payout_changed');
      if(row.status==='released'&&row.reference!==reference)fail('verification_transfer_reconciliation_required');
      if(row.status==='released')updates.push(()=>bindPayoutReceipt(order,{code:row.code},receipt));
      else updates.push(()=>{Object.assign(row,{status:'released',releasedAt:ctx.paidAt,releasedBy:actor.id,reference,
        transferReconciliation:{attemptId,reference,receiptFileId:receipt.fileId,amountMinor,fundsSentConfirmed:true}});bindPayoutReceipt(order,row,receipt);});
    } else if(payout.key.startsWith(`change:${order.id}:`)) {
      const changeId=payout.key.slice(`change:${order.id}:`.length);
      const payment=(store.orderChangePayments||[]).find(p=>p.orderId===order.id&&p.changeId===changeId);
      const request=changesFor(store,order).find(r=>r.id===changeId&&r.supplierId===order.supplierId);
      row=(store.orderChangePayouts||[]).find(p=>p.orderId===order.id&&p.changeId===changeId);
      if(!payment||!request||payment.principalMinor!==payout.amountMinor)fail('verification_payout_changed');
      if(row&&row.reference!==reference)fail('verification_transfer_reconciliation_required');
      if(!row)updates.push(()=>{store.orderChangePayouts.push({id:id('chgpayout'),orderId:order.id,changeId,supplierId:order.supplierId,amountMinor:payout.amountMinor,reference,receiptFileId:receipt.fileId,releasedBy:actor.id,createdAt:at});bindPayoutReceipt(order,{code:'change_settlement'},receipt);});
    } else if(payout.key.startsWith('settlement:')) {
      row=(store.refundSupplierPayouts||[]).find(p=>`settlement:${p.id}`===payout.key&&p.orderId===order.id&&p.supplierId===order.supplierId);
      if(!row||row.amountMinor!==payout.amountMinor||row.status==='superseded')fail('verification_payout_changed');
      if(row.status==='released'&&row.reference!==reference)fail('verification_transfer_reconciliation_required');
      if(row.status!=='released')updates.push(()=>Object.assign(row,{status:'released',reference,receiptFileId:receipt.fileId,releasedAt:ctx.paidAt,releasedBy:actor.id}));
      updates.push(()=>bindPayoutReceipt(order,{code:'refund_settlement'},receipt));
    } else if(payout.key===`bonus:${order.id}:${order.supplierId}`) {
      const award=(store.shopMoneyLedger||[]).find(e=>e.key===`bonus-award:${order.id}:${order.supplierId}`&&e.supplierId===order.supplierId);
      if(!award||award.owedDeltaMinor!==payout.amountMinor)fail('verification_payout_changed');
      updates.push(()=>bindPayoutReceipt(order,{code:'launch_bonus'},receipt));
    } else fail('verification_payout_identity_mismatch');
  }
  for(const update of updates)update();
  for(const payout of prepared)completeVerificationPayout(store,order,payout,{...ctx,reconciled:true,transferReference:reference,transferAmountMinor:amountMinor});
  reconcileVerificationRecovery(store,order,ctx);
  store.auditLog.push({id:id('aud'),at,actorId:actor.id,actorRole:actor.role,action:'supplier_transfer.reconcile_paid',entityType:'order',entityId:order.id,orderId:order.id,
    reason:ctx.reason,detail:{attemptId,payerId:entry.data.payerId,amountMinor,paidAt:ctx.paidAt,reference,receiptFileId:receipt.fileId,payoutKeys:prepared.map(p=>p.key)}});
  for(const recipient of [{userId:order.supplierId,role:'supplier'},...privilegedAdminMemberships(store)])store.notifications.push({id:id('ntf'),at,userId:recipient.userId,appRole:recipient.role,
    type:'supplier_transfer_reconciled',orderId:order.id,title:'Supplier transfer reconciled',body:'An already-sent supplier transfer was recorded with its evidence. Do not send it again.',read:false});
  order.updatedAt=at;
  return {replayed:false,amountMinor,attemptId};
}
