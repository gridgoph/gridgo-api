import {Readable} from 'node:stream';
import {createColourWorker} from '../src/colour-worker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../src/database.js';
import {loadStore,saveStore,loadColourSourceStore,loadColourSaveStore} from '../src/postgres-store.js';
import {resetDatabase} from './fixtures/reset-database.js';
import {fixture,actors,id,AT} from './fixtures/reschedule.js';
import {defaultTaxonomy} from '../src/taxonomy.js';
import {routeOrderMatch} from '../src/order-match-routes.js';
import {ensureExpressPreview} from '../src/express-print.js';

test('prepared Express file and mixed page prices survive round trip and cannot be rewritten', {skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase({DATABASE_URL:process.env.DATABASE_URL});t.after(()=>db.close());
 await resetDatabase(db,'TRUNCATE voucher_campaigns, users, platform_settings, taxonomy_categories, accepted_file_formats RESTART IDENTITY CASCADE');
 let store=fixture();for(const key of ['orders','orderJobs','orderLineItems','orderLineItemOptions','orderInvoices'])store[key]=[];
 store.taxonomy=defaultTaxonomy();
 for(const s of store.supplierServices)s.categoryCode='document_publication';
 for(const item of store.catalogItems)Object.assign(item,{subcategoryCode:'document_printing',express:true,pricingUnit:'per_page',printLayouts:['fit_to_paper'],expressPricing:{a4:{bw:200,light:400,full:600}}});
 const file={fileId:'original',ownerId:'client',purpose:'artwork',state:'ready',objectKey:'private/original.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',originalFilename:'report.pdf',size:3,createdAt:AT,detected:{pageCount:3},artworkCheck:{status:'passed'},references:[]};store.files.push(file,{...file,fileId:'proof',purpose:'payment_proof',objectKey:'private/proof.png'});
 const input={fileId:file.fileId,copies:2,paper:'a4',colourMode:'auto',orientation:'auto',sides:'one',layout:'fit_to_paper',acceptedWarnings:[]};
 const {analysis,key,request}=ensureExpressPreview(store,file,input,'documents',AT);
 await db.transaction(()=>saveStore(db,store));
 const worker=createColourWorker({database:db,load:()=>loadStore(db),loadSource:fileId=>loadColourSourceStore(db,fileId),loadForSave:original=>loadColourSaveStore(db,original),save:value=>saveStore(db,value),id,now:()=>AT,
  storage:{statObject:async()=>({size:3}),getObject:async()=>Readable.from(Buffer.from('pdf')),putObject:async()=>{}},
  renderExpress:async()=>({bytes:Buffer.from('%PDF-prepared'),pages:[{page:1,strongColourBps:0,printColour:'bw'},{page:2,strongColourBps:2000,printColour:'colour'},{page:3,strongColourBps:5000,printColour:'colour'}]})});
 await worker();store=await loadStore(db);
 const rendered=store.files.find(f=>f.fileId===file.fileId).colourAnalyses.find(row=>row.key===key);
 assert.equal(rendered.status,'ready');const preparedId=rendered.outputFileId;
 assert.equal(store.files.find(f=>f.fileId===preparedId).expressRendering.key,key);
 const call=(path,body)=>routeOrderMatch({req:{method:'POST'},url:new URL(`http://test${path}`),store,user:actors.client,readBody:async()=>body,id,now:()=>AT});
 const draft=await call('/express/drafts',{supplierId:'supplier',location:{lat:7.06,lng:125.6},fulfillmentMode:'pickup',files:[input]});
 await db.transaction(()=>saveStore(db,store));store=await loadStore(db);
 assert.deepEqual(store.catalogItems[0].expressPricing.a4,{bw:200,light:400,full:600});
 const placed=await call(`/me/carts/${draft.body.cartId}/checkout`,{looksRight:true,expressConfirmation:draft.body.confirmation,payment:{method:'qr_manual',reference:'COLOUR-PG',proofFileId:'proof'}});
 await db.transaction(()=>saveStore(db,store));store=await loadStore(db);
 const order=store.orders.find(o=>o.id===placed.body.order.id),line=store.orderLineItems.find(l=>l.orderId===order.id);
 assert.equal(order.supplierSubtotalMinor,2400);assert.equal(order.totalMinor,draft.body.quote.totalMinor);assert.equal(line.artworkFileId,preparedId);
 assert.equal(line.expressOriginalFileId,'original');assert.equal(line.expressPrint.pagePricing.subtotalMinor,2400);
 await assert.rejects(db.query(`UPDATE order_line_items SET express_print=jsonb_set(express_print,'{orientation}','"portrait"') WHERE id=$1`,[line.id]),/Express line print snapshot is immutable/);
 await assert.rejects(db.query(`UPDATE files SET data=jsonb_set(data,'{expressRendering,key}','"different"') WHERE file_id=$1`,[preparedId]),/Express rendering identity is immutable/);
});
