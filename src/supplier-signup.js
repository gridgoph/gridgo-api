import { homePin, HOME_PIN_CONSENT, homePickupPoint, HOME_PICKUP_POINT_CONSENT, HOME_FILE_AGREEMENT, homeDistance } from './home-printers.js';
import { CatalogError } from './supplier-catalog.js';
import { philippineMobileNumber } from './phone.js';
import { documentCapabilities } from './document-capabilities.js';
import { expressRates } from './express-orders.js';
import { identityHasMembership } from './authorization-context.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';
import { supplierOnboardingSettings, tierSignup, standardSignupDocument, missingShopName } from './supplier-onboarding.js';
import { validateShopSchedule } from './availability.js';
import { supplierPayoutStatus } from './supplier-payout-policy.js';

export const LOCATION_CONSENT_WORDING='I agree that GRIDGO may store and use my shop location to match jobs and arrange pickups.';
export const PAYOUT_CONSENT_WORDING='I authorize GRIDGO to send shop payouts to this QR account. I am responsible for the receiving account details and have permission to use it.';
export const PRINT_GROUPS=Object.freeze(['documents','marketing','banners_signage','apparel','merchandise','awards','construction','packaging']);
const fail=(status,code='invalid_supplier_signup',field)=>{throw new CatalogError(status,code,'Refresh sign-up and complete the required fields.',field?{field}:{});};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,field,max=120)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(400,undefined,field);return v.trim();};
const phone=v=>philippineMobileNumber(v,'phone',{code:'invalid_supplier_signup'});
export const signupForShop=(store,supplierId)=>(store.supplierSignups||[]).find(s=>s.supplierId===supplierId);
export function verifiedSignupPhone(clerkUser,value) {
  return (clerkUser?.phoneNumbers||clerkUser?.phone_numbers||[]).some(p=>p.verification?.status==='verified'&&(p.phoneNumber||p.phone_number)===value);
}
export function signupProjection(store,row) {
  const steps=structuredClone(row?.steps||{});
  const required=['eligibility','shop','location',...(tierSignup(row)&&steps.eligibility?.shopKind==='home_printer'?['pickup']:[]),'prints'];
  let nextStep=required.find(step=>!steps[step])||'enroll';
  const profile=(store.supplierProfiles||[]).find(p=>p.userId===row?.supplierId);
  if (row?.supplierId) {
    const owner=(store.shopMemberships||[]).some(m=>m.shopId===row.supplierId&&m.role==='owner'&&m.status==='active');
    const account=(store.supplierPayoutAccounts||[]).find(a=>a.supplierId===row.supplierId);
    const policy=(store.supplierPayoutPolicies||[]).find(p=>p.supplierId===row.supplierId);
    if(tierSignup(row)) {
      nextStep=!profile?.schedule?'hours':!owner?'owner_claim':!account?.qrFileId||!policy?.consent?'payout':!row.steps.finish?'finish':'complete';
    } else nextStep=!profile?.homePrinter&&!profile?.schedule?'hours':!(store.shopTeamSettings||[]).some(s=>s.shopId===row.supplierId)?'team':!owner?'owner_claim'
      :!account?.qrFileId||!policy?.consent?'payout':(store.catalogItems||[]).some(i=>i.supplierId===row.supplierId
        &&!(store.catalogItemPhotos||[]).some(p=>p.catalogItemId===i.id))?'listing_photos':'complete';
  }
  return {version:row?.version||0,supplierId:row?.supplierId||null,steps,nextStep,updatedAt:row?.updatedAt||null};
}
export function signupEnrollment(store,clerkUserId,version) {
  const signup=(store.supplierSignups||[]).find(row=>row.clerkUserId===clerkUserId);
  if(!signup||signup.version!==version)fail(409,'supplier_signup_stale');
  if(['eligibility','shop','location','prints'].some(step=>!signup.steps[step]))fail(409,'supplier_signup_incomplete');
  const {shop,location}=signup.steps;
  if(signup.steps.eligibility.shopKind==='home_printer'&&!location.pinConsent?.accepted)fail(409,'home_pin_consent_required');
  if(tierSignup(signup)&&signup.steps.eligibility.registrantRole!=='owner')fail(409,'shop_owner_required');
  if(tierSignup(signup)&&signup.steps.eligibility.shopKind==='home_printer'&&!signup.steps.pickup)fail(409,'home_pickup_point_required');
  return {signup,body:{profile:{shopName:shop.shopName,contactName:shop.contactName,phone:shop.phone,location:location.point},
    serviceCategories:['document_publication']}};
}
export function completeSignupEnrollment(store,signup,supplierId,at) {
  signup.supplierId=supplierId;signup.updatedAt=at;
  const profile=store.supplierProfiles.find(p=>p.userId===supplierId);
  if(tierSignup(signup))profile.pickupAvailable=true;
  if(signup.steps.hours)profile.schedule=structuredClone(signup.steps.hours.schedule);
  if(signup.steps.eligibility.shopKind==='home_printer') {
    const profile=store.supplierProfiles.find(p=>p.userId===supplierId), location=signup.steps.location;
    profile.homePrinter={barangay:location.barangay,street:location.street,propertyType:location.propertyType,landmark:location.landmark,
      pinConsent:location.pinConsent,startedAt:at,pinChangedAt:at,online:false,consecutiveMisses:0};
    profile.supplierType='home';profile.barangay=location.barangay;profile.pickupAvailable=false;
    if(signup.steps.pickup) {
      profile.homePrinter.pickupPoint=signup.steps.pickup.point;
      profile.homePrinter.privacyAgreement=signup.steps.pickup.privacyAgreement;
      profile.pickupAvailable=signup.steps.pickup.mode!=='delivery_only';
    }
  }
  if(signup.steps.eligibility.registrantRole==='manager') {
    const member=store.shopMemberships.find(m=>m.shopId===supplierId&&m.userId===supplierId);
    member.role='staff';
    (store.shopTeamMemberSettings||=[]).push({shopId:supplierId,userId:supplierId,manager:true,jobAlerts:true});
  }
}
export async function routeSupplierSignup({req,url,store,claims,clerkUser,readBody,now}) {
  if(url.pathname!=='/auth/clerk/supplier-signup'||!['GET','PATCH'].includes(req.method))return null;
  if(!claims?.sub)fail(401,'unauthorized');
  let row=(store.supplierSignups||=[]).find(s=>s.clerkUserId===claims.sub);
  const identity=(store.users||[]).find(u=>u.clerkUserId===claims.sub);
  if(identity&&(identity.accountStatus||'active')!=='active')fail(403,'forbidden');
  if(req.method==='PATCH') {
    const body=await readBody(req);
    if(!object(body)||!Number.isSafeInteger(body.expectedVersion)||!object(body.value))fail(400);
    if(body.expectedVersion!==(row?.version||0))fail(409,'supplier_signup_stale');
    if(row?.supplierId)fail(409,'supplier_signup_enrolled');
    const {step,value}=body;let saved;
    if(step==='eligibility') {
      if(!['print_shop','home_printer'].includes(value.shopKind)||!['owner','manager'].includes(value.registrantRole)||value.adult!==true)fail(400,undefined,'eligibility');
      if(row?.steps.shop&&(row.steps.eligibility.registrantRole!==value.registrantRole||row.steps.eligibility.shopKind!==value.shopKind))fail(409,'supplier_signup_restart_required');
      saved={shopKind:value.shopKind,registrantRole:value.registrantRole,adult:true,attestedAt:now()};
    } else if(step==='shop') {
      if(!row?.steps.eligibility)fail(409,'supplier_signup_step_required');
      const mobile=phone(value.phone);
      if(!clerkUser||clerkUser.id!==claims.sub)fail(502,'clerk_unavailable');
      if(!verifiedSignupPhone(clerkUser,mobile))fail(403,'shop_mobile_verification_required');
      if(missingShopName(value.shopName))fail(400,undefined,'shopName');
      saved={shopName:text(value.shopName,'shopName'),contactName:text(value.contactName,'contactName'),phone:mobile,phoneVerifiedAt:now()};
      if(row.steps.eligibility.registrantRole==='manager') {
        saved.ownerPhone=phone(value.ownerPhone);
        if(saved.ownerPhone===mobile)fail(400,undefined,'ownerPhone');
      }
    } else if(step==='location') {
      const p=value.point,c=value.consent;
      if(!object(p)||!Number.isFinite(p.lat)||Math.abs(p.lat)>90||!Number.isFinite(p.lng)||Math.abs(p.lng)>180)fail(400,undefined,'point');
      if(row?.steps.eligibility?.shopKind!=='home_printer'&&(c?.accepted!==true||c.wording!==LOCATION_CONSENT_WORDING))fail(400,undefined,'consent');
      saved=row?.steps.eligibility?.shopKind==='home_printer'?homePin(value,now()):{point:{lat:p.lat,lng:p.lng,label:text(p.label,'label',500)},consent:{accepted:true,wording:LOCATION_CONSENT_WORDING,at:now()}};
    } else if(step==='pickup') {
      if(row?.steps.eligibility?.shopKind!=='home_printer')fail(400,'home_printer_required');
      if(!['gate','guardhouse','landmark','delivery_only'].includes(value.mode))fail(400,undefined,'mode');
      if(value.privacyAgreement?.accepted!==true||value.privacyAgreement.wording!==HOME_FILE_AGREEMENT)fail(400,'home_file_privacy_required');
      saved={mode:value.mode,point:value.mode==='delivery_only'?null:homePickupPoint({...value,kind:value.mode},now()),
        privacyAgreement:{accepted:true,wording:HOME_FILE_AGREEMENT,at:now()}};
    } else if(step==='hours') {
      validateShopSchedule(value.schedule);
      if(value.schedule.utcOffsetMinutes!==480)fail(400,undefined,'schedule');
      saved={schedule:structuredClone(value.schedule)};
    } else if(step==='prints') {
      if(row?.steps.eligibility?.shopKind==='home_printer'&&(value.groups?.length!==1||value.groups[0]!=='documents'
        ||value.documents?.papers?.some(p=>!['short','a4','long'].includes(p))||Object.keys(value.documents?.finishing||{}).length))fail(400,'home_documents_only');
      if(!Array.isArray(value.groups)||!value.groups.length||value.groups.length>8||value.groups.some(g=>!PRINT_GROUPS.includes(g)))fail(400,undefined,'groups');
      saved={groups:[...new Set(value.groups)],...(value.groups.includes('documents')?{documents:documentCapabilities(value.documents)}:{})};
    } else fail(400,undefined,'step');
    if(!row){row={clerkUserId:claims.sub,supplierId:null,version:0,steps:{}};store.supplierSignups.push(row);}
    row.steps[step]=saved;row.version++;row.updatedAt=now();
  }
  const point=row?.steps.location?.point;
  const guides=point?(store.settings?.areaPriceGuides||[]).filter(g=>homeDistance(point,g)<=g.radiusMeters)
    .sort((a,b)=>homeDistance(point,a)-homeDistance(point,b)):[];
  return {status:200,body:{signup:signupProjection(store,row),printGroups:PRINT_GROUPS,locationConsentWording:row?.steps.eligibility?.shopKind==='home_printer'?HOME_PIN_CONSENT:LOCATION_CONSENT_WORDING,
    payoutConsentWording:PAYOUT_CONSENT_WORDING,homePickupPointConsentWording:HOME_PICKUP_POINT_CONSENT,homeFilePrivacyWording:HOME_FILE_AGREEMENT,
    onboardingSettings:supplierOnboardingSettings(store.settings),areaPriceGuides:guides.map(g=>({name:g.name,ranges:structuredClone(g.ranges)})),
    documentRates:expressRates(store.settings)},mutated:req.method==='PATCH'};
}

export async function routeSignupSetup({req,url,store,user,readBody,now,id,audit}) {
  if(url.pathname==='/me/supplier-signup/finish')return finishSignup({req,store,user,readBody,now,id,audit});
  const staff=/^\/ops\/shops\/([^/]+)\/signup$/.exec(url.pathname);
  if(!staff&&url.pathname!=='/me/supplier-signup/setup-help')return null;
  if(!user)fail(401,'unauthorized');
  if(staff) {
    if(req.method!=='GET')fail(405,'method_not_allowed');
    if(!['ops_admin','super_admin'].some(role=>user.role===role&&identityHasMembership(user,role)))fail(403,'forbidden');
    const signup=signupForShop(store,staff[1]);if(!signup)fail(404,'supplier_signup_not_found');
    return {status:200,body:{signup:signupProjection(store,signup)}};
  }
  if(req.method!=='POST')fail(405,'method_not_allowed');
  if(user.role!=='supplier'||user.shopRole==='staff')fail(403,'shop_owner_or_manager_required');
  const signup=signupForShop(store,user.id);if(!signup)fail(404,'supplier_signup_not_found');
  const body=await readBody(req);
  if(!Array.isArray(body?.fileIds)||!body.fileIds.length||body.fileIds.length>8||new Set(body.fileIds).size!==body.fileIds.length)fail(400,undefined,'fileIds');
  const files=body.fileIds.map(fileId=>{
    const file=(store.files||[]).find(f=>f.fileId===fileId&&f.ownerId===user.id&&f.purpose==='supplier_price_list'
      &&f.state==='ready'&&!f.deletedAt&&!f.deleteRequestedAt&&f.objectKey);
    if(!file)fail(400,'invalid_supplier_price_list');return file;
  });
  if(signup.steps.setupHelp) {
    if(JSON.stringify(signup.steps.setupHelp.fileIds)!==JSON.stringify(body.fileIds))fail(409,'supplier_setup_already_requested');
    return {status:200,body:{setupHelp:signup.steps.setupHelp}};
  }
  const at=now();
  signup.steps.setupHelp={status:'requested',fileIds:body.fileIds,requestedAt:at};signup.version++;signup.updatedAt=at;
  for(const file of files)(file.references||=[]).push({type:'supplier_signup',id:user.id,field:'price_list'});
  for(const m of privilegedAdminMemberships(store))(store.notifications||=[]).push({id:id('ntf'),userId:m.userId,appRole:m.role,
    type:'supplier_setup_requested',shopId:user.id,title:'Shop requests catalogue setup',body:'A shop sent a private price list for catalogue setup assistance.',at,read:false});
  audit?.(store,{actor:user,action:'supplier_signup.setup_requested',entityType:'supplier_signup',entityId:user.id,detail:{fileIds:body.fileIds}});
  queueInvalidate(store,{resource:'catalog',userIds:[user.id]});
  return {status:201,body:{setupHelp:signup.steps.setupHelp},mutated:true};
}

async function finishSignup({req,store,user,readBody,now,id,audit}) {
  if(!user)fail(401,'unauthorized');
  if(req.method!=='POST')fail(405,'method_not_allowed');
  if(user.role!=='supplier'||user.shopRole&&user.shopRole!=='owner'
    ||!(store.shopMemberships||[]).some(m=>m.shopId===user.id&&m.userId===(user.actorUserId||user.id)&&m.role==='owner'&&m.status==='active'))fail(403,'shop_owner_required');
  const signup=signupForShop(store,user.id),body=await readBody(req),at=now();
  if(!tierSignup(signup))fail(409,'supplier_signup_incomplete');
  if(body?.expectedVersion!==signup.version)fail(409,'supplier_signup_stale');
  if(signup.steps.finish)return {status:200,body:{signup:signupProjection(store,signup)}};
  const profile=(store.supplierProfiles||[]).find(p=>p.userId===user.id);
  const account=(store.supplierPayoutAccounts||[]).find(p=>p.supplierId===user.id);
  const policy=(store.supplierPayoutPolicies||[]).find(p=>p.supplierId===user.id);
  const approval=(store.approvalCases||[]).find(c=>c.userId===user.id&&c.kind==='supplier');
  if(!profile||missingShopName(profile.shopName)||!profile.shop||!profile.schedule||signup.steps.eligibility.adult!==true
    ||signup.steps.eligibility.registrantRole!=='owner'||!['pending','approved'].includes(approval?.status)
    ||!['mine','family','business'].includes(policy?.holder)||policy?.consent?.accepted!==true
    ||!(store.files||[]).some(f=>f.fileId===account?.qrFileId&&f.ownerId===user.id&&f.purpose==='supplier_payout_qr'&&f.state==='ready'&&f.objectKey&&!f.deletedAt&&!f.deleteRequestedAt))fail(409,'supplier_signup_incomplete');
  validateShopSchedule(profile.schedule);
  if(profile.homePrinter&&(!signup.steps.pickup||!profile.homePrinter.privacyAgreement?.accepted))fail(409,'supplier_signup_incomplete');
  const settings=supplierOnboardingSettings(store.settings);
  const publish=settings.autoApproveDocuments&&(approval.status==='approved'||settings.unverifiedShopsEnabled);
  const candidates=(store.catalogItems||[]).filter(i=>i.supplierId===user.id&&standardSignupDocument(store,i));
  if(!candidates.length)fail(409,'supplier_signup_incomplete');
  if(publish) {
    for(const item of candidates) {
      const service=(store.supplierServices||[]).find(s=>s.id===item.supplierServiceId&&s.supplierId===user.id);
      // Never override a review decision, private revision or staff take-down.
      if(!service||!['pending_verification','live'].includes(service.state)||service.suspendedAt||service.suspendReason
        ||item.version!==1||item.reviewStatus!=='pending'||item.approvedSnapshot||item.active===false||item.suspendedAt||item.suspendReason)fail(409,'supplier_signup_review_required');
    }
    for(const item of candidates) {
      item.reviewStatus='approved';item.reviewedAt=at;item.reviewedBy=null;item.reviewReason='standard_signup_documents';item.updatedAt=at;
      const service=store.supplierServices.find(s=>s.id===item.supplierServiceId);
      service.state='live';service.version=(service.version||1)+1;service.updatedAt=at;
    }
    profile.expressEnabled=true;
    if(profile.homePrinter) {
      profile.homePrinter.onboardingLiveAt=at;profile.homePrinter.online=true;
      profile.homePrinter.location={...profile.shop,at};
    }
  }
  signup.steps.finish={at,autoApproved:publish};signup.version++;signup.updatedAt=at;
  audit?.(store,{actor:user,action:'supplier_signup.finished',entityType:'supplier_signup',entityId:user.id,detail:{autoApproved:publish,listingIds:publish?candidates.map(i=>i.id):[]}});
  for(const m of privilegedAdminMemberships(store))(store.notifications||=[]).push({id:id('ntf'),userId:m.userId,appRole:m.role,
    type:'supplier_signup_finished',title:'Shop setup completed',body:'A shop completed setup. Verification remains separate.',shopId:user.id,at,read:false});
  queueInvalidate(store,{resource:'catalog',userIds:[user.id]});
  return {status:200,body:{signup:signupProjection(store,signup),live:publish,payoutStatus:supplierPayoutStatus(store,user.id,at)},mutated:true};
}
