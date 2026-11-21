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
test('persisted ping budgets survive midnight hours edits and restores without resetting either night', {skip:!DATABASE_URL}, async t=>{
  const {routeShopHours}=await import('../src/shop-hours.js');
  const {defaultShopSchedule}=await import('../src/availability.js');
  const {pingPrinterDemand}=await import('../src/printer-demand.js');
  const {id}=await import('./fixtures/reschedule.js');
  const {db}=await setup(t),at='2026-11-24T02:00:00+08:00';
  const initial=await loadStore(db);
  initial.taxonomy.categories.push({id:'night_documents',code:'document_publication',name:'Documents',active:true});
  initial.taxonomy.subcategories.push({id:'night_document_family',code:'document_printing',categoryCode:'document_publication',name:'Document printing',active:true});
  for(const service of initial.supplierServices)service.categoryCode='document_publication';
  for(const item of initial.catalogItems)Object.assign(item,{express:true,pricingUnit:'per_page',subcategoryCode:'document_printing',turnaroundMode:'override',turnaroundMinutes:1,turnaroundHours:1/60,printLayouts:['fit_to_paper']});
  for(const profile of initial.supplierProfiles) {
    profile.schedule=defaultShopSchedule();profile.availability={nightJobs:'all_night',printerDemandPings:profile.userId==='supplier'};
  }
  for(const userId of ['third_client','fourth_client']) {
    initial.users.push({id:userId,clerkUserId:`clerk_${userId}`,role:'client',email:[userId,'example.invalid'].join('@'),name:'Client',accountType:'individual',createdAt:AT});
    initial.userRoleMemberships.push({userId,role:'client',createdAt:AT});initial.clientProfiles.push({userId,clientKind:'personal',updatedAt:AT});
  }
  await db.transaction(()=>saveStore(db,initial));
  const ping=userId=>db.transaction(async()=>{
    const store=await loadStore(db);
    const result=pingPrinterDemand(store,store.users.find(u=>u.id===userId),{location:{lat:7.06,lng:125.6}},{at,id});
    await saveStore(db,store);return result;
  });
  const hours=schedule=>db.transaction(async()=>{
    const store=await loadStore(db),profile=store.supplierProfiles.find(p=>p.userId==='supplier');
    const result=await routeShopHours({store,user:store.users.find(u=>u.id==='supplier'),req:{method:'PATCH'},url:new URL('http://test/me/shop-hours'),
      readBody:async()=>({expectedVersion:profile.version||1,schedule}),now:()=>at,id,audit:()=>{}});
    assert.equal(result.status,200);await saveStore(db,store);
  });
  const early={utcOffsetMinutes:480,week:[0,1,2,3,4,5,6].map(weekday=>({weekday,opensMinute:0,closesMinute:60})),closures:[]};
  assert.equal(await ping('client'),true);
  await hours(early);assert.equal(await ping('other'),true);
  await hours(defaultShopSchedule());assert.equal(await ping('client'),false);
  assert.equal(await ping('other'),true);assert.equal(await ping('third_client'),true);assert.equal(await ping('fourth_client'),false);
  await hours(early);assert.equal(await ping('other'),false);assert.equal(await ping('third_client'),true);
  await hours(defaultShopSchedule());assert.equal(await ping('client'),false);assert.equal(await ping('fourth_client'),false);
  const loaded=await loadStore(db),history=loaded.supplierProfiles.find(p=>p.userId==='supplier').availability.demandPings;
  assert.equal(history.filter(p=>p.night==='2026-11-23').length,3);
  assert.equal(history.filter(p=>p.night==='2026-11-24').length,2);
  assert.equal(loaded.notifications.filter(n=>n.type==='printer_demand'&&n.userId==='supplier'&&n.night==='2026-11-23').length,3);
});
test('outbox retries cap mobile and browser transport expiry at shortened night hours without extending issued deadlines', {skip:!DATABASE_URL}, async t=>{
  const {createECDH}=await import('node:crypto');
  const {createOutboxWorker}=await import('../src/push-outbox.js');
  const {loadPushDeliveryStore}=await import('../src/postgres-store.js');
  const {createWebPushDelivery}=await import('../src/web-push.js');
  const {routeShopStatus}=await import('../src/shop-status.js');
  const {manilaDay}=await import('../src/shop-availability.js');
  const {id}=await import('./fixtures/reschedule.js');
  const db=createDatabase({DATABASE_URL});t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const night=manilaDay(new Date(Date.now()+86400000).toISOString()),instant=time=>`${night}T${time}:00+08:00`;
  const store=fixture(),profile=store.supplierProfiles.find(p=>p.userId==='supplier');
  profile.availability={nightJobs:'until_23',printerDemandPings:true};
  profile.schedule={utcOffsetMinutes:480,week:[0,1,2,3,4,5,6].map(weekday=>({weekday,opensMinute:480,closesMinute:1080})),closures:[]};
  store.shopMemberships=[{shopId:'supplier',userId:'supplier',role:'owner',status:'active',createdAt:AT,updatedAt:AT}];
  for(const platform of ['android','ios'])store.deviceTokens.push({id:`retry_${platform}`,userId:'supplier',platform,appRole:'supplier',token:`retry_test_${platform}`,createdAt:AT,updatedAt:AT});
  const notice={id:'retry_night_ping',userId:'supplier',shopId:'supplier',appRole:'supplier',type:'printer_demand',night,expiresAt:instant('23:00'),at:instant('19:00'),title:'Nearby printing demand',body:'A nearby client needs a printer'};
  store.notifications.push(notice);
  const key=createECDH('prime256v1');key.generateKeys();
  await db.transaction(async()=>{
    await saveStore(db,store);
    await db.query("INSERT INTO web_push_subscriptions(id,endpoint,p256dh,auth,user_id) VALUES('retry_web',$1,$2,$3,'supplier')",
      ['https://fcm.googleapis.com/fcm/send/night-retry',key.getPublicKey().toString('base64url'),Buffer.alloc(16).toString('base64url')]);
    for(const platform of ['android','ios'])await db.query('INSERT INTO notification_push_outbox(notification_id,device_id,user_id) VALUES($1,$2,$3)',[notice.id,`retry_${platform}`,'supplier']);
    await db.query("INSERT INTO notification_push_outbox(notification_id,web_subscription_id,user_id) VALUES($1,'retry_web','supplier')",[notice.id]);
  });
  let clock=Date.parse(instant('19:00')),succeed=false;
  const mobile=[],browser=[];
  const webDelivery=createWebPushDelivery({vapid:{publicKey:'test',privateKey:'test',subject:'https://example.invalid'},sendNotification:async(_subscription,_payload,options)=>{
    browser.push(options.TTL);if(!succeed)throw {statusCode:503};
  }});
  const drain=createOutboxWorker({database:db,loadStore:loadPushDeliveryStore,clock:()=>clock,webDelivery,delivery:{configured:true,send:async(message,[device])=>{
    mobile.push({platform:device.platform,...message});return [{ok:succeed,prune:false,code:succeed?null:'transport_error'}];
  }}});
  const setMode=mode=>db.transaction(async()=>{
    const current=await loadStore(db),shop=current.supplierProfiles.find(p=>p.userId==='supplier');
    await routeShopStatus({store:current,user:current.users.find(u=>u.id==='supplier'),req:{method:'PATCH'},url:new URL('http://test/me/shop-status'),
      readBody:async()=>({expectedVersion:shop.version||1,nightJobs:mode}),now:()=>new Date(clock).toISOString(),id,audit:()=>{}});
    await saveStore(db,current);
  });
  const retry=()=>db.query("UPDATE notification_push_outbox SET status='pending',next_attempt_at=now() WHERE notification_id=$1",[notice.id]);
  await drain();assert.equal(mobile.length,2);assert.deepEqual(browser,[3600]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM notification_push_outbox WHERE notification_id=$1 AND status='pending' AND attempts=1",[notice.id])).rows[0].count,3);
  clock=Date.parse(instant('20:59'));await setMode('until_21');succeed=true;await retry();await drain();
  assert.equal(mobile.length,4);
  for(const message of mobile.slice(2)) {assert.equal(message.ttlSeconds,60);assert.equal(Date.parse(message.expiresAt),Date.parse(instant('21:00')));}
  assert.deepEqual(browser,[3600,60]);
  assert.equal((await loadStore(db)).notifications.find(n=>n.id===notice.id).expiresAt,notice.expiresAt);
  clock=Date.parse(instant('22:59'));await setMode('all_night');await retry();await drain();
  assert.equal(mobile.length,6);
  for(const message of mobile.slice(4)) {assert.equal(message.ttlSeconds,60);assert.equal(Date.parse(message.expiresAt),Date.parse(instant('23:00')));}
  assert.deepEqual(browser,[3600,60,60]);
});
