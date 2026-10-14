import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFile } from '../src/attachments.js';

test('artwork metadata exposes a private preview resolver for legacy PDF files', () => {
  const file = { fileId: 'file_pdf', purpose: 'artwork', state: 'ready', detectedContentType: 'application/pdf', objectKey: 'private/original.pdf' };
  assert.deepEqual(publicFile(file).preview, {
    status: 'pending', downloadUrlPath: '/files/file_pdf/preview-url', retryPath: '/files/file_pdf/preview',
  });
  assert.ok(!JSON.stringify(publicFile(file)).includes('private/'));
});
