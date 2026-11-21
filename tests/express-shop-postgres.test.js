import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore } from '../src/postgres-store.js';
import { resetDatabase } from './fixtures/reset-database.js';
import { fixture, AT } from './fixtures/reschedule.js';
import { apiForTest } from './fixtures/reschedule-http.js';
import { startExpressAcceptance } from '../src/express-orders.js';
const DATABASE_URL=process.env.DATABASE_URL;
async function setup(t,mode='pickup') {
 const db=createDatabase({DATABASE_URL});t.after(()=>db.close());
 await resetDatabase(db,'TRUNCATE users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
 const store=fixture(),order=store.orders[0];
 Object.assign(order,{orderType:'express',expressOrder:{version:1,originalSupplierId:'supplier',location:order.dropoff,declines:0,pickupCode:'012345',events:[],printSettings:[{fileId:'art',pages:{printed:4},copies:2}]},
  shopHandoverVersion:2,fileCheck:{status:'passed'},state:'supplier_assigned',fulfillmentMode:mode});
 if(mode==='pickup') {
  order.deliveryFeeMinor=0;order.totalMinor=order.onlineDueMinor=11000;order.payments.initial.amountMinor=11000;
  order.paymentAllocations=order.paymentAllocations.filter(p=>p.component!=='delivery_pass_through');
 }
 startExpressAcceptance(order,new Date().toISOString());
 store.files.push({fileId:'art',ownerId:'client',purpose:'artwork',state:'ready',objectKey:'client/doc.pdf',originalFilename:'doc.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',size:100,createdAt:AT,references:[{type:'order',id:'order',field:'line:line:artwork',attachedAt:AT,attachedBy:'client'}]});
 store.orderLineItems[0].artworkFileId='art';order.artworkFileIds=['art'];
 store.shopMemberships=[{shopId:'supplier',userId:'other',role:'staff',status:'active',createdAt:AT,updatedAt:AT},
  {shopId:'supplier',userId:'replacement',role:'owner',status:'active',createdAt:AT,updatedAt:AT}];
 await db.transaction(()=>saveStore(db,store));
 return {db,api:await apiForTest(t),store};
}
const headers={'x-gridgo-role':'supplier','x-gridgo-shop-id':'supplier'};
test('Express readiness works directly after acceptance and through the released app chain; counter code and Staff privacy remain enforced',{skip:!DATABASE_URL},async t=>{
 const {db,api}=await setup(t);
 assert.equal((await api('other','POST','/orders/order/express/accept',{}, {headers})).status,200);
 const before=(await loadStore(db)).orders[0];
 const ready=await api('other','POST','/orders/order/transition',{state:'ready_for_dispatch'},{headers});
 assert.equal(ready.status,200,JSON.stringify(ready.body));
 assert.equal(ready.body.order.orderType,'express');assert.ok(ready.body.order.expressOrder);
 assert.equal(ready.body.order.supplierSubtotalMinor,undefined);
 assert.equal(ready.body.order.paymentClassification,'in_app');
 assert.equal(ready.body.order.expressOrder.pickupCode,undefined);
 assert.equal((await api('other','POST','/orders/order/express/pickup',{code:'999999'},{headers})).status,409);
 assert.equal((await api('other','POST','/orders/order/express/pickup',{code:'012345'},{headers})).status,200);
 const after=(await loadStore(db)).orders[0];
 assert.deepEqual(after.payoutMilestones,before.payoutMilestones);assert.deepEqual(after.payments,before.payments);
 assert.equal(after.state,'issue_window_open');
});
test('shop-wide Express settings persist, use version checks, allow delegated owners and deny Staff',{skip:!DATABASE_URL},async t=>{
 const {db,api}=await setup(t);
 const read=await api('supplier','GET','/me/express-settings');
 assert.equal(read.status,200,JSON.stringify(read.body));assert.equal(read.body.expressEnabled,true);
 assert.equal((await api('other','PATCH','/me/express-settings',{expressEnabled:false,expectedVersion:read.body.version},{headers})).status,403);
 const changed=await api('replacement','PATCH','/me/express-settings',{expressEnabled:false,expectedVersion:read.body.version},{headers});
 assert.equal(changed.status,200,JSON.stringify(changed.body));
 assert.equal((await api('supplier','PATCH','/me/express-settings',{expressEnabled:true,expectedVersion:read.body.version})).status,409);
 const loaded=await loadStore(db);assert.equal(loaded.supplierProfiles.find(p=>p.userId==='supplier').expressEnabled,false);
 assert.ok(loaded.auditLog.some(a=>a.action==='shop.express_settings_updated'&&a.actorId==='replacement'));
});
test('shop file access records survive reads, isolate user/device/job, and refuse unrelated or revoked access',{skip:!DATABASE_URL},async t=>{
 const {db,api}=await setup(t);
 const path='/orders/order/files/art/access';
 const body={jobId:'job',action:'opened',deviceId:'phone-1'};
 assert.equal((await api('client','POST',path,body)).status,403);
 const open=await api('other','POST',path,body,{headers});
 assert.equal(open.status,200,JSON.stringify(open.body));
 const appBody={action:body.action,deviceId:body.deviceId};
 assert.equal((await api('other','POST',path,appBody,{headers})).status,200);
 assert.equal((await api('other','POST',path,{...body,action:'downloaded',deviceId:'pc-1'},{headers})).status,200);
 assert.equal((await api('other','POST',path,{...body,jobId:'missing'},{headers})).status,403);
 assert.equal((await api('other','POST',path,{...body,action:'bad'},{headers})).status,400);
 const job=await api('other','GET','/orders/order',null,{headers});
 assert.equal(job.status,200,JSON.stringify(job.body));assert.equal(job.body.order.fileAccesses.length,2);
 assert.equal(job.body.order.fileAccesses.find(row=>row.action==='opened').userId,'other');
 assert.equal(job.body.order.fileAccesses.find(row=>row.action==='opened').count,2);
 assert.equal((await api('supplier','GET','/jobs')).body.jobs[0].fileAccesses.length,2);
 assert.equal((await api('client','GET','/orders/order')).body.order.fileAccesses,undefined);
 assert.equal((await api('rider','GET','/orders/order')).body.order?.fileAccesses,undefined);
 const loaded=await loadStore(db);loaded.shopMemberships.find(m=>m.userId==='other').status='removed';
 await db.transaction(()=>saveStore(db,loaded));
 assert.equal((await api('other','POST',path,body,{headers})).status,403);
});


test('released app production chain readies delivery Express while regular and held orders keep their gates',{skip:!DATABASE_URL},async t=>{
 const {db,api}=await setup(t,'delivery');
 assert.equal((await api('supplier','POST','/orders/order/express/accept',{})).status,200);
 assert.equal((await api('supplier','POST','/orders/order/transition',{state:'production'})).status,200);
 let loaded=await loadStore(db);loaded.orders[0].payoutHold=true;
 await db.transaction(()=>saveStore(db,loaded));
 assert.equal((await api('supplier','POST','/orders/order/transition',{state:'ready_for_dispatch'})).body.error,'claim_hold_active');
 loaded=await loadStore(db);loaded.orders[0].payoutHold=false;
 await db.transaction(()=>saveStore(db,loaded));
 assert.equal((await api('replacement','POST','/orders/order/transition',{state:'ready_for_dispatch'})).status,403);
 const ready=await api('supplier','POST','/orders/order/transition',{state:'ready_for_dispatch'});
 assert.equal(ready.status,200,JSON.stringify(ready.body));assert.equal(ready.body.order.state,'ready_for_dispatch');
 assert.equal(ready.body.order.shopHandover?.finished,undefined);
 // A second, ordinary fixture order must still submit finished photos and pass review.
 loaded=await loadStore(db);const regular=structuredClone(loaded.orders[0]);
 Object.assign(regular,{id:'regular',state:'production'});delete regular.orderType;delete regular.expressOrder;
 loaded.orders.push(regular);await db.transaction(()=>saveStore(db,loaded));
 assert.equal((await api('supplier','POST','/orders/regular/transition',{state:'ready_for_dispatch'})).body.error,'production_finished_required');
});

test('authorized full-file links record a device-scoped authorization without pretending it downloaded',{skip:!DATABASE_URL},async t=>{
 const {api}=await setup(t);
 let signed;
 for(let n=0;n<100;n++) {
  signed=await api('other','GET','/files/art/download-url',null,{headers:{...headers,'x-gridgo-device-id':'phone-1'}});
  if(signed.body.error!=='storage_initializing')break;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal(signed.status,200,JSON.stringify(signed.body));
 const details=await api('supplier','GET','/orders/order');
 assert.equal(details.body.order.fileAccesses.length,1);
 assert.equal(details.body.order.fileAccesses[0].action,'download_authorized');
 assert.equal(details.body.order.fileAccesses[0].deviceId,'phone-1');
});


test('active Staff can decline with normal ownership, notes, timer and work-stop authorization',{skip:!DATABASE_URL},async t=>{
 const {db,api}=await setup(t);
 let loaded=await loadStore(db);loaded.orders[0].shopRecovery={status:'requested'};
 await db.transaction(()=>saveStore(db,loaded));
 assert.equal((await api('other','POST','/orders/order/express/accept',{}, {headers})).body.error,'shop_recovery_pending');
 assert.equal((await api('other','POST','/orders/order/express/decline',{reason:'Printer unavailable'}, {headers})).body.error,'shop_recovery_pending');
 assert.equal((await api('other','POST','/orders/order/transition',{state:'ready_for_dispatch'}, {headers})).status,409);
 loaded=await loadStore(db);delete loaded.orders[0].shopRecovery;
 await db.transaction(()=>saveStore(db,loaded));
 assert.equal((await api('other','POST','/orders/order/express/decline',{}, {headers})).status,400);
 const declined=await api('other','POST','/orders/order/express/decline',{reason:'Printer unavailable'}, {headers});
 assert.equal(declined.status,200,JSON.stringify(declined.body));
 assert.equal(declined.body.expressOrder.pickupCode,undefined);
 assert.equal(declined.body.expressOrder.events,undefined);
 const after=await loadStore(db);
 assert.ok(after.auditLog.some(entry=>entry.action==='express.cancelled'&&entry.actorId==='other'));
});

test('removed original Owner with another shop membership cannot enqueue or receive an Express offer',{skip:!DATABASE_URL},async t=>{
 const {loadDeliveryStore,loadPushDeliveryStore}=await import('../src/postgres-store.js');
 const {shopNotificationDraft}=await import('../src/client-order-notifications.js');
 const {notificationVisible}=await import('../src/notifications.js');
 const {deviceAcceptsNotification,enqueueNotificationPushes,createOutboxWorker}=await import('../src/push-outbox.js');
 const {db,api}=await setup(t);
 let store=await loadStore(db);
 store.shopMemberships.push({shopId:'replacement',userId:'supplier',role:'staff',status:'active',createdAt:AT,updatedAt:AT});
 const at=new Date().toISOString();
 const device={id:'original_offer_device',userId:'supplier',platform:'android',appRole:'supplier',token:'original_offer_test_token',createdAt:at,updatedAt:at};
 store.deviceTokens.push(device);
 const notice={...shopNotificationDraft(store.orders[0]),id:'before_owner_removal',at};
 store.notifications.push(notice);
 await db.transaction(async()=>{
  await saveStore(db,store);
  assert.equal(await enqueueNotificationPushes(db,store,[notice]),1);
 });
 const removed=await api('replacement','DELETE','/me/shop-team/members/supplier',null,{headers});
 assert.equal(removed.status,200,JSON.stringify(removed.body));
 const denied=await api('supplier','GET','/orders/order',null,{headers});
 assert.equal(denied.status,403);assert.equal(denied.body.error,'shop_access_removed');
 const deliveryStore=await loadDeliveryStore(db,{userIds:['supplier'],notificationIds:[notice.id]});
 const currentNotice=deliveryStore.notifications.find(row=>row.id===notice.id);
 assert.equal(deliveryStore.shopMemberships.find(row=>row.shopId==='supplier'&&row.userId==='supplier').status,'removed');
 assert.equal(notificationVisible(deliveryStore,currentNotice,'supplier','supplier'),false);
 assert.equal(deviceAcceptsNotification(deliveryStore,device,currentNotice,at),false);
 const legacyNotice={...currentNotice};delete legacyNotice.shopId;
 assert.equal(notificationVisible(deliveryStore,legacyNotice,'supplier','supplier'),false);
 store=await loadStore(db);
 const blocked={...notice,id:'after_owner_removal'};store.notifications.push(blocked);
 await db.transaction(async()=>{
  await saveStore(db,store);
  assert.equal(await enqueueNotificationPushes(db,store,[blocked]),0);
 });
 assert.equal((await db.query('SELECT count(*)::int AS count FROM notification_push_outbox WHERE notification_id=$1',[blocked.id])).rows[0].count,0);
 const sent=[];
 await createOutboxWorker({database:db,loadStore:loadPushDeliveryStore,delivery:{configured:true,send:async(message,devices)=>{
  sent.push(message.data.type);return devices.map(d=>({deviceId:d.id,ok:true,prune:false}));
 }}})();
 assert.equal(sent.includes('shop_express_offer'),false);
 assert.equal((await db.query('SELECT status FROM notification_push_outbox WHERE notification_id=$1',[notice.id])).rows[0].status,'suppressed');
 assert.equal(deviceAcceptsNotification(deliveryStore,device,{userId:'supplier',type:'role_changed'},at),true);
});

test('demoted original account and invited Staff get safe deliverable Express offers with no duplicate rows',{skip:!DATABASE_URL},async t=>{
 const {shopNotificationDraft}=await import('../src/client-order-notifications.js');
 const {notifyShopStaff}=await import('../src/shop-team.js');
 const {loadPushDeliveryStore}=await import('../src/postgres-store.js');
 const {enqueueNotificationPushes,createOutboxWorker}=await import('../src/push-outbox.js');
 const {db,api}=await setup(t);
 const demoted=await api('replacement','PATCH','/me/shop-team/members/supplier',{role:'staff'},{headers});
 assert.equal(demoted.status,200,JSON.stringify(demoted.body));
 const store=await loadStore(db),at=new Date().toISOString();
 const baseline=structuredClone(store);const notice={...shopNotificationDraft(store.orders[0]),id:'demoted_original_offer',at};
 store.notifications.push(notice);
 for(const userId of ['supplier','other','replacement'])store.deviceTokens.push({id:`offer_${userId}`,userId,platform:'android',appRole:'supplier',token:`offer_test_${userId}`,createdAt:at,updatedAt:at});
 let serial=0;const options={id:()=>`demoted_copy_${++serial}`};
 notifyShopStaff(store,baseline,options);notifyShopStaff(store,baseline,options);
 const offers=store.notifications.filter(n=>n.type==='shop_express_offer');assert.equal(offers.length,3);
 await db.transaction(async()=>{
  await saveStore(db,store);assert.equal(await enqueueNotificationPushes(db,store,offers),3);
 });
 for(const userId of ['supplier','other','replacement']) {
  const inbox=await api(userId,'GET','/notifications',null,{headers});
  assert.equal(inbox.status,200,JSON.stringify(inbox.body));
  const visible=inbox.body.notifications.filter(n=>n.type==='shop_express_offer');
  assert.equal(visible.length,1,userId);
  if(userId==='replacement')assert.match(visible[0].title,/PHP 100\.00/);
  else assert.doesNotMatch(JSON.stringify(visible[0]),/PHP|100\.00|earningsMinor/);
 }
 const deliveries=[];
 await createOutboxWorker({database:db,loadStore:loadPushDeliveryStore,delivery:{configured:true,send:async(message,devices)=>{
  for(const d of devices)deliveries.push({userId:d.userId,...message});
  return devices.map(d=>({deviceId:d.id,ok:true,prune:false}));
 }}})();
 const delivered=deliveries.filter(message=>message.data.type==='shop_express_offer');assert.equal(delivered.length,3);
 for(const message of delivered)if(message.userId==='replacement')assert.match(message.title,/PHP 100\.00/);else assert.doesNotMatch(message.title,/PHP|100\.00/);
});

test('reopened Express production projects photo-free readiness to Owners and Staff without changing rider handover',{skip:!DATABASE_URL},async t=>{
 const {api}=await setup(t,'delivery');
 assert.equal((await api('other','POST','/orders/order/express/accept',{}, {headers})).status,200);
 assert.equal((await api('other','POST','/orders/order/transition',{state:'production'}, {headers})).status,200);
 for(const userId of ['supplier','other']) {
  const read=await api(userId,'GET','/orders/order',null,{headers});assert.equal(read.status,200,JSON.stringify(read.body));
  const order=read.body.order;
  assert.equal(order.orderType,'express');assert.equal(order.state,'production');
  assert.equal(order.expressOrder.status,'printing');assert.equal(order.handoverFlow,'rider_packs');
  assert.equal(order.transitionReadiness.ready_for_dispatch.allowed,true);
  assert.deepEqual(order.transitionReadiness.ready_for_dispatch.missing,[]);
  assert.equal(order.transitionReadiness.ready_for_dispatch.receiptScan.required,false);
  assert.equal(order.shopHandover.finished,undefined);
 }
});
