import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizeChatUpload } from '../src/chat-image-sanitizer.js';

for (const extension of ['jpg', 'png', 'webp']) {
  test(`reencodes ${extension} without device, GPS, comment or profile metadata`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gg246-image-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, `source.${extension}`);
    execFileSync('convert', ['-size', '12x10', 'xc:red', '-set', 'comment', 'SecretDevice GPSLatitude=7.123 GPSLongitude=125.456', source]);
    if (extension === 'jpg') {
      const jpeg = await fs.readFile(source);
      // Valid TIFF Make tag plus an XMP location/device payload in JPEG APP1.
      const tiff = Buffer.alloc(26 + 13);
      tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8);
      tiff.writeUInt16LE(0x10f, 10); tiff.writeUInt16LE(2, 12); tiff.writeUInt32LE(13, 14); tiff.writeUInt32LE(26, 18);
      tiff.write('SecretDevice\0', 26);
      const app1 = data => { const header = Buffer.from([255, 225, 0, 0]); header.writeUInt16BE(data.length + 2, 2); return Buffer.concat([header, data]); };
      const exif = app1(Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
      const xmp = app1(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPSLatitude=7.123 GPSLongitude=125.456 SecretDevice</x:xmpmeta>'));
      await fs.writeFile(source, Buffer.concat([jpeg.subarray(0, 2), exif, xmp, jpeg.subarray(2)]));
      assert.match(execFileSync('identify', ['-verbose', source]).toString(), /SecretDevice/);
    }
    const file = { tempPath: source, size: (await fs.stat(source)).size, originalFilename: 'private-name@shop.ph.' + extension };
    const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension];
    assert.equal(await sanitizeChatUpload(file, mime), 'image/png');
    assert.equal(file.originalFilename, 'image.png');
    const bytes = await fs.readFile(source);
    assert.equal(file.size, bytes.length);
    assert.equal(bytes.includes(Buffer.from('SecretDevice')), false);
    assert.equal(bytes.includes(Buffer.from('GPSLatitude')), false);
    const info = execFileSync('identify', ['-verbose', source]).toString();
    assert.doesNotMatch(info, /exif:|Profile-exif|Profile-xmp|GPSLatitude|SecretDevice/);
    assert.match(info, /Geometry: 12x10/);
  });
}

test('PDF only receives a neutral filename; unsupported and malformed images fail closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gg246-image-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tempPath = path.join(directory, 'upload');
  await fs.writeFile(tempPath, '%PDF-1.7 test');
  const file = { tempPath, size: 13, originalFilename: 'phone-09171234567.pdf' };
  assert.equal(await sanitizeChatUpload(file, 'application/pdf'), 'application/pdf');
  assert.equal(file.originalFilename, 'document.pdf');
  await assert.rejects(sanitizeChatUpload({ ...file, size: 10 * 1024 * 1024 + 1 }, 'application/pdf'), { code: 'file_too_large', status: 413 });
  await assert.rejects(sanitizeChatUpload(file, 'image/svg+xml'), { code: 'chat_image_unsupported' });
  await assert.rejects(sanitizeChatUpload(file, 'image/jpeg'), { code: 'chat_image_sanitization_failed' });
});
