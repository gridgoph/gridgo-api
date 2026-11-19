import { listingAcceptsArtwork } from './file-formats.js';
import { randomInt } from 'node:crypto';
import { approvedCatalogView } from './catalog-review-state.js';
import { publicCatalogItem, catalogGroupsForItem, selectedCatalogPrice } from './supplier-catalog.js';
import { supplierMatchBlockersFor } from './supplier-eligibility.js';
import { defaultShopSchedule, isOpenAt } from './availability.js';
import { publicShopRating } from './shop-rating.js';
import { distanceMetersBetween, deliveryFeeForDistance } from './operational-model.js';
import { sameReviewData } from './review-data.js';
import { projectShopFinish } from './order-match.js';
import { testerProgress } from './founding-testers.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';

export const EXPRESS_ACCEPT_MS = 5 * 60_000;
export function expressFail(status, code) { throw Object.assign(new Error(code), {status, code}); }
export function expressRates(settings) { return settings?.expressRates ?? {bwMinor:300,colourMinor:500}; }
export function validateExpressRates(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates) || Object.keys(rates).some(k=>!['bwMinor','colourMinor'].includes(k))
    || ![rates.bwMinor,rates.colourMinor].every(n=>Number.isSafeInteger(n)&&n>0)) expressFail(400,'invalid_express_rates');
  return rates;
}
export function expressLinePrice(line) {
  const rate=line.expressPrint?.rateMinor, pages=line.documentPages?.printed, quantity=line.quantity;
  if (![rate,pages,quantity].every(n=>Number.isSafeInteger(n)&&n>0)) expressFail(400,'invalid_express_print');
  const value=BigInt(rate)*BigInt(pages)*BigInt(quantity), units=BigInt(pages)*BigInt(quantity)*1000n;
  if(value>BigInt(Number.MAX_SAFE_INTEGER)||units>BigInt(Number.MAX_SAFE_INTEGER)) expressFail(400,'invalid_money');
  return {unit:'per_page',quantity,unitRateMinor:rate,billableMilliUnits:Number(units),lineSubtotalMinor:Number(value)};
}
export function expressPoint(point) {
  if(!point || !Number.isFinite(point.lat)||!Number.isFinite(point.lng)||Math.abs(point.lat)>90||Math.abs(point.lng)>180) expressFail(400,'invalid_express_location');
  return {lat:point.lat,lng:point.lng,...(typeof point.label==='string'?{label:point.label.slice(0,500)}:{})};
}
export function expressShopList(source,user,{location,sort='nearest'}={},at) {
  location=expressPoint(location);
  if(!['nearest','top_rated','fewest_jobs'].includes(sort)) expressFail(400,'invalid_express_sort');
  const store=approvedCatalogView(source), blockers=supplierMatchBlockersFor(store);
  const rows=[];
  for(const profile of store.supplierProfiles||[]) {
    const supplierId=profile.userId, supplier=store.users.find(u=>u.id===supplierId);
    if(!supplier || !sameReviewData(user,supplier) || blockers(supplierId,profile).length || !isOpenAt(profile.schedule||defaultShopSchedule(),at)) continue;
    const listings=(store.catalogItems||[]).filter(item=>item.supplierId===supplierId && item.express===true
      && item.pricingUnit==='per_page' && item.subcategoryCode==='document_printing' && publicCatalogItem(store,item));
    if(!listings.length) continue;
    const jobsAhead=(store.orders||[]).filter(o=>o.supplierId===supplierId && ['supplier_assigned','payment_authorized','production','supplier_self_qc'].includes(o.state)).length;
    const hours=Math.min(...listings.map(item=>publicCatalogItem(store,item).turnaroundHours||1));
    const projection=projectShopFinish(store,{supplierId,turnaroundHours:hours,units:1,now:at}).projection;
    const createdAt=(store.approvalCases||[]).find(c=>c.userId===supplierId&&c.kind==='supplier'&&c.status==='approved')?.decidedAt||supplier.createdAt, age=Date.parse(at)-Date.parse(createdAt);
    rows.push({supplierId,catalogItemIds:listings.map(item=>item.id),name:profile.shopName||supplier.name||'Shop',address:profile.shop.label||'',
      location:structuredClone(profile.shop),distanceMeters:distanceMetersBetween(location,profile.shop),rating:publicShopRating(store,supplierId),jobsAhead,
      readyAt:projection.promiseBy,busy:jobsAhead>=3,isNew:Number.isFinite(age)&&age>=0&&age<7*86400000});
  }
  rows.sort((a,b)=>(sort==='top_rated'?(b.rating?.average||0)-(a.rating?.average||0):sort==='fewest_jobs'?a.jobsAhead-b.jobsAhead:0)
    ||a.distanceMeters-b.distanceMeters||a.supplierId.localeCompare(b.supplierId));
  if(sort!=='nearest'&&rows.length>1) {const index=rows.findIndex(r=>r.isNew);if(index>=0){const [row]=rows.splice(index,1);rows.splice(1,0,row);}}
  return rows;
}
export function expressStatus(order) {
  if(order.state==='cancelled')return 'cancelled';
  if(order.expressOrder?.pickedUpAt)return 'picked_up';
  if(['delivered','issue_window_open','completed','payout_released'].includes(order.state))return 'delivered';
  if(['ready_for_dispatch','rider_assigned','picked_up','out_for_delivery','awaiting_collection'].includes(order.state))return 'ready';
  if(['production','supplier_self_qc'].includes(order.state))return 'printing';
  if(['supplier_accepted','payment_authorized'].includes(order.state))return 'accepted';
  return 'sending';
}
export function publicExpress(order,user) {
  const e=order.expressOrder;if(!e)return null;
  const own=user?.id===order.clientId, staff=['ops_admin','super_admin'].includes(user?.role), shop=user?.id===order.supplierId;
  if(!own&&!staff&&!shop&&user?.id!==order.riderId)return null;
  return {status:expressStatus(order),originalSupplierId:e.originalSupplierId,currentSupplierId:order.supplierId,declineCount:e.declines,
    acceptBy:order.shopAcceptance?.status==='pending'?order.shopAcceptance.deadlineAt:null,
    events:structuredClone(e.events||[]),refundRequired:e.refundRequired===true,
    ...(own&&order.fulfillmentMode==='pickup'&&['ready','picked_up'].includes(expressStatus(order))?{pickupCode:e.pickupCode}:{}),
    ...(own||staff||shop?{printSettings:structuredClone(e.printSettings||[])}:{})};
}
export function startExpressAcceptance(order,at) {
  order.shopAcceptance={supplierId:order.supplierId,assignedAt:at,deadlineAt:new Date(Date.parse(at)+EXPRESS_ACCEPT_MS).toISOString(),workingMinutes:5,status:'pending'};
  order.expressOrder.events.push({state:'sending',supplierId:order.supplierId,at});
}
export function expressEvent(store,order,state,{at,id,actorId=null,reason=null}) {
  order.updatedAt=at;
  (order.expressOrder.events||=[]).push({state,at,supplierId:order.supplierId});
  (store.auditLog||=[]).push({id:id('aud'),at,actorId,actorRole:actorId?'supplier':'system',action:`express.${state}`,entityType:'order',entityId:order.id,orderId:order.id,reason,detail:{supplierId:order.supplierId,declines:order.expressOrder.declines}});
  for(const recipient of [{userId:order.clientId,role:'client'},{userId:order.supplierId,role:'supplier'},...privilegedAdminMemberships(store)]) {
    (store.notifications||=[]).push({id:id('ntf'),at,userId:recipient.userId,appRole:recipient.role,type:'express_order',orderId:order.id,title:'Express order update',body:`Your Express order is ${state.replaceAll('_',' ')}.`,read:false});
  }
  queueOrderInvalidate(store,order,['orders','jobs','notifications']);
}
export function declineExpress(store,order,{at,id,kind='declined',actorId=null,reason=null}) {
  const e=order.expressOrder;
  if(!e || order.state!=='supplier_assigned'||order.shopAcceptance?.status!=='pending')expressFail(409,'express_acceptance_not_pending');
  if((order.payoutMilestones||[]).some(p=>p.status==='released') || (store.refundSupplierPayouts||[]).some(p=>p.orderId===order.id&&p.status==='released'))expressFail(409,'express_reassignment_payout_released');
  const previous=order.supplierId;
  e.declines++;e.declinedSupplierIds=[...new Set([...(e.declinedSupplierIds||[]),previous])];
  order.shopAcceptance.status=kind;
  e.events.push({state:kind,at,supplierId:previous,reason:kind==='timed_out'?'No response within five minutes.':reason});
  const client=store.users.find(u=>u.id===order.clientId);
  const replacement=e.declines<3 && expressShopList(store,client,{location:e.location},at).find(shop=>!e.declinedSupplierIds.includes(shop.supplierId)
    && expressReplacementSupports(store,shop,e.printSettings||[])
    && (order.fulfillmentMode==='pickup'||deliveryFeeForDistance(distanceMetersBetween(shop.location,order.dropoff),store.settings)===order.deliveryFeeMinor));
  if(replacement) {
    order.supplierId=replacement.supplierId;order.pickup=structuredClone(replacement.location);
    for(const job of store.orderJobs||[])if(job.orderId===order.id){job.supplierId=order.supplierId;job.pickup=structuredClone(order.pickup);job.updatedAt=at;}
    expressEvent(store,order,'moved',{at,id,actorId,reason:kind==='timed_out'?'No response within five minutes.':reason});startExpressAcceptance(order,at);
  } else {
    order.state='cancelled';order.cancelledAt=at;order.cancelledBy='system';order.cancellationReason='No Express shop accepted the order.';
    e.refundRequired=Object.values(order.payments||{}).some(p=>p.status==='confirmed');
    for(const job of store.orderJobs||[])if(job.orderId===order.id){job.state='cancelled';job.updatedAt=at;}
    order.timeline.push({at,state:'cancelled',by:'system',note:order.cancellationReason});
    expressEvent(store,order,'cancelled',{at,id,actorId,reason:kind==='timed_out'?'No response within five minutes.':reason});
  }
}
export function createExpressSnapshot(cart,lines,at) {
 return {version:1,originalSupplierId:lines[0].supplierId,location:structuredClone(cart.expressLocation),declines:0,declinedSupplierIds:[],
  pickupCode:String(randomInt(1000000)).padStart(6,'0'),events:[{state:'sending',at,supplierId:lines[0].supplierId}],
  printSettings:lines.map(line=>({fileId:line.artworkFileId,pages:structuredClone(line.documentPages),copies:line.quantity,
    colour:line.expressPrint.colour,paper:line.expressPrint.paper,paperStock:line.expressPrint.paperStock,sides:line.expressPrint.sides,layout:line.printLayout,note:line.specialInstructions||'',acceptedWarnings:structuredClone(line.expressPrint.acceptedWarnings)}))};
}
const day=at=>new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10);
export function expressGuide(store,user,at) {
 const record=store.users.find(u=>u.id===user.id)?.expressGuide||{},missions=testerProgress(store,user.id).missions;
 return {missions,popupLastShownDate:record.popupLastShownDate||null,guideSeen:record.guideSeen===true,guideCompleted:record.guideCompleted===true,
  showPopup:!missions.added&&record.popupLastShownDate!==day(at)};
}
export function updateExpressGuide(store,user,body,at) {
 if(!['popup_shown','guide_seen','guide_completed','file_added'].includes(body?.action))expressFail(400,'invalid_express_guide_action');
 if(body.action==='file_added') {
   if(!(store.files||[]).some(f=>f.fileId===body.fileId&&f.ownerId===user.id&&f.state==='ready'&&f.purpose==='artwork'))expressFail(404,'file_not_found');
   let tester=(store.foundingTesters||=[]).find(t=>t.clientId===user.id);
   if(!tester){tester={clientId:user.id};store.foundingTesters.push(tester);}tester.addedAt ||= at;
   return expressGuide(store,user,at);
 }
 const record=(store.users.find(u=>u.id===user.id).expressGuide||={});
 if(body.action==='popup_shown')record.popupLastShownDate=day(at);
 else {record.guideSeen=true;if(body.action==='guide_completed')record.guideCompleted=true;}
 return expressGuide(store,user,at);
}

/** Strip fee working/rates recursively on Express client surfaces only. */
export function expressClientProjection(value) {
 if(Array.isArray(value))return value.map(expressClientProjection);
 if(!value||typeof value!=='object')return value;
 const out={};
 for(const [key,item] of Object.entries(value)) {
   if(/(?:Bps|Percent)$/.test(key)||['serviceFeeSchedule','serviceFeeWorking','serviceFeeRateBps','serviceFeeMinor','grossServiceFeeMinor','clientServiceFeeMinor','voucherServiceFeeMinor','componentLines'].includes(key))continue;
   out[key]=expressClientProjection(item);
 }
 return out;
}

function expressReplacementSupports(source,shop,settings) {
 const store=approvedCatalogView(source);
 return settings.every(print=>shop.catalogItemIds.some(itemId=>{
   const item=store.catalogItems.find(row=>row.id===itemId), listing=item&&publicCatalogItem(store,item);
   const file=store.files.find(row=>row.fileId===print.fileId);
   if(!listing || !(item.printLayouts||[]).includes(print.layout) || !listingAcceptsArtwork(listing.acceptedFormats,file?.detectedContentType))return false;
   try { expressCatalogOptions(store,item,print);return true; } catch(error) {if(error.status)return false;throw error;}
 }));
}

/** Express offers only its standard print controls, never custom paid add-ons. */
export function expressCatalogOptions(store,item,print) {
 const normalize=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
 const optionIds=[];let paperStock=null;
 for(const group of catalogGroupsForItem(store,item.id,{includeInactiveOptions:false})) {
   if(group.kind==='addon') {if(group.required)expressFail(409,'express_listing_configuration_required');continue;}
   const name=normalize(group.name);let chosen;
   if(/colou?r/.test(name)) {
     chosen=group.options.find(option=>{
       const label=normalize(option.label), bw=/black|b&w|b\/?w|monochrome/.test(label);
       return print.colour==='bw'?bw:/colou?r/.test(label)&&!bw;
     });
   } else if(/size/.test(name)||group.options.some(o=>o.specBinding?.fieldCode==='size')) {
     const pattern={a4:/\ba4\b/,short:/short|letter|8[.]5.*11/,long:/long|folio|legal|8[.]5.*13/}[print.paper];
     chosen=group.options.find(o=>pattern?.test(normalize(o.specBinding?.value||o.label)));
   } else if(/paper|material|stock/.test(name)) {
     chosen=print.paperStock?group.options.find(o=>normalize(o.label)===normalize(print.paperStock)):group.options[0];
     if(chosen)paperStock=chosen.label;
   } else if(!group.required)continue;
   if(!chosen)expressFail(409,'express_listing_configuration_required');
   optionIds.push(chosen.id);
 }
 selectedCatalogPrice(store,item,optionIds);
 return {optionIds,paperStock};
}
