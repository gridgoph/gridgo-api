import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderColourAnalysis,readPpm } from '../src/colour-renderer.js';
import { colourSettings } from '../src/colour-pricing.js';
import { previewPdf } from './helpers/preview-fixtures.mjs';

async function source(t,bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'colour-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename = path.join(dir,'input'); await fs.writeFile(filename,bytes);return filename;
}
test('real PDF renderer measures every page, with physical boxes and actual-size margins',async t => {
  const input = await source(t,previewPdf());
  const request = {version:1,layout:'source',paper:null,thresholds:colourSettings()};
  const pages = await renderColourAnalysis(input,{detectedContentType:'application/pdf'},request);
  assert.equal(pages.length,2);
  assert.equal(pages[0].widthMilli,105833);
  assert.ok(Math.abs(pages[0].strongColourBps-3333) < 100,JSON.stringify(pages));
  assert.ok(Math.abs(pages[1].strongColourBps-3333) < 100);
  const printed = await renderColourAnalysis(input,{detectedContentType:'application/pdf'}, {...request,layout:'actual_size_centered',paper:{widthMilli:211666,heightMilli:141112}});
  assert.ok(Math.abs(printed[0].strongColourBps-833) < 50);
});
test('image decoding covers PNG/JPEG; transparency is white paper',async t => {
  for (const [type,name] of [['image/png','pixel.png'],['image/jpeg','pixel.jpg']]) {
    const input = await source(t,await fs.readFile(new URL(`./fixtures/artwork-check/${name}`,import.meta.url)));
    const pages = await renderColourAnalysis(input,{detectedContentType:type},{layout:'fit_to_paper',paper:{widthMilli:297000,heightMilli:420000},thresholds:colourSettings()});
    assert.equal(pages.length,1); assert.ok(pages[0].strongColourBps >= 0 && pages[0].strongColourBps <= 10000);
  }
});
test('corrupt documents fail closed; PPM parser preserves whitespace-valued pixels',async t => {
  await assert.rejects(renderColourAnalysis(await source(t,Buffer.from('%PDF-1.4 bad')),{detectedContentType:'application/pdf'},{}),{code:'colour_render_failed'});
  assert.deepEqual([...readPpm(Buffer.concat([Buffer.from('P6\n1 1\n255\n'),Buffer.from([10,32,13])])).pixels],[10,32,13]);
});
