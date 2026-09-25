import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalDecisionInput,
  decideApprovalCase,
  supplierApprovalReadiness,
  suspendedWithAccount,
} from "../src/approval-cases.js";
import { notifyOpsSignupSubmitted } from "../src/client-order-notifications.js";

const AT = "2026-08-16T00:00:00.000Z";

function supplierStore() {
  return {
    users: [{ id: "supplier", role: "supplier", verificationStatus: "pending" }],
    userRoleMemberships: [{ userId: "supplier", role: "supplier", createdAt: AT }],
    supplierProfiles: [{
      userId: "supplier",
      shopName: "Print Shop",
      contactName: "Sam Supplier",
      shop: { lat: 7.064, lng: 125.6085, label: "Davao Shop" },
    }],
    taxonomy: {
      categories: [{ id: "category", code: "print", name: "Print", active: true }],
      categoryAliases: [],
    },
    supplierServices: [{
      id: "service_complete",
      supplierId: "supplier",
      categoryCode: "print",
      pricingBasis: "per_unit",
      referenceRateMinor: 1000,
      turnaroundHours: 24,
      state: "pending_verification",
      createdAt: AT,
      updatedAt: AT,
    }],
    approvalCases: [{
      id: "case_supplier",
      userId: "supplier",
      kind: "supplier",
      status: "pending",
      version: 1,
      applicationRevision: 1,
      submittedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    }],
    approvalCaseEvents: [],
    auditLog: [],
    notifications: [],
  };
}

test("supplier approval readiness publishes only complete submitted service lines", () => {
  const store = supplierStore();
  store.supplierServices.push({
    ...store.supplierServices[0],
    id: "service_incomplete",
    pricingBasis: "",
  });
  assert.deepEqual(supplierApprovalReadiness(store, "supplier"), {
    readyForApproval: true,
    missing: [],
    publishableServiceIds: ["service_complete"],
  });

  store.supplierServices[0].state = "draft";
  assert.deepEqual(supplierApprovalReadiness(store, "supplier"), {
    readyForApproval: false,
    missing: ["review_ready_service_line"],
    publishableServiceIds: [],
  });
});

test("approval decision input is strict and requires transition-specific explanations", () => {
  assert.equal(approvalDecisionInput("reject", { expectedVersion: 1, requestId: "r", reason: " " }).error, "reason_required");
  assert.equal(approvalDecisionInput("suspend", { expectedVersion: 1, requestId: "r" }).error, "reason_required");
  assert.equal(approvalDecisionInput("restore", { expectedVersion: 1, requestId: "r", note: " " }).error, "note_required");
  assert.equal(approvalDecisionInput("approve", { expectedVersion: 1, requestId: "r", commission: 10 }).error, "unexpected_field");
  assert.deepEqual(
    approvalDecisionInput("approve", { expectedVersion: 1, requestId: " r ", note: " ready " }),
    { expectedVersion: 1, requestId: "r", reason: "ready" },
  );
});

test("decisions on cases whose applicant lost the matching membership fail with 409", () => {
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${sequence += 1}`;
  const actor = { id: "ops", role: "client" };

  const store = supplierStore();
  store.approvalCases[0].status = "approved";
  store.users[0] = { id: "supplier", role: "client", accountType: "individual" };
  store.userRoleMemberships = [{ userId: "supplier", role: "client", createdAt: AT }];
  assert.throws(
    () => decideApprovalCase({
      store,
      caseId: "case_supplier",
      action: "suspend",
      input: { expectedVersion: 1, requestId: "request_demoted", reason: "Post-departure review" },
      actor,
      actorRole: "ops_admin",
      at: AT,
      createId,
    }),
    (error) => error.status === 409 && error.code === "approval_case_role_mismatch",
  );
  assert.equal(store.approvalCases[0].status, "approved");
  assert.equal(store.approvalCases[0].version, 1);
  assert.equal(Object.hasOwn(store.users[0], "verificationStatus"), false);
  assert.equal(store.approvalCaseEvents.length, 0);
  assert.equal(store.notifications.length, 0);
});

test("legacy verification stays untouched when the legacy role diverges from the case kind", () => {
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${sequence += 1}`;
  const actor = { id: "ops", role: "client" };

  const store = supplierStore();
  store.approvalCases[0].status = "approved";
  store.users[0] = {
    id: "supplier",
    role: "rider",
    verificationStatus: "approved",
    verifiedAt: AT,
    verifiedBy: "ops_original",
  };
  store.userRoleMemberships = [
    { userId: "supplier", role: "supplier", createdAt: AT },
    { userId: "supplier", role: "rider", createdAt: AT },
  ];
  const suspended = decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "suspend",
    input: { expectedVersion: 1, requestId: "request_switched", reason: "Supplier case review" },
    actor,
    actorRole: "ops_admin",
    at: AT,
    createId,
  });
  assert.equal(suspended.approvalCase.status, "suspended");
  assert.equal(store.users[0].verificationStatus, "approved");
  assert.equal(store.users[0].verifiedAt, AT);
  assert.equal(store.users[0].verifiedBy, "ops_original");
});

test("supplier approve, suspend, and restore preserve explicit service review", () => {
  const store = supplierStore();
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${sequence += 1}`;
  const actor = { id: "ops", role: "client" };

  const approved = decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "approve",
    input: { expectedVersion: 1, requestId: "request_approve", reason: null },
    actor,
    actorRole: "ops_admin",
    at: AT,
    createId,
  });
  assert.equal(approved.approvalCase.status, "approved");
  assert.equal(approved.approvalCase.version, 2);
  assert.deepEqual(approved.publishedServiceIds, ["service_complete"]);
  assert.equal(store.supplierServices[0].state, "live");
  assert.equal(store.notifications.length, 1);

  const replayed = decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "approve",
    input: { expectedVersion: 1, requestId: "request_approve", reason: null },
    actor,
    actorRole: "ops_admin",
    at: AT,
    createId,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(store.approvalCaseEvents.length, 1);
  assert.equal(store.notifications.length, 1);

  decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "suspend",
    input: { expectedVersion: 2, requestId: "request_suspend", reason: "Safety review" },
    actor,
    actorRole: "ops_admin",
    at: AT,
    createId,
  });
  assert.equal(store.supplierServices[0].state, "suspended");
  assert.equal(store.supplierServices[0].approvalSuspensionPreviousState, "live");

  decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "restore",
    input: { expectedVersion: 3, requestId: "request_restore", reason: "Account cleared" },
    actor,
    actorRole: "ops_admin",
    at: AT,
    createId,
  });
  assert.equal(store.approvalCases[0].status, "approved");
  assert.equal(store.supplierServices[0].state, "suspended");
  assert.deepEqual(store.approvalCaseEvents.at(-1).snapshot.restoredServiceIds, []);
  assert.equal(store.notifications.at(-1).title, "Account restored");
  assert.equal(store.auditLog.some((entry) => entry.action === "service.restore"), false);
});

const SUSPENDED_AT = "2026-09-18T03:00:00.000Z";

/**
 * A supplier suspended the way Dara Blueprint was: an approved account taken
 * down, one line with it, plus lines that must never come back with it.
 */
function suspendedSupplierStore() {
  const store = supplierStore();
  Object.assign(store.approvalCases[0], {
    status: "suspended",
    version: 3,
    decidedAt: SUSPENDED_AT,
    decidedBy: "ops",
    suspensionReason: "Unpaid penalty",
  });
  const line = (id, extra) => ({
    ...store.supplierServices[0],
    id,
    state: "suspended",
    suspendedAt: SUSPENDED_AT,
    suspendedBy: "ops",
    ...extra,
  });
  store.supplierServices = [
    line("svc_tagged", {
      suspendReason: "Unpaid penalty",
      approvalSuspensionPreviousState: "live",
      approvalSuspensionCaseId: "case_supplier",
    }),
    line("svc_legacy", { suspendReason: "supplier_verification_suspended" }),
    line("svc_individual", { suspendReason: "Blurry sample photos", suspendedAt: "2026-09-10T00:00:00.000Z" }),
    { ...store.supplierServices[0], id: "svc_draft", state: "draft" },
    { ...line("svc_other_supplier", { suspendReason: "supplier_verification_suspended" }), supplierId: "someone_else" },
  ];
  return store;
}

function restoreInput(restoreServiceIds, requestId = "request_restore_lines") {
  return { expectedVersion: 3, requestId, reason: "Penalty settled", restoreServiceIds };
}

test("restore input accepts restoreServiceIds only on restore and only as ids", () => {
  const base = { expectedVersion: 3, requestId: "r", note: "Penalty settled" };
  assert.deepEqual(approvalDecisionInput("restore", base).restoreServiceIds, []);
  assert.deepEqual(
    approvalDecisionInput("restore", { ...base, restoreServiceIds: [" svc_a ", "svc_a", "svc_b"] }).restoreServiceIds,
    ["svc_a", "svc_b"],
  );
  for (const invalid of ["svc_a", [""], [7], null]) {
    assert.equal(
      approvalDecisionInput("restore", { ...base, restoreServiceIds: invalid }).error,
      "invalid_restore_service_ids",
    );
  }
  assert.equal(
    approvalDecisionInput("suspend", { expectedVersion: 2, requestId: "r", reason: "x", restoreServiceIds: [] }).error,
    "unexpected_field",
  );
});

test("only lines that went down with the account count as suspended with it", () => {
  const store = suspendedSupplierStore();
  const approvalCase = store.approvalCases[0];
  const flagged = Object.fromEntries(
    store.supplierServices.map((service) => [service.id, suspendedWithAccount(store, approvalCase, service)]),
  );
  assert.deepEqual(flagged, {
    svc_tagged: true,
    svc_legacy: true,
    svc_individual: false,
    svc_draft: false,
    svc_other_supplier: false,
  });

  // A legacy suspension that carried a typed reason predates the case tag;
  // it matches the suspend event written by the same approver in that request.
  store.supplierServices[2].suspendReason = "Unpaid penalty";
  store.supplierServices[2].suspendedAt = "2026-09-18T03:00:00.004Z";
  assert.equal(suspendedWithAccount(store, approvalCase, store.supplierServices[2]), false);
  store.approvalCaseEvents.push({
    id: "ace_legacy", approvalCaseId: "case_supplier", fromStatus: "approved", toStatus: "suspended",
    actorUserId: "ops", actorKind: "approver", reason: "Unpaid penalty", requestId: "acr_legacy",
    snapshot: {}, createdAt: SUSPENDED_AT,
  });
  assert.equal(suspendedWithAccount(store, approvalCase, store.supplierServices[2]), true);
  store.supplierServices[2].suspendedBy = "another_ops";
  assert.equal(suspendedWithAccount(store, approvalCase, store.supplierServices[2]), false);
});

test("restore brings back the named lines in the same decision, audited, with one notice", () => {
  const store = suspendedSupplierStore();
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${sequence += 1}`;
  const outcome = decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "restore",
    input: restoreInput(["svc_tagged", "svc_legacy"]),
    actor: { id: "super" },
    actorRole: "super_admin",
    at: AT,
    createId,
  });
  assert.equal(outcome.approvalCase.status, "approved");
  assert.deepEqual(outcome.restoredServiceIds, ["svc_tagged", "svc_legacy"]);
  for (const id of ["svc_tagged", "svc_legacy"]) {
    const service = store.supplierServices.find((candidate) => candidate.id === id);
    assert.equal(service.state, "live");
    assert.equal(service.suspendedAt, null);
    assert.equal(service.suspendedBy, null);
    assert.equal(service.suspendReason, null);
    assert.equal(Object.hasOwn(service, "approvalSuspensionCaseId"), false);
    assert.equal(Object.hasOwn(service, "approvalSuspensionPreviousState"), false);
    assert.equal(service.updatedAt, AT);
  }
  assert.equal(store.supplierServices.find((service) => service.id === "svc_individual").state, "suspended");

  const lineAudits = store.auditLog.filter((entry) => entry.action === "service.restore");
  assert.deepEqual(lineAudits.map((entry) => entry.entityId), ["svc_tagged", "svc_legacy"]);
  for (const entry of lineAudits) {
    assert.equal(entry.entityType, "supplier_service");
    assert.equal(entry.actorId, "super");
    assert.equal(entry.actorRole, "super_admin");
    assert.equal(entry.reason, "Penalty settled");
    assert.equal(entry.detail.approvalCaseId, "case_supplier");
    assert.equal(entry.detail.requestId, "request_restore_lines");
    assert.equal(entry.detail.to, "live");
    assert.equal(entry.detail.suspension.suspendedAt, SUSPENDED_AT);
  }
  const caseAudit = store.auditLog.find((entry) => entry.action === "approval_case.restore");
  assert.deepEqual(caseAudit.detail.restoredServiceIds, ["svc_tagged", "svc_legacy"]);

  assert.equal(store.notifications.length, 1);
  assert.equal(store.notifications[0].userId, "supplier");
  assert.equal(store.notifications[0].type, "approval_restored");
  assert.equal(store.notifications[0].title, "Your shop is back on GRIDGO");

  const replayed = decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "restore",
    input: restoreInput(["svc_tagged", "svc_legacy"]),
    actor: { id: "super" },
    actorRole: "super_admin",
    at: AT,
    createId,
  });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.restoredServiceIds, ["svc_tagged", "svc_legacy"]);
  assert.equal(store.notifications.length, 1);
});

test("restore refuses any id that did not go down with this account, and changes nothing", () => {
  for (const [ids, refused] of [
    [["svc_tagged", "svc_individual"], ["svc_individual"]],
    [["svc_other_supplier"], ["svc_other_supplier"]],
    [["svc_draft", "svc_missing", "svc_legacy"], ["svc_draft", "svc_missing"]],
  ]) {
    const store = suspendedSupplierStore();
    const before = JSON.stringify(store);
    assert.throws(
      () => decideApprovalCase({
        store,
        caseId: "case_supplier",
        action: "restore",
        input: restoreInput(ids),
        actor: { id: "ops" },
        actorRole: "ops_admin",
        at: AT,
        createId: (prefix) => `${prefix}_x`,
      }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "service_not_restorable");
        assert.deepEqual(error.details.serviceIds, refused);
        return true;
      },
    );
    assert.equal(JSON.stringify(store), before);
  }
});

test("a non-supplier restore refuses service ids instead of reaching the user's lines", () => {
  const store = suspendedSupplierStore();
  store.userRoleMemberships.push({ userId: "supplier", role: "client", createdAt: AT });
  store.approvalCases.push({
    id: "case_business", userId: "supplier", kind: "business_client", status: "suspended", version: 3,
    applicationRevision: 1, submittedAt: AT, createdAt: AT, updatedAt: AT,
  });
  assert.throws(
    () => decideApprovalCase({
      store,
      caseId: "case_business",
      action: "restore",
      input: restoreInput(["svc_legacy"], "request_business"),
      actor: { id: "ops" },
      actorRole: "ops_admin",
      at: AT,
      createId: (prefix) => `${prefix}_x`,
    }),
    (error) => error.code === "service_not_restorable",
  );
  assert.equal(store.approvalCases[1].status, "suspended");
  assert.equal(store.supplierServices.find((service) => service.id === "svc_legacy").state, "suspended");
});

test("approving a business-client case flips account type only then", () => {
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${sequence += 1}`;
  const store = {
    users: [{ id: "client", role: "client", accountType: "individual", version: 1 }],
    userRoleMemberships: [{ userId: "client", role: "client", createdAt: AT }],
    clientProfiles: [{
      userId: "client",
      clientKind: "personal",
      businessName: "Bautista Trading",
      businessNature: "Events",
      updatedAt: AT,
    }],
    approvalCases: [{
      id: "case_business",
      userId: "client",
      kind: "business_client",
      status: "pending",
      version: 1,
      applicationRevision: 1,
      submittedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    }],
    approvalCaseEvents: [{
      id: "ace_apply",
      approvalCaseId: "case_business",
      applicationRevision: 1,
      toStatus: "pending",
      actorUserId: "client",
      actorKind: "applicant",
      requestId: "enrollment:business_client:client:key",
      snapshot: {
        businessName: "Bautista Trading",
        businessNature: "Events",
        accountType: "organization",
      },
      createdAt: AT,
    }],
    notifications: [],
    auditLog: [],
  };

  decideApprovalCase({
    store,
    caseId: "case_business",
    action: "approve",
    input: { expectedVersion: 1, requestId: "request_business_approve", reason: null },
    actor: { id: "ops", role: "ops_admin" },
    actorRole: "ops_admin",
    at: AT,
    createId,
  });

  assert.equal(store.approvalCases[0].status, "approved");
  assert.equal(store.users[0].accountType, "organization");
  assert.equal(store.users[0].orgName, "Bautista Trading");
  assert.equal(store.users[0].version, 2);
  assert.equal(store.clientProfiles[0].clientKind, "business");
});

test("approve still notifies only the applicant after ops signup rows exist", () => {
  const store = supplierStore();
  store.userRoleMemberships.push(
    { userId: "ops", role: "ops_admin", createdAt: AT },
    { userId: "admin", role: "super_admin", createdAt: AT },
  );
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${sequence += 1}`;
  notifyOpsSignupSubmitted(store, store.approvalCases[0], { createId, at: AT });
  assert.equal(store.notifications.length, 2);
  assert.ok(store.notifications.every((row) => row.type === "ops_signup_submitted"));

  decideApprovalCase({
    store,
    caseId: "case_supplier",
    action: "approve",
    input: { expectedVersion: 1, requestId: "request_approve_only_applicant", reason: null },
    actor: { id: "ops", role: "ops_admin" },
    actorRole: "ops_admin",
    at: AT,
    createId,
  });
  const after = store.notifications.filter((row) => row.type !== "ops_signup_submitted");
  assert.equal(after.length, 1);
  assert.equal(after[0].userId, "supplier");
  assert.match(after[0].type, /^approval_/);
});
