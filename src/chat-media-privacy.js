import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { maskOrderChat } from './chat-contact-masking.js';

/** Local bounded OCR/QR checks; no private text is sent to an external service or retained. */
function run(command, args, directory, accepted = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn('prlimit', ['--as=1073741824', '--cpu=8', '--fsize=16777216', '--nofile=128', '--', command, ...args], {
      cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: directory, TMPDIR: directory, OMP_THREAD_LIMIT: '1',
        ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
        ...(process.env.TESSDATA_PREFIX ? { TESSDATA_PREFIX: process.env.TESSDATA_PREFIX } : {}) },
    });
    let output = '', overflow = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, 12000);
    child.stdout.on('data', chunk => { if (output.length + chunk.length > 65536) { overflow = true; kill(); } else output += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); accepted.includes(code) && !overflow ? resolve(output) : reject(new Error('chat_media_scan_failed')); });
  });
}

export async function scanChatMedia(source, contentType) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gridgo-chat-scan-'));
  try {
    const input = path.join(directory, contentType === 'application/pdf' ? 'input.pdf' : 'input.png');
    await fs.copyFile(source, input);
    let images = [input];
    if (contentType === 'application/pdf') {
      const info = await run('pdfinfo', [input], directory);
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > 4) throw new Error('chat_media_scan_limit');
      await run('pdftoppm', ['-png', '-scale-to', '2000', input, path.join(directory, 'page')], directory);
      images = (await fs.readdir(directory)).filter(name => /^page-\d+\.png$/.test(name)).map(name => path.join(directory, name));
      if (images.length !== pages) throw new Error('chat_media_scan_incomplete');
    }
    let hasQr = false, hasContacts = false, hasAddress = false;
    for (const file of images) {
      const codes = await run('zbarimg', ['--quiet', '--raw', '--set', '*.disable', '--set', 'qrcode.enable', file], directory, [0, 4]);
      // A production identifier encoded as a QR is job content. Withhold only
      // recognized payment/contact payloads; do not blanket-hide every barcode.
      hasQr ||= codes.split('\n').some(code => maskOrderChat(code, { orderType: 'express' }).contactAttempt);
      const text = await run('tesseract', [file, 'stdout', '-l', 'eng', '--psm', '11'], directory);
      const normal = { orderType: 'express' };
      hasContacts ||= maskOrderChat(text, normal).contactAttempt;
      const home = { ...normal, supplierId: 'shop', homePrinter: { supplierId: 'shop' } };
      hasAddress ||= maskOrderChat(text, home).text !== maskOrderChat(text, normal).text;
    }
    return { version: 1, status: 'checked', hasQr, hasContacts, hasAddress };
  } catch {
    return { version: 1, status: 'unavailable' };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export function hideChatMedia(file, order) {
  if (order?.orderType !== 'express') return false;
  const verdict = file?.chatSafety;
  return verdict?.version !== 1 || verdict.status !== 'checked' || verdict.hasQr || verdict.hasContacts
    || (verdict.hasAddress && order.homePrinter?.supplierId === order.supplierId && order.shopAcceptance?.status !== 'accepted');
}
