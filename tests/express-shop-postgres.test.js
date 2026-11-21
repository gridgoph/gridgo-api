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
 assert.equal((await api('other','POST',path,body,{headers})).status,200);
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
