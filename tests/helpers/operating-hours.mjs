// Unrelated lifecycle tests exercise work at arbitrary wall-clock times. Use an
// explicit round-the-clock platform; operating-hours tests use launch windows.
export function alwaysOpenOperatingHours() {
  return { timeZone: 'Asia/Manila', artworkReviewMinutes: 60, priorityDispatchCutoffMinute: 960,
    schedule: { utcOffsetMinutes: 480, closures: [],
      week: Array.from({ length: 7 }, (_, weekday) => ({ weekday, opensMinute: 0, closesMinute: 1440 })) } };
}
