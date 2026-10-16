/** All arithmetic is integer centavos. Round half-up ONCE after summing exact bracket numerators. */
export const DEFAULT_SERVICE_FEE_SCHEDULE = Object.freeze({ version: 2, rounding: 'half_up_once', brackets: Object.freeze([
  Object.freeze({ upToMinor: 200_000, rateBps: 4500 }),
  Object.freeze({ upToMinor: 2_000_000, rateBps: 2500 }),
  Object.freeze({ upToMinor: null, rateBps: 1500 }),
]) });
const fail = (code) => { throw Object.assign(new Error(code), { status: 400, code }); };
const minor = n => { if (!Number.isSafeInteger(n) || n < 0) fail('invalid_money'); return n; };
const bps = n => Number.isInteger(n) && n >= 0 && n <= 10000;
export function validateFeeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) fail('invalid_service_fee_schedule');
  if (schedule.version === 1) {
    if (!bps(schedule.rateBps)) fail('invalid_service_fee_schedule');
    return schedule;
  }
  if (schedule.version !== 2 || schedule.rounding !== 'half_up_once' || !Array.isArray(schedule.brackets)
      || !schedule.brackets.length || schedule.brackets.length > 20) fail('invalid_service_fee_schedule');
  let previous = 0;
  schedule.brackets.forEach((band, index) => {
    if (!band || !bps(band.rateBps) || (index === schedule.brackets.length - 1 ? band.upToMinor !== null
      : !Number.isSafeInteger(band.upToMinor) || band.upToMinor <= previous)) fail('invalid_service_fee_schedule');
    previous = band.upToMinor;
  });
  return schedule;
}
export function feeSchedule(settings, at = new Date().toISOString()) {
  const pending = settings?.scheduledServiceFee;
  const selected = pending && Date.parse(pending.effectiveFrom) <= Date.parse(at) ? pending
    : settings?.serviceFeeSchedule || { version: 1, rateBps: settings?.serviceFeeRateBps ?? 0 };
  return structuredClone(validateFeeSchedule(selected));
}
export function feeSettings(settings, schedule) {
  // A locked snapshot must never consult a later scheduled change.
  return { ...settings, serviceFeeSchedule: schedule, scheduledServiceFee: null,
    ...(schedule.version === 1 ? { serviceFeeRateBps: schedule.rateBps } : {}) };
}
export function serviceFeeMoney(principalMinor, schedule) {
  minor(principalMinor); validateFeeSchedule(schedule);
  const bands = schedule.version === 1 ? [{ upToMinor: null, rateBps: schedule.rateBps }] : schedule.brackets;
  let lower = 0, numerator = 0n, roundedSoFar = 0n;
  const working = bands.map(band => {
    const taxableMinor = Math.max(0, Math.min(principalMinor, band.upToMinor ?? principalMinor) - lower);
    const exact = BigInt(taxableMinor) * BigInt(band.rateBps);
    numerator += exact;
    const cumulative = (numerator + 5000n) / 10000n;
    // Cumulative rounding assigns the fractional remainder without rounding each bracket independently.
    const amountMinor = Number(cumulative - roundedSoFar);
    const result = { fromMinor: lower, upToMinor: band.upToMinor, rateBps: band.rateBps, taxableMinor, amountMinor };
    roundedSoFar = cumulative; lower = band.upToMinor;
    return result;
  });
  const amountMinor = minor(Number(roundedSoFar));
  minor(principalMinor + amountMinor);
  return { grossServiceFeeMinor: amountMinor, serviceFeeSchedule: structuredClone(schedule), serviceFeeWorking: working };
}
export function nextFeeSettings(settings, body, version, at) {
  if (!Object.hasOwn(body, 'serviceFeeBrackets')) {
    if (Object.hasOwn(body, 'serviceFeeEffectiveFrom')) fail('service_fee_brackets_required');
    return {};
  }
  const effectiveFrom = body.serviceFeeEffectiveFrom ?? at;
  if (typeof effectiveFrom !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(effectiveFrom)
      || !Number.isFinite(Date.parse(effectiveFrom)) || Date.parse(effectiveFrom) < Date.parse(at)) fail('invalid_service_fee_effective_from');
  const schedule = validateFeeSchedule({ version: 2, rounding: 'half_up_once',
    brackets: structuredClone(body.serviceFeeBrackets), settingsVersion: version, effectiveFrom: new Date(effectiveFrom).toISOString() });
  return Date.parse(effectiveFrom) > Date.parse(at)
    ? { serviceFeeSchedule: feeSchedule(settings, at), scheduledServiceFee: schedule }
    : { serviceFeeSchedule: schedule, scheduledServiceFee: null };
}
export function serviceFeePreview(settings, body, version, at) {
  const next = nextFeeSettings(settings, body, version + 1, at);
  const proposed = next.scheduledServiceFee || next.serviceFeeSchedule || feeSchedule(settings, at);
  return { version, current: feeSchedule(settings, at), proposed, examples: [50000,199900,200000,500000,2000000,5000000].map(shopPriceMinor => ({
    shopPriceMinor, previous: serviceFeeMoney(shopPriceMinor, feeSchedule(settings, at)), next: serviceFeeMoney(shopPriceMinor, proposed),
  })) };
}
