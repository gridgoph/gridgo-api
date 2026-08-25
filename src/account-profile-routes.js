import { identityHasMembership } from "./authorization-context.js";
import { philippineMobileNumber } from "./phone.js";

const BUSINESS_ACCOUNT_TYPES = new Set(["business", "organization"]);

export class AccountProfileError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "AccountProfileError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new AccountProfileError(status, code, message, details);
}

function record(value, field = "body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "invalid_account_profile", `${field} must be a JSON object.`, { field });
  }
  return value;
}

function rejectUnexpected(body, allowed) {
  const field = Object.keys(body).find((candidate) => !allowed.includes(candidate));
  if (field) fail(400, "unexpected_field", `Remove \`${field}\`.`, { field });
}

function text(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    fail(400, "invalid_account_profile", `${field} is required.`, { field });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    fail(400, "invalid_account_profile", `${field} must be at most ${maxLength} characters.`, {
      field,
      maxLength,
    });
  }
  return normalized;
}

function requireClient(user) {
  if (!user) fail(401, "unauthorized", "Sign in to edit your GRIDGO account.");
  if (!identityHasMembership(user, "client")) {
    fail(403, "membership_required", "A GRIDGO client membership is required.", {
      requiredRole: "client",
    });
  }
  // account_type and org_name are still legacy users columns during the
  // membership compatibility window and are constrained to a client primary row.
  if (user.role !== "client") {
    fail(409, "client_profile_unavailable", "This identity does not have an editable client account profile.");
  }
}

function headerVersion(req) {
  const raw = req?.headers?.["if-match"] ?? req?.headers?.["If-Match"];
  return typeof raw === "string" ? raw.replace(/^W\//, "").replaceAll('"', "").trim() : raw;
}

function expectedVersion(req, body, currentVersion) {
  const raw = body.expectedVersion ?? headerVersion(req);
  if (raw == null || raw === "") {
    fail(400, "expected_version_required", "Send expectedVersion so GRIDGO can reject a stale profile edit.");
  }
  const expected = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(expected) || expected < 1) {
    fail(400, "invalid_account_profile", "expectedVersion must be a positive integer.", {
      field: "expectedVersion",
    });
  }
  if (expected !== currentVersion) {
    fail(409, "account_version_conflict", "This account changed. Refresh it and try again.", {
      expectedVersion: expected,
      currentVersion,
    });
  }
}

function point(value, field) {
  record(value, field);
  if (!Number.isFinite(value.lat) || value.lat < -90 || value.lat > 90) {
    fail(400, "invalid_account_profile", `${field}.lat must be a latitude from -90 to 90.`, {
      field: `${field}.lat`,
    });
  }
  if (!Number.isFinite(value.lng) || value.lng < -180 || value.lng > 180) {
    fail(400, "invalid_account_profile", `${field}.lng must be a longitude from -180 to 180.`, {
      field: `${field}.lng`,
    });
  }
  return { lat: value.lat, lng: value.lng };
}

function addressInput(value) {
  const address = record(value, "address");
  rejectUnexpected(address, ["label", "addressLine", "point", "isDefault"]);
  return {
    label: text(address.label, "address.label", 80),
    addressLine: text(address.addressLine, "address.addressLine", 240),
    point: point(address.point, "address.point"),
    isDefault: Boolean(address.isDefault),
  };
}

function sameAddress(left, right) {
  return left.label === right.label
    && left.addressLine === right.addressLine
    && left.point?.lat === right.point.lat
    && left.point?.lng === right.point.lng;
}

function publicAccount(user, publicUser) {
  const projected = publicUser(user);
  projected.version = user.version || 1;
  delete projected.profileNameManaged;
  return projected;
}

function bumpVersion(user) {
  user.version = (user.version || 1) + 1;
}

function updateName(user, name) {
  if (user.name === name && user.profileNameManaged === true) return false;
  user.name = name;
  // Once a person explicitly edits their Account profile, Clerk webhooks may
  // keep refreshing email but must not overwrite the chosen display name.
  user.profileNameManaged = true;
  return true;
}

function addAddress(store, user, input, createId, at) {
  store.clientAddresses ||= [];
  const existing = store.clientAddresses.find(
    (candidate) => candidate.clientId === user.id && sameAddress(candidate, input),
  );
  if (existing) return { address: existing, created: false };
  if (input.isDefault) {
    for (const candidate of store.clientAddresses) {
      if (candidate.clientId === user.id) candidate.isDefault = false;
    }
  }
  const address = {
    id: createId("addr"),
    clientId: user.id,
    ...input,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  store.clientAddresses.push(address);
  return { address, created: true };
}

export function isAccountProfileRoute(method, pathname) {
  return (pathname === "/me" && ["GET", "PATCH"].includes(method))
    || (pathname === "/me/business-apply" && method === "POST");
}

/**
 * Client Account contract (the user envelope is always `{ "user": ... }`):
 * GET /me
 * PATCH /me { "expectedVersion": 1, "name"?: "Ana", "phone"?: "09171234567", "orgName"?: "Acme" }
 * POST /me/business-apply { "accountType"?: "business"|"organization", "businessName": "Acme", "contactName"?: "Ana", "contactPhone"?: "09171234567", "address"?: { "label": "Office", "addressLine": "123 Rizal St", "point": { "lat": 7.07, "lng": 125.61 }, "isDefault"?: true } }
 */
export async function routeAccountProfile({ req, url, store, user, readBody, createId, now, audit, publicUser }) {
  const { pathname } = url;
  if (!isAccountProfileRoute(req.method, pathname)) return null;
  requireClient(user);

  if (req.method === "GET") {
    return { status: 200, body: { user: publicAccount(user, publicUser) }, mutated: false };
  }

  if (req.method === "PATCH") {
    const body = record(await readBody(req));
    rejectUnexpected(body, ["expectedVersion", "name", "phone", "orgName"]);
    expectedVersion(req, body, user.version || 1);
    if (!["name", "phone", "orgName"].some((field) => Object.hasOwn(body, field))) {
      fail(400, "invalid_account_profile", "Send at least one of name, phone, or orgName.");
    }

    const name = Object.hasOwn(body, "name") ? text(body.name, "name", 120) : null;
    const phone = Object.hasOwn(body, "phone")
      ? philippineMobileNumber(body.phone, "phone", {
        code: "invalid_account_profile",
        blankMessage: "Enter a mobile number GRIDGO can reach you on.",
      })
      : null;
    const hasOrgName = Object.hasOwn(body, "orgName");
    const orgName = hasOrgName ? text(body.orgName, "orgName", 160) : null;
    if (hasOrgName && user.accountType === "individual") {
      fail(400, "org_name_not_allowed", "Individual accounts do not use an organization name.", {
        field: "orgName",
      });
    }
    if (BUSINESS_ACCOUNT_TYPES.has(user.accountType) && !(orgName || user.orgName)) {
      fail(400, "org_name_required", "Business and organization accounts require orgName.", {
        field: "orgName",
      });
    }

    if (name != null) updateName(user, name);
    if (phone != null) user.phone = phone;
    if (orgName != null) user.orgName = orgName;
    bumpVersion(user);
    if (typeof audit === "function") {
      audit(store, {
        actor: user,
        action: "client_account.update",
        entityType: "user",
        entityId: user.id,
        detail: { fields: ["name", "phone", "orgName"].filter((field) => Object.hasOwn(body, field)) },
      });
    }
    return { status: 200, body: { user: publicAccount(user, publicUser) }, mutated: true };
  }

  const body = record(await readBody(req));
  rejectUnexpected(body, ["accountType", "businessName", "contactName", "contactPhone", "phone", "address"]);
  if (Object.hasOwn(body, "contactPhone") && Object.hasOwn(body, "phone")) {
    fail(400, "invalid_account_profile", "Send contactPhone only once.", { field: "contactPhone" });
  }
  const accountType = body.accountType == null ? "business" : body.accountType;
  if (!BUSINESS_ACCOUNT_TYPES.has(accountType)) {
    fail(400, "invalid_account_profile", "accountType must be business or organization.", {
      field: "accountType",
    });
  }
  const businessName = text(body.businessName, "businessName", 160);
  const contactName = Object.hasOwn(body, "contactName")
    ? text(body.contactName, "contactName", 120)
    : user.name;
  const submittedPhone = body.contactPhone ?? body.phone;
  const contactPhone = submittedPhone != null
    ? philippineMobileNumber(submittedPhone, "contactPhone", {
      code: "invalid_account_profile",
      blankMessage: "Enter a contact mobile number for this business account.",
    })
    : user.phone;
  if (!contactName) {
    fail(400, "contact_name_required", "Send contactName for this business account.", {
      field: "contactName",
    });
  }
  if (!contactPhone) {
    fail(400, "contact_phone_required", "Send contactPhone for this business account.", {
      field: "contactPhone",
    });
  }
  const address = body.address == null ? null : addressInput(body.address);

  let changed = false;
  if (user.accountType !== accountType) {
    user.accountType = accountType;
    changed = true;
  }
  if (user.orgName !== businessName) {
    user.orgName = businessName;
    changed = true;
  }
  if (contactName !== user.name || user.profileNameManaged !== true) {
    changed = updateName(user, contactName) || changed;
  }
  if (contactPhone !== user.phone) {
    user.phone = contactPhone;
    changed = true;
  }
  const at = now();
  const addressResult = address ? addAddress(store, user, address, createId, at) : null;
  if (addressResult?.created) changed = true;
  if (changed) {
    bumpVersion(user);
    if (typeof audit === "function") {
      audit(store, {
        actor: user,
        action: "client_account.business_apply",
        entityType: "user",
        entityId: user.id,
        detail: { accountType, addressAdded: Boolean(addressResult?.created) },
      });
    }
  }
  return {
    status: 200,
    body: { user: publicAccount(user, publicUser) },
    mutated: changed,
  };
}
