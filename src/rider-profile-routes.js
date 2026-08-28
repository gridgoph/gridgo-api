import { identityHasMembership } from "./authorization-context.js";
import { philippineMobileNumber } from "./phone.js";
import {
  CatalogError,
  assertExpectedVersion,
  bumpVersion,
} from "./supplier-catalog.js";

const VEHICLE_TYPES = new Set(["motorcycle", "car", "van", "truck", "bicycle"]);

function fail(status, code, message, details = {}) {
  throw new CatalogError(status, code, message, details);
}

function optionalText(value, field, maxLength) {
  if (value != null && typeof value !== "string") {
    fail(400, "invalid_rider_profile", `${field} must be a string.`, { field });
  }
  const text = String(value ?? "");
  if (text.length > maxLength) {
    fail(400, "invalid_rider_profile", `${field} is too long.`, { field, maxLength });
  }
  return text;
}

function requiredText(value, field, maxLength = 200) {
  const text = optionalText(value, field, maxLength).trim();
  if (!text) fail(400, "invalid_rider_profile", `${field} is required.`, { field });
  return text;
}

function catalogRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "invalid_rider_profile", "body must be a JSON object.", { field: "body" });
  }
  return value;
}

function requireRider(user) {
  if (!user || !identityHasMembership(user, "rider")) {
    fail(403, "forbidden", "A rider membership is required.");
  }
}

function privateRiderProfile(profile, owner) {
  return {
    userId: profile.userId,
    name: owner?.name ?? null,
    phone: owner?.phone ?? null,
    email: owner?.email ?? null,
    vehicleType: profile.vehicleType,
    plateNumber: profile.plateNumber,
    licenseNumber: profile.licenseNumber ?? null,
    version: profile.version || 1,
    updatedAt: profile.updatedAt,
  };
}

export function isPrivateRiderProfileRoute(pathname) {
  return pathname === "/me/rider-profile";
}

/**
 * The signed-in rider's own name, number, vehicle and plate.
 *
 * Phone and email live on the account; vehicle, plate and licence live on the
 * rider profile. The app shows them on one details screen, so both reads
 * answer with the joined view. Email belongs to the GRIDGO sign-in.
 */
export async function routeRiderProfile({ req, url, store, user, readBody, now, audit }) {
  const { pathname } = url;
  if (!["GET", "PATCH"].includes(req.method) || pathname !== "/me/rider-profile") return null;

  requireRider(user);
  const profile = (store.riderProfiles || []).find((candidate) => candidate.userId === user.id);
  if (!profile) fail(404, "rider_profile_not_found", "Complete rider enrollment first.");
  const owner = (store.users || []).find((candidate) => candidate.id === user.id);
  if (req.method === "GET") {
    return { status: 200, body: { profile: privateRiderProfile(profile, owner) } };
  }

  const body = catalogRecord(await readBody(req));
  assertExpectedVersion(req, body, "rider_profile_stale", profile.version || 1);
  if (Object.hasOwn(body, "email")) {
    fail(
      400,
      "email_not_editable",
      "Your email comes from your GRIDGO sign-in. Change it there and it will update here.",
      { field: "email" },
    );
  }

  // Read every field before anything moves so a mistyped phone cannot leave a
  // half-applied edit behind.
  const phone = Object.hasOwn(body, "phone")
    ? philippineMobileNumber(body.phone, "phone", {
      code: "invalid_rider_profile",
      blankMessage: "Enter a mobile number GRIDGO and Operations can reach you on.",
    })
    : null;
  const name = body.name != null ? requiredText(body.name, "name", 120) : null;
  let vehicleType = null;
  if (body.vehicleType != null) {
    vehicleType = requiredText(body.vehicleType, "vehicleType", 40);
    if (!VEHICLE_TYPES.has(vehicleType)) {
      fail(
        400,
        "invalid_rider_profile",
        "Choose motorcycle, car, van, truck, or bicycle.",
        { field: "vehicleType" },
      );
    }
  }
  const plateNumber = body.plateNumber != null
    ? requiredText(body.plateNumber, "plateNumber", 40)
    : null;
  const hasLicense = Object.hasOwn(body, "licenseNumber");
  const licenseNumber = hasLicense
    ? optionalText(body.licenseNumber, "licenseNumber", 80).trim()
    : null;

  if (name != null && owner) owner.name = name;
  if (vehicleType != null) profile.vehicleType = vehicleType;
  if (plateNumber != null) profile.plateNumber = plateNumber;
  if (hasLicense) {
    if (licenseNumber) profile.licenseNumber = licenseNumber;
    else delete profile.licenseNumber;
  }
  const at = now();
  bumpVersion(profile, at);
  if (owner && phone) owner.phone = phone;
  if (typeof audit === "function") {
    audit(store, {
      actor: user,
      action: "rider_profile.update",
      entityType: "rider_profile",
      entityId: user.id,
    });
  }
  return { status: 200, body: { profile: privateRiderProfile(profile, owner) }, mutated: true };
}
