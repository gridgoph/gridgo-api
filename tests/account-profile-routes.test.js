import test from "node:test";
import assert from "node:assert/strict";

import { routeAccountProfile } from "../src/account-profile-routes.js";

const AT = "2026-08-25T10:00:00.000Z";

function fixture(overrides = {}) {
  const user = {
    id: "user_client",
    clerkUserId: "clerk_client",
    email: "client@gridgo.test",
    name: "Client Name",
    phone: "+639171234567",
    role: "client",
    accountType: "individual",
    version: 1,
    createdAt: AT,
    ...overrides,
  };
  return {
    user,
    store: {
      users: [user],
      userRoleMemberships: [{ userId: user.id, role: "client", createdAt: AT }],
      clientAddresses: [],
      auditLog: [],
    },
  };
}

function publicUser(user) {
  const projected = { ...user };
  delete projected.clerkUserId;
  delete projected.profileNameManaged;
  return projected;
}

async function call({ store, user }, method, pathname, body, headers = {}) {
  let sequence = 0;
  return routeAccountProfile({
    req: { method, headers },
    url: new URL(`http://127.0.0.1${pathname}`),
    store,
    user,
    readBody: async () => body,
    createId: (prefix) => `${prefix}_${++sequence}`,
    now: () => AT,
    audit: (target, entry) => target.auditLog.push(entry),
    publicUser,
  });
}

test("PATCH /me updates client fields and bumps the version", async () => {
  const context = fixture();
  const response = await call(context, "PATCH", "/me", {
    expectedVersion: 1,
    name: "Ana Reyes",
    phone: "0918 765 4321",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.name, "Ana Reyes");
  assert.equal(response.body.user.phone, "+639187654321");
  assert.equal(response.body.user.version, 2);
  assert.equal(context.user.profileNameManaged, true);
  assert.equal(context.store.auditLog[0].action, "client_account.update");
});

test("a business profile rejects a missing organization name", async () => {
  const context = fixture({ accountType: "business", orgName: "Current Business" });
  await assert.rejects(
    call(context, "PATCH", "/me", { expectedVersion: 1, orgName: "" }),
    (error) => error.status === 400 && error.code === "invalid_account_profile" && error.details.field === "orgName",
  );
  assert.equal(context.user.version, 1);
  assert.equal(context.user.orgName, "Current Business");
});

test("PATCH /me rejects a stale phone version without changing the profile", async () => {
  const context = fixture({ version: 3 });
  await assert.rejects(
    call(context, "PATCH", "/me", { expectedVersion: 2, name: "Stale Edit" }),
    (error) => error.status === 409
      && error.code === "account_version_conflict"
      && error.details.currentVersion === 3,
  );
  assert.equal(context.user.name, "Client Name");
  assert.equal(context.user.version, 3);
});

test("POST /me/business-apply is idempotent and reuses client addresses", async () => {
  const context = fixture();
  const body = {
    accountType: "business",
    businessName: "GRIDGO Business Customer",
    address: {
      label: "Office",
      addressLine: "123 Rizal Street",
      point: { lat: 7.0731, lng: 125.6128 },
      isDefault: true,
    },
  };

  const first = await call(context, "POST", "/me/business-apply", body);
  const second = await call(context, "POST", "/me/business-apply", body);

  assert.equal(first.status, 200);
  assert.equal(first.body.user.accountType, "business");
  assert.equal(first.body.user.orgName, "GRIDGO Business Customer");
  assert.equal(first.body.user.version, 2);
  assert.equal(second.body.user.version, 2);
  assert.equal(second.mutated, false);
  assert.equal(context.store.clientAddresses.length, 1);
  assert.equal(context.store.auditLog.length, 1);
});

test("an individual remains valid without orgName", async () => {
  const context = fixture({ phone: undefined });
  const response = await call(context, "PATCH", "/me", {
    expectedVersion: 1,
    name: "Personal Client",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.accountType, "individual");
  assert.equal(Object.hasOwn(response.body.user, "orgName"), false);
  assert.equal(response.body.user.version, 2);
});
