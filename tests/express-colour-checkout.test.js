import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,caller} from './fixtures/scheduling.js';
import {ensureExpressPreview} from '../src/express-print.js';
import {authorizeFileRead} from '../src/attachments.js';
import {publicOrderFor} from '../src/operational-model.js';
const AT='2026-09-23T01:00:00.000Z',location={lat:7.064,lng:125.6085};
const input={fileId:'file_art',copies:2,paper:'a4',colourMode:'choose',colourPages:'2',orientation:'portrait',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]};
function setup(){const {store,client}=fixture({express:true});
 for(const item of store.catalogItems)Object.assign(item,{express:true,pricingUnit:'per_page',subcategoryCode:'document_printing',printLayouts:['fit_to_paper'],expressPricing:{a4:{bw:200,light:400,full:600}}});
 for(const service of store.supplierServices)Object.assign(service,{categoryCode:'document_publication',turnaroundHours:1,standardTurnaroundHours:1});
 const file=store.files.find(f=>f.fileId==='file_art');file.detected={pageCount:3};
 return {store,client,file,call:caller(store,client,AT)};
}
function complete(store,file){const {analysis,key}=ensureExpressPreview(store,file,input,'documents',AT);
 Object.assign(analysis,{status:'ready',outputFileId:'printed',completedAt:AT,pages:[{page:1,strongColourBps:0,printColour:'bw'},{page:2,strongColourBps:1500,printColour:'colour'},{page:3,strongColourBps:5000,printColour:'bw'}]});
 store.files.push({...structuredClone(file),fileId:'printed',objectKey:'private/print.pdf',colourAnalyses:[],expressRendering:{key,sourceFileId:file.fileId},references:[]});return analysis;
}
test('preview queues an owned immutable print specification and returns pending without leaking private keys',async()=>{
 const {store,call}=setup();const response=await call('POST','/express/preview',{productType:'documents',files:[input]});
 assert.equal(response?.status,202);assert.equal(response.body.files[0].status,'pending');assert.equal(store.files.find(f=>f.fileId==='file_art').colourAnalyses.length,1);
 assert.doesNotMatch(JSON.stringify(response),/objectKey|private\//);
});
test('GET map exact page mix equals checkout and shops receive only the prepared file',async()=>{
 const {store,file,call,client}=setup();complete(store,file);
 const params=new URLSearchParams({lat:String(location.lat),lng:String(location.lng),sort:'cheapest',files:JSON.stringify([input])});
 const list=await call('GET',`/express/shops?${params}`);assert.ok(list.body.shops.length>=2);
 assert.equal(list.body.shops[0].price.perPageMixed,true);
 const draft=await call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',files:[input]});
 assert.equal(list.body.shops.find(s=>s.supplierId==='shop_a').price.totalMinor,draft.body.quote.totalMinor);
 const placed=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'PRINT1',proofFileId:'file_qr'}});
 const order=store.orders.find(o=>o.id===placed.body.order.id);assert.equal(order.supplierSubtotalMinor,1600);assert.equal(order.totalMinor,draft.body.quote.totalMinor);
 const line=store.orderLineItems.find(l=>l.orderId===order.id);assert.equal(line.artworkFileId,'printed');assert.equal(line.expressOriginalFileId,'file_art');
 order.fileCheck={status:'passed'};
 const supplier={id:'shop_a',role:'supplier'};assert.throws(()=>authorizeFileRead(supplier,store,file),e=>e.status===403);
 assert.doesNotThrow(()=>authorizeFileRead(supplier,store,store.files.find(f=>f.fileId==='printed')));
 const shop=publicOrderFor(order,supplier,store);assert.equal(shop.expressOrder.printSettings[0].fileId,'printed');assert.equal(shop.expressOrder.printSettings[0].outputAlreadyApplied,true);
 assert.equal(shop.expressOrder.printSettings[0].sourceFileId,undefined);assert.doesNotMatch(JSON.stringify(shop),/file_art/);
 const own=publicOrderFor(order,client,store);assert.doesNotMatch(JSON.stringify(own.expressOrder),/priceMinor|subtotalMinor|rateMinor/);
});
test('failed preparation quotes the original whole-file mode with a clear frozen fallback',async()=>{
 const {store,file,call}=setup();const {analysis}=ensureExpressPreview(store,file,input,'documents',AT);Object.assign(analysis,{status:'failed',error:'colour_render_failed'});
 const draft=await call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',files:[input]});
 const line=store.cartLines.find(l=>l.cartId===draft.body.cartId);assert.equal(line.expressPrint.renderStatus,'fallback');assert.equal(line.expressPrint.fallback.colour,'colour');
 assert.equal(line.expressPrint.rateMinor,600);assert.equal(draft.body.printPreview[0].fallback.originalFile,true);
 assert.equal(draft.body.quote.totalMinor,3960); // 3 pages x 2 x 600, fixture fee.
 complete(store,file);
 const placed=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'FALLBACK1',proofFileId:'file_qr'}});
 const order=store.orders.find(o=>o.id===placed.body.order.id);assert.equal(order.totalMinor,draft.body.quote.totalMinor);assert.equal(order.expressOrder.printSettings[0].renderStatus,'fallback');
});

test('fresh shops without tiers use approved shop B&W/colour rates and Light defaults to Full',async()=>{
 const {store,file,call}=setup();complete(store,file);
 for(const item of store.catalogItems){delete item.expressPricing;item.basePriceMinor=700;
  store.catalogOptionGroups.push({id:`colour_${item.id}`,catalogItemId:item.id,name:'Colour',kind:'spec',required:true});
  for(const [suffix,label,priceModifierMinor] of [['bw','B&W',-500],['clr','Colour',0]])store.catalogOptions.push({id:`${suffix}_${item.id}`,optionGroupId:`colour_${item.id}`,label,priceModifierMinor,active:true});
 }
 const result=await call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',files:[input]});
 const line=store.cartLines.find(l=>l.cartId===result.body.cartId);
 assert.deepEqual(line.expressPrint.pagePricing.pages.map(p=>p.priceMinor),[200,700,200]);
 assert.equal(line.expressPrint.pagePricing.subtotalMinor,2200);
});
test('Plans use explicit shop prices for the exact type and dimensions',async()=>{
 const {store,file,call}=setup();
 for(const item of store.catalogItems)Object.assign(item,{subcategoryCode:'blueprint_cad_plotting',expressPricing:{plans:{whiteprint:{'20x30':{bw:3000,colour:6000},a2:{bw:2000,colour:4000}},blue_paper:{'20x30':{blue:3500}}}}});
 const plan={fileId:file.fileId,copies:2,paper:'20x30',planType:'whiteprint',colour:'bw',sides:'one',orientation:'auto',layout:'fit_to_paper',acceptedWarnings:[]};
 const variant=ensureExpressPreview(store,file,plan,'plans',AT);Object.assign(variant.analysis,{status:'failed',error:'colour_print_resolution_limit'});
 const draft=await call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',productType:'plans',files:[plan]});
 const line=store.cartLines.find(l=>l.cartId===draft.body.cartId);assert.equal(line.expressPrint.rateMinor,3000);assert.equal(line.expressPrint.planType,'whiteprint');
 assert.equal(line.expressPrint.renderStatus,'fallback');assert.equal(line.expressPrint.paper,'20x30');
 for(const change of [{orientation:'portrait'},{sides:'two'},{planType:'blue_paper',colour:'colour'},{paper:'a4'}])await assert.rejects(call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',productType:'plans',files:[{...plan,...change}]}));
});
test('preview rejects another client file and unsupported sources expose fallback rather than waiting forever',async()=>{
 const {store,file,call}=setup();file.ownerId='someone_else';
 await assert.rejects(call('POST','/express/preview',{files:[input]}),e=>e.status===409 && e.code==='file_not_ready');
 file.ownerId='user_client';file.detectedContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 const result=await call('POST','/express/preview',{files:[input]});assert.equal(result.status,200);assert.equal(result.body.files[0].status,'failed');assert.equal(result.body.files[0].fallback.originalFile,true);
});

test('pending preparation reports a preview state before shop selection',async()=>{
 const {call}=setup();await call('POST','/express/preview',{files:[input]});
 await assert.rejects(call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',files:[input]}),e=>e.code==='express_preview_pending');
});
test('assigned riders receive no print settings or original file metadata',async()=>{
 const {publicExpress}=await import('../src/express-orders.js');
 const order={clientId:'client',supplierId:'shop',riderId:'rider',expressOrder:{printSettings:[{sourceFileId:'private_original'}]}};
 assert.equal(publicExpress(order,{id:'rider',role:'rider'}).printSettings,undefined);
});

test('shop Staff receive applied print instructions and per-page mix without money',async()=>{
 const {staffExpressProjection}=await import('../src/shop-staff-order.js');
 const result=staffExpressProjection({printSettings:[{fileId:'prepared',sourceFileId:'original',orientation:'portrait',colourMode:'choose',colourPages:'2',renderStatus:'ready',planType:'whiteprint',outputAlreadyApplied:true,
  productionPrint:{layout:'actual_size_centered',orientation:'auto',colour:'as_prepared',pageRange:null},pages:{total:3,range:'2-3',printed:2},rateMinor:500,
  pagePricing:{subtotalMinor:1400,counts:{bw:1,light:1,full:0},pages:[{page:2,printColour:'colour',tier:'light',priceMinor:400},{page:3,printColour:'bw',tier:'bw',priceMinor:300}]}}]});
 assert.equal(result.printSettings[0].outputAlreadyApplied,true);assert.equal(result.printSettings[0].productionPrint.pageRange,null);assert.equal(result.printSettings[0].orientation,'portrait');
 assert.equal(result.printSettings[0].pageMix.pages[0].tier,'light');assert.deepEqual(staffExpressProjection(result),result);assert.doesNotMatch(JSON.stringify(result),/priceMinor|subtotalMinor|rateMinor|original/);
});

test('legacy reassignment cannot move a shop-priced page mix to another shop without a new quote',async()=>{
 const {declineExpress,startExpressAcceptance}=await import('../src/express-orders.js');
 const {store,file,call}=setup();complete(store,file);
 const draft=await call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',files:[input]});
 const placed=await call('POST',`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'MIX-DECLINE',proofFileId:'file_qr'}});
 const order=store.orders.find(o=>o.id===placed.body.order.id);order.state='supplier_assigned';startExpressAcceptance(order,AT);
 declineExpress(store,order,{at:AT,id:p=>`${p}_decline`,kind:'declined'});
 assert.equal(order.supplierId,'shop_a');assert.equal(order.state,'cancelled');assert.equal(order.expressOrder.repickRequired,true);
});

test('ready preview exposes page tags and counts before choosing a shop',async()=>{
 const {store,file,call}=setup();complete(store,file);
 const response=await call('POST','/express/preview',{files:[input]});
 assert.deepEqual(response.body.files[0].counts,{bw:2,light:1,full:0});
 assert.deepEqual(response.body.files[0].pages.map(p=>p.tier),['bw','light','bw']);
 assert.equal(response.body.files[0].pages[2].youSet,true);assert.doesNotMatch(JSON.stringify(response),/priceMinor|subtotalMinor/);
});

test('unapproved sibling listing prices cannot fill a missing legacy tier',async()=>{
 const {store,file,call}=setup();complete(store,file);
 const main=store.catalogItems[0];delete main.expressPricing;main.basePriceMinor=700;
 store.catalogOptionGroups.push({id:'main_colour',catalogItemId:main.id,name:'Colour',kind:'spec',required:true});
 store.catalogOptions.push({id:'main_full',optionGroupId:'main_colour',label:'Colour',priceModifierMinor:0,active:true});
 const privateItem={...main,id:'private_bw',reviewStatus:'pending',basePriceMinor:100};store.catalogItems.push(privateItem);
 store.catalogOptionGroups.push({id:'private_colour',catalogItemId:privateItem.id,name:'Colour',kind:'spec',required:true});
 store.catalogOptions.push({id:'private_bw_option',optionGroupId:'private_colour',label:'B&W',priceModifierMinor:0,active:true});
 await assert.rejects(call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',files:[input]}),e=>e.code==='express_listing_unavailable');
});

test('legacy tier fallback cannot borrow a different paper stock',async()=>{
 const {store,file,call}=setup();complete(store,file);
 const main=store.catalogItems[0];delete main.expressPricing;main.basePriceMinor=700;
 store.catalogOptionGroups.push({id:'main_colour',catalogItemId:main.id,name:'Colour',kind:'spec',required:true},{id:'main_stock',catalogItemId:main.id,name:'Paper stock',kind:'spec',required:true});
 store.catalogOptions.push({id:'main_full',optionGroupId:'main_colour',label:'Colour',priceModifierMinor:0,active:true},{id:'main_bond',optionGroupId:'main_stock',label:'80gsm bond',priceModifierMinor:0,active:true});
 const sibling={...main,id:'other_stock',basePriceMinor:100};store.catalogItems.push(sibling);
 store.catalogOptionGroups.push({id:'other_colour',catalogItemId:sibling.id,name:'Colour',kind:'spec',required:true},{id:'other_stock_group',catalogItemId:sibling.id,name:'Paper stock',kind:'spec',required:true});
 store.catalogOptions.push({id:'other_bw',optionGroupId:'other_colour',label:'B&W',priceModifierMinor:0,active:true},{id:'other_bond',optionGroupId:'other_stock_group',label:'60gsm bond',priceModifierMinor:0,active:true});
 await assert.rejects(call('POST','/express/drafts',{supplierId:'shop_a',location,fulfillmentMode:'pickup',files:[input]}),e=>e.code==='express_listing_unavailable');
});

test('exhausted immutable variants expose the same explicit fallback in preview and draft',async()=>{
 const {file,call}=setup();file.colourAnalyses=Array.from({length:32},(_,i)=>({key:`old_${i}`,status:'failed',request:{}}));
 const result=await call('POST','/express/preview',{files:[input]});
 assert.equal(result.body.files[0].fallback.reason,'colour_analysis_limit');assert.equal(file.colourAnalyses.length,32);
});

test('invalid colour-page input is refused before queuing or falling back',async()=>{
 const {file,call}=setup();
 for(const change of [{colourPages:'bad'},{colourPages:'4'},{pageRange:'1',colourPages:'2'}])await assert.rejects(call('POST','/express/preview',{files:[{...input,...change}]}));
 assert.equal(file.colourAnalyses?.length||0,0);
});

test('preview rejects malformed file entries with the API validation error',async()=>{
 const {call}=setup();for(const file of [null,[], 'file'])await assert.rejects(call('POST','/express/preview',{files:[file]}),e=>e.status===400&&e.code==='invalid_request');
});
