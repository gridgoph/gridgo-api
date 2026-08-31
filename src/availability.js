/**
 * When a shop can actually finish a job.
 *
 * Everything about the deadline rests here. Matching filters on it, the client
 * is promised against it, the shop is judged against it, and Operations sorts
 * its day by it -- so it has to count time the way a print shop does, not the
 * way a clock does. Twenty working hours starting Friday afternoon is Tuesday
 * lunchtime at a shop that closes weekends, and any engine that answers
 * "Saturday" has promised something nobody agreed to.
 *
 * That was not possible before this module: shop closures lived only on the
 * supplier's own phone (`gridgo-supplier/lib/blackouts.ts` says so outright),
 * so the platform had no idea a shop was shut. Hours and closures move here.
 *
 * Two dates come out of this file and they are deliberately different:
 *
 *   readyBy  -- what the shop's own board promised. The shop sees this, and its
 *               on-time record is measured against it.
 *   promiseBy -- readyBy plus the platform's allowance. The client sees this.
 *
 * The gap is GRIDGO's insurance and stays GRIDGO's. A shop shown the padded
 * date works to the padded date, and the allowance is spent before the job
 * starts.
 *
 * The Philippines does not observe daylight saving, so a fixed UTC offset is
 * correct here rather than a lazy simplification. It is stored per schedule
 * anyway, so a second city does not need this file rewritten.
 */

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
/** A shop shut for a year is a data fault, not a long wait. Bound every walk. */
const MAX_WALK_DAYS = 366;

export class AvailabilityError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "AvailabilityError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details = {}) {
  throw new AvailabilityError(status, code, message, details);
}

/**
 * Mon-Sat 08:00-18:00, closed Sunday.
 *
 * Every shop already on the platform gets this on migrate and is prompted to
 * correct it. A shop with no schedule at all cannot be scheduled against, and
 * silently treating that as "open always" is how a Sunday promise gets made.
 */
export function defaultShopSchedule() {
  return {
    utcOffsetMinutes: 480,
    week: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensMinute: 8 * 60,
      closesMinute: 18 * 60,
    })),
    closures: [],
  };
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function validateShopSchedule(schedule) {
  const offset = schedule?.utcOffsetMinutes;
  if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
    fail(400, "invalid_schedule", "Set the shop's time offset to a whole number of minutes from UTC.", {
      field: "utcOffsetMinutes",
    });
  }
  const week = schedule?.week;
  if (!Array.isArray(week) || week.length === 0) {
    fail(400, "invalid_schedule", "Set at least one day this shop is open.", { field: "week" });
  }
  const byWeekday = new Map();
  for (const [index, window] of week.entries()) {
    const { weekday, opensMinute, closesMinute } = window || {};
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      fail(400, "invalid_schedule", `week[${index}].weekday must be 0 (Sunday) through 6 (Saturday).`, {
        field: `week[${index}].weekday`,
      });
    }
    for (const [name, value] of [["opensMinute", opensMinute], ["closesMinute", closesMinute]]) {
      if (!Number.isInteger(value) || value < 0 || value > MINUTES_PER_DAY) {
        fail(400, "invalid_schedule", `week[${index}].${name} must be a whole number of minutes past midnight.`, {
          field: `week[${index}].${name}`,
        });
      }
    }
    if (closesMinute <= opensMinute) {
      fail(400, "invalid_schedule", "A shop's closing time must be later than its opening time.", {
        field: `week[${index}].closesMinute`,
      });
    }
    const existing = byWeekday.get(weekday) || [];
    for (const other of existing) {
      if (opensMinute < other.closesMinute && other.opensMinute < closesMinute) {
        fail(400, "invalid_schedule", "Two opening hours on the same day overlap.", {
          field: `week[${index}]`,
        });
      }
    }
    existing.push({ opensMinute, closesMinute });
    byWeekday.set(weekday, existing);
  }
  for (const [index, closure] of (schedule?.closures || []).entries()) {
    if (!DAY_KEY.test(closure?.startDay || "") || !DAY_KEY.test(closure?.endDay || "")) {
      fail(400, "invalid_schedule", `closures[${index}] needs a start and end day as YYYY-MM-DD.`, {
        field: `closures[${index}]`,
      });
    }
    if (closure.endDay < closure.startDay) {
      fail(400, "invalid_schedule", "A closure cannot end before it starts.", { field: `closures[${index}]` });
    }
  }
  return true;
}

function instantOf(value, field) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(time)) {
    fail(400, "invalid_instant", `${field} must be a valid date and time.`, { field });
  }
  return time;
}

/** The shop's own calendar day and clock, from an absolute instant. */
function localOf(timeMs, offsetMinutes) {
  const shifted = new Date(timeMs + offsetMinutes * MS_PER_MINUTE);
  return {
    dayKey: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function instantAt(dayKey, minuteOfDay, offsetMinutes) {
  return Date.parse(`${dayKey}T00:00:00.000Z`) + (minuteOfDay - offsetMinutes) * MS_PER_MINUTE;
}

function nextDayKey(dayKey) {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + MINUTES_PER_DAY * MS_PER_MINUTE)
    .toISOString().slice(0, 10);
}

function isClosed(schedule, dayKey) {
  return (schedule.closures || []).some(
    (closure) => dayKey >= closure.startDay && dayKey <= closure.endDay,
  );
}

/** Opening hours for one calendar day, earliest first. Empty when shut. */
function windowsOn(schedule, dayKey, weekday) {
  if (isClosed(schedule, dayKey)) return [];
  return (schedule.week || [])
    .filter((window) => window.weekday === weekday)
    .sort((left, right) => left.opensMinute - right.opensMinute);
}

/**
 * Walk forward through the shop's open hours, handing each one to `consume`.
 *
 * Every other function here is this walk with a different stopping condition,
 * which is why it exists once: a shop's calendar is fiddly enough that three
 * copies of it would disagree within a release.
 */
function walkOpenTime(schedule, fromMs, consume) {
  validateShopSchedule(schedule);
  const offset = schedule.utcOffsetMinutes;
  let { dayKey, weekday, minuteOfDay } = localOf(fromMs, offset);
  let cursorMinute = minuteOfDay;

  for (let day = 0; day < MAX_WALK_DAYS; day += 1) {
    for (const window of windowsOn(schedule, dayKey, weekday)) {
      const opens = Math.max(window.opensMinute, day === 0 ? cursorMinute : 0);
      if (opens >= window.closesMinute) continue;
      const verdict = consume({
        dayKey,
        openedMs: instantAt(dayKey, opens, offset),
        minutes: window.closesMinute - opens,
        closesMs: instantAt(dayKey, window.closesMinute, offset),
      });
      if (verdict !== undefined) return verdict;
    }
    dayKey = nextDayKey(dayKey);
    weekday = (weekday + 1) % 7;
    cursorMinute = 0;
  }
  fail(409, "shop_never_open", "This shop has no opening hours in the year ahead.", {
    field: "schedule",
  });
  return null;
}

/** Is the shop open at this exact moment? */
export function isOpenAt(schedule, at) {
  const timeMs = instantOf(at, "at");
  validateShopSchedule(schedule);
  const { dayKey, weekday, minuteOfDay } = localOf(timeMs, schedule.utcOffsetMinutes);
  return windowsOn(schedule, dayKey, weekday).some(
    (window) => minuteOfDay >= window.opensMinute && minuteOfDay < window.closesMinute,
  );
}

/**
 * When the shop has put in this many working minutes, starting from `from`.
 *
 * Zero minutes still moves the answer to the next moment the shop is open,
 * because "starts immediately" on a Sunday means Monday morning, not Sunday.
 */
export function addWorkingMinutes(schedule, from, minutes) {
  const fromMs = instantOf(from, "from");
  if (!Number.isFinite(minutes) || minutes < 0) {
    fail(400, "invalid_duration", "Working minutes must be zero or more.", { field: "minutes" });
  }
  let remaining = Math.ceil(minutes);
  return new Date(walkOpenTime(schedule, fromMs, ({ openedMs, minutes: available, closesMs }) => {
    if (remaining === 0) return openedMs;
    if (remaining < available) return openedMs + remaining * MS_PER_MINUTE;
    remaining -= available;
    if (remaining === 0) return closesMs;
    return undefined;
  })).toISOString();
}

/** Working minutes the shop actually has between two instants. */
export function workingMinutesBetween(schedule, from, to) {
  const fromMs = instantOf(from, "from");
  const toMs = instantOf(to, "to");
  if (toMs <= fromMs) return 0;
  let total = 0;
  walkOpenTime(schedule, fromMs, ({ openedMs, minutes, closesMs }) => {
    if (openedMs >= toMs) return total;
    total += Math.max(0, Math.round((Math.min(closesMs, toMs) - openedMs) / MS_PER_MINUTE));
    return closesMs >= toMs ? total : undefined;
  });
  return total;
}

/** The end of the nth open day at or after `from`. Day 0 is the day work starts. */
export function addWorkingDays(schedule, from, days) {
  const fromMs = instantOf(from, "from");
  if (!Number.isInteger(days) || days < 0) {
    fail(400, "invalid_duration", "Working days must be a whole number, zero or more.", { field: "days" });
  }
  let seen = -1;
  let lastDay = null;
  return new Date(walkOpenTime(schedule, fromMs, ({ dayKey, closesMs }) => {
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      seen += 1;
    }
    return seen >= days ? closesMs : undefined;
  })).toISOString();
}

/**
 * When this shop would finish this job, and what the client should be told.
 *
 * Three things hold a job back and the slowest one wins:
 *
 *   the queue     -- work already committed has to clear first
 *   turnaround    -- the listing's own stated time
 *   daily capacity -- a shop that runs 500 units a day needs two days for 900,
 *                     however short its turnaround says it is
 *
 * Capacity is counted in whole open days rather than minutes because that is
 * how a shop declares it, and pretending a 500/day limit is 50/hour would
 * promise finishing at noon on work that gets done tomorrow.
 */
export function projectFinish({
  schedule,
  now,
  queueMinutes = 0,
  turnaroundMinutes,
  units = null,
  capacityDaily = null,
  allowanceMinutes = 0,
}) {
  if (!Number.isFinite(turnaroundMinutes) || turnaroundMinutes <= 0) {
    fail(400, "invalid_duration", "A listing needs a positive turnaround before it can be scheduled.", {
      field: "turnaroundMinutes",
    });
  }
  if (!Number.isFinite(queueMinutes) || queueMinutes < 0) {
    fail(400, "invalid_duration", "Queue time must be zero or more.", { field: "queueMinutes" });
  }

  const startsAt = addWorkingMinutes(schedule, now, queueMinutes);
  const byTurnaround = addWorkingMinutes(schedule, startsAt, turnaroundMinutes);

  let capacityDays = 0;
  if (Number.isSafeInteger(units) && units > 0 && Number.isSafeInteger(capacityDaily) && capacityDaily > 0) {
    capacityDays = Math.ceil(units / capacityDaily) - 1;
  }
  const byCapacity = capacityDays > 0 ? addWorkingDays(schedule, startsAt, capacityDays) : byTurnaround;

  const capacityWins = Date.parse(byCapacity) > Date.parse(byTurnaround);
  const readyBy = capacityWins ? byCapacity : byTurnaround;
  const promiseBy = allowanceMinutes > 0
    ? addWorkingMinutes(schedule, readyBy, allowanceMinutes)
    : readyBy;

  return {
    startsAt,
    /** The shop's own date. Its on-time record is measured against this. */
    readyBy,
    /** What the client is told. Never shown to the shop. */
    promiseBy,
    limitedBy: capacityWins ? "capacity" : "turnaround",
    queueMinutes,
    capacityDays,
  };
}

/**
 * Can this shop be offered for this deadline?
 *
 * Judged on the promised date, not the shop's own. A shop that only just
 * scrapes Friday with no allowance left cannot be offered Friday -- the whole
 * point of the allowance is that it is not spent before the job starts.
 */
export function fitsDeadline(projection, deadline) {
  if (deadline == null) return true;
  return Date.parse(projection.promiseBy) <= instantOf(deadline, "deadline");
}
