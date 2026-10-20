import { AvailabilityError, validateShopSchedule, isOpenAt, addOpeningMilliseconds, openingMillisecondsBetween } from './availability.js';

export function defaultOperatingHours() {
  return { timeZone: 'Asia/Manila', schedule: { utcOffsetMinutes: 480,
    week: [1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, opensMinute: 480, closesMinute: 1020 })),
    closures: [] }, artworkReviewMinutes: 60, sameDayReviewMinutes: 30, sameDayPromiseAllowanceMinutes: 120, priorityDispatchCutoffMinute: 960 };
}
export const operatingHours = settings => ({ ...defaultOperatingHours(), ...settings?.operatingHours });

function invalid() {
  throw new AvailabilityError(400, 'invalid_operating_hours', 'Use an Asia/Manila calendar with one daytime window per open day, valid closure dates, a review duration of 1–540 minutes, a same-day promise margin of 0–600 whole working minutes, and a cutoff from 00:00 to 23:59.');
}
const dayValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function validateOperatingHours(value, { requireDispatchWindow = true } = {}) {
  if (!value || value.timeZone !== 'Asia/Manila' || value.schedule?.utcOffsetMinutes !== 480
    || Object.hasOwn(value.schedule, 'extension')
    || !Number.isSafeInteger(value.artworkReviewMinutes) || value.artworkReviewMinutes < 1 || value.artworkReviewMinutes > 540
    || (Object.hasOwn(value, 'sameDayReviewMinutes') && (!Number.isSafeInteger(value.sameDayReviewMinutes) || value.sameDayReviewMinutes < 1 || value.sameDayReviewMinutes > 540))
    || (Object.hasOwn(value, 'sameDayPromiseAllowanceMinutes') && (!Number.isSafeInteger(value.sameDayPromiseAllowanceMinutes) || value.sameDayPromiseAllowanceMinutes < 0 || value.sameDayPromiseAllowanceMinutes > 600))
    || !Number.isSafeInteger(value.priorityDispatchCutoffMinute) || value.priorityDispatchCutoffMinute < 0 || value.priorityDispatchCutoffMinute > 1439
    || !Array.isArray(value.schedule?.week) || value.schedule.week.length > 7
    || new Set(value.schedule.week.map(row => row?.weekday)).size !== value.schedule.week.length
    || !Array.isArray(value.schedule?.closures) || value.schedule.closures.length > 100
    || value.schedule.closures.some(row => !dayValid(row?.startDay) || !dayValid(row?.endDay)
      || row.endDay < row.startDay || Date.parse(row.endDay) - Date.parse(row.startDay) > 90 * 86400000)) invalid();
  try {
    validateShopSchedule(value.schedule);
    if (requireDispatchWindow && !value.schedule.week.some(window => window.opensMinute < value.priorityDispatchCutoffMinute)) invalid();
    // Bound closure coverage so every calendar search can find a window within a year.
    const days = new Set();
    for (const row of value.schedule.closures) {
      for (let at = Date.parse(row.startDay); at <= Date.parse(row.endDay); at += 86400000) days.add(at);
    }
    if (days.size > 90) invalid();
    const probes = ['2000-01-02T00:00:00+08:00', ...value.schedule.closures.map(row => `${row.startDay}T00:00:00+08:00`)];
    for (const from of probes) {
      // A sparse weekly schedule plus closures must still fit a review in the bounded walk.
      addOpeningMilliseconds(value.schedule, from, value.artworkReviewMinutes * 60000);
    }
  } catch { invalid(); }
}

export function reviewTiming(settings, at, { sameDay = false } = {}) {
  const policy = operatingHours(settings);
  const reviewMinutes = sameDay ? policy.sameDayReviewMinutes : policy.artworkReviewMinutes;
  const scheduledReviewAt = addOpeningMilliseconds(policy.schedule, at, 0);
  const reviewCompletesAt = addOpeningMilliseconds(policy.schedule, scheduledReviewAt, reviewMinutes * 60000);
  const withoutClosures = addOpeningMilliseconds({ ...policy.schedule, closures: [] }, at, reviewMinutes * 60000);
  return { timeZone: 'Asia/Manila', isOpenNow: isOpenAt(policy.schedule, at),
    reviewDelayed: Date.parse(reviewCompletesAt) > Date.parse(withoutClosures),
    artworkReviewMinutes: reviewMinutes, scheduledReviewAt,
    reviewCompletesAt };
}

/** Only creation opts in. Never attach this to an existing order on read or migration. */
export function operatingClockSnapshot(settings, settingsVersion) {
  return { version: 1, settingsVersion, schedule: structuredClone(operatingHours(settings).schedule) };
}
export function slaElapsed(clock, from, to) {
  return clock?.version === 1 ? openingMillisecondsBetween(clock.schedule, from, to) : Date.parse(to) - Date.parse(from);
}
export function slaDueAt(clock, from, durationMs) {
  return clock?.version === 1 ? addOpeningMilliseconds(clock.schedule, from, durationMs)
    : new Date(Date.parse(from) + durationMs).toISOString();
}

/** Hours gate only work that begins; a custody step on an assigned trip is marked in the timeline instead. */
export function outsideHoursMark(order, settings, at) {
  return order.operatingClock && !isOpenAt(operatingHours(settings).schedule, at) ? { outsideOperatingHours: true } : {};
}

export function requireOperatingHours(settings, at, activity) {
  const timing = reviewTiming(settings, at);
  if (!timing.isOpenNow) throw new AvailabilityError(409, 'outside_operating_hours',
    `${activity} resumes during operating hours.`, { scheduledReviewAt: timing.scheduledReviewAt });
}

/** Live queue timing is separate from the immutable client promise and SLA calendar. */
export function orderReviewTiming(order, settings, at = new Date().toISOString()) {
  if (order.fileCheck?.status !== 'pending' || !order.operatingClock) return null;
  const requestedAt = order.fileCheck.requestedAt || order.createdAt;
  const timing = reviewTiming(settings, Date.parse(at) > Date.parse(requestedAt) ? at : requestedAt, { sameDay: order.scheduling?.sameDay === true });
  const original = order.reviewSchedule;
  return { ...timing, readyBy: order.promiseBy ?? null,
    status: 'waiting_for_review', label: 'Waiting for review',
    reviewDelayed: Boolean(order.reviewDelayed) || Boolean(original?.reviewDelayed) || timing.reviewDelayed,
    originallyScheduledReviewAt: original?.scheduledReviewAt ?? null,
    outsideHoursNotice: timing.isOpenNow ? null : 'outside_operating_hours' };
}

/** Called inside the audited settings transaction; promises and money never move. */
export function tagDelayedReviews(store, previousSettings, at) {
  const affected = [];
  for (const order of store.orders || []) {
    if (!order.operatingClock || order.fileCheck?.status !== 'pending') continue;
    const from = Date.parse(order.fileCheck.requestedAt) > Date.parse(at) ? order.fileCheck.requestedAt : at;
    const options = { sameDay: order.scheduling?.sameDay === true };
    const before = reviewTiming(previousSettings, from, options), after = reviewTiming(store.settings, from, options);
    if (Date.parse(after.reviewCompletesAt) <= Date.parse(before.reviewCompletesAt)) continue;
    order.reviewDelayed = { at, settingsVersion: store.version, scheduledReviewAt: after.scheduledReviewAt,
      reviewCompletesAt: after.reviewCompletesAt };
    affected.push(order.id);
  }
  return affected;
}

/** Manila date keys and closure reasons shared by calendars and hard deadline checks. */
export const schedulingDay = at => new Date(Date.parse(at) + 480 * 60000).toISOString().slice(0, 10);
export function deadlineDayReason(settings, deadline, now) {
  const day = schedulingDay(deadline), today = schedulingDay(now);
  const policy = operatingHours(settings), weekday = new Date(day).getUTCDay();
  if (policy.schedule.closures.some(row => day >= row.startDay && day <= row.endDay)) return 'gridgo_closed';
  if (!policy.schedule.week.some(row => row.weekday === weekday)) return weekday === 0 ? 'gridgo_closed_sunday' : 'gridgo_closed';
  if (day === today) {
    const minute = (Date.parse(now) - Date.parse(`${today}T00:00:00+08:00`)) / 60000;
    if (minute >= policy.priorityDispatchCutoffMinute) return 'after_dispatch_cutoff';
    if (!isOpenAt(policy.schedule, now)) return 'outside_operating_hours';
  }
  return null;
}

/** The cutoff ends dispatch for the day; it does not invent a second calendar. */
export function dispatchReadyAt(settings, at) {
  const policy = operatingHours(settings);
  let next = addOpeningMilliseconds(policy.schedule, at, 0);
  for (let day = 0; day < 366; day++) {
    const key = schedulingDay(next);
    const cutoff = Date.parse(`${key}T00:00:00+08:00`) + policy.priorityDispatchCutoffMinute * 60000;
    if (Date.parse(next) < cutoff) return next;
    next = addOpeningMilliseconds(policy.schedule, new Date(Date.parse(`${key}T00:00:00+08:00`) + 86400000).toISOString(), 0);
  }
  throw new AvailabilityError(409, 'dispatch_unavailable', 'No GRIDGO opening precedes the dispatch cutoff.');
}
