import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createColourWorker} from '../src/colour-worker.js';
import {ensureExpressPreview} from '../src/express-print.js';

test('async Express analysis persists a private production artwork and immutable rendering identity',async()=>{
 const file={fileId:'original',ownerId:'client',purpose:'artwork',objectKey:'private/original',state:'ready',detectedContentType:'application/pdf',size:3};
 const store={settings:{},files:[file],carts:[],cartLines:[]};
 const job=ensureExpressPreview(store,file,{paper:'a4',colourMode:'all_bw',orientation:'landscape',sides:'one',layout:'fit_to_paper'},'documents','2026-11-27T00:00:00Z');
 const objects=new Map();let count=0;
 const worker=createColourWorker({database:{transaction:async f=>f(),query:async sql=>sql.includes('try_advisory')?{rows:[{locked:true}]}:{rowCount:1,rows:[{file_id:'original'}]}},load:async()=>store,save:async()=>{},
  storage:{statObject:async()=>({size:3}),getObject:async()=>Readable.from(Buffer.from('pdf')),putObject:async value=>objects.set(value.key,value.body)},
  renderExpress:async()=>({pages:[{page:1,strongColourBps:5000,printColour:'bw',outputPage:1}],bytes:Buffer.from('%PDF-print-ready')}),id:prefix=>`${prefix}_${++count}`});
 await worker();
 assert.equal(job.analysis.status,'ready');assert.ok(job.analysis.outputFileId);
 const output=store.files.find(f=>f.fileId===job.analysis.outputFileId);
 assert.equal(output.purpose,'artwork');assert.equal(output.ownerId,'client');assert.equal(output.expressRendering.key,job.key);
 assert.equal(output.detected.pageCount,1);assert.equal(output.artworkCheck.status,'passed');assert.equal(objects.size,1);assert.notEqual(output.objectKey,file.objectKey);
 assert.equal(file.objectKey,'private/original');
});

test('render failure records an explicit fallback reason without creating a derivative',async()=>{
 const file={fileId:'source',ownerId:'client',purpose:'artwork',objectKey:'private/source',state:'ready',detectedContentType:'application/pdf',size:3};
 const store={settings:{},files:[file],carts:[],cartLines:[]};
 const job=ensureExpressPreview(store,file,{paper:'a4',colourMode:'auto',sides:'one',layout:'fit_to_paper'},'documents','2026-11-27T00:00:00Z');
 const worker=createColourWorker({database:{transaction:async f=>f(),query:async sql=>sql.includes('try_advisory')?{rows:[{locked:true}]}:{rowCount:1,rows:[{file_id:'source'}]}},load:async()=>store,save:async()=>{},
  storage:{statObject:async()=>({size:3}),getObject:async()=>Readable.from(Buffer.from('pdf'))},renderExpress:async()=>{throw Object.assign(new Error('private document text must not be saved'),{code:'colour_print_resolution_limit'});}});
 await worker();assert.equal(job.analysis.status,'failed');assert.equal(job.analysis.error,'colour_print_resolution_limit');assert.equal(store.files.length,1);
 assert.doesNotMatch(JSON.stringify(job.analysis),/private document text/);
});
