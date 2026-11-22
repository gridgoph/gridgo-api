import { listCashEvidence } from './cash-evidence.js';
import { randomUUID } from 'node:crypto';
import { cashAmounts, cashSettings, cashFail as fail } from './cash-policy.js';
import { cashFingerprint, cashWallet, postCash, reconcileCash, releaseCash } from './cash-ledger.js';
import { privilegedAdminMemberships, approvedRole, queueOrderInvalidate } from './notifications.js';
import { basketForOrder } from './baskets.js';
import { activeAcknowledgementHandover, issueAcknowledgement } from './acknowledgement-receipts.js';
import { deliverySplit, deliveryFeeForDistance, distanceMetersBetween } from './operational-model.js';
import { gridgoOfficePoint } from './gridgo-office.js';
import { assertRefundWorkAllowed } from './refund-policy.js';
import { claimBlocksHandover } from './shop-handover.js';
import { restoreVoucherForRefund } from './vouchers.js';
import { assertReviewMoneyAllowed } from './review-data.js';
import { manageCashIncident, cashIncidentOpen, publicCashIncident } from './cash-incidents.js';

const staff = user => ['ops_admin', 'super_admin'].includes(user?.role);
const text = value => { if (typeof value !== 'string' || !value.trim() || value.length > 120) fail('cash_reference_required',400); return value.trim().toUpperCase(); };
const owned = (store,user,fileId,purpose,target) => {
  const file = store.files.find(f => f.fileId === fileId && f.ownerId === user.id && f.state === 'ready' && f.purpose === purpose);
  if (!file || !['image/jpeg','image/png','image/webp'].includes(file.detectedContentType)) fail('cash_evidence_required',400);
  if (file.references?.length) fail('cash_evidence_already_bound');
  file.references ||= [];
  file.references.push({ type: 'cash', id: target.id, orderId: target.orderId ?? null, clientId: target.clientId ?? null,
    supplierId:target.supplierId??null,field: purpose });
  return file.fileId;
};
export async function cashRequest(db,req,user,body) {
  const key = req.headers?.['idempotency-key'];
  if (typeof key !== 'string' || !key.trim() || key.length > 120) fail('cash_idempotency_required',400);
  const fingerprint = cashFingerprint({ method: req.method, path: req.url, body });
  const previous = (await db.query('SELECT fingerprint,response FROM cash_requests WHERE actor_id=$1 AND request_key=$2',[user.id,key])).rows[0];
  if (previous) {
    if (previous.fingerprint !== fingerprint) fail('cash_idempotency_conflict');
    return { cached: previous.response };
  }
  return { finish: async response => {
    await db.query('INSERT INTO cash_requests(actor_id,request_key,fingerprint,response) VALUES($1,$2,$3,$4)',[user.id,key,fingerprint,response]);
    return response;
  } };
}
function notify(store,order,user,type,{id,at,audit},detail={}) {
  audit(store,{actor:user,action:`cash.${type}`,entityType:order?'order':'cash',entityId:order?.id ?? detail.id,orderId:order?.id,detail});
  const recipients = [...privilegedAdminMemberships(store), ...(order ? [{userId:order.clientId,role:'client'}, ...(order.riderId?[{userId:order.riderId,role:'rider'}]:[]),
    ...(type.startsWith('incident_') || type==='remedy_pay' && ['reprint','replacement'].includes(order.cashProgress?.remedy?.remedyType)?[{userId:order.supplierId,role:'supplier'}]:[])] : [{userId:detail.riderId,role:'rider'}])];
  for (const r of recipients) if (r.userId) store.notifications.push({id:id('ntf'),userId:r.userId,appRole:r.role,type:`cash_${type}`,orderId:order?.id,
    title:'Cash payment update',body:'Open GRIDGO to review the cash payment update.',at,read:false});
  if (order) queueOrderInvalidate(store,order,['orders','jobs','dispatch']);
}
export function cashProgress(order) { return order.cashProgress ||= { version:1 }; }
function clientRepayment(progress) {
  const rejected = progress.rejectedRepayments?.at(-1);
  const status = progress.repaymentConfirmedAt ? 'confirmed' : progress.repayment ? 'pending' : rejected ? 'rejected' : 'none';
  return {
    status,
    submittedAt: (status === 'rejected' ? rejected.submittedAt : progress.repayment?.submittedAt) ?? null,
    rejectedAt: status === 'rejected' ? rejected.at ?? null : null,
    rejectionReason: status === 'rejected' ? rejected.reason ?? null : null,
  };
}
function version(progress,body) { if (body.expectedVersion !== (progress.version || 1)) fail('cash_stale'); }
function checkRider(store,user,order) {
  if (user.role !== 'rider' || !approvedRole(store,user.id,'rider') || order.riderId !== user.id) fail('forbidden',403);
}
export function updateCashBasket(store,order) {
  const basket = basketForOrder(store,order.id);
  if (!basket || basket.payment.method !== 'cash') return;
  const orders = basket.orderIds.map(id => store.orders.find(o => o.id === id));
  basket.payment.status = orders.every(o=>o.state==='cancelled')?'cancelled':orders.every(o=>o.state==='cancelled' || o.payments.initial.status==='confirmed')
    ? orders.some(o=>o.state==='cancelled')?'partially_cancelled':'confirmed':'not_submitted';
}
/** Part of the existing delivery transaction, before the immutable AR/signature commit. */
export async function collectCash({db,store,order,user,body,at,id,audit}) {
  if (!order.cash) return;
  const p = cashProgress(order), amounts = cashAmounts(order);
  if (cashIncidentOpen(order)) fail('cash_incident_hold');
  if (p.noShowReportedAt || p.noShowApprovedAt || !p.shopPaidAt || p.collectedAt) fail('cash_collection_not_available');
  if (body.cashReceived !== true || body.amountReceivedMinor !== amounts.collectMinor) fail('cash_exact_collection_required',400);
  await postCash(db,{key:`collected:${order.id}`,kind:'cash_collected',orderId:order.id,riderId:user.id,actorId:user.id,
    entries:[[`client_cash:${order.clientId}`,-amounts.collectMinor],[`rider_cash:${user.id}`,amounts.collectMinor]],
    evidence:{amountMinor:amounts.collectMinor,deliveryFileId:body.evidenceFileId,signatureFileId:body.acknowledgementSignature?.fileId}});
  if (amounts.voucherMinor) await postCash(db,{key:`voucher:${order.id}`,kind:'voucher_funded',orderId:order.id,riderId:user.id,actorId:user.id,
    entries:[['voucher_expense',amounts.voucherMinor],[`wallet:${user.id}`,-amounts.voucherMinor]],evidence:{voucherId:order.voucher.id}});
  if (amounts.gridgoMinor) await releaseCash(db,order.id,{consume:true,actorId:user.id});
  Object.assign(order.payments.initial,{status:'confirmed',confirmedAt:at,confirmedBy:user.id,confirmationSource:'rider_cash',amountReceivedMinor:amounts.collectMinor,changeMinor:0});
  Object.assign(p,{collectedAt:at,version:(p.version||1)+1});
  order.paymentStatus='paid'; updateCashBasket(store,order);
  notify(store,order,user,'collected',{id,at,audit});
}

export async function settleCashRedelivery({db,store,order,user,at,id,audit}) {
  const leg=order.cashProgress?.redelivery;
  if (!leg?.paidAt || leg.deliveredAt || leg.riderId!==user.id) fail('cash_redelivery_not_available');
  await postCash(db,{key:`redelivery-settled:${leg.id}`,kind:'redelivery_settled',orderId:order.id,riderId:user.id,actorId:user.id,
    entries:[[`redelivery_due:${leg.id}`,leg.feeMinor],[`wallet:${user.id}`,-leg.riderPayoutMinor],['gridgo_revenue',-leg.platformDeliveryShareMinor]],
    evidence:{redeliveryId:leg.id,amountMinor:leg.feeMinor,deliveryFileId:order.deliveryEvidence?.fileId}});
  leg.deliveredAt=at;
  order.cashProgress.version++;
  notify(store,order,user,'redelivery_settled',{at,id,audit});
}

export async function routeCash({req,url,db,store,user,readBody,id,now,audit,storage}) {
  const walletPath = url.pathname === '/me/rider-wallet';
  const topupPath = url.pathname === '/me/rider-wallet/topups';
  const decision = /^\/ops\/cash\/topups\/([^/]+)\/(confirm|reject)$/.exec(url.pathname);
  const riderAction = /^\/dispatch\/([^/]+)\/cash\/(shop-payment|collect|no-show-start|no-show-report)$/.exec(url.pathname);
  const opsAction = /^\/ops\/cash\/orders\/([^/]+)\/(approve-no-show|reject-no-show|confirm-repayment|reject-repayment|confirm-redelivery|reject-redelivery|remedy-reserve|remedy-reconcile|remedy-pay|incident-open|incident-return|cancel-unpaid)$/.exec(url.pathname);
  const clientAction = /^\/orders\/([^/]+)\/cash\/(repayment|redelivery-quote|redelivery-payment|remedy-destination)$/.exec(url.pathname);
  const evidence = /^\/ops\/cash\/orders\/([^/]+)\/evidence$/.exec(url.pathname);
  const detail = /^\/orders\/([^/]+)\/cash$/.exec(url.pathname);
  const topupList = url.pathname === '/ops/cash/topups';
  const recon = url.pathname === '/ops/cash/reconciliation';
  const incidentList = url.pathname === '/ops/cash/incidents';
  if (!walletPath && !topupPath && !decision && !riderAction && !opsAction && !clientAction && !detail && !topupList && !recon && !incidentList && !evidence) return null;
  if (!user) fail('unauthorized',401);
  if ((decision || opsAction || topupList || recon || incidentList || evidence) && !staff(user)) fail('forbidden',403);
  if ((walletPath || topupPath) && (user.role !== 'rider' || !approvedRole(store,user.id,'rider'))) fail('forbidden',403);
  const targetId = (riderAction || opsAction || clientAction || detail || evidence)?.[1];
  const order = targetId && store.orders.find(o => o.id===targetId && o.cash);
  if (targetId && !order) fail('order_not_found',404);
  if (riderAction) checkRider(store,user,order);
  if (clientAction && (user.role!=='client' || order.clientId!==user.id)) fail('forbidden',403);
  if (detail && !staff(user) && !(user.role==='client' && order.clientId===user.id) && !(user.role==='rider' && order.riderId===user.id)) fail('forbidden',403);
  if (req.method==='GET') {
    if (evidence) return {status:200,body:await listCashEvidence({store,order,storage})};
    if (incidentList) {
      const status=url.searchParams.get('status');
      if (status && !['outstanding','resolved'].includes(status)) fail('cash_incident_status_invalid',400);
      return {status:200,body:{incidents:(await db.query('SELECT * FROM cash_incidents WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC,id DESC LIMIT 100',[status])).rows.map(r=>({...publicCashIncident(r),reason:r.reason,evidenceFileId:r.evidence_file_id}))}};
    }
    if (walletPath) return {status:200,body:{wallet:await cashWallet(db,user.id),incidents:(await db.query("SELECT * FROM cash_incidents WHERE rider_id=$1 AND status='outstanding' ORDER BY created_at DESC LIMIT 100",[user.id])).rows.map(publicCashIncident),activity:(await db.query(`SELECT j.*,
      COALESCE(sum(-e.amount_minor) FILTER(WHERE a.wallet AND a.rider_id=j.rider_id),0)::bigint AS balance_delta,
      COALESCE(sum(-e.amount_minor) FILTER(WHERE a.id='wallet:'||j.rider_id),0)::bigint AS available_delta
      FROM cash_journals j LEFT JOIN cash_entries e ON e.journal_id=j.id LEFT JOIN cash_accounts a ON a.id=e.account_id WHERE j.rider_id=$1
      AND j.kind IN('topup_pending','topup_confirmed','topup_rejected','wallet_reserved','wallet_released','gridgo_share_debited','shop_paid','cash_collected','no_show_returned','no_show_repaid','voucher_funded','redelivery_settled','cash_incident_opened','cash_incident_resolution')
      GROUP BY j.id ORDER BY j.sequence DESC LIMIT 100`,[user.id])).rows.map(j=>({id:j.id,type:j.kind,orderId:j.order_id,at:j.created_at,
        balanceDeltaMinor:j.balance_delta,availableDeltaMinor:j.available_delta,reservedDeltaMinor:j.balance_delta-j.available_delta,
        amountMinor:j.evidence.amountMinor??Math.abs(j.balance_delta||j.available_delta),...(j.kind.startsWith('topup_')?{reference:j.evidence.reference}:{})}))}};
    if (topupList) return {status:200,body:{topups:(await db.query(`SELECT j.*,d.kind AS decision FROM cash_journals j LEFT JOIN cash_journals d ON d.event_key='topup-decision:'||j.id WHERE j.kind='topup_pending' ORDER BY j.created_at DESC LIMIT 100`)).rows}};
    if (recon) return {status:200,body:await reconcileCash(db,{orderId:url.searchParams.get('orderId'),riderId:url.searchParams.get('riderId')})};
    if (detail) {
      const progress = cashProgress(order);
      return {status:200,body:{cash:{version:progress.version||1,status:order.paymentStatus,
        amountDueMinor:order.state==='cancelled' || order.payments.initial.status==='confirmed'?0:order.totalMinor,shopPaidAt:progress.shopPaidAt ?? null,collectedAt:progress.collectedAt ?? null,
        noShowApprovedAt:progress.noShowApprovedAt ?? null,repaymentConfirmedAt:progress.repaymentConfirmedAt ?? null,
        ...(user.role==='client'?{repayment:clientRepayment(progress)}:{}),
        ...(staff(user)?{progress}:{}),...((staff(user)||user.role==='rider')?{amounts:cashAmounts(order),
          noShowStartedAt:progress.noShowStartedAt ?? null,noShowReportedAt:progress.noShowReportedAt ?? null}:{}),
        ...(progress.redelivery?{redelivery:{id:progress.redelivery.id,feeMinor:progress.redelivery.feeMinor,paidAt:progress.redelivery.paidAt??null,deliveredAt:progress.redelivery.deliveredAt??null,invoice:progress.redelivery.invoice??null}}:{}),
        ...(user.role==='client'?{remedy:progress.remedy?{type:'cash_funded_advance',remedyType:progress.remedy.remedyType,status:progress.remedy.status,
          ...(['partial_refund','full_refund'].includes(progress.remedy.remedyType)?{amountMinor:progress.remedy.amountMinor}:{}),paidAt:progress.remedy.paidAt??null}:null}:{})}}};
    }
    fail('not_found',404);
  }
  if (req.method!=='POST' || evidence) fail('not_found',404);
  if (topupPath) assertReviewMoneyAllowed(user);
  if (order) assertReviewMoneyAllowed(order);
  const body = await readBody(req);
  if (!body || typeof body!=='object' || Array.isArray(body)) fail('invalid_request',400);
  const replay = await cashRequest(db,req,user,body);
  if (replay.cached) return replay.cached;
  const at=now(), ctx={at,id,audit};
  let response;
  if (topupPath) {
    if (cashSettings(store.settings).enabled!==true) fail('cash_disabled');
    if (![20000,50000,100000].includes(body.amountMinor)) fail('cash_topup_amount_invalid',400);
    const reference=text(body.reference), eventKey=`topup:${randomUUID()}`;
    const screenshotFileId=body.screenshotFileId?owned(store,user,body.screenshotFileId,'cash_topup_proof',{id:eventKey}):null;
    const topupId=await postCash(db,{key:eventKey,kind:'topup_pending',riderId:user.id,actorId:user.id,
      entries:[[`pending_bank:${user.id}`,body.amountMinor],[`pending_topup:${user.id}`,-body.amountMinor]],
      evidence:{reference,amountMinor:body.amountMinor,screenshotFileId}});
    notify(store,null,user,'topup_pending',ctx,{id:topupId,riderId:user.id});
    response={status:201,body:{topup:{id:topupId,status:'pending',amountMinor:body.amountMinor,reference}}};
  } else if (decision) {
    const topup=(await db.query("SELECT * FROM cash_journals WHERE id=$1 AND kind='topup_pending'",[decision[1]])).rows[0];
    if (!topup) fail('cash_topup_not_found',404);
    if ((await db.query('SELECT 1 FROM cash_journals WHERE event_key=$1',[`topup-decision:${topup.id}`])).rowCount) fail('cash_topup_already_decided');
    const amount=topup.evidence.amountMinor, confirmed=decision[2]==='confirm';
    const reason=text(body.reason);
    if (confirmed && (await db.query("SELECT 1 FROM cash_journals WHERE kind='topup_confirmed' AND evidence->>'reference'=$1",[topup.evidence.reference])).rowCount) fail('cash_transfer_duplicate');
    await postCash(db,{key:`topup-decision:${topup.id}`,kind:confirmed?'topup_confirmed':'topup_rejected',riderId:topup.rider_id,actorId:user.id,
      entries:[[`pending_bank:${topup.rider_id}`,-amount],[`pending_topup:${topup.rider_id}`,amount],
        ...(confirmed?[['gridgo_bank',amount],[`wallet:${topup.rider_id}`,-amount]]:[])],
      evidence:{topupId:topup.id,reference:topup.evidence.reference,amountMinor:amount,reason}});
    const screenshot=store.files.find(f=>f.fileId===topup.evidence.screenshotFileId);
    for (const ref of screenshot?.references||[]) if (ref.type==='cash' && ref.id===topup.event_key) ref.closedAt=at;
    notify(store,null,user,confirmed?'topup_confirmed':'topup_rejected',ctx,{id:topup.id,riderId:topup.rider_id});
    response={status:200,body:{topup:{id:topup.id,status:confirmed?'confirmed':'rejected'}}};
  } else if (order) {
    const p=cashProgress(order), amounts=cashAmounts(order), action=(riderAction||opsAction||clientAction)[2];
    let receipt,incident;
    version(p,body);
    if (cashIncidentOpen(order) && !action.startsWith('incident-')) fail('cash_incident_hold');
    const bind=(fileId,purpose,owner=user)=>owned(store,owner,fileId,purpose,{id:`${order.id}:${action}`,orderId:order.id,clientId:order.clientId,
      ...(['cash_shop_receipt','cash_shop_return'].includes(purpose)?{supplierId:order.supplierId}:{})});
    const event=(kind,entries,evidence,key=kind)=>postCash(db,{key:`${key}:${order.id}`,kind,orderId:order.id,riderId:order.riderId,actorId:user.id,entries,evidence});
    if (action==='cancel-unpaid') {
      if (p.shopPaidAt || p.collectedAt || p.noShowApprovedAt || order.state==='cancelled' || !['supplier_failure','artwork_unproducible'].includes(body.reasonCode)
        || body.noCashAdvancedConfirmed!==true || body.shopObligationMinor!==0) fail('cash_unpaid_cancellation_not_available');
      const photoFileId=bind(body.photoFileId,'cash_incident_photo',order.riderId?{id:order.riderId}:user);
      await releaseCash(db,order.id,{actorId:user.id});
      p.unpaidCancellation={at,reasonCode:body.reasonCode,photoFileId,noCashAdvancedConfirmed:true,shopObligationMinor:0};
      Object.assign(order,{state:'cancelled',cancelledAt:at,cancelledBy:user.id,cancellationReason:'The order could not be produced. No cash was advanced or collected.',paymentStatus:'cancelled_unpaid',unpaidBalanceCancelled:true});
      for(const stage of order.payoutMilestones) if(stage.status!=='released') stage.status='superseded';
      order.timeline.push({at,state:'cancelled',by:user.id,note:order.cancellationReason});
      restoreVoucherForRefund(store,order,{id,at,actorId:user.id,clientCaused:false,reason:order.cancellationReason});
      updateCashBasket(store,order);
    } else if (action.startsWith('incident-')) {
      incident=await manageCashIncident({db,store,order,user,body,action,at,id,bind});
      updateCashBasket(store,order);
    } else if (action==='collect') {
      assertRefundWorkAllowed(store,order);
      if (claimBlocksHandover(store,order)) fail('cash_work_held');
      if (!activeAcknowledgementHandover(order,user)) fail('cash_arrival_required');
      if (!store.files.some(f=>f.fileId===body.evidenceFileId && f.ownerId===user.id && f.purpose==='delivery_photo' && f.state==='ready'
        && f.references?.some(r=>r.type==='order' && r.id===order.id))) fail('cash_evidence_required',400);
      await collectCash({db,store,order,user,body,at,id,audit});
      ({receipt}=await issueAcknowledgement({database:db,store,order,user,now:()=>at,id,audit}));
    } else if (action==='shop-payment') {
      assertRefundWorkAllowed(store,order);
      if (claimBlocksHandover(store,order)) fail('cash_work_held');
      if (order.state!=='rider_assigned' || p.shopPaidAt || p.noShowApprovedAt) fail('cash_shop_payment_not_available');
      if (body.amountMinor!==amounts.shopMinor) fail('cash_exact_shop_payment_required',400);
      const receiptFileId=bind(body.receiptFileId,'cash_shop_receipt');
      await event('shop_paid',[[`rider_cash:${user.id}`,-amounts.shopMinor],[`shop_cash:${order.supplierId}`,amounts.shopMinor]],{receiptFileId,amountMinor:amounts.shopMinor});
      Object.assign(p,{shopPaidAt:at,shopReceiptFileId:receiptFileId});
      Object.assign(order.payoutMilestones[0],{status:'released',releasedAt:at,releasedBy:user.id,receiptFileId,pofFileIds:[receiptFileId],cashPaid:true});
    } else if (action==='no-show-start') {
      if (!['picked_up','out_for_delivery'].includes(order.state) || p.noShowStartedAt || p.collectedAt || !p.shopPaidAt) fail('cash_no_show_not_available');
      if (!['call','message'].includes(body.contactMethod)) fail('cash_contact_required',400);
      if (!order.riderProgress?.events?.arrived) fail('cash_arrival_required');
      Object.assign(p,{noShowStartedAt:at,contactMethod:body.contactMethod});
    } else if (action==='no-show-report') {
      if (!p.noShowStartedAt || p.noShowReportedAt || p.collectedAt || p.noShowApprovedAt) fail('cash_no_show_not_available');
      if (Date.parse(at)<Date.parse(p.noShowStartedAt)+order.cash.noShowWaitSeconds*1000) fail('cash_wait_not_elapsed');
      Object.assign(p,{noShowReportedAt:at,noShowPhotoFileId:bind(body.photoFileId,'cash_no_show_photo'),noShowReason:text(body.reason)});
    } else if (action==='approve-no-show') {
      if (!p.noShowReportedAt || p.noShowApprovedAt || p.collectedAt) fail('cash_no_show_not_pending');
      const returnFileId=bind(body.returnPhotoFileId,'cash_return_photo');
      await event('no_show_returned',[[`client_receivable:${order.id}`,amounts.shopMinor],[`wallet:${order.riderId}`,-amounts.shopMinor]],{returnFileId,photoFileId:p.noShowPhotoFileId,amountMinor:amounts.shopMinor,reason:text(body.reason)});
      await releaseCash(db,order.id,{actorId:user.id});
      Object.assign(p,{noShowApprovedAt:at,noShowRiderId:order.riderId,returnFileId}); order.state='awaiting_collection'; order.paymentStatus='cash_debt';
    } else if (action==='reject-no-show') {
      if (!p.noShowReportedAt || p.noShowApprovedAt) fail('cash_no_show_not_pending');
      (p.rejectedReports ||= []).push({at,reason:text(body.reason),photoFileId:p.noShowPhotoFileId});
      for (const key of ['noShowReportedAt','noShowStartedAt','noShowPhotoFileId']) delete p[key];
    } else if (action==='repayment') {
      if (!p.noShowApprovedAt || p.repayment || p.repaymentConfirmedAt) fail('cash_repayment_not_available');
      if (body.amountMinor!==order.totalMinor) fail('cash_exact_repayment_required',400);
      p.repayment={reference:text(body.reference),proofFileId:bind(body.proofFileId,'cash_repayment_proof'),submittedAt:at};
    } else if (action==='confirm-repayment') {
      if (!p.noShowApprovedAt || !p.repayment || p.repaymentConfirmedAt) fail('cash_repayment_not_pending');
      if ((await db.query("SELECT 1 FROM cash_journals WHERE kind='no_show_repaid' AND evidence->>'reference'=$1",[p.repayment.reference])).rowCount) fail('cash_transfer_duplicate');
      await event('no_show_repaid',[['gridgo_bank',amounts.collectMinor],[`client_receivable:${order.id}`,-amounts.shopMinor],
        ['gridgo_revenue',-amounts.gridgoMinor],[`wallet:${order.riderId}`,-amounts.riderMinor],...(amounts.voucherMinor?[['voucher_expense',amounts.voucherMinor]]:[])],p.repayment);
      p.repaymentConfirmedAt=at;
      // The original sale remains a cash sale; repayment is a separate online movement.
      Object.assign(order.payments.initial,{status:'confirmed',confirmedAt:at,confirmationSource:'no_show_online_repayment'});
      order.paymentStatus='paid'; updateCashBasket(store,order);
    } else if (action==='reject-repayment') {
      if (!p.repayment || p.repaymentConfirmedAt) fail('cash_repayment_not_pending');
      (p.rejectedRepayments ||= []).push({...p.repayment,reason:text(body.reason),at});
      delete p.repayment;
    } else if (action==='redelivery-quote') {
      if (!p.repaymentConfirmedAt || order.state!=='awaiting_collection' || p.redelivery?.payment) fail('cash_redelivery_not_available');
      const pickup=gridgoOfficePoint(), distanceMeters=distanceMetersBetween(pickup,order.dropoff);
      const feeMinor=deliveryFeeForDistance(distanceMeters,store.settings);
      p.redelivery={id:id('redelivery'),pickup,dropoff:structuredClone(order.dropoff),distanceMeters,feeMinor,
        ...deliverySplit(feeMinor,store.settings.riderCommissionBps??8000),quotedAt:at,expiresAt:new Date(Date.parse(at)+15*60000).toISOString()};
    } else if (action==='redelivery-payment') {
      const leg=p.redelivery;
      if (!leg || leg.id!==body.redeliveryId || leg.payment || Date.parse(at)>=Date.parse(leg.expiresAt)) fail('cash_redelivery_quote_stale');
      if (body.acceptCost!==true || body.amountMinor!==leg.feeMinor) fail('cash_redelivery_cost_confirmation_required',400);
      leg.payment=leg.feeMinor ? {reference:text(body.reference),proofFileId:bind(body.proofFileId,'cash_repayment_proof'),submittedAt:at}
        : {reference:null,proofFileId:null,submittedAt:at,noTransferRequired:true};
    } else if (action==='reject-redelivery') {
      const leg=p.redelivery;
      if (!leg?.payment || leg.paidAt) fail('cash_redelivery_payment_not_pending');
      (p.rejectedRedeliveryPayments ||= []).push({...structuredClone(leg.payment),redeliveryId:leg.id,reason:text(body.reason),at});
      delete leg.payment;
    } else if (action==='confirm-redelivery') {
      const leg=p.redelivery;
      if (!leg?.payment || leg.paidAt || !p.repaymentConfirmedAt) fail('cash_redelivery_payment_not_pending');
      await event('redelivery_paid',[['gridgo_bank',leg.feeMinor],[`redelivery_due:${leg.id}`,-leg.feeMinor]],
        {...leg.payment,redeliveryId:leg.id,amountMinor:leg.feeMinor,terms:structuredClone(leg)},`redelivery-paid:${leg.id}`);
      leg.paidAt=at;
      leg.invoice={number:`${order.invoiceNumber||order.id}-RD-${leg.id}`,type:'redelivery',totalMinor:leg.feeMinor,currency:'PHP',issuedAt:at};
      leg.previousPickup=structuredClone(order.pickupChecklist||null);
      leg.previousOffer=structuredClone(order.dispatchOffer||null);
      order.state='ready_for_dispatch';order.riderId=null;
      delete order.dispatchOffer;delete order.dispatchOfferAttempts;delete order.riderProgress;
    } else if (action==='remedy-destination') {
      if (p.remedy && ['reserved','unknown','paid'].includes(p.remedy.status)) fail('cash_remedy_destination_locked');
      if (body.ownershipConfirmed!==true || typeof body.accountName!=='string' || !body.accountName.trim() || body.accountName.length>120) fail('cash_destination_invalid',400);
      p.remedyDestination={qrFileId:bind(body.qrFileId,'cash_remedy_qr'),accountName:body.accountName.trim(),revision:(p.remedyDestination?.revision||0)+1};
    } else if (action==='remedy-reserve') {
      const issue=store.issues.find(i=>i.id===body.issueId && i.orderId===order.id);
      const d=issue?.faultDecision, refund=['partial_refund','full_refund'].includes(d?.remedy);
      if (!d || d.id!==body.decisionId || d.status!=='approved' || !['partial_refund','full_refund','reprint','replacement'].includes(d.remedy)
        || !['shop','rider','gridgo'].includes(d.fault) || !d.evidenceIds?.length
        || !Number.isSafeInteger(d.gridgoCostMinor) || d.gridgoCostMinor<0 || d.gridgoCostMinor>d.costMinor
        || (d.gridgoCostMinor>100000 && !d.approvedBy)) fail('cash_funded_remedy_not_authorized');
      const supplierAccount=store.supplierPayoutAccounts?.find(a=>a.supplierId===order.supplierId);
      const destination=refund?p.remedyDestination:supplierAccount;
      if (!(p.collectedAt||p.repaymentConfirmedAt) || !destination || body.destinationVerified!==true
        || (refund?body.destinationRevision!==destination.revision:body.supplierDestinationVersion!==destination.version)) fail('cash_remedy_destination_verification_required');
      if (!refund && (d.gridgoCostMinor!==d.costMinor || !store.files.some(f=>f.fileId===destination.qrFileId && f.ownerId===order.supplierId && f.purpose==='supplier_payout_qr' && f.state==='ready'))) fail('cash_funded_remedy_not_authorized');
      if (p.remedy && ['reserved','unknown'].includes(p.remedy.status)) fail('cash_remedy_payer_reserved');
      if ((await db.query("SELECT 1 FROM cash_journals WHERE order_id=$1 AND kind='remedy_paid' AND evidence->>'decisionId'=$2",[order.id,d.id])).rowCount) fail('cash_remedy_already_paid');
      const paid=Number((await db.query("SELECT COALESCE(sum((evidence->>'amountMinor')::numeric),0)::text AS total FROM cash_journals WHERE order_id=$1 AND kind='remedy_paid' AND evidence->>'remedyType' IN('partial_refund','full_refund')",[order.id])).rows[0].total);
      if (!Number.isSafeInteger(d.costMinor) || d.costMinor<=0 || refund && d.costMinor>order.totalMinor-paid) fail('cash_remedy_exceeds_collection');
      const earlierFee=Number((await db.query("SELECT COALESCE(sum((evidence->>'heldFeeMinor')::numeric),0)::text AS total FROM cash_journals WHERE order_id=$1 AND kind='remedy_paid'",[order.id])).rows[0].total);
      const heldFeeMinor=d.costMinor-d.gridgoCostMinor;
      if (heldFeeMinor>Math.max(0,order.serviceFeeMinor-(order.voucherServiceFeeMinor||0)+(amounts.productionDeductionMinor||0)-earlierFee)) fail('cash_remedy_funding_shortfall');
      if (p.remedy) (p.remedyAttempts ||= []).push(structuredClone(p.remedy));
      p.remedy={id:id('cashremedy'),decisionId:d.id,issueId:issue.id,remedyType:d.remedy,status:'reserved',payerId:user.id,amountMinor:d.costMinor,
        advanceMinor:d.gridgoCostMinor,heldFeeMinor,fault:d.fault,
        sourceWallet:text(body.sourceWallet),provider:text(body.provider),destination:structuredClone(destination),approvedDecision:structuredClone(d),reservedAt:at};
    } else if (action==='remedy-reconcile') {
      const r=p.remedy;
      if (!r || !['reserved','unknown'].includes(r.status) || r.payerId!==user.id && user.role!=='super_admin') fail('cash_remedy_payer_required',403);
      if (body.outcome==='unknown') r.status='unknown';
      else if (body.outcome==='not_sent' && body.noTransferConfirmed===true) r.status='failed';
      else fail('cash_remedy_reconciliation_required',400);
      (p.remedyAttempts ||= []).push({...structuredClone(r),reason:text(body.reason),at});
    } else if (action==='remedy-pay') {
      const r=p.remedy;
      if (!r || !['reserved','unknown'].includes(r.status) || r.payerId!==user.id && user.role!=='super_admin') fail('cash_remedy_payer_required',403);
      if (body.amountMinor!==r.amountMinor) fail('cash_remedy_amount_mismatch',400);
      const refund=['partial_refund','full_refund'].includes(r.remedyType);
      const reference=text(body.reference),receiptFileId=refund?bind(body.receiptFileId,'cash_remedy_receipt'):
        owned(store,user,body.receiptFileId,'cash_reprint_receipt',{id:r.id,orderId:order.id,supplierId:order.supplierId});
      if ((await db.query("SELECT 1 FROM cash_journals WHERE kind='remedy_paid' AND evidence->>'reference'=$1 AND evidence->>'sourceWallet'=$2 AND evidence->>'provider'=$3",[reference,r.sourceWallet,r.provider])).rowCount) fail('cash_transfer_duplicate');
      await event('remedy_paid',[['cash_remedy_expense',r.advanceMinor],['gridgo_revenue',r.heldFeeMinor],['gridgo_bank',-r.amountMinor]],
        {remedyId:r.id,decisionId:r.decisionId,remedyType:r.remedyType,reference,receiptFileId,amountMinor:r.amountMinor,advanceMinor:r.advanceMinor,heldFeeMinor:r.heldFeeMinor,
          destination:structuredClone(r.destination),approvedDecision:structuredClone(r.approvedDecision),sourceWallet:r.sourceWallet,provider:r.provider},`remedy-paid:${r.id}`);
      if (r.fault==='shop' && r.advanceMinor) await event('shop_recovery_created',[[`shop_receivable:${order.supplierId}`,r.advanceMinor],['shop_recovery_offset',-r.advanceMinor]],
        {remedyId:r.id,decisionId:r.decisionId,amountMinor:r.advanceMinor,earnedPayoutsOnly:true},`shop-recovery:${r.id}`);
      Object.assign(r,{status:'paid',paidAt:at,receiptFileId,reference});
      restoreVoucherForRefund(store,order,{id,at,actorId:user.id,clientCaused:false,reason:r.approvedDecision.reason});
    } else fail('not_found',404);
    if (action!=='collect') p.version=(p.version||1)+1;
    order.updatedAt=at;
    if (action!=='collect') notify(store,order,user,action.replaceAll('-','_'),ctx,{version:p.version});
    response={status:200,body:{cash:{version:p.version,status:order.paymentStatus,
      ...(user.role==='client' && action==='repayment'?{repayment:clientRepayment(p)}:{}),
      ...(staff(user)?{progress:p}:{})},...(receipt?{receipt}:{}),...(incident?{incident}:{}),...(action==='redelivery-quote'?{redelivery:p.redelivery}:{})}};
  } else fail('not_found',404);
  return {...await replay.finish(response),mutated:true};
}
