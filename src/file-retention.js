import { invalidateRiderDocumentsForFile, markFileDeleted } from './attachments.js';
import { assertEarlyFileDeletion, fileRelationships, retentionDecision } from './file-retention-policy.js';

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
  async function finishPending(fileId) {
    return database.transaction(async () => {
      const store = await load();
      const file = store.files.find((row) => row.fileId === fileId);
      if (!file || file.state !== 'delete_pending' || (file.deletionSource === 'retention' && !enabled)
        || fileRelationships(store, file).held) return false;
      // Keep the domain lock until deletion finishes: opening a case cannot race
      // the final protection check. The pending intent was committed separately.
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
      if (file.state !== 'delete_pending' || file.deletionSource !== 'early') {
        pending(store, file, 'early', latestActor, typeof reason === 'string' ? reason.trim() : null);
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
          if (file.state !== 'delete_pending') {
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
      if (file.state !== 'delete_pending') continue;
      try { await finishPending(file.fileId); } catch { /* Retry on the daily pass. */ }
    }
  }
  return { run, deleteEarly, finishPending, reconcile };
}
