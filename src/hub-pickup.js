import { AvailabilityError, validateShopSchedule } from "./availability.js";
import { gridgoOfficePoint } from "./gridgo-office.js";

const DEFAULT_SCHEDULE = { utcOffsetMinutes: 480,
  week: [1, 3, 5].map(weekday => ({ weekday, opensMinute: 540, closesMinute: 1020 })), closures: [] };

export function hubPickupSettings(settings) {
  return structuredClone(settings?.hubPickup ?? { schedule: null, feeMinor: 0 });
}

export function publicHubPickup(settings) {
  const pickup = hubPickupSettings(settings);
  return { ...pickup, schedule: pickup.schedule ?? structuredClone(DEFAULT_SCHEDULE), point: gridgoOfficePoint() };
}

export function validateHubPickup(value, fail) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, "schedule")
      || !Number.isSafeInteger(value.feeMinor) || value.feeMinor < 0) {
    fail(400, "invalid_hub_pickup", "Set a schedule and a nonnegative safe-integer fee in PHP minor units.", { field: "hubPickup" });
  }
  if (value.schedule !== null) {
    if (!value.schedule || typeof value.schedule !== "object" || Array.isArray(value.schedule)
        || !Array.isArray(value.schedule.week) || value.schedule.week.length > 28
        || (value.schedule.closures != null && (!Array.isArray(value.schedule.closures) || value.schedule.closures.length > 120))) {
      fail(400, "invalid_hub_pickup_schedule", "Set a weekly schedule with an optional closure array.", { field: "hubPickup.schedule" });
    }
    try {
      validateShopSchedule(value.schedule);
    } catch (error) {
      if (!(error instanceof AvailabilityError)) throw error;
      fail(400, "invalid_hub_pickup_schedule", error.message, error.details);
    }
  }
}
