import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {runColourCommand as run,readPpm,COLOUR_MAX_SOURCE,COLOUR_MAX_PAGES} from './colour-renderer.js';
import {measurePrintedColour,printedPlacement} from './colour-pricing.js';
import {selectedPageNumbers,expressDocumentTier} from './express-print.js';

const MAX_RASTER=100*1024*1024,MAX_PDF=64*1024*1024;
const fail=code=>{throw Object.assign(new Error(code),{code,status:422});};
const pt=milli=>Number((milli*72/25400).toFixed(5));

/** Fixed PDF objects only: uploaded bytes are decoded to RGB, never copied as PDF code.
 * PDF rasterization preserves at least 300 dpi at final placement (10k cap); placement uses the
 * same physical geometry as measurement. No interpolated thumbnail is printed. */
export async function renderExpressPrint(source,file,request) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gridgo-express-print-')),started=Date.now();
 try {
  const stat=await fs.stat(source);if(!stat.size||stat.size>COLOUR_MAX_SOURCE)fail('colour_source_too_large');
  const input=path.join(directory,'input');await fs.copyFile(source,input);
  await fs.writeFile(path.join(directory,'policy.xml'),'<policymap><policy domain="delegate" rights="none" pattern="*"/><policy domain="path" rights="none" pattern="@*"/><policy domain="coder" rights="none" pattern="*"/><policy domain="coder" rights="read" pattern="{PNG,JPEG,WEBP}"/><policy domain="coder" rights="write" pattern="PPM"/></policymap>',{mode:0o600});
  const pdf=file.detectedContentType==='application/pdf';let total=1,info='';
  if(pdf){const summary=await run('pdfinfo',[input],directory,{capture:true});total=Number(/^Pages:\s+(\d+)/m.exec(summary)?.[1]);
   if(!Number.isSafeInteger(total)||total<1||total>COLOUR_MAX_PAGES)fail('colour_page_limit');
   if(/^Encrypted:\s+yes/m.test(summary))fail('colour_protected_document');
   info=await run('pdfinfo',['-f','1','-l',String(total),'-box',input],directory,{capture:true});}
  const numbers=selectedPageNumbers(total,request.express.pageRange),colourPages=new Set(request.express.colourMode==='choose'&&request.express.colourPages?selectedPageNumbers(total,request.express.colourPages):[]);
  if([...colourPages].some(page=>!numbers.includes(page)))fail('colour_page_selection_invalid');
  const objects=[null,null],pageIds=[],pages=[];let outputBytes=0;
  const add=value=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);outputBytes+=bytes.length;if(outputBytes>MAX_PDF)fail('colour_output_too_large');objects.push(bytes);return objects.length;};
  for(const page of numbers) {
   if(Date.now()-started>90000)fail('colour_render_timeout');
   let widthMilli,heightMilli;const output=path.join(directory,'page.ppm');
   if(pdf){const box=new RegExp(`^Page\\s+${page}\\s+CropBox:\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)`,'m').exec(info);if(!box)fail('colour_page_size_unknown');
    widthMilli=Math.round((Number(box[3])-Number(box[1]))*25400/72);heightMilli=Math.round((Number(box[4])-Number(box[2]))*25400/72);
    if(Math.abs(Number(new RegExp(`^Page\\s+${page}\\s+rot:\\s+(-?\\d+)`,'m').exec(info)?.[1]||0))%180===90)[widthMilli,heightMilli]=[heightMilli,widthMilli];
    if(!(widthMilli>0&&heightMilli>0))fail('colour_page_size_unknown');
    const placement=printedPlacement({widthMilli,heightMilli},request.paper,request.layout,request.orientation);
    const dpi=300*Math.max(1,placement.scale);
    // Refuse rather than silently lower final print resolution at the size cap.
    if(Math.max(widthMilli,heightMilli)*dpi/25400>10000||widthMilli*heightMilli*(dpi/25400)**2*3>MAX_RASTER)fail('colour_print_resolution_limit');
    await run('pdftoppm',['-f',String(page),'-l',String(page),'-singlefile','-cropbox','-r',String(dpi),input,path.join(directory,'page')],directory,{maxOutput:MAX_RASTER});
   }else{const coder={'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'}[file.detectedContentType];if(!coder)fail('colour_file_unsupported');
    await run('convert',['-limit','memory','128MiB','-limit','map','128MiB','-limit','disk','0','-limit','thread','1',`${coder}:${input}[0]`,'-auto-orient','-background','white','-alpha','remove','-alpha','off','-depth','8',`ppm:${output}`],directory,{maxOutput:MAX_RASTER});
    widthMilli=file.detected?.widthMilli;heightMilli=file.detected?.heightMilli;}
   if((await fs.stat(output)).size>MAX_RASTER)fail('colour_raster_invalid');
   const raster=readPpm(await fs.readFile(output),10000);await fs.unlink(output);
   if(!pdf&&widthMilli&&heightMilli&&(raster.width>raster.height)!==(widthMilli>heightMilli))[widthMilli,heightMilli]=[heightMilli,widthMilli];
   const sourcePage={...raster,widthMilli,heightMilli},geometry=printedPlacement(sourcePage,request.paper,request.layout,request.orientation);
   const measured=measurePrintedColour(sourcePage,request.paper,request.layout,request.thresholds,request.orientation);
   const tier=expressDocumentTier(measured.strongColourBps,request.express.lightMaxBps);
   const printColour=request.express.productType==='plans'?request.express.ink:
    request.express.colourMode==='all_bw'||request.express.colourMode==='choose'&&!colourPages.has(page)||tier==='bw'?'bw':'colour';
   const blue=printColour==='blue',gray=printColour==='bw',count=raster.width*raster.height;
   const pixels=gray||blue?Buffer.alloc(count):Buffer.from(raster.pixels),alpha=blue?Buffer.alloc(count):null;
   if(gray||blue)for(let i=0;i<count;i++){
    const value=Math.round((299*raster.pixels[i*3]+587*raster.pixels[i*3+1]+114*raster.pixels[i*3+2])/1000);
    if(gray)pixels[i]=value;else alpha[i]=255-value;
   }
   let maskId=null;
   if(blue){const mask=deflateSync(alpha);maskId=add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${mask.length} >>\nstream\n`),mask,Buffer.from('\nendstream')]));}
   const compressed=deflateSync(pixels),space=blue?'[/Indexed /DeviceRGB 0 <144187>]':`/${gray?'DeviceGray':'DeviceRGB'}`;
   const imageId=add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace ${space} /BitsPerComponent 8 ${maskId?`/SMask ${maskId} 0 R `:''}/Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),compressed,Buffer.from('\nendstream')]));
   const {sourceW,sourceH,targetW,targetH,scale,offsetX,offsetY}=geometry;
   // Physical blue paper is simulated by the viewer, never painted as background ink.
   const background=request.express.paperColour==='blue'?'':`1 1 1 rg 0 0 ${pt(targetW)} ${pt(targetH)} re f\n`;
   const commands=`q\n${background}0 0 ${pt(targetW)} ${pt(targetH)} re W n\n${pt(sourceW*scale)} 0 0 ${pt(sourceH*scale)} ${pt(offsetX)} ${pt(targetH-offsetY-sourceH*scale)} cm\n/Im Do\nQ\n`;
   const contentId=add(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}endstream`);
   pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(targetW)} ${pt(targetH)}] /Resources << /XObject << /Im ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
   pages.push({page,widthMilli:widthMilli||null,heightMilli:heightMilli||null,...measured,printColour,outputPage:pages.length+1});
  }
  objects[0]=Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');objects[1]=Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const chunks=[Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n','latin1')],offsets=[0];let length=chunks[0].length;
  for(let i=0;i<objects.length;i++){offsets.push(length);const bytes=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),objects[i],Buffer.from('\nendobj\n')]);chunks.push(bytes);length+=bytes.length;}
  const xref=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  const bytes=Buffer.concat([...chunks,Buffer.from(xref)]);if(bytes.length>MAX_PDF)fail('colour_output_too_large');
  return {pages,bytes};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
