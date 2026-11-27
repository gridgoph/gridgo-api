import { PricingError } from './pricing.js';
import { parsePaperSize, PRINT_LAYOUTS } from './print-layout.js';
import { selectDocumentPages } from './document-pages.js';
import { colourSettings } from './colour-pricing.js';
import { analysisKey, queueColourRequest, COLOUR_TYPES } from './colour-analysis.js';

const fail = code => {throw new PricingError(400,code,code);};
export const EXPRESS_PLAN_SIZES = ['20x30','24x36','30x40','a2','a1','a0'];
export const EXPRESS_LIGHT_DEFAULT_BPS = 2500;
export function expressDocumentTier(bps,lightMaxBps=EXPRESS_LIGHT_DEFAULT_BPS) {
 if(!Number.isSafeInteger(bps)||bps<0||bps>10000||!Number.isSafeInteger(lightMaxBps)||lightMaxBps<0||lightMaxBps>10000)fail('invalid_colour_result');
 return bps===0?'bw':bps<=lightMaxBps?'light':'full';
}
export function selectedPageNumbers(total,range) {
 const selected=selectDocumentPages(total,range);
 if(!selected)fail('document_page_count_required');
 if(!selected.range)return Array.from({length:total},(_,i)=>i+1);
 return selected.range.split(',').flatMap(part=>{const [a,b=a]=part.trim().split('-').map(Number);return Array.from({length:b-a+1},(_,i)=>a+i);});
}
export function normalizeExpressPrint(input,productType='documents') {
 const orientation=input.orientation??'auto',layout=input.layout;
 if(!['auto','portrait','landscape'].includes(orientation))fail('invalid_express_orientation');
 if(!PRINT_LAYOUTS.includes(layout))fail('invalid_print_layout');
 if(!['one','two'].includes(input.sides))fail('invalid_express_print');
 const common={productType,paper:input.paper,sides:input.sides,orientation,layout,pageRange:selectDocumentPages(Number.MAX_SAFE_INTEGER,input.pageRange??null).range};
 if(productType==='plans') {
  if(!EXPRESS_PLAN_SIZES.includes(input.paper)||orientation!=='auto'||input.sides!=='one')fail('invalid_express_plan');
  if(!['whiteprint','blue_ink','blue_paper'].includes(input.planType))fail('invalid_express_plan');
  if(input.planType==='whiteprint'?!['bw','colour'].includes(input.colour):input.colour!=='blue')fail('invalid_express_plan_colour');
  return {...common,planType:input.planType,colour:input.colour,ink:input.planType==='whiteprint'?input.colour:'blue',paperColour:input.planType==='blue_paper'?'blue':'white'};
 }
 if(productType!=='documents'||!['a4','short','long','a3'].includes(input.paper))fail('invalid_express_print');
 const colourMode=input.colourMode??'auto';
 if(!['auto','all_bw','choose'].includes(colourMode))fail('invalid_express_colour_mode');
 if(colourMode!=='choose'&&input.colourPages!=null)fail('invalid_express_colour_pages');
 if(colourMode==='choose'&&(typeof input.colourPages!=='string'||input.colourPages.length>1000))fail('invalid_express_colour_pages');
 return {...common,colourMode,colourPages:colourMode==='choose'?(selectDocumentPages(Number.MAX_SAFE_INTEGER,input.colourPages).range||''):null};
}
export function priceExpressPages(pages,print,prices,lightMaxBps=EXPRESS_LIGHT_DEFAULT_BPS) {
 if(!Number.isSafeInteger(print.copies)||print.copies<1||!pages.length)fail('invalid_quantity');
 const chosen=new Set(print.colourMode==='choose'&&print.colourPages?selectedPageNumbers(Math.max(...pages.map(p=>p.page)),print.colourPages):[]);
 if([...chosen].some(page=>!pages.some(p=>p.page===page)))fail('invalid_express_colour_pages');
 const rows=pages.map(page=>{
  const measuredTier=expressDocumentTier(page.strongColourBps,lightMaxBps);
  const tier=print.colourMode==='all_bw'||print.colourMode==='choose'&&!chosen.has(page.page)?'bw':measuredTier;
  const priceMinor=prices[tier];
  if(!Number.isSafeInteger(priceMinor)||priceMinor<0)fail('invalid_money');
  return {...page,measuredTier,tier,printColour:tier==='bw'?'bw':'colour',youSet:tier!==measuredTier,priceMinor};
 });
 const subtotal=rows.reduce((sum,p)=>sum+BigInt(p.priceMinor),0n)*BigInt(print.copies);
 if(subtotal>BigInt(Number.MAX_SAFE_INTEGER))fail('invalid_money');
 return {pages:rows,subtotalMinor:Number(subtotal),counts:Object.fromEntries(['bw','light','full'].map(tier=>[tier,rows.filter(p=>p.tier===tier).length]))};
}
export function expressPrintRequest(settings,input,productType) {
 const print=normalizeExpressPrint(input,productType);
 const paper=parsePaperSize(print.paper);
 return {version:2,layout:print.layout,paper:{widthMilli:paper.widthMilli,heightMilli:paper.heightMilli},orientation:print.orientation,
  thresholds:colourSettings(settings),express:{...print,lightMaxBps:settings?.expressLightColourMaxBps??EXPRESS_LIGHT_DEFAULT_BPS}};
}
/** An owning-file preview can pin the settings measured before a staff edit.
 * Rebuild its canonical request, so the key binds every choice after JSONB reads. */
export function resolveExpressPrintRequest(settings,file,input,productType) {
 let request=expressPrintRequest(settings,input,productType);
 if(input.previewKey!=null) {
  if(typeof input.previewKey!=='string'||!/^[a-f0-9]{64}$/.test(input.previewKey))fail('invalid_express_preview_key');
  const previous=file.colourAnalyses?.find(row=>row.key===input.previewKey&&row.request?.version===2&&row.request?.express);
  if(!previous)throw new PricingError(409,'express_preview_required','Review the prepared print settings.');
  request=expressPrintRequest({colourDetection:previous.request.thresholds,expressLightColourMaxBps:previous.request.express.lightMaxBps},input,productType);
  if(analysisKey(request)!==input.previewKey)throw new PricingError(409,'express_preview_required','Review the prepared print settings.');
 }
 return {request,key:analysisKey(request)};
}
export function validateExpressPageSelection(file,print) {
 const total=Number.isSafeInteger(file.detected?.pageCount)&&file.detected.pageCount>0?file.detected.pageCount:Number.MAX_SAFE_INTEGER;
 const printed=selectDocumentPages(total,print.pageRange);
 if(print.colourMode!=='choose'||!print.colourPages)return;
 const chosen=selectDocumentPages(total,print.colourPages);
 if(!printed.range)return;
 const intervals=range=>range.split(',').map(part=>{const [a,b=a]=part.trim().split('-').map(Number);return [a,b];});
 if(intervals(chosen.range).some(([a,b])=>!intervals(printed.range).some(([start,end])=>start<=a&&end>=b)))fail('invalid_express_colour_pages');
}
export function ensureExpressPreview(store,file,input,productType,at,{retry=false}={}) {
 const {request,key}=resolveExpressPrintRequest(store.settings,file,input,productType);
 validateExpressPageSelection(file,request.express);
 let queued=queueColourRequest(file,request,at,{retry});
 if(!COLOUR_TYPES.includes(file.detectedContentType)&&file.state==='ready'&&!file.colourAnalyses?.some(row=>row.key===key)&&(!file.colourAnalyses||file.colourAnalyses.length<32)) {
  (file.colourAnalyses||=[]).push({key,request,status:'failed',error:'colour_file_unsupported',requestedAt:at,completedAt:at});queued=true;
 }
 return {key,request,queued,analysis:file.colourAnalyses?.find(row=>row.key===key)};
}

export function parseExpressPricing(value) {
 if(value==null)return null;
 const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
 const rates=(row,keys)=>{
  if(!object(row)||Object.keys(row).length!==keys.length||keys.some(k=>!Number.isSafeInteger(row[k])||row[k]<=0||row[k]%100!==0))fail('invalid_express_pricing');
  return Object.fromEntries(keys.map(k=>[k,row[k]]));
 };
 if(!object(value)||Object.keys(value).some(k=>!['a4','short','long','a3','plans'].includes(k)))fail('invalid_express_pricing');
 const result={};for(const paper of ['a4','short','long','a3'])if(value[paper]!=null)result[paper]=rates(value[paper],['bw','light','full']);
 if(value.plans!=null){if(!object(value.plans)||Object.keys(value.plans).some(k=>!['whiteprint','blue_ink','blue_paper'].includes(k)))fail('invalid_express_pricing');
  result.plans={};for(const [type,sizes]of Object.entries(value.plans)){
   if(!object(sizes)||Object.keys(sizes).some(k=>!EXPRESS_PLAN_SIZES.includes(k)))fail('invalid_express_pricing');
   result.plans[type]=Object.fromEntries(Object.entries(sizes).map(([size,row])=>[size,rates(row,type==='whiteprint'?['bw','colour']:['blue'])]));
  }}
 return result;
}
