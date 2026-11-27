import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as media from '../src/chat-media-privacy.js';

test('QR and contact images are withheld; ordinary production pictures are shareable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gridgo-chat-privacy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const qr = await media.scanChatMedia('tests/fixtures/chat-payment-qr.png', 'image/png');
  assert.equal(qr.status, 'checked'); assert.equal(qr.hasQr, true);
  assert.equal((await media.scanChatMedia('tests/fixtures/chat-payment-qr.pdf', 'application/pdf')).hasQr, true);
  assert.equal((await media.scanChatMedia('tests/fixtures/chat-production-qr.png', 'image/png')).hasQr, false, 'production QR identifiers remain visible');
  const phone = path.join(directory, 'phone.png');
  execFileSync('convert', ['-size', '1000x200', 'xc:white', '-font', 'DejaVu-Sans', '-pointsize', '48', '-fill', 'black', '-gravity', 'center', '-annotate', '0', 'Call 09171234567', phone]);
  assert.equal((await media.scanChatMedia(phone, 'image/png')).hasContacts, true);
  const ordinary = path.join(directory, 'ordinary.png');
  execFileSync('convert', ['-size', '300x200', 'xc:blue', ordinary]);
  const verdict = await media.scanChatMedia(ordinary, 'image/png');
  assert.equal(verdict.status, 'checked'); assert.equal(verdict.hasQr, false); assert.equal(verdict.hasContacts, false);
  assert.equal(media.hideChatMedia({ chatSafety: verdict }, { orderType: 'express' }), false);
  assert.equal(media.hideChatMedia({}, { orderType: 'express' }), true, 'legacy unscanned media fails closed');
  assert.equal(media.hideChatMedia({}, {}), false, 'regular order attachment compatibility');
});

test('unreadable media fails closed without returning extracted private text', async () => {
  const result = await media.scanChatMedia('/does-not-exist', 'image/png');
  assert.deepEqual(result, { version: 1, status: 'unavailable' });
});
