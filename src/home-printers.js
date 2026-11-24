import { randomUUID } from 'node:crypto';
import { queueInvalidate, privilegedAdminMemberships } from './notifications.js';
/** Home-printer policy. Private facts stay on the existing supplier profile. */
const DAY = 86400000;
export const HOME_PIN_CONSENT = 'I agree that clients see only my barangay and approximate distance, paid home-pickup clients see my street, and the assigned rider sees my exact pin only during an active job.';
export const HOME_FILE_AGREEMENT = 'I will keep client files private, use them only to print the job, and delete them after completing it.';
export const homeProfile = (store, id) => store?.supplierProfiles?.find(p => p.userId === id && p.homePrinter);
export const homeSettings = settings => ({minimumAgeYears:18,starterWeeklyJobCap:30,verificationWindowDays:30,...settings?.homePrinter});
const fail = (status, code) => { throw Object.assign(new Error(code), {status, code}); };
export function validateHomeSettings(settings) {
 const policy=homeSettings(settings);
 if(settings?.homePrinter!==undefined && (!settings.homePrinter || Array.isArray(settings.homePrinter) || typeof settings.homePrinter!=='object'
   || Object.keys(settings.homePrinter).some(k=>!Object.hasOwn(policy,k)||!['minimumAgeYears','starterWeeklyJobCap','verificationWindowDays'].includes(k))))fail(400,'invalid_home_printer_settings');
 for(const [key,min,max] of [['minimumAgeYears',18,100],['starterWeeklyJobCap',1,10000],['verificationWindowDays',1,3650]])
  if(!Number.isSafeInteger(policy[key])||policy[key]<min||policy[key]>max)fail(400,'invalid_home_printer_settings');
 return policy;
}
export function homeVerified(store, profile) {
 const types=new Set(profile?.homeVerificationTypes||homeDocuments(store,profile?.userId).map(homeDocumentType));
 return !!profile?.homePrinter?.starterApprovedAt && types.has('tin') && ['business_permit','barangay_clearance'].some(t=>types.has(t))
  && (store.approvalCases||[]).some(c=>c.userId===profile.userId&&c.kind==='supplier'&&c.status==='approved');
}
// The same spherical distance used by matching, without a policy/module cycle.
export function homeDistance(a,b) {
 if(!a||!b)return Infinity;
 const rad=n=>n*Math.PI/180,dl=rad(b.lat-a.lat),dn=rad(b.lng-a.lng);
 const h=Math.sin(dl/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dn/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
export function homePrinterStatus(store, profile, at) {
 const h=profile.homePrinter,policy=homeSettings(store.settings),verified=homeVerified(store,profile);
 const jobs=(store.orders||[]).filter(o=>(o.expressOrder?.events||[]).some(e=>e.state==='accepted'&&e.supplierId===profile.userId
  && Date.parse(e.at)>Date.parse(at)-7*DAY&&Date.parse(e.at)<=Date.parse(at))).length;
 const deadlineAt=new Date(Date.parse(h.startedAt)+policy.verificationWindowDays*DAY).toISOString();
 const reason=!h.pinConsent?.accepted?'home_pin_consent_required':!h.privacyAgreement?.accepted?'home_file_privacy_required':h.starterRevokedAt?'home_starter_revoked':!h.starterApprovedAt?'home_starter_review_required'
  :!verified&&Date.parse(at)>=Date.parse(deadlineAt)?'home_verification_deadline'
  :!verified&&jobs>=policy.starterWeeklyJobCap?'home_weekly_cap'
  :Date.parse(h.offlineUntil)>Date.parse(at)?'home_fair_play_hold'
  :homeDistance(h.location,profile.shop)>300?'home_away_from_pin':!h.online?'home_offline':null;
 return {printerType:'home',symbol:'house',level:verified?'verified':h.starterApprovedAt&&!h.starterRevokedAt?'starter':'pending',
  verified,online:h.online===true,offersPaused:!!reason,newOrdersPaused:!!reason,reason,deadlineAt,weeklyJobs:jobs,
  weeklyJobCap:verified?null:policy.starterWeeklyJobCap,offlineUntil:h.offlineUntil||null,
  allowHomePickup:verified&&profile.pickupAvailable===true,pinConsentWording:HOME_PIN_CONSENT,filePrivacyWording:HOME_FILE_AGREEMENT};
}
export function recordHomeOffer(store,supplierId,state,at) {
 const profile=homeProfile(store,supplierId);if(!profile)return;
 const h=profile.homePrinter;
 h.consecutiveMisses=state==='timed_out'?(h.consecutiveMisses||0)+1:0;
 if(h.consecutiveMisses>=2&&h.online){h.online=false;h.offlineReason='missed_offers';notifyHomeStatus(store,supplierId,at,'Two missed offers switched you offline.');}
 profile.updatedAt=at;
}
export function recordHomeGiveBack(store,profile,order,at) {
 if(Date.parse(at)-Date.parse(order.shopAcceptance.acceptedAt)<=5*60000)return false;
 const h=profile.homePrinter;
 h.lateGiveBacks=(h.lateGiveBacks||[]).filter(time=>Date.parse(time)>Date.parse(at)-7*DAY);
 h.lateGiveBacks.push(at);
 if(h.lateGiveBacks.length>=3){h.online=false;h.offlineUntil=new Date(Date.parse(at)+DAY).toISOString();}
 if(h.lateGiveBacks.length>3)h.starterRevokedAt=at;
 if(h.lateGiveBacks.length>=3)notifyHomeStatus(store,profile.userId,at,h.starterRevokedAt?'Starter access needs review after repeated late give-backs.':'Late give-backs paused new offers for 24 hours.');
 return true;
}
export function snapshotHomePrinter(store,order) {
 const profile=homeProfile(store,order.supplierId);
 if(order.homePrinter&&order.homePrinter.supplierId!==order.supplierId)(order.homePrinterHistory||=[]).push(structuredClone(order.homePrinter));
 if(!profile){delete order.homePrinter;return;}
 const h=profile.homePrinter;
 order.homePrinter={supplierId:profile.userId,barangay:h.barangay,street:h.street,pin:structuredClone(order.pickup||profile.shop),
  propertyType:h.propertyType,landmark:h.landmark,privateNames:[profile.shopName,profile.contactName,store.users?.find(u=>u.id===profile.userId)?.name].filter(Boolean)};
}
// Pre-policy orders have no home snapshot. Use their frozen pickup, never
// today's shop pin; an unknown historical street is not disclosed after payment.
function homeForOrder(store,order) {
 if(order.homePrinter?.supplierId===order.supplierId)return order.homePrinter;
 const profile=homeProfile(store,order.supplierId);if(!profile)return null;
 const h=profile.homePrinter,same=profile.shop?.lat===order.pickup?.lat&&profile.shop?.lng===order.pickup?.lng;
 return {supplierId:profile.userId,barangay:same?h.barangay:'Barangay unavailable',
  street:same&&h.pinConsent?.accepted?h.street:null,pin:order.pickup,
  privateNames:[profile.shopName,profile.contactName,store.users?.find(u=>u.id===profile.userId)?.name]};
}
const activeRider=(user,order)=>user?.role==='rider'&&user.id===order?.riderId
 && ['rider_assigned','picked_up','out_for_delivery','awaiting_collection'].includes(order.state);
const settled=p=>['confirmed','not_required'].includes(p?.status);
export function homePickupProjection(order,user,home) {
 if(activeRider(user,order))return {...structuredClone(home.pin),...(home.landmark?{landmark:home.landmark}:{}),...(home.propertyType?{propertyType:home.propertyType}:{})};
 const paid=user?.role==='client'&&user.id===order?.clientId&&order.fulfillmentMode==='pickup'
  &&settled(order.payments?.initial)&&settled(order.payments?.final_online);
 return {barangay:home.barangay,...(paid&&home.street?{street:home.street}:{})};
}
/** Shared JSON boundary, including nested quote/job and legacy publicUser shapes.
 * Exact coordinates are never returned to clients, even after pickup payment.
 * Only the assigned active rider's order subtree may carry its frozen pin. */
export function homePrinterResponse(store,value,user) {
 if(!store || ['ops_admin','super_admin'].includes(user?.role))return value;
 const homes=(store.supplierProfiles||[]).filter(p=>p.homePrinter&&!(user?.role==='supplier'&&user.id===p.userId));
 const orderById=new Map((store.orders||[]).map(o=>[o.id,o]));
 const orders=(store.orders||[]).filter(o=>o.homePrinter||o.homePrinterHistory?.length||homeProfile(store,o.supplierId));
 const metadata=new Map(orders.map(o=>[o.id,homeForOrder(store,o)]));
 if(!homes.length&&!orders.length)return value;
 const privateHomes=homes.map(p=>({supplierId:p.userId,barangay:p.homePrinter.barangay,street:p.homePrinter.street,pin:p.shop,
  privateNames:[p.shopName,p.contactName,store.users?.find(u=>u.id===p.userId)?.name],privateDetails:[p.shop?.label,p.homePrinter.landmark]}));
 for(const o of orders)for(const h of [metadata.get(o.id),o.homePrinter,...o.homePrinterHistory||[]].filter(h=>h&&!(user?.role==='supplier'&&user.id===h.supplierId)))privateHomes.push({...h,privateDetails:[h.pin?.label,h.landmark]});
 const lookup=id=>privateHomes.find(h=>h.supplierId===id);
 const stringsBySupplier=new Map();
 for(const h of privateHomes) {
  const strings=stringsBySupplier.get(h.supplierId)||new Map();
  for(const secret of [...h.privateNames||[],...h.privateDetails||[]])if(secret)strings.set(secret,h.barangay);
  stringsBySupplier.set(h.supplierId,strings);
 }
 function visit(item,context=null,home=null,key='') {
  if(typeof item==='string') {
   if(key==='street'&&context&&homePickupProjection(context,user,metadata.get(context.id)||home||{}).street===item)return item;
   if(!home)return item;
   const strings=stringsBySupplier.get(home.supplierId)||new Map();
   if(/^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(item))return item;
   if(key==='id'||/(?:Id|Ids)$/.test(key)||['role','appRole','type','state','status','error','purpose','printerType','verificationLevel'].includes(key))return item;
   // Redact human-readable identity/text fields, never protocol values or
   // opaque references whose bytes must survive an unrelated profile edit.
   if(!/(?:Name|Filename)$/.test(key)&&!['name','label','title','body','note','reason','message','address','street','contact','description','text','content','summary','filename'].includes(key))return item;
   if(strings.has(item))return strings.get(item);
   let text=item;
   for(const [secret,barangay] of strings)if(secret.length>=4)text=text.split(secret).join(barangay);
   return text;
  }
  if(!item||typeof item!=='object')return item;
  if(Array.isArray(item))return item.map(v=>visit(v,context,home,key));
  const order=orderById.get(item.orderId||item.id);
  if(order)context=order;
  const direct=lookup(item.supplierId||item.userId||item.id||store.cartLines?.find(line=>item.lineIds?.includes(line.id))?.supplierId);
  const frozen=context?metadata.get(context.id):null;
  home=direct&&frozen&&direct.supplierId===frozen.supplierId?frozen:direct||frozen||home;
  if(Number.isFinite(item.lat)&&Number.isFinite(item.lng)) {
   const target=frozen?.pin?.lat===item.lat&&frozen?.pin?.lng===item.lng?frozen:privateHomes.find(h=>h.pin?.lat===item.lat&&h.pin?.lng===item.lng);
   if(target) return context?.supplierId===target.supplierId?homePickupProjection(context,user,metadata.get(context.id)||target):{barangay:target.barangay};
  }
  const out={};
  for(const [k,v] of Object.entries(item)) {
   if(k==='homePrinterHistory'||k==='homePrinter'&&!v?.level)continue;
   if(home&&['contactName','phone','email','landmark','propertyType','privateNames','privateDetails','hours','shopHours','schedule'].includes(k))continue;
   if(home&&(['shopName','supplierName'].includes(k)||k==='name'&&(item.id===home.supplierId||item.userId===home.supplierId||item.printerType==='home'))){out[k]=home.barangay;continue;}
   if(home&&['distanceMeters','deliveryDistanceMeters','distanceKm'].includes(k)&&Number.isFinite(v)) {
    out[k]=k==='distanceKm'?Math.max(0.5,Math.ceil(v*2)/2):Math.max(500,Math.ceil(v/500)*500);out.distanceApproximate=true;continue;
   }
   out[k]=visit(v,context,home,k);
  }
  if(home&&['supplierId','shopName','supplierName'].some(k=>Object.hasOwn(item,k))) {
   out.printerType='home';out.symbol='house';out.barangay=home.barangay;
   const verified=homeVerified(store,homeProfile(store,home.supplierId));
   out.verified=verified;out.verificationLevel=verified?'verified':'starter';
  }
  return out;
 }
 return visit(value);
}
export function homeDocuments(store,supplierId) {
 return (store.files||[]).filter(f=>f.ownerId===supplierId&&f.purpose==='verification_document'&&f.state==='ready'
  &&!f.deleteRequestedAt&&!f.deletedAt&&f.references?.some(r=>r.type==='user'&&r.id===supplierId));
}
export const homeDocumentType = file => file.verificationDocumentType||file.references?.find(r=>r.type==='user')?.documentType;
export function homeVerificationMissing(store,profile) {
 if(!profile?.homePrinter)return [];
 const types=new Set(homeDocuments(store,profile.userId).map(homeDocumentType));
 return [...(!profile.homePrinter.starterApprovedAt||profile.homePrinter.starterRevokedAt?['starter']:[]),
  ...(!['business_permit','barangay_clearance'].some(t=>types.has(t))?['business_permit_or_barangay_clearance']:[]),...(!types.has('tin')?['tin']:[])];
}
export function nextHomePinChange(at) {
 const date=new Date(at),day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+1);
 const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));
 return date.toISOString();
}
export function homePin(value,at) {
 const point=value?.point;
 if(!point||!Number.isFinite(point.lat)||Math.abs(point.lat)>90||!Number.isFinite(point.lng)||Math.abs(point.lng)>180
  ||!['house','boarding_house'].includes(value.propertyType))fail(400,'invalid_home_pin');
 const text=(v,max)=>typeof v==='string'&&v.trim()&&v.trim().length<=max;
 if(!text(value.barangay,120)||!text(value.street,300)||(value.landmark!=null&&!text(value.landmark,300)))fail(400,'invalid_home_pin');
 if(value.consent?.accepted!==true||value.consent.wording!==HOME_PIN_CONSENT)fail(400,'home_pin_consent_required');
 return {point:{lat:point.lat,lng:point.lng,label:value.street.trim()},barangay:value.barangay.trim(),street:value.street.trim(),
  propertyType:value.propertyType,landmark:value.landmark?.trim()||null,pinConsent:{accepted:true,wording:HOME_PIN_CONSENT,at}};
}

export function notifyHomeStatus(store,supplierId,at,body) {
 for(const recipient of [{userId:supplierId,role:'supplier'},...privilegedAdminMemberships(store)])(store.notifications||=[]).push({id:`ntf_${randomUUID()}`,userId:recipient.userId,appRole:recipient.role,type:'home_printer_status',title:'Home printer status',body,at,read:false});
 queueInvalidate(store,{resource:'catalog',userIds:[supplierId]});
 queueInvalidate(store,{resource:'notifications',userIds:[supplierId,...privilegedAdminMemberships(store).map(m=>m.userId)]});
}
