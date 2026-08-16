import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalDecisionInput,
  decideApprovalCase,
  supplierApprovalReadiness,
} from "../src/approval-cases.js";

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
});
