import {fixture,AT} from './reschedule.js';
import {resetDatabase} from './reset-database.js';
import {saveStore} from '../../src/postgres-store.js';

export async function setupVerification(db,configure=()=>{}) {
  await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories RESTART IDENTITY CASCADE');
  const store=fixture(),now=new Date().toISOString();
  store.settings.supplierVerification={payoutCapMinor:4000,windowDays:30};
  store.userRoleMemberships.find(m=>m.userId==='supplier').createdAt=now;
  Object.assign(store.approvalCases.find(c=>c.userId==='supplier'),{status:'pending',createdAt:now,decidedAt:null});
  store.users.find(u=>u.id==='supplier').verificationStatus='pending';
  store.taxonomy.categories.push({id:'documents',code:'document_publication',name:'Documents',active:true});
  store.supplierServices.push({...store.supplierServices[0],id:'documents',categoryCode:'document_publication',state:'live'});
  const order=store.orders[0];order.readyBy=new Date(Date.now()+86400000).toISOString();order.promisedDate=order.readyBy;
  order.payoutMilestones[0].pofFileIds=['proof'];
  store.files.push({fileId:'proof',ownerId:'supplier',purpose:'fulfilment_proof',state:'ready',objectKey:'proof',originalFilename:'proof.png',size:100,
    declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[{type:'order',id:'order',field:'pofFileIds',milestoneCode:'production_started'}]});
  store.files.push({fileId:'id-selfie',ownerId:'supplier',purpose:'verification_document',state:'ready',objectKey:'verification/id-selfie',originalFilename:'id-selfie.png',size:100,
    declaredContentType:'image/png',detectedContentType:'image/png',createdAt:AT,references:[]});
  store.shopMemberships.push({shopId:'supplier',userId:'other',role:'staff',status:'active',createdAt:AT,updatedAt:AT});
  await configure(store);
  await db.transaction(()=>saveStore(db,store));
}
