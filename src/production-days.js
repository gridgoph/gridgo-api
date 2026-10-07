import { AvailabilityError, defaultShopSchedule, validateShopSchedule } from './availability.js';

/** Split shifts count together. A variable-length week needs an explicit policy. */
export function productionDayMinutes(schedule = defaultShopSchedule()) {
  validateShopSchedule(schedule);
  const totals = new Map();
  for (const row of schedule.week) totals.set(row.weekday, (totals.get(row.weekday) || 0) + row.closesMinute - row.opensMinute);
  const lengths = new Set(totals.values());
  if (lengths.size !== 1) throw new AvailabilityError(409, 'production_day_length_unavailable', 'The shop needs a consistent working-day length before production days can be set.');
  return [...lengths][0];
}

export function shopProductionDayMinutes(store, supplierId) {
  return productionDayMinutes((store.supplierProfiles || []).find(row => row.userId === supplierId)?.schedule || undefined);
}

export function hoursToDays(hours, minutes = 600) {
  return hours == null ? null : Math.max(1, Math.ceil(hours * 60 / minutes));
}

/** Days own new writes; hour-only builds keep working through this adapter. */
export function productionDuration(body, current, prefix, minutes, errorCode = "invalid_catalog_item") {
  const daysKey = `${prefix}Days`, hoursKey = `${prefix}Hours`;
  let days = current[daysKey] ?? hoursToDays(current[hoursKey], minutes);
  const field = Object.hasOwn(body, daysKey) ? daysKey : Object.hasOwn(body, hoursKey) ? hoursKey : null;
  if (field) {
    const value = body[field];
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (field === daysKey && !Number.isSafeInteger(value)))) {
      throw new AvailabilityError(400, errorCode, `${field} must be a whole number, at least 1.`, { field });
    }
    days = field === daysKey ? value : hoursToDays(value, minutes);
  }
  const hours = days == null ? null : days * minutes / 60;
  if (days != null && (!Number.isSafeInteger(days * minutes) || days * minutes > 2_147_483_647)) {
    throw new AvailabilityError(400, errorCode, 'Production time is too large.', { field: daysKey });
  }
  return { [daysKey]: days ?? null, [hoursKey]: hours };
}

export function productionProjection(record, minutes, prefixes = ['turnaround', 'minimumTurnaround']) {
  return Object.assign({ productionDayMinutes: minutes }, ...prefixes.map(prefix => ({
    [`${prefix}Days`]: record[`${prefix}Days`] ?? (minutes == null ? null : hoursToDays(record[`${prefix}Hours`], minutes)),
  })));
}

/** Keep the hour compatibility view synchronized after loading canonical days. */
export function synchronizeProductionHours(store, { convertLegacy = false } = {}) {
  const apply = (record, minutes, prefixes) => {
    if (minutes == null) return;
    for (const prefix of prefixes) {
      const days = `${prefix}Days`, hours = `${prefix}Hours`;
      if (record[days] == null && convertLegacy && record[hours] != null) record[days] = hoursToDays(record[hours], minutes);
      if (record[days] != null) record[hours] = record[days] * minutes / 60;
    }
  };
  const dayMinutes = convertLegacy ? shopProductionDayMinutes : displayProductionDayMinutes;
  for (const service of store.supplierServices || []) apply(service, dayMinutes(store, service.supplierId), ['turnaround', 'standardTurnaround', 'rushTurnaround']);
  for (const item of store.catalogItems || []) {
    const minutes = dayMinutes(store, item.supplierId);
    apply(item, minutes, ['turnaround', 'minimumTurnaround']);
    if (item.approvedSnapshot) {
      apply(item.approvedSnapshot.item, minutes, ['turnaround', 'minimumTurnaround']);
      for (const tier of item.approvedSnapshot.catalogSpeedTiers || []) apply(tier, minutes, ['turnaround']);
    }
  }
  for (const tier of store.catalogSpeedTiers || []) {
    const item = (store.catalogItems || []).find(item => item.id === tier.catalogItemId);
    apply(tier, dayMinutes(store, item?.supplierId), ['turnaround']);
  }
  for (const starter of store.listingStarters || []) apply(starter, 600, ['defaultTurnaround']);
  for (const line of store.orderLineItems || []) {
    if (line.turnaroundDaysSnapshot != null && line.productionDayMinutesSnapshot != null) {
      line.turnaroundHoursSnapshot = line.turnaroundDaysSnapshot * line.productionDayMinutesSnapshot / 60;
    }
  }
  for (const job of store.orderJobs || []) {
    if (job.estimatedProductionMinutes != null) job.estimatedHours = job.estimatedProductionMinutes / 60;
  }
  return store;
}

/** An unavailable calendar may still be displayed; scheduling and writes stay strict. */
export function displayProductionDayMinutes(store, supplierId) {
  try { return shopProductionDayMinutes(store, supplierId); }
  catch (error) { if (error instanceof AvailabilityError) return null; throw error; }
}
