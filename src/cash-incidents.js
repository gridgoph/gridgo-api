import { cashAmounts, cashFail as fail } from './cash-policy.js';
import { postCash, releaseCash } from './cash-ledger.js';
import { restoreVoucherForRefund } from './vouchers.js';

export const cashIncidentOpen = order => order?.cashProgress?.incident?.status==='outstanding';
export const publicCashIncident = row => ({id:row.id,orderId:row.order_id,shopId:row.supplier_id,riderId:row.rider_id,
  amountMinor:row.amount_minor,resolvedMinor:row.resolved_minor,remainingMinor:row.amount_minor-row.resolved_minor,
  status:row.status,incidentVersion:row.version,createdAt:row.created_at});

/** Resolution types are independent of the incident/claim model; GRIDGO advances are deliberately unavailable. */
export async function manageCashIncident({db,store,order,user,body,action,at,id,bind}) {
  const p=order.cashProgress;
  if (action==='incident-open') {
    if (!p.shopPaidAt || p.collectedAt || p.repaymentConfirmedAt || p.noShowApprovedAt || p.incident
      || !['rider_assigned','picked_up','out_for_delivery'].includes(order.state)) fail('cash_incident_not_available');
    if (typeof body.reason!=='string' || !body.reason.trim() || body.reason.length>2000) fail('cash_incident_reason_required',400);
    const source=(await db.query("SELECT * FROM cash_journals WHERE order_id=$1 AND kind='shop_paid'",[order.id])).rows[0];
    const amount=cashAmounts(order).shopMinor;
    if (!source || source.evidence.amountMinor!==amount) fail('cash_shop_payment_reconciliation_required');
    const incidentId=id('cashincident'),photoFileId=bind(body.photoFileId,'cash_incident_photo');
    await db.query(`INSERT INTO cash_incidents(id,order_id,supplier_id,rider_id,source_payment_id,amount_minor,reason,evidence_file_id,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[incidentId,order.id,order.supplierId,source.rider_id,source.id,amount,body.reason.trim(),photoFileId,user.id,at]);
    await postCash(db,{key:`incident:${incidentId}`,kind:'cash_incident_opened',orderId:order.id,riderId:source.rider_id,actorId:user.id,
      entries:[[`rider_claim:${incidentId}`,amount],[`shop_return_obligation:${incidentId}`,-amount]],
      evidence:{incidentId,amountMinor:amount,photoFileId,sourcePaymentId:source.id}});
  } else {
    if (body.resolutionType!=='supplier_cash_return') fail('cash_resolution_not_enabled');
    const incident=(await db.query('SELECT * FROM cash_incidents WHERE order_id=$1 FOR UPDATE',[order.id])).rows[0];
    if (!incident || incident.status!=='outstanding') fail('cash_incident_not_outstanding');
    const remaining=incident.amount_minor-incident.resolved_minor,amount=body.amountMinor;
    if (!Number.isSafeInteger(amount) || amount<0 || amount>remaining || amount===0 && (remaining!==0 || body.noTransferRequired!==true)) fail('cash_return_amount_invalid',400);
    if (body.riderReceiptConfirmed!==true) fail('cash_counter_return_confirmation_required',400);
    const receiptFileId=bind(body.receiptFileId,'cash_shop_return',{id:incident.rider_id});
    const resolutionId=id('cashresolution');
    const journalId=await postCash(db,{key:`incident-resolution:${resolutionId}`,kind:'cash_incident_resolution',orderId:order.id,riderId:incident.rider_id,actorId:user.id,
      entries:[[`shop_cash:${incident.supplier_id}`,-amount],[`rider_cash:${incident.rider_id}`,amount],
        [`rider_claim:${incident.id}`,-amount],[`shop_return_obligation:${incident.id}`,amount]],
      evidence:{incidentId:incident.id,resolutionId,resolutionType:'supplier_cash_return',amountMinor:amount,receiptFileId,riderReceiptConfirmed:true}});
    await db.query(`INSERT INTO cash_incident_resolutions(id,incident_id,resolution_type,amount_minor,receipt_file_id,journal_id,actor_id,created_at,data)
      VALUES($1,$2,'supplier_cash_return',$3,$4,$5,$6,$7,$8)`,[resolutionId,incident.id,amount,receiptFileId,journalId,user.id,at,{riderReceiptConfirmed:true,noTransferRequired:amount===0}]);
  }
  const incident=(await db.query('SELECT * FROM cash_incidents WHERE order_id=$1',[order.id])).rows[0];
  p.incident=publicCashIncident(incident);
  if (incident.status==='resolved') {
    await releaseCash(db,order.id,{actorId:user.id});
    Object.assign(order,{state:'cancelled',cancelledAt:at,cancelledBy:user.id,cancellationReason:'Shop could not complete the order; the rider recovered the shop cash.',
      unpaidBalanceCancelled:true,paymentStatus:'cancelled_unpaid'});
    order.timeline.push({at,state:'cancelled',by:user.id,note:order.cancellationReason});
    restoreVoucherForRefund(store,order,{id,at,actorId:user.id,clientCaused:false,reason:order.cancellationReason});
  }
  return p.incident;
}
