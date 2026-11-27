import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

export const REQUIRED_RIDER_DOCUMENTS = Object.freeze(['drivers_license', 'drivers_license_back', 'or_cr', 'motorcycle_photo', 'resume']);
export const RIDER_CONSENT = 'I agree that GRIDGO keeps my license, OR/CR, motorcycle photo and resume only to check that I can ride for GRIDGO. Only GRIDGO Ops can see them.';

function fail(status, code, message, details = {}) {
  throw Object.assign(new Error(message), { status, code, details });
}

export function riderVerification(store, approvalCase) {
  if (!approvalCase) return null;
  const review = approvalCase.riderReview || {};
  return {
    status: approvalCase.status === 'approved' ? 'approved'
      : approvalCase.status !== 'pending' ? approvalCase.status
      : review.status === 'needs_reupload' ? 'needs_reupload'
      : approvalCase.submittedAt ? 'under_review' : 'intake',
    consent: review.consent || null,
    consentVersion: 1,
    consentWording: RIDER_CONSENT,
    requiredDocuments: REQUIRED_RIDER_DOCUMENTS,
  };
}

export function assertRiderDocumentsComplete(store, riderId, at) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const current = (store.riderDocuments || []).filter(d => d.riderId === riderId && d.isCurrent !== false);
  const license = current.find(d => d.kind === 'drivers_license');
  if (license?.expiresOn && license.expiresOn <= today) fail(409, 'document_expired', 'Replace the expired driver license.');
  const missing = REQUIRED_RIDER_DOCUMENTS.filter(kind => !current.some(d => d.kind === kind && !d.reuploadReason
    && (kind !== 'drivers_license' || d.expiresOn > today)
    && (kind !== 'motorcycle_photo' || (typeof d.description === 'string' && d.description.trim()))
    && (store.files || []).some(f => f.fileId === d.fileId && f.ownerId === riderId && f.purpose === 'rider_verification_document' && f.state === 'ready')));
  if (missing.length) fail(409, 'rider_documents_incomplete', 'Attach all required current rider documents.', { missing });
}

export function recordRiderConsent(approvalCase, consent, at) {
  if (consent?.accepted !== true || consent.version !== 1 || Object.keys(consent).some(k => !['accepted', 'version'].includes(k))) {
    fail(400, 'consent_required', 'Accept the current rider document privacy consent.');
  }
  approvalCase.riderReview = { ...approvalCase.riderReview, status: 'under_review', consent: { acceptedAt: at, version: 1, wording: RIDER_CONSENT } };
}

export function notifyRiderReview(store, approvalCase, status, { createId, at }) {
  const recipients = new Set([approvalCase.userId, ...privilegedAdminMemberships(store).map(m => m.userId)]);
  store.notifications ||= [];
  for (const userId of recipients) store.notifications.push({
    id: createId('ntf'), userId, type: `rider_${status}`, title: 'Rider application updated',
    body: 'Open GRIDGO to review the application status.', approvalCaseId: approvalCase.id,
    domainEventKey: `rider_review:${approvalCase.id}:${approvalCase.version}:${status}`, read: false, at,
  });
  queueInvalidate(store, { resource: 'approvals', id: approvalCase.id });
  queueInvalidate(store, { resource: 'identity', id: approvalCase.userId });
}

export function requestRiderReupload({ store, approvalCase, body, actor, actorRole, at, createId }) {
  if (!approvalCase || approvalCase.kind !== 'rider') fail(404, 'approval_case_not_found', 'Rider application not found.');
  if (!body || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
    || typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 200
    || Object.keys(body).some(k => !['expectedVersion', 'requestId', 'documents'].includes(k))
    || !Array.isArray(body.documents) || !body.documents.length || body.documents.length > 5
    || body.documents.some(d => !d || !REQUIRED_RIDER_DOCUMENTS.includes(d.kind) || typeof d.reason !== 'string'
      || !d.reason.trim() || d.reason.length > 1000 || Object.keys(d).some(k => !['kind', 'reason'].includes(k)))
    || new Set(body.documents.map(d => d.kind)).size !== body.documents.length) {
    fail(400, 'invalid_reupload_request', 'Provide expectedVersion, requestId and document kinds with a reason each.');
  }
  const payload = JSON.stringify({ expectedVersion: body.expectedVersion, documents: body.documents });
  const prior = (store.approvalCaseEvents || []).find(e => e.requestId === body.requestId);
  if (prior) {
    if (prior.approvalCaseId !== approvalCase.id || prior.snapshot?.reuploadPayload !== payload) fail(409, 'request_id_conflict', 'This requestId already belongs to a different decision.');
    return { replayed: true };
  }
  if (approvalCase.status !== 'pending' || !approvalCase.submittedAt || approvalCase.riderReview?.status === 'needs_reupload') {
    fail(409, 'approval_state_conflict', 'Only an application under review can be sent back.');
  }
  if (approvalCase.version !== body.expectedVersion) fail(409, 'approval_case_stale', 'Refresh the rider application before deciding.');
  const documents = body.documents.map(input => {
    const document = (store.riderDocuments || []).find(d => d.riderId === approvalCase.userId && d.kind === input.kind && d.isCurrent !== false);
    if (!document) fail(409, 'rider_documents_incomplete', 'A requested document is missing.');
    return { document, reason: input.reason.trim() };
  });
  for (const { document, reason } of documents) document.reuploadReason = reason;
  approvalCase.riderReview = { ...approvalCase.riderReview, status: 'needs_reupload', requestedKinds: body.documents.map(d => d.kind) };
  approvalCase.version += 1;
  approvalCase.updatedAt = at;
  (store.approvalCaseEvents ||= []).push({ id: createId('ace'), approvalCaseId: approvalCase.id,
    applicationRevision: approvalCase.applicationRevision, fromStatus: 'pending', toStatus: 'pending',
    actorUserId: actor.id, actorKind: 'approver', requestId: body.requestId,
    snapshot: { action: 'needs_reupload', reuploadPayload: payload, documents: body.documents }, createdAt: at });
  (store.auditLog ||= []).push({ id: createId('aud'), at, actorId: actor.id, actorRole,
    action: 'rider.needs_reupload', entityType: 'approval_case', entityId: approvalCase.id,
    detail: { requestId: body.requestId, documentKinds: body.documents.map(d => d.kind), version: approvalCase.version } });
  notifyRiderReview(store, approvalCase, 'needs_reupload', { createId, at });
  return { replayed: false };
}
