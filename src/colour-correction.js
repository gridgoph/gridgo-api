import { colourTier } from './colour-pricing.js';
import { changesFor } from './order-change-policy.js';
const fail = code => {throw Object.assign(new Error(code),{code,status:400});};
/** A shop's correction is a separate, consented amendment, never a rewrite. */
export function parseColourCorrection(store,order,line,value) {
  if (!line?.colourPricing?.pricedByColour || !value || typeof value !== 'object' || !Array.isArray(value.pages)) fail('invalid_colour_correction');
  const original = line.colourPricing;
  const prior = changesFor(store,order).filter(row => row.lineItemId === line.id && row.status === 'applied' && row.data.colourCorrection).at(-1)?.data.colourCorrection;
  if (value.pages.length !== original.pages.length) fail('invalid_colour_correction');
  const seen = new Set();
  const pages = value.pages.map(row => {
    const match = original.pages.find(page => page.fileId === row?.fileId && page.page === row.page);
    const key = `${row?.fileId}:${row?.page}`;
    if (!match || seen.has(key) || !Number.isSafeInteger(row.sheetPriceMinor) || row.sheetPriceMinor < 0) fail('invalid_colour_correction');
    seen.add(key);
    return {fileId:match.fileId,page:match.page,strongColourBps:row.strongColourBps,
      tier:colourTier(row.strongColourBps,original.tierSet,original.request.thresholds),sheetPriceMinor:row.sheetPriceMinor};
  });
  const total = pages.reduce((sum,row)=>sum+BigInt(row.sheetPriceMinor),0n)*BigInt(original.quantity);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_change_amount');
  const originalLineSubtotalMinor = prior?.correctedLineSubtotalMinor ?? original.lineSubtotalMinor;
  const correctedLineSubtotalMinor = Number(total);
  if (correctedLineSubtotalMinor < originalLineSubtotalMinor) throw Object.assign(new Error('Use the existing Operations refund flow for a price reduction.'),{code:'colour_correction_refund_required',status:409});
  return {version:1,pages,originalLineSubtotalMinor,correctedLineSubtotalMinor,
    quantity:original.quantity,quantityMode:original.quantityMode,totalSheets:original.totalSheets};
}
