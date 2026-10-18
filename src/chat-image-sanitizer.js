import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CLIENT_SHOP_CHAT_MAX_BYTES } from './chat-attachment-policy.js';

const CHAT_ATTACHMENT_MAX_BYTES = CLIENT_SHOP_CHAT_MAX_BYTES;
const failure = code => Object.assign(new Error(code), { code, status: 422 });

// Use the same bounded ImageMagick/prlimit toolchain as colour-renderer.
// Decode a fixed allowlisted coder, take one frame, orient, then write only
// pixels. The original file is never uploaded to MinIO.
async function render(directory, input, output, coder) {
  await fs.writeFile(path.join(directory, 'policy.xml'), '<policymap><policy domain="delegate" rights="none" pattern="*"/><policy domain="path" rights="none" pattern="@*"/><policy domain="coder" rights="none" pattern="*"/><policy domain="coder" rights="read" pattern="{JPEG,WEBP}"/><policy domain="coder" rights="read|write" pattern="PNG"/></policymap>');
  return new Promise((resolve, reject) => {
    const child = spawn('prlimit', ['--as=1073741824', '--cpu=20', `--fsize=${CHAT_ATTACHMENT_MAX_BYTES}`, '--nofile=128', '--',
      'convert', '-limit', 'memory', '64MiB', '-limit', 'map', '64MiB', '-limit', 'disk', '0', '-limit', 'thread', '1',
      `${coder}:${input}[0]`, '-auto-orient', '-resize', '4096x4096>', '-strip', '-define', 'png:exclude-chunks=all', `png:${output}`], {
      cwd: directory, detached: true, stdio: 'ignore',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8', MAGICK_CONFIGURE_PATH: directory },
    });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, 25000);
    child.once('error', () => { clearTimeout(timer); reject(failure('chat_image_sanitization_failed')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(failure('chat_image_sanitization_failed')); });
  });
}

export async function sanitizeChatUpload(file, contentType) {
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) throw Object.assign(failure('file_too_large'), { status: 413 });
  if (contentType === 'application/pdf') {
    file.originalFilename = 'document.pdf';
    return contentType;
  }
  const coder = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[contentType];
  if (!coder) throw failure('chat_image_unsupported');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gridgo-chat-image-'));
  try {
    const input = path.join(directory, 'source');
    const output = path.join(directory, 'sanitized.png');
    await fs.copyFile(file.tempPath, input);
    await render(directory, input, output, coder);
    const bytes = await fs.readFile(output);
    if (!bytes.length || bytes.length > CHAT_ATTACHMENT_MAX_BYTES) throw failure('chat_image_sanitization_failed');
    await fs.writeFile(file.tempPath, bytes);
    file.size = bytes.length;
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    file.sniffBytes = bytes.subarray(0, 8192);
    file.originalFilename = 'image.png';
    file.declaredContentType = 'image/png';
    return 'image/png';
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
