import { reportOrderAllowed } from './review-data.js';
const DAY = 86400000;
export const PERFORMANCE_GRACE_MS = 3600000;
export const performanceEnabled = (store, at) => Boolean(store?.supplierPerformanceLaunchedAt
  && Date.parse(at) >= Date.parse(store.supplierPerformanceLaunchedAt));
export function performanceTier(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= PERFORMANCE_GRACE_MS) return null;
  return elapsedMs > 24 * 3600000 ? 'severe' : elapsedMs > 6 * 3600000 ? 'moderate' : 'minor';
}
export const performanceExemption = (store, row) => (store.supplierPerformanceEvents || []).find(event =>
  event.kind === 'no_fault' && event.orderId === row.orderId && event.supplierId === row.supplierId) || null;
const emptyCounts = () => ({ declines: 0, timeouts: 0, lateFinishes: 0, cancellations: 0, arrivedPacked: 0 });
const COUNT_KEY = { declined: 'declines', timed_out: 'timeouts', late_finish: 'lateFinishes', cancelled: 'cancellations', arrived_packed: 'arrivedPacked' };
export function performanceCounts(store, supplierId, at) {
  const end = Date.parse(at), start = end - 30 * DAY;
  const counts = emptyCounts();
  for (const event of store.supplierPerformanceEvents || []) {
    if (!reportOrderAllowed(store, event.orderId) || event.supplierId !== supplierId || Date.parse(event.at) <= start || Date.parse(event.at) > end
        || event.exemption || performanceExemption(store, event)) continue;
    const key = COUNT_KEY[event.kind];
    if (key) counts[key]++;
  }
  return counts;
}
export function consequences(kind, counts) {
  const warnings = [];
  if (kind === 'declined' && counts.declines >= 3) warnings.push('repeated_declines');
  if (kind === 'timed_out' && counts.timeouts >= 2) warnings.push('repeated_timeouts');
  if (kind === 'late_finish') warnings.push('late_finish');
  if (kind === 'cancelled' && counts.cancellations >= 1) warnings.push('accepted_order_cancelled');
  if (kind === 'arrived_packed' && counts.arrivedPacked >= 2) warnings.push('repeated_arrived_packed');
  return { warnings,
    hideTopPick: (kind === 'timed_out' && counts.timeouts >= 3) || (kind === 'late_finish' && counts.lateFinishes >= 2),
    rosterReview: (kind === 'late_finish' && counts.lateFinishes >= 3) || (kind === 'cancelled' && counts.cancellations >= 2) };
}
/** Replay incident-time windows: an old count alone cannot restart a seven-day demotion. */
export function performanceTopPick(store, supplierId, at) {
  const end = Date.parse(at);
  let hiddenUntil = null;
  for (const event of store.supplierPerformanceEvents || []) {
    if (!reportOrderAllowed(store, event.orderId) || event.supplierId !== supplierId || !['late_finish', 'timed_out'].includes(event.kind)
        || event.exemption || performanceExemption(store, event) || Date.parse(event.at) > end
        || Date.parse(event.at) + 7 * DAY <= end) continue;
    if (consequences(event.kind, performanceCounts(store, supplierId, event.at)).hideTopPick) {
      const until = new Date(Date.parse(event.at) + 7 * DAY).toISOString();
      if (!hiddenUntil || until > hiddenUntil) hiddenUntil = until;
    }
  }
  return { hidden: Boolean(hiddenUntil), hiddenUntil, allHiddenFallback: true };
}

/** A request made after the commitment cannot erase that missed commitment. */
export function performanceDeadline(order) {
  const request = order.rescheduleRequest;
  if (request?.status === 'accepted' && request.supplierId === order.supplierId
      && Date.parse(request.requestedAt) >= Date.parse(request.originalReadyBy)) return request.originalReadyBy;
  return order.readyBy;
}
