import test from "node:test";
import assert from "node:assert/strict";
import {
  selectActorRole,
  resolveAuthorizationContext,
  identityHasMembership,
} from "../src/authorization-context.js";
import { authorizeFileUpload, authorizeFileAttach, attachFileReference } from "../src/attachments.js";
import { publicOrderFor } from "../src/operational-model.js";

function fixture() {
  return {
    users: [{ id: "admin", role: "super_admin", name: "Admin" }],
    userRoleMemberships: ["super_admin", "client"].map((role) => ({ userId: "admin", role })),
    orders: [{
      id: "order", clientId: "admin", supplierId: "shop", state: "needs_qa",
      supplierSubtotalMinor: 10000, supplierPlatformPayoutMinor: 10000,
      payoutMilestones: [{ code: "printing", amountMinor: 5000 }],
      timeline: [], artworkFileIds: [],
    }],
  };
}

test("file reauthentication preserves selected client authorization and order projection", () => {
  const initial = fixture();
  resolveAuthorizationContext(initial, initial.users[0]);
  const actor = selectActorRole(initial, initial.users[0], "client", { restrictMemberships: true });
  authorizeFileUpload(actor, "artwork");
  const latest = structuredClone(initial);
  const reauthenticated = latest.users[0];
  resolveAuthorizationContext(latest, reauthenticated);
  const latestActor = selectActorRole(latest, reauthenticated, "client", { restrictMemberships: true });
  assert.equal(latestActor.role, "client");
  assert.equal(identityHasMembership(latestActor, "super_admin"), false);
  assert.equal(identityHasMembership(latestActor, "client"), true);
  assert.throws(() => authorizeFileUpload(latestActor, "payment_qr"), { status: 403, code: "forbidden" });
  const file = {
    fileId: "artwork", ownerId: "admin", purpose: "artwork", state: "ready",
    detectedContentType: "application/pdf", objectKey: "private/artwork", size: 100, references: [],
  };
  const target = { type: "order", record: latest.orders[0] };
  authorizeFileAttach(latestActor, file, target);
  assert.throws(() => authorizeFileAttach(latestActor, file, {
    type: "order", record: { ...target.record, clientId: "other" },
  }), { status: 403, code: "forbidden" });
  attachFileReference(file, target);
  const response = publicOrderFor(target.record, latestActor, latest);
  assert.deepEqual(response.artworkFileIds, ["artwork"]);
  assert.equal(Object.hasOwn(response, "supplierPlatformPayoutMinor"), false);
  assert.equal(Object.hasOwn(response, "supplierSubtotalMinor"), false);
  assert.ok(response.payoutMilestones.every((m) => !Object.hasOwn(m, "amountMinor")));
  latestActor.name = "Updated";
  assert.equal(reauthenticated.name, "Updated");
  assert.equal(reauthenticated.role, "super_admin");
});

test("selected roles are revalidated against fresh membership and approval facts", () => {
  const s = fixture();
  s.userRoleMemberships.push({ userId: "admin", role: "supplier" });
  s.approvalCases = [{ userId: "admin", kind: "supplier", status: "pending" }];
  const pending = selectActorRole(s, s.users[0], "supplier", { restrictMemberships: true });
  assert.equal(pending.verificationStatus, "pending");
  const latest = structuredClone(s);
  latest.approvalCases[0].status = "suspended";
  assert.equal(selectActorRole(latest, latest.users[0], "supplier", { restrictMemberships: true }).verificationStatus, "suspended");
  latest.userRoleMemberships = latest.userRoleMemberships.filter((m) => m.role !== "client");
  assert.throws(() => selectActorRole(latest, latest.users[0], "client", { restrictMemberships: true }), { status: 403, code: "forbidden" });
  assert.throws(() => selectActorRole(s, s.users[0], "unknown", { restrictMemberships: true }), { status: 403, code: "forbidden" });
  assert.equal(selectActorRole(s, null, "client", { restrictMemberships: true }), null);
});

test("requests without explicit role retain the primary role and memberships", () => {
  const s = fixture();
  const actor = selectActorRole(s, s.users[0]);
  assert.equal(actor.role, "super_admin");
  assert.equal(identityHasMembership(actor, "client"), true);
  assert.equal(identityHasMembership(actor, "super_admin"), true);
  assert.equal(publicOrderFor(s.orders[0], actor, s).supplierPlatformPayoutMinor, 10000);
});
