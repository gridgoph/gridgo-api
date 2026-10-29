import { AttachmentError } from './attachments.js';
import { isPreviewDocument, previewObjectKey, publicArtworkPreview } from './artwork-preview.js';
import { DEFAULT_SAVED_FILES_LIMIT_BYTES, isSavedArtwork } from './file-retention-policy.js';
import { displayFilename } from './display-filename.js';

export { DEFAULT_SAVED_FILES_LIMIT_BYTES } from './file-retention-policy.js';
const LIVE = new Set(['pending_upload', 'ready', 'delete_pending']);
const reserved = file => isSavedArtwork(file)
  || (['artwork', 'mockup'].includes(file.purpose) && Boolean(file.saveToMyFilesRequestedAt));
const fail = (status, code, message, details) => { throw new AttachmentError(status, code, message, details); };

export function assertLibraryClient(user) {
  if (!user) fail(401, 'unauthorized', 'Sign in to view My files.');
  if (user.role !== 'client') fail(403, 'forbidden', 'My files is available in your client account.');
  if (['removed', 'suspended'].includes(user.accountStatus)) fail(403, 'forbidden', 'Your account cannot manage files right now.');
}
export function savedFilesUsage(store, user) {
  assertLibraryClient(user);
  return { usedBytes: (store.files || []).filter(file => file.ownerId === user.id && reserved(file) && LIVE.has(file.state))
    .reduce((sum, file) => sum + file.size, 0), limitBytes: store.settings?.savedFilesLimitBytes ?? DEFAULT_SAVED_FILES_LIMIT_BYTES };
}
export function ownLibraryFile(store, user, fileId, { savedOnly = false } = {}) {
  assertLibraryClient(user);
  const file = (store.files || []).find(row => row.fileId === fileId && row.ownerId === user.id);
  if (!file || (savedOnly && !isSavedArtwork(file))) fail(404, 'file_not_found', 'That file is not in your My files library.');
  if (!['artwork', 'mockup'].includes(file.purpose)) fail(400, 'saved_file_purpose_not_allowed', 'Only artwork and design mockups can be saved to My files.');
  return file;
}
export function setFileSaved(store, user, fileId, saved, at, { pendingUpload = false } = {}) {
  const file = ownLibraryFile(store, user, fileId);
  if (typeof saved !== 'boolean') fail(400, 'invalid_saved_file_choice', 'Send saved as true or false.');
  if (!(file.state === 'ready' || (pendingUpload && file.state === 'pending_upload')) || !file.objectKey
    || !Number.isSafeInteger(file.size) || file.size < 0 || file.savedFileDeletionRequestedAt) {
    fail(409, 'file_not_ready', 'Choose a ready artwork file that is not being deleted.');
  }
  if (saved === reserved(file)) return { file, changed: false };
  if (saved) {
    const { usedBytes, limitBytes } = savedFilesUsage(store, user);
    if (file.size > limitBytes - usedBytes) fail(409, 'saved_files_limit_reached',
      'My files storage is full. Delete saved files or turn off Save to My files, then try again.',
      { limitBytes, usedBytes, fileSizeBytes: file.size });
  }
  // A reservation cannot pin an interrupted upload forever. The ready commit
  // promotes it to savedAt only after PutObject has succeeded.
  if (pendingUpload && file.state === 'pending_upload') file.saveToMyFilesRequestedAt = saved ? at : null;
  else file.savedAt = saved ? at : null;
  return { file, changed: true };
}

export async function listSavedFiles({ store, user, offset = 0, storage }) {
  assertLibraryClient(user);
  if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'invalid_offset', 'Use a nonnegative whole-number offset.');
  const all = (store.files || []).filter(file => file.ownerId === user.id && isSavedArtwork(file) && file.state === 'ready')
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.fileId.localeCompare(b.fileId));
  const files = await Promise.all(all.slice(offset, offset + 50).map(async file => {
    const result = { fileId: file.fileId, purpose: file.purpose, originalFilename: displayFilename(file.originalFilename),
      size: file.size, detectedContentType: file.detectedContentType, savedAt: file.savedAt,
      preview: publicArtworkPreview(file) ?? null, previewUrl: null, downloadUrl: null, expiresAt: null };
    try {
      const stat = await storage.statObject(file.objectKey);
      if (stat.size !== file.size) throw new AttachmentError(409, 'storage_object_mismatch', 'The stored file size does not match its record.');
      const signed = await storage.presignGet(file.objectKey, { privateFinancial: true });
      result.downloadUrl = signed.url; result.expiresAt = signed.expiresAt;
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.detectedContentType)) result.previewUrl = signed.url;
      else if (isPreviewDocument(file) && file.preview?.status === 'ready') {
        const key = previewObjectKey(file.objectKey);
        const previewStat = await storage.statObject(key);
        if (previewStat.size === file.preview.size) result.previewUrl = (await storage.presignGet(key, { privateFinancial: true })).url;
      }
    } catch (error) {
      // An unavailable original or preview must not hide the rest of the library.
      result.unavailable = true;
      result.error = ['storage_object_mismatch', 'storage_object_missing'].includes(error.code) ? error.code : 'minio_unavailable';
    }
    return result;
  }));
  return { files, usage: savedFilesUsage(store, user), nextOffset: all.length > offset + 50 ? offset + 50 : null };
}

export function requestAccountSavedFileDeletion(store, userId, { at, actor = null, audit }) {
  let changed = 0;
  for (const file of store.files || []) {
    if (file.ownerId !== userId || !reserved(file) || !LIVE.has(file.state)) continue;
    file.savedAt = null;
    delete file.saveToMyFilesRequestedAt;
    file.savedFileDeletionRequestedAt = at;
    audit(store, { actor, action: 'file.saved_account_closed', entityType: 'file', entityId: file.fileId,
      reason: 'account_closed', detail: { purpose: file.purpose } });
    changed++;
  }
  return changed;
}
