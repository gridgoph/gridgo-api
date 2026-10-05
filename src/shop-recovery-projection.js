export function publicRecovery(order, user) {
  const recovery = order.shopRecovery;
  if (!recovery) return null;
  if (['ops_admin', 'super_admin'].includes(user?.role)) return structuredClone(recovery);
  if (user?.role === 'client' && user.id === order.clientId) return { id: recovery.id, status: recovery.status,
    createdAt: recovery.createdAt, refundRequestId: recovery.refundRequestId || null,
    replacement: recovery.proposal ? { promiseBy: recovery.proposal.promiseBy } : null,
    canAccept: recovery.status === 'awaiting_client' && Boolean(recovery.proposal),
    canRefund: ['awaiting_client', 'ops_review'].includes(recovery.status) };
  return { id: recovery.id, status: recovery.status };
}
