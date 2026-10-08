import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUpload } from '../src/attachments.js';
import { inspectArtwork } from '../src/artwork-inspection.js';
import { checkArtworkBytes } from '../src/artwork-file-check.js';
import { documentPagesFor } from '../src/document-pages.js';
import { listingAcceptsArtwork, publicAcceptedFormats } from '../src/file-formats.js';
import { defaultAcceptedFileFormats } from '../src/reference-data.js';
import { docx, docxEntries, zip } from './helpers/docx.mjs';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const upload = bytes => validateUpload({ originalFilename: 'print.docx', declaredContentType: MIME, size: bytes.length, sniffBytes: bytes }, 'artwork');
const check = bytes => checkArtworkBytes(bytes, bytes, bytes.length, MIME, '2026-10-08T00:00:00Z');

test('DOCX is uploadable and PDF/DOCX-only listings refuse JPEG', () => {
  const formats = publicAcceptedFormats({ acceptedFileFormats: defaultAcceptedFileFormats() });
  assert.equal(formats.find(row => row.code === 'docx')?.uploadable, true);
  const accepted = formats.filter(row => ['pdf', 'docx'].includes(row.code));
  assert.equal(listingAcceptsArtwork(accepted, MIME), true);
  assert.equal(listingAcceptsArtwork(accepted, 'application/pdf'), true);
  assert.equal(listingAcceptsArtwork(accepted, 'image/jpeg'), false);
});

test('stored, deflated and streamed DOCX archives pass upload and structural checkout checks', () => {
  for (const options of [{ method: 0 }, { method: 8 }, { descriptor: true }]) {
    const bytes = docx('7', options);
    assert.equal(upload(bytes), MIME);
    assert.equal(check(bytes).status, 'passed');
    assert.equal(inspectArtwork(bytes, MIME)?.pageCount, 7);
    assert.equal(inspectArtwork(bytes, MIME)?.widthMilli, null);
  }
});

test('DOCX without usable Pages metadata stays structurally valid with unknown count', () => {
  for (const pages of [null, '0', '-1', 'no', '1.5', '9007199254740992']) {
    const bytes = docx(pages);
    assert.equal(upload(bytes), MIME);
    assert.equal(check(bytes).status, 'passed');
    assert.equal(inspectArtwork(bytes, MIME)?.pageCount, null);
  }
});

test('renamed ZIP, missing Word parts, corrupt and protected containers are refused', () => {
  const corrupt = docx('7', { method: 0 }); corrupt[60] ^= 1;
  const encrypted = docx(); encrypted.writeUInt16LE(1, 6);
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1); docx().copy(oversized);
  const cases = [zip([['hello.txt', 'hello']]), zip(docxEntries().filter(([name]) => name !== '[Content_Types].xml')),
    zip(docxEntries().filter(([name]) => name !== 'word/document.xml')), docx().subarray(0, -1), corrupt, encrypted, oversized,
    zip([...docxEntries(), ['word/document.xml', 'duplicate']]), zip([...docxEntries(), ['../escape', 'no']]),
    zip([...docxEntries(), ['word/bomb.xml', 'x'.repeat(4 * 1024 * 1024)]]),
    zip([...docxEntries(), ...Array.from({ length: 2049 }, (_, i) => [`word/${i}`, 'x'])]),
  ];
  for (const bytes of cases) {
    assert.throws(() => upload(bytes), error => ['invalid_file_type', 'file_too_large'].includes(error.code));
    assert.equal(check(bytes).status, 'failed');
  }
});

test('unknown DOCX count accepts explicit client pages; known counts and other formats keep server counts', () => {
  const file = { fileId: 'doc', purpose: 'artwork', state: 'ready', detectedContentType: MIME, detected: { pageCount: null } };
  const store = { files: [file] }, item = { pricingUnit: 'per_page' };
  const line = { artworkFileId: 'doc', measurement: { pages: 9 } };
  assert.deepEqual(documentPagesFor(store, item, line, null, { required: true }), { total: 9, range: null, printed: 9 });
  file.detected.pageCount = 7;
  assert.deepEqual(documentPagesFor(store, item, line, '2-4', { required: true }), { total: 7, range: '2-4', printed: 3 });
  file.detected.pageCount = null; file.detectedContentType = 'application/pdf';
  assert.throws(() => documentPagesFor(store, item, line, null, { required: true }), { code: 'document_page_count_required' });
});

test('DOCX size declarations cannot bypass inflation limits or CRC checks', () => {
  const bytes = zip([...docxEntries(), ['word/bomb.xml', 'x'.repeat(4 * 1024 * 1024)]]);
  let directory = bytes.readUInt32LE(bytes.length - 6);
  for (let i = 0; i < 4; i++) directory += 46 + bytes.readUInt16LE(directory + 28);
  const offset = bytes.readUInt32LE(directory + 42);
  // Lie about the expanded length in BOTH headers; bounded inflate must refuse.
  bytes.writeUInt32LE(100, directory + 24); bytes.writeUInt32LE(100, offset + 22);
  assert.throws(() => upload(bytes), { code: 'invalid_file_type' });
  assert.equal(check(bytes).status, 'failed');
  const huge = docx();
  const central = huge.readUInt32LE(huge.length - 6);
  huge.writeUInt32LE(17 * 1024 * 1024, central + 24);
  assert.throws(() => upload(huge), { code: 'invalid_file_type' });
});

test('DOCX cannot impersonate another MIME or upload purpose, or use only ZIP magic', () => {
  const bytes = docx();
  const file = { originalFilename: 'file.docx', declaredContentType: MIME, size: bytes.length, sniffBytes: bytes };
  for (const purpose of ['mockup', 'verification_document', 'catalog_item_photo']) {
    assert.throws(() => validateUpload(file, purpose), { code: 'invalid_file_type' });
  }
  assert.throws(() => validateUpload({ ...file, declaredContentType: 'application/pdf' }), { code: 'invalid_file_type' });
  assert.throws(() => validateUpload({ ...file, originalFilename: 'file.pdf' }), { code: 'invalid_file_type' });
  assert.throws(() => validateUpload({ ...file, sniffBytes: bytes.subarray(0, 32) }), { code: 'invalid_file_type' });
  assert.equal(validateUpload({ ...file, declaredContentType: '' }), MIME);
});
