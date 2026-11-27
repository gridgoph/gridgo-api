import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as renderer from '../src/express-print-renderer.js';
import {expressPrintRequest} from '../src/express-print.js';
import {previewPdf} from './helpers/preview-fixtures.mjs';
import {renderColourAnalysis} from '../src/colour-renderer.js';
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
 const measured=await renderColourAnalysis(printed,{detectedContentType:'application/pdf'},{paper:null,layout:'source',thresholds:colourSettings()});
 assert.equal(measured[0].strongColourBps,0);assert.ok(measured[1].strongColourBps>0);
 assert.ok(Math.abs(measured[1].strongColourBps-result.pages[1].strongColourBps)<50);
});
test('a page range becomes the exact production PDF and blue paper is single-ink',async t=>{
 assert.equal(typeof renderer.renderExpressPrint,'function');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'express-plan-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,'input.pdf');await fs.writeFile(input,previewPdf());
 const request=expressPrintRequest({}, {paper:'20x30',planType:'blue_paper',colour:'blue',orientation:'auto',sides:'one',layout:'fit_to_paper',pageRange:'2'},'plans');
 const result=await renderer.renderExpressPrint(input,{detectedContentType:'application/pdf'},request);
 assert.equal(result.pages.length,1);assert.equal(result.pages[0].page,2);assert.equal(result.pages[0].printColour,'blue');
 assert.ok(result.bytes.length<64*1024*1024);assert.match(result.bytes.toString('latin1'),/0.51 0.71 0.90 rg/);
});
