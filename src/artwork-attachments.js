import { validateArtworkLinks } from './artwork-links.js';

export const MAX_ARTWORK_ATTACHMENTS = 10;
function fail(code, message) { throw Object.assign(new Error(message), { status: 400, code }); }
export function artworkLabel(value) {
  if (value == null) return {};
  if (typeof value !== 'string' || value.trim().length > 80 || /[\x00-\x1f\x7f]/u.test(value)) {
    fail('invalid_artwork_attachments', 'Use an attachment label of at most 80 characters on one line.');
  }
  return value.trim() ? { label: value.trim() } : {};
}

/** Array order is the client-selected order. Old rows are projected without a rewrite. */
export function artworkAttachmentsFor(line) {
  return structuredClone(line.artworkAttachments ?? [
    ...(line.artworkFileId ? [{ kind: 'file', fileId: line.artworkFileId }] : []),
    ...(line.artworkLinks || []).map(link => ({ kind: 'link', ...link })),
  ]);
}
export function artworkFileIdsFor(line) {
  return artworkAttachmentsFor(line).filter(entry => entry.kind === 'file').map(entry => entry.fileId);
}
export function assertArtworkAttachmentLimit(entries) {
  if (entries.length > MAX_ARTWORK_ATTACHMENTS) fail('artwork_attachment_limit_exceeded', 'Attach at most 10 files and design links per item in total.');
}
export function validateArtworkAttachments(entries, acceptedFormats, { allowShortLinks = false } = {}) {
  if (!Array.isArray(entries)) fail('invalid_artwork_attachments', 'Send artworkAttachments as an ordered array.');
  assertArtworkAttachmentLimit(entries);
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid_artwork_attachments', 'Each attachment must be a file or design link.');
    const label = artworkLabel(entry.label);
    if (entry.kind === 'file' && typeof entry.fileId === 'string' && entry.fileId.trim() && entry.fileId.length <= 120 && !Object.hasOwn(entry, 'url')) {
      return { kind: 'file', fileId: entry.fileId.trim(), ...label };
    }
    if (entry.kind === 'link' && !Object.hasOwn(entry, 'fileId')) {
      const [link] = validateArtworkLinks([entry], acceptedFormats, { allowShortLinks });
      return { kind: 'link', ...link, ...label };
    }
    fail('invalid_artwork_attachments', 'Use kind=file with fileId or kind=link with formatCode and url.');
  });
}

/** Legacy PATCH replaces its primary file and/or links without discarding extra uploads. */
export function writeArtworkAttachments(line, body, acceptedFormats) {
  if (Object.hasOwn(body, 'artworkAttachments')) {
    if (['artworkFileId', 'artworkLinks'].some(key => Object.hasOwn(body, key))) {
      fail('invalid_artwork_attachments', 'Send artworkAttachments or the legacy artwork fields, not both.');
    }
    line.artworkAttachments = validateArtworkAttachments(body.artworkAttachments, acceptedFormats);
  } else {
    let entries = artworkAttachmentsFor(line);
    if (Object.hasOwn(body, 'artworkFileId')) {
      const index = entries.findIndex(entry => entry.kind === 'file');
      if (body.artworkFileId == null) { if (index >= 0) entries.splice(index, 1); }
      else {
        const entry = { ...(index >= 0 ? entries[index] : {}), kind: 'file', fileId: body.artworkFileId };
        if (index >= 0) entries[index] = entry; else entries.unshift(entry);
      }
    }
    if (Object.hasOwn(body, 'artworkLinks')) {
      const links = validateArtworkLinks(body.artworkLinks, acceptedFormats);
      entries = [...entries.filter(entry => entry.kind === 'file'), ...links.map(link => ({ kind: 'link', ...link }))];
    }
    // No artwork update: preserve historical links/formats until checkout revalidation.
    if (!['artworkFileId', 'artworkLinks'].some(key => Object.hasOwn(body, key))) return;
    entries = validateArtworkAttachments(entries, acceptedFormats);
    if (line.artworkAttachments) line.artworkAttachments = entries;
    else {
      line.artworkFileId = entries.find(entry => entry.kind === 'file')?.fileId ?? null;
      line.artworkLinks = entries.filter(entry => entry.kind === 'link').map(({ kind, ...link }) => link);
    }
  }
  const entries = artworkAttachmentsFor(line);
  line.artworkFileId = entries.find(entry => entry.kind === 'file')?.fileId ?? null;
  line.artworkLinks = entries.filter(entry => entry.kind === 'link').map(({ kind, ...link }) => link);
}

export function artworkPreviewFileId(store, line) {
  return artworkFileIdsFor(line).find(fileId => (store?.files || []).some(file => file.fileId === fileId
    && file.state === 'ready' && (file.detectedContentType?.startsWith('image/') || file.detectedContentType === 'application/pdf'))) ?? null;
}

/** Only call on role-safe response projections, then independently authorize every file. */
export async function signArtworkAttachments(body, { findFile, authorizeRead, presignGet }) {
  const signed = new Map();
  async function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.artworkAttachments)) {
      for (const entry of value.artworkAttachments) {
        if (entry.kind !== 'file') continue;
        const file = findFile(entry.fileId);
        if (!file || file.state !== 'ready' || file.purpose !== 'artwork' || file.deleteRequestedAt || file.deletedAt) continue;
        try { authorizeRead(file); } catch { continue; }
        try {
          if (!signed.has(file.fileId)) signed.set(file.fileId, await presignGet(file.objectKey));
          const url = signed.get(file.fileId);
          entry.downloadUrl = url.url;
          entry.downloadUrlExpiresAt = url.expiresAt;
        } catch { /* Keep the attachment visible; readers can retry /files/:id/download-url. */ }
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'artworkAttachments') await walk(child);
  }
  await walk(body);
}
