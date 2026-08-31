import test from "node:test";
import assert from "node:assert/strict";

import {
  AvailabilityError,
  addWorkingDays,
  addWorkingMinutes,
  defaultShopSchedule,
  fitsDeadline,
  isOpenAt,
  projectFinish,
  validateShopSchedule,
  workingMinutesBetween,
} from "../src/availability.js";

/**
 * Dates here are real and checked: 2026-09-04 is a Friday, so the weekend the
 * walk has to step over is the actual one. Every expectation is written as the
 * absolute instant, with the shop's local clock in the comment beside it --
 * asserting against a helper that does the same conversion would only prove the
 * helper agrees with itself.
 */

const MON_TO_SAT = defaultShopSchedule(); // Mon-Sat 08:00-18:00, +08:00
const MON_TO_FRI = {
  utcOffsetMinutes: 480,
  week: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinute: 480, closesMinute: 1080 })),
  closures: [],
};

const FRI_4PM = "2026-09-04T08:00:00.000Z"; // Fri 4pm in Davao
const FRI_8AM = "2026-09-04T00:00:00.000Z"; // Fri 8am
const SUN_10AM = "2026-09-06T02:00:00.000Z"; // Sun 10am, shop shut

function expectDomainError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof AvailabilityError, true);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.match(error.message, /[A-Za-z]/);
    return true;
  });
}

test("the migrate default is Mon-Sat 08:00-18:00 and shut on Sunday", () => {
  assert.equal(validateShopSchedule(MON_TO_SAT), true);
  assert.deepEqual(MON_TO_SAT.week.map((w) => w.weekday), [1, 2, 3, 4, 5, 6]);
  assert.equal(isOpenAt(MON_TO_SAT, "2026-09-04T02:00:00.000Z"), true); // Fri 10am
  assert.equal(isOpenAt(MON_TO_SAT, "2026-09-04T11:00:00.000Z"), false); // Fri 7pm
  assert.equal(isOpenAt(MON_TO_SAT, SUN_10AM), false); // Sunday
});

test("twenty working hours from Friday afternoon lands Tuesday, not Saturday", () => {
  // Fri 16:00-18:00 is 2h, Mon is 10h, so 8h remain and land Tue 16:00.
  // A wall-clock engine would answer Saturday lunchtime and promise a day the
  // shop is shut.
  assert.equal(
    addWorkingMinutes(MON_TO_FRI, FRI_4PM, 20 * 60),
    "2026-09-08T08:00:00.000Z", // Tue 4pm
  );
});

test("the same twenty hours land Monday at a shop that opens Saturdays", () => {
  assert.equal(
    addWorkingMinutes(MON_TO_SAT, FRI_4PM, 20 * 60),
    "2026-09-07T08:00:00.000Z", // Mon 4pm
  );
});

test("no work at all still moves to the next moment the shop is open", () => {
  // "Starts immediately" on a Sunday means Monday morning.
  assert.equal(addWorkingMinutes(MON_TO_SAT, SUN_10AM, 0), "2026-09-07T00:00:00.000Z"); // Mon 8am
});

test("a closure is stepped over like any other shut day", () => {
  const withHoliday = { ...MON_TO_SAT, closures: [{ startDay: "2026-09-07", endDay: "2026-09-07" }] };
  assert.equal(
    addWorkingMinutes(withHoliday, FRI_4PM, 20 * 60),
    "2026-09-08T08:00:00.000Z", // Tue 4pm — Monday was closed
  );
  assert.equal(isOpenAt(withHoliday, "2026-09-07T02:00:00.000Z"), false);
});

test("working minutes between two instants ignore the hours the shop is shut", () => {
  // Fri 16:00 -> Mon 09:00 is 65 clock hours but 13 working ones.
  assert.equal(workingMinutesBetween(MON_TO_SAT, FRI_4PM, "2026-09-07T01:00:00.000Z"), 780);
  assert.equal(workingMinutesBetween(MON_TO_SAT, FRI_4PM, FRI_4PM), 0);
});

test("working days count open days, and day zero is the day work starts", () => {
  assert.equal(addWorkingDays(MON_TO_SAT, FRI_4PM, 0), "2026-09-04T10:00:00.000Z"); // Fri close
  assert.equal(addWorkingDays(MON_TO_SAT, FRI_4PM, 1), "2026-09-05T10:00:00.000Z"); // Sat close
  assert.equal(addWorkingDays(MON_TO_SAT, FRI_4PM, 2), "2026-09-07T10:00:00.000Z"); // Mon close
});

test("a job waits for the queue ahead of it before its own turnaround starts", () => {
  const clear = projectFinish({
    schedule: MON_TO_SAT, now: FRI_8AM, turnaroundMinutes: 600,
  });
  assert.equal(clear.startsAt, FRI_8AM);
  assert.equal(clear.readyBy, "2026-09-04T10:00:00.000Z"); // Fri 6pm

  const queued = projectFinish({
    schedule: MON_TO_SAT, now: FRI_8AM, queueMinutes: 600, turnaroundMinutes: 600,
  });
  assert.equal(queued.startsAt, "2026-09-04T10:00:00.000Z"); // starts Fri close
  assert.equal(queued.readyBy, "2026-09-05T10:00:00.000Z"); // Sat 6pm
});

test("daily capacity holds back a big run however short the turnaround says it is", () => {
  const projection = projectFinish({
    schedule: MON_TO_SAT,
    now: FRI_8AM,
    turnaroundMinutes: 600, // the listing claims one day
    units: 900,
    capacityDaily: 500, // but the shop only runs 500 a day
  });
  assert.equal(projection.limitedBy, "capacity");
  assert.equal(projection.capacityDays, 1);
  assert.equal(projection.readyBy, "2026-09-05T10:00:00.000Z"); // Sat, not Fri
});

test("capacity that comfortably covers the run does not slow anything down", () => {
  const projection = projectFinish({
    schedule: MON_TO_SAT, now: FRI_8AM, turnaroundMinutes: 600, units: 100, capacityDaily: 500,
  });
  assert.equal(projection.limitedBy, "turnaround");
  assert.equal(projection.capacityDays, 0);
});

test("the allowance pads the client's date and leaves the shop's alone", () => {
  const projection = projectFinish({
    schedule: MON_TO_SAT,
    now: FRI_8AM,
    turnaroundMinutes: 600,
    allowanceMinutes: 600, // one working day
  });
  assert.equal(projection.readyBy, "2026-09-04T10:00:00.000Z"); // shop: Fri 6pm
  assert.equal(projection.promiseBy, "2026-09-05T10:00:00.000Z"); // client: Sat 6pm
  assert.notEqual(projection.readyBy, projection.promiseBy);
});

test("the allowance is working time, so it never pushes a promise onto a shut day", () => {
  const projection = projectFinish({
    schedule: MON_TO_SAT,
    now: "2026-09-05T08:00:00.000Z", // Sat 4pm
    turnaroundMinutes: 120,
    allowanceMinutes: 600,
  });
  assert.equal(projection.readyBy, "2026-09-05T10:00:00.000Z"); // Sat 6pm
  assert.equal(projection.promiseBy, "2026-09-07T10:00:00.000Z"); // Mon 6pm, skipping Sunday
});

test("a shop is judged fit on the promised date, never on its own", () => {
  const projection = projectFinish({
    schedule: MON_TO_SAT, now: FRI_8AM, turnaroundMinutes: 600, allowanceMinutes: 600,
  });
  // The shop's own date clears Friday midnight, but the promise does not — so
  // this shop cannot be offered a Friday deadline. That is the allowance doing
  // its job rather than being spent before the work starts.
  assert.equal(Date.parse(projection.readyBy) < Date.parse("2026-09-04T16:00:00.000Z"), true);
  assert.equal(fitsDeadline(projection, "2026-09-04T16:00:00.000Z"), false);
  assert.equal(fitsDeadline(projection, "2026-09-06T16:00:00.000Z"), true);
  assert.equal(fitsDeadline(projection, null), true); // "no rush" filters nobody out
});

test("a schedule that never opens is a fault, not a very long wait", () => {
  const shut = { utcOffsetMinutes: 480, week: [{ weekday: 0, opensMinute: 480, closesMinute: 1080 }], closures: [{ startDay: "2020-01-01", endDay: "2099-01-01" }] };
  expectDomainError(() => addWorkingMinutes(shut, FRI_8AM, 60), 409, "shop_never_open");
});

test("a broken schedule is refused with the field that is wrong", () => {
  expectDomainError(() => validateShopSchedule({ utcOffsetMinutes: 480, week: [] }), 400, "invalid_schedule");
  expectDomainError(
    () => validateShopSchedule({ utcOffsetMinutes: 480, week: [{ weekday: 9, opensMinute: 0, closesMinute: 60 }] }),
    400, "invalid_schedule",
  );
  expectDomainError(
    () => validateShopSchedule({ utcOffsetMinutes: 480, week: [{ weekday: 1, opensMinute: 600, closesMinute: 600 }] }),
    400, "invalid_schedule",
  );
  expectDomainError(
    () => validateShopSchedule({
      utcOffsetMinutes: 480,
      week: [
        { weekday: 1, opensMinute: 480, closesMinute: 720 },
        { weekday: 1, opensMinute: 700, closesMinute: 1080 },
      ],
    }),
    400, "invalid_schedule",
  );
  expectDomainError(
    () => validateShopSchedule({ ...MON_TO_SAT, closures: [{ startDay: "2026-09-10", endDay: "2026-09-01" }] }),
    400, "invalid_schedule",
  );
});

test("a listing with no turnaround cannot be scheduled at all", () => {
  expectDomainError(
    () => projectFinish({ schedule: MON_TO_SAT, now: FRI_8AM, turnaroundMinutes: 0 }),
    400, "invalid_duration",
  );
});

test("a shop with a lunch break splits its day without losing minutes", () => {
  const withBreak = {
    utcOffsetMinutes: 480,
    week: [
      { weekday: 5, opensMinute: 480, closesMinute: 720 }, // Fri 08:00-12:00
      { weekday: 5, opensMinute: 780, closesMinute: 1080 }, // Fri 13:00-18:00
    ],
    closures: [],
  };
  assert.equal(workingMinutesBetween(withBreak, FRI_8AM, "2026-09-04T10:00:00.000Z"), 540); // 9h, not 10
  assert.equal(addWorkingMinutes(withBreak, FRI_8AM, 300), "2026-09-04T06:00:00.000Z"); // 2pm, over the break
});
