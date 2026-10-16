import test from 'node:test';
import assert from 'node:assert/strict';
import { colourSettings, validateColourSettings, strongPixel, measurePrintedColour, colourTier, priceColourPages, parseColourListing } from '../src/colour-pricing.js';

const settings = colourSettings();
test('neutral, black and pastel pixels are cheap; saturated orange/red/green/blue count', () => {
  for (const rgb of [[0,0,0], [255,255,255], [120,120,120], [255,230,220], [2,0,0]]) assert.equal(strongPixel(...rgb, settings), false);
  for (const rgb of [[255,120,0], [255,0,0], [0,180,0], [0,0,255]]) assert.equal(strongPixel(...rgb, settings), true);
  assert.equal(strongPixel(255,120,0, {...settings, minSaturationBps: 10000}), true);
  assert.equal(strongPixel(255,120,1, {...settings, minSaturationBps: 10000}), false);
  assert.throws(() => validateColourSettings({...settings, maxLightnessBps: 10001}), /invalid_colour_settings/);
});
test('coverage is the whole printed paper, including white margins and clipping', () => {
  const page = { width: 2, height: 2, pixels: Buffer.from([255,0,0, 255,0,0, 255,255,255, 255,255,255]), widthMilli: 100000, heightMilli: 100000 };
  assert.equal(measurePrintedColour(page, null, 'source', settings).strongColourBps, 5000);
  const paper = {widthMilli: 200000, heightMilli: 200000};
  assert.equal(measurePrintedColour(page, paper, 'actual_size_centered', settings).strongColourBps, 1250);
  assert.equal(measurePrintedColour(page, paper, 'fit_to_paper', settings).strongColourBps, 5000);
  assert.equal(measurePrintedColour(page, {widthMilli: 100000, heightMilli: 50000}, 'actual_size_original_position', settings).strongColourBps, 10000);
});
test('tier boundaries are inclusive and A3 cutoff is editable', () => {
  assert.deepEqual([0,1,2500,2501,5000,5001,10000].map(b => colourTier(b,'large_format',settings)), ['none','up_to_25','up_to_25','up_to_50','up_to_50','above_50','above_50']);
  assert.equal(colourTier(1000,'a3',settings), 'monochrome');
  assert.equal(colourTier(1001,'a3',settings), 'full_colour');
  assert.equal(colourTier(1500,'a3',{...settings,a3MonochromeMaxBps:2000}), 'monochrome');
});
test('each page uses its own shop price, with identical sets/copies sheet maths and no fallback', () => {
  const pages = [{page:1,strongColourBps:0},{page:2,strongColourBps:1800},{page:3,strongColourBps:4000}];
  const prices = {none:3000,up_to_25:6000,up_to_50:10000,above_50:20000};
  for (const quantityMode of ['copies_each_page','document_sets']) {
    const quote = priceColourPages(pages, {tierSet:'large_format',prices}, settings, 3, quantityMode);
    assert.equal(quote.totalSheets, 9); assert.equal(quote.lineSubtotalMinor, 57000);
    assert.equal(quote.pages[1].sheetPriceMinor, 6000);
  }
  const quote = priceColourPages(pages, {tierSet:'large_format', prices:{none:0}}, settings, 2, 'document_sets');
  assert.equal(quote.status,'needs_price_check'); assert.equal(quote.lineSubtotalMinor,null);
  assert.equal(quote.pages[0].sheetPriceMinor,0); assert.equal(quote.pages[1].sheetPriceMinor,null);
  assert.equal(quote.pages[1].message,'This page needs a price check');
  assert.throws(() => priceColourPages(pages, {tierSet:'large_format',prices}, settings, Number.MAX_SAFE_INTEGER,'document_sets'), /invalid_money/);
});
test('shop configuration rejects invented tiers, floating prices and fixed-price units', () => {
  const listing = {pricingUnit:'per_page',printLayouts:['fit_to_paper']};
  const body = {pricedByColour:true,colourPricing:{sizes:[{paperSize:'20x30',tierSet:'large_format',prices:{none:3000,up_to_25:6000}}]}};
  const parsed = parseColourListing(body, listing);
  assert.equal(parsed.colourPricing.sizes[0].prices.up_to_50,undefined);
  assert.throws(() => parseColourListing(body,{...listing,pricingUnit:'per_area'}), /colour_pricing_requires_per_page/);
  assert.throws(() => parseColourListing({...body,colourPricing:{sizes:[{paperSize:'A3',tierSet:'constructor',prices:{}}]}},listing), /invalid_colour_pricing/);
  assert.throws(() => parseColourListing({...body,oneColour:true},listing), /invalid_colour_pricing/);
  assert.throws(() => parseColourListing({...body,colourPricing:{sizes:[{paperSize:'A3',tierSet:'large_format',prices:{none:1}}]}},listing), /invalid_colour_pricing/);
  assert.throws(() => parseColourListing({...body,colourPricing:{sizes:[{paperSize:'A3',tierSet:{toString:null},prices:{}}]}},listing), /invalid_colour_pricing/);
  assert.throws(() => parseColourListing({...body,colourPricing:{sizes:[{paperSize:'A3',tierSet:'a3',prices:{full_colour:1.2}}]}},listing), /invalid_colour_pricing/);
});
