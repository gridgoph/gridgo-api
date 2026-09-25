import { resolveCategoryCode } from "./taxonomy.js";
import { assertRiderApprovalReady } from "./enrollment.js";

export const APPROVAL_CASE_KINDS = new Set(["business_client", "supplier", "rider"]);
export const APPROVAL_CASE_STATUSES = new Set(["pending", "approved", "rejected", "suspended"]);
export const APPROVAL_DECISIONS = new Set(["approve", "reject", "suspend", "restore"]);

/**
 * The legacy `POST /users/:id/verification` route marks the live lines it
 * suspends with this reason when the approver gave none.
 */
export const LEGACY_ACCOUNT_SUSPEND_REASON = "supplier_verification_suspended";

// Lines the legacy route suspended carry no case tag. Its line writes and its
// case event come from separate clock reads inside one request.
const LEGACY_SUSPENSION_MATCH_MS = 5000;

const DECISION_TRANSITIONS = {
  approve: { from: "pending", to: "approved" },
  reject: { from: "pending", to: "rejected" },
  suspend: { from: "approved", to: "suspended" },
  restore: { from: "suspended", to: "approved" },
};

// Mirrors the deferred approval_cases_matching_membership_trigger: a decision
// on a case whose applicant lost the matching membership could never commit.
const CASE_KIND_MEMBERSHIP_ROLE = {
  business_client: "client",
  supplier: "supplier",
  rider: "rider",
};

function nonblank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function activeCategory(store, code) {
  const category = resolveCategoryCode(store.taxonomy, code);
  return category?.active !== false ? category : null;
}

/**
 * Approval-queue readiness stays on profile + review-ready service lines.
 * Listing completeness is exposed on GET /me/supplier-readiness.
 */
export function supplierApprovalReadiness(store, supplierId) {
  const missing = [];
  const profile = (store.supplierProfiles || []).find((candidate) => candidate.userId === supplierId);
  if (!profile) {
    missing.push("supplier_profile");
  } else {
    if (!nonblank(profile.shopName)) missing.push("shop_name");
    if (!nonblank(profile.contactName)) missing.push("contact_name");
    if (
      !profile.shop ||
      !Number.isFinite(profile.shop.lat) ||
      profile.shop.lat < -90 ||
      profile.shop.lat > 90 ||
      !Number.isFinite(profile.shop.lng) ||
      profile.shop.lng < -180 ||
      profile.shop.lng > 180 ||
      !nonblank(profile.shop.label)
    ) {
      missing.push("shop_location");
    }
  }

  const pendingServices = (store.supplierServices || []).filter(
    (service) => service.supplierId === supplierId && service.state === "pending_verification",
  );
  const publishableServices = pendingServices.filter(
    (service) =>
      Boolean(activeCategory(store, service.categoryCode)) &&
      Boolean(nonblank(service.pricingBasis)) &&
      Number.isSafeInteger(service.referenceRateMinor) &&
      service.referenceRateMinor >= 0 &&
      Number.isSafeInteger(service.turnaroundHours) &&
      service.turnaroundHours > 0,
  );
  if (publishableServices.length === 0) missing.push("review_ready_service_line");

  return {
    readyForApproval: missing.length === 0,
    missing,
    publishableServiceIds: publishableServices.map((service) => service.id),
  };
}

export function approvalDecisionInput(action, body) {
  if (!APPROVAL_DECISIONS.has(action)) {
    return { error: "invalid_approval_decision", status: 404 };
  }
  const allowed = new Set(
    action === "approve"
      ? ["expectedVersion", "requestId", "note"]
      : action === "restore"
        ? ["expectedVersion", "requestId", "note", "restoreServiceIds"]
        : ["expectedVersion", "requestId", "reason"],
  );
  const unexpected = Object.keys(body || {}).find((key) => !allowed.has(key));
  if (unexpected) {
    return {
      error: "unexpected_field",
      status: 400,
      details: { field: unexpected, allowed: [...allowed] },
    };
  }
  if (!Number.isSafeInteger(body?.expectedVersion) || body.expectedVersion <= 0) {
    return { error: "expected_version_required", status: 400 };
  }
  const requestId = nonblank(body?.requestId);
  if (!requestId || requestId.length > 200) {
    return { error: "request_id_required", status: 400 };
  }
  const reason = nonblank(body?.reason);
  const note = nonblank(body?.note);
  if (action === "reject" && !reason) return { error: "reason_required", status: 400 };
  if (action === "suspend" && !reason) return { error: "reason_required", status: 400 };
  if (action === "restore" && !note) return { error: "note_required", status: 400 };
  let restoreServiceIds = [];
  if (action === "restore" && body.restoreServiceIds !== undefined) {
    const ids = body.restoreServiceIds;
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every((value) => nonblank(value))) {
      return { error: "invalid_restore_service_ids", status: 400 };
    }
    restoreServiceIds = [...new Set(ids.map((value) => value.trim()))];
  }
  return {
    expectedVersion: body.expectedVersion,
    requestId,
    reason: action === "approve" || action === "restore" ? note : reason,
    ...(action === "restore" ? { restoreServiceIds } : {}),
  };
}

function fail(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  throw error;
}

export function latestApplicantSnapshot(store, caseId) {
  const events = (store.approvalCaseEvents || [])
    .filter((event) => event.approvalCaseId === caseId && event.actorKind === "applicant")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const snapshot = events.at(-1)?.snapshot || {};
  const rest = { ...snapshot };
  delete rest.requestPayloadHash;
  return rest;
}

export function businessApplicationProjection(store, approvalCase) {
  const snapshot = latestApplicantSnapshot(store, approvalCase.id);
  const profile = (store.clientProfiles || []).find((candidate) => candidate.userId === approvalCase.userId);
  const accountType = snapshot.accountType === "organization" ? "organization" : "business";
  return {
    businessName: nonblank(snapshot.businessName) || nonblank(profile?.businessName) || null,
    businessNature: nonblank(snapshot.businessNature) || nonblank(profile?.businessNature) || null,
    accountType,
  };
}

function applyBusinessClientConversion(store, approvalCase, at) {
  if (approvalCase.kind !== "business_client") return;
  const application = businessApplicationProjection(store, approvalCase);
  const user = (store.users || []).find((candidate) => candidate.id === approvalCase.userId);
  if (user && (user.role === "client" || (store.userRoleMemberships || []).some(
    (membership) => membership.userId === user.id && membership.role === "client",
  ))) {
    user.accountType = application.accountType;
    if (application.businessName) user.orgName = application.businessName;
    user.version = (user.version || 1) + 1;
  }
  const profile = (store.clientProfiles || []).find((candidate) => candidate.userId === approvalCase.userId);
  if (profile) {
    profile.clientKind = "business";
    if (application.businessName) profile.businessName = application.businessName;
    if (application.businessNature) profile.businessNature = application.businessNature;
    profile.updatedAt = at;
  } else if (application.businessName) {
    store.clientProfiles ||= [];
    store.clientProfiles.push({
      userId: approvalCase.userId,
      clientKind: "business",
      businessName: application.businessName,
      businessNature: application.businessNature,
      updatedAt: at,
    });
  }
}

function updateLegacyVerification(store, approvalCase, action, actorId, at, reason) {
  if (!new Set(["supplier", "rider"]).has(approvalCase.kind)) return;
  const user = (store.users || []).find((candidate) => candidate.id === approvalCase.userId);
  if (!user || user.role !== approvalCase.kind) return;
  user.verificationStatus = approvalCase.status;
  user.verificationNote = reason || null;
  if (approvalCase.status === "approved") {
    user.verifiedAt = at;
    user.verifiedBy = actorId;
  } else if (action === "reject" || action === "suspend") {
    delete user.verifiedAt;
    delete user.verifiedBy;
  }
}

function withinLegacyWindow(left, right) {
  const distance = Math.abs(Date.parse(left) - Date.parse(right));
  return Number.isFinite(distance) && distance <= LEGACY_SUSPENSION_MATCH_MS;
}

/**
 * Whether this line went down with the account rather than on its own.
 * Canonical and (from now on) legacy account suspensions tag the line with the
 * case. Older legacy suspensions are recognised by their fixed reason, or by
 * the same approver, reason, and moment as a suspend/reject event on the case.
 * A line Operations suspended individually is never one of these.
 */
export function suspendedWithAccount(store, approvalCase, service) {
  if (!approvalCase || approvalCase.kind !== "supplier") return false;
  if (!service || service.supplierId !== approvalCase.userId || service.state !== "suspended") return false;
  if (service.approvalSuspensionCaseId) return service.approvalSuspensionCaseId === approvalCase.id;
  if (service.suspendReason === LEGACY_ACCOUNT_SUSPEND_REASON) return true;
  const reason = nonblank(service.suspendReason);
  if (!reason || !service.suspendedAt) return false;
  return (store.approvalCaseEvents || []).some(
    (event) =>
      event.approvalCaseId === approvalCase.id &&
      event.actorKind === "approver" &&
      (event.toStatus === "suspended" || event.toStatus === "rejected") &&
      event.actorUserId === service.suspendedBy &&
      event.reason === reason &&
      withinLegacyWindow(event.createdAt, service.suspendedAt),
  );
}

function restoreSupplierServices(store, approvalCase, serviceIds, context) {
  const { actorId, actorRole, at, note, requestId, createId } = context;
  const restored = [];
  for (const serviceId of serviceIds) {
    const service = store.supplierServices.find((candidate) => candidate.id === serviceId);
    const suspension = {
      suspendedAt: service.suspendedAt ?? null,
      suspendedBy: service.suspendedBy ?? null,
      suspendReason: service.suspendReason ?? null,
    };
    const restoredState = service.approvalSuspensionPreviousState || "live";
    service.state = restoredState;
    service.suspendedAt = null;
    service.suspendedBy = null;
    service.suspendReason = null;
    delete service.approvalSuspensionPreviousState;
    delete service.approvalSuspensionCaseId;
    service.updatedAt = at;
    store.auditLog.push({
      id: createId("aud"),
      at,
      actorId,
      actorRole,
      action: "service.restore",
      entityType: "supplier_service",
      entityId: service.id,
      detail: {
        approvalCaseId: approvalCase.id,
        requestId,
        from: "suspended",
        to: restoredState,
        suspension,
      },
      reason: note,
    });
    restored.push(service.id);
  }
  return restored;
}

function suspendSupplierServices(store, approvalCase, actorId, at, reason) {
  if (approvalCase.kind !== "supplier") return [];
  const suspended = [];
  for (const service of store.supplierServices || []) {
    if (service.supplierId !== approvalCase.userId || service.state !== "live") continue;
    service.approvalSuspensionPreviousState = "live";
    service.approvalSuspensionCaseId = approvalCase.id;
    service.state = "suspended";
    service.suspendedAt = at;
    service.suspendedBy = actorId;
    service.suspendReason = reason;
    service.updatedAt = at;
    suspended.push(service.id);
  }
  return suspended;
}

function publishSupplierServices(store, approvalCase, serviceIds, actorId, at) {
  if (approvalCase.kind !== "supplier") return [];
  const selected = new Set(serviceIds);
  const published = [];
  for (const service of store.supplierServices || []) {
    if (!selected.has(service.id)) continue;
    service.state = "live";
    service.verifiedAt = at;
    service.verifiedBy = actorId;
    service.suspendedAt = null;
    service.suspendedBy = null;
    service.suspendReason = null;
    service.updatedAt = at;
    published.push(service.id);
  }
  return published;
}

export function decideApprovalCase({
  store,
  caseId,
  action,
  input,
  actor,
  actorRole,
  at,
  createId,
}) {
  const priorEvent = (store.approvalCaseEvents || []).find((event) => event.requestId === input.requestId);
  if (priorEvent) {
    if (priorEvent.approvalCaseId !== caseId || priorEvent.snapshot?.action !== action) {
      fail(409, "request_id_conflict", "That requestId already belongs to a different approval decision.");
    }
    const approvalCase = (store.approvalCases || []).find((candidate) => candidate.id === caseId);
    return {
      approvalCase,
      event: priorEvent,
      publishedServiceIds: priorEvent.snapshot?.publishedServiceIds || [],
      suspendedServiceIds: priorEvent.snapshot?.suspendedServiceIds || [],
      restoredServiceIds: priorEvent.snapshot?.restoredServiceIds || [],
      replayed: true,
    };
  }

  const approvalCase = (store.approvalCases || []).find((candidate) => candidate.id === caseId);
  if (!approvalCase) fail(404, "approval_case_not_found", "That approval case no longer exists.");
  const requiredRole = CASE_KIND_MEMBERSHIP_ROLE[approvalCase.kind];
  const holdsMembership = (store.userRoleMemberships || []).some(
    (membership) => membership.userId === approvalCase.userId && membership.role === requiredRole,
  );
  if (!holdsMembership) {
    fail(409, "approval_case_role_mismatch", `The applicant no longer holds the ${requiredRole} role this case verifies.`, {
      approvalCase,
      requiredRole,
    });
  }
  const transition = DECISION_TRANSITIONS[action];
  if (approvalCase.status !== transition.from) {
    if (approvalCase.version !== input.expectedVersion) {
      fail(
        409,
        "approval_already_decided",
        "Another approver committed a decision first. Refresh the approval case.",
        { approvalCase },
      );
    }
    fail(409, "invalid_approval_transition", `A ${approvalCase.status} case cannot accept the ${action} decision.`, {
      approvalCase,
      requiredStatus: transition.from,
    });
  }
  if (approvalCase.version !== input.expectedVersion) {
    fail(409, "approval_case_stale", "The approval case changed. Refresh it before deciding.", {
      approvalCase,
    });
  }

  let readiness = null;
  if (action === "approve" && approvalCase.kind === "supplier") {
    readiness = supplierApprovalReadiness(store, approvalCase.userId);
    if (!readiness.readyForApproval) {
      fail(409, "supplier_profile_incomplete", "Complete the supplier approval checklist before approving.", {
        missing: readiness.missing,
      });
    }
  }
  if ((action === "approve" || action === "restore") && approvalCase.kind === "rider") {
    assertRiderApprovalReady(store, approvalCase.userId, at);
  }
  const restoreServiceIds = action === "restore" ? input.restoreServiceIds || [] : [];
  const notRestorable = restoreServiceIds.filter(
    (serviceId) =>
      !suspendedWithAccount(
        store,
        approvalCase,
        (store.supplierServices || []).find((candidate) => candidate.id === serviceId),
      ),
  );
  if (notRestorable.length > 0) {
    fail(
      409,
      "service_not_restorable",
      "Only this account's service lines suspended with the account can come back with it.",
      { serviceIds: notRestorable },
    );
  }

  const fromStatus = approvalCase.status;
  approvalCase.status = transition.to;
  approvalCase.version += 1;
  approvalCase.decidedAt = at;
  approvalCase.decidedBy = actor.id;
  approvalCase.updatedAt = at;
  delete approvalCase.rejectionReason;
  delete approvalCase.suspensionReason;
  if (action === "reject") approvalCase.rejectionReason = input.reason;
  if (action === "suspend") approvalCase.suspensionReason = input.reason;

  const publishedServiceIds = action === "approve"
    ? publishSupplierServices(store, approvalCase, readiness?.publishableServiceIds || [], actor.id, at)
    : [];
  const suspendedServiceIds = action === "suspend"
    ? suspendSupplierServices(store, approvalCase, actor.id, at, input.reason)
    : [];
  if (action === "approve") {
    applyBusinessClientConversion(store, approvalCase, at);
  }
  if (!Array.isArray(store.auditLog)) store.auditLog = [];
  // Restore brings back only the lines the approver named. Anything else that
  // is suspended stays down until it is reviewed through its verify route.
  const restoredServiceIds = restoreSupplierServices(store, approvalCase, restoreServiceIds, {
    actorId: actor.id,
    actorRole,
    at,
    note: input.reason,
    requestId: input.requestId,
    createId,
  });
  updateLegacyVerification(store, approvalCase, action, actor.id, at, input.reason);

  const event = {
    id: createId("ace"),
    approvalCaseId: approvalCase.id,
    applicationRevision: approvalCase.applicationRevision,
    fromStatus,
    toStatus: approvalCase.status,
    actorUserId: actor.id,
    actorKind: "approver",
    ...(input.reason ? { reason: input.reason } : {}),
    requestId: input.requestId,
    snapshot: {
      action,
      version: approvalCase.version,
      publishedServiceIds,
      suspendedServiceIds,
      ...(action === "restore" ? { restoredServiceIds } : {}),
    },
    createdAt: at,
  };
  if (!Array.isArray(store.approvalCaseEvents)) store.approvalCaseEvents = [];
  store.approvalCaseEvents.push(event);

  store.auditLog.push({
    id: createId("aud"),
    at,
    actorId: actor.id,
    actorRole,
    action: `approval_case.${action}`,
    entityType: "approval_case",
    entityId: approvalCase.id,
    detail: {
      from: fromStatus,
      to: approvalCase.status,
      version: approvalCase.version,
      requestId: input.requestId,
      publishedServiceIds,
      suspendedServiceIds,
      ...(action === "restore" ? { restoredServiceIds } : {}),
    },
    reason: input.reason || null,
  });

  if (!Array.isArray(store.notifications)) store.notifications = [];
  const notificationType = `approval_${approvalCase.status === "approved" && action === "restore" ? "restored" : approvalCase.status}`;
  const shopBack = restoredServiceIds.length > 0;
  const title = shopBack ? "Your shop is back on GRIDGO" : {
    approve: "Application approved",
    reject: "Application needs changes",
    suspend: "Account suspended",
    restore: "Account restored",
  }[action];
  const lines = `${restoredServiceIds.length} service line${restoredServiceIds.length === 1 ? "" : "s"}`;
  store.notifications.push({
    id: createId("ntf"),
    userId: approvalCase.userId,
    type: notificationType,
    title,
    body: shopBack
      ? `Your account and ${lines} can take new orders again.`
      : "Open GRIDGO to review your current approval status.",
    approvalCaseId: approvalCase.id,
    domainEventKey: `approval_case:${approvalCase.id}:${input.requestId}`,
    read: false,
    at,
  });

  return { approvalCase, event, publishedServiceIds, suspendedServiceIds, restoredServiceIds, replayed: false };
}
