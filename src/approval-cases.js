import {
  advanceSupplierServiceVersion,
  supplierCatalogTransitionReadiness,
  transitionSupplierServiceToLive,
} from "./supplier-catalog.js";

export const APPROVAL_CASE_KINDS = new Set(["business_client", "supplier", "rider"]);
export const APPROVAL_CASE_STATUSES = new Set(["pending", "approved", "rejected", "suspended"]);
export const APPROVAL_DECISIONS = new Set(["approve", "reject", "suspend", "restore"]);

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

export function approvalDecisionInput(action, body) {
  if (!APPROVAL_DECISIONS.has(action)) {
    return { error: "invalid_approval_decision", status: 404 };
  }
  const allowed = new Set(
    action === "approve"
      ? ["expectedVersion", "requestId", "note"]
      : action === "restore"
        ? ["expectedVersion", "requestId", "note"]
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
  return {
    expectedVersion: body.expectedVersion,
    requestId,
    reason: action === "approve" || action === "restore" ? note : reason,
  };
}

function fail(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  throw error;
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
    advanceSupplierServiceVersion(service, at);
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
    transitionSupplierServiceToLive(service, at, actorId);
    delete service.approvalSuspensionPreviousState;
    delete service.approvalSuspensionCaseId;
    advanceSupplierServiceVersion(service, at);
    published.push(service.id);
  }
  return published;
}

export function applySupplierApprovalServiceTransition({
  store,
  approvalCase,
  action,
  actorId,
  at,
  reason,
}) {
  let readiness = null;
  if (["approve", "restore"].includes(action) && approvalCase.kind === "supplier") {
    readiness = supplierCatalogTransitionReadiness(store, approvalCase.userId, {
      restoring: action === "restore",
    });
    if (!readiness.readyForApproval) {
      fail(409, "supplier_profile_incomplete", "Complete the supplier approval checklist before approving.", {
        missing: readiness.missing,
      });
    }
  }
  return {
    readiness,
    publishedServiceIds: ["approve", "restore"].includes(action)
      ? publishSupplierServices(store, approvalCase, readiness?.publishableServiceIds || [], actorId, at)
      : [],
    suspendedServiceIds: action === "suspend"
      ? suspendSupplierServices(store, approvalCase, actorId, at, reason)
      : [],
  };
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

  const serviceOutcome = applySupplierApprovalServiceTransition({
    store,
    approvalCase,
    action,
    actorId: actor.id,
    at,
    reason: input.reason,
  });

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

  const { publishedServiceIds, suspendedServiceIds } = serviceOutcome;
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
    },
    createdAt: at,
  };
  if (!Array.isArray(store.approvalCaseEvents)) store.approvalCaseEvents = [];
  store.approvalCaseEvents.push(event);

  if (!Array.isArray(store.auditLog)) store.auditLog = [];
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
    },
    reason: input.reason || null,
  });

  if (!Array.isArray(store.notifications)) store.notifications = [];
  const notificationType = `approval_${approvalCase.status === "approved" && action === "restore" ? "restored" : approvalCase.status}`;
  const title = {
    approve: "Application approved",
    reject: "Application needs changes",
    suspend: "Account suspended",
    restore: "Account restored",
  }[action];
  store.notifications.push({
    id: createId("ntf"),
    userId: approvalCase.userId,
    type: notificationType,
    title,
    body: "Open GRIDGO to review your current approval status.",
    approvalCaseId: approvalCase.id,
    domainEventKey: `approval_case:${approvalCase.id}:${input.requestId}`,
    read: false,
    at,
  });

  return { approvalCase, event, publishedServiceIds, suspendedServiceIds, replayed: false };
}
