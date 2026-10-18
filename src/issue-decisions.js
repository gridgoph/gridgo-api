import { refundFail as fail, refundMinor } from './refund-policy.js';
import { publicIssue } from './issue-evidence.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';

export const FAULT_APPROVAL_LIMIT_MINOR = 100000;
const reasonText = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail(400, 'fault_reason_required', 'Explain the evidence and remedy in at most 2000 characters.');
  return value.trim();
};

/** A human decision record. It neither chooses fault nor moves money or claims. */
export async function routeIssueDecisions({ req, url, store, user, readBody, now, id, audit }) {
  const match = url.pathname.match(/^\/issues\/([^/]+)\/(decision|approve-decision)$/);
  if (!match || req.method !== 'POST') return null;
  if (!user) fail(401, 'unauthorized', 'Sign in.');
  if (!['ops_admin', 'super_admin'].includes(user.role)) fail(403, 'forbidden', 'Operations or Super Admin is required.');
  const issue = (store.issues || []).find(row => row.id === match[1]);
  if (!issue) fail(404, 'issue_not_found', 'Issue not found.');
  if (['resolved', 'dismissed'].includes(issue.status)) fail(409, 'issue_closed', 'This issue is closed.');
  const body = await readBody(req);
  if (body?.expectedVersion !== (issue.version || 1)) fail(409, 'issue_stale', 'Reload the issue before changing it.', { currentVersion: issue.version || 1 });
  const reason = reasonText(body.reason);
  const at = now();
  let decision;
  if (match[2] === 'approve-decision') {
    if (user.role !== 'super_admin') fail(403, 'fault_super_admin_required', 'Super Admin must approve this GRIDGO-funded remedy.');
    if (issue.faultDecision?.status !== 'awaiting_approval' || body.decisionId !== issue.faultDecision.id) fail(409, 'fault_decision_conflict', 'Select the pending decision.');
    decision = { ...issue.faultDecision, status: 'approved', approvedBy: user.id, approvedAt: at, approvalReason: reason };
  } else {
    if (!['shop', 'rider', 'gridgo', 'client'].includes(body.fault)
      || !['reprint', 'replacement', 'partial_refund', 'full_refund', 'none'].includes(body.remedy)) {
      fail(400, 'invalid_fault_decision', 'Choose a fault and remedy.');
    }
    if (body.fault === 'client' && body.remedy !== 'none') fail(400, 'fault_client_no_refund', 'Client fault has no funded remedy.');
    if (body.fault !== 'client' && body.remedy === 'none') fail(400, 'invalid_fault_decision', 'Record a remedy for this fault.');
    const costMinor = refundMinor(body.costMinor, 'costMinor');
    const gridgoCostMinor = refundMinor(body.gridgoCostMinor, 'gridgoCostMinor');
    if (gridgoCostMinor > costMinor || (['rider', 'gridgo'].includes(body.fault) && gridgoCostMinor !== costMinor)
      || (body.fault === 'client' && costMinor !== 0)) fail(400, 'invalid_fault_funding', 'Record the total remedy cost and the amount GRIDGO funds, including any shop-fault advance.');
    const evidenceIds = body.evidenceIds;
    const allowed = new Set([...(issue.evidenceSnapshot?.groups || []).map(row => row.id),
      ...(issue.evidenceSnapshot?.files || []).map(row => row.fileId)]);
    if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > 50
      || new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some(value => !allowed.has(value))) {
      fail(400, 'fault_evidence_required', 'Cite gathered case evidence.');
    }
    const alternativesReason = ['partial_refund', 'full_refund'].includes(body.remedy) ? reasonText(body.alternativesReason) : null;
    decision = { id: id('idecision'), fault: body.fault, remedy: body.remedy, reason, evidenceIds: [...evidenceIds],
      alternativesReason, costMinor, gridgoCostMinor, recordedBy: user.id, recordedAt: at,
      status: gridgoCostMinor > FAULT_APPROVAL_LIMIT_MINOR && user.role !== 'super_admin' ? 'awaiting_approval' : 'approved',
      ...(user.role === 'super_admin' ? { approvedBy: user.id, approvedAt: at } : {}) };
  }
  issue.faultDecision = decision;
  (issue.faultDecisionHistory ||= []).push(structuredClone(decision));
  issue.version = (issue.version || 1) + 1;
  issue.updatedAt = at;
  audit(store, { actor: user, action: `issue.${match[2] === 'decision' ? 'fault_recorded' : 'fault_approved'}`,
    entityType: 'issue', entityId: issue.id, orderId: issue.orderId, reason,
    detail: { decisionId: decision.id, fault: decision.fault, remedy: decision.remedy, costMinor: decision.costMinor,
      gridgoCostMinor: decision.gridgoCostMinor, status: decision.status, version: issue.version } });
  store.notifications ||= [];
  for (const recipient of [{ userId: issue.clientId, role: 'client' }, ...privilegedAdminMemberships(store)]) {
    store.notifications.push({ id: id('notif'), userId: recipient.userId, appRole: recipient.role, orderId: issue.orderId,
      type: 'issue_decision', title: 'Problem report updated', body: 'Open the problem report for the recorded decision and its approval status.', read: false, at });
  }
  const order = store.orders.find(row => row.id === issue.orderId);
  if (order) queueOrderInvalidate(store, order, ['orders', 'claims']);
  return { status: 200, mutated: true, body: { issue: publicIssue(issue, user) } };
}
