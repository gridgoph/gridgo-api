import test from 'node:test';
import assert from 'node:assert/strict';
import { expressRates, validateExpressRates, expressLinePrice, expressShopList, publicExpress, startExpressAcceptance, declineExpress, expressGuide, updateExpressGuide } from '../src/express-orders.js';
import { fixture } from './fixtures/scheduling.js';
const AT = '2026-09-23T01:00:00.000Z';
function setup() {
  const {store,client}=fixture({express:true});
  for(const item of store.catalogItems) { item.express=true; item.printLayouts=['fit_to_paper','actual_size_centered','actual_size_original_position']; item.pricingUnit='per_page'; item.subcategoryCode='document_printing'; }
  for(const service of store.supplierServices) service.categoryCode='document_publication';
  return {store,client};
}
test('Express shop rates use safe integer centavos and duplex charges printed sides once',()=>{
  assert.deepEqual(expressRates({}),{bwMinor:300,colourMinor:500});
  assert.equal(expressLinePrice({expressPrint:{colour:'bw',sides:'two',rateMinor:300},quantity:2,documentPages:{printed:3}}).lineSubtotalMinor,1800);
  for(const value of [0,-1,3.5,'300',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>validateExpressRates({bwMinor:value,colourMinor:500}));
  assert.throws(()=>expressLinePrice({expressPrint:{rateMinor:500},quantity:Number.MAX_SAFE_INTEGER,documentPages:{printed:2}}));
});
test('Pay shops exclude closed/unapproved shops, show Busy, and put one New shop second outside nearest sort',()=>{
 const {store,client}=setup();
 store.users.find(u=>u.id==='shop_b').createdAt='2026-09-21T00:00:00Z';
 store.orders.push(...[1,2,3].map(i=>({id:`o${i}`,supplierId:'shop_a',state:'production'})));
 const rows=expressShopList(store,client,{location:{lat:7.064,lng:125.6085},sort:'fewest_jobs'},AT);
 assert.equal(rows[0].supplierId,'shop_a');assert.equal(rows[0].busy,true);assert.equal(rows[1].isNew,true);
 store.supplierProfiles[0].isClosed=true;
 assert.deepEqual(expressShopList(store,client,{location:{lat:7.064,lng:125.6085}},AT).map(x=>x.supplierId),['shop_b']);
 store.approvalCases=[];
 assert.deepEqual(expressShopList(store,client,{location:{lat:7.064,lng:125.6085}},AT),[]);
});
test('five minute acceptance is wall-clock; reassignment preserves money, three refusals cancel',()=>{
 const {store}=setup(); let n=0;const id=p=>`${p}_${++n}`;
 const order={id:'express1',clientId:'user_client',supplierId:'shop_a',state:'supplier_assigned',fulfillmentMode:'pickup',pickup:{lat:7.064,lng:125.6085},totalMinor:990,supplierSubtotalMinor:900,
  expressOrder:{version:1,originalSupplierId:'shop_a',location:{lat:7.064,lng:125.6085},declines:0,events:[]},payoutMilestones:[],timeline:[]};
 store.orders.push(order);store.orderJobs.push({id:'j',orderId:order.id,supplierId:'shop_a',state:'needs_qa'});
 startExpressAcceptance(order,AT);
 assert.equal(order.shopAcceptance.deadlineAt,'2026-09-23T01:05:00.000Z');
 declineExpress(store,order,{at:'2026-09-23T01:05:00.000Z',id,kind:'timed_out'});
 assert.equal(order.supplierId,'shop_b');assert.equal(order.totalMinor,990);assert.equal(order.expressOrder.declines,1);
 order.expressOrder.declines=2;order.expressOrder.declinedSupplierIds=[];
 declineExpress(store,order,{at:'2026-09-23T01:10:00.000Z',id,kind:'declined'});
 assert.equal(order.state,'cancelled'); assert.equal(order.expressOrder.declines,3);assert.equal(order.totalMinor,990);
});
test('pickup credentials are client-only and guide flags are monotone with server Manila day',()=>{
 const {store,client}=setup();const order={clientId:client.id,supplierId:'shop_a',state:'ready_for_dispatch',fulfillmentMode:'pickup',expressOrder:{pickupCode:'012345',events:[],declines:0,originalSupplierId:'shop_a'}};
 assert.equal(publicExpress(order,client).pickupCode,'012345');
 assert.equal(publicExpress(order,{id:'shop_a',role:'supplier'}).pickupCode,undefined);
 assert.equal(publicExpress(order,{id:'other',role:'client'}),null);
 updateExpressGuide(store,client,{action:'popup_shown'},AT);
 updateExpressGuide(store,client,{action:'guide_completed'},AT);
 updateExpressGuide(store,client,{action:'guide_seen'},AT);
 assert.equal(expressGuide(store,client,AT).popupLastShownDate,'2026-09-23');
 assert.equal(expressGuide(store,client,AT).guideCompleted,true);
 assert.equal(expressGuide(store,client,AT).showPopup,false);
});
test('Express draft and checkout reuse cart fee builder and preserve print choices',async()=>{
 const {store,client}=setup();store.version=3;
 store.files.find(f=>f.fileId==='file_art').detected={pageCount:3};
 const {caller}=await import('./fixtures/scheduling.js');const call=caller(store,client,AT);
 const draft=await call('POST','/express/drafts',{supplierId:'shop_a',location:{lat:7.064,lng:125.6085},fulfillmentMode:'delivery',dropoff:{lat:7.065,lng:125.609,label:'Home'},
 files:[{fileId:'file_art',copies:2,colour:'bw',paper:'a4',sides:'two',layout:'fit_to_paper',acceptedWarnings:[]}]});
 assert.equal(draft.status,201);
 const cart=store.carts.find(c=>c.id===draft.body.cartId),lines=store.cartLines.filter(l=>l.cartId===cart.id);
 const {clientCartQuote}=await import('../src/order-match-routes.js');
 assert.equal(draft.body.quote.totalMinor,clientCartQuote(store,cart,lines,AT).totalMinor);
 const result=await call('POST',`/me/carts/${cart.id}/checkout`,{expressConfirmation:draft.body.confirmation,looksRight:true,payment:{method:'qr_manual',reference:'EXPRESS-1',proofFileId:'file_qr'}});
 const order=store.orders.find(o=>o.id===result.body.order.id);
 assert.equal(order.orderType,'express');assert.equal(order.supplierSubtotalMinor,1800);
 assert.equal(order.totalMinor,draft.body.quote.totalMinor);
 assert.equal(order.expressOrder.printSettings[0].sides,'two');
 assert.equal(JSON.stringify(result.body).includes('serviceFeeRateBps'),false);
 assert.equal(JSON.stringify(result.body).includes('pickupCode'),false);
});
test('Friend Pass funds delivery only and never stacks with a larger discount',async()=>{
 const {voucherMoney}=await import('../src/voucher-money.js');
 const groups=[{supplierSubtotalMinor:3000,grossServiceFeeMinor:1350,deliveryFeeMinor:10000,organizationDiscountMinor:0,serviceFeeSchedule:{version:2}}];
 const money=voucherMoney(groups,0,{expressDeliveryReward:true});
 assert.equal(money.voucherDiscountMinor,500);assert.equal(money.groups[0].voucherDeliveryMinor,500);assert.equal(money.groups[0].voucherServiceFeeMinor,0);
 assert.equal(voucherMoney([{...groups[0],organizationDiscountMinor:600}],0,{expressDeliveryReward:true}).voucherDiscountMinor,0);
 assert.equal(voucherMoney([{...groups[0],deliveryFeeMinor:0}],0,{expressDeliveryReward:true}).voucherDiscountMinor,0);
});
test('accept at deadline reassigns, acceptance before deadline is scoped and idempotent; pickup opens issue window without payouts',async()=>{
 const {routeExpressOrders}=await import('../src/express-routes.js');
 const {store,client}=setup();let n=0;
 const order={id:'order_x',orderType:'express',clientId:client.id,supplierId:'shop_a',state:'supplier_assigned',fulfillmentMode:'pickup',fileCheck:{status:'passed'},
 totalMinor:330,supplierSubtotalMinor:300,pickup:{lat:7.064,lng:125.6085},timeline:[],payoutMilestones:[{code:'delivered',status:'locked',amountMinor:105}],
 payments:{initial:{status:'confirmed'},final_online:{status:'not_required'}},
 expressOrder:{pickupCode:'012345',version:1,originalSupplierId:'shop_a',location:{lat:7.064,lng:125.6085},declines:0,events:[]}};
 store.orders.push(order);startExpressAcceptance(order,AT);
 const call=(action,user,body={},at=AT)=>routeExpressOrders({req:{method:'POST'},url:new URL(`http://test/orders/order_x/express/${action}`),store,user,readBody:async()=>body,id:p=>`${p}_${++n}`,now:()=>at});
 await assert.rejects(call('accept',client),e=>e.code==='forbidden');
 await assert.rejects(call('accept',{id:'shop_b',role:'supplier'}),e=>e.code==='forbidden');
 const shop={id:'shop_a',role:'supplier'};
 assert.equal((await call('accept',shop)).status,200);assert.equal(order.state,'payment_authorized');
 assert.equal((await call('accept',shop)).status,200);
 order.state='ready_for_dispatch';
 assert.equal((await call('pickup',shop,{code:'000000'})).status,409);
 assert.equal((await call('pickup',shop,{code:'012345'})).status,200);
 assert.equal(order.state,'issue_window_open');assert.equal(order.issueWindowOpenedAt,AT);assert.equal(order.payoutMilestones[0].status,'locked');
 assert.equal((await call('pickup',shop,{code:'012345'})).status,200);
 order.expressOrder.pickedUpAt=null;order.state='supplier_assigned';startExpressAcceptance(order,AT);
 assert.equal((await call('accept',shop,{},'2026-09-23T01:05:00.000Z')).status,409);
 assert.equal(order.supplierId,'shop_b');
});
test('Friend Pass first completed order awards each party once and consumes through the voucher reservation',async()=>{
 const {awardExpressFriendPass}=await import('../src/express-rewards.js');
 const {reserveVoucher,confirmVoucher}=await import('../src/vouchers.js');
 const {store,client}=setup();let n=0;const id=p=>`${p}_${++n}`;
 store.users.push({id:'inviter',role:'client'});store.userRoleMemberships.push({userId:'inviter',role:'client'});
 store.testerInvites=[{id:'invite',clientId:client.id,inviterId:'inviter',createdAt:'2026-09-01T00:00:00Z'}];
 const order={id:'first',clientId:client.id,createdAt:AT,state:'completed'};store.orders.push(order);
 assert.equal(awardExpressFriendPass(store,order,{state:'issue_window_open'},{id,at:AT}),true);
 assert.equal(awardExpressFriendPass(store,order,{state:'issue_window_open'},{id,at:AT}),false);
 assert.equal(store.vouchers.length,2);
 const voucher=store.vouchers.find(v=>v.clientId===client.id);const cart={id:'cart_reward',clientId:client.id};
 reserveVoucher(store,voucher,cart,{id,at:AT,orderIds:['next'],amountMinor:500});
 confirmVoucher(store,[{id:'next',voucher:{id:voucher.id},state:'needs_qa'}],{id,at:AT,actorId:client.id});
 assert.equal(voucher.status,'used');assert.equal(store.voucherRedemptions.length,1);
 assert.throws(()=>reserveVoucher(store,voucher,{id:'another',clientId:client.id},{id,at:AT}),e=>e.code==='voucher_unavailable');
});
test('Express drafts cannot be edited through custom cart routes or previewed against changed file counts',async()=>{
 const {store,client}=setup();store.files.find(f=>f.fileId==='file_art').detected={pageCount:3};
 const {caller}=await import('./fixtures/scheduling.js');const call=caller(store,client,AT);
 const draft=await call('POST','/express/drafts',{supplierId:'shop_a',location:{lat:7.064,lng:125.6085},fulfillmentMode:'pickup',files:[{fileId:'file_art',copies:1,colour:'bw',paper:'a4',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]}]});
 const cartId=draft.body.cartId,line=store.cartLines.find(l=>l.cartId===cartId);
 await assert.rejects(call('PATCH',`/me/carts/${cartId}/lines/${line.id}`,{quantity:100}),e=>e.code==='express_draft_replace_required');
 store.files.find(f=>f.fileId==='file_art').detected.pageCount=4;
 await assert.rejects(call('POST',`/me/carts/${cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual'}}),e=>e.code==='express_preview_required');
 assert.equal(store.orders.length,0);
});
test('lifecycle sweep honors five-minute boundaries and cancels on the third consecutive timeout',async()=>{
 const {addShop}=await import('./fixtures/scheduling.js');
 const {expireShopAcceptances}=await import('../src/shop-recovery.js');
 const {store,client}=setup();addShop(store,'shop_c',{express:true,lat:7.11,lng:125.64});
 const item=store.catalogItems.at(-1);item.pricingUnit='per_page';item.subcategoryCode='document_printing';store.supplierServices.at(-1).categoryCode='document_publication';
 let n=0;const id=p=>`${p}_${++n}`;
 const order={id:'timed',orderType:'express',clientId:client.id,supplierId:'shop_a',state:'supplier_assigned',fulfillmentMode:'pickup',totalMinor:330,
  timeline:[],payments:{initial:{status:'confirmed',amountMinor:330}},payoutMilestones:[],expressOrder:{version:1,location:{lat:7.064,lng:125.6085},originalSupplierId:'shop_a',declines:0,events:[]}};
 store.orders.push(order);startExpressAcceptance(order,AT);
 assert.equal(expireShopAcceptances(store,{at:'2026-09-23T01:04:59.999Z',createId:id}),false);
 for(const minute of ['05','10'])assert.equal(expireShopAcceptances(store,{at:`2026-09-23T01:${minute}:00.000Z`,createId:id}),true);
 assert.equal(order.expressOrder.declines,2);assert.equal(order.state,'supplier_assigned');
 assert.equal(expireShopAcceptances(store,{at:'2026-09-23T01:15:00.000Z',createId:id}),true);
 assert.equal(order.expressOrder.declines,3);assert.equal(order.state,'cancelled');assert.equal(order.expressOrder.refundRequired,true);
 assert.equal(expireShopAcceptances(store,{at:'2026-09-23T01:16:00.000Z',createId:id}),false);
 assert.equal(order.totalMinor,330);
});
test('Express printing uses the published progressive fee brackets without a new fee',async()=>{
 const {DEFAULT_SERVICE_FEE_SCHEDULE}=await import('../src/service-fee.js');
 const {caller}=await import('./fixtures/scheduling.js');
 for(const [pages,expected] of [[1000,415000],[10000,3690000]]) {
   const {store,client}=setup();store.settings.serviceFeeSchedule=structuredClone(DEFAULT_SERVICE_FEE_SCHEDULE);
   store.files.find(f=>f.fileId==='file_art').detected={pageCount:pages};
   const result=await caller(store,client,AT)('POST','/express/drafts',{supplierId:'shop_a',location:{lat:7.064,lng:125.6085},fulfillmentMode:'pickup',files:[{fileId:'file_art',copies:1,colour:'bw',paper:'a4',sides:'two',layout:'fit_to_paper',acceptedWarnings:[]}]});
   assert.equal(result.body.quote.clientItemSubtotalMinor,expected);assert.equal(result.body.quote.totalMinor,expected);
   assert.doesNotMatch(JSON.stringify(result.body),/serviceFee|rateBps|RateBps/);
 }
});
test('standard catalogue choices follow print settings and cannot include paid custom extras',async()=>{
 const {expressCatalogOptions}=await import('../src/express-orders.js');
 const {store}=setup();const item=store.catalogItems[0];
 store.catalogOptionGroups=[{id:'colour',catalogItemId:item.id,name:'Colour',kind:'spec',required:true},{id:'size',catalogItemId:item.id,name:'Paper size',kind:'spec',required:true},{id:'paper',catalogItemId:item.id,name:'Paper',kind:'spec',required:true},{id:'extra',catalogItemId:item.id,name:'Add-ons',kind:'addon',required:false}];
 store.catalogOptions=[['bw','colour','Black and white'],['colour_choice','colour','Colour'],['a4','size','A4'],['stock','paper','70gsm bond'],['binding','extra','Binding']].map(([id,optionGroupId,label])=>({id,optionGroupId,label,priceModifierMinor:200,active:true}));
 assert.deepEqual(expressCatalogOptions(store,item,{colour:'bw',paper:'a4'}),{optionIds:['bw','stock','a4'],paperStock:'70gsm bond'});
 assert.throws(()=>expressCatalogOptions(store,item,{colour:'bw',paper:'long'}),e=>e.code==='express_listing_configuration_required');
});
test('Express status projection maps every client state without exposing credentials before ready',async()=>{
 const {expressStatus}=await import('../src/express-orders.js');
 for(const [state,expected] of [['initial_payment_review','sending'],['needs_qa','sending'],['supplier_assigned','sending'],['payment_authorized','accepted'],['production','printing'],['supplier_self_qc','printing'],['ready_for_dispatch','ready'],['out_for_delivery','ready'],['issue_window_open','delivered'],['completed','delivered'],['cancelled','cancelled']]) {
   const order={state,clientId:'client',supplierId:'shop',fulfillmentMode:'pickup',expressOrder:{pickupCode:'012345',events:[],declines:0}};
   assert.equal(expressStatus(order),expected);
   if(expected!=='ready')assert.equal(publicExpress(order,{id:'client',role:'client'}).pickupCode,undefined);
   for(const user of [{id:'shop',role:'supplier'},{id:'staff',role:'ops_admin'},{id:'other',role:'client'}])assert.equal(publicExpress(order,user)?.pickupCode,undefined);
 }
});
test('legacy handover cannot close an Express counter order without its verified code',async()=>{
 const {completeHandover}=await import('../src/hub-handover.js');
 const {store}=setup();
 const order={id:'bypass',orderType:'express',fulfillmentMode:'pickup',expressOrder:{pickupCode:'012345'},state:'awaiting_collection',timeline:[]};
 assert.throws(()=>completeHandover(store,order,{actor:{id:'ops'},at:AT,id:p=>p}),e=>e.code==='express_pickup_code_required');
 assert.equal(order.state,'awaiting_collection');
});
