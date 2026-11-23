import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, addShop, caller } from './fixtures/scheduling.js';
import { expressShopList, declineExpress, startExpressAcceptance, publicExpress } from '../src/express-orders.js';
import { routeExpressOrders } from '../src/express-routes.js';
const AT = '2026-09-23T01:00:00.000Z';
const location = {lat:7.064,lng:125.6085};
function setup() {
  const {store,client}=fixture({express:true});
  addShop(store,'shop_c',{lat:7.13,lng:125.6085});
  addShop(store,'shop_d',{lat:7.18,lng:125.6085});
  addShop(store,'shop_e',{lat:7.25,lng:125.6085});
  for(const item of store.catalogItems) Object.assign(item,{express:true,pricingUnit:'per_page',subcategoryCode:'document_printing',printLayouts:['fit_to_paper']});
  for(const service of store.supplierServices) Object.assign(service,{categoryCode:'document_publication',turnaroundHours:1,standardTurnaroundHours:1});
  store.files.find(f=>f.fileId==='file_art').detected={pageCount:2};
  return {store,client,call:caller(store,client,AT)};
}
const files=[{fileId:'file_art',copies:1,colour:'bw',paper:'a4',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]}];
const request={location,fulfillmentMode:'delivery',dropoff:{...location,label:'Destination'},files};
test('Nearby expands to B then C only while fewer than three open printers qualify',async()=>{
  const {store,call}=setup();
  let answer=await call('POST','/express/shops',request);
  assert.deepEqual(answer.body.expandedZones,['B']);
  assert.deepEqual(answer.body.shops.map(s=>s.zone.code),['A','A','B']);
  store.supplierProfiles.find(p=>p.userId==='shop_b').isClosed=true;
  answer=await call('POST','/express/shops',request);
  assert.deepEqual(answer.body.expandedZones,['B','C']);
  assert.equal(answer.body.shops.filter(s=>s.isOpenNow).length,3);
  assert.equal(answer.body.shops.find(s=>s.supplierId==='shop_b').selectable,false);
  assert.equal(answer.body.shops.find(s=>s.supplierId==='shop_c').deliveryFeeMinor,14900);
  assert.equal(answer.body.shops.find(s=>s.supplierId==='shop_d').deliveryFeeMinor,22900);
  assert.equal(answer.body.shops.some(s=>s.supplierId==='shop_e'),false);
});
test('Just print it chooses fastest capable printer within fare permission and never selects closed shops',async()=>{
  const {store,call}=setup();
  store.supplierServices.find(s=>s.supplierId==='shop_c').turnaroundHours=0.25;
  store.supplierServices.find(s=>s.supplierId==='shop_c').standardTurnaroundHours=0.25;
  let draft=await call('POST','/express/drafts',{...request,selection:'just_print_it',fareLimit:'nearby'});
  assert.equal(draft.body.shop.zone.code,'A');
  draft=await call('POST','/express/drafts',{...request,selection:'just_print_it',fareLimit:'up_to_149'});
  assert.equal(draft.body.shop.supplierId,'shop_c');
  store.settings.deliveryFeeBands[1].feeMinor=15000;
  draft=await call('POST','/express/drafts',{...request,selection:'just_print_it',fareLimit:'up_to_149'});
  assert.equal(draft.body.shop.zone.code,'A');
  store.supplierServices.find(s=>s.supplierId==='shop_e').turnaroundHours=0.1;
  store.supplierServices.find(s=>s.supplierId==='shop_e').standardTurnaroundHours=0.1;
  draft=await call('POST','/express/drafts',{...request,selection:'just_print_it',fareLimit:'any'});
  assert.equal(draft.body.shop.supplierId,'shop_e');assert.equal(draft.body.shop.zone.key,'out_of_zone');
  store.supplierProfiles.find(p=>p.userId==='shop_c').isClosed=true;
  draft=await call('POST','/express/drafts',{...request,selection:'just_print_it',fareLimit:'any'});
  assert.notEqual(draft.body.shop.supplierId,'shop_c');
  await assert.rejects(call('POST','/express/drafts',{...request,selection:'just_print_it'}),e=>e.code==='invalid_express_fare_limit');
});
test('pickup estimates and home privacy are explicit; shop and verification filters apply',async()=>{
  const {store,client,call}=setup();
  Object.assign(store.supplierProfiles[0],{supplierType:'home',barangay:'Sample barangay',shopName:'Private name'});
  const answer=await call('POST','/express/shops',{...request,fulfillmentMode:'pickup',sort:'all_davao'});
  const home=answer.body.shops.find(s=>s.supplierId==='shop_a');
  assert.equal(home.printerType,'home');assert.equal(home.name,'Sample barangay');
  assert.equal(home.address,'Sample barangay');assert.equal(home.location,null);
  assert.equal(home.walkingTimeMinutes,0);assert.equal(home.deliveryFeeMinor,null);
  assert.equal(home.verificationLevel,'verified');
  store.supplierProfiles[0].shop.lat+=0.001;
  const rough=(await call('POST','/express/shops',{...request,fulfillmentMode:'pickup',sort:'all_davao'})).body.shops.find(s=>s.supplierId==='shop_a');
  assert.equal(rough.distanceMeters,500);assert.equal(rough.distanceApproximate,true);assert.equal(rough.walkingTimeMinutes,7);
  assert.ok(answer.body.shops.find(s=>s.supplierId==='shop_b').walkingTimeMinutes>0);
  const filtered=await call('POST','/express/shops',{...request,shopsOnly:true,verifiedOnly:true,sort:'all_davao'});
  assert.equal(filtered.body.shops.some(s=>s.printerType==='home'),false);
  assert.ok(filtered.body.shops.every(s=>s.verified));
  assert.equal(expressShopList(store,client,{location},AT).find(shop=>shop.supplierId==='shop_a').location,null);
});
test('A3 is quoted at shop price, requires a new pick after decline, and has a five minute payment deadline',async()=>{
  const {store,client,call}=setup();
  for(const item of store.catalogItems) {
    store.catalogOptionGroups.push({id:`size_${item.id}`,catalogItemId:item.id,name:'Size',kind:'spec',required:true});
    store.catalogOptions.push({id:`a3_${item.id}`,optionGroupId:`size_${item.id}`,label:'A3',specBinding:{fieldCode:'size',value:'A3'},active:true,priceModifierMinor:0});
  }
  store.catalogItems[0].basePriceMinor=1000;store.catalogItems[1].basePriceMinor=500;
  const a3={...request,fulfillmentMode:'pickup',files:[{...files[0],paper:'a3'}]};
  const list=await call('POST','/express/shops',{...a3,sort:'lowest_price'});
  assert.equal(list.body.shops[0].supplierId,'shop_b');
  await assert.rejects(call('POST','/express/drafts',{...a3,selection:'just_print_it',fareLimit:'any'}),e=>e.code==='express_manual_selection_required');
  const draft=await call('POST','/express/drafts',{...a3,supplierId:'shop_a'});
  assert.equal(draft.body.paymentTiming,'after_acceptance');
  const placed=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation});
  const order=store.orders.find(o=>o.id===placed.body.order.id);
  order.state='supplier_assigned';order.fileCheck={status:'passed'};startExpressAcceptance(order,AT);
  const money=order.totalMinor;
  declineExpress(store,order,{at:AT,id:p=>p});
  assert.equal(order.state,'cancelled');assert.equal(order.supplierId,'shop_a');assert.equal(order.totalMinor,money);
  assert.equal(publicExpress(order,client).repickRequired,true);
  order.state='supplier_assigned';startExpressAcceptance(order,AT);
  await routeExpressOrders({req:{method:'POST'},url:new URL(`http://test/orders/${order.id}/express/accept`),store,user:{id:'shop_a',role:'supplier'},readBody:async()=>({}),id:p=>p,now:()=>AT});
  assert.equal(order.expressOrder.payBy,'2026-09-23T01:05:00.000Z');
  const {assertExpressPaymentSubmission,expireExpressPayments}=await import('../src/express-orders.js');
  assert.doesNotThrow(()=>assertExpressPaymentSubmission(order,'2026-09-23T01:04:59.999Z'));
  assert.throws(()=>assertExpressPaymentSubmission(order,'2026-09-23T01:05:00.000Z'),e=>e.code==='express_payment_expired');
  assert.equal(expireExpressPayments(store,{at:'2026-09-23T01:05:00.000Z',id:p=>p}),true);
  assert.equal(order.state,'cancelled');
});
test('document reroute cannot cross zones even when settings give two zones the same price',()=>{
  const {store}=setup();
  store.settings.deliveryFeeBands[1].feeMinor=8900;
  store.supplierProfiles.find(p=>p.userId==='shop_b').isClosed=true;
  const order={id:'same_zone',clientId:'user_client',supplierId:'shop_a',state:'supplier_assigned',fulfillmentMode:'delivery',dropoff:location,pickup:location,deliveryFeeMinor:8900,distanceZone:{key:'nearby'},totalMinor:10000,timeline:[],
    expressOrder:{version:1,originalSupplierId:'shop_a',location,declines:0,events:[]}};
  startExpressAcceptance(order,AT);declineExpress(store,order,{at:AT,id:p=>p});
  assert.equal(order.state,'cancelled');assert.equal(order.supplierId,'shop_a');
});

test('plans use each shop sheet price for every selected page and copy, then accept before payment; timeout requires a new pick',async()=>{
 const {store,client,call}=setup();
 for(const item of store.catalogItems) {
  Object.assign(item,{subcategoryCode:'blueprint_cad_plotting',pricingUnit:'per_unit',basePriceMinor:item.supplierId==='shop_b'?6500:8000});
  store.supplierServices.find(s=>s.id===item.supplierServiceId).categoryCode='specialized_prototyping';
  store.catalogOptionGroups.push({id:`size_${item.id}`,catalogItemId:item.id,name:'Size',kind:'spec',required:true});
  store.catalogOptions.push({id:`a2_${item.id}`,optionGroupId:`size_${item.id}`,label:'20x30 / A2',specBinding:{fieldCode:'size',value:'A2'},active:true,priceModifierMinor:0});
 }
 const plans={...request,productType:'plans',files:[{...files[0],copies:3,paper:'a2'}]};
 const before=structuredClone(store);
 const list=await call('POST','/express/shops',{...plans,sort:'lowest_price'});
 assert.equal(list.body.shops[0].supplierId,'shop_b');assert.equal(JSON.stringify(store),JSON.stringify(before));
 const draft=await call('POST','/express/drafts',{...plans,supplierId:'shop_b'});
 assert.equal(draft.body.paymentTiming,'after_acceptance');
 const line=store.cartLines.find(l=>l.cartId===draft.body.cartId);
 assert.equal(line.expressPrint.rateMinor,6500);assert.equal(line.documentPages.printed,2);
 const placed=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation});
 const order=store.orders.find(o=>o.id===placed.body.order.id);
 assert.equal(order.supplierSubtotalMinor,39000);assert.equal(order.state,'needs_qa');
 assert.equal(store.orderLineItems.find(line=>line.orderId===order.id).quantity,6);
 assert.equal(order.expressOrder.printSettings[0].copies,3);
 assert.equal(order.expressOrder.paymentTiming,'after_acceptance');
 order.state='supplier_assigned';order.fileCheck={status:'passed'};startExpressAcceptance(order,AT);
 declineExpress(store,order,{at:'2026-09-23T01:05:00.000Z',id:p=>p,kind:'timed_out'});
 assert.equal(order.supplierId,'shop_b');assert.equal(publicExpress(order,client).repickRequired,true);
 assert.equal(order.state,'cancelled');assert.equal(order.supplierSubtotalMinor,39000);
});

test('Nearby remains in A with three open printers; filters count Starter eligibility before expansion',async()=>{
 const {store,call}=setup();
 store.supplierProfiles.find(p=>p.userId==='shop_c').shop.lat=7.08;
 const pending=store.approvalCases.find(c=>c.userId==='shop_a');pending.status='pending';pending.createdAt=new Date().toISOString();
 store.supplierPayoutAccounts=[{supplierId:'shop_a',qrFileId:'payout'}];
 store.files.push({fileId:'payout',ownerId:'shop_a',purpose:'supplier_payout_qr',state:'ready'});
 let answer=await call('POST','/express/shops',request);
 assert.deepEqual(answer.body.expandedZones,[]);assert.equal(answer.body.shops.length,3);
 assert.equal(answer.body.shops.find(s=>s.supplierId==='shop_a').verificationLevel,'starter');
 answer=await call('POST','/express/shops',{...request,verifiedOnly:true});
 assert.equal(answer.body.shops.some(s=>s.supplierId==='shop_a'),false);
 assert.deepEqual(answer.body.expandedZones,['B','C']);
});

test('A3 submitted evidence survives the deadline; unpaid expiry does not affect other orders',async()=>{
 const {expireExpressPayments}=await import('../src/express-orders.js');
 const {store}=setup();
 const accepted={id:'paid_window',orderType:'express',state:'initial_payment_review',payments:{initial:{status:'pending_confirmation'}},expressOrder:{paymentTiming:'after_acceptance',payBy:AT}};
 const regular={id:'regular',state:'awaiting_initial_payment',payments:{initial:{status:'not_submitted'}}};
 store.orders.push(accepted,regular);
 assert.equal(expireExpressPayments(store,{at:AT,id:p=>p}),false);
 assert.equal(accepted.state,'initial_payment_review');assert.equal(regular.state,'awaiting_initial_payment');
});

test('released GET shop lists remain open-only and unbounded by the new Nearby expansion',async()=>{
 const {store,call}=setup();
 store.supplierProfiles.find(p=>p.userId==='shop_b').isClosed=true;
 const result=await call('GET',`/express/shops?lat=${location.lat}&lng=${location.lng}`);
 assert.equal(result.body.shops.some(shop=>shop.supplierId==='shop_b'),false);
 assert.equal(result.body.shops.some(shop=>shop.supplierId==='shop_e'),true);
 assert.equal(result.body.expandedZones,undefined);
});

test('Just print it fare permission survives the draft and is checked again before checkout',async()=>{
 const {store,call}=setup();
 const draft=await call('POST','/express/drafts',{...request,selection:'just_print_it',fareLimit:'up_to_149'});
 assert.equal(store.cartLines[0].expressPrint.selection.fareLimit,'up_to_149');
 store.settings.deliveryFeeBands[0].feeMinor=15000;
 await assert.rejects(call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'CAP',proofFileId:'file_qr'}}),e=>e.code==='express_shop_unavailable');
 assert.equal(store.orders.length,0);
});

test('accepted document rerouting uses its original zone limits and preserves the accepted fare after settings edits',()=>{
 const {store}=setup();
 const bands=structuredClone(store.settings.deliveryFeeBands);
 store.supplierProfiles.find(profile=>profile.userId==='shop_b').shop.lat=7.10;
 store.settings.deliveryFeeBands[0].maxDistanceMeters=1000;store.settings.deliveryFeeBands[0].feeMinor=10000;
 const order={id:'locked_fare',clientId:'user_client',supplierId:'shop_a',state:'supplier_assigned',fulfillmentMode:'delivery',dropoff:location,pickup:location,deliveryFeeMinor:8900,totalMinor:10000,timeline:[],
  expressOrder:{version:1,originalSupplierId:'shop_a',location,printerZone:{key:'nearby'},deliveryFeeBands:bands,declines:0,events:[]}};
 startExpressAcceptance(order,AT);declineExpress(store,order,{at:AT,id:p=>p});
 assert.equal(order.supplierId,'shop_b');assert.equal(order.deliveryFeeMinor,8900);assert.equal(order.totalMinor,10000);
});

test('fully voucher-funded A3 keeps the existing zero-cash checkout boundary',async()=>{
 const {issueVoucher}=await import('../src/vouchers.js');
 const {store,client,call}=setup();let sequence=0;
 const campaign={id:'full',name:'Full voucher',valueMinor:100000,totalLimit:10,validityDays:30,status:'active',purpose:'manual',coversOrderTotal:true};
 store.voucherCampaigns=[campaign];issueVoucher(store,campaign,client.id,{id:prefix=>`${prefix}_${++sequence}`,at:AT});
 for(const item of store.catalogItems) {
  store.catalogOptionGroups.push({id:`size_${item.id}`,catalogItemId:item.id,name:'Size',kind:'spec',required:true});
  store.catalogOptions.push({id:`a3_${item.id}`,optionGroupId:`size_${item.id}`,label:'A3',specBinding:{fieldCode:'size',value:'A3'},active:true,priceModifierMinor:0});
 }
 const draft=await call('POST','/express/drafts',{...request,supplierId:'shop_a',files:[{...files[0],paper:'a3'}]});
 assert.equal(draft.body.quote.downpaymentMinor,0);
 // Released clients may still include their payment object at a zero boundary.
 const placed=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'UNUSED',proofFileId:'file_qr'}});
 const order=store.orders.find(row=>row.id===placed.body.order.id);
 assert.equal(order.payments.initial.method,'gridgo_voucher');assert.equal(order.payments.initial.status,'confirmed');assert.equal(order.state,'needs_qa');
});
