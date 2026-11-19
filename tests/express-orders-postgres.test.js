import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore} from '../src/postgres-store.js';
import {resetDatabase} from './fixtures/reset-database.js';
import {fixture,actors,id,AT} from './fixtures/reschedule.js';
import {defaultTaxonomy} from '../src/taxonomy.js';
import {routeOrderMatch} from '../src/order-match-routes.js';
import {startExpressAcceptance,declineExpress} from '../src/express-orders.js';
import {awardExpressFriendPass} from '../src/express-rewards.js';

test('Express checkout, reassignment and dynamic reward survive PostgreSQL round trips', {skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase({DATABASE_URL:process.env.DATABASE_URL});t.after(()=>db.close());
 await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
 const store=fixture();store.orders=[];store.orderJobs=[];store.orderLineItems=[];store.orderLineItemOptions=[];store.orderInvoices=[];
 store.taxonomy=defaultTaxonomy();
 for(const service of store.supplierServices)service.categoryCode='document_publication';
 for(const item of store.catalogItems)Object.assign(item,{subcategoryCode:'document_printing',express:true,pricingUnit:'per_page',printLayouts:['fit_to_paper']});
 store.files.push({fileId:'express_art',ownerId:'client',purpose:'artwork',state:'ready',objectKey:'client/express.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',originalFilename:'express.pdf',size:100,createdAt:AT,detected:{pageCount:4},artworkCheck:{status:'passed'},references:[]},
 {fileId:'express_qr',ownerId:'client',purpose:'payment_proof',state:'ready',objectKey:'client/qr.jpg',declaredContentType:'image/jpeg',detectedContentType:'image/jpeg',originalFilename:'qr.jpg',size:100,createdAt:AT,references:[]});
 const call=(path,body)=>routeOrderMatch({req:{method:'POST'},url:new URL(`http://test${path}`),store,user:actors.client,readBody:async()=>body,id,now:()=>AT});
 const draft=await call('/express/drafts',{supplierId:'supplier',location:{lat:7.06,lng:125.6},fulfillmentMode:'pickup',files:[{fileId:'express_art',copies:2,colour:'colour',paper:'a4',sides:'two',layout:'fit_to_paper',acceptedWarnings:[]}]});
 const placed=await call(`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'EXPRESS-PG',proofFileId:'express_qr'}});
 await db.transaction(()=>saveStore(db,store));
 let loaded=await db.transaction(()=>loadStore(db));const order=loaded.orders.find(o=>o.id===placed.body.order.id);
 assert.equal(order.supplierSubtotalMinor,4000);assert.equal(order.expressOrder.printSettings[0].copies,2);
 await assert.rejects(db.query(`UPDATE orders SET data=jsonb_set(data,'{expressOrder,pickupCode}','"999999"') WHERE id=$1`,[order.id]),/Express checkout snapshot is immutable/);
 order.state='supplier_assigned';startExpressAcceptance(order,AT);
 declineExpress(loaded,order,{at:AT,id,kind:'declined'});
 assert.equal(order.supplierId,'replacement');
 await db.transaction(()=>saveStore(db,loaded));
 loaded=await db.transaction(()=>loadStore(db));assert.equal(loaded.orders[0].expressOrder.declines,1);
 // Existing tester attribution identifies the two recipients; the reward has no fixed face value.
 loaded.testerInviteCodes=[{clientId:'other',code:'EXPRESSCODE',createdAt:AT}];
 loaded.testerInvites=[{id:'express_invite',inviterId:'other',clientId:'client',code:'EXPRESSCODE',email:'client@example.invalid',createdAt:AT,matchedAt:AT,unmatchedReason:null}];
 const completed=loaded.orders[0];completed.state='completed';
 assert.equal(awardExpressFriendPass(loaded,completed,{state:'issue_window_open'},{id,at:AT}),true);
 await db.transaction(()=>saveStore(db,loaded));
 loaded=await db.transaction(()=>loadStore(db));assert.equal(loaded.vouchers.filter(v=>v.data.expressDeliveryReward).length,2);
 const callLoaded=(path,body)=>routeOrderMatch({req:{method:'POST'},url:new URL(`http://test${path}`),store:loaded,user:actors.client,readBody:async()=>body,id,now:()=>AT});
 const next=await callLoaded('/express/drafts',{supplierId:'supplier',location:{lat:7.06,lng:125.6},fulfillmentMode:'delivery',dropoff:{lat:7.07,lng:125.61,label:'House'},files:[{fileId:'express_art',copies:2,colour:'bw',paper:'a4',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]}]});
 assert.ok(next.body.quote.voucherDiscountMinor>0);
 const second=await callLoaded(`/me/carts/${next.body.cartId}/checkout`,{looksRight:true,expressConfirmation:next.body.confirmation,payment:{method:'qr_manual',reference:'EXPRESS-PG-2',proofFileId:'express_qr'}});
 const paid=loaded.orders.find(o=>o.id===second.body.order.id);
 assert.equal(paid.voucherServiceFeeMinor,0);assert.equal(paid.voucherDeliveryMinor,next.body.quote.voucherDiscountMinor);
 await db.transaction(()=>saveStore(db,loaded));
 const {confirmVoucher}=await import('../src/vouchers.js');
 paid.payments.initial.status='confirmed';confirmVoucher(loaded,[paid],{id,at:AT,actorId:'client'});
 await db.transaction(()=>saveStore(db,loaded));
 const final=await db.transaction(()=>loadStore(db));
 assert.equal(final.vouchers.find(v=>v.id===paid.voucher.id).status,'used');
 assert.equal(final.voucherRedemptions.filter(r=>r.voucherId===paid.voucher.id).length,1);
});

test('Express HTTP settings handshake, per-user flags and shop acceptance are authorized and committed', {skip:!process.env.DATABASE_URL},async t=>{
 const {apiForTest}=await import('./fixtures/reschedule-http.js');
 const db=createDatabase({DATABASE_URL:process.env.DATABASE_URL});t.after(()=>db.close());
 await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
 const store=fixture(),order=store.orders[0];
 Object.assign(order,{state:'supplier_assigned',orderType:'express',fileCheck:{status:'passed'},expressOrder:{version:1,originalSupplierId:'supplier',location:order.dropoff,declines:0,pickupCode:'012345',events:[]}});
 // Keep the HTTP test's clock independent of its dated fixture.
 startExpressAcceptance(order,new Date().toISOString());
 await db.transaction(()=>saveStore(db,store));
 const api=await apiForTest(t);
 assert.equal((await api(null,'GET','/me/express-guide')).status,401);
 assert.equal((await api('rider','PATCH','/me/express-guide',{action:'guide_completed'})).status,403);
 const guide=await api('client','PATCH','/me/express-guide',{action:'guide_completed'});
 assert.equal(guide.status,200,JSON.stringify(guide.body));assert.equal(guide.body.guide.guideCompleted,true);
 const other=await api('other','GET','/me/express-guide');assert.equal(other.body.guide.guideCompleted,false);
 const settings=await api('admin','GET','/settings');const version=settings.body.version;
 assert.equal((await api('admin','PATCH','/settings',{expectedVersion:version,reason:'Invalid',expressRates:null})).status,400);
 assert.equal((await api('ops','PATCH','/settings',{expectedVersion:version,reason:'No',expressRates:{bwMinor:350,colourMinor:600}})).status,403);
 const rates=await api('admin','PATCH','/settings',{expectedVersion:version,reason:'Express rate test',expressRates:{bwMinor:350,colourMinor:600}});
 assert.equal(rates.status,200,JSON.stringify(rates.body));
 assert.equal((await api('admin','PATCH','/settings',{expectedVersion:version,reason:'Stale',expressRates:{bwMinor:400,colourMinor:600}})).status,409);
 assert.equal((await api('client','GET','/settings')).body.settings.expressRates,undefined);
 assert.equal((await api('replacement','POST','/orders/order/express/accept',{})).status,403);
 const accepted=await api('supplier','POST','/orders/order/express/accept',{});
 assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.state,'payment_authorized');
 const loaded=await loadStore(db);assert.equal(loaded.orders[0].shopAcceptance.status,'accepted');
 assert.equal(loaded.users.find(u=>u.id==='client').expressGuide.guideCompleted,true);
 assert.ok(loaded.auditLog.some(a=>a.action==='express.accepted'));
 for(const userId of ['ops','admin'])assert.ok(loaded.notifications.some(n=>n.userId===userId&&n.type==='express_order'));
});

for (const kind of ['declined', 'timed_out']) {
 test(`Express terminal ${kind} commits and later shop acceptance sweeps keep working`, {skip:!process.env.DATABASE_URL}, async t=>{
  const {expireShopAcceptances}=await import('../src/shop-recovery.js');
  const db=createDatabase({DATABASE_URL:process.env.DATABASE_URL});t.after(()=>db.close());
  await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
  const store=fixture();store.taxonomy=defaultTaxonomy();
  for(const service of store.supplierServices)service.categoryCode='document_publication';
  for(const item of store.catalogItems)Object.assign(item,{subcategoryCode:'document_printing',express:true,pricingUnit:'per_page',printLayouts:['fit_to_paper']});
  const first=store.orders[0];
  Object.assign(first,{state:'supplier_assigned',orderType:'express',fileCheck:{status:'passed'},
   expressOrder:{version:1,originalSupplierId:'supplier',location:first.dropoff,pickupCode:'012345',events:[],
    declines:kind==='declined'?2:0,declinedSupplierIds:kind==='timed_out'?['replacement']:[],printSettings:[]}});
  startExpressAcceptance(first,AT);
  const second=structuredClone(first);
  Object.assign(second,{id:'second_order',supplierId:'replacement',fulfillmentMode:'pickup',deliveryFeeMinor:0,totalMinor:11000,onlineDueMinor:11000});
  second.payments.initial.amountMinor=11000;
  second.paymentAllocations=second.paymentAllocations.filter(allocation=>allocation.component!=='delivery_pass_through');
  Object.assign(second.expressOrder,{originalSupplierId:'replacement',declines:0,declinedSupplierIds:[],pickupCode:'123456'});
  startExpressAcceptance(second,'2026-10-05T00:01:00.000Z');
  store.orders.push(second);
  await db.transaction(()=>saveStore(db,store));
  // Use the same load -> expiry -> save transaction as the lifecycle worker.
  await db.transaction(async()=>{
   const current=await loadStore(db),order=current.orders.find(o=>o.id===first.id);
   if(kind==='declined')declineExpress(current,order,{at:'2026-10-05T00:04:00.000Z',id,kind,actorId:'supplier',reason:'Printer unavailable'});
   else assert.equal(expireShopAcceptances(current,{at:'2026-10-05T00:05:00.000Z',createId:id}),true);
   await saveStore(db,current);
  });
  let loaded=await loadStore(db),cancelled=loaded.orders.find(o=>o.id===first.id);
  assert.equal(cancelled.state,'cancelled');
  assert.equal(cancelled.cancelledBy,null);
  assert.equal(cancelled.cancellationReason,'No Express shop accepted the order.');
  assert.equal(cancelled.expressOrder.refundRequired,true);
  assert.equal(loaded.orderJobs.find(j=>j.orderId===first.id).state,'cancelled');
  assert.equal(cancelled.expressOrder.events.at(-1).state,'cancelled');
  assert.ok(loaded.auditLog.some(a=>a.orderId===first.id&&a.action==='express.cancelled'));
  assert.ok(loaded.notifications.some(n=>n.orderId===first.id&&n.type==='express_order'));
  assert.equal(loaded.orders.find(o=>o.id===second.id).shopAcceptance.status,'pending');
  // A later sweep must commit another shop's timeout and replacement too.
  await db.transaction(async()=>{
   const current=await loadStore(db);
   assert.equal(expireShopAcceptances(current,{at:'2026-10-05T00:06:00.000Z',createId:id}),true);
   await saveStore(db,current);
  });
  loaded=await loadStore(db);
  const moved=loaded.orders.find(o=>o.id===second.id);
  assert.equal(moved.supplierId,'supplier');
  assert.equal(moved.expressOrder.declines,1);
  assert.ok(moved.expressOrder.events.some(event=>event.state==='timed_out'));
  assert.equal(moved.shopAcceptance.deadlineAt,'2026-10-05T00:11:00.000Z');
 });
}
