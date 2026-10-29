import { matchTesterInvites, testerInviteNeedsReconciliation } from './tester-invites.js';
import { reconcilePromotionInvites } from './promotions.js';
import { recordTesterCartStep, foundingTesterNeedsReconciliation } from './founding-testers.js';

/** A conservative probe, under the same domain lock as the actual reconciliation.
 * Invitation policies run on a disposable copy; no speculative audit, notification
 * or random identifier reaches persistence. Rewards use their real entry guards.
 */
export function testerBootstrapNeedsWrite(store, clientId, { at }) {
  const probe = structuredClone(store);
  let sequence = 0;
  const ctx = { at, id: prefix => `${prefix}_bootstrap_probe_${++sequence}` };
  if (matchTesterInvites(probe, ctx)) return true;
  if (reconcilePromotionInvites(probe, ctx)) return true;
  if (recordTesterCartStep(probe, clientId, at)) return true;
  return foundingTesterNeedsReconciliation(probe, clientId)
    || testerInviteNeedsReconciliation(probe, clientId);
}
