import crypto from "node:crypto";

import { clerkClientProfile } from "./auth.js";
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

function validateSupplier(store, body) {
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
  const categories = [];
  if (Array.isArray(body.serviceCategories)) {
    for (const [index, code] of body.serviceCategories.entries()) {
      const category = typeof code === "string" ? resolveCategoryCode(store.taxonomy, code) : null;
      if (!category || category.active === false) {
        fields[`serviceCategories.${index}`] = "must identify an active governed category";
      } else if (!categories.some((item) => item.code === category.code)) {
        categories.push(category);
      }
    }
  }
  if (Object.keys(fields).length) invalidApplication(fields);
  return {
    shopName,
    contactName,
    phone,
    location: { lat: location.lat, lng: location.lng, label },
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

export function enrollSupplier({ store, clerkUserId, clerkUser, body, idempotencyKey, createId, now }) {
  const existing = mappedUser(store, clerkUserId);
  if (existing && exactRetry(store, { kind: "supplier", user: existing, key: idempotencyKey, body })) {
    return retryResult(store, existing, "supplier", "supplier");
  }
  const application = validateSupplier(store, body);
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

export function applyForBusiness({ store, user, body, idempotencyKey, createId, now }) {
  if (!plainObject(body)) invalidApplication({ body: "must be a JSON object" });
  rejectUnexpected(body, ["businessName", "businessNature"]);
  const fields = {};
  const businessName = nonblank(body.businessName);
  const businessNature = nonblank(body.businessNature);
  if (!businessName) fields.businessName = "is required";
  if (!businessNature) fields.businessNature = "is required";
  if (Object.keys(fields).length) invalidApplication(fields);
  if (!(store.userRoleMemberships || []).some(
    (membership) => membership.userId === user.id && membership.role === "client",
  )) {
    fail(403, "membership_required", "Activate ordinary client access before applying for GRIDGO Business.", {
      requiredRole: "client",
    });
  }
  if (exactRetry(store, { kind: "business_client", user, key: idempotencyKey, body })) {
    return retryResult(store, user, "client", "business_client");
  }
  ensureNoCase(store, user.id, "business_client");
  const at = now();
  let profile = (store.clientProfiles || []).find((candidate) => candidate.userId === user.id);
  if (!profile) {
    profile = { userId: user.id, clientKind: "personal", updatedAt: at };
    store.clientProfiles.push(profile);
  }
  Object.assign(profile, { clientKind: "business", businessName, businessNature, updatedAt: at });
  if (user.role === "client") {
    user.accountType = "business";
    user.orgName = businessName;
  }
  const approvalCase = addInitialCase(store, {
    user, kind: "business_client", submittedAt: at, key: idempotencyKey, body, createId, at,
    snapshot: { businessName, businessNature },
  });
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

export function assertRiderApprovalReady(store, userId, at) {
  if (!currentFutureLicense(store, userId, manilaDate(at))) {
    fail(
      409,
      "rider_documents_incomplete",
      "A ready current driver's licence with a future expiry is required before approving this rider.",
      { missing: ["drivers_license"] },
    );
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
  const at = now();
  if (!approvalCase.submittedAt) {
    const today = manilaDate(at);
    const anyLicense = (store.riderDocuments || []).find(
      (document) => document.riderId === user.id
        && document.kind === "drivers_license"
        && document.isCurrent !== false,
    );
    if (anyLicense && anyLicense.expiresOn <= today) {
      fail(409, "document_expired", "Replace the expired driver's licence before submitting the rider application.");
    }
    if (!currentFutureLicense(store, user.id, today)) {
      fail(
        409,
        "rider_documents_incomplete",
        "Attach a current driver's licence photo with a future expiry before submitting the rider application.",
        { missing: ["drivers_license"] },
      );
    }
    approvalCase.submittedAt = at;
    approvalCase.updatedAt = at;
  }
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
    const today = manilaDate(at);
    const currentLicense = (store.riderDocuments || []).find(
      (document) => document.riderId === user.id
        && document.kind === "drivers_license"
        && document.isCurrent !== false,
    );
    if (currentLicense && currentLicense.expiresOn <= today) {
      fail(409, "document_expired", "Replace the expired driver's licence before reapplying.");
    }
    if (!currentFutureLicense(store, user.id, today)) {
      fail(
        409,
        "rider_documents_incomplete",
        "Attach a current driver's licence photo with a future expiry before reapplying.",
        { missing: ["drivers_license"] },
      );
    }
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
  return { status: 200, approvalCase, replay: false };
}
