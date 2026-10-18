import { approvalReviewSnapshot } from './approval-proof.js';
import { refundFail as fail } from './refund-policy.js';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined)
  .map(key => [key, structuredClone(value[key])]));
const EVIDENCE_PURPOSES = new Set(['artwork', 'mockup', 'finished_product_photo', 'production_photo',
  'fulfilment_proof', 'packing_photo', 'handoff_signature', 'delivery_photo', 'approval_signature', 'approval_sample_photo']);
export const PROBLEM_TYPES = ['material_quality', 'damage', 'wrong_item', 'delivery', 'other'];

export function problemPhotos(store, user, body) {
  // Existing builds send kind/description only. New problem reports opt in with problemType.
  if (body.problemType === undefined && body.photoFileIds === undefined) return [];
  if (!PROBLEM_TYPES.includes(body.problemType)) fail(400, 'invalid_problem_type', 'Choose a supported problem type.');
  if (!Array.isArray(body.photoFileIds) || !body.photoFileIds.length || body.photoFileIds.length > 10
    || new Set(body.photoFileIds).size !== body.photoFileIds.length) fail(400, 'problem_photos_required', 'Attach one to ten distinct problem photos.');
  return body.photoFileIds.map(fileId => {
    const file = (store.files || []).find(row => row.fileId === fileId);
    if (!file || file.ownerId !== user.id || file.purpose !== 'refund_evidence' || file.state !== 'ready'
      || !file.objectKey || file.deletedAt || file.deleteRequestedAt || file.references?.length
      || !['image/jpeg', 'image/png', 'image/webp'].includes(file.detectedContentType)) {
      fail(400, 'invalid_problem_photo', 'Upload your own unused, ready refund_evidence photo.');
    }
    return file;
  });
}

/** Snapshot facts only. Missing historical proof is never reconstructed as approval. */
export function gatherIssueEvidence(store, order, photos, at) {
  const specification = approvalReviewSnapshot(store, order);
  const approvals = (order.approvalProofs || []).map(proof => pick(proof, ['id', 'phase', 'status', 'method', 'at',
    'statement', 'signatureFileId', 'samplePhotoFileId', 'snapshot', 'snapshotSha256']));
  const ids = new Set(photos.map(file => file.fileId));
  const findIds = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'fileId' || key.endsWith('FileId')) && typeof entry === 'string') ids.add(entry);
      else if (key.endsWith('FileIds') && Array.isArray(entry)) entry.forEach(id => ids.add(id));
      else findIds(entry);
    }
  };
  const groups = [
    { id: 'specification', kind: 'specification', data: specification },
    { id: 'approvals', kind: 'approval', data: approvals },
    { id: 'file_check', kind: 'preflight', data: structuredClone(order.fileCheck ?? null) },
    { id: 'shop_qa', kind: 'shop_qa', data: pick(order.shopHandover, ['finished', 'review', 'attempts']) },
    { id: 'rider_check', kind: 'rider_check', data: { checklist: structuredClone(order.pickupChecklist ?? null),
      ...pick(order.shopHandover, ['inspections', 'packingPhotos']) } },
    { id: 'delivery', kind: 'delivery', data: pick(order, ['deliveryEvidence', 'deliveryPhotoFileIds', 'deliveryProofFileIds']) },
    { id: 'client_photos', kind: 'client_report', data: { fileIds: photos.map(file => file.fileId) } },
  ];
  groups.forEach(group => findIds(group.data));
  for (const file of store.files || []) {
    if (EVIDENCE_PURPOSES.has(file.purpose) && file.references?.some(ref => ref.type === 'order' && ref.id === order.id)) ids.add(file.fileId);
  }
  const files = [...ids].sort().map(fileId => {
    const file = (store.files || []).find(row => row.fileId === fileId);
    // Only evidence purposes; never copy object keys, receiving accounts or verification documents.
    if (!file || (!EVIDENCE_PURPOSES.has(file.purpose) && !photos.includes(file))) return { fileId, unavailable: true };
    return { ...pick(file, ['fileId', 'purpose', 'originalFilename', 'detectedContentType', 'size', 'contentSha256',
      'state', 'createdAt', 'readyAt', 'artworkCheck', 'detected']),
      unavailable: file.state !== 'ready' || Boolean(file.deleteRequestedAt || file.deletedAt) };
  });
  return { version: 1, capturedAt: at, groups, files };
}

export function publicIssue(issue, user) {
  const result = structuredClone(issue);
  if (!['ops_admin', 'super_admin'].includes(user?.role)) {
    delete result.evidenceSnapshot;
    delete result.faultDecisionHistory;
    if (result.faultDecision) result.faultDecision = pick(result.faultDecision, ['id', 'fault', 'remedy', 'reason', 'status', 'recordedAt', 'approvedAt']);
    if (user?.role !== 'client') delete result.photoFileIds;
  }
  return result;
}
