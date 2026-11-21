import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller } from './fixtures/scheduling.js';
import { nightWindow, expressAvailability } from '../src/shop-availability.js';
import { routeShopStatus } from '../src/shop-status.js';
import { expressShopList } from '../src/express-orders.js';
import { pingPrinterDemand } from '../src/printer-demand.js';
import { availableDispatch } from '../src/dispatch-policy.js';
import { projectListingGroup } from '../src/order-match.js';
import { routeSupplierCatalog } from '../src/catalog-routes.js';
import { publicCatalogItem } from '../src/supplier-catalog.js';
import { supplierMatchBlockersFor } from '../src/supplier-eligibility.js';
const at = time => `2026-11-23T${time}:00+08:00`;
function setup() {
  const {store,client} = fixture({express:true});
  for (const item of store.catalogItems) Object.assign(item,{express:true,pricingUnit:'per_page',subcategoryCode:'document_printing',turnaroundMode:'override',turnaroundMinutes:15,turnaroundHours:0.25,printLayouts:['fit_to_paper']});
  for (const service of store.supplierServices) service.categoryCode='document_publication';
  for (const profile of store.supplierProfiles) profile.availability={nightJobs:'all_night',printerDemandPings:true};
  return {store,client,profile:store.supplierProfiles[0]};
}
function status(store,user,body,now=at('19:00'),method='PATCH') {
  let serial=0;
  return routeShopStatus({store,user,req:{method},url:new URL('http://test/me/shop-status'),readBody:async()=>body,now:()=>now,id:p=>`${p}_${++serial}`,audit:()=>{}});
}
test('separate night window starts after final close, ends exclusively at chosen time, and all night crosses midnight',()=>{
  const {store,profile}=setup();
  for(const [mode,end] of [['until_21','21:00'],['until_23','23:00']]) {
    profile.availability.nightJobs=mode;
    assert.equal(nightWindow(profile,at('17:59')),null);
    assert.ok(nightWindow(profile,at('18:00')));
    assert.equal(nightWindow(profile,at(end)),null);
    assert.equal(nightWindow(profile,'2026-11-24T00:01:00+08:00'),null);
  }
  profile.availability.nightJobs='all_night';
  assert.equal(nightWindow(profile,'2026-11-24T02:00:00+08:00').night,'2026-11-23');
  assert.equal(nightWindow(profile,'2026-11-24T08:00:00+08:00'),null);
  profile.schedule={utcOffsetMinutes:480,week:[{weekday:1,opensMinute:480,closesMinute:1000}],closures:[],weekdayOverrides:[{weekday:1,opensMinute:480,closesMinute:960}]};
  assert.ok(nightWindow(profile,at('16:00')));
  profile.schedule.closures=[{startDay:'2026-11-24',endDay:'2026-11-24'}];
  assert.equal(nightWindow(profile,'2026-11-24T02:00:00+08:00'),null);
  assert.ok(expressAvailability(profile,store.settings,at('19:00'),'pickup'));
});
test('night matching restricts to Express documents; delivery needs rider hours; bounded ready time bypasses staff calendar',()=>{
  const {store,client,profile}=setup(),location=profile.shop;
  assert.equal(expressShopList(store,client,{location,fulfillmentMode:'delivery'},at('19:00')).length,0);
  assert.equal(expressShopList(store,client,{location},at('19:00'))[0].readyAt,new Date(at('19:15')).toISOString());
  const line={catalogItemId:store.catalogItems[0].id,quantity:1,expressPrint:{colour:'bw'}};
  assert.equal(projectListingGroup(store,[line],{now:at('19:00')}).projection.promiseBy,new Date(at('19:15')).toISOString());
  profile.availability.nightJobs='until_21';
  assert.throws(()=>projectListingGroup(store,[line],{now:at('20:59')}),e=>e.code==='express_night_capacity');
  store.catalogItems[0].subcategoryCode='flyers';
  assert.ok(!expressShopList(store,client,{location},at('19:00')).some(s=>s.supplierId===profile.userId));
  store.catalogItems[0].subcategoryCode='document_printing';
  store.settings.operatingHours.schedule.week=[{weekday:1,opensMinute:480,closesMinute:1200}];
  assert.ok(expressShopList(store,client,{location,fulfillmentMode:'delivery'},at('19:00')).length);
  const order={orderType:'express',fulfillmentMode:'delivery',state:'ready_for_dispatch',expressOrder:{nightWindow:nightWindow(profile,at('19:00'))},shopClock:{schedule:{utcOffsetMinutes:480,week:[{weekday:1,opensMinute:480,closesMinute:1080}],weekdayOverrides:[{weekday:1,opensMinute:480,closesMinute:1080}],closures:[]}},operatingClock:{version:1}};
  assert.equal(availableDispatch(order,store,at('19:00')),true);
  assert.equal(availableDispatch(order,store,at('20:00')),false);
  order.fulfillmentMode='pickup';assert.equal(availableDispatch(order,store,at('19:00')),false);
});
test('pause expires at the exact hour or Manila midnight and preserves independent manual closure',async()=>{
  const {store,profile}=setup(),user={id:profile.userId,role:'supplier'};
  let response=await status(store,user,{expectedVersion:1,pause:'one_hour'},at('19:00'));
  assert.equal(response.body.hours.isOpenNow,false);
  assert.ok(supplierMatchBlockersFor(store,at('19:59'))(user.id,profile).includes('shop_closed'));
  assert.ok(!supplierMatchBlockersFor(store,at('20:00'))(user.id,profile).includes('shop_closed'));
  assert.equal(expressAvailability(profile,store.settings,at('19:59')),null);
  assert.ok(expressAvailability(profile,store.settings,at('20:00')));
  response=await status(store,user,{expectedVersion:2,pause:'today'},at('23:30'));
  assert.equal(response.body.pausedUntil,'2026-11-23T16:00:00.000Z');
  assert.ok(expressAvailability(profile,store.settings,'2026-11-24T00:00:00+08:00'));
  await status(store,user,{expectedVersion:3,temporarilyClosed:true,pause:null});
  assert.equal(expressAvailability(profile,store.settings,'2026-11-24T00:00:00+08:00'),null);
  await assert.rejects(status(store,user,{expectedVersion:1,nightJobs:'off'}),e=>e.code==='shop_profile_stale');
  await assert.rejects(status(store,{...user,shopRole:'staff'},{expectedVersion:4,pause:null}),e=>e.code==='shop_owner_required');
  assert.equal((await status(store,{...user,shopRole:'staff'},null,at('19:00'),'GET')).status,200);
});
test('printer demand requires opt-in, nearby location, active window and at most three distinct clients per night',()=>{
  const {store,client,profile}=setup();let serial=0;
  const ping=(user=client,time=at('19:00'),location=profile.shop)=>pingPrinterDemand(store,user,{location},{at:time,id:p=>`${p}_${++serial}`});
  profile.availability.printerDemandPings=false;store.supplierProfiles[1].availability.printerDemandPings=false;
  assert.equal(ping(),false);profile.availability.printerDemandPings=true;
  assert.equal(ping(client,at('17:00')),false);
  assert.equal(ping(client,at('19:00'),{lat:8,lng:126}),false);
  assert.equal(ping(),true);assert.equal(ping(),false);
  for (let n=1;n<=4;n++) ping({...client,id:`client_${n}`});
  assert.equal(store.notifications.filter(n=>n.type==='printer_demand').length,3);
  assert.equal(profile.availability.demandPings.length,3);
  assert.equal(ping({...client,id:'fourth'},'2026-11-24T01:00:00+08:00'),false);
  assert.equal(ping(client,'2026-11-24T19:00:00+08:00'),true);
  profile.availability.nightJobs='until_21';
  assert.equal(ping({...client,id:'late'},'2026-11-24T21:00:00+08:00'),false);
});
test('night Express draft and checkout snapshot immediate promises; close and delivery gates revalidate at checkout',async()=>{
  const {store,client,profile}=setup();store.version=1;
  store.files.find(f=>f.fileId==='file_art').detected={pageCount:1};
  const call=caller(store,client,at('19:00'));
  const body={supplierId:profile.userId,location:profile.shop,fulfillmentMode:'pickup',files:[{fileId:'file_art',copies:1,colour:'bw',paper:'a4',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]}]};
  const draft=await call('POST','/express/drafts',body);
  assert.equal(draft.status,201);
  const checkout=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{expressConfirmation:draft.body.confirmation,looksRight:true,payment:{method:'qr_manual',reference:'NIGHT-1',proofFileId:'file_qr'}});
  const order=store.orders.find(o=>o.id===checkout.body.order.id);
  assert.equal(order.promiseBy,new Date(at('19:15')).toISOString());
  assert.equal(order.expressOrder.nightWindow.night,'2026-11-23');
  profile.isClosed=true;
  await assert.rejects(call('POST','/express/drafts',body),e=>e.code==='express_shop_unavailable');
  profile.isClosed=false;
  await assert.rejects(call('POST','/express/drafts',{...body,fulfillmentMode:'delivery'}),e=>e.code==='express_shop_unavailable');
});
test('listing hide/show preserves prices and removing a referenced listing archives without touching order snapshots',async()=>{
  const {store,profile}=setup(),item=store.catalogItems[0],user=store.users.find(u=>u.id===profile.userId);
  const call=(method,body)=>routeSupplierCatalog({store,user,req:{method,headers:{}},url:new URL(`http://test/me/catalog-items/${item.id}`),readBody:async()=>body,id:p=>p,now:()=>at('19:00'),audit:()=>{}});
  const price=item.basePriceMinor;
  await call('PATCH',{expectedVersion:1,active:false});assert.equal(item.basePriceMinor,price);assert.equal(publicCatalogItem(store,item),null);
  await call('PATCH',{expectedVersion:2,active:true});assert.equal(item.basePriceMinor,price);assert.ok(publicCatalogItem(store,item));
  store.orderLineItems.push({id:'ordered_line',sourceCatalogItemId:item.id,orderId:'open_order',baseUnitPriceMinor:price});
  const snapshot=structuredClone(store.orderLineItems);
  await call('DELETE',{expectedVersion:3});assert.equal(item.active,false);assert.equal(item.basePriceMinor,price);assert.deepEqual(store.orderLineItems,snapshot);
});
test('night dispatch ends at the selected deadline even without weekday overrides and resumes in normal hours',()=>{
  const {store,profile}=setup();
  profile.availability.nightJobs='until_21';
  store.settings.operatingHours.schedule.week=[0,1,2,3,4,5,6].map(weekday=>({weekday,opensMinute:0,closesMinute:1440}));
  const order={orderType:'express',fulfillmentMode:'delivery',state:'ready_for_dispatch',
    expressOrder:{nightWindow:nightWindow(profile,at('19:00'))},shopClock:{schedule:{utcOffsetMinutes:480,week:[1,2,3,4,5,6].map(weekday=>({weekday,opensMinute:480,closesMinute:1080})),closures:[]}},operatingClock:{version:1}};
  assert.equal(availableDispatch(order,store,at('20:59')),true);
  assert.equal(availableDispatch(order,store,at('21:00')),false);
  assert.equal(availableDispatch(order,store,'2026-11-24T08:00:00+08:00'),true);
  profile.availability.nightJobs='all_night';
  order.expressOrder.nightWindow=nightWindow(profile,at('19:00'));
  assert.equal(availableDispatch(order,store,'2026-11-24T02:00:00+08:00'),true);
});
