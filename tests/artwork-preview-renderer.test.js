import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderArtworkPreview } from '../src/artwork-preview-renderer.js';
import { DOCX_CONTENT_TYPE } from '../src/docx.js';
import { docx, zip, docxEntries } from './helpers/docx.mjs';
import { previewPdf } from './helpers/preview-fixtures.mjs';

async function render(t, bytes, type) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'input'); await fs.writeFile(source, bytes);
  return renderArtworkPreview(source, type);
}

test('real PDF renderer returns only the landscape first page as a bounded PNG', async t => {
  const png = await render(t, previewPdf(), 'application/pdf');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1600);
  assert.ok(png.readUInt32BE(20) < 1600);
});
test('Word previews are unavailable even for valid DOCX and before source access', async t => {
  const expected = { code: 'preview_word_not_available', status: 422, message: 'Preview not available for Word files yet - open the original' };
  await assert.rejects(render(t, docx(null), DOCX_CONTENT_TYPE), expected);
  await assert.rejects(renderArtworkPreview('/nonexistent/word-source', DOCX_CONTENT_TYPE), expected);
});
test('malformed PDF produces a coded error, not a blank success', async t => {
  await assert.rejects(render(t, Buffer.from('%PDF-1.4 garbage'), 'application/pdf'), { code: 'preview_rasterization_failed' });
});
test('Word external resources and active fields remain unrendered', async t => {
  for (const entries of [
    [...docxEntries(), ['word/_rels/document.xml.rels', '<Relationships><Relationship TargetMode="External" Target="http://127.0.0.1/secret"/></Relationships>']],
    docxEntries().map(([name, value]) => [name, name === 'word/document.xml' ? value.replace('<w:t>', '<w:instrText>INCLUDEPICTURE ').replace('</w:t>', '</w:instrText>') : value]),
  ]) await assert.rejects(render(t, zip(entries), DOCX_CONTENT_TYPE), { code: 'preview_word_not_available', status: 422 });
});

test('blue paper is a preview backdrop, including in the production image toolchain',async t=>{
 const {execFileSync}=await import('node:child_process');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paper-preview-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const source=path.join(directory,'input.pdf'),output=path.join(directory,'preview.png');await fs.writeFile(source,previewPdf());
 const png=await renderArtworkPreview(source,'application/pdf',{paperColour:'blue'});await fs.writeFile(output,png);
 const pixel=execFileSync('convert',[output,'-crop','1x1+0+0','-depth','8','rgb:-']);
 assert.deepEqual([...pixel],[130,181,230]);assert.ok(png.length<=8*1024*1024);
});
