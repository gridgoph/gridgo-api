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

/** Explicit days retain their calendar meaning; legacy hours are never rounded. */
export function productionDuration(body, current, prefix, minutes, errorCode = "invalid_catalog_item") {
  const daysKey = `${prefix}Days`, hoursKey = `${prefix}Hours`, minutesKey = `${prefix}Minutes`;
  const field = Object.hasOwn(body, daysKey) && body[daysKey] != null ? daysKey
    : Object.hasOwn(body, minutesKey) ? minutesKey
    : Object.hasOwn(body, daysKey) ? daysKey : Object.hasOwn(body, hoursKey) ? hoursKey : null;
  let days = current[daysKey] ?? null;
  let duration = days != null ? days * minutes : current[minutesKey] ?? (current[hoursKey] == null ? null : current[hoursKey] * 60);
  if (field) {
    const value = body[field];
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
        || (field !== hoursKey && !Number.isSafeInteger(value))
        || (field === minutesKey && value >= minutes))) {
      throw new AvailabilityError(400, errorCode, 'Use positive whole days or integer same-day production minutes.', { field });
    }
    days = field === daysKey ? value : null;
    duration = value == null ? null : field === daysKey ? value * minutes : field === hoursKey ? value * 60 : value;
  }
  if (duration != null && (!Number.isSafeInteger(duration) || duration <= 0 || duration > 2_147_483_647)) {
    throw new AvailabilityError(400, errorCode, 'Production time must fit positive integer minutes.', { field: field || minutesKey });
  }
  return { [daysKey]: days ?? null, [minutesKey]: duration, [hoursKey]: duration == null ? null : duration / 60 };
}

export function productionProjection(record, minutes, prefixes = ['turnaround', 'minimumTurnaround']) {
  return Object.assign({ productionDayMinutes: minutes }, ...prefixes.map(prefix => {
    const days = record[`${prefix}Days`] ?? null;
    const duration = days != null && minutes != null ? days * minutes
      : record[`${prefix}Minutes`] ?? (record[`${prefix}Hours`] == null ? null : record[`${prefix}Hours`] * 60);
    return { [`${prefix}Days`]: days, [`${prefix}Minutes`]: duration,
      [`${prefix}Hours`]: duration == null ? null : duration / 60 };
  }));
}

/** Keep the hour compatibility view synchronized after loading canonical days or minutes. */
export function synchronizeProductionHours(store, { convertLegacy = false } = {}) {
  const apply = (record, minutes, prefixes) => {
    for (const prefix of prefixes) {
      const days = `${prefix}Days`, hours = `${prefix}Hours`, exact = `${prefix}Minutes`;
      if (record[days] != null && minutes != null) record[exact] = record[days] * minutes;
      else if (convertLegacy && record[exact] == null && record[hours] != null) record[exact] = record[hours] * 60;
      if (record[exact] != null) record[hours] = record[exact] / 60;
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
    if (line.turnaroundMinutesSnapshot != null) {
      line.turnaroundHoursSnapshot = line.turnaroundMinutesSnapshot / 60;
    } else if (line.turnaroundDaysSnapshot != null && line.productionDayMinutesSnapshot != null) {
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
