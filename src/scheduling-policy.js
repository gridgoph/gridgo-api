/** Pilot exemptions never alter a promised date or reverse an applied deduction. */
export function schedulingWarningOnly(order, store = null) {
  if (order.express === true || order.scheduling?.sameDay || order.scheduling?.tightDeadline) return true;
  const lines = (store?.orderLineItems || []).filter(line => line.orderId === order.id);
  return lines.length > 0 && lines.every(line => {
    const minutes = line.turnaroundMinutesSnapshot ?? line.turnaroundHoursSnapshot * 60;
    return line.turnaroundDaysSnapshot == null && minutes > 0 && minutes < (line.productionDayMinutesSnapshot ?? 600);
  });
}
export const tightDeclineExemption = (order, kind, reason) =>
  order.scheduling?.tightDeadline && kind === 'declined' && typeof reason === 'string' && reason.trim()
    ? 'tight_deadline_pilot' : null;
