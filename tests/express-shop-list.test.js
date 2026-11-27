import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, addShop, caller } from './fixtures/scheduling.js';
import { expressFilterData, expressCardPrice } from '../src/express-shop-facts.js';
import { expressPrinterOrder } from '../src/express-printers.js';
import { catalogItemsWithPhotos } from '../src/catalog-photo-urls.js';

const AT = '2026-09-23T01:00:00.000Z';
const location = {lat:7.064,lng:125.6085};
function setup() {
  const {store,client}=fixture({express:true});
  client.accountType='individual';
  addShop(store,'shop_c',{lat:7.08,lng:125.6085});
  for(const item of store.catalogItems) Object.assign(item,{express:true,pricingUnit:'per_page',subcategoryCode:'document_printing',printLayouts:['fit_to_paper']});
  for(const service of store.supplierServices) Object.assign(service,{categoryCode:'document_publication',turnaroundHours:1,standardTurnaroundHours:1});
  store.files.find(f=>f.fileId==='file_art').detected={pageCount:2};
  return {store,client,call:caller(store,client,AT)};
}
const files=[{fileId:'file_art',copies:3,colour:'bw',paper:'a4',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]}];
const pickup={location,fulfillmentMode:'pickup',files};
const delivery={location,fulfillmentMode:'delivery',dropoff:{...location,label:'Destination'},files};
function addA3(store) {
  for(const item of store.catalogItems) {
    store.catalogOptionGroups.push({id:`size_${item.id}`,catalogItemId:item.id,name:'Size',kind:'spec',required:true});
    store.catalogOptions.push({id:`a3_${item.id}`,optionGroupId:`size_${item.id}`,label:'A3',specBinding:{fieldCode:'size',value:'A3'},active:true,priceModifierMinor:0});
  }
}

test('each card total is the checkout total for that printer, pickup and delivery', async()=>{
  for(const body of [pickup,delivery]) {
    const {store,call}=setup();
    const list=await call('POST','/express/shops',{...body,sort:'all_davao'});
    const priced=list.body.shops.filter(s=>s.selectable);
    assert.ok(priced.length>=2);
    for(const shop of priced) {
      assert.equal(shop.price.totalMinor,shop.quote.totalMinor);
      assert.equal(shop.price.printedPages,6);
      assert.equal(shop.price.perPageMinor,300);assert.equal(shop.price.perPageMixed,false);
      if(body.fulfillmentMode==='delivery') assert.equal(shop.price.totalMinor,shop.quote.clientItemSubtotalMinor+shop.quote.deliveryFeeMinor);
      const draft=await call('POST','/express/drafts',{...body,supplierId:shop.supplierId});
      assert.equal(draft.body.quote.totalMinor,shop.price.totalMinor);
      const placed=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'REF1',proofFileId:'file_qr'}});
      assert.equal(store.orders.find(o=>o.id===placed.body.order.id).totalMinor,shop.price.totalMinor);
    }
  }
});

test('per-page price is the shop page rate, or the rounded-up average for mixed rates', ()=>{
  const line=(rateMinor,printed,quantity)=>({quantity,documentPages:{printed},expressPrint:{rateMinor}});
  const quote={status:'priced',totalMinor:9999};
  assert.deepEqual(expressCardPrice(quote,[line(300,2,3)]),{totalMinor:9999,printedPages:6,perPageMinor:300,perPageMixed:false});
  assert.deepEqual(expressCardPrice(quote,[line(300,2,1),line(500,1,1)]),{totalMinor:9999,printedPages:3,perPageMinor:367,perPageMixed:true});
  assert.equal(expressCardPrice({status:'incomplete',totalMinor:null},[line(300,1,1)]),null);
});

test('cheapest sorts by client total; closed printers stay last', async()=>{
  const {store,call}=setup();addA3(store);
  store.catalogItems.find(i=>i.supplierId==='shop_a').basePriceMinor=1000;
  store.catalogItems.find(i=>i.supplierId==='shop_b').basePriceMinor=500;
  store.catalogItems.find(i=>i.supplierId==='shop_c').basePriceMinor=700;
  const a3={...pickup,files:[{...files[0],paper:'a3'}]};
  let list=await call('POST','/express/shops',{...a3,sort:'cheapest'});
  assert.deepEqual(list.body.shops.map(s=>s.supplierId),['shop_b','shop_c','shop_a']);
  assert.equal(list.body.sort,'cheapest');
  const totals=list.body.shops.map(s=>s.price.totalMinor);
  assert.deepEqual([...totals].sort((x,y)=>x-y),totals);
  store.supplierProfiles.find(p=>p.userId==='shop_b').isClosed=true;
  list=await call('POST','/express/shops',{...a3,sort:'cheapest'});
  assert.equal(list.body.shops.at(-1).supplierId,'shop_b');assert.equal(list.body.shops.at(-1).price,undefined);
});

test('ready_soonest orders by ready time', async()=>{
  const {store,call}=setup();
  for(const id of ['shop_a','shop_b'])Object.assign(store.supplierServices.find(s=>s.supplierId===id),{turnaroundHours:3,standardTurnaroundHours:3});
  const list=await call('POST','/express/shops',{...pickup,sort:'ready_soonest'});
  assert.equal(list.body.shops[0].supplierId,'shop_c');
  const ready=list.body.shops.map(s=>Date.parse(s.readyAt));
  assert.deepEqual([...ready].sort((x,y)=>x-y),ready);
});

test('delivery cheapest includes the delivery fee, so the nearer printer wins at equal page prices', async()=>{
  const {store,call}=setup();
  store.supplierProfiles.find(p=>p.userId==='shop_c').shop.lat=7.13;
  const list=await call('POST','/express/shops',{...delivery,sort:'cheapest'});
  const fees=list.body.shops.map(s=>s.deliveryFeeMinor);
  assert.deepEqual([...fees].sort((x,y)=>x-y),fees);
  assert.ok(list.body.shops.at(-1).price.totalMinor>list.body.shops[0].price.totalMinor);
});

test('GET keeps legacy sorts, accepts ready_soonest and refuses cheapest without files', async()=>{
  const {call}=setup();
  const ready=await call('GET',`/express/shops?lat=${location.lat}&lng=${location.lng}&sort=ready_soonest`);
  assert.equal(ready.body.sort,'ready_soonest');assert.ok(ready.body.filterData);
  await assert.rejects(call('GET',`/express/shops?lat=${location.lat}&lng=${location.lng}&sort=cheapest`),e=>e.code==='express_shop_pricing_required');
  await assert.rejects(call('POST','/express/shops',{...pickup,sort:'priciest'}),e=>e.code==='invalid_express_sort');
  const legacy=await call('GET',`/express/shops?lat=${location.lat}&lng=${location.lng}`);
  assert.equal(legacy.body.filterData,undefined);assert.ok(Array.isArray(legacy.body.shops[0].services));
});

test('the decline order reuses the list order for the same sort', async()=>{
  const {store,call}=setup();
  const list=await call('POST','/express/shops',{...delivery,sort:'cheapest'});
  const again=[...list.body.shops].reverse().sort(expressPrinterOrder(store,location,'cheapest'));
  assert.deepEqual(again.map(s=>s.supplierId),list.body.shops.map(s=>s.supplierId));
});

test('cards carry logo, services, rating, top shop and payment methods; home printers stay private', async()=>{
  const {store,call}=setup();
  store.files.push({fileId:'logo_b',ownerId:'shop_b',purpose:'supplier_shop_image',state:'ready',objectKey:'shop_b/logo.png'},
    {fileId:'logo_a',ownerId:'shop_a',purpose:'supplier_shop_image',state:'ready',objectKey:'shop_a/logo.png'});
  store.supplierShopMedia=[{supplierId:'shop_b',slot:'logo',fileId:'logo_b'},{supplierId:'shop_b',slot:'cover',fileId:'logo_a'},{supplierId:'shop_a',slot:'logo',fileId:'logo_a'}];
  Object.assign(store.supplierServices.find(s=>s.supplierId==='shop_b'),{rushEnabled:true,documentCapabilities:{papers:['a4'],colours:['bw'],duplex:true,a3PricesMinor:{},finishing:{stapling:500,binding:4000}}});
  const item=store.catalogItems.find(i=>i.supplierId==='shop_c');
  store.catalogOptionGroups.push({id:'finish_c',catalogItemId:item.id,name:'Finish',kind:'addon',required:false});
  store.catalogOptions.push({id:'lam_c',optionGroupId:'finish_c',label:'Lamination',specBinding:{fieldCode:'finish',valueCode:'lamination'},active:true,priceModifierMinor:500});
  for(let n=0;n<5;n++)store.shopReviews.push({id:`r${n}`,supplierId:'shop_b',orderId:`o${n}`,qualityStars:n===0?4:5});
  Object.assign(store.supplierProfiles.find(p=>p.userId==='shop_a'),{supplierType:'home',barangay:'Sample barangay'});
  const list=await call('POST','/express/shops',{...pickup,sort:'all_davao'});
  const card=id=>list.body.shops.find(s=>s.supplierId===id);
  assert.deepEqual(card('shop_b').logo,{fileId:'logo_b',url:'/catalog/media/logo_b'});
  assert.equal(card('shop_c').logo,null);
  assert.deepEqual(card('shop_b').services,['stapling','binding','rush']);
  assert.deepEqual(card('shop_c').services,['lamination']);
  assert.deepEqual(card('shop_b').rating,{average:4.8,count:5});assert.equal(card('shop_b').topShop,false);assert.equal(card('shop_b').topShopBadge,null);
  assert.equal(card('shop_c').topShop,false);
  assert.equal(typeof card('shop_b').jobsAhead,'number');assert.ok(card('shop_b').readyAt);
  assert.equal(card('shop_b').isOpenNow,true);assert.equal(card('shop_b').verified,true);
  const home=card('shop_a');
  assert.equal(home.logo,null);assert.equal(home.location,null);assert.equal(home.name,'Sample barangay');
  assert.equal(home.distanceApproximate,true);assert.equal(home.distanceMeters%500,0);
  assert.deepEqual(home.paymentMethods,['qr_ph']);
  assert.ok(catalogItemsWithPhotos(list.body).some(entry=>entry.photos?.[0]?.fileId==='logo_b'));
  assert.ok(!JSON.stringify(list.body).includes('logo_a'));
});

test('cash is listed only where checkout would accept it', async()=>{
  const {store,client,call}=setup();
  const methods=async body=>Object.fromEntries((await call('POST','/express/shops',{...body,sort:'all_davao'})).body.shops.map(s=>[s.supplierId,s.paymentMethods]));
  assert.deepEqual((await methods(delivery)).shop_b,['qr_ph']);
  store.settings.cash={enabled:true,limitMinor:150000,noShowWaitSeconds:600};
  assert.deepEqual((await methods(delivery)).shop_b,['cash','qr_ph']);
  assert.deepEqual((await methods(pickup)).shop_b,['qr_ph']);
  store.settings.cash.limitMinor=100;
  assert.deepEqual((await methods(delivery)).shop_b,['qr_ph']);
  store.settings.cash.limitMinor=150000;
  store.approvalCases.find(c=>c.userId==='shop_b').status='pending';
  assert.deepEqual((await methods(delivery)).shop_b??['qr_ph'],['qr_ph']);
  store.approvalCases.find(c=>c.userId==='shop_b').status='approved';
  client.accountType='business';
  assert.deepEqual((await methods(delivery)).shop_b,['qr_ph']);
});

test('filter data counts every nearby printer before type/verified filters and buckets the totals', async()=>{
  const {store,call}=setup();
  Object.assign(store.supplierProfiles.find(p=>p.userId==='shop_a'),{supplierType:'home',barangay:'Sample barangay'});
  store.supplierServices.find(s=>s.supplierId==='shop_c').rushEnabled=true;
  const all=await call('POST','/express/shops',{...delivery,sort:'all_davao'});
  const shopsOnly=await call('POST','/express/shops',{...delivery,sort:'all_davao',shopsOnly:true});
  assert.equal(shopsOnly.body.shops.some(s=>s.printerType==='home'),false);
  assert.deepEqual(shopsOnly.body.filterData,all.body.filterData);
  const data=all.body.filterData;
  assert.equal(data.printers,all.body.shops.length);
  assert.deepEqual(data.printerType,{shop:all.body.shops.filter(s=>s.printerType==='shop').length,home:1});
  assert.equal(data.services.rush,1);assert.equal(data.paymentMethods.qr_ph,data.printers);assert.equal(data.paymentMethods.cash,0);
  const totals=all.body.shops.filter(s=>s.price).map(s=>s.price.totalMinor);
  assert.equal(data.price.total.minMinor,Math.min(...totals));assert.equal(data.price.total.maxMinor,Math.max(...totals));
  assert.equal(data.price.total.buckets.reduce((n,b)=>n+b.count,0),totals.length);
  assert.ok(data.price.total.buckets.length<=10);
  assert.deepEqual(data.price.perPage,{minMinor:300,maxMinor:300,buckets:[{fromMinor:300,toMinor:300,count:totals.length}]});
});

test('histogram buckets are inclusive, contiguous and at most ten', ()=>{
  const rows=[100,105,199,250,1100].map(totalMinor=>({selectable:true,price:{totalMinor,perPageMinor:1}}));
  const {price}=expressFilterData(rows);
  assert.equal(price.total.buckets.length,10);
  assert.equal(price.total.buckets[0].fromMinor,100);assert.equal(price.total.buckets.at(-1).toMinor,1100);
  for(let i=1;i<price.total.buckets.length;i++)assert.equal(price.total.buckets[i].fromMinor,price.total.buckets[i-1].toMinor+1);
  assert.deepEqual(price.total.buckets.map(b=>b.count),[3,1,0,0,0,0,0,0,0,1]);
  assert.equal(expressFilterData([{selectable:false,price:null}]).price,null);
});

test('client cards show only the dated monthly badge and boost it only in Nearest',async()=>{
  const {store,call}=setup();
  store.shopLeaderboardMonths=[{month:'2026-08',validFrom:'2026-08-31T16:00:00.000Z',validUntil:'2026-09-30T16:00:00.000Z',
    winners:[{supplierId:'shop_b',score:97,rank:1,parts:{stars:{value:5}}}]}];
  const nearest=await call('POST','/express/shops',{...pickup,sort:'nearest'});
  assert.equal(nearest.body.shops[0].supplierId,'shop_b');
  const row=nearest.body.shops[0];assert.equal(row.topShop,true);
  assert.deepEqual(row.topShopBadge,{type:'top_shop',month:'2026-08',validFrom:'2026-08-31T16:00:00.000Z',validUntil:'2026-09-30T16:00:00.000Z'});
  for(const key of ['score','rank','parts','acceptance','declines','gap'])assert.equal(Object.hasOwn(row,key),false,key);
  const price=await call('POST','/express/shops',{...pickup,sort:'cheapest'});
  assert.equal(price.body.shops[0].supplierId,'shop_a');
  const all=await call('POST','/express/shops',{...pickup,sort:'all_davao'});
  assert.equal(all.body.shops[0].supplierId,'shop_a');
});
