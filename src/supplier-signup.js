import { homePin, HOME_PIN_CONSENT } from './home-printers.js';
import { CatalogError } from './supplier-catalog.js';
import { philippineMobileNumber } from './phone.js';
import { documentCapabilities } from './document-capabilities.js';
import { expressRates } from './express-orders.js';
import { identityHasMembership } from './authorization-context.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

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
  let nextStep=['eligibility','shop','location','prints'].find(step=>!steps[step])||'enroll';
  const profile=(store.supplierProfiles||[]).find(p=>p.userId===row?.supplierId);
  if (row?.supplierId) {
    const owner=(store.shopMemberships||[]).some(m=>m.shopId===row.supplierId&&m.role==='owner'&&m.status==='active');
    const account=(store.supplierPayoutAccounts||[]).find(a=>a.supplierId===row.supplierId);
    const policy=(store.supplierPayoutPolicies||[]).find(p=>p.supplierId===row.supplierId);
    nextStep=!profile?.homePrinter&&!profile?.schedule?'hours':!(store.shopTeamSettings||[]).some(s=>s.shopId===row.supplierId)?'team':!owner?'owner_claim'
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
  return {signup,body:{profile:{shopName:shop.shopName,contactName:shop.contactName,phone:shop.phone,location:location.point},
    serviceCategories:['document_publication']}};
}
export function completeSignupEnrollment(store,signup,supplierId,at) {
  signup.supplierId=supplierId;signup.updatedAt=at;
  if(signup.steps.eligibility.shopKind==='home_printer') {
    const profile=store.supplierProfiles.find(p=>p.userId===supplierId), location=signup.steps.location;
    profile.homePrinter={barangay:location.barangay,street:location.street,propertyType:location.propertyType,landmark:location.landmark,
      pinConsent:location.pinConsent,startedAt:at,pinChangedAt:at,online:false,consecutiveMisses:0};
    profile.supplierType='home';profile.barangay=location.barangay;profile.pickupAvailable=false;
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
    } else if(step==='prints') {
      if(row?.steps.eligibility?.shopKind==='home_printer'&&(value.groups?.length!==1||value.groups[0]!=='documents'
        ||value.documents?.papers?.some(p=>!['short','a4','long'].includes(p))||Object.keys(value.documents?.finishing||{}).length))fail(400,'home_documents_only');
      if(!Array.isArray(value.groups)||!value.groups.length||value.groups.length>8||value.groups.some(g=>!PRINT_GROUPS.includes(g)))fail(400,undefined,'groups');
      saved={groups:[...new Set(value.groups)],...(value.groups.includes('documents')?{documents:documentCapabilities(value.documents)}:{})};
    } else fail(400,undefined,'step');
    if(!row){row={clerkUserId:claims.sub,supplierId:null,version:0,steps:{}};store.supplierSignups.push(row);}
    row.steps[step]=saved;row.version++;row.updatedAt=now();
  }
  return {status:200,body:{signup:signupProjection(store,row),printGroups:PRINT_GROUPS,locationConsentWording:row?.steps.eligibility?.shopKind==='home_printer'?HOME_PIN_CONSENT:LOCATION_CONSENT_WORDING,
    payoutConsentWording:PAYOUT_CONSENT_WORDING,documentRates:expressRates(store.settings)},mutated:req.method==='PATCH'};
}

export async function routeSignupSetup({req,url,store,user,readBody,now,id,audit}) {
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
