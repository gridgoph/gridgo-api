import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { measurePrintedColour } from './colour-pricing.js';

export const COLOUR_MAX_SOURCE = 64*1024*1024;
export const COLOUR_MAX_PAGES = 200;
const MAX_OUTPUT = 6*1024*1024;
const failure = code => Object.assign(new Error(code),{code,status:422});
function run(command,args,directory,{capture=false,timeout=25000}={}) {
  return new Promise((resolve,reject) => {
    const child = spawn('prlimit',['--as=1073741824','--cpu=20',`--fsize=${MAX_OUTPUT}`,'--nofile=128','--',command,...args],{
      cwd:directory,detached:true,stdio:['ignore',capture?'pipe':'ignore','ignore'],
      env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:directory,TMPDIR:directory,LANG:'C.UTF-8',MAGICK_CONFIGURE_PATH:directory},
    });
    let output = '', timedOut = false;
    const kill = () => { try {process.kill(-child.pid,'SIGKILL');} catch {} };
    child.stdout?.on('data',chunk => {output += chunk.toString(); if (output.length > 256000) kill();});
    const timer = setTimeout(() => {timedOut = true; kill();},timeout);
    child.once('error',() => {clearTimeout(timer);reject(failure('colour_renderer_unavailable'));});
    child.once('close',code => {clearTimeout(timer); if (timedOut || code !== 0) reject(failure(timedOut?'colour_render_timeout':'colour_render_failed')); else resolve(output);});
  });
}
export function readPpm(bytes) {
  let at = 0;
  function token() {
    while (at < bytes.length) {
      if (bytes[at] === 35) {while (at < bytes.length && bytes[at] !== 10) at++;}
      else if ([9,10,13,32].includes(bytes[at])) at++;
      else break;
    }
    const start = at;
    while (at < bytes.length && ![9,10,13,32].includes(bytes[at])) at++;
    return bytes.toString('ascii',start,at);
  }
  if (token() !== 'P6') throw failure('colour_raster_invalid');
  const width = Number(token()), height = Number(token()), max = Number(token());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1200 || height > 1200 || max !== 255) throw failure('colour_raster_invalid');
  if (bytes[at] === 13 && bytes[at+1] === 10) at += 2; else at++;
  const pixels = bytes.subarray(at);
  if (pixels.length !== width*height*3) throw failure('colour_raster_invalid');
  return {width,height,pixels};
}
export async function renderColourAnalysis(source,file,request) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'gridgo-colour-'));
  const started = Date.now();
  try {
    if (!(await fs.stat(source)).size || (await fs.stat(source)).size > COLOUR_MAX_SOURCE) throw failure('colour_source_too_large');
    await fs.writeFile(path.join(directory,'policy.xml'), '<policymap><policy domain="delegate" rights="none" pattern="*"/><policy domain="path" rights="none" pattern="@*"/><policy domain="coder" rights="none" pattern="*"/><policy domain="coder" rights="read" pattern="{PNG,JPEG,WEBP}"/><policy domain="coder" rights="write" pattern="PPM"/></policymap>', {mode:0o600});
    const input = path.join(directory,'source');
    await fs.copyFile(source,input);
    const pdf = file.detectedContentType === 'application/pdf';
    let pageCount = 1, info = '';
    if (pdf) {
      const summary = await run('pdfinfo',[input],directory,{capture:true});
      pageCount = Number(/^Pages:\s+(\d+)/m.exec(summary)?.[1]);
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > COLOUR_MAX_PAGES) throw failure('colour_page_limit');
      if (/^Encrypted:\s+yes/m.test(summary)) throw failure('colour_protected_document');
      info = await run('pdfinfo',['-f','1','-l',String(pageCount),'-box',input],directory,{capture:true});
    }
    const pages = [];
    for (let page=1;page<=pageCount;page++) {
      if (Date.now()-started > 90000) throw failure('colour_render_timeout');
      const output = path.join(directory,'page.ppm');
      let widthMilli, heightMilli;
      if (pdf) {
        // pdfinfo's CropBox values describe the same page pdftoppm -cropbox
        // renders, including mixed-size PDFs and a non-zero box origin.
        const box = new RegExp(`^Page\\s+${page}\\s+CropBox:\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)`,'m').exec(info);
        if (!box) throw failure('colour_page_size_unknown');
        widthMilli = Math.round((Number(box[3])-Number(box[1]))*25400/72);
        heightMilli = Math.round((Number(box[4])-Number(box[2]))*25400/72);
        const rotation = Number(new RegExp(`^Page\\s+${page}\\s+rot:\\s+(-?\\d+)`,'m').exec(info)?.[1] || 0);
        if (Math.abs(rotation)%180 === 90) [widthMilli,heightMilli] = [heightMilli,widthMilli];
        if (!(widthMilli > 0 && heightMilli > 0)) throw failure('colour_page_size_unknown');
        await run('pdftoppm',['-f',String(page),'-l',String(page),'-singlefile','-cropbox','-scale-to','1200',input,path.join(directory,'page')],directory);
      } else {
        const coder = {'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'}[file.detectedContentType];
        if (!coder) throw failure('colour_file_unsupported');
        await run('convert',['-limit','memory','64MiB','-limit','map','64MiB','-limit','disk','0','-limit','thread','1',`${coder}:${input}[0]`,'-auto-orient','-background','white','-alpha','remove','-alpha','off','-resize','1200x1200>','-depth','8',`ppm:${output}`],directory);
        widthMilli = file.detected?.widthMilli; heightMilli = file.detected?.heightMilli;
      }
      const stat = await fs.stat(output);
      if (stat.size > MAX_OUTPUT) throw failure('colour_raster_invalid');
      const raster = readPpm(await fs.readFile(output));
      // EXIF auto-orientation may exchange image axes.
      if (!pdf && widthMilli && heightMilli && (raster.width > raster.height) !== (widthMilli > heightMilli)) [widthMilli,heightMilli] = [heightMilli,widthMilli];
      pages.push({page, widthMilli:widthMilli || null,heightMilli:heightMilli || null,
        ...measurePrintedColour({...raster,widthMilli,heightMilli},request.paper,request.layout,request.thresholds)});
      await fs.unlink(output);
    }
    return pages;
  } finally {await fs.rm(directory,{recursive:true,force:true});}
}
