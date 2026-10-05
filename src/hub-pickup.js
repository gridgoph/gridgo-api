import { AvailabilityError, validateShopSchedule } from "./availability.js";
import { gridgoOfficePoint } from "./gridgo-office.js";

export function hubPickupSettings(settings) {
  return structuredClone(settings?.hubPickup ?? { schedule: null, feeMinor: 0 });
}

export function publicHubPickup(settings) {
  return { ...hubPickupSettings(settings), point: gridgoOfficePoint() };
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
