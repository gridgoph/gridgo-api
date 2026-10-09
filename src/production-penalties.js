import { slaElapsed } from './operating-hours.js';
import { rescheduleHold } from './order-reschedule-policy.js';
import { formatMinorPhp } from './payout-copy.js';
import { refundHold, refundSettlementFor } from './refund-policy.js';
import { privilegedAdminMemberships, queueOrderInvalidate } from './notifications.js';
import { writeDraft } from './client-order-notifications.js';

const TIERS = ['minor', 'moderate', 'severe'];
const WATCHED = new Set(['payment_authorized', 'production', 'supplier_self_qc']);
export const defaultProductionPenalty = () => ({ deductionsEnabled: false, minorBps: 500, moderateBps: 1500, severeBps: 3000 });
export const productionPenaltySettings = (settings) => ({ ...defaultProductionPenalty(), ...settings?.productionPenalty });

export function validateProductionPenalty(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || typeof policy.deductionsEnabled !== 'boolean'
      || TIERS.some((tier) => !Number.isInteger(policy[`${tier}Bps`]) || policy[`${tier}Bps`] < 0 || policy[`${tier}Bps`] > 10000)
      || policy.minorBps > policy.moderateBps || policy.moderateBps > policy.severeBps) {
    throw Object.assign(new Error('Use an enabled boolean and increasing integer rates from 0 to 10,000 basis points.'),
      { status: 400, code: 'invalid_production_penalty' });
  }
}

/** Only client acceptance changes readyBy; pending/expired requests retain the original deadline. */
export function productionDeadline(order) { return order.readyBy || null; }

export function latenessTier(deadlineAt, finishedAt, noCommunication = false, clock = null) {
  const late = !deadlineAt || !finishedAt ? NaN : slaElapsed(clock, deadlineAt, finishedAt);
  if (!Number.isFinite(late) || late <= 0) return null;
  return noCommunication || late > 24 * 3600000 ? 'severe' : late > 6 * 3600000 ? 'moderate' : 'minor';
}

export function cappedPenaltyMinor(remainingMinor, rateBps) {
  if (!Number.isSafeInteger(remainingMinor) || remainingMinor < 0 || !Number.isInteger(rateBps) || rateBps < 0) {
    throw new RangeError('Penalty amounts require non-negative safe integer minor units and integer basis points');
  }
  const amount = (BigInt(remainingMinor) * BigInt(rateBps) + 5000n) / 10000n;
  return Number(amount > BigInt(remainingMinor) ? BigInt(remainingMinor) : amount);
}

export function orderPenaltyMinor(order) {
  return (order.payoutMilestones || []).reduce((sum, stage) => sum + (stage.productionDeductionMinor || 0), 0);
}

export function recentLapseQualityPenalty(store, supplierId, at) {
  const end = Date.parse(at), start = end - 30 * 86400000;
  // Two quality points per late order in 30 days, capped at ten of 100.
  // Client priority remains lexicographic; this is not a weighted match score.
  const count = (store.productionLapses || []).filter((lapse) => lapse.supplierId === supplierId
    && Date.parse(lapse.deadlineAt) >= start && Date.parse(lapse.deadlineAt) <= end).length;
  return Math.min(10, count * 2);
}

function warningText(lapse) {
  return `This order missed its ready-by deadline of ${lapse.deadlineAt}. This is ${lapse.tier} lateness. `
    + `The penalty is ${lapse.rateBps / 100}% of what GRIDGO still owes your shop on this order, capped at that balance. Nothing carries over to another order. `
    + (lapse.tier === 'moderate' ? 'A formal warning has been added to your shop record. ' : '')
    + (lapse.tier === 'severe' ? 'This order is eligible for Operations to review reassignment. ' : '')
    + 'Recent late orders lower your quality ranking in matching. '
    + (lapse.policy.deductionsEnabled ? 'This warning is recorded before any deduction. ' : 'Deductions are off for this lapse; this is a warning only. ')
    + 'Update the job and contact Operations if the deadline or circumstances need review.';
}

function recordEvent(store, order, lapse, kind, at, createId) {
  const body = kind === 'warning' ? warningText(lapse)
    : `A late-production deduction of ${formatMinorPhp(lapse.deductionMinor)} was applied to this order's unpaid shop payout. Nothing carries over to another order.`;
  if (kind === 'warning') lapse.warnings.push({ tier: lapse.tier, at, message: body, formal: lapse.tier !== 'minor' });
  store.auditLog.push({ id: createId('aud'), at, actorId: null, actorRole: 'system', action: `production_lapse.${kind}`,
    entityType: 'order', entityId: order.id, orderId: order.id,
    detail: { lapseId: lapse.id, tier: lapse.tier, deductionMinor: lapse.deductionMinor }, reason: null });
  const recipients = [{ userId: lapse.supplierId, role: 'supplier' }, ...privilegedAdminMemberships(store)];
  for (const recipient of recipients) writeDraft(store, {
    userId: recipient.userId, appRole: recipient.role, type: `production_lapse_${kind}`,
    occurrenceKey: `${lapse.id}:${kind}:${lapse.tier}`, orderId: order.id,
    title: kind === 'warning' ? 'Late production warning' : 'Late production deduction', body, read: false,
  }, { id: createId('ntf'), at });
  queueOrderInvalidate(store, order, ['orders', 'payouts']);
}

/** Call under the domain transaction lock; save records, audits and outbox together. */
export function assessProductionLapses(store, { at, createId, orderId = null }) {
  store.productionLapses ||= [];
  let changed = false;
  for (const order of store.orders || []) {
    if (orderId && order.id !== orderId) continue;
    if (order.shopRecovery && order.shopRecovery.status !== 'accepted') continue;
    if (!order.supplierId || !order.commercialCommittedAt || !productionDeadline(order)) continue;
    let lapse = store.productionLapses.find((row) => row.orderId === order.id && row.supplierId === order.supplierId);
    if (lapse && (lapse.appliedAt || lapse.closedAt)) continue;
    if (refundSettlementFor(store, order) || order.state === 'cancelled') {
      if (lapse) { lapse.closedAt = at; changed = true; }
      continue;
    }
    if (!order.readyAt && !WATCHED.has(order.state)) continue;
    const tier = latenessTier(productionDeadline(order), order.readyAt || at, Boolean(order.productionNoCommunication), order.operatingClock);
    if (!tier) continue;
    if (!lapse) {
      const policy = productionPenaltySettings(store.settings);
      lapse = { id: createId('lapse'), orderId: order.id, supplierId: order.supplierId,
        deadlineAt: productionDeadline(order), detectedAt: at, tier, rateBps: policy[`${tier}Bps`],
        policy, settingsVersion: store.version, warnings: [], deductionMinor: 0, remainingBalanceMinor: 0,
        appliedAt: null, closedAt: null };
      store.productionLapses.push(lapse);
    }
    const nextTier = TIERS.indexOf(tier) > TIERS.indexOf(lapse.tier) ? tier : lapse.tier;
    const needsWarning = lapse.warnings.length === 0 || nextTier !== lapse.tier;
    lapse.tier = nextTier;
    lapse.rateBps = lapse.policy[`${nextTier}Bps`];
    if (nextTier === 'severe') order.productionReassignmentEligible = true;
    if (needsWarning) {
      recordEvent(store, order, lapse, 'warning', at, createId);
      changed = true;
      continue; // A warning must commit before this tier can deduct.
    }
    if (!lapse.policy.deductionsEnabled || !productionPenaltySettings(store.settings).deductionsEnabled) continue;
    if (!order.readyAt && lapse.tier !== 'severe') continue;
    if (Date.parse(at) <= Date.parse(lapse.warnings.at(-1).at)) continue;
    if (refundHold(store, order) || rescheduleHold(order) || order.payoutHold || (store.claims || []).some((claim) => claim.orderId === order.id
      && ['open', 'payout_held'].includes(claim.status))) continue;
    const unpaid = (order.payoutMilestones || []).filter((stage) => !['released', 'superseded'].includes(stage.status));
    const remaining = unpaid.reduce((sum, stage) => sum + BigInt(stage.amountMinor), 0n);
    if (remaining > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Remaining payout exceeds safe integer minor units');
    lapse.remainingBalanceMinor = Number(remaining);
    lapse.deductionMinor = cappedPenaltyMinor(lapse.remainingBalanceMinor, lapse.rateBps);
    let left = lapse.deductionMinor;
    // Take from the last unpaid stages first, leaving already released money intact.
    for (const stage of [...unpaid].reverse()) {
      const deduction = Math.min(left, stage.amountMinor);
      stage.productionDeductionMinor = (stage.productionDeductionMinor || 0) + deduction;
      stage.amountMinor -= deduction;
      left -= deduction;
    }
    lapse.appliedAt = at;
    order.updatedAt = at;
    recordEvent(store, order, lapse, 'deduction', at, createId);
    changed = true;
  }
  return changed;
}

export function supplierLapses(store, supplierId) {
  return (store.productionLapses || []).filter((lapse) => lapse.supplierId === supplierId)
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)).map((lapse) => ({ ...lapse,
      reassignmentEligible: lapse.tier === 'severe',
      status: lapse.appliedAt ? 'applied' : lapse.closedAt ? 'closed' : lapse.policy.deductionsEnabled ? 'warned' : 'warning_only',
    }));
}
