import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCX_CONTENT_TYPE } from '../src/docx.js';
import { createArtworkPreviews, isPreviewDocument } from '../src/artwork-preview.js';
import { publicFile } from '../src/attachments.js';

test('artwork metadata exposes a private preview resolver for legacy PDF files', () => {
  const file = { fileId: 'file_pdf', purpose: 'artwork', state: 'ready', detectedContentType: 'application/pdf', objectKey: 'private/original.pdf' };
  assert.deepEqual(publicFile(file).preview, {
    status: 'pending', downloadUrlPath: '/files/file_pdf/preview-url', retryPath: '/files/file_pdf/preview',
  });
  assert.ok(!JSON.stringify(publicFile(file)).includes('private/'));
});

test('Word metadata overrides legacy preview states and never triggers upload rendering', () => {
  for (const preview of [undefined, { status: 'ready', size: 100 }, { status: 'failed', error: 'preview_conversion_failed' }]) {
    const file = { fileId: 'word', purpose: 'artwork', state: 'ready', detectedContentType: DOCX_CONTENT_TYPE, preview };
    assert.equal(isPreviewDocument(file), false);
    assert.deepEqual(publicFile(file).preview, {
      status: 'unsupported', error: 'preview_word_not_available',
      downloadUrlPath: '/files/word/preview-url', retryPath: '/files/word/preview',
    });
  }
});

test('Word preview reads and Retry authorize first and never read, render or sign cached bytes', async () => {
  const file = { fileId: 'word', purpose: 'artwork', state: 'ready', detectedContentType: DOCX_CONTENT_TYPE, preview: { status: 'ready', size: 100 } };
  let authorized = 0;
  const unexpected = () => assert.fail('Word must not access storage, renderer, locks or save');
  const previews = createArtworkPreviews({
    database: { transaction: fn => fn(), query: unexpected }, load: async () => ({ files: [file] }), save: unexpected,
    storage: { statObject: unexpected, getObject: unexpected, putObject: unexpected, presignGet: unexpected }, render: unexpected,
  });
  for (const retry of [false, true]) {
    await assert.rejects(previews.resolve('word', { retry, authorize: () => { authorized++; } }), { code: 'preview_word_not_available', status: 422 });
    await assert.rejects(previews.resolve('word', { retry, authorize: () => { throw Object.assign(new Error('Denied'), { code: 'forbidden' }); } }), { code: 'forbidden' });
  }
  assert.equal(authorized, 2);
});
