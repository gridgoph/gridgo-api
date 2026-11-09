import { setupOperationsReads } from './operations-reads.js';
import { saveStore, loadStore } from '../../src/postgres-store.js';
import { AT, id } from './reschedule.js';
import { defaultPromotionSettings } from '../../src/promotion-settings.js';
import { claimFounding, inviteFriend } from '../../src/promotions.js';

export async function setupStaffDesks(database) {
  const store = await setupOperationsReads(database);
  store.settings.clientShopChatContactThreshold=7;
  store.staffRoles.push({ code: 'counter', name: 'Counter', canHandout: true });
  store.staffProfiles.push({ userId: 'staff', roleCode: 'counter', active: true, updatedAt: AT });
  store.staffInvites.push({ id: 'invite', codeHash: 'private-code-hash', roleCode: 'counter', createdBy: 'admin',
    createdAt: AT, expiresAt: '2030-01-01T00:00:00.000Z', redeemedBy: null, redeemedAt: null, revokedAt: null });
  const base = structuredClone(store.catalogItems.find(r => r.id === 'item_replacement'));
  for (let i=0;i<57;i++) store.catalogItems.push({ ...structuredClone(base), id: `staff_item_${String(i).padStart(3,'0')}`, name: `Print cards ${i}`,
    basePriceMinor: 100+i, updatedAt: i%2 ? AT : '2026-10-04T23:00:00.000Z', sortOrder: 100-i,
    ...(i%7 === 0 ? { productionTimeReviewReasons: ['legacy_one_working_day'] } : {}) });
  store.catalogOptionGroups.push({ id: 'A_group', catalogItemId: 'staff_item_001', name: 'Stock', required: false, selectionMode:'single', sortOrder: 1, version:1, createdAt:AT, updatedAt:AT });
  store.catalogOptions.push({ id:'unicode_option',optionGroupId:'A_group',label:' İA ΟΣ special%_ Café ',priceModifierMinor:0,active:false,sortOrder:0,createdAt:AT,updatedAt:AT });
  store.supplierProfiles.push({...structuredClone(store.supplierProfiles[0]),userId:'review_supplier',shopName:'Review shop'});
  store.supplierServices.push({...structuredClone(store.supplierServices[0]),id:'service_review',supplierId:'review_supplier'});
  store.catalogItems.push({...structuredClone(base),id:'item_review',supplierId:'review_supplier',supplierServiceId:'service_review'});
  Object.assign(store.users.find(r=>r.id==='other'),{accountType:'organization',orgName:'Fixture Organization'});
  store.organizationAccounts.push({userId:'other',nameKey:'fixture organization',schoolKey:'fixture school',name:'Fixture Organization',school:'Fixture School',currentOfficer:{id:'officer',fullName:'Fixture Officer'}});
  store.approvalCases.push({id:'case_org',userId:'other',kind:'business_client',status:'approved',version:1,applicationRevision:1,createdAt:AT,updatedAt:AT,submittedAt:AT,decidedBy:'admin',decidedAt:AT});
  store.settings.featuredPrints={version:1,catalogItemIds:['item_supplier','item_colour','missing']};
  store.seasonWindows.push({id:'season',name:'Graduation',startDate:'2026-11-01',endDate:'2026-11-30',demandLevel:'Peak',message:'Plan ahead',version:1,noticeQueuedAt:null,createdAt:AT,updatedAt:AT});
  store.staffInvites.push({ ...store.staffInvites[0], id:'old_invite', codeHash:'old-private-code-hash', expiresAt:'2026-10-06T00:00:00.000Z', redeemedBy:'staff', redeemedAt:AT });
  for (const [i,key] of ['a_active','unrelated','review'].entries()) {
    const order=store.orders.find(r=>r.id===key);
    order.rescheduleRequest={id:`request_${key}`,supplierId:order.supplierId,status:i%2?'accepted':'pending',requestedAt:AT,originalReadyBy:order.readyBy,reason:'Fixture deadline',proposedReadyBy:'2026-11-20T00:00:00.000Z'};
    order.handover={qrToken:`private-${key}`,otp:'123456',hubId:'primary',escalation:{at:AT,by:order.clientId,reason:'Mismatch'}};
    store.hubHandouts.push({id:`handout_${key}`,orderId:key,staffId:'staff',staffName:'Counter Staff',hubId:'primary',at:AT});
    store.supplierInvoices.push({orderId:key,supplierId:order.supplierId,month:'2026-10',expectedAt:AT,fileId:`supplier_invoice_${key}`,number:`INV-${i}`,date:'2026-10-05',amountMinor:10000,submittedAt:AT,updatedAt:AT,version:1,collectedAt:i%2?AT:null,collectedBy:i%2?'ops':null});
    store.orderSurveys.push({orderId:key,clientId:order.clientId,completedAt:AT,openedAt:AT,expiresAt:'2026-10-12T00:00:00.000Z',fulfillmentKind:'delivery',notifiedAt:AT,submittedAt:AT,fulfillmentStars:3+i,easeStars:4,qualityStars:4,priceFeeling:3,recommendScore:8,
      fulfillmentTags:[],easeTags:[],priceWorthTags:['print_quality'],needsFollowUp:i===0,rewardStatus:'founding_tester',directShopComparison:'about_the_same',orderAgainAtPrice:'yes'});
    store.supplierPerformanceEvents.push({id:`performance_${key}`,orderId:key,supplierId:order.supplierId,sourceKey:'finish',kind:'late_finish',at:AT,recordedAt:AT,warningCodes:['late_finish'],reason:'Fixture',workingLateMs:7200000});
    for(let j=0;j<105;j++)store.locationPings.push({id:`ping_${key}_${j}`,orderId:key,riderId:order.riderId||'rider',lat:7,lng:125,accuracy:5,at:new Date(Date.parse(AT)+j*1000).toISOString(),receivedAt:new Date(Date.parse(AT)+j*2000).toISOString()});
  }
  store.orders.find(r=>r.id==='pickup_offer').state='awaiting_collection';
  store.orders.find(r=>r.id==='pickup_offer').handover={qrToken:'private-claim',otp:'111111',hubId:'primary'};
  store.approvalCases.find(r=>r.userId==='supplier').submittedAt=AT;
  store.approvalCases.find(r=>r.userId==='rider').submittedAt=AT;
  for(const r of store.approvalCases) if(r.submittedAt) {r.decidedBy='admin';r.decidedAt=AT;}
  store.files.push({...structuredClone(store.files[0]),fileId:'rider_license',ownerId:'rider',purpose:'rider_verification_document',references:[],objectKey:'private/rider_license'});
  store.riderDocuments.push({id:'license',riderId:'rider',kind:'drivers_license',fileId:'rider_license',expiresOn:'2030-01-01',isCurrent:true,uploadedAt:AT});
  store.checkoutExitPrompts.push({id:'exit',clientId:'client',cartId:'staff_cart',reachedAt:AT,askedAt:AT,cartTotalMinor:10000,categoryCodes:['digital_printing'],reason:'price_too_high',answeredAt:AT});
  store.carts.push({id:'staff_cart',clientId:'client',state:'draft',version:1,serviceLevel:'standard',createdAt:AT,updatedAt:AT});
  store.promotionSettings=[{id:'launch',version:1,settings:defaultPromotionSettings()}];
  claimFounding(store,'other',{id,at:'2026-10-27T01:00:00.000Z'});
  inviteFriend(store,'other','friend@example.test',{id,at:'2026-10-27T01:00:00.000Z'});
  store.users.push({id:'friend',clerkUserId:'clerk_friend',email:'friend@example.test',name:'Late joining friend',role:'client',accountType:'individual',createdAt:AT},
    {id:'former_client',clerkUserId:'clerk_former',email:'former@example.test',name:'Former client',role:'supplier',verificationStatus:'approved',createdAt:AT});
  store.userRoleMemberships.push({userId:'friend',role:'client',createdAt:AT},{userId:'former_client',role:'supplier',createdAt:AT});
  store.vouchers.push({...structuredClone(store.vouchers[0]),id:'former_reward',clientId:'former_client',issuedAt:new Date().toISOString(),expiresAt:'2030-01-01T00:00:00.000Z'});
  // Unreferenced uploads, a legacy embedded payment reference and a held file
  // exercise the retention read's inverse relationships.
  for (const fileId of ['unused_retention','embedded_retention','held_retention']) store.files.push({...structuredClone(store.files[0]),fileId,objectKey:`private/${fileId}`,purpose:'artwork',references:[],createdAt:AT});
  store.orders.find(r=>r.id==='z_history').payments.initial.proofFileId='embedded_retention';
  store.issues.find(r=>r.id==='issue_a_active').photoFileIds.push('held_retention');
  store.baskets.push({id:'basket_staff',clientId:'client',receiptOrderId:'a_active',orderIds:['a_active','m_offer'],totalMinor:24000,
    fulfillmentMode:'delivery',deadline:'2026-12-01T00:00:00.000Z',payment:{method:'qr_manual',status:'confirmed',amountMinor:24000},createdAt:AT,updatedAt:AT});
  await database.transaction(()=>saveStore(database,store));
  await database.query("UPDATE supplier_catalog_items SET updated_at='2026-10-05T00:00:00.000100Z' WHERE id='staff_item_001'");
  await database.query("UPDATE supplier_catalog_items SET updated_at='2026-10-05T00:00:00.000900Z' WHERE id='staff_item_003'");
  // Threads are SQL-owned, outside the compatibility save adapter.
  await database.query("INSERT INTO client_shop_chat_threads(order_id,created_at,updated_at) VALUES ('a_active',$1,$1),('review',$1,$1)",[AT]);
  await database.query("INSERT INTO issue_reports(id,issue,category,reporter_id) VALUES ('11111111-1111-4111-8111-111111111111','Fixture report','bug','client'),('22222222-2222-4222-8222-222222222222','Review report','bug','review_client')");
  return loadStore(database);
}
