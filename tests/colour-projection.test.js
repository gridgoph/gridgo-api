import test from 'node:test';
import assert from 'node:assert/strict';
import { publicColourQuote, publicColourListing, orderColourClientAmount, publicColourChange } from '../src/colour-projection.js';
import { priceColourPages, colourSettings, parseColourListing } from '../src/colour-pricing.js';
import { colourFixture } from './helpers/colour-fixture.mjs';
import { clientInvoice } from '../src/invoice-projection.js';
const quote = () => ({version:1,pricedByColour:true,...priceColourPages([{page:1,strongColourBps:0},{page:2,strongColourBps:1800}],{tierSet:'large_format',prices:{none:3000,up_to_25:6000}},colourSettings(),3,'document_sets')});
function noShopPrices(value) {
  assert.equal(Object.hasOwn(value,'lineSubtotalMinor'),false);
  for (const page of value.pages) {
    assert.equal(page.sheetPriceMinor,page.clientSheetPriceMinor);
    if (page.clientPageTotalMinor != null) assert.equal(page.sheetPriceMinor*value.quantity+page.clientPageRoundingMinor,page.clientPageTotalMinor);
  }
}
test('client page amounts include allocated fee and sum to the all-in line total',()=>{
  const raw=quote();
  const client=publicColourQuote(raw,'client',39150);
  noShopPrices(client);assert.equal(client.clientLineSubtotalMinor,39150);
  assert.deepEqual(client.pages.map(page=>page.sheetPriceMinor),[4350,8700]);
  assert.deepEqual(client.pages.map(page=>page.clientPageTotalMinor),[13050,26100]);
  assert.equal(raw.pages[0].sheetPriceMinor,3000);
  assert.deepEqual(publicColourQuote(raw,'supplier',39150),raw);
  const ops=publicColourQuote(raw,'ops_admin',39150);
  assert.equal(ops.pages[0].sheetPriceMinor,3000);assert.equal(ops.pages[0].clientPageTotalMinor,13050);
});
test('rounding across copies stays integer and exact, and incomplete quotes expose no raw rate',()=>{
  const raw={...quote(),quantity:3,lineSubtotalMinor:9,pages:[1,2,3].map(page=>({page,sheetPriceMinor:1}))};
  const client=publicColourQuote(raw,'client',13);
  assert.deepEqual(client.pages.map(page=>page.clientPageTotalMinor),[5,4,4]);
  noShopPrices(client);
  const partial=publicColourQuote({...raw,status:'needs_price_check',lineSubtotalMinor:null,pages:[...raw.pages,{page:4,sheetPriceMinor:null,status:'needs_price_check'}]},'client');
  noShopPrices(partial);assert.ok(partial.pages.every(page=>page.clientPageTotalMinor===null));
});
test('public listing colour tables contain availability, while private tables retain shop rates',()=>{
  const {item}=colourFixture();
  const projected=publicColourListing(item.colourPricing);
  assert.equal(Object.hasOwn(projected.sizes[0],'prices'),false);
  assert.deepEqual(projected.sizes[0].offeredTiers,['none','up_to_25','up_to_50','above_50']);
});
test('order line all-in allocation uses the frozen group bracket fee, never current settings',()=>{
  const store={orderLineItems:[{id:'a',orderId:'order',lineSubtotalMinor:200000},{id:'b',orderId:'order',lineSubtotalMinor:400000}]};
  const order={id:'order',serviceFeeSchedule:{version:2},grossServiceFeeMinor:190000};
  assert.equal(orderColourClientAmount(store,order,store.orderLineItems[0]),263333);
  assert.equal(orderColourClientAmount(store,order,store.orderLineItems[1]),526667);
});
test('client invoices sanitize colour prices even with a legacy flat fee schedule',()=>{
  const snapshot={itemSubtotalMinor:27000,serviceFeeMinor:2700,serviceFeeRateBps:1000,lines:[{id:'line',unitPriceMinor:0,amountMinor:27000,colourPricing:quote()}]};
  const client=clientInvoice(snapshot);
  noShopPrices(client.lines[0].colourPricing);assert.equal(client.lines[0].colourPricing.clientLineSubtotalMinor,29700);
  assert.equal(Object.hasOwn(client.lines[0],'amountMinor'),false);
  assert.equal(clientInvoice(snapshot,{exposeWorking:true}).lines[0].colourPricing.pages[0].sheetPriceMinor,3000);
});
test('correction history removes shop amounts and uses frozen original fee plus incremental collection',()=>{
  const store={orderLineItems:[{id:'line',orderId:'order',lineSubtotalMinor:10000}],orderChanges:[]};
  const order={id:'order',serviceFeeRateBps:1000,serviceFeeMinor:1000};
  const row={id:'change',lineItemId:'line',status:'pending',feeMinor:500,data:{colourCorrection:{quantity:10,pages:[{page:1,sheetPriceMinor:1000},{page:2,sheetPriceMinor:500}],originalLineSubtotalMinor:10000,correctedLineSubtotalMinor:15000}}};
  store.orderChanges.push(row);
  const projected=publicColourChange(store,order,row,'client');
  assert.equal(projected.originalClientLineSubtotalMinor,11000);assert.equal(projected.correctedClientLineSubtotalMinor,16500);
  noShopPrices(projected);assert.equal(Object.hasOwn(projected,'correctedLineSubtotalMinor'),false);
  assert.equal(projected.pages.reduce((sum,page)=>sum+page.clientPageTotalMinor,0),16500);
});

test('all cart and catalogue quote paths hide shop page prices and share the group fee once',async()=>{
  const {routeOrderMatch}=await import('../src/order-match-routes.js');
  const {queueLineColour}=await import('../src/colour-analysis.js');
  const {store,item,line}=colourFixture();
  const at='2026-10-05T00:00:00.000Z';
  store.carts.push({id:'colour_cart',clientId:'client',state:'draft',version:1,serviceLevel:'standard',fulfillmentMode:'delivery',defaultDropoff:{lat:7.07,lng:125.61,label:'Home'},createdAt:at,updatedAt:at});
  const first={...line,id:'first',cartId:'colour_cart',quantity:30,sortOrder:0};
  const second={...line,id:'second',cartId:'colour_cart',quantity:1,sortOrder:1};
  store.cartLines.push(first,second);
  queueLineColour(store,item,first,at);
  Object.assign(store.files.find(file=>file.fileId==='colour_art').colourAnalyses[0],{status:'ready',completedAt:at,pages:[{page:1,strongColourBps:4000},{page:2,strongColourBps:4000}]});
  async function call(method,path,body={}) {return routeOrderMatch({req:{method},url:new URL(path,'http://test'),store,user:store.users.find(row=>row.id==='client'),readBody:async()=>body,id:()=>'',now:()=>at});}
  for (const method of ['GET','POST']) {
    const result=await call(method,'/me/carts/colour_cart/quote');
    assert.equal(result.body.quote.clientItemSubtotalMinor,815000);
    assert.deepEqual(result.body.quote.colourPricing.map(row=>row.clientLineSubtotalMinor),[788710,26290]);
    assert.ok(result.body.quote.colourPricing.every(quote=>quote.pages.every(page=>page.sheetPriceMinor!==10000)));
    for (const quote of result.body.quote.colourPricing) {
      noShopPrices(quote);assert.equal(quote.pages.reduce((sum,page)=>sum+page.clientPageTotalMinor,0),quote.clientLineSubtotalMinor);
    }
  }
  const cart=(await call('GET','/me/carts/colour_cart')).body.cart;
  assert.ok(cart.lines.every(line=>line.colourPricing.pages.every(page=>page.sheetPriceMinor!==10000)));
  for (const row of cart.lines) {assert.equal(Object.hasOwn(row,'lineSubtotalMinor'),false);noShopPrices(row.colourPricing);assert.equal(Object.hasOwn(row.listing.colourPricing.sizes[0],'prices'),false);}
  const standalone=(await call('POST','/me/catalog-quotes',{catalogItemId:item.id,...line,quantity:30})).body.quote;
  noShopPrices(standalone.colourPricing);assert.equal(standalone.colourPricing.clientLineSubtotalMinor,790000);
});


test('legacy approved colour snapshots use canonical public and private projections without rewriting history', async () => {
  const { listingSnapshot, approvedCatalogView } = await import('../src/catalog-review-state.js');
  const { privateCatalogItem, publicCatalogItem } = await import('../src/supplier-catalog.js');
  const { store, item } = colourFixture();
  Object.assign(item, parseColourListing({ pricedByColour: true, colourPricing: { sizes: [
    { paperSize: '4x8 ft', tierSet: 'large_format', prices: { none: 1000, above_50: 4000, up_to_25: 2000, up_to_50: 3000 } },
    { paperSize: 'A4', tierSet: 'large_format', prices: { above_50: 500, none: 0 } },
  ] } }, item));
  item.approvedSnapshot = listingSnapshot(store, item);
  const sizes = item.approvedSnapshot.item.colourPricing.sizes;
  item.approvedSnapshot.item.colourPricing.sizes = ['4x8 ft', 'A4'].map(name => sizes.find(size => size.paperSize === name));
  item.approvedSnapshot.item.colourPricing.sizes[0].prices = { none: 1000, above_50: 4000, up_to_25: 2000, up_to_50: 3000 };
  item.reviewStatus = 'pending';
  const original = structuredClone(item);
  const view = approvedCatalogView(store);
  const approved = view.catalogItems.find(row => row.id === item.id);
  assert.deepEqual(approved.colourPricing.sizes.map(size => size.paperSize), ['A4', '4x8 ft']);
  assert.deepEqual(Object.keys(approved.colourPricing.sizes[1].prices), ['none', 'up_to_25', 'up_to_50', 'above_50']);
  const privateItem = privateCatalogItem(store, { ...item, colourPricing: original.approvedSnapshot.item.colourPricing });
  const directPublic = publicColourListing(original.approvedSnapshot.item.colourPricing);
  assert.deepEqual(directPublic.sizes.map(size => size.paperSize), ['A4', '4x8 ft']);
  assert.deepEqual(directPublic.sizes[1].offeredTiers, ['none', 'up_to_25', 'up_to_50', 'above_50']);
  assert.deepEqual(privateItem.colourPricing.sizes.map(size => size.paperSize), ['A4', '4x8 ft']);
  assert.deepEqual(Object.entries(privateItem.colourPricing.sizes[1].prices),
    [['none', 1000], ['up_to_25', 2000], ['up_to_50', 3000], ['above_50', 4000]]);
  const publicItem = publicCatalogItem(store, item);
  assert.deepEqual(publicItem.colourPricing.sizes.map(size => size.paperSize), ['A4', '4x8 ft']);
  assert.deepEqual(publicItem.colourPricing.sizes[1].offeredTiers, ['none', 'up_to_25', 'up_to_50', 'above_50']);
  assert.ok(publicItem.colourPricing.sizes.every(size => !Object.hasOwn(size, 'prices')));
  assert.deepEqual(item, original);
});
