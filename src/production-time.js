import { AvailabilityError } from './availability.js';
import { displayProductionDayMinutes, productionProjection } from './production-days.js';

export const PRODUCTION_TIME_FIELDS = ['turnaroundMode', 'turnaroundDays', 'turnaroundMinutes', 'turnaroundHours',
  'minimumTurnaroundDays', 'minimumTurnaroundMinutes', 'minimumTurnaroundHours'];
const invalid = () => { throw new AvailabilityError(400, 'invalid_production_time', 'Choose exact hours or a whole working-day range.', { field: 'productionTime' }); };

/** The editor is an adapter onto the published duration fields, never another scheduler. */
export function productionTimeFields(choice, dayMinutes) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) invalid();
  let minimum, maximum, minDays = null, maxDays = null;
  if (choice.mode === 'same_day') {
    if (Object.keys(choice).some(key => !['mode', 'hours'].includes(key)) || typeof choice.hours !== 'number') invalid();
    // API reads divide canonical integer minutes by 60. Multiplying a returned
    // value (e.g. 31 / 60) can introduce a fractional floating-point residue.
    // Accept exactly that round trip, without rounding actual fractional minutes.
    minimum = maximum = Math.round(choice.hours * 60);
    if (choice.hours !== maximum / 60) invalid();
  } else if (choice.mode === 'days') {
    if (Object.keys(choice).some(key => !['mode', 'minDays', 'maxDays'].includes(key))
      || !Number.isSafeInteger(choice.minDays) || !Number.isSafeInteger(choice.maxDays)
      || choice.minDays < 1 || choice.minDays > choice.maxDays) invalid();
    minDays = choice.minDays; maxDays = choice.maxDays;
    minimum = minDays * dayMinutes; maximum = maxDays * dayMinutes;
  } else invalid();
  if (![minimum, maximum].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) invalid();
  return { turnaroundMode: 'override', turnaroundDays: maxDays, turnaroundMinutes: maximum, turnaroundHours: maximum / 60,
    minimumTurnaroundDays: minDays, minimumTurnaroundMinutes: minimum, minimumTurnaroundHours: minimum / 60 };
}

export function expandProductionTimeBody(body, dayMinutes) {
  if (!Object.hasOwn(body, 'productionTime')) return body;
  if ([...PRODUCTION_TIME_FIELDS, 'express'].some(key => Object.hasOwn(body, key))) invalid();
  return { ...body, ...productionTimeFields(body.productionTime, dayMinutes), express: false };
}

export function effectiveProductionTime(store, item) {
  const service = (store.supplierServices || []).find(row => row.id === item.supplierServiceId) || {};
  const inherited = service.standardTurnaroundHours != null || service.standardTurnaroundMinutes != null || service.standardTurnaroundDays != null;
  const prefix = inherited ? 'standardTurnaround' : 'turnaround';
  const source = item.turnaroundMode === 'override' ? item : {
    ...item, turnaroundDays: service[`${prefix}Days`], turnaroundMinutes: service[`${prefix}Minutes`], turnaroundHours: service[`${prefix}Hours`],
  };
  const projected = productionProjection(source, displayProductionDayMinutes(store, item.supplierId));
  const maximum = projected.turnaroundMinutes;
  const minimum = projected.minimumTurnaroundMinutes ?? maximum;
  const maxDays = projected.turnaroundDays;
  const minDays = projected.minimumTurnaroundDays ?? (minimum === maximum ? maxDays : null);
  let choice = null;
  if (Number.isSafeInteger(maximum) && maximum > 0) {
    if (maxDays != null && minDays != null) choice = { mode: 'days', minDays, maxDays };
    else if (maxDays == null) choice = { mode: 'same_day', hours: maximum / 60 };
  }
  return { choice, maximum, minimum };
}

export function productionTimeReview(store, item) {
  const reasons = new Set(item.productionTimeReviewReasons || []);
  if (item.express && !(effectiveProductionTime(store, item).maximum > 0)) reasons.add('express_missing_hours');
  return { required: reasons.size > 0, reasons: [...reasons], message: reasons.size ? 'Check your production time' : null };
}

export function clearProductionTimeReview(store, item, body) {
  if ((Object.hasOwn(body, 'productionTime') || PRODUCTION_TIME_FIELDS.some(key => Object.hasOwn(body, key)))
      && effectiveProductionTime(store, item).maximum > 0) item.productionTimeReviewReasons = [];
}

export function productionTimeAudit(item) {
  return Object.fromEntries([...PRODUCTION_TIME_FIELDS, 'express', 'productionTimeReviewReasons'].map(key => [key, structuredClone(item[key] ?? null)]));
}
