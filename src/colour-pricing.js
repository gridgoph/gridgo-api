import { PricingError } from './pricing.js';
import { parsePaperSize } from './print-layout.js';

export const COLOUR_TIERS = Object.freeze({large_format: ['none','up_to_25','up_to_50','above_50'], a3: ['monochrome','full_colour']});
export const QUANTITY_MODES = Object.freeze(['copies_each_page','document_sets']);
export const ONE_COLOUR_WARNING = 'Your file has colour, but this service prints in one colour. Choose a colour service if you need the colours.';
const fail = (code, details = {}, status = 400) => { throw new PricingError(status, code, code, details); };
export const colourSettings = settings => ({minSaturationBps:2500, minLightnessBps:500, maxLightnessBps:8500, a3MonochromeMaxBps:1000, ...(settings?.colourDetection || {})});
export function validateColourSettings(value) {
  const keys = ['minSaturationBps','minLightnessBps','maxLightnessBps','a3MonochromeMaxBps'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
      || keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10000)
      || value.minSaturationBps === 0 || value.minLightnessBps >= value.maxLightnessBps || value.maxLightnessBps === 10000) fail('invalid_colour_settings');
  return structuredClone(value);
}
export function parseQuantityMode(value) {
  if (value == null) return null;
  if (!QUANTITY_MODES.includes(value)) fail('invalid_quantity_mode');
  return value;
}
/** One order for validated writes, row reads and legacy approved snapshots.
 * Physical dimensions are integers; orientation affects only the final tie-break. */
export function canonicalColourPricing(pricing) {
  if (pricing == null) return null;
  const result = structuredClone(pricing);
  result.sizes.sort((a,b) => {
    const dimensions = Math.min(a.widthMilli,a.heightMilli) - Math.min(b.widthMilli,b.heightMilli)
      || Math.max(a.widthMilli,a.heightMilli) - Math.max(b.widthMilli,b.heightMilli);
    if (dimensions) return dimensions;
    const aKey = `${a.widthMilli}:${a.heightMilli}`, bKey = `${b.widthMilli}:${b.heightMilli}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  for (const size of result.sizes) {
    const tiers = COLOUR_TIERS[size.tierSet];
    size.prices = Object.fromEntries(Object.entries(size.prices)
      .sort(([a],[b]) => tiers.indexOf(a) - tiers.indexOf(b)));
  }
  return result;
}

export function parseColourListing(body, item) {
  const pricedByColour = Object.hasOwn(body,'pricedByColour') ? body.pricedByColour : item.pricedByColour === true;
  const oneColour = Object.hasOwn(body,'oneColour') ? body.oneColour : item.oneColour === true;
  const pricing = Object.hasOwn(body,'colourPricing') ? body.colourPricing : item.colourPricing ?? null;
  if (typeof pricedByColour !== 'boolean' || typeof oneColour !== 'boolean' || (oneColour && pricedByColour)) fail('invalid_colour_pricing');
  if (pricedByColour && item.pricingUnit !== 'per_page') fail('colour_pricing_requires_per_page');
  if (pricedByColour && !item.printLayouts?.length) fail('colour_pricing_requires_print_layout');
  let colourPricing = null;
  if (pricing != null) {
    if (!pricing || typeof pricing !== 'object' || !Array.isArray(pricing.sizes) || pricing.sizes.length > 32) fail('invalid_colour_pricing');
    const seen = new Set();
    const sizes = pricing.sizes.map(size => {
      const paper = parsePaperSize(size?.paperSize);
      const tierSet = size?.tierSet;
      if (!paper || typeof tierSet !== 'string' || !Object.hasOwn(COLOUR_TIERS,tierSet) || ((tierSet === 'a3') !== (paper.pageSize === 'A3')) || !size.prices || typeof size.prices !== 'object' || Array.isArray(size.prices)) fail('invalid_colour_pricing');
      const key = [Math.min(paper.widthMilli,paper.heightMilli),Math.max(paper.widthMilli,paper.heightMilli)].join(':');
      if (seen.has(key)) fail('invalid_colour_pricing'); seen.add(key);
      const prices = {};
      for (const [tier, price] of Object.entries(size.prices)) {
        if (!COLOUR_TIERS[tierSet].includes(tier)) fail('invalid_colour_pricing');
        if (price == null) continue; // Omission and null both mean not offered.
        if (!Number.isSafeInteger(price) || price < 0) fail('invalid_colour_pricing');
        prices[tier] = price;
      }
      return {paperSize: String(size.paperSize).trim(), ...paper, tierSet, prices};
    });
    colourPricing = canonicalColourPricing({sizes});
  }
  if (pricedByColour && !colourPricing?.sizes.length) fail('invalid_colour_pricing');
  return {pricedByColour, oneColour, colourPricing};
}

// HSV saturation excludes near-neutral pixels; HSL lightness excludes pale
// and almost-black pixels. Integer comparisons keep exact threshold boundaries.
export function strongPixel(r,g,b,settings) {
  const high = Math.max(r,g,b), low = Math.min(r,g,b);
  return high > 0 && (high-low)*10000 >= settings.minSaturationBps*high
    && (high+low)*10000 >= settings.minLightnessBps*510
    && (high+low)*10000 <= settings.maxLightnessBps*510;
}

// Sample a bounded, uniformly spaced paper grid. White paper outside the file
// is part of the denominator. Actual-size placements clip at the paper edges.
export function measurePrintedColour(page, paper, layout, settings) {
  if (paper && layout !== 'fit_to_paper' && !(page.widthMilli > 0 && page.heightMilli > 0)) fail('colour_physical_size_unknown', {}, 422);
  const sourceW = page.widthMilli || page.width, sourceH = page.heightMilli || page.height;
  let targetW = paper?.widthMilli || sourceW, targetH = paper?.heightMilli || sourceH;
  // Same automatic feed orientation as the print-layout contract.
  if (paper && sourceW !== sourceH && targetW !== targetH && (sourceW > sourceH) !== (targetW > targetH)) [targetW,targetH] = [targetH,targetW];
  const scale = layout === 'fit_to_paper' ? Math.min(targetW/sourceW,targetH/sourceH) : 1;
  const offsetX = layout === 'actual_size_original_position' ? 0 : (targetW-sourceW*scale)/2;
  const offsetY = layout === 'actual_size_original_position' ? 0 : (targetH-sourceH*scale)/2;
  const width = Math.max(1,Math.round(800*targetW/Math.max(targetW,targetH)));
  const height = Math.max(1,Math.round(800*targetH/Math.max(targetW,targetH)));
  let strong = 0;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const sx = ((x+0.5)*targetW/width-offsetX)/scale;
    const sy = ((y+0.5)*targetH/height-offsetY)/scale;
    if (sx < 0 || sx >= sourceW || sy < 0 || sy >= sourceH) continue;
    const at = (Math.min(page.height-1,Math.floor(sy/sourceH*page.height))*page.width + Math.min(page.width-1,Math.floor(sx/sourceW*page.width)))*3;
    if (strongPixel(page.pixels[at],page.pixels[at+1],page.pixels[at+2],settings)) strong++;
  }
  // Round upwards so a real non-zero area never silently falls into 'none'.
  return {strongColourBps:Math.ceil(strong*10000/(width*height)), strongPixels:strong, sampledPixels:width*height};
}
export function colourTier(bps,tierSet,settings) {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) fail('invalid_colour_result');
  if (tierSet === 'a3') return bps <= settings.a3MonochromeMaxBps ? 'monochrome' : 'full_colour';
  if (tierSet !== 'large_format') fail('invalid_colour_pricing');
  return bps === 0 ? 'none' : bps <= 2500 ? 'up_to_25' : bps <= 5000 ? 'up_to_50' : 'above_50';
}
function safe(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) fail('invalid_money');
  return Number(value);
}
export function priceColourPages(pages,size,settings,quantity,quantityMode) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) fail('invalid_quantity');
  if (!QUANTITY_MODES.includes(quantityMode)) fail('quantity_mode_required',{},409);
  const rows = pages.map(page => {
    const tier = colourTier(page.strongColourBps,size.tierSet,settings);
    const sheetPriceMinor = size.prices[tier] ?? null;
    if (sheetPriceMinor != null && (!Number.isSafeInteger(sheetPriceMinor) || sheetPriceMinor < 0)) fail('invalid_money');
    return {...page, strongColourPercent:page.strongColourBps/100, tier, sheetPriceMinor,
      status:sheetPriceMinor == null ? 'needs_price_check' : 'priced',
      ...(sheetPriceMinor == null ? {message:'This page needs a price check'} : {})};
  });
  const missing = rows.some(page => page.sheetPriceMinor == null);
  return {status:missing ? 'needs_price_check' : 'priced', quantity, quantityMode,
    totalSheets:safe(BigInt(rows.length)*BigInt(quantity)), pages:rows,
    lineSubtotalMinor:missing ? null : safe(rows.reduce((sum,page) => sum+BigInt(page.sheetPriceMinor),0n)*BigInt(quantity))};
}
