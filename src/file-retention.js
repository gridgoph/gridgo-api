import { isPreviewDocument, previewObjectKey } from './artwork-preview.js';
import { DOCX_CONTENT_TYPE } from './docx.js';
import { invalidateRiderDocumentsForFile, markFileDeleted } from './attachments.js';
import { assertEarlyFileDeletion, fileRelationships, retentionDecision, isSavedArtwork } from './file-retention-policy.js';

export function createFileRetention({ database, load, save, storage, enabled = false,
  now = () => new Date().toISOString(), id }) {
  function audit(store, file, action, actor, reason) {
    store.auditLog ||= [];
    store.auditLog.push({ id: id('aud'), at: now(), actorId: actor?.id || null,
      actorRole: actor?.role || 'system', action, entityType: 'file', entityId: file.fileId,
      reason: reason || null, detail: { purpose: file.purpose } });
  }
  function pending(store, file, source, actor, reason) {
    file.state = 'delete_pending'; file.deleteRequestedAt = now(); file.deletionSource = source;
    invalidateRiderDocumentsForFile(store, file, now());
    audit(store, file, source === 'retention' ? 'file.retention_delete' : 'file.early_delete', actor, reason);
  }
  function closureDeletable(store, file) {
    if (!['artwork', 'mockup'].includes(file?.purpose) || !file.savedFileDeletionRequestedAt) return false;
    const links = fileRelationships(store, file);
    // A closed account cannot check out its old draft carts. Historical order
    // snapshots and every open-case hold still protect the original bytes.
    return !links.held && links.orders.every(order => ['completed', 'payout_released', 'cancelled'].includes(order.state));
  }
  async function finishPending(fileId) {
    return database.transaction(async () => {
      const store = await load();
      const file = store.files.find((row) => row.fileId === fileId);
      const links = file && fileRelationships(store, file);
      if (!file || file.state !== 'delete_pending' || !['early', 'retention', 'saved_file', 'account_closed'].includes(file.deletionSource)
        || (isSavedArtwork(file) && file.deletionSource !== 'saved_file')
        || (file.deletionSource === 'saved_file' && (links.activeCart
          || links.orders.some(order => !['completed', 'payout_released'].includes(order.state))))
        || (file.deletionSource === 'account_closed' && !closureDeletable(store, file))
        || (file.deletionSource === 'retention' && (!enabled || !retentionDecision(store, file, now()).eligible))
        || links.held) return false;
      // Keep the domain lock until deletion finishes: opening a case cannot race
      // the final protection check. The pending intent was committed separately.
      // Delete the deterministic derivative even if a crash prevented its
      // metadata commit. All parent holds apply to both objects.
      // Word rendering is deferred, but any previously cached Word rendition
      // still belongs to the parent and must share its deletion/hold lifecycle.
      if (file.objectKey && (isPreviewDocument(file) || (file.purpose === 'artwork' && file.detectedContentType === DOCX_CONTENT_TYPE))) {
        await storage.deleteObject(previewObjectKey(file.objectKey));
      }
      if (file.objectKey) await storage.deleteObject(file.objectKey);
      markFileDeleted(file, now());
      await save(store);
      return true;
    });
  }
  async function deleteEarly(fileId, actor, reason) {
    await database.transaction(async () => {
      const store = await load();
      const file = store.files.find((row) => row.fileId === fileId);
      const latestActor = typeof actor === 'function' ? await actor(store) : actor;
      assertEarlyFileDeletion(store, file, latestActor, reason);
      if (file.state === 'deleted') return;
      if (!['ready', 'delete_pending'].includes(file.state)) {
        throw Object.assign(new Error('file_state_conflict'), { status: 409, code: 'file_state_conflict' });
      }
      const source = isSavedArtwork(file) && latestActor.role === 'client' ? 'saved_file' : 'early';
      if (file.state !== 'delete_pending' || file.deletionSource !== source) {
        pending(store, file, source, latestActor, typeof reason === 'string' ? reason.trim() : null);
        await save(store);
      }
    });
    await finishPending(fileId);
    return (await load()).files.find((row) => row.fileId === fileId);
  }
  async function run({ dryRun = true } = {}) {
    const at = now();
    const snapshot = await load();
    const candidates = snapshot.files.filter((file) => retentionDecision(snapshot, file, at).eligible);
    const byPurpose = {};
    for (const file of candidates) byPurpose[file.purpose] = (byPurpose[file.purpose] || 0) + 1;
    const report = { at, dryRun: dryRun || !enabled, deletionEnabled: enabled, total: candidates.length,
      byPurpose, deleted: 0, failed: 0 };
    if (report.dryRun) return report;
    for (const candidate of candidates) {
      try {
        const queued = await database.transaction(async () => {
          const store = await load();
          const file = store.files.find((row) => row.fileId === candidate.fileId);
          if (!file || !retentionDecision(store, file, now()).eligible) return false;
          if (file.state !== 'delete_pending' || !['early', 'retention'].includes(file.deletionSource)) {
            pending(store, file, 'retention');
            await save(store);
          }
          return true;
        });
        if (queued && await finishPending(candidate.fileId)) report.deleted++;
      } catch {
        // Durable intent survives unavailable storage and is retried next pass.
        report.failed++;
      }
    }
    return report;
  }
  async function reconcile() {
    for (const file of (await load()).files) {
      if (file.state === 'ready' && file.savedFileDeletionRequestedAt) {
        await database.transaction(async () => {
          const store = await load();
          const current = store.files.find(row => row.fileId === file.fileId);
          if (current?.state !== 'ready' || !closureDeletable(store, current)) return;
          pending(store, current, 'account_closed', null, 'account_closed');
          await save(store);
        });
      }
      if (file.state !== 'delete_pending' && !(file.state === 'ready' && file.savedFileDeletionRequestedAt)) continue;
      try { await finishPending(file.fileId); } catch { /* Retry on the daily pass. */ }
    }
  }
  return { run, deleteEarly, finishPending, reconcile };
}
