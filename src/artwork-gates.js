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
  const check = { ...order.fileCheck };
  check.waitingSeconds = check.status === 'pending'
    ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(check.requestedAt)) / 1000)) : 0;
  return check;
}

export function recordFileCheckTransition(order, from, next, actor, at, note) {
  if (!order.fileCheck) return;
  if (from === 'needs_qa' && ['supplier_assigned', 'approved_for_matching', 'proof_approval'].includes(next)) {
    order.fileCheck = { ...order.fileCheck, status: 'passed', reviewedAt: at, reviewedBy: actor.id, reason: null };
  } else if (from === 'needs_qa' && next === 'client_correction') {
    order.fileCheck = { ...order.fileCheck, status: 'failed', reviewedAt: at, reviewedBy: actor.id, reason: note.trim() };
  } else if (['submitted', 'needs_qa'].includes(next) && from === 'client_correction') {
    order.fileCheck = { status: 'pending', requestedAt: at, reviewedAt: null, reviewedBy: null, reason: null };
  } else if (next === 'cancelled' && order.fileCheck.status !== 'passed') {
    order.fileCheck = { ...order.fileCheck, status: 'cancelled' };
  }
}
