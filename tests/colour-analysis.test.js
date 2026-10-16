import test from 'node:test';
import assert from 'node:assert/strict';
import { colourFixture } from './helpers/colour-fixture.mjs';
import { colourRequestFor,queueLineColour,colourQuoteFor,colourPriceChecks,analysisKey } from '../src/colour-analysis.js';
import { parseColourCorrection } from '../src/colour-correction.js';
import { priceCatalogSelection,selectedCatalogPrice,publicCatalogItem } from '../src/supplier-catalog.js';
import { AT } from './fixtures/reschedule.js';
function complete(store,item,line) {
  queueLineColour(store,item,line,AT);
  const job = store.files.find(row=>row.fileId==='colour_art').colourAnalyses[0];
  Object.assign(job,{status:'ready',completedAt:AT,pages:[{page:1,strongColourBps:0},{page:2,strongColourBps:1800}]});
  return job;
}
test('queued layout analysis gates pricing; shop sheet prices are exact and never option-marked up',()=>{
  const {store,item,line}=colourFixture();
  assert.equal(colourQuoteFor(store,item,line).status,'pending');
  complete(store,item,line);
  const {selectedOptions}=selectedCatalogPrice(store,item,line.optionIds);
  const quote=priceCatalogSelection(store,item,{quantity:3,selectedOptions,artworkSelection:line});
  assert.equal(quote.lineSubtotalMinor,27000); assert.equal(quote.colourPricing.totalSheets,6);
  assert.equal(publicCatalogItem(store,item).effectivePriceMinor,null);
  line.quantityMode=null; assert.equal(colourQuoteFor(store,item,line).status,'quantity_mode_required');
});
test('unpriced tier exposes page flag to Ops, with no fallback total; quantity mode cannot hide it',()=>{
  const {store,item,line}=colourFixture({missing:true});complete(store,item,line);
  store.carts.push({id:'cart',clientId:'client',state:'draft'});store.cartLines.push({...line,cartId:'cart',quantityMode:null});
  const quote=colourQuoteFor(store,item,line);
  assert.equal(quote.status,'needs_price_check');assert.equal(quote.pages[1].sheetPriceMinor,null);assert.equal(quote.lineSubtotalMinor,null);
  assert.equal(colourPriceChecks(store).length,1);
});
test('layout, threshold, paper and original-file changes cannot reuse another analysis',()=>{
  const {store,item,line}=colourFixture();complete(store,item,line);
  const key=analysisKey(colourRequestFor(store,item,line));
  line.printLayout='actual_size_centered';assert.notEqual(analysisKey(colourRequestFor(store,item,line)),key);assert.equal(colourQuoteFor(store,item,line).status,'pending');
  line.printLayout='fit_to_paper';store.settings.colourDetection.minSaturationBps=9000;assert.equal(colourQuoteFor(store,item,line).status,'pending');
});
test('one-colour warning never changes or blocks the fixed shop price; ranges price only printed pages',()=>{
  const {store,item,line}=colourFixture({priced:false});complete(store,item,line);
  assert.match(colourQuoteFor(store,item,line).warning,/Your file has colour/);
  item.printLayouts=[];line.printLayout=null;
  assert.equal(colourQuoteFor(store,item,line).status,'pending'); // Source analysis required, no null-check crash.
  const priced=colourFixture();complete(priced.store,priced.item,priced.line);
  priced.line.documentPages={range:'2'};assert.equal(colourQuoteFor(priced.store,priced.item,priced.line).lineSubtotalMinor,18000);
});
test('corrections validate every original page and calculate the supplement without rewriting evidence',()=>{
  const {store,item,line}=colourFixture();complete(store,item,line);line.colourPricing=colourQuoteFor(store,item,line);
  const original=structuredClone(line.colourPricing);
  const value={pages:[{fileId:'colour_art',page:1,strongColourBps:1800,sheetPriceMinor:6000},{fileId:'colour_art',page:2,strongColourBps:1800,sheetPriceMinor:6000}]};
  assert.equal(parseColourCorrection(store,store.orders[0],line,value).correctedLineSubtotalMinor,36000);
  assert.deepEqual(line.colourPricing,original);
  value.pages[0].page=2;assert.throws(()=>parseColourCorrection(store,store.orders[0],line,value),{code:'invalid_colour_correction'});
});

test('cart refresh reaches its owner and staff, never an unrelated client',async()=>{
  const {invalidateAudienceIds}=await import('../src/notifications.js');
  const {store}=colourFixture();
  const audience=invalidateAudienceIds(store,{resource:'carts',id:'cart',clientId:'client'});
  assert.ok(audience.includes('client'));assert.ok(audience.includes('ops'));assert.ok(audience.includes('admin'));assert.ok(!audience.includes('other'));
});

test('approved price tables isolate pending shop revisions from quotes',async()=>{
  const {listingSnapshot}=await import('../src/catalog-review-state.js');
  const {store,item,line}=colourFixture();complete(store,item,line);
  const approved=listingSnapshot(store,item);
  item.approvedSnapshot=approved;item.reviewStatus='pending';
  item.colourPricing.sizes[0].prices.up_to_25=999999;
  assert.equal(colourQuoteFor(store,item,line).lineSubtotalMinor,27000);
});

test('duplicate artwork is refused instead of producing ambiguous dispute evidence',()=>{
  const {store,item,line}=colourFixture();complete(store,item,line);
  line.artworkAttachments=[{kind:'file',fileId:'colour_art'},{kind:'file',fileId:'colour_art'}];
  assert.equal(colourQuoteFor(store,item,line).status,'duplicate_artwork_unsupported');
});
