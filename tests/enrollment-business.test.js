import test from "node:test";
import assert from "node:assert/strict";

import { applyForBusiness } from "../src/enrollment.js";

const AT = "2026-08-16T00:00:00.000Z";

function store() {
  const user = {
    id: "user_client",
    role: "client",
    accountType: "individual",
    name: "Ana",
    version: 1,
  };
  return {
    user,
    store: {
      users: [user],
      userRoleMemberships: [{ userId: user.id, role: "client", createdAt: AT }],
      clientProfiles: [{ userId: user.id, clientKind: "personal", updatedAt: AT }],
      approvalCases: [],
      approvalCaseEvents: [],
      notifications: [],
      auditLog: [],
    },
  };
}

test("applyForBusiness opens a pending case and leaves the account personal", () => {
  const context = store();
  let sequence = 0;
  const result = applyForBusiness({
    store: context.store,
    user: context.user,
    body: {
      businessName: "Bautista Trading",
      businessNature: "Corporate merchandise",
      accountType: "organization",
    },
    idempotencyKey: "apply-1",
    createId: (prefix) => `${prefix}_${++sequence}`,
    now: () => AT,
  });

  assert.equal(result.status, 201);
  assert.equal(result.approvalCase.kind, "business_client");
  assert.equal(result.approvalCase.status, "pending");
  assert.equal(context.user.accountType, "individual");
  assert.equal(Object.hasOwn(context.user, "orgName"), false);
  assert.equal(result.clientProfile.clientKind, "personal");
  // The requested name is held on the application event, never on the still
  // personal profile, so a rejected application leaves nothing behind.
  assert.equal(result.clientProfile.businessName ?? null, null);
  assert.equal(context.store.approvalCaseEvents[0].snapshot.businessName, "Bautista Trading");
  assert.equal(context.store.approvalCaseEvents[0].snapshot.accountType, "organization");
});

test("applyForBusiness retries the same idempotency key without opening a second case", () => {
  const context = store();
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${++sequence}`;
  const input = {
    store: context.store,
    user: context.user,
    body: { businessName: "Bautista Trading", businessNature: "Events" },
    idempotencyKey: "apply-1",
    createId,
    now: () => AT,
  };
  const first = applyForBusiness(input);
  const second = applyForBusiness(input);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.approvalCase.id, first.approvalCase.id);
  assert.equal(context.store.approvalCases.length, 1);
  assert.equal(context.user.accountType, "individual");
});
