import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, caller } from './fixtures/scheduling.js';
import { matchShop } from '../src/order-match.js';
import { expressCatalogOptions, expressStatus } from '../src/express-orders.js';
import { createSignupDocuments, supplierSupportsDocumentOrder } from '../src/document-capabilities.js';
import { routeExpressOrders } from '../src/express-routes.js';
import { routeSupplierCatalog } from '../src/catalog-routes.js';
const AT='2026-09-23T01:00:00.000Z';
function setup() {
  const f=fixture({express:true});
  for(const item of f.store.catalogItems){item.subcategoryCode='document_printing';item.pricingUnit='per_page';item.printLayouts=['fit_to_paper'];item.express=true;}
  for(const service of f.store.supplierServices){service.categoryCode='document_publication';service.documentCapabilities={papers:['short','a4'],colours:['bw'],duplex:false};}
  f.store.supplierServices[1].documentCapabilities={papers:['short','a4','a3'],colours:['bw','colour'],duplex:true};
  return f;
}
test('matching filters colour, A3 and back-to-back work using saved document capabilities',()=>{
  const {store}=setup();
  for(const structuredSpec of [{colourMode:'colour'},{size:'a3'},{sides:'two'}]) {
    const match=matchShop(store,{subcategoryCode:'document_printing',structuredSpec,now:AT,ranking:['quality','speed','cost','distance']});
    assert.equal(match.shop.supplierId,'shop_b');
    assert.ok(match.otherListings.every(s=>s.supplierId!=='shop_a'));
  }
  const both=matchShop(store,{subcategoryCode:'document_printing',structuredSpec:{colourMode:'bw',size:'a4',sides:'one'},now:AT,ranking:['quality','speed','cost','distance']});
  assert.ok(both.shop.supplierId);
});
test('A3 Express locks the shop price and asks for client payment only after shop acceptance',async()=>{
  const {store,client}=setup();let n=0;const id=p=>`${p}_${++n}`;
  store.files.find(f=>f.fileId==='file_art').detected={pageCount:2};
  const [service]=createSignupDocuments(store,'shop_a',{papers:['a3'],colours:['bw'],duplex:true,a3PricesMinor:{bw:1700},finishing:{}},{id,at:AT});
  service.state='live';
  const item=store.catalogItems.at(-1);item.reviewStatus='approved';store.catalogItemPhotos.push({catalogItemId:item.id,fileId:'photo_item_shop_a',sortOrder:0});
  const call=caller(store,client,AT);
  const draft=await call('POST','/express/drafts',{supplierId:'shop_a',location:{lat:7.06,lng:125.6},fulfillmentMode:'pickup',files:[{
    catalogItemId:item.id,fileId:'file_art',copies:3,colour:'bw',paper:'a3',sides:'two',layout:'fit_to_paper',acceptedWarnings:[]}]});
  assert.equal(store.cartLines.at(-1).expressPrint.rateMinor,1700);
  const checkout=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation});
  const order=store.orders.find(o=>o.id===checkout.body.order.id);
  assert.equal(order.supplierSubtotalMinor,10200);assert.equal(order.state,'needs_qa');
  assert.equal(order.payments.initial.status,'not_submitted');assert.equal(order.expressOrder.paymentTiming,'after_acceptance');
  assert.equal('rateMinor' in checkout.body.order.expressOrder.printSettings[0],false);
  assert.equal(order.fileCheck.status,'pending');
  order.fileCheck.status='passed';order.state='supplier_assigned';
  const accepted=await routeExpressOrders({req:{method:'POST'},url:new URL(`http://test/orders/${order.id}/express/accept`),store,user:{id:'shop_a',role:'supplier'},
    readBody:async()=>({}),id,now:()=>AT,audit:()=>{}});
  assert.equal(accepted.status,200);assert.equal(order.state,'awaiting_initial_payment');
  assert.equal(order.shopAcceptance.status,'accepted');
  assert.equal(order.payments.initial.status,'not_submitted');
  assert.equal(expressStatus({...order,state:'initial_payment_review'}),'accepted');
});
test('Express and ordinary cart writes refuse an unsupported document request',async()=>{
  const {store,client}=setup();const item=store.catalogItems[0];
  assert.throws(()=>expressCatalogOptions(store,item,{colour:'colour',paper:'a4',sides:'one'}),e=>e.code==='document_capability_unavailable');
  const call=caller(store,client,AT);
  const cart=await call('POST','/me/carts',{fulfillmentMode:'pickup'});
  await assert.rejects(call('POST',`/me/carts/${cart.body.cart.id}/lines`,{catalogItemId:item.id,expectedVersion:1,expectedServiceVersion:1,
    quantity:1,optionIds:[],structuredSpec:{colourMode:'colour'},artworkFileId:'file_art',printLayout:'fit_to_paper'}),e=>e.code==='document_capability_unavailable');
});
test('manual supplier eligibility also respects immutable document print facts',()=>{
  const {store}=setup();
  for(const print of [{colour:'colour',paper:'a4',sides:'one'},{colour:'bw',paper:'a3',sides:'one'},{colour:'bw',paper:'a4',sides:'two'}]) {
    const order={id:'saved',expressOrder:{printSettings:[print]}};
    assert.equal(supplierSupportsDocumentOrder(store,'shop_a',order),false);
    assert.equal(supplierSupportsDocumentOrder(store,'shop_b',order),true);
  }
  store.orderLineItems=[{id:'saved_line',orderId:'normal',sourceCatalogItemId:store.catalogItems[0].id,structuredSpecSnapshot:{size:'A4'}}];
  store.orderLineItemOptions=[{orderLineItemId:'saved_line',groupNameSnapshot:'Colour',optionLabelSnapshot:'Colour'}];
  assert.equal(supplierSupportsDocumentOrder(store,'shop_a',{id:'normal'}),false);
});

test('accepted document specifications remain guarded without the original document listing',()=>{
  const {store}=setup();
  store.catalogItems[0].subcategoryCode='booklets';
  for(const spec of [{size:'a3'},{colourMode:'colour'},{sides:'two'}]) {
    store.orderLineItems=[{id:'accepted',orderId:'normal',sourceCatalogItemId:store.catalogItems[0].id,
      pricingUnitSnapshot:'per_page',structuredSpecSnapshot:spec}];
    assert.equal(supplierSupportsDocumentOrder(store,'shop_a',{id:'normal'}),false);
    assert.equal(supplierSupportsDocumentOrder(store,'shop_b',{id:'normal'}),true);
    store.orderLineItems[0].sourceCatalogItemId=null;
    assert.equal(supplierSupportsDocumentOrder(store,'shop_a',{id:'normal'}),false);
  }
  // Historical lines can lack a pricing unit; their accepted options still apply.
  store.orderLineItems=[{id:'accepted',orderId:'normal',structuredSpecSnapshot:{}}];
  store.orderLineItemOptions=[{orderLineItemId:'accepted',groupNameSnapshot:'Colour',optionLabelSnapshot:'Colour'}];
  assert.equal(supplierSupportsDocumentOrder(store,'shop_a',{id:'normal'}),false);
  store.orderLineItemOptions=[];
  store.orderLineItems[0].structuredSpecSnapshot={size:'3 x 5 feet',material:'vinyl'};
  assert.equal(supplierSupportsDocumentOrder(store,'shop_a',{id:'normal'}),true);
});

test('ordinary checkout keeps document capability requirements after a private product edit',async()=>{
  const {store,client}=setup();let sequence=0;const id=p=>`normal_${p}_${++sequence}`;
  store.files.find(f=>f.fileId==='file_art').detected={pageCount:2};
  const [service]=createSignupDocuments(store,'shop_b',{papers:['a3'],colours:['colour'],duplex:true,a3PricesMinor:{colour:1700},finishing:{}},{id,at:AT});
  service.state='live';const item=store.catalogItems.at(-1);item.reviewStatus='approved';
  store.catalogItemPhotos.push({catalogItemId:item.id,fileId:'photo_item_shop_b',sortOrder:0});
  const optionIds=store.catalogOptionGroups.filter(g=>g.catalogItemId===item.id)
    .map(g=>store.catalogOptions.filter(o=>o.optionGroupId===g.id).at(-1).id);
  const call=caller(store,client,AT);
  const cart=(await call('POST','/me/carts',{fulfillmentMode:'pickup'})).body.cart;
  await call('POST',`/me/carts/${cart.id}/lines`,{catalogItemId:item.id,expectedVersion:1,expectedServiceVersion:1,
    optionIds,quantity:1,structuredSpec:{size:'a3',colourMode:'colour',sides:'two'},artworkFileId:'file_art',printLayout:'fit_to_paper'});
  const placed=await call('POST',`/me/carts/${cart.id}/checkout`,{payment:{method:'qr_manual',proofFileId:'file_qr',reference:'DOCUMENT'}});
  const order=store.orders.find(o=>o.id===placed.body.order.id);
  assert.equal(supplierSupportsDocumentOrder(store,'shop_a',order),false);
  const edited=await routeSupplierCatalog({req:{method:'PATCH'},url:new URL(`http://test/me/catalog-items/${item.id}`),store,
    user:{id:'shop_b',role:'supplier'},readBody:async()=>({expectedVersion:1,subcategoryCode:'booklets'}),id,now:()=>AT,audit:()=>{}});
  assert.equal(edited.status,200);assert.equal(item.reviewStatus,'pending');
  assert.equal(item.approvedSnapshot.item.subcategoryCode,'document_printing');
  assert.equal(supplierSupportsDocumentOrder(store,'shop_a',order),false);
  assert.deepEqual(store.orderLineItems[0].structuredSpecSnapshot,{size:'a3',colourMode:'colour',sides:'two'});
});
