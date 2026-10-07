// Checkout and supplier visibility share this gate. File bytes stay in MinIO;
// only the upload's structural verdict and the Operations decision are stored.
export function supplierArtworkReleased(order) {
  if (!order) return false;
  if (order.fileCheck) return order.fileCheck.status === 'passed';
  // Existing in-flight work remains visible. Legacy intake has not passed QA.
  return !['draft', 'submitted', 'needs_qa', 'client_correction', 'proof_approval', 'initial_payment_review'].includes(order.state)
    || (order.timeline || []).some(entry => ['approved_for_matching', 'supplier_assigned'].includes(entry.state));
}

export function fileCheckProjection(order, at = new Date().toISOString()) {
  if (!order.fileCheck) return null;
  const check = { ...order.fileCheck, checklist: order.fileCheck.checklist ?? null };
  check.waitingSeconds = check.status === 'pending'
    ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(check.requestedAt)) / 1000)) : 0;
  return check;
}

/** Existing portal ticks, versioned so later wording cannot invent old results. */
export const QA_CHECK_IDS = ['artwork', 'spec', 'quantity', 'address'];

export function qaChecklistSnapshot(checks, passing) {
  // Old dashboard builds may still send only the overall decision during rollout.
  if (checks === undefined) return null;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)
      || Object.keys(checks).length !== QA_CHECK_IDS.length
      || QA_CHECK_IDS.some(id => typeof checks[id] !== 'boolean' || (passing && !checks[id]))) {
    const error = new Error('Send all four QA checks as booleans; approval requires all four checked.');
    error.status = 400;
    error.code = 'invalid_qa_checklist';
    throw error;
  }
  return { version: 1, checks: Object.fromEntries(QA_CHECK_IDS.map(id => [id, checks[id]])) };
}

export function recordFileCheckTransition(order, from, next, actor, at, note, checks) {
  const passing = from === 'needs_qa' && ['supplier_assigned', 'approved_for_matching', 'proof_approval'].includes(next);
  const rejecting = from === 'needs_qa' && next === 'client_correction';
  if (passing || rejecting) {
    const checklist = qaChecklistSnapshot(checks, passing);
    if (!order.fileCheck && !checklist) return;
    order.fileCheck = {
      ...(order.fileCheck || { requestedAt: at }),
      status: passing ? 'passed' : 'failed', reviewedAt: at, reviewedBy: actor.id,
      reason: passing ? null : note.trim(), checklist,
    };
  } else if (order.fileCheck && ['submitted', 'needs_qa'].includes(next) && from === 'client_correction') {
    order.fileCheck = { status: 'pending', requestedAt: at, reviewedAt: null, reviewedBy: null, reason: null, checklist: null };
  } else if (order.fileCheck && next === 'cancelled' && order.fileCheck.status !== 'passed') {
    order.fileCheck = { ...order.fileCheck, status: 'cancelled' };
  }
}
