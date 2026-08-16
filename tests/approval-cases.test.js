import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalDecisionInput,
  decideApprovalCase,
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
      categories: [{
        id: "category", code: "print", name: "Print", active: true,
        productFamilyIds: ["poster"],
      }],
      categoryAliases: [],
      materials: [{ code: "paper", categoryCodes: ["print"], active: true }],
      finishes: [{ code: "matte", categoryCodes: ["print"], active: true }],
    },
    zones: [{ code: "davao_central", active: true }],
    supplierServices: [{
      id: "service_complete",
      supplierId: "supplier",
      categoryCode: "print",
      pricingBasis: "per_unit",
      referenceRateMinor: 1000,
      turnaroundHours: 24,
      materialCodes: ["paper"],
      finishCodes: ["matte"],
      productFamilyIds: ["poster"],
      zones: ["davao_central"],
      state: "pending_verification",
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    }],
    supplierPaymentTerms: [{
      supplierId: "supplier",
      deliveryDownpaymentRateBps: 0,
      pickupFullOnlineEnabled: true,
      pickupDownpaymentStoreEnabled: false,
      updatedAt: AT,
    }],
    acceptedFileFormats: [{ code: "pdf", displayName: "PDF", inputKind: "file", active: true }],
    supplierServiceFileFormats: [{ supplierServiceId: "service_complete", formatCode: "pdf" }],
    catalogItems: [{
      id: "item_complete",
      supplierId: "supplier",
      supplierServiceId: "service_complete",
      name: "Poster",
      description: "",
      basePriceMinor: 1000,
      fileFormatMode: "inherit",
      active: true,
      sortOrder: 0,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    }],
    catalogItemFileFormats: [],
    catalogOptionGroups: [],
    catalogOptions: [],
    files: [
      { fileId: "photo", state: "ready", objectKey: "catalog/photo.jpg" },
      { fileId: "logo", state: "ready", objectKey: "catalog/logo.png" },
    ],
    catalogItemPhotos: [{ catalogItemId: "item_complete", fileId: "photo", sortOrder: 0, createdAt: AT }],
    supplierShopMedia: [{ supplierId: "supplier", slot: "logo", fileId: "logo", updatedAt: AT }],
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

test("supplier approve, suspend, and restore enforce readiness and service versions", () => {
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
  assert.equal(store.supplierServices[0].version, 2);
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
  assert.equal(store.supplierServices[0].version, 3);
  assert.equal(store.supplierServices[0].approvalSuspensionPreviousState, "live");

  store.catalogItemPhotos.length = 0;
  assert.throws(
    () => decideApprovalCase({
      store,
      caseId: "case_supplier",
      action: "restore",
      input: { expectedVersion: 3, requestId: "request_restore_blocked", reason: "Account cleared" },
      actor,
      actorRole: "ops_admin",
      at: AT,
      createId,
    }),
    (error) => error.status === 409
      && error.code === "supplier_profile_incomplete"
      && error.details.missing.includes("active_catalog_item"),
  );
  assert.equal(store.approvalCases[0].status, "suspended");
  assert.equal(store.supplierServices[0].version, 3);

  store.catalogItemPhotos.push({ catalogItemId: "item_complete", fileId: "photo", sortOrder: 0, createdAt: AT });
  const restored = decideApprovalCase({
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
  assert.deepEqual(restored.publishedServiceIds, ["service_complete"]);
  assert.equal(store.supplierServices[0].state, "live");
  assert.equal(store.supplierServices[0].version, 4);
  assert.equal(store.supplierServices[0].approvalSuspensionCaseId, undefined);
});
