import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DOCX_CONTENT_TYPE } from './docx.js';
import { DOMAIN_MUTATION_LOCK } from './database.js';
import { renderArtworkPreview, PREVIEW_MAX_SOURCE, previewError } from './artwork-preview-renderer.js';

const DOCUMENTS = ['application/pdf', DOCX_CONTENT_TYPE];
const IMAGES = ['image/jpeg', 'image/png', 'image/webp'];
export const previewObjectKey = key => `${key}.preview-v1.png`;
export const isPreviewDocument = file => file?.purpose === 'artwork' && DOCUMENTS.includes(file.detectedContentType);
export function publicArtworkPreview(file) {
  if (file?.purpose !== 'artwork' || file.state !== 'ready') return undefined;
  const supported = DOCUMENTS.includes(file.detectedContentType) || IMAGES.includes(file.detectedContentType);
  return {
    status: !supported ? 'unsupported' : IMAGES.includes(file.detectedContentType) ? 'ready' : file.preview?.status || 'pending',
    downloadUrlPath: `/files/${file.fileId}/preview-url`, retryPath: `/files/${file.fileId}/preview`,
    ...(file.preview?.error ? { error: file.preview.error } : {}),
  };
}
export function logPreviewFailure(fileId, phase, error) {
  // Codes only: renderer stderr may contain private document text/paths.
  const reason = String(error?.code || 'preview_internal_error').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80);
  console.warn(JSON.stringify({ event: 'artwork_preview_failed', fileId, phase, reason }));
}

export function createArtworkPreviews({ database, load, save, storage, render = renderArtworkPreview, now = () => new Date().toISOString() }) {
  async function resolve(fileId, { authorize, sourcePath, retry = false } = {}) {
    // One renderer across API replicas. This lock is independent of the domain
    // lock: conversion must not stall orders/payments. Refuse excess work rather
    // than queuing arbitrary documents or exhausting the connection pool.
    const result = await database.transaction(async () => {
      let store = await load();
      let file = store.files.find(row => row.fileId === fileId);
      await authorize(store, file);
      if (!isPreviewDocument(file) && !IMAGES.includes(file.detectedContentType)) throw previewError('preview_not_supported', 422);
      if (file.purpose !== 'artwork') throw previewError('preview_not_supported', 422);
      const image = IMAGES.includes(file.detectedContentType);
      let directory;
      try {
        if (!image && (!file.preview || file.preview.status !== 'ready' || retry)) {
          const locked = (await database.query("SELECT pg_try_advisory_xact_lock(hashtext('gridgo-preview-renderer')) AS locked")).rows[0].locked;
          if (!locked) return { error: previewError('preview_busy', 503) };
          if (file.preview?.attemptedAt && Date.parse(now()) - Date.parse(file.preview.attemptedAt) < 30_000) {
            return { error: previewError(file.preview.error || 'preview_retry_later', 429) };
          }
          if (file.size > PREVIEW_MAX_SOURCE) throw previewError('preview_source_too_large', 422);
          let input = sourcePath;
          if (!input) {
            directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gridgo-preview-source-'));
            input = path.join(directory, 'source');
            const stat = await storage.statObject(file.objectKey);
            if (stat.size !== file.size) throw previewError('preview_source_mismatch', 409);
            let size = 0;
            const limit = new Transform({ transform(chunk, encoding, callback) {
              size += chunk.length;
              callback(size > PREVIEW_MAX_SOURCE || size > file.size ? previewError('preview_source_too_large', 422) : null, chunk);
            } });
            await pipeline(await storage.getObject(file.objectKey), limit, fs.createWriteStream(input, { mode: 0o600 }), { signal: AbortSignal.timeout(30_000) });
            if (size !== file.size) throw previewError('preview_source_mismatch', 409);
          }
          const bytes = await render(input, file.detectedContentType);
          const originalKey = file.objectKey;
          await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DOMAIN_MUTATION_LOCK]);
          store = await load(); file = store.files.find(row => row.fileId === fileId);
          await authorize(store, file);
          if (file.objectKey !== originalKey) throw previewError('preview_source_changed', 409);
          const key = previewObjectKey(originalKey);
          await storage.putObject({ key, body: bytes, size: bytes.length, contentType: 'image/png', privateFinancial: true });
          file.preview = { status: 'ready', size: bytes.length, attemptedAt: now(), version: 1 };
          await save(store);
        }
        const key = image ? file.objectKey : previewObjectKey(file.objectKey);
        const stat = await storage.statObject(key);
        if (stat.size !== (image ? file.size : file.preview.size)) throw previewError('preview_object_mismatch', 409);
        const signed = await storage.presignGet(key, { privateFinancial: true });
        return { value: { fileId, contentType: image ? file.detectedContentType : 'image/png', page: 1, ...signed } };
      } catch (error) {
        logPreviewFailure(fileId, 'generation_or_read', error);
        // A failed read does not poison a good cached rendition. Retry can
        // regenerate missing/corrupt bytes; signing failures just need a new URL.
        if (!image && file?.state === 'ready' && file.preview?.status !== 'ready') {
          await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DOMAIN_MUTATION_LOCK]);
          store = await load(); file = store.files.find(row => row.fileId === fileId);
          if (file?.state === 'ready') {
            file.preview = { status: 'failed', error: error.code?.startsWith('preview_') ? error.code : 'preview_generation_failed', attemptedAt: now(), version: 1 };
            await save(store);
          }
        }
        return { error: error.code && Number.isInteger(error.status) ? error : previewError('preview_generation_failed') };
      } finally { if (directory) await fs.promises.rm(directory, { recursive: true, force: true }); }
    }, { lockKey: `gridgo-preview:${fileId}` });
    if (result.error) { logPreviewFailure(fileId, 'request', result.error); throw result.error; }
    return result.value;
  }
  return { resolve };
}
