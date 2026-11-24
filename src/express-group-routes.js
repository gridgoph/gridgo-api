import { documentPagesFor } from './document-pages.js';
import { approvedRole } from './notifications.js';
import { createGroup, joinGroup, removeGroupMember, lookupGroupInvite, groupMembers, assertGroupHost, assertGroupMember, assertGroupEditable, openGroupCheckout, cancelGroup, groupAmounts, groupNotice, groupTracking, backupReceiver, formatGroupMinor } from './express-groups.js';
import { createExpressDraft, checkoutBasket, expressConfirmation, clientCartQuote, cartVoucherPlan } from './order-match-routes.js';
import { expressFail as fail, expressShopList, expressLinePrice, expressStatus, expressRates } from './express-orders.js';
import { approvedCatalogView, CATALOG_REVIEW_TABLES } from './catalog-review-state.js';
import { reviewCatalogView, REVIEW_CATALOG_TABLES } from './review-data.js';
import { clientRiderLocationPing, currentRiderPings, latestPing, clientTracking, deliveryMilestones } from './rider-tracking.js';
import { cancelGroupExpressOrder } from './group-express-recovery.js';

const FILE_FIELDS=['fileId','copies','pageRange','paper','colour','sides','layout','note','acceptedWarnings'];
function filesInput(files) {
  if(!Array.isArray(files)||files.length>20)fail(400,'invalid_express_files');
  return files.map(f=>{
    if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(k=>!FILE_FIELDS.includes(k))||!['a4','short','long'].includes(f.paper)||!Number.isSafeInteger(f.copies)||f.copies<1||!['bw','colour'].includes(f.colour)||!['one','two'].includes(f.sides)||!['fit_to_paper','actual_size_centered','actual_size_original_position'].includes(f.layout)||!Array.isArray(f.acceptedWarnings)||f.acceptedWarnings.length>20||f.acceptedWarnings.some(w=>!['paper_size_mismatch','rgb_colour'].includes(w))||f.note!=null&&(typeof f.note!=='string'||f.note.length>300))fail(400,'invalid_express_files');
    return structuredClone(f);
  });
}
function hostUser(store,g) {return {...store.users.find(u=>u.id===g.hostId),role:'client'};}
// Internal owner map is constructed exclusively from active membership-owned inputs.
export function buildGroupDraft(store,g,{supplierId=null,id,at,preview=false}={}) {
  const host=hostUser(store,g),members=groupMembers(store,g),owners=new Map(),fileMembers=[];
  const files=members.flatMap(m=>m.files.map(f=>{
    const file=store.files.find(row=>row.fileId===f.fileId);
    if(!file||file.ownerId!==m.userId||file.state!=='ready'||file.purpose!=='artwork'||!file.objectKey||file.savedFileDeletionRequestedAt)fail(409,'file_not_ready');
    const pages=documentPagesFor(store,{pricingUnit:'per_page'},{artworkFileId:f.fileId},f.pageRange??null,{required:true});
    expressLinePrice({documentPages:pages,quantity:f.copies,expressPrint:{rateMinor:expressRates(store.settings)[f.colour==='bw'?'bwMinor':'colourMinor']}});
    owners.set(f.fileId,{id:m.userId});fileMembers.push(m);return f;
  }));
  if(!files.length)fail(409,'group_files_required');
  const view=approvedCatalogView(store);
  const shops=expressShopList(view,host,{location:g.fulfillmentMode==='delivery'?g.dropoff:g.location,fulfillmentMode:g.fulfillmentMode},at);
  if(g.fulfillmentMode==='pickup'&&!supplierId&&!preview)fail(400,'group_pickup_shop_required');
  const candidates=supplierId?shops.filter(s=>s.supplierId===supplierId):shops;
  for(const shop of candidates) {
    const target={...view,carts:[],cartLines:[],foundingTesters:structuredClone(store.foundingTesters||[])};
    let result;
    try {result=createExpressDraft(target,host,{location:g.location,dropoff:g.dropoff,fulfillmentMode:g.fulfillmentMode,supplierId:shop.supplierId,files},id,at,null,owners);}
    catch(error) {if(!supplierId&&error.status===409)continue;throw error;}
    target.cartLines.forEach((line,i)=>Object.assign(line.expressPrint,{groupMemberId:fileMembers[i].userId,groupMemberName:store.users.find(u=>u.id===fileMembers[i].userId)?.name||'Group member'}));
    if(!preview) {
      const existing=store.carts.find(c=>c.id===g.cartId&&c.state==='draft');
      if(existing) {
        const cartId=existing.id,createdAt=existing.createdAt;
        Object.assign(existing,target.carts[0],{id:cartId,createdAt});target.carts[0]=existing;
        for(const line of target.cartLines)line.cartId=cartId;
        store.cartLines=store.cartLines.filter(line=>line.cartId!==cartId);
      } else store.carts.push(target.carts[0]);
      store.cartLines.push(...target.cartLines);g.cartId=target.carts[0].id;
      result.body.cartId=g.cartId;
      result.body.quote=clientCartQuote(store,target.carts[0],target.cartLines,at);
    }
    result.body.confirmation=expressConfirmation(target.carts[0],target.cartLines);
    return {cart:target.carts[0],lines:target.cartLines,...result.body};
  }
  fail(409,'express_shop_unavailable');
}
export function recalculateGroup(store,g,{id,at,draft=null,order=null}={}) {
  const members=groupMembers(store,g);
  if(!members.some(m=>m.files.length)){g.quoteStatus='priced';g.amounts=members.map(m=>({userId:m.userId,fileCount:0,pageCount:0,printSubtotalMinor:0,deliveryShareMinor:0,amountOwedMinor:0}));g.totalMinor=0;g.deliveryFeeMinor=0;return;}
  let result;
  try { result=draft||buildGroupDraft(store,g,{id,at,preview:true}); }
  catch(error) {
    if(order||error.code!=='express_shop_unavailable')throw error;
    // Membership and validated file edits must not depend on a printer staying
    // open. No checkout is possible while the ordinary quote is unavailable.
    g.quoteStatus='pending';g.totalMinor=0;g.deliveryFeeMinor=0;
    g.amounts=members.map(m=>({userId:m.userId,fileCount:m.files.length,pageCount:m.files.reduce((n,f)=>n+documentPagesFor(store,{pricingUnit:'per_page'},{artworkFileId:f.fileId},f.pageRange??null,{required:true}).printed*f.copies,0),printSubtotalMinor:0,deliveryShareMinor:0,amountOwedMinor:0}));
    return;
  }
  g.quoteStatus='priced';
  const quote=order?{clientItemSubtotalMinor:order.supplierSubtotalMinor+order.serviceFeeMinor,deliveryFeeMinor:order.deliveryFeeMinor,totalMinor:order.totalMinor}:result.quote;
  const voucher=order?null:cartVoucherPlan(store,result.cart,result.lines,at);
  const payableDelivery=order?Math.max(0,order.deliveryFeeMinor-(order.voucherDeliveryMinor||0)):(voucher?.groups[0]?.clientDeliveryFeeMinor??quote.deliveryFeeMinor);
  const principals=members.map(m=>result.lines.filter(l=>l.expressPrint.groupMemberId===m.userId).reduce((sum,l)=>sum+expressLinePrice(l).lineSubtotalMinor,0));
  g.amounts=groupAmounts(members,g.hostId,{printingMinor:quote.clientItemSubtotalMinor,deliveryMinor:payableDelivery,totalMinor:quote.totalMinor},principals);
  for(const amount of g.amounts)amount.pageCount=result.lines.filter(l=>l.expressPrint.groupMemberId===amount.userId).reduce((n,l)=>n+l.documentPages.printed*l.quantity,0);
  g.totalMinor=quote.totalMinor;g.deliveryFeeMinor=payableDelivery;g.updatedAt=at;
}
export function publicGroup(store,g,user,at) {
  const own=assertGroupMember(store,g,user),host=g.hostId===user.id;
  const summary=m=>({...g.amounts?.find(a=>a.userId===m.userId),...(g.quoteStatus==='pending'?{printSubtotalMinor:null,deliveryShareMinor:null,amountOwedMinor:null}:{}),userId:m.userId,name:store.users.find(u=>u.id===m.userId)?.name||'Group member',paidBack:!!m.paidBack});
  return {id:g.id,host:{id:g.hostId,name:store.users.find(u=>u.id===g.hostId)?.name||'Host'},state:g.state,status:g.orderId?expressStatus(store.orders.find(o=>o.id===g.orderId)||{}):g.state,version:g.version,fulfillmentMode:g.fulfillmentMode,closesAt:g.closesAt,checkoutOpenedAt:g.checkoutOpenedAt||null,payBy:g.payBy||null,
    quoteStatus:g.quoteStatus||'priced',people:groupMembers(store,g).length,printingPeople:groupMembers(store,g).filter(m=>m.files.length).length,cancelReason:g.cancelReason||null,
    me:{...summary(own),files:structuredClone(own.files),review:structuredClone(own.review||null)},
    ...(host?{members:groupMembers(store,g).map(summary),totalMinor:g.quoteStatus==='pending'?null:g.totalMinor??0,deliveryFeeMinor:g.quoteStatus==='pending'?null:g.deliveryFeeMinor??null,location:g.location,dropoff:g.dropoff,backupReceiver:g.backupReceiver,cartId:g.cartId}:{}),
    tracking:groupTracking(store,g,user,at)};
}
export async function routeExpressGroups(args) {
  const path=args.url.pathname;
  if(!path.startsWith('/express/groups')&&!path.startsWith('/me/express-groups')&&!/^\/dispatch\/[^/]+\/group-/.test(path))return null;
  const {store}=args,view=reviewCatalogView(approvedCatalogView(store),args.user);
  if(view===store)return routeExpressGroupsApproved(args);
  const fields=[...new Set([...CATALOG_REVIEW_TABLES,...REVIEW_CATALOG_TABLES])];
  const original=Object.fromEntries(fields.map(key=>[key,store[key]]));
  try {
    for(const key of fields)store[key]=view[key];
    return await routeExpressGroupsApproved(args);
  } finally {Object.assign(store,original);}
}
async function routeExpressGroupsApproved({req,url,store,user,readBody,id,now,database}) {
  const path=url.pathname;
  const backup=/^\/dispatch\/([^/]+)\/(group-backup|group-arrival-estimate)$/.exec(path);
  if(backup) {
    const order=store.orders.find(o=>o.id===backup[1]&&o.groupOrder);
    if(!order)fail(404,'order_not_found');
    if(user?.role!=='rider'||user.id!==order.riderId||!approvedRole(store,user.id,'rider'))fail(403,'forbidden');
    if(backup[2]==='group-arrival-estimate'&&req.method==='POST') {
      const body=await readBody(req),at=now();
      if(!['picked_up','out_for_delivery'].includes(order.state))fail(409,'group_delivery_not_active');
      if(!Number.isInteger(body?.minutes)||body.minutes<1||body.minutes>180)fail(400,'invalid_arrival_estimate');
      order.groupOrder.arrivalEstimate={riderId:user.id,at:new Date(Date.parse(at)+body.minutes*60000).toISOString()};
      const g=store.expressGroups.find(g=>g.id===order.groupOrder.id);
      const text=`The rider is on the way. Estimated arrival in ${body.minutes} minutes.`;
      groupNotice(store,g,'on_the_way',{host:text,member:text},{id,at});
      return {status:200,body:{estimatedArrivalAt:order.groupOrder.arrivalEstimate.at},mutated:true};
    }
    if(backup[2]!=='group-backup'||req.method!=='GET')return null;
    const {rows}=await database.query("SELECT id,pair,state,caller_id,callee_id,rider_id,created_at FROM order_calls WHERE order_id=$1 AND rider_id=$2 AND pair='delivery' AND state='missed'",[order.id,user.id]);
    return {status:200,body:{backup:backupReceiver(order,rows,now())}};
  }
  if(!path.startsWith('/express/groups')&&!path.startsWith('/me/express-groups'))return null;
  if(user?.role!=='client')fail(403,'forbidden');
  const ctx={id,at:now()};
  const read=async()=>{const body=await readBody(req);if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_request');return body;};
  if(path==='/me/express-groups'&&req.method==='GET')return {status:200,body:{groups:(store.expressGroups||[]).filter(g=>groupMembers(store,g).some(m=>m.userId===user.id)).map(g=>publicGroup(store,g,user,ctx.at))}};
  if(path==='/express/groups'&&req.method==='POST') {
    const g=createGroup(store,user,await read(),ctx);recalculateGroup(store,g,ctx);
    return {status:201,body:{group:publicGroup(store,g,user,ctx.at),inviteToken:g.inviteToken},mutated:true};
  }
  const invite=/^\/express\/groups\/invites\/([^/]+)(\/join)?$/.exec(path);
  if(invite) {
    const g=lookupGroupInvite(store,invite[1],ctx.at);
    if(invite[2]&&req.method==='POST') {
      joinGroup(store,g,user,ctx);recalculateGroup(store,g,ctx);
      return {status:200,body:{group:publicGroup(store,g,user,ctx.at)},mutated:true};
    }
    if(!invite[2]&&req.method==='GET')return {status:200,body:{group:{id:g.id,hostName:store.users.find(u=>u.id===g.hostId)?.name||'Host',quoteStatus:g.quoteStatus||'priced',people:groupMembers(store,g).length,closesAt:g.closesAt,fulfillmentMode:g.fulfillmentMode}}};
    return null;
  }
  const match=/^\/express\/groups\/([^/]+)(?:\/(files|leave|close|cancel|prepare|checkout|shop-decision|tracking|review|members\/([^/]+)(?:\/(paid-back))?))?$/.exec(path);
  if(!match)return null;
  const g=(store.expressGroups||[]).find(g=>g.id===match[1]);if(!g)fail(404,'group_not_found');
  const member=assertGroupMember(store,g,user),action=match[2];
  const response=()=>({status:200,body:{group:publicGroup(store,g,user,ctx.at)},mutated:true});
  if(!action&&req.method==='GET')return {...response(),mutated:false};
  if(action==='tracking'&&req.method==='GET') {
    const order=store.orders.find(o=>o.id===g.orderId);if(!order)fail(409,'group_not_ordered');
    const ping=clientRiderLocationPing(order,latestPing(currentRiderPings(store,order)));
    return {status:200,body:{...groupTracking(store,g,user,ctx.at),me:publicGroup(store,g,user,ctx.at).me,
      ping:ping?{lat:ping.lat,lng:ping.lng,accuracy:ping.accuracy??null,at:ping.at,leg:'delivery'}:null,
      riderTracking:clientTracking(order,ping,store.settings,store.version,Date.parse(ctx.at)),deliveryMilestones:deliveryMilestones(order)}};
  }
  if(action==='review'&&req.method==='POST') {
    const order=store.orders.find(o=>o.id===g.orderId);
    if(!order||!['completed','payout_released'].includes(order.state))fail(409,'order_not_complete');
    if(member.review)fail(409,'already_rated');
    const body=await read(),scores={};
    for(const key of ['qualityStars','speedStars','valueStars','riderStars']) {
      if(key==='riderStars'&&body[key]==null)continue;
      if(!Number.isInteger(body[key])||body[key]<1||body[key]>5)fail(400,'invalid_rating');
      scores[key]=body[key];
    }
    if(body.comment!=null&&(typeof body.comment!=='string'||body.comment.length>2000))fail(400,'invalid_rating');
    member.review={...scores,comment:body.comment||null,at:ctx.at};
    (store.auditLog||=[]).push({id:id('aud'),at:ctx.at,actorId:user.id,actorRole:'client',action:'express_group.rated',entityType:'express_group',entityId:g.id,orderId:order.id});
    groupNotice(store,g,'rated',{host:'A group rating was recorded.',member:null},ctx,{userIds:[g.hostId]});
    return {status:201,body:{review:member.review},mutated:true};
  }
  if(action==='files'&&req.method==='PUT') {
    assertGroupEditable(g,ctx.at);member.files=filesInput((await read()).files);
    recalculateGroup(store,g,ctx);g.version++;
    const amount=g.amounts.find(a=>a.userId===user.id);
    groupNotice(store,g,'files_added',{host:g.quoteStatus==='pending'?'Group files changed. No printer quote is available yet.':`Group files changed: ${amount.pageCount} pages; client total PHP ${formatGroupMinor(amount.amountOwedMinor)}.`,member:null},ctx,{userIds:[g.hostId]});
    return response();
  }
  if(action==='leave'&&req.method==='POST') {removeGroupMember(store,g,user,user.id,ctx);recalculateGroup(store,g,ctx);return {status:200,body:{ok:true},mutated:true};}
  if(match[3]) {
    assertGroupHost(g,user);
    if(match[4]&&req.method==='PATCH') {const b=await read();if(typeof b.paidBack!=='boolean')fail(400,'invalid_paid_back');const m=assertGroupMember(store,g,{id:match[3]});m.paidBack=b.paidBack;return response();}
    if(!match[4]&&req.method==='DELETE') {removeGroupMember(store,g,user,match[3],ctx);recalculateGroup(store,g,ctx);return response();}
    return null;
  }
  if(req.method!=='POST')return null;
  assertGroupHost(g,user);
  if(action==='close') {openGroupCheckout(store,g,ctx);return response();}
  if(action==='cancel') {
    if(g.orderId)fail(409,'group_order_cancellation_required');
    cancelGroup(store,g,'host_cancelled',ctx);return response();
  }
  if(action==='shop-decision') {
    const order=store.orders.find(o=>o.id===g.orderId),decision=order?.groupOrder?.shopDecision,b=await read();
    if(!decision||decision.status!=='pending'||Date.parse(ctx.at)>=Date.parse(decision.deadlineAt))fail(409,'group_shop_decision_expired');
    if(!['use','cancel'].includes(b.decision))fail(400,'invalid_group_shop_decision');
    decision.status=b.decision;decision.decidedAt=ctx.at;
    if(b.decision==='use'&&order.shopAcceptance?.status==='pending')order.shopAcceptance.deadlineAt=new Date(Date.parse(ctx.at)+5*60000).toISOString();
    if(b.decision==='cancel'){cancelGroupExpressOrder(store,order,'host_cancelled',ctx);cancelGroup(store,g,'host_cancelled',ctx);}
    return response();
  }
  if(['prepare','checkout'].includes(action)) {
    if(g.state!=='checkout_open'||Date.parse(ctx.at)>=Date.parse(g.payBy))fail(409,'group_locked');
    const b=await read();
    if(action==='prepare') {
      const draft=buildGroupDraft(store,g,{...ctx,supplierId:g.fulfillmentMode==='pickup'?b.supplierId:null});
      recalculateGroup(store,g,{...ctx,draft});
      return {status:200,body:{group:publicGroup(store,g,user,ctx.at),cartId:draft.cartId,confirmation:draft.confirmation,quote:draft.quote,shop:draft.shop},mutated:true};
    }
    const cart=store.carts.find(c=>c.id===g.cartId&&c.state==='draft');if(!cart)fail(409,'group_preview_required');
    if(b.payment?.method==='cash'&&clientCartQuote(store,cart,store.cartLines.filter(l=>l.cartId===cart.id),ctx.at).totalMinor>=150000)fail(409,'group_cash_limit_exceeded');
    const result=checkoutBasket(store,user,cart,b,id,ctx.at,req),order=store.orders.find(o=>o.id===result.order.id);
    recalculateGroup(store,g,{...ctx,draft:{lines:store.cartLines.filter(l=>l.cartId===cart.id)},order});
    g.state='ordered';g.orderId=order.id;g.lastOrderState=order.state;g.updatedAt=ctx.at;
    groupNotice(store,g,'placed',{host:`Group order placed. Client total PHP ${formatGroupMinor(order.totalMinor)}.`,member:m=>`Group order placed. You owe the host PHP ${formatGroupMinor(g.amounts.find(a=>a.userId===m.userId).amountOwedMinor)}.`},ctx);
    return {status:201,body:{group:publicGroup(store,g,user,ctx.at),orderId:order.id},mutated:true};
  }
  return null;
}
