import {expressCatalogOptions,expressFail} from './express-orders.js';
import {selectedCatalogPrice,publicCatalogItem} from './supplier-catalog.js';
import {priceExpressPages,resolveExpressPrintRequest,validateExpressPageSelection} from './express-print.js';

// Internal capability: JSON requests cannot force a successful preparation to fall back.
export const EXPRESS_ACCEPTED_ORIGINAL = Symbol('expressAcceptedOriginal');
export const isExpressPrintV2=input=>input.printVersion===2||input.colourMode!=null||input.orientation!=null||input.planType!=null||input.colour==null;
export function expressPreviewState(store,file,input,productType) {
 if(input[EXPRESS_ACCEPTED_ORIGINAL]===true) {
  const {request,key}=resolveExpressPrintRequest(store.settings,file,{...input,previewKey:undefined},productType);
  validateExpressPageSelection(file,request.express);
  return {request,key,analysis:{status:'failed',error:'accepted_original_fallback'},output:null,ready:false};
 }
 const {request,key}=resolveExpressPrintRequest(store.settings,file,input,productType);
 validateExpressPageSelection(file,request.express);
 const analysis=file.colourAnalyses?.find(row=>row.key===key) || (file.colourAnalyses?.length>=32?{status:'failed',error:'colour_analysis_limit'}:null);
 if(!analysis||analysis.status==='pending')expressFail(409,'express_preview_pending');
 const output=store.files.find(f=>f.fileId===analysis.outputFileId&&f.state==='ready'&&!f.deleteRequestedAt&&!f.deletedAt);
 const ready=analysis.status==='ready'&&output?.expressRendering?.key===key;
 if(analysis.status==='ready'&&!ready)expressFail(409,'express_preview_required');
 return {request,key,analysis,output,ready};
}
export function expressV2Selection(store,item,input,productType,file,at) {
 const {request,key,analysis,output,ready}=expressPreviewState(store,file,input,productType);
 const print=request.express;
 const fallbackColour=productType==='plans'?print.ink:print.colourMode==='all_bw'?'bw':'colour';
 const pages=ready?analysis.pages:null;
 const requiresColour=pages?.some(p=>p.printColour==='colour')??fallbackColour==='colour';
 const colour=productType==='plans'?print.colour:requiresColour?'colour':'bw';
 const choice={...input,productType,printVersion:2,colour};
 const standard=expressCatalogOptions(store,item,choice);
 let prices,rateMinor;
 if(productType==='plans'){
  rateMinor=item.expressPricing?.plans?.[print.planType]?.[print.paper]?.[print.ink];
  if(!Number.isSafeInteger(rateMinor)||rateMinor<=0)expressFail(409,'express_listing_configuration_required');
 }else{
  prices=item.expressPricing?.[print.paper];
  if(!prices){
   const priceFor=mode=>{
    const candidates=[item,...store.catalogItems.filter(row=>row.id!==item.id&&row.supplierId===item.supplierId&&row.supplierServiceId===item.supplierServiceId&&row.express&&row.subcategoryCode==='document_printing')];
    for(const candidate of candidates)try{
     if(!publicCatalogItem(store,candidate,{at})||!candidate.printLayouts?.includes(input.layout))continue;
     const options=expressCatalogOptions(store,candidate,{...choice,colour:mode});
     if(options.paperStock!==standard.paperStock)continue;
     return selectedCatalogPrice(store,candidate,options.optionIds).effectiveUnitPriceMinor;
    }catch(error){if(!error.status)throw error;}
    return null;
   };
   const bw=priceFor('bw'),full=priceFor('colour');prices={bw,light:full,full};
  }
  rateMinor=prices[colour==='bw'?'bw':'full'];
  if(!Number.isSafeInteger(rateMinor)||rateMinor<=0)expressFail(409,'express_listing_configuration_required');
 }
 let pagePricing=null;
 if(ready&&productType==='documents') {
  if(pages.some(p=>!Number.isSafeInteger(prices[p.printColour==='bw'?'bw':p.strongColourBps<=print.lightMaxBps?'light':'full'])))expressFail(409,'express_listing_configuration_required');
  pagePricing=priceExpressPages(pages,{...print,copies:input.copies},prices,print.lightMaxBps);
  if(pagePricing.pages.some((p,i)=>p.printColour!==pages[i].printColour))expressFail(409,'express_preview_required');
 }
 return {...standard,rateMinor,print:{...print,printVersion:2,colour,analysisKey:key,
  renderStatus:ready?'ready':'fallback',outputFileId:ready?output.fileId:null,
  ...(pagePricing?{pagePricing}:{}),
  ...(ready?{}:{fallback:{reason:analysis.error||'colour_render_failed',colour:fallbackColour,originalFile:true,
   message:analysis.error==='accepted_original_fallback'?'This request keeps the accepted original-file colour mode.':'Print preparation failed. The original file uses one colour mode; review it before sending.'}})}};
}
export function publicExpressPrint(print,role='client') {
 if(!print)return null;
 const result=structuredClone(print);
 if(!['ops_admin','super_admin'].includes(role))delete result.sourceFileId;
 if(role==='client'){
  delete result.rateMinor;
  if(result.pagePricing){delete result.pagePricing.subtotalMinor;for(const page of result.pagePricing.pages)delete page.priceMinor;}
 }
 return result;
}
