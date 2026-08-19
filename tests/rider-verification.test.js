import test from "node:test";
import assert from "node:assert/strict";

import {
  assertRiderApprovalReady,
  assertRiderLegacyVerificationReady,
  EnrollmentError,
} from "../src/enrollment.js";

const AT = "2026-08-19T05:00:00.000Z";

function riderStore(overrides = {}) {
  return {
    riderProfiles: [{
      userId: "user_rider",
      vehicleType: "motorcycle",
      plateNumber: "ABC 1234",
      licenseNumber: "N01-1234",
      updatedAt: AT,
    }],
    riderDocuments: [],
    files: [],
    approvalCases: [{
      id: "apc_rider",
      userId: "user_rider",
      kind: "rider",
      status: "pending",
      version: 1,
      submittedAt: null,
    }],
    ...overrides,
  };
}

test("canonical rider approval still requires a submitted case and a licence file", () => {
  assert.throws(
    () => assertRiderApprovalReady(riderStore(), "user_rider", AT),
    (error) => error instanceof EnrollmentError && error.code === "rider_documents_incomplete",
  );
});

test("legacy verification accepts a typed licence number when no file was ever attached", () => {
  assert.doesNotThrow(() => assertRiderLegacyVerificationReady(riderStore(), "user_rider", AT));
});

test("legacy verification still refuses a rider whose licence file was removed", () => {
  const store = riderStore({
    riderDocuments: [{
      id: "rdoc_old",
      riderId: "user_rider",
      kind: "drivers_license",
      fileId: "file_old",
      expiresOn: "2028-01-01",
      isCurrent: false,
    }],
    files: [{ fileId: "file_old", state: "deleted" }],
  });
  assert.throws(
    () => assertRiderLegacyVerificationReady(store, "user_rider", AT),
    (error) => error instanceof EnrollmentError && error.code === "rider_documents_incomplete",
  );
});
