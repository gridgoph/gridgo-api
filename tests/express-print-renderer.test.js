import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as renderer from '../src/express-print-renderer.js';
import {expressPrintRequest} from '../src/express-print.js';
import {previewPdf} from './helpers/preview-fixtures.mjs';
import {renderArtworkPreview} from '../src/artwork-preview-renderer.js';
import {renderColourAnalysis,readPpm} from '../src/colour-renderer.js';
import {colourSettings} from '../src/colour-pricing.js';

test('private production PDF applies page choices, paper, orientation and colour exactly once',async t=>{
 assert.equal(typeof renderer.renderExpressPrint,'function');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'express-print-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.pdf');await fs.writeFile(source,previewPdf());
 const request=expressPrintRequest({}, {paper:'a4',orientation:'portrait',layout:'fit_to_paper',sides:'one',colourMode:'choose',colourPages:'2'},'documents');
 const result=await renderer.renderExpressPrint(source,{detectedContentType:'application/pdf'},request);
 assert.equal(result.pages.length,2);assert.equal(result.pages[0].printColour,'bw');assert.equal(result.pages[1].printColour,'colour');
 const printed=path.join(dir,'printed.pdf');await fs.writeFile(printed,result.bytes);
 const info=execFileSync('pdfinfo',[printed],{encoding:'utf8'});assert.match(info,/Pages:\s+2/);assert.match(info,/Page size:\s+595.2\d* x 841.8\d*/);
 assert.ok([...result.bytes.toString('latin1').matchAll(/\/Width (\d+)/g)].every(match=>Number(match[1])>=2300),'fit-to-page PDF pixels preserve 300 dpi at the final placement');
 const measured=await renderColourAnalysis(printed,{detectedContentType:'application/pdf'},{paper:null,layout:'source',thresholds:colourSettings()});
 assert.equal(measured[0].strongColourBps,0);assert.ok(measured[1].strongColourBps>0);
 assert.ok(Math.abs(measured[1].strongColourBps-result.pages[1].strongColourBps)<50);
});
test('a page range becomes the exact production PDF and blue paper is single-ink',async t=>{
 assert.equal(typeof renderer.renderExpressPrint,'function');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'express-plan-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,'input.pdf');await fs.writeFile(input,previewPdf());
 const request=expressPrintRequest({}, {paper:'a2',planType:'blue_paper',colour:'blue',orientation:'auto',sides:'one',layout:'fit_to_paper',pageRange:'2'},'plans');
 const result=await renderer.renderExpressPrint(input,{detectedContentType:'application/pdf'},request);
 assert.equal(result.pages.length,1);assert.equal(result.pages[0].page,2);assert.equal(result.pages[0].printColour,'blue');
 assert.ok(result.bytes.length<64*1024*1024);assert.ok(result.bytes.includes(Buffer.from('/SMask')),'blue ink uses a transparent mask, never an inked paper background');
 const printed=path.join(dir,'printed.pdf');await fs.writeFile(printed,result.bytes);
 execFileSync('pdftoppm',['-singlefile','-scale-to','100',printed,path.join(dir,'printed')]);
 const raster=readPpm(await fs.readFile(path.join(dir,'printed.ppm')));assert.deepEqual([...raster.pixels.subarray(0,3)],[255,255,255],'unmarked paper must receive no background ink');
 const preview=await renderArtworkPreview(printed,'application/pdf',{paperColour:'blue'});
 const previewPath=path.join(dir,'preview.png');await fs.writeFile(previewPath,preview);
 const previewRaster=readPpm(execFileSync('convert',[previewPath,'-depth','8','ppm:-'],{maxBuffer:8*1024*1024}),2000);
 assert.deepEqual([...previewRaster.pixels.subarray(0,3)],[130,181,230],'the viewer simulates the physical blue paper');
});

test('production preparation runs in a bounded worker with the same rendering result',async t=>{
 const {renderExpressPrintInWorker}=await import('../src/express-print-worker.js');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'express-thread-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,'input.pdf');await fs.writeFile(input,previewPdf());
 const request=expressPrintRequest({}, {paper:'a4',colourMode:'all_bw',sides:'one',layout:'fit_to_paper'},'documents');
 const direct=await renderer.renderExpressPrint(input,{detectedContentType:'application/pdf'},request);
 const threaded=await renderExpressPrintInWorker(input,{detectedContentType:'application/pdf'},request);
 assert.deepEqual(threaded.pages,direct.pages);assert.ok(Buffer.isBuffer(threaded.bytes));assert.ok(threaded.bytes.equals(direct.bytes));
});

test('a print exceeding the final-resolution bounds fails explicitly instead of stretching pixels',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'express-resolution-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,'input.pdf');await fs.writeFile(input,previewPdf());
 const request=expressPrintRequest({}, {paper:'a0',planType:'whiteprint',colour:'bw',sides:'one',layout:'fit_to_paper'},'plans');
 await assert.rejects(renderer.renderExpressPrint(input,{detectedContentType:'application/pdf'},request),{code:'colour_print_resolution_limit'});
});
