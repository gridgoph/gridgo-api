import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DOCX_CONTENT_TYPE, inspectDocx } from './docx.js';

export const PREVIEW_MAX_SOURCE = 64 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
export function previewError(code, status = 503) {
  return Object.assign(new Error('The artwork preview could not be loaded. Retry or open the original file.'), { code, status });
}

// No shell or user-selected executable/arguments. Kill only our own process
// group, including Writer's child, on timeout. Never inherit service secrets.
function run(command, args, directory, stage) {
  return new Promise((resolve, reject) => {
    const child = spawn('prlimit', ['--as=1073741824', '--cpu=20', `--fsize=${MAX_OUTPUT}`, '--nofile=128', '--', command, ...args], {
      cwd: directory, detached: true, stdio: 'ignore',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Child already exited. */ }
    }, 25_000);
    child.once('error', error => { clearTimeout(timer); reject(previewError(error.code === 'ENOENT' ? 'preview_renderer_unavailable' : `preview_${stage}_failed`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(previewError('preview_render_timeout'));
      else if (code !== 0) reject(previewError(`preview_${stage}_failed`));
      else resolve();
    });
  });
}

export async function renderArtworkPreview(source, type) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gridgo-preview-'));
  try {
    const size = (await fs.stat(source)).size;
    if (!size || size > PREVIEW_MAX_SOURCE) throw previewError('preview_source_too_large', 422);
    let pdf = path.join(directory, 'source.pdf');
    if (type === DOCX_CONTENT_TYPE) {
      const bytes = await fs.readFile(source);
      // The upload sniff remains unchanged; this stricter rendering check
      // refuses active/external content before invoking a document interpreter.
      if (!inspectDocx(bytes, { forPreview: true })) throw previewError('preview_document_unsafe', 422);
      const input = path.join(directory, 'source.docx');
      await fs.writeFile(input, bytes, { mode: 0o600 });
      const profile = path.join(directory, 'profile');
      await fs.mkdir(path.join(profile, 'user'), { recursive: true });
      await fs.writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), `<?xml version="1.0"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>`);
      await run('libreoffice', ['--headless', '--nologo', '--nodefault', '--norestore', '--nofirststartwizard',
        `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to',
        'pdf:writer_pdf_Export:{"PageRange":{"type":"string","value":"1"}}', '--outdir', directory, input], directory, 'conversion');
    } else if (type === 'application/pdf') {
      await fs.copyFile(source, pdf);
    } else throw previewError('preview_not_supported', 422);
    if (!(await fs.stat(pdf).catch(() => null))?.size) throw previewError('preview_conversion_failed');
    await run('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '1600', '-png', pdf, path.join(directory, 'page')], directory, 'rasterization');
    const output = path.join(directory, 'page.png');
    const result = await fs.stat(output).catch(() => null);
    if (!result?.size || result.size > MAX_OUTPUT) throw previewError('preview_output_invalid');
    const bytes = await fs.readFile(output);
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw previewError('preview_output_invalid');
    return bytes;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
