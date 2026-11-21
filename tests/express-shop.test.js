import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, AT } from './fixtures/reschedule.js';
import { productionTransitionReadiness } from '../src/job-readiness.js';
import { shopNotificationDraft } from '../src/client-order-notifications.js';
import { pushMessageFor, fcmRequestBody } from '../src/push.js';
import { staffRouteAllowed, notifyShopStaff } from '../src/shop-team.js';
import { publicOrderFor } from '../src/operational-model.js';
function express(store) {
 const order=store.orders[0];
 Object.assign(order,{orderType:'express',expressOrder:{version:1,events:[],printSettings:[{pages:{printed:4},copies:2}]},shopHandoverVersion:2,fileCheck:{status:'passed'},shopAcceptance:{status:'accepted'}});
 return order;
}
test('Express accepted and printing jobs can become ready without evidence; regular and held jobs cannot',()=>{
 const store=fixture(),order=express(store);
 store.settings.shopReceiptScanRequired=true;
 for(const state of ['payment_authorized','production','supplier_self_qc']) {
  order.state=state;
  assert.equal(productionTransitionReadiness(store,order,'ready_for_dispatch').allowed,true,state);
 }
 order.payoutHold=true;
 assert.equal(productionTransitionReadiness(store,order,'ready_for_dispatch').allowed,false);
 delete order.payoutHold;
 store.refundRequests=[{orderId:order.id,status:'requested',kind:'client_request'}];
 assert.equal(productionTransitionReadiness(store,order,'ready_for_dispatch').allowed,false);
 store.refundRequests=[];
 delete order.orderType; order.state='production';
 assert.equal(productionTransitionReadiness(store,order,'ready_for_dispatch').missing[0].code,'production_finished_required');
});
test('Express offer uses its category and channel with bounded work details and owner-only earnings',()=>{
 const store=fixture(),order=express(store);order.state='supplier_assigned';
 order.shopAcceptance={status:'pending',deadlineAt:'2026-10-05T00:05:00.000Z'};order.updatedAt=AT;
 const draft=shopNotificationDraft(order);
 assert.equal(draft.type,'shop_express_offer');
 const message=pushMessageFor({...draft,id:'offer',at:AT});
 assert.match(message.title,/PHP 100\.00/);assert.match(message.body,/8 pages.*rider.*5 min/i);
 assert.equal(message.androidChannelId,'gridgo_express');
 const request=fcmRequestBody(message,'test');
 assert.equal(request.message.apns.payload.aps.category,'gridgo_express_offer');
 assert.equal(request.message.android.notification.click_action,'gridgo_express_offer');
 assert.deepEqual(Object.keys(message.data).sort(),['at','notificationId','orderId','type']);
 store.notifications=[{...draft,id:'offer',at:AT}];
 store.shopMemberships=[{shopId:'supplier',userId:'other',role:'staff',status:'active'}];
 notifyShopStaff(store,{notifications:[]},{id:()=> 'staff_offer'});
 const staff=store.notifications.find(n=>n.userId==='other');
 assert.ok(staff);assert.doesNotMatch(JSON.stringify(staff),/100\.00|10000|earningsMinor/);
 assert.equal(pushMessageFor(staff).androidChannelId,'gridgo_express');
});
test('shop Staff can use Express work routes and see Express work without money',()=>{
 for(const action of ['accept','decline','pickup'])assert.equal(staffRouteAllowed('POST',`/orders/order/express/${action}`),true);
 assert.equal(staffRouteAllowed('PATCH','/me/express-settings'),false);
 const store=fixture(),order=express(store);
 const record=publicOrderFor(order,{id:'supplier',role:'supplier',shopRole:'staff'},store);
 assert.equal(record.orderType,'express');assert.ok(record.expressOrder);
 assert.equal(record.supplierSubtotalMinor,undefined);assert.equal(record.payoutMilestones,undefined);
});

test('expired and accepted offers never reach a device, and demoted owners never get earnings',async()=>{
 const {deviceAcceptsNotification}=await import('../src/push-outbox.js');
 const {notificationVisible}=await import('../src/notifications.js');
 const store=fixture(),order=express(store);order.state='supplier_assigned';
 order.shopAcceptance={status:'pending',deadlineAt:'2026-10-05T00:05:00.000Z'};order.updatedAt=AT;
 const n={...shopNotificationDraft(order),id:'offer',at:AT};
 const device={userId:'supplier',appRole:'supplier'};
 assert.equal(deviceAcceptsNotification(store,device,n,AT),true);
 assert.equal(deviceAcceptsNotification(store,device,n,'2026-10-05T00:05:00.000Z'),false);
 order.shopAcceptance.status='accepted';assert.equal(deviceAcceptsNotification(store,device,n,AT),false);
 order.shopAcceptance.status='pending';
 store.shopMemberships=[{shopId:'supplier',userId:'supplier',role:'staff',status:'active'}];
 assert.equal(notificationVisible(store,n,'supplier','supplier'),false);
});

test('Staff receive only a bounded payment method for the app payment label',()=>{
 const store=fixture(),order=express(store);
 const record=publicOrderFor(order,{id:'supplier',role:'supplier',shopRole:'staff'},store);
 assert.equal(record.paymentMethod,'qr_manual');assert.equal(record.payments,undefined);
});

test('Android Express uses Expo presentation data so the OS does not swallow category actions',()=>{
 const store=fixture(),order=express(store);order.state='supplier_assigned';order.updatedAt=AT;
 order.shopAcceptance={status:'pending',deadlineAt:'2026-10-05T00:05:00.000Z'};
 const message=pushMessageFor({...shopNotificationDraft(order),id:'offer',at:AT});
 const android=fcmRequestBody(message,'test',{platform:'android'}).message;
 assert.equal(android.notification,undefined);
 assert.equal(android.android.notification,undefined);
 assert.equal(android.data.categoryId,'gridgo_express_offer');assert.equal(android.data.channelId,'gridgo_express');
 assert.deepEqual(JSON.parse(android.data.body),message.data);
 assert.match(android.data.title,/100\.00/);assert.match(android.data.message,/8 pages/);
 assert.equal(android.android.ttl,'300s');
 const ios=fcmRequestBody(message,'test',{platform:'ios'}).message;
 assert.equal(ios.apns.payload.aps.category,'gridgo_express_offer');
 assert.deepEqual(ios.data,message.data);
});

test('a delegated owner demoted to Staff cannot receive an earlier earnings offer',async()=>{
 const {notificationVisible}=await import('../src/notifications.js');
 const store=fixture(),order=express(store);order.state='supplier_assigned';order.updatedAt=AT;
 order.shopAcceptance={status:'pending',deadlineAt:'2026-10-05T00:05:00.000Z'};
 const n={...shopNotificationDraft(order),userId:'other',shopId:'supplier',id:'old_owner_offer',at:AT};
 store.shopMemberships=[{shopId:'supplier',userId:'other',role:'staff',status:'active'}];
 assert.equal(notificationVisible(store,n,'other','supplier'),false);
});

test('Express replacement events create one detailed offer instead of a generic assignment',async()=>{
 const {deriveDomainEvents}=await import('../src/domain-events.js');
 const store=fixture(),order=express(store),before=structuredClone(store);
 order.state='supplier_assigned';order.supplierId='replacement';order.updatedAt=AT;
 order.shopAcceptance={status:'pending',deadlineAt:'2026-10-05T00:05:00.000Z'};
 store.orderJobs[0].supplierId='replacement';
 let next=0;deriveDomainEvents(store,before,{createId:()=>`notification_${++next}`,at:AT});
 const offers=store.notifications.filter(n=>n.userId==='replacement'&&n.type==='shop_express_offer');
 assert.equal(offers.length,1);assert.equal(offers[0].expressOffer.pages,8);
 assert.equal(store.notifications.some(n=>n.type==='shop_job_assigned'),false);
});

test('Staff Express uses an explicit work allowlist and safe payment classification',async()=>{
 const {staffOrderProjection}=await import('../src/shop-staff-order.js');
 const record={id:'order',orderType:'express',fulfillmentMode:'pickup',
  payments:{initial:{method:'gridgo_voucher',amountMinor:12345}},
  expressOrder:{status:'accepted',acceptBy:AT,pickupCode:'012345',opaqueFutureMoney:12345,
    events:[{state:'declined',reason:'PHP 123.45'}],
    printSettings:[{fileId:'art',pages:{total:4,range:null,printed:4,amount:12345},copies:2,paper:'a4',colour:'bw',sides:'two',layout:'fit_to_paper',rateMinor:12345,opaqueFutureMoney:12345}]}};
 const result=staffOrderProjection(record);
 assert.equal(result.paymentClassification,'voucher');
 assert.equal(result.expressOrder.pickupCode,undefined);
 assert.equal(result.expressOrder.events,undefined);
 assert.equal(result.expressOrder.opaqueFutureMoney,undefined);
 assert.equal(result.expressOrder.printSettings[0].opaqueFutureMoney,undefined);
 assert.equal(result.expressOrder.printSettings[0].pages.amount,undefined);
 assert.equal(result.expressOrder.printSettings[0].pages.printed,4);
 assert.doesNotMatch(JSON.stringify(result),/12345|012345|PHP/);
});


test('unknown Staff payment methods cannot turn into a payment classification',async()=>{
 const {staffOrderProjection}=await import('../src/shop-staff-order.js');
 for (const method of ['unknown','__proto__','constructor']) {
  const result=staffOrderProjection({id:'order',payments:{initial:{method}}});
  assert.equal(result.paymentClassification,undefined);assert.equal(result.paymentMethod,undefined);
 }
});
