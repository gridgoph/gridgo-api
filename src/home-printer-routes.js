import { homeProfile, homePrinterStatus, homePin, homeSettings, homeDocuments, homeDocumentType,
 HOME_FILE_AGREEMENT, nextHomePinChange, homeVerified, notifyHomeStatus } from './home-printers.js';
import { queueInvalidate, privilegedAdminMemberships } from './notifications.js';
import { supplierCanWork } from './supplier-verification.js';
const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
export async function routeHomePrinters({req,url,store,user,readBody,now,id,audit}) {
 const staff=/^\/ops\/home-printers\/([^/]+)(?:\/(starter))?$/.exec(url.pathname);
 const own=url.pathname==='/me/home-printer';
 if(!staff&&!own)return null;
 if(!user)fail(401,'unauthorized');
 if(staff?!['ops_admin','super_admin'].includes(user.role):user.role!=='supplier'||user.shopRole&&user.shopRole!=='owner')fail(403,'forbidden');
 const profile=homeProfile(store,staff?staff[1]:user.id);if(!profile)fail(404,'home_printer_not_found');
 const at=now(),h=profile.homePrinter;
 const projection=()=>({version:profile.version||1,homePrinter:homePrinterStatus(store,profile,at),pin:{point:profile.shop,barangay:h.barangay,street:h.street,
  propertyType:h.propertyType,landmark:h.landmark,nextChangeAt:nextHomePinChange(h.pinChangedAt||h.startedAt)},
  ...(staff?{starterEvidence:h.starterEvidence||null,verificationDocuments:homeDocuments(store,profile.userId).map(f=>({fileId:f.fileId,documentType:homeDocumentType(f)}))}:{})});
 if(req.method==='GET'&&!staff?.[2])return {status:200,body:projection()};
 if(staff?req.method!=='POST'||!staff[2]:req.method!=='PATCH')fail(405,'method_not_allowed');
 const body=await readBody(req);
 if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_home_printer');
 if(body.expectedVersion!==(profile.version||1))fail(409,'shop_profile_stale');
 if(staff) {
  if(!h.privacyAgreement?.accepted)fail(409,'home_file_privacy_required');
  const birth=String(body.dateOfBirth||''),today=new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10);
  const age=Number(today.slice(0,4))-Number(birth.slice(0,4))-(today.slice(5)<birth.slice(5)?1:0);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(birth)||!Number.isFinite(Date.parse(birth))||new Date(birth).toISOString().slice(0,10)!==birth||age<homeSettings(store.settings).minimumAgeYears)fail(400,'home_adult_id_required');
  const docs=homeDocuments(store,profile.userId),reviewed=body.reviewedFileIds;
  if(!Array.isArray(reviewed)||!['valid_id','id_selfie','sample_work'].every(type=>docs.some(f=>homeDocumentType(f)===type&&reviewed.includes(f.fileId))))fail(409,'home_starter_documents_required');
  h.starterApprovedAt=at;delete h.starterRevokedAt;
  h.starterEvidence={dateOfBirth:birth,fileIds:reviewed.filter(fileId=>docs.some(f=>f.fileId===fileId)),reviewedBy:user.id,reviewedAt:at};
 } else {
  if(Object.keys(body).some(k=>!['expectedVersion','online','location','pin','allowHomePickup','filePrivacyAgreement'].includes(k)))fail(400,'invalid_home_printer');
  if(body.filePrivacyAgreement!==undefined) {
   if(body.filePrivacyAgreement?.accepted!==true||body.filePrivacyAgreement.wording!==HOME_FILE_AGREEMENT)fail(400,'home_file_privacy_required');
   h.privacyAgreement={accepted:true,wording:HOME_FILE_AGREEMENT,at};
  }
  if(body.pin) {
   if(h.pinConsent?.accepted&&Date.parse(at)<Date.parse(nextHomePinChange(h.pinChangedAt||h.startedAt)))fail(409,'home_pin_change_limited');
   const pin=homePin(body.pin,at);profile.shop=pin.point;Object.assign(h,pin);profile.barangay=h.barangay;delete h.point;h.pinChangedAt=at;h.online=false;h.location=null;
   const identity=store.users.find(u=>u.id===profile.userId);if(identity)identity.shop=structuredClone(profile.shop);
  }
  if(body.location!==undefined) {
   const p=body.location;
   if(!p||!Number.isFinite(p.lat)||Math.abs(p.lat)>90||!Number.isFinite(p.lng)||Math.abs(p.lng)>180)fail(400,'invalid_home_location');
   h.location={lat:p.lat,lng:p.lng,at};
  }
  if(body.allowHomePickup!==undefined) {
   if(typeof body.allowHomePickup!=='boolean')fail(400,'invalid_home_printer');
   if(body.allowHomePickup&&!homeVerified(store,profile))fail(409,'home_verified_pickup_required');
   profile.pickupAvailable=body.allowHomePickup;
  }
  if(body.online!==undefined) {
   if(typeof body.online!=='boolean')fail(400,'invalid_home_printer');
   if(body.online) {
    if(!body.location)fail(400,'home_current_location_required');
    if(!supplierCanWork(store,profile.userId))fail(403,'supplier_not_approved');
    // Validate before mutation so a refused switch cannot clear a hold.
    const status=homePrinterStatus(store,{...profile,homePrinter:{...h,online:true}},at);
    if(status.reason)fail(409,status.reason);
   }
   h.online=body.online;h.consecutiveMisses=0;delete h.offlineReason;
  }
 }
 if(!staff&&(body.pin||body.online!==undefined||body.allowHomePickup!==undefined))notifyHomeStatus(store,profile.userId,at,'Home printer availability or pickup settings changed.');
 profile.version=(profile.version||1)+1;profile.updatedAt=at;
 audit?.(store,{actor:user,action:staff?'home_printer.starter_reviewed':'home_printer.updated',entityType:'supplier_profile',entityId:profile.userId,detail:{version:profile.version}});
 if(staff)for(const recipient of [{userId:profile.userId,role:'supplier'},...privilegedAdminMemberships(store)])(store.notifications||=[]).push({id:id('ntf'),userId:recipient.userId,appRole:recipient.role,type:'home_printer_level',title:'Home printer level updated',body:'Open verification to review your level.',at,read:false});
 queueInvalidate(store,{resource:'catalog',userIds:[profile.userId]});
 return {status:200,body:projection(),mutated:true};
}
