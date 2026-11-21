import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadDeliveryStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { deviceAcceptsNotification } from '../src/push-outbox.js';
import { pushMessageFor } from '../src/push.js';
const DATABASE_URL=process.env.DATABASE_URL;
const headers={'x-gridgo-role':'supplier','x-gridgo-shop-id':'supplier'};
async function setup(t) {
  const db=createDatabase({DATABASE_URL});t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store=fixture();
  store.shopMemberships=[{shopId:'supplier',userId:'supplier',role:'owner',status:'active',createdAt:AT,updatedAt:AT},
    {shopId:'supplier',userId:'replacement',role:'owner',status:'active',createdAt:AT,updatedAt:AT},
    {shopId:'supplier',userId:'other',role:'staff',status:'active',createdAt:AT,updatedAt:AT}];
  await db.transaction(()=>saveStore(db,store));
  return {db,api:await apiForTest(t,{GRIDGO_FCM_SERVICE_ACCOUNT_FILE:'',GRIDGO_WEB_PUSH_VAPID_PRIVATE_KEY:''})};
}
test('status read and write enforce selected shop ownership, staff read-only, shared version, audit and persistence',{skip:!DATABASE_URL},async t=>{
  const {db,api}=await setup(t);
  assert.equal((await api(null,'GET','/me/shop-status')).status,401);
  assert.equal((await api('client','GET','/me/shop-status')).status,403);
  const read=await api('other','GET','/me/shop-status',null,{headers});
  assert.equal(read.status,200,JSON.stringify(read.body));assert.equal(read.body.nightJobs,'off');
  assert.equal((await api('other','PATCH','/me/shop-status',{expectedVersion:1,nightJobs:'all_night'},{headers})).status,403);
  const write=await api('replacement','PATCH','/me/shop-status',{expectedVersion:1,nightJobs:'all_night',expressEnabled:false,printerDemandPings:true,pause:'one_hour'},{headers});
  assert.equal(write.status,200,JSON.stringify(write.body));assert.equal(write.body.version,2);assert.ok(Date.parse(write.body.pausedUntil)>Date.now());
  assert.equal((await api('supplier','PATCH','/me/express-settings',{expectedVersion:1,expressEnabled:true})).status,409);
  assert.equal((await api('supplier','PATCH','/me/shop-status',{expectedVersion:2,nightJobs:'invalid'})).status,400);
  let store=await loadStore(db),profile=store.supplierProfiles.find(p=>p.userId==='supplier');
  assert.equal(profile.availability.nightJobs,'all_night');assert.equal(profile.expressEnabled,false);
  assert.ok(store.auditLog.some(a=>a.action==='shop.status_updated'&&a.actorId==='replacement'));
  // The legacy profile writer lists only its known columns and leaves metadata intact.
  await db.query(`INSERT INTO supplier_profiles(user_id,shop_name,contact_name,shop_lat,shop_lng,shop_label,pickup_available,is_closed,express_enabled,schedule,version,updated_at)
    SELECT user_id,shop_name,contact_name,shop_lat,shop_lng,shop_label,pickup_available,is_closed,express_enabled,schedule,version,updated_at FROM supplier_profiles WHERE user_id='supplier'
    ON CONFLICT(user_id) DO UPDATE SET shop_name=EXCLUDED.shop_name`);
  store=await loadStore(db);assert.deepEqual(store.supplierProfiles.find(p=>p.userId==='supplier').availability,profile.availability);
  const resume=await api('supplier','PATCH','/me/shop-status',{expectedVersion:2,pause:null,expressEnabled:true});assert.equal(resume.status,200,JSON.stringify(resume.body));
  assert.equal(resume.body.pausedUntil,null);
  assert.equal((await api('supplier','GET','/me/supplier-profile')).body.profile?.availability,undefined);
});
test('night demand push rechecks expiry, opt-out and owner access after durable reload; provider TTL ends at night deadline',{skip:!DATABASE_URL},async t=>{
  const {db}=await setup(t),at='2026-11-23T19:00:00+08:00',expiresAt='2026-11-23T21:00:00+08:00';
  const store=await loadStore(db),profile=store.supplierProfiles.find(p=>p.userId==='supplier');
  profile.availability={nightJobs:'until_21',printerDemandPings:true,demandPings:[{night:'2026-11-23',clientId:'client',at}]};
  const notice={id:'night_ping',userId:'replacement',shopId:'supplier',appRole:'supplier',type:'printer_demand',night:'2026-11-23',expiresAt,at,title:'Nearby printing demand',body:'A nearby client needs a printer'};
  store.notifications.push(notice);await db.transaction(()=>saveStore(db,store));
  const loaded=await loadDeliveryStore(db,{userIds:['replacement'],notificationIds:[notice.id]}),device={userId:'replacement',appRole:'supplier',platform:'android'};
  assert.equal(deviceAcceptsNotification(loaded,device,loaded.notifications[0],at),true);
  assert.equal(deviceAcceptsNotification(loaded,device,loaded.notifications[0],expiresAt),false);
  const message=pushMessageFor(notice,{}, {at});assert.equal(message.ttlSeconds,7200);assert.equal(message.expiresAt,expiresAt);
  assert.deepEqual(Object.keys(message.data).sort(),['at','notificationId','type']);
  loaded.supplierProfiles.find(p=>p.userId==='supplier').availability.printerDemandPings=false;
  assert.equal(deviceAcceptsNotification(loaded,device,loaded.notifications[0],at),false);
});
test('concurrent client demand commits a durable per-shop nightly budget across two API processes',{skip:!DATABASE_URL},async t=>{
  const {db,api}=await setup(t),otherApi=await apiForTest(t,{GRIDGO_FCM_SERVICE_ACCOUNT_FILE:'',GRIDGO_WEB_PUSH_VAPID_PRIVATE_KEY:''});
  const store=await loadStore(db);
  store.taxonomy.categories.push({id:'document_category',code:'document_publication',name:'Documents',active:true});
  store.taxonomy.subcategories.push({id:'document_family',code:'document_printing',categoryCode:'document_publication',name:'Document printing',active:true});
  for(const service of store.supplierServices)service.categoryCode='document_publication';
  for(const item of store.catalogItems)Object.assign(item,{express:true,pricingUnit:'per_page',subcategoryCode:'document_printing',turnaroundMode:'override',turnaroundMinutes:1,turnaroundHours:1/60,printLayouts:['fit_to_paper']});
  const local=new Date(Date.now()+480*60000),openMinute=(local.getUTCHours()*60+local.getUTCMinutes()+720)%1439;
  for(const profile of store.supplierProfiles) {
    profile.schedule={utcOffsetMinutes:480,week:[0,1,2,3,4,5,6].map(weekday=>({weekday,opensMinute:openMinute,closesMinute:openMinute+1})),closures:[]};
    profile.availability={nightJobs:'all_night',printerDemandPings:profile.userId==='supplier'};
  }
  for(let n=1;n<=4;n++) {
    store.users.push({id:`demand_${n}`,clerkUserId:`clerk_demand_${n}`,role:'client',email:`demand_${n}@example.invalid`,name:'Client',accountType:'individual',createdAt:AT});
    store.userRoleMemberships.push({userId:`demand_${n}`,role:'client',createdAt:AT});
    store.clientProfiles.push({userId:`demand_${n}`,clientKind:'personal',updatedAt:AT});
  }
  await db.transaction(()=>saveStore(db,store));
  const body={location:{lat:7.06,lng:125.6},fulfillmentMode:'pickup'};
  assert.equal((await api('supplier','POST','/express/demand',body)).status,403);
  const responses=await Promise.all([1,2,3,4].map((n)=>(n%2?api:otherApi)(`demand_${n}`,'POST','/express/demand',body)));
  for(const response of responses)assert.deepEqual(response.body,{ok:true},JSON.stringify(response));
  const loaded=await loadStore(db),pings=loaded.supplierProfiles.find(p=>p.userId==='supplier').availability.demandPings;
  assert.equal(pings.length,3);assert.equal(loaded.notifications.filter(n=>n.type==='printer_demand').length,6);
  assert.equal(loaded.notifications.filter(n=>n.type==='ops_printer_demand'&&n.userId==='admin').length,3);
  assert.equal(loaded.notifications.filter(n=>n.type==='ops_printer_demand'&&n.userId==='ops').length,3);
  const repeat=await api(pings[0].clientId,'POST','/express/demand',body);assert.deepEqual(repeat.body,{ok:true});
  assert.equal((await loadStore(db)).supplierProfiles.find(p=>p.userId==='supplier').availability.demandPings.length,3);
});
