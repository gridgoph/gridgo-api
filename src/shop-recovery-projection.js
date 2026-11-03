import { clientPricing } from './shop-move-pricing.js';

const clientOption = (option) => ({ optionId: option.optionId || null, promiseBy: option.promiseBy, pricing: clientPricing(option.pricing) });
const needsTopUp = (option) => option?.pricing?.rule === 'above_cap';

export function publicRecovery(order, user) {
  const recovery = order.shopRecovery;
  if (!recovery) return null;
  if (['ops_admin', 'super_admin'].includes(user?.role)) return structuredClone(recovery);
  if (user?.role === 'client' && user.id === order.clientId) {
    const open = recovery.status === 'awaiting_client';
    const options = recovery.proposal ? [recovery.proposal, ...(recovery.proposal.alternatives || [])] : [];
    return { id: recovery.id, status: recovery.status, fault: recovery.fault || 'shop',
      createdAt: recovery.createdAt, refundRequestId: recovery.refundRequestId || null,
      replacement: recovery.proposal ? clientOption(recovery.proposal) : null,
      alternatives: (recovery.proposal?.alternatives || []).map(clientOption),
      // Released builds show Accept only for an offer they can take without paying more.
      canAccept: open && Boolean(recovery.proposal) && !needsTopUp(recovery.proposal),
      canPickAlternative: open && Boolean(recovery.proposal?.alternatives?.length),
      canPayDifference: open && options.some(needsTopUp),
      canRefund: ['awaiting_client', 'ops_review', 'awaiting_payment'].includes(recovery.status),
      topUp: recovery.topUp ? { changeRequestId: recovery.topUp.changeRequestId, amountMinor: recovery.topUp.amountMinor } : null };
  }
  return { id: recovery.id, status: recovery.status };
}
