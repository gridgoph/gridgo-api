import { publicExpressPrint } from './express-shop-pricing.js';
import { homePrinterStatus, homeVerified, recordHomeOffer, snapshotHomePrinter } from './home-printers.js';
import { groupExpressMoved, cancelGroupExpressOrder } from './group-express-recovery.js';
import { supplierVerified, rankVerifiedWithinDistance } from "./supplier-verification.js";
import { staffExpressProjection } from './shop-staff-order.js';
import { assertDocumentRequest } from './document-capabilities.js';
import { listingAcceptsArtwork } from './file-formats.js';
import { randomInt } from 'node:crypto';
import { approvedCatalogView } from './catalog-review-state.js';
import { publicCatalogItem, catalogGroupsForItem, selectedCatalogPrice } from './supplier-catalog.js';
import { supplierMatchBlockersFor } from './supplier-eligibility.js';
import { publicShopRating } from './shop-rating.js';
import { distanceMetersBetween, distanceZoneForDistance, deliveryFeeForDistance } from './operational-model.js';
import { sameReviewData } from './review-data.js';
import { expressAvailability } from './shop-availability.js';
import { isOpenAt } from './availability.js';
import { operatingHours } from './operating-hours.js';
import { projectExpressNightFinish, projectShopFinish, projectListingGroup } from './order-match.js';
import { testerProgress } from './founding-testers.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';
import { expressShopLogo, expressShopServices, expressPaymentMethods, TOP_SHOP_MIN_AVERAGE } from './express-shop-facts.js';

export const EXPRESS_ACCEPT_MS = 5 * 60_000;
export function expressFail(status, code) { throw Object.assign(new Error(code), {status, code}); }
export function expressRates(settings) { return settings?.expressRates ?? {bwMinor:300,colourMinor:500}; }
export function validateExpressRates(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates) || Object.keys(rates).some(k=>!['bwMinor','colourMinor'].includes(k))
    || ![rates.bwMinor,rates.colourMinor].every(n=>Number.isSafeInteger(n)&&n>0)) expressFail(400,'invalid_express_rates');
  return rates;
}
export function expressLinePrice(line) {
  if(line.expressPrint?.pagePricing) {
    const {pages}=line.expressPrint.pagePricing,quantity=line.quantity;
    if(!Number.isSafeInteger(quantity)||quantity<1||pages.length!==line.documentPages?.printed||pages.some(p=>!Number.isSafeInteger(p.priceMinor)||p.priceMinor<0))expressFail(400,'invalid_express_print');
    const value=pages.reduce((sum,p)=>sum+BigInt(p.priceMinor),0n)*BigInt(quantity),units=BigInt(pages.length)*BigInt(quantity)*1000n;
    if(value>BigInt(Number.MAX_SAFE_INTEGER)||units>BigInt(Number.MAX_SAFE_INTEGER))expressFail(400,'invalid_money');
    if(Number(value)!==line.expressPrint.pagePricing.subtotalMinor)expressFail(400,'invalid_express_print');
    const rates=new Set(pages.map(p=>p.priceMinor));
    return {unit:'per_page',quantity,unitRateMinor:rates.size===1?pages[0].priceMinor:0,billableMilliUnits:Number(units),lineSubtotalMinor:Number(value)};
  }
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
/** Shop cards use the fastest listing; an actual job must fit its selected work. */
export function assertExpressNightJob(source, supplierId, lines, fulfillmentMode, at) {
  const store=approvedCatalogView(source),profile=store.supplierProfiles.find(p=>p.userId===supplierId);
  const availability=expressAvailability(profile,store.settings,at,fulfillmentMode);
  if(!availability)expressFail(409,'express_shop_unavailable');
  if(!availability.nightWindow)return;
  const {projection}=projectListingGroup(store,lines,{now:at});
  if(fulfillmentMode==='delivery' && !isOpenAt(operatingHours(store.settings).schedule,projection.promiseBy))expressFail(409,'express_shop_unavailable');
}
export function expressShopList(source,user,{location,sort='nearest',fulfillmentMode='pickup',includeClosed=false,productType='documents'}={},at) {
  location=expressPoint(location);
  if(!['pickup','delivery'].includes(fulfillmentMode)) expressFail(400,'invalid_fulfillment_mode');
  if(!['nearest','top_rated','fewest_jobs'].includes(sort)) expressFail(400,'invalid_express_sort');
  const store=approvedCatalogView(source), blockers=supplierMatchBlockersFor(store,at);
  const rows=[];
  for(const profile of store.supplierProfiles||[]) {
    const supplierId=profile.userId, supplier=store.users.find(u=>u.id===supplierId);
    if(profile.homePrinter&&(productType!=='documents'||homePrinterStatus(store,profile,at).newOrdersPaused
      ||fulfillmentMode==='pickup'&&(!homeVerified(store,profile)||!profile.pickupAvailable)))continue;
    const availability=expressAvailability(profile,store.settings,at,fulfillmentMode);
    const shopAvailability=profile.homePrinter?availability:expressAvailability(profile,store.settings,at,'pickup');
    if((!availability&&!includeClosed) || !supplier || !sameReviewData(user,supplier)
      || blockers(supplierId,profile).some(code=>!includeClosed||code!=='shop_closed') || profile.expressEnabled===false) continue;
    const listingStore=includeClosed&&!shopAvailability?{...store,supplierProfiles:store.supplierProfiles.map(p=>p.userId===supplierId
      ?{...p,isClosed:false,availability:{...p.availability,pausedUntil:null}}:p)}:store;
    const listings=(store.catalogItems||[]).filter(item=>item.supplierId===supplierId && item.express===true
      && (productType==='plans'?['per_page','per_unit'].includes(item.pricingUnit)&&item.subcategoryCode==='blueprint_cad_plotting'&&!item.pricedByColour
        :item.pricingUnit==='per_page' && item.subcategoryCode==='document_printing') && publicCatalogItem(listingStore,item,{at}));
    if(!listings.length) continue;
    if(productType==='plans'&&availability?.nightWindow)continue;
    const jobsAhead=(store.orders||[]).filter(o=>o.supplierId===supplierId && ['supplier_assigned','payment_authorized','production','supplier_self_qc'].includes(o.state)).length;
    const hours=Math.min(...listings.map(item=>publicCatalogItem(listingStore,item,{at}).turnaroundHours||1));
    let projection;
    try { projection=availability?(projectExpressNightFinish(store,supplierId,hours,at) || projectShopFinish(store,{supplierId,turnaroundHours:hours,units:1,now:at})).projection:{promiseBy:null}; }
    catch(error) { if(error.code==='express_night_capacity')continue;throw error; }
    if(availability?.nightWindow && fulfillmentMode==='delivery' && !isOpenAt(operatingHours(store.settings).schedule,projection.promiseBy))continue;
    const createdAt=(store.approvalCases||[]).find(c=>c.userId===supplierId&&c.kind==='supplier'&&c.status==='approved')?.decidedAt||supplier.createdAt, age=Date.parse(at)-Date.parse(createdAt);
    const home=profile.supplierType==='home',barangay=home?(profile.barangay||'Barangay unavailable'):null;
    const distance=distanceMetersBetween(location,profile.shop),distanceZone=distanceZoneForDistance(distance,store.settings);
    const verified=supplierVerified(store,supplierId);
    rows.push({supplierId,verified,verificationLevel:verified?'verified':'starter',printerType:home?'home':'shop',barangay,
      catalogItemIds:listings.map(item=>item.id),name:home?barangay:profile.shopName||supplier.name||'Shop',address:home?barangay:profile.shop.label||'',
      location:home?null:structuredClone(profile.shop),distanceMeters:home?Math.max(500,Math.ceil(distance/500)*500):distance,distanceApproximate:home,distanceZone,
      zone:{...distanceZone,code:({nearby:'A',away:'B',long_distance:'C'})[distanceZone.key]||null},
      deliveryFeeMinor:fulfillmentMode==='delivery'?deliveryFeeForDistance(distance,store.settings):null,
      walkingTimeMinutes:fulfillmentMode==='pickup'?Math.ceil((home?Math.max(500,Math.ceil(distance/500)*500):distance)/80):null,walkingEstimateSource:fulfillmentMode==='pickup'?'straight_line_80m_per_minute':null,
      isOpenNow:!!shopAvailability,selectable:!!availability,openStatus:shopAvailability?(shopAvailability.nightWindow&&!shopAvailability.nightWindow.home?'night':'open'):'closed',
      rating:publicShopRating(store,supplierId),jobsAhead,
      logo:expressShopLogo(store,supplierId,home),services:expressShopServices(store,supplierId,at),
      paymentMethods:expressPaymentMethods(store,user,{home,verified,fulfillmentMode}),
      readyAt:availability?projection.promiseBy:null,deliveryAvailable:availability?.deliveryAvailable||false,nightWindow:availability?.nightWindow||null,busy:jobsAhead>=3,isNew:Number.isFinite(age)&&age>=0&&age<7*86400000});
  }
  for(const row of rows)row.topShop=(row.rating?.average||0)>=TOP_SHOP_MIN_AVERAGE;
  rows.sort((a,b)=>(sort==='top_rated'?(b.rating?.average||0)-(a.rating?.average||0):sort==='fewest_jobs'?a.jobsAhead-b.jobsAhead:0)
    ||distanceMetersBetween(location,store.supplierProfiles.find(p=>p.userId===a.supplierId).shop)-distanceMetersBetween(location,store.supplierProfiles.find(p=>p.userId===b.supplierId).shop)||a.supplierId.localeCompare(b.supplierId));
  if(sort!=='nearest'&&rows.length>1) {const index=rows.findIndex(r=>r.isNew);if(index>=0){const [row]=rows.splice(index,1);rows.splice(1,0,row);}}
  return rows.some(row=>row.printerType==='home')?rows:rankVerifiedWithinDistance(rows);
}
export function expressStatus(order) {
  if(order.state==='cancelled')return 'cancelled';
  if(order.expressOrder?.pickedUpAt)return 'picked_up';
  if(['delivered','issue_window_open','completed','payout_released'].includes(order.state))return 'delivered';
  if(['ready_for_dispatch','rider_assigned','picked_up','out_for_delivery','awaiting_collection'].includes(order.state))return 'ready';
  if(['production','supplier_self_qc'].includes(order.state))return 'printing';
  if(['supplier_accepted','payment_authorized','awaiting_initial_payment'].includes(order.state)||order.shopAcceptance?.status==='accepted')return 'accepted';
  return 'sending';
}
export function publicExpress(order,user) {
  const e=order.expressOrder;if(!e)return null;
  const own=user?.role==='client'&&user.id===order.clientId, staff=['ops_admin','super_admin'].includes(user?.role), shop=user?.role==='supplier'&&user.id===order.supplierId;
  if(!own&&!staff&&!shop&&user?.id!==order.riderId)return null;
  const result = {status:expressStatus(order),paymentTiming:e.paymentTiming||'checkout',originalSupplierId:e.originalSupplierId,currentSupplierId:order.supplierId,declineCount:e.declines,
    acceptBy:order.shopAcceptance?.status==='pending'?order.shopAcceptance.deadlineAt:null,
    events:structuredClone(e.events||[]),refundRequired:e.refundRequired===true,repickRequired:e.repickRequired===true,payBy:e.payBy||null,
    ...(own&&order.fulfillmentMode==='pickup'&&['ready','picked_up'].includes(expressStatus(order))?{pickupCode:e.pickupCode}:{}),
    ...(own||staff||shop?{printSettings:structuredClone(e.printSettings||[])}:{})};
  if(own&&!staff&&!shop) {
    if(order.groupOrder)result.printSettings=result.printSettings.filter(p=>p.groupMemberId===user.id);
  }
  if(result.printSettings)result.printSettings=result.printSettings.map(print=>publicExpressPrint(print,user?.role));
  return ['staff','manager'].includes(user?.shopRole) ? staffExpressProjection(result) : result;
}
export function startExpressAcceptance(order,at) {
  order.shopAcceptance={supplierId:order.supplierId,assignedAt:at,deadlineAt:new Date(Date.parse(order.groupOrder?.shopDecision?.status==='pending'?order.groupOrder.shopDecision.deadlineAt:at)+EXPRESS_ACCEPT_MS).toISOString(),workingMinutes:5,status:'pending'};
  order.expressOrder.events.push({state:'sending',supplierId:order.supplierId,at});
}
export function expressEvent(store,order,state,{at,id,actorId=null,reason=null}) {
  order.updatedAt=at;
  (order.expressOrder.events||=[]).push({state,at,supplierId:order.supplierId});
  (store.auditLog||=[]).push({id:id('aud'),at,actorId,actorRole:actorId?'supplier':'system',action:`express.${state}`,entityType:'order',entityId:order.id,orderId:order.id,reason,detail:{supplierId:order.supplierId,declines:order.expressOrder.declines}});
  for(const recipient of [{userId:order.clientId,role:'client'},{userId:order.supplierId,role:'supplier'},...privilegedAdminMemberships(store)].filter(r=>!order.groupOrder||r.userId!==order.clientId)) {
    (store.notifications||=[]).push({id:id('ntf'),at,userId:recipient.userId,appRole:recipient.role,type:'express_order',orderId:order.id,title:'Express order update',body:`Your Express order is ${state.replaceAll('_',' ')}.`,read:false});
  }
  queueOrderInvalidate(store,order,['orders','jobs','notifications']);
}
export function declineExpress(store,order,{at,id,kind='declined',actorId=null,reason=null}) {
  const e=order.expressOrder;
  if(!e || order.state!=='supplier_assigned'||order.shopAcceptance?.status!=='pending')expressFail(409,'express_acceptance_not_pending');
  if((order.payoutMilestones||[]).some(p=>p.status==='released') || (store.refundSupplierPayouts||[]).some(p=>p.orderId===order.id&&p.status==='released'))expressFail(409,'express_reassignment_payout_released');
  const previous=order.supplierId;
  recordHomeOffer(store,previous,kind,at);
  e.declines++;e.declinedSupplierIds=[...new Set([...(e.declinedSupplierIds||[]),previous])];
  order.shopAcceptance.status=kind;
  e.events.push({state:kind,at,supplierId:previous,reason:kind==='timed_out'?'No response within five minutes.':reason});
  const client=store.users.find(u=>u.id===order.clientId);
  const manual=e.paymentTiming==='after_acceptance'||e.printSettings?.some(print=>print.printVersion===2||print.paper==='a3'||print.productType==='plans');
  const originalPickup=order.pickup||store.supplierProfiles.find(p=>p.userId===e.originalSupplierId)?.shop;
  const originalZone=e.printerZone?.key||(order.fulfillmentMode==='delivery'?order.distanceZone?.key:null)
    ||distanceZoneForDistance(distanceMetersBetween(originalPickup,e.location),store.settings).key;
  const zoneSettings=e.deliveryFeeBands?{...store.settings,deliveryFeeBands:e.deliveryFeeBands}:store.settings;
  const sameZone=shop=>distanceZoneForDistance(distanceMetersBetween(
    store.supplierProfiles.find(profile=>profile.userId===shop.supplierId).shop,
    order.fulfillmentMode==='delivery'?order.dropoff:e.location),zoneSettings).key===originalZone;
  const replacement=!manual&&(kind==='given_back'||e.declines<3) && expressShopList(store,client,{location:order.fulfillmentMode==='delivery'?order.dropoff:e.location,fulfillmentMode:order.fulfillmentMode},at).find(shop=>!e.declinedSupplierIds.includes(shop.supplierId)
    && expressReplacementSupports(store,shop,e.printSettings||[],order.fulfillmentMode,at)
    && sameZone(shop));
  if(replacement) {
    order.supplierId=replacement.supplierId;
    if(replacement.nightWindow)e.nightWindow=structuredClone(replacement.nightWindow);else delete e.nightWindow;
    order.pickup=structuredClone(store.supplierProfiles.find(p=>p.userId===replacement.supplierId).shop);
    snapshotHomePrinter(store,order);
    for(const job of store.orderJobs||[])if(job.orderId===order.id){job.supplierId=order.supplierId;job.pickup=structuredClone(order.pickup);job.updatedAt=at;}
    groupExpressMoved(store,order,{at,id});
    expressEvent(store,order,'moved',{at,id,actorId,reason:kind==='timed_out'?'No response within five minutes.':reason});startExpressAcceptance(order,at);
  } else {
    if(manual)e.repickRequired=true;
    order.state='cancelled';order.cancelledAt=at;order.cancelledBy=null;order.cancellationReason='No Express shop accepted the order.';
    e.refundRequired=Object.values(order.payments||{}).some(p=>p.status==='confirmed');
    for(const job of store.orderJobs||[])if(job.orderId===order.id){job.state='cancelled';job.updatedAt=at;}
    order.timeline.push({at,state:'cancelled',by:'system',note:order.cancellationReason});
    if(order.groupOrder)cancelGroupExpressOrder(store,order,e.declines>=3?'three_declines':'no_shop_in_zone',{at,id});
    expressEvent(store,order,'cancelled',{at,id,actorId,reason:kind==='timed_out'?'No response within five minutes.':reason});
  }
}
export function createExpressSnapshot(cart,lines,at) {
 return {version:1,originalSupplierId:lines[0].supplierId,location:structuredClone(cart.expressLocation),declines:0,declinedSupplierIds:[],
  pickupCode:String(randomInt(1000000)).padStart(6,'0'),events:[{state:'sending',at,supplierId:lines[0].supplierId}],
  printSettings:lines.map(line=>({...((line.expressPrint.groupMemberId)?{groupMemberId:line.expressPrint.groupMemberId,groupMemberName:line.expressPrint.groupMemberName}:{}),...(line.expressPrint.printVersion===2?structuredClone(line.expressPrint):{}),fileId:line.expressPrint.outputFileId||line.artworkFileId,...(line.expressPrint.outputFileId?{sourceFileId:line.artworkFileId,outputAlreadyApplied:true,productionPrint:{layout:'actual_size_centered',orientation:'auto',colour:'as_prepared',pageRange:null}}:{}),pages:structuredClone(line.documentPages),copies:line.quantity,
    colour:line.expressPrint.colour,paper:line.expressPrint.paper,paperStock:line.expressPrint.paperStock,sides:line.expressPrint.sides,
    ...(line.expressPrint.productType?{productType:line.expressPrint.productType}:{}),
    ...(line.expressPrint.paper==='a3'||line.expressPrint.productType==='plans'?{rateMinor:line.expressPrint.rateMinor}:{}),layout:line.printLayout,note:line.specialInstructions||'',acceptedWarnings:structuredClone(line.expressPrint.acceptedWarnings)}))};
}

export function assertExpressPaymentSubmission(order,at) {
 if(order.expressOrder?.paymentTiming!=='after_acceptance')return;
 if(order.shopAcceptance?.status!=='accepted')expressFail(409,'express_acceptance_required');
 if(order.expressOrder.payBy&&Date.parse(at)>=Date.parse(order.expressOrder.payBy))expressFail(409,'express_payment_expired');
}

/** Submitted evidence reserves the price while Operations confirms it. */
export function expireExpressPayments(store,{at,id}) {
 let changed=false;
 for(const order of store.orders||[]) {
  const e=order.expressOrder;
  if(order.orderType!=='express'||e?.paymentTiming!=='after_acceptance'||!e.payBy
    ||order.state!=='awaiting_initial_payment'||order.payments?.initial?.status!=='not_submitted'
    ||Date.parse(at)<Date.parse(e.payBy))continue;
  order.state='cancelled';order.cancelledAt=at;order.cancelledBy=null;order.cancellationReason='Express payment window expired. Choose a printer again.';
  e.repickRequired=true;
  for(const job of store.orderJobs||[])if(job.orderId===order.id){job.state='cancelled';job.updatedAt=at;}
  order.timeline.push({at,state:'cancelled',by:'system',note:order.cancellationReason});
  expressEvent(store,order,'payment_expired',{at,id});changed=true;
 }
 return changed;
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

function expressReplacementSupports(source,shop,settings,fulfillmentMode,at) {
 const store=approvedCatalogView(source);
 const lines=[];
 for(const print of settings) {
  const compatible=shop.catalogItemIds.flatMap(itemId=>{
   const item=store.catalogItems.find(row=>row.id===itemId), listing=item&&publicCatalogItem(store,item);
   const file=store.files.find(row=>row.fileId===print.fileId);
   if(!listing || !(item.printLayouts||[]).includes(print.layout) || !listingAcceptsArtwork(listing.acceptedFormats,file?.detectedContentType))return [];
   try { const standard=expressCatalogOptions(store,item,print);if(print.paper==='a3'&&standard.rateMinor!==print.rateMinor)return [];return [{item,listing}]; } catch(error) {if(error.status)return [];throw error;}
  }).sort((a,b)=>a.listing.turnaroundHours-b.listing.turnaroundHours);
  if(!compatible.length)return false;
  lines.push({catalogItemId:compatible[0].item.id,quantity:print.copies||1,expressPrint:print});
 }
 if(lines.length) {
  try { assertExpressNightJob(store,shop.supplierId,lines,fulfillmentMode,at); }
  catch(error) { if(['express_night_capacity','express_shop_unavailable'].includes(error.code))return false;throw error; }
 }
 return true;
}

/** Express offers only its standard print controls, never custom paid add-ons. */
export function expressCatalogOptions(store,item,print) {
 assertDocumentRequest(store,item,{expressPrint:print});
 const normalize=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
 const optionIds=[];let paperStock=null,hasA3=false;
 for(const group of catalogGroupsForItem(store,item.id,{includeInactiveOptions:false})) {
   if(group.kind==='addon') {if(group.required)expressFail(409,'express_listing_configuration_required');continue;}
   const name=normalize(group.name);let chosen;
   if(print.printVersion===2&&print.productType==='plans'&&/type|process/.test(name)) {
     chosen=group.options.find(o=>normalize(o.label).replaceAll(' ','_')===print.planType);
   } else if(/colou?r/.test(name)) {
     chosen=group.options.find(option=>{
       const label=normalize(option.label), bw=/black|b&w|b\/?w|monochrome/.test(label);
       return print.colour==='blue'?/blue/.test(label):print.colour==='bw'?bw:/colou?r/.test(label)&&!bw;
     });
   } else if(/size/.test(name)||group.options.some(o=>o.specBinding?.fieldCode==='size')) {
     const pattern={a4:/\ba4\b/,a3:/\ba3\b/,a2:/\ba2\b|20x30/,a1:/\ba1\b|24x36/,a0:/\ba0\b/,'30x40':/30x40/,short:/short|letter|8[.]5.*11/,long:/long|folio|legal|8[.]5.*13/}[print.paper];
     chosen=group.options.find(o=>{
       const label=normalize(o.specBinding?.value||o.label);
       if(print.printVersion===2&&print.productType==='plans')return label.replace(/\s/g,'').replace(/[×]/g,'x').replace(/in(?:ches)?$/,'')===print.paper;
       return pattern?.test(label);
     });
     if(print.paper==='a3'&&chosen)hasA3=true;
   } else if(/sides/.test(name)) {
     chosen=group.options.find(o=>print.sides==='two'?/back|two|duplex/.test(normalize(o.label)):/one|single/.test(normalize(o.label)));
   } else if(/paper|material|stock/.test(name)) {
     chosen=print.paperStock?group.options.find(o=>normalize(o.label)===normalize(print.paperStock)):group.options[0];
     if(chosen)paperStock=chosen.label;
   } else if(!group.required)continue;
   if(!chosen)expressFail(409,'express_listing_configuration_required');
   optionIds.push(chosen.id);
 }
 if(print.paper==='a3'&&!hasA3)expressFail(409,'express_listing_configuration_required');
 const priced=selectedCatalogPrice(store,item,optionIds);
 const rateMinor=print.paper==='a3'||print.productType==='plans'?priced.effectiveUnitPriceMinor:expressRates(store.settings)[print.colour==='bw'?'bwMinor':'colourMinor'];
 if(!Number.isSafeInteger(rateMinor)||rateMinor<=0)expressFail(409,'express_listing_configuration_required');
 return {optionIds,paperStock,rateMinor};
}
