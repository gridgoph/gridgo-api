import crypto from "node:crypto";

import { clerkClientProfile } from "./auth.js";
import { notifyOpsSignupSubmitted } from "./client-order-notifications.js";
import { queueInvalidate } from "./notifications.js";
import { resolveCategoryCode } from "./taxonomy.js";

const VEHICLE_TYPES = new Set(["motorcycle", "car", "van", "truck", "bicycle"]);
const REAPPLY_KINDS = new Map([
  ["business-client", { caseKind: "business_client", role: "client" }],
  ["supplier", { caseKind: "supplier", role: "supplier" }],
  ["rider", { caseKind: "rider", role: "rider" }],
]);

export class EnrollmentError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "EnrollmentError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new EnrollmentError(status, code, message, details);
}

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(body) {
  return crypto.createHash("sha256").update(stable(body)).digest("hex");
}

function unexpectedField(record, allowed, prefix = "") {
  if (!plainObject(record)) return null;
  const key = Object.keys(record).find((candidate) => !allowed.includes(candidate));
  return key == null ? null : `${prefix}${key}`;
}

function rejectUnexpected(record, allowed, prefix = "") {
  const field = unexpectedField(record, allowed, prefix);
  if (field) {
    fail(
      400,
      "unexpected_field",
      `Remove \`${field}\`. The enrollment URL fixes the role and approval state; callers cannot supply them.`,
      { field },
    );
  }
}

function nonblank(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalidApplication(fields) {
  fail(
    400,
    "invalid_application",
    "Fix the highlighted application fields and submit again.",
    { fields },
  );
}

export function requireIdempotencyKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) {
    fail(
      400,
      "idempotency_key_required",
      "Send a unique Idempotency-Key header for this application, then retry the same request with that key.",
    );
  }
  if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    fail(
      400,
      "invalid_application",
      "Use an Idempotency-Key containing 1 to 200 letters, numbers, dots, underscores, colons, or hyphens.",
      { fields: { "Idempotency-Key": "must be a valid idempotency token" } },
    );
  }
  return key;
}

function caseProjection(approvalCase) {
  if (!approvalCase) return null;
  return {
    id: approvalCase.id,
    kind: approvalCase.kind,
    status: approvalCase.status,
    version: approvalCase.version,
    applicationRevision: approvalCase.applicationRevision,
    submittedAt: approvalCase.submittedAt ?? null,
    decidedAt: approvalCase.decidedAt ?? null,
    rejectionReason: approvalCase.rejectionReason ?? null,
    suspensionReason: approvalCase.suspensionReason ?? null,
    updatedAt: approvalCase.updatedAt,
  };
}

function enrollmentRequestId(kind, userId, key) {
  return `enrollment:${kind}:${userId}:${key}`;
}

function reapplyRequestId(kind, userId, key) {
  return `reapply:${kind}:${userId}:${key}`;
}

function riderSubmitRequestId(userId, key) {
  return `rider-submit:${userId}:${key}`;
}

function eventForRequest(store, requestId) {
  return (store.approvalCaseEvents || []).find((event) => event.requestId === requestId) || null;
}

function exactRetry(store, { kind, user, key, body }) {
  const event = eventForRequest(store, enrollmentRequestId(kind, user.id, key));
  if (!event) return false;
  if (event.snapshot?.requestPayloadHash !== payloadHash(body)) {
    fail(
      409,
      "application_already_exists",
      "This idempotency key already created the application with different input. Resume the existing application.",
      { approvalCase: caseProjection((store.approvalCases || []).find((item) => item.id === event.approvalCaseId)) },
    );
  }
  return true;
}

function mappedUser(store, clerkUserId) {
  const matches = (store.users || []).filter((candidate) => candidate.clerkUserId === clerkUserId);
  if (matches.length > 1) {
    fail(401, "unauthorized", "This Clerk identity is mapped ambiguously. Ask Operations to repair the account mapping.");
  }
  return matches[0] || null;
}

function resolveOrCreateIdentity({ store, clerkUserId, clerkUser, role, application, createId, at }) {
  const linked = mappedUser(store, clerkUserId);
  if (linked) return { user: linked, created: false };
  if (!clerkUser) {
    fail(502, "clerk_unavailable", "Could not load this Clerk user. Retry enrollment in a moment.");
  }
  const profile = clerkClientProfile(clerkUser);
  if (!profile.email || !profile.email.includes("@")) {
    fail(400, "invalid_application", "Add an email address in Clerk before enrolling.", {
      fields: { email: "is required from the authenticated Clerk identity" },
    });
  }
  if ((store.users || []).some((candidate) => String(candidate.email || "").toLowerCase() === profile.email)) {
    fail(
      409,
      "email_already_registered",
      "This email belongs to another GRIDGO identity. Sign in to that Clerk identity or ask Operations to resolve the conflict.",
    );
  }
  const user = {
    id: createId("user"),
    clerkUserId,
    email: profile.email,
    name: profile.name || profile.email.split("@")[0],
    role,
    accountStatus: "active",
    verificationStatus: "pending",
    createdAt: at,
  };
  const submittedPhone = nonblank(application.phone);
  if (submittedPhone || profile.phone) user.phone = submittedPhone || profile.phone;
  if (role === "supplier") {
    user.supplierName = application.shopName;
    user.shop = application.location;
  }
  store.users.push(user);
  return { user, created: true };
}

function ensureNoCase(store, userId, kind) {
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === userId && candidate.kind === kind,
  );
  if (approvalCase) {
    fail(
      409,
      "application_already_exists",
      "This role application already exists. Resume it from the fixed account projection.",
      { approvalCase: caseProjection(approvalCase) },
    );
  }
}

function ensureMembership(store, userId, role, at) {
  if (!(store.userRoleMemberships || []).some(
    (membership) => membership.userId === userId && membership.role === role,
  )) {
    store.userRoleMemberships.push({ userId, role, createdAt: at });
  }
  return (store.userRoleMemberships || []).find(
    (membership) => membership.userId === userId && membership.role === role,
  );
}

function addInitialCase(store, { user, kind, submittedAt, key, body, createId, at, snapshot }) {
  const approvalCase = {
    id: createId("apc"),
    userId: user.id,
    kind,
    status: "pending",
    version: 1,
    applicationRevision: 1,
    ...(submittedAt ? { submittedAt } : {}),
    createdAt: at,
    updatedAt: at,
  };
  store.approvalCases.push(approvalCase);
  store.approvalCaseEvents.push({
    id: createId("ace"),
    approvalCaseId: approvalCase.id,
    applicationRevision: 1,
    toStatus: "pending",
    actorUserId: user.id,
    actorKind: "applicant",
    requestId: enrollmentRequestId(kind, user.id, key),
    snapshot: { ...snapshot, requestPayloadHash: payloadHash(body) },
    createdAt: at,
  });
  return approvalCase;
}

function validateSupplierInput(body) {
  if (!plainObject(body)) invalidApplication({ body: "must be a JSON object" });
  rejectUnexpected(body, ["profile", "serviceCategories"]);
  if (plainObject(body.profile)) {
    rejectUnexpected(body.profile, ["shopName", "contactName", "phone", "location"], "profile.");
    if (plainObject(body.profile.location)) {
      rejectUnexpected(body.profile.location, ["lat", "lng", "label"], "profile.location.");
    }
  }
  const profile = plainObject(body.profile) ? body.profile : {};
  const location = plainObject(profile.location) ? profile.location : {};
  const fields = {};
  const shopName = nonblank(profile.shopName);
  const contactName = nonblank(profile.contactName);
  const phone = nonblank(profile.phone);
  const label = nonblank(location.label);
  if (!shopName) fields["profile.shopName"] = "is required";
  if (!contactName) fields["profile.contactName"] = "is required";
  if (!phone) fields["profile.phone"] = "is required";
  if (!Number.isFinite(location.lat) || location.lat < -90 || location.lat > 90) {
    fields["profile.location.lat"] = "must be a latitude from -90 to 90";
  }
  if (!Number.isFinite(location.lng) || location.lng < -180 || location.lng > 180) {
    fields["profile.location.lng"] = "must be a longitude from -180 to 180";
  }
  if (!label) fields["profile.location.label"] = "is required";
  if (!Array.isArray(body.serviceCategories) || body.serviceCategories.length === 0) {
    fields.serviceCategories = "choose at least one active category";
  }
  if (Array.isArray(body.serviceCategories)) {
    for (const [index, code] of body.serviceCategories.entries()) {
      if (!nonblank(code)) fields[`serviceCategories.${index}`] = "must identify an active governed category";
    }
  }
  if (Object.keys(fields).length) invalidApplication(fields);
  return {
    shopName,
    contactName,
    phone,
    location: { lat: location.lat, lng: location.lng, label },
    serviceCategories: body.serviceCategories,
  };
}

function resolveSupplierCategories(store, validated) {
  const fields = {};
  const categories = [];
  for (const [index, code] of validated.serviceCategories.entries()) {
    const category = resolveCategoryCode(store.taxonomy, code);
    if (!category || category.active === false) {
      fields[`serviceCategories.${index}`] = "must identify an active governed category";
    } else if (!categories.some((item) => item.code === category.code)) {
      categories.push(category);
    }
  }
  if (Object.keys(fields).length) invalidApplication(fields);
  return {
    shopName: validated.shopName,
    contactName: validated.contactName,
    phone: validated.phone,
    location: validated.location,
    categoryCodes: categories.map((category) => category.code),
  };
}

function validateRider(body) {
  if (!plainObject(body)) invalidApplication({ body: "must be a JSON object" });
  rejectUnexpected(body, ["profile"]);
  if (plainObject(body.profile)) {
    rejectUnexpected(body.profile, ["phone", "vehicleType", "plateNumber", "licenseNumber"], "profile.");
  }
  const profile = plainObject(body.profile) ? body.profile : {};
  const fields = {};
  const phone = nonblank(profile.phone);
  const vehicleType = nonblank(profile.vehicleType);
  const plateNumber = nonblank(profile.plateNumber);
  const licenseNumber = nonblank(profile.licenseNumber);
  if (!phone) fields["profile.phone"] = "is required";
  if (!VEHICLE_TYPES.has(vehicleType)) {
    fields["profile.vehicleType"] = "choose motorcycle, car, van, truck, or bicycle";
  }
  if (!plateNumber) fields["profile.plateNumber"] = "is required";
  if (Object.keys(fields).length) invalidApplication(fields);
  return { phone, vehicleType, plateNumber, ...(licenseNumber ? { licenseNumber } : {}) };
}

function retryResult(store, user, role, kind) {
  return {
    status: 200,
    user,
    membership: (store.userRoleMemberships || []).find(
      (candidate) => candidate.userId === user.id && candidate.role === role,
    ),
    approvalCase: (store.approvalCases || []).find(
      (candidate) => candidate.userId === user.id && candidate.kind === kind,
    ),
    supplierServices: role === "supplier"
      ? (store.supplierServices || []).filter((service) => service.supplierId === user.id)
      : undefined,
  };
}

function notifySignupAndInvalidate(store, approvalCase, createId, at) {
  notifyOpsSignupSubmitted(store, approvalCase, { createId, at });
  queueInvalidate(store, { resource: "approvals", id: approvalCase.id });
}

export function enrollSupplier({ store, clerkUserId, clerkUser, body, idempotencyKey, createId, now }) {
  const validated = validateSupplierInput(body);
  const existing = mappedUser(store, clerkUserId);
  if (existing && exactRetry(store, { kind: "supplier", user: existing, key: idempotencyKey, body })) {
    return retryResult(store, existing, "supplier", "supplier");
  }
  const application = resolveSupplierCategories(store, validated);
  const at = now();
  const { user } = resolveOrCreateIdentity({
    store, clerkUserId, clerkUser, role: "supplier", application, createId, at,
  });
  ensureNoCase(store, user.id, "supplier");
  user.phone = application.phone;
  user.supplierName = application.shopName;
  user.shop = application.location;
  const membership = ensureMembership(store, user.id, "supplier", at);
  const currentProfile = (store.supplierProfiles || []).find((profile) => profile.userId === user.id);
  const profile = {
    userId: user.id,
    shopName: application.shopName,
    contactName: application.contactName,
    shop: application.location,
    pickupAvailable: currentProfile?.pickupAvailable === true,
    updatedAt: at,
  };
  if (currentProfile) Object.assign(currentProfile, profile);
  else store.supplierProfiles.push(profile);
  const supplierServices = application.categoryCodes.map((categoryCode) => ({
    id: createId("svc"),
    supplierId: user.id,
    categoryCode,
    materialCodes: [],
    finishCodes: [],
    productFamilyIds: [],
    sizeMin: null,
    sizeMax: null,
    qtyMin: null,
    qtyMax: null,
    pricingBasis: "per_unit",
    referenceRateMinor: 0,
    turnaroundHours: 48,
    capacityDaily: null,
    capacityWeekly: null,
    zones: [],
    equipmentNotes: "",
    state: "draft",
    imageFileIds: [],
    createdAt: at,
    updatedAt: at,
  }));
  store.supplierServices.push(...supplierServices);
  const approvalCase = addInitialCase(store, {
    user, kind: "supplier", submittedAt: at, key: idempotencyKey, body, createId, at,
    snapshot: { shopName: application.shopName, serviceCategories: application.categoryCodes },
  });
  notifySignupAndInvalidate(store, approvalCase, createId, at);
  return { status: 201, user, membership, supplierProfile: profile, approvalCase, supplierServices };
}

export function enrollRider({ store, clerkUserId, clerkUser, body, idempotencyKey, createId, now }) {
  const application = validateRider(body);
  const at = now();
  const existing = mappedUser(store, clerkUserId);
  if (existing && exactRetry(store, { kind: "rider", user: existing, key: idempotencyKey, body })) {
    return retryResult(store, existing, "rider", "rider");
  }
  const { user } = resolveOrCreateIdentity({
    store, clerkUserId, clerkUser, role: "rider", application, createId, at,
  });
  ensureNoCase(store, user.id, "rider");
  user.phone = application.phone;
  const membership = ensureMembership(store, user.id, "rider", at);
  const currentProfile = (store.riderProfiles || []).find((profile) => profile.userId === user.id);
  const profile = {
    userId: user.id,
    vehicleType: application.vehicleType,
    plateNumber: application.plateNumber,
    ...(application.licenseNumber ? { licenseNumber: application.licenseNumber } : {}),
    version: currentProfile?.version || 1,
    updatedAt: at,
  };
  if (currentProfile) Object.assign(currentProfile, profile);
  else store.riderProfiles.push(profile);
  const approvalCase = addInitialCase(store, {
    user, kind: "rider", submittedAt: null, key: idempotencyKey, body, createId, at,
    snapshot: { vehicleType: application.vehicleType, plateNumber: application.plateNumber },
  });
  return { status: 201, user, membership, riderProfile: profile, approvalCase };
}

const BUSINESS_ACCOUNT_TYPES = new Set(["business", "organization"]);

export function applyForBusiness({ store, user, body, idempotencyKey, createId, now }) {
  if (!plainObject(body)) invalidApplication({ body: "must be a JSON object" });
  rejectUnexpected(body, ["businessName", "businessNature", "accountType"]);
  const fields = {};
  const businessName = nonblank(body.businessName);
  const businessNature = nonblank(body.businessNature);
  const accountType = body.accountType == null ? "business" : body.accountType;
  if (!businessName) fields.businessName = "is required";
  if (!businessNature) fields.businessNature = "is required";
  if (!BUSINESS_ACCOUNT_TYPES.has(accountType)) {
    fields.accountType = "must be business or organization";
  }
  if (Object.keys(fields).length) invalidApplication(fields);
  if (!(store.userRoleMemberships || []).some(
    (membership) => membership.userId === user.id && membership.role === "client",
  )) {
    fail(403, "membership_required", "Activate ordinary client access before applying for GRIDGO Business.", {
      requiredRole: "client",
    });
  }
  store.approvalCases ||= [];
  store.approvalCaseEvents ||= [];
  store.clientProfiles ||= [];
  store.notifications ||= [];
  store.auditLog ||= [];
  if (exactRetry(store, { kind: "business_client", user, key: idempotencyKey, body })) {
    return retryResult(store, user, "client", "business_client");
  }
  ensureNoCase(store, user.id, "business_client");
  const at = now();
  let profile = store.clientProfiles.find((candidate) => candidate.userId === user.id);
  if (!profile) {
    profile = { userId: user.id, clientKind: "personal", updatedAt: at };
    store.clientProfiles.push(profile);
  }
  /*
   The requested name is held on the application, not on the profile.

   A personal profile that may not carry business fields is an invariant worth
   keeping, because nothing clears those fields when an application is rejected
   or abandoned: written here, a name nobody approved would sit on the profile
   indefinitely and read back through `/auth/me` as though it were real.

   Nothing is lost by leaving it off. The applicant event below snapshots the
   same values, `businessApplicationProjection` reads that snapshot first, and
   the approval copies them onto the profile when Operations converts the
   client.
  */
  const approvalCase = addInitialCase(store, {
    user, kind: "business_client", submittedAt: at, key: idempotencyKey, body, createId, at,
    snapshot: { businessName, businessNature, accountType },
  });
  notifySignupAndInvalidate(store, approvalCase, createId, at);
  return {
    status: 201,
    user,
    membership: (store.userRoleMemberships || []).find(
      (membership) => membership.userId === user.id && membership.role === "client",
    ),
    clientProfile: profile,
    approvalCase,
  };
}

function currentFutureLicense(store, userId, today) {
  return (store.riderDocuments || []).find(
    (document) => document.riderId === userId
      && document.kind === "drivers_license"
      && document.isCurrent !== false
      && typeof document.expiresOn === "string"
      && document.expiresOn > today
      && (store.files || []).some(
        (file) => file.fileId === document.fileId && file.state === "ready",
      ),
  ) || null;
}

function manilaDate(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function assertRiderReady(store, userId, at, { expiredMessage, incompleteMessage, allowTypedLicense = false }) {
  const profile = (store.riderProfiles || []).find((candidate) => candidate.userId === userId);
  const fields = {};
  if (!profile || !VEHICLE_TYPES.has(nonblank(profile.vehicleType))) {
    fields["profile.vehicleType"] = "choose motorcycle, car, van, truck, or bicycle";
  }
  const plateNumber = nonblank(profile?.plateNumber);
  if (!plateNumber || plateNumber === "PROFILE-COMPLETION-REQUIRED") {
    fields["profile.plateNumber"] = "is required";
  }
  if (Object.keys(fields).length) invalidApplication(fields);

  const today = manilaDate(at);
  if (currentFutureLicense(store, userId, today)) return;
  const licenseDocuments = (store.riderDocuments || []).filter(
    (document) => document.riderId === userId && document.kind === "drivers_license",
  );
  const currentLicense = licenseDocuments.find((document) => document.isCurrent !== false);
  if (currentLicense && currentLicense.expiresOn <= today) {
    fail(409, "document_expired", expiredMessage);
  }
  // The rider app still enrolls with a typed licence number and no file. The
  // legacy verification route may accept that number only when no licence
  // file was ever attached — a deleted file still blocks approval.
  if (allowTypedLicense && nonblank(profile.licenseNumber) && licenseDocuments.length === 0) {
    return;
  }
  fail(
    409,
    "rider_documents_incomplete",
    incompleteMessage,
    { missing: ["drivers_license"] },
  );
}

export function assertRiderApprovalReady(store, userId, at) {
  assertRiderReady(store, userId, at, {
    expiredMessage: "Replace the expired driver's licence before approving this rider.",
    incompleteMessage: "A ready current driver's licence with a future expiry is required before approving this rider.",
  });
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === userId && candidate.kind === "rider",
  );
  if (!approvalCase || approvalCase.submittedAt == null) {
    fail(409, "approval_state_conflict", "The rider must explicitly submit this application before approval.", {
      approvalCase: caseProjection(approvalCase),
    });
  }
}

/**
 * The Operations sign-up queue still decides through POST /users/:id/verification.
 * The rider app has not shipped file upload + explicit submit, so a typed
 * licence number from enroll is enough on this compatibility path. Canonical
 * case decisions keep asserting a ready file and a submitted case.
 */
export function assertRiderLegacyVerificationReady(store, userId, at) {
  assertRiderReady(store, userId, at, {
    expiredMessage: "Replace the expired driver's licence before approving this rider.",
    incompleteMessage: "A ready current driver's licence with a future expiry is required before approving this rider.",
    allowTypedLicense: true,
  });
  const licenseDocuments = (store.riderDocuments || []).filter(
    (document) => document.riderId === userId && document.kind === "drivers_license",
  );
  if (licenseDocuments.length === 0) return;
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === userId && candidate.kind === "rider",
  );
  if (!approvalCase || approvalCase.submittedAt == null) {
    fail(409, "approval_state_conflict", "The rider must explicitly submit this application before approval.", {
      approvalCase: caseProjection(approvalCase),
    });
  }
}

export function submitRiderApplication({ store, user, body, idempotencyKey, createId, now }) {
  if (!plainObject(body)) invalidApplication({ body: "must be a JSON object" });
  rejectUnexpected(body, ["expectedVersion"]);
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion <= 0) {
    invalidApplication({ expectedVersion: "must be a positive integer" });
  }
  if (!(store.userRoleMemberships || []).some(
    (membership) => membership.userId === user.id && membership.role === "rider",
  )) {
    fail(403, "membership_required", "This action requires a rider membership.", { requiredRole: "rider" });
  }
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === user.id && candidate.kind === "rider",
  );
  const requestId = riderSubmitRequestId(user.id, idempotencyKey);
  const replay = eventForRequest(store, requestId);
  if (replay) {
    if (replay.snapshot?.requestPayloadHash !== payloadHash(body)) {
      fail(409, "approval_state_conflict", "This idempotency key already submitted different rider input. Refresh the case.", {
        approvalCase: caseProjection(approvalCase),
      });
    }
    return { approvalCase: replay.snapshot.approvalCase, replay: true };
  }
  if (!approvalCase || approvalCase.status !== "pending") {
    fail(409, "approval_state_conflict", "Only a pending rider application can be submitted.", {
      approvalCase: caseProjection(approvalCase),
    });
  }
  if (body.expectedVersion !== approvalCase.version) {
    fail(409, "approval_state_conflict", "Refresh the rider application and submit its current version.", {
      approvalCase: caseProjection(approvalCase),
    });
  }
  if (approvalCase.submittedAt) {
    fail(409, "approval_state_conflict", "This rider application is already submitted. Refresh its current state.", {
      approvalCase: caseProjection(approvalCase),
    });
  }
  const at = now();
  assertRiderReady(store, user.id, at, {
    expiredMessage: "Replace the expired driver's licence before submitting the rider application.",
    incompleteMessage: "Attach a current driver's licence photo with a future expiry before submitting the rider application.",
  });
  approvalCase.submittedAt = at;
  approvalCase.updatedAt = at;
  const response = caseProjection(approvalCase);
  store.approvalCaseEvents.push({
    id: createId("ace"),
    approvalCaseId: approvalCase.id,
    applicationRevision: approvalCase.applicationRevision,
    fromStatus: "pending",
    toStatus: "pending",
    actorUserId: user.id,
    actorKind: "applicant",
    requestId,
    snapshot: { requestPayloadHash: payloadHash(body), approvalCase: response },
    createdAt: at,
  });
  notifySignupAndInvalidate(store, approvalCase, createId, at);
  return { approvalCase: response, replay: false };
}

export function reapplyForApproval({ store, user, pathKind, body, idempotencyKey, createId, now }) {
  const kind = REAPPLY_KINDS.get(pathKind);
  if (!kind) fail(404, "not_found", "That approval application kind does not exist.");
  if (!plainObject(body)) invalidApplication({ body: "must be a JSON object" });
  rejectUnexpected(body, ["expectedVersion", "correctionSummary"]);
  const correctionSummary = nonblank(body.correctionSummary);
  const fields = {};
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion <= 0) {
    fields.expectedVersion = "must be a positive integer";
  }
  if (!correctionSummary) fields.correctionSummary = "is required";
  if (Object.keys(fields).length) invalidApplication(fields);
  if (!(store.userRoleMemberships || []).some(
    (membership) => membership.userId === user.id && membership.role === kind.role,
  )) {
    fail(403, "membership_required", `This action requires the ${kind.role} membership.`, {
      requiredRole: kind.role,
    });
  }
  const requestId = reapplyRequestId(kind.caseKind, user.id, idempotencyKey);
  const replay = eventForRequest(store, requestId);
  const approvalCase = (store.approvalCases || []).find(
    (candidate) => candidate.userId === user.id && candidate.kind === kind.caseKind,
  );
  if (replay) {
    if (replay.snapshot?.requestPayloadHash !== payloadHash(body)) {
      fail(409, "approval_state_conflict", "This idempotency key already reapplied with different input. Refresh the case.", {
        approvalCase: caseProjection(approvalCase),
      });
    }
    return { status: 200, approvalCase, replay: true };
  }
  if (!approvalCase || approvalCase.status !== "rejected" || approvalCase.version !== body.expectedVersion) {
    fail(409, "approval_state_conflict", "Only the current version of a rejected application can be reapplied.", {
      approvalCase: caseProjection(approvalCase),
    });
  }
  const at = now();
  if (kind.caseKind === "rider") {
    assertRiderReady(store, user.id, at, {
      expiredMessage: "Replace the expired driver's licence before reapplying.",
      incompleteMessage: "Attach a current driver's licence photo with a future expiry before reapplying.",
    });
  }
  const previous = caseProjection(approvalCase);
  approvalCase.status = "pending";
  approvalCase.version += 1;
  approvalCase.applicationRevision += 1;
  approvalCase.submittedAt = at;
  approvalCase.updatedAt = at;
  delete approvalCase.decidedAt;
  delete approvalCase.decidedBy;
  delete approvalCase.rejectionReason;
  delete approvalCase.suspensionReason;
  if (user.role === kind.role && ["supplier", "rider"].includes(kind.role)) {
    user.verificationStatus = "pending";
    delete user.verificationNote;
    delete user.verifiedAt;
    delete user.verifiedBy;
  }
  store.approvalCaseEvents.push({
    id: createId("ace"),
    approvalCaseId: approvalCase.id,
    applicationRevision: approvalCase.applicationRevision,
    fromStatus: "rejected",
    toStatus: "pending",
    actorUserId: user.id,
    actorKind: "applicant",
    reason: correctionSummary,
    requestId,
    snapshot: { previous, correctionSummary, requestPayloadHash: payloadHash(body) },
    createdAt: at,
  });
  store.auditLog.push({
    id: createId("aud"),
    at,
    actorId: user.id,
    actorRole: kind.role,
    action: "approval_case.reapply",
    entityType: "approval_case",
    entityId: approvalCase.id,
    detail: { kind: kind.caseKind, correctionSummary, applicationRevision: approvalCase.applicationRevision },
  });
  notifySignupAndInvalidate(store, approvalCase, createId, at);
  return { status: 200, approvalCase, replay: false };
}
