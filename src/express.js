/**
 * Express: a shop's promise that a listing can be had the same day.
 *
 * A shop switches Express on per listing. While it is on, the listing is not
 * held back by its own production time, its queue, its daily capacity, its
 * opening hours or GRIDGO's review hours: it can meet any deadline from today
 * on. Contract: docs/EXPRESS_API.md.
 *
 * Express never makes a promise earlier than the shop's ordinary one. When the
 * ordinary projection already meets the deadline it stands unchanged; Express
 * only answers the deadlines the ordinary projection would miss. Work with no
 * deadline is projected as usual.
 *
 * Two things still hold an Express listing back, because they are the shop
 * saying it is not working at all: a temporary closure (the shop is excluded
 * from matching before this is reached) and dated closures. A deadline whose
 * every day from today on is a dated closure is not Express-reachable.
 */
import { defaultShopSchedule } from "./availability.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
/** The same bound the availability walk uses: a year of closures is a data fault. */
const MAX_CLOSURE_DAYS = 366;

/** Whether a listing record carries the shop's Express switch. */
export function listingExpress(item) {
  return item?.express === true;
}

function scheduleFor(store, supplierId) {
  return (store.supplierProfiles || []).find((row) => row.userId === supplierId)?.schedule || defaultShopSchedule();
}

function offsetOf(schedule) {
  return Number.isInteger(schedule?.utcOffsetMinutes) ? schedule.utcOffsetMinutes : 480;
}

/** The shop's own calendar day of an instant. */
export function localDayKey(timeMs, offsetMinutes) {
  return new Date(timeMs + offsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 10);
}

function nextDayKey(dayKey) {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

function closedOn(schedule, dayKey) {
  return (schedule.closures || []).some((closure) => dayKey >= closure.startDay && dayKey <= closure.endDay);
}

/** The last millisecond of a shop-local day. */
export function endOfLocalDay(dayKey, offsetMinutes) {
  return Date.parse(`${dayKey}T00:00:00.000Z`) + MS_PER_DAY - offsetMinutes * MS_PER_MINUTE - 1;
}

/**
 * The first shop-local day, from today, the shop is not shut by a dated
 * closure. Null when it is shut for longer than a year.
 */
export function firstExpressDay(store, supplierId, now) {
  const schedule = scheduleFor(store, supplierId);
  let dayKey = localDayKey(Date.parse(now), offsetOf(schedule));
  for (let day = 0; day < MAX_CLOSURE_DAYS; day += 1) {
    if (!closedOn(schedule, dayKey)) return dayKey;
    dayKey = nextDayKey(dayKey);
  }
  return null;
}

/**
 * The Express promise for one deadline, or null when Express cannot answer it.
 *
 * The shop has until the requested deadline. When the deadline's day is today
 * but its clock time has already passed (the client app sends 18:00), the shop
 * has until the end of today instead: Express is offered the whole day long.
 */
export function expressTarget(store, { supplierId, deadline, now }) {
  if (deadline == null) return null;
  const deadlineMs = Date.parse(deadline);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return null;
  const offset = offsetOf(scheduleFor(store, supplierId));
  const deadlineDay = localDayKey(deadlineMs, offset);
  const firstDay = firstExpressDay(store, supplierId, now);
  if (firstDay == null || deadlineDay < firstDay) return null;
  const target = deadlineMs > nowMs ? deadlineMs : endOfLocalDay(deadlineDay, offset);
  return { deadline: new Date(deadlineMs).toISOString(), readyBy: new Date(target).toISOString() };
}

/**
 * Apply Express to an ordinary projection.
 *
 * The ordinary projection stands when it already meets the deadline (or there
 * is none). Otherwise the shop's date and the client's date are both the
 * Express target: no allowance, no review wait. `expressDeadline` records the
 * deadline the promise was made for, so `fitsDeadline` accepts it even when
 * the end-of-today rule put the date after a deadline that had already passed.
 */
export function withExpress(store, projection, { supplierId, deadline, now, express }) {
  if (!express || deadline == null) return projection;
  if (Date.parse(projection.promiseBy) <= Date.parse(deadline)) return projection;
  const target = expressTarget(store, { supplierId, deadline, now });
  if (!target) return projection;
  return {
    ...projection,
    readyBy: target.readyBy,
    promiseBy: target.readyBy,
    limitedBy: "express",
    express: true,
    expressDeadline: target.deadline,
  };
}
