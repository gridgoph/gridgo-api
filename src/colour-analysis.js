import crypto from 'node:crypto';
import { artworkFileIdsFor, artworkAttachmentsFor } from './artwork-attachments.js';
import { approvedCatalogView } from './catalog-review-state.js';
import { printLayoutCheck } from './print-layout.js';
import { selectDocumentPages } from './document-pages.js';
import { colourSettings, priceColourPages, ONE_COLOUR_WARNING } from './colour-pricing.js';

export const COLOUR_TYPES = ['application/pdf','image/png','image/jpeg','image/webp'];
export const analysisKey = request => crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
export function sourceColourRequest(settings) {
  return {version:1, layout:'source', paper:null, thresholds:colourSettings(settings)};
}
export function colourRequestFor(store,item,line) {
  const fileIds = artworkFileIdsFor(line);
  const check = printLayoutCheck(store,item,{optionIds:line.optionIds || [],fileIds,layout:line.printLayout});
  if (!check?.paper || !line.printLayout) return item.oneColour ? sourceColourRequest(store.settings) : null;
  return {version:1, layout:line.printLayout, paper:{widthMilli:check.paper.widthMilli,heightMilli:check.paper.heightMilli}, thresholds:colourSettings(store.settings)};
}
export function queueColourRequest(file,request,at,{retry=false}={}) {
  if (!file || file.state !== 'ready' || file.purpose !== 'artwork' || file.deleteRequestedAt || !COLOUR_TYPES.includes(file.detectedContentType) || !request) return false;
  const key = analysisKey(request);
  file.colourAnalyses ||= [];
  const previous = file.colourAnalyses.find(row => row.key === key);
  if (previous && !(retry && previous.status === 'failed' && Date.parse(at)-Date.parse(previous.completedAt) >= 30000)) return false;
  // A bounded number of immutable request/results per upload. New originals
  // can always be uploaded; never evict evidence already used by an order.
  if (!previous && file.colourAnalyses.length >= 32) return false;
  const job = {key, request:structuredClone(request), status:'pending', requestedAt:at};
  if (previous) file.colourAnalyses.splice(file.colourAnalyses.indexOf(previous),1,job);
  else file.colourAnalyses.push(job);
  return true;
}
export function queueLineColour(store,item,line,at,options) {
  const view = approvedCatalogView(store);
  item = view.catalogItems.find(row => row.id === item.id) || item;
  if (!item.pricedByColour && !item.oneColour) return false;
  const request = colourRequestFor(view,item,line);
  let queued = false;
  for (const fileId of artworkFileIdsFor(line)) queued = queueColourRequest(store.files.find(file => file.fileId === fileId),request,at,options) || queued;
  return queued;
}
function rangePages(pages,range) {
  const selected = selectDocumentPages(pages.length,range);
  if (!selected?.range) return pages;
  const intervals = selected.range.split(',').map(part => part.trim().split('-').map(Number));
  return pages.filter(row => intervals.some(([a,b=a]) => row.page >= a && row.page <= b));
}
export function colourQuoteFor(store,item,line) {
  const view = approvedCatalogView(store);
  item = view.catalogItems.find(row => row.id === item.id) || item;
  if (!item.pricedByColour && !item.oneColour) return null;
  const request = colourRequestFor(view,item,line), key = request && analysisKey(request);
  const ids = artworkFileIdsFor(line);
  const base = {version:1, pricedByColour:item.pricedByColour === true, request, quantityMode:line.quantityMode ?? null,
    quantity:line.quantity, pages:[], totalSheets:null, lineSubtotalMinor:null, warning:null, estimate:true};
  if (!request) return {...base,status:'configuration_required'};
  if (!ids.length || artworkAttachmentsFor(line).some(entry => entry.kind !== 'file')) return {...base,status:'artwork_upload_required'};
  if (new Set(ids).size !== ids.length) return {...base,status:'duplicate_artwork_unsupported'};
  const results = ids.map(fileId => {
    const file = view.files.find(row => row.fileId === fileId && row.state === 'ready' && !row.deleteRequestedAt && !row.deletedAt);
    const result = file?.colourAnalyses?.find(row => row.key === key);
    return {fileId,file,result};
  });
  if (results.some(row => !row.file || !COLOUR_TYPES.includes(row.file.detectedContentType))) return {...base,status:'unsupported'};
  if (results.some(row => !row.result && row.file.colourAnalyses?.length >= 32)) return {...base,status:'analysis_limit'};
  if (results.some(row => row.result?.status === 'failed')) return {...base,status:'failed'};
  if (results.some(row => row.result?.status !== 'ready')) return {...base,status:'pending'};
  let pages = results.flatMap(({fileId,result}) => result.pages.map(page => ({...page,strongColourPercent:page.strongColourBps/100,fileId,analysisKey:key,detectedAt:result.completedAt})));
  // Ranges have always referred to the primary document only. Avoid silently
  // treating a range as a selection across unrelated files.
  if (ids.length > 1 && line.documentPages?.range) return {...base,status:'multiple_file_page_range_unsupported'};
  if (ids.length === 1) pages = rangePages(pages,line.documentPages?.range);
  const warning = item.oneColour && pages.some(page => page.strongColourBps > 0) ? ONE_COLOUR_WARNING : null;
  const totalSheets = pages.length*line.quantity;
  if (!Number.isSafeInteger(totalSheets)) throw Object.assign(new Error('invalid_money'),{code:'invalid_money',status:400});
  if (!item.pricedByColour) return {...base,status:'fixed_price',pages,warning,totalSheets};
  const paper = request.paper;
  const size = item.colourPricing?.sizes.find(row => Math.min(row.widthMilli,row.heightMilli) === Math.min(paper.widthMilli,paper.heightMilli)
    && Math.max(row.widthMilli,row.heightMilli) === Math.max(paper.widthMilli,paper.heightMilli));
  if (!size) return {...base,status:'needs_price_check',totalSheets,pages:pages.map(page => ({...page,tier:null,sheetPriceMinor:null,status:'needs_price_check',message:'This page needs a price check'}))};
  const priced = priceColourPages(pages,size,request.thresholds,line.quantity,line.quantityMode || 'copies_each_page');
  if (!line.quantityMode && priced.status === 'priced') return {...base,status:'quantity_mode_required',pages:priced.pages,totalSheets};
  return {...base,...priced, quantityMode:line.quantityMode ?? null, paperSize:size.paperSize,tierSet:size.tierSet,warning};
}
export function publicColourQuote(quote,role) {
  if (!quote || !['client','supplier','ops_admin','super_admin'].includes(role)) return null;
  const result = structuredClone(quote);
  // These are page printing prices, not payout or milestone figures. Client
  // totals continue to use the existing all-in group fee allocation.
  return result;
}
export function colourPriceChecks(store) {
  const view = approvedCatalogView(store);
  return (view.cartLines || []).flatMap(line => {
    const cart = view.carts.find(row => row.id === line.cartId && row.state === 'draft');
    const item = view.catalogItems.find(row => row.id === line.catalogItemId);
    if (!cart || !item?.pricedByColour) return [];
    const quote = colourQuoteFor(view,item,line);
    return quote?.status === 'needs_price_check' ? [{cartId:cart.id,lineId:line.id,clientId:cart.clientId,supplierId:line.supplierId,catalogItemId:item.id,colourPricing:quote}] : [];
  });
}
