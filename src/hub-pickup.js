import { AvailabilityError, validateShopSchedule } from "./availability.js";
import { gridgoOfficePoint } from "./gridgo-office.js";
import { operatingHours } from "./operating-hours.js";

export function hubPickupSettings(settings) {
  return structuredClone(settings?.hubPickup ?? { schedule: null, feeMinor: 0 });
}

/** Decided 18 Oct 2026: an unset hub schedule follows GRIDGO's operating hours; an explicit hub schedule wins. */
export function effectiveHubSchedule(settings) {
  const own = hubPickupSettings(settings).schedule;
  return own
    ? { schedule: own, hoursSource: "hub" }
    : { schedule: structuredClone(operatingHours(settings).schedule ?? null), hoursSource: "operating_hours" };
}

/** Hub, match, cart and arrival-snapshot projection: the schedule that actually applies. */
export function publicHubPickup(settings) {
  return { ...hubPickupSettings(settings), ...effectiveHubSchedule(settings), point: gridgoOfficePoint() };
}

/** `GET /settings` keeps the stored schedule (null = follow operating hours) so an editor round-trip never pins them. */
export function settingsHubPickup(settings) {
  const { schedule, hoursSource } = effectiveHubSchedule(settings);
  return { ...hubPickupSettings(settings), hoursSource, effectiveSchedule: schedule, point: gridgoOfficePoint() };
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
