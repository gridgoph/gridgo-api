/** Versioned shop-to-rider evidence; independent of every published payout plan. */
export const FORCED_STEP_REASONS = Object.freeze(['technical_issue', 'evidence_verified_offline', 'operational_correction', 'other']);
export const riderPackingFlow = order => order?.payoutPlanVersion === 2 && order?.shopHandoverVersion === 2;
export const claimBlocksHandover = (store, order) => Boolean(order.payoutHold || (store.claims || [])
  .some(row => row.orderId === order.id && ['open', 'payout_held'].includes(row.status)));
export function finishedProductPhotos(store, order) {
  return (store?.files || []).filter(file => file.purpose === 'finished_product_photo' && file.ownerId === order.supplierId
    && file.state === 'ready' && file.objectKey && ['image/jpeg', 'image/png', 'image/webp'].includes(file.detectedContentType)
    && file.references?.some(ref => ref.type === 'order' && ref.id === order.id));
}
export function currentInspection(order) {
  const check = order.pickupChecklist;
  return check?.status === 'inspected' && check.completedBy === order.riderId && check.inspectionId ? check : null;
}
export function inspectedPackingPhotos(store, order) {
  const inspection = currentInspection(order);
  if (!inspection) return [];
  return (store?.files || []).filter(file => file.purpose === 'packing_photo' && file.ownerId === order.riderId
    && file.state === 'ready' && file.objectKey && ['image/jpeg', 'image/png', 'image/webp'].includes(file.detectedContentType)
    && file.references?.some(ref => ref.type === 'order' && ref.id === order.id && ref.inspectionId === inspection.inspectionId));
}
export function handoverRequirements(store, order, next) {
  const missing = [];
  if (!order.shopHandover?.finished || order.shopHandover.finished.supplierId !== order.supplierId) missing.push({ code: 'production_finished_required', message: 'Submit photos of the finished, unpacked products for GRIDGO review first.' });
  if (order.shopHandover?.finished && !order.shopHandover.finished.photoFileIds.every(fileId => finishedProductPhotos(store, order).some(file => file.fileId === fileId))) missing.push({ code: 'finished_product_photo_required', message: 'The reviewed finished-product photos must remain available before readiness.' });
  if (next === 'ready_for_dispatch' && order.shopHandover?.review?.decision !== 'approved') {
    missing.push({ code: 'production_review_required', message: 'Wait for GRIDGO to approve the finished-product photos before calling a rider. Do not pack yet.' });
  }
  return missing;
}
export function forcedStepError(body) {
  if (typeof body.reason !== 'string' || !body.reason.trim()) return 'production_override_reason_required';
  if (!FORCED_STEP_REASONS.includes(body.reasonCode)) return 'production_override_reason_code_required';
  if (body.reason.trim().length > 2000) return 'production_override_reason_too_long';
  return null;
}
