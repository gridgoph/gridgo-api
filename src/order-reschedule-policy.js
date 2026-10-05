/** Independent from claim/refund holds; releasing either cannot resume a declined job. */
export function rescheduleHold(order) {
  const request = order?.rescheduleRequest;
  return Boolean(request && (request.status === 'declined' || request.resolution === 'operations_required')
    && !['rematched', 'resolved'].includes(request.resolution));
}

export function publicReschedule(order, user) {
  const request = order.rescheduleRequest;
  if (!request) return null;
  const ops = ['ops_admin', 'super_admin'].includes(user?.role);
  const client = user?.role === 'client' && user.id === order.clientId;
  const supplier = user?.role === 'supplier' && user.id === request.supplierId;
  if (!ops && !client && !supplier) return null;
  const result = { id: request.id, orderId: order.id, reason: request.reason, status: request.status,
    requestedAt: request.requestedAt, expiresAt: request.expiresAt, answeredAt: request.answeredAt || null,
    resolution: request.resolution || null, refundRequestId: request.refundRequestId || null,
    workHeld: rescheduleHold(order) };
  if (ops || supplier) Object.assign(result, { supplierId: request.supplierId,
    originalReadyBy: request.originalReadyBy, proposedReadyBy: request.proposedReadyBy });
  if (ops || client) Object.assign(result, { originalPromiseBy: request.originalPromiseBy,
    proposedPromiseBy: request.proposedPromiseBy });
  if (client || ops) {
    result.canRequestRefund = request.status === 'declined' && !['rematched', 'refund_requested', 'resolved'].includes(request.resolution);
    result.rematch = request.resolution === 'rematch_offered' && request.offer ? {
      id: request.offer.id, promiseBy: request.offer.promiseBy, expiresAt: request.offer.expiresAt,
      sameProductAndSpecs: true, priceUnchanged: true,
    } : null;
  }
  if (ops) Object.assign(result, { appliedDeductionMinor: request.appliedDeductionMinor || 0, priorLapse: request.priorLapse || null, offer: request.offer || null, resolvedAt: request.resolvedAt || null,
    resolutionReason: request.resolutionReason || null });
  return result;
}
