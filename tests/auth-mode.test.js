import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  activateClerkClientProfile,
  authConfiguration,
  authenticateBearerToken,
  clientEmailAvailable,
} from "../src/auth.js";

const ISSUER = "https://casual-crab-9.clerk.accounts.dev";
const AUTHORIZED_PARTY = "http://localhost:19006";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" });

const COMPLETE_ENV = {
  CLERK_SECRET_KEY: "test-only-placeholder",
  CLERK_ISSUER: ISSUER,
  CLERK_AUTHORIZED_PARTIES: AUTHORIZED_PARTY,
  CLERK_JWT_KEY: JWT_KEY,
};

function signToken(overrides = {}) {
  const current = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gridgo-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: "clerk_client",
    sid: "sess_gridgo_test",
    azp: AUTHORIZED_PARTY,
    iat: current - 5,
    nbf: current - 5,
    exp: current + 300,
    ...overrides,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

test("Clerk configuration is mandatory and AUTH_MODE is removed", () => {
  assert.throws(() => authConfiguration({}), /CLERK_SECRET_KEY is required/);
  assert.throws(() => authConfiguration({ ...COMPLETE_ENV, AUTH_MODE: "legacy" }), /AUTH_MODE has been removed/);
  assert.throws(() => authConfiguration({ ...COMPLETE_ENV, AUTH_MODE: "dual" }), /AUTH_MODE has been removed/);
  assert.throws(() => authConfiguration({ ...COMPLETE_ENV, AUTH_MODE: "clerk" }), /AUTH_MODE has been removed/);
  for (const variable of ["CLERK_SECRET_KEY", "CLERK_ISSUER", "CLERK_AUTHORIZED_PARTIES"]) {
    const env = { ...COMPLETE_ENV };
    delete env[variable];
    assert.throws(() => authConfiguration(env), new RegExp(`${variable} is required`));
  }
  assert.deepEqual(authConfiguration(COMPLETE_ENV).authorizedParties, [AUTHORIZED_PARTY]);
});

test("verified Clerk subject resolves to the database role without trusting a role claim", async () => {
  const config = authConfiguration(COMPLETE_ENV);
  const store = {
    users: [{ id: "user_client", clerkUserId: "clerk_client", role: "client" }],
    userRoleMemberships: [{ userId: "user_client", role: "client", createdAt: "2026-08-16T00:00:00.000Z" }],
    approvalCases: [],
  };
  const authenticated = await authenticateBearerToken(signToken({ gridgo_role: "super_admin" }), store, config);
  assert.equal(authenticated.status, null);
  assert.equal(authenticated.user.id, "user_client");
  assert.equal(authenticated.user.role, "client");
  assert.deepEqual(authenticated.authorization.memberships, store.userRoleMemberships);

  assert.equal((await authenticateBearerToken(null, store, config)).status, 401);
  assert.equal((await authenticateBearerToken("tok_old_local_session", store, config)).status, 401);
  assert.equal((await authenticateBearerToken(signToken({ sub: "unmapped" }), store, config)).status, 401);
});

test("activation provisions an unmapped Clerk identity as a passwordless client only", async () => {
  const config = authConfiguration(COMPLETE_ENV);
  const store = { users: [] };
  let metadataWrites = 0;
  const clerkBackend = {
    users: {
      getUser: async () => ({
        id: "clerk_client",
        firstName: "Fely",
        lastName: "Cia",
        primaryEmailAddress: { emailAddress: "FELY@example.com" },
        primaryPhoneNumber: { phoneNumber: "+639001234567" },
        publicMetadata: { gridgoRole: "super_admin" },
      }),
      updateUserMetadata: async () => { metadataWrites += 1; },
    },
  };
  const result = await activateClerkClientProfile({
    token: signToken(), store, config, clerkBackend,
    createId: () => "user_new_client", now: () => "2026-08-16T00:00:00.000Z",
  });

  assert.equal(result.status, 200);
  assert.equal(result.user.role, "client");
  assert.equal(result.user.accountType, "individual");
  assert.equal(result.user.email, "fely@example.com");
  assert.equal(Object.hasOwn(result.user, "password"), false);
  assert.equal(metadataWrites, 0);
  assert.deepEqual(store.users, [result.user]);
  assert.deepEqual(store.userRoleMemberships, [{
    userId: "user_new_client", role: "client", createdAt: "2026-08-16T00:00:00.000Z",
  }]);
  assert.deepEqual(store.clientProfiles, [{
    userId: "user_new_client", clientKind: "personal", updatedAt: "2026-08-16T00:00:00.000Z",
  }]);
});

test("activation adds only a client membership to an existing privileged identity", async () => {
  const config = authConfiguration(COMPLETE_ENV);
  const store = {
    users: [{ id: "user_admin", clerkUserId: "clerk_client", email: "admin@example.com", role: "super_admin" }],
    userRoleMemberships: [{ userId: "user_admin", role: "super_admin", createdAt: "2026-08-15T00:00:00.000Z" }],
    clientProfiles: [],
  };
  const result = await activateClerkClientProfile({
    token: signToken(), store, config,
    clerkBackend: { users: { getUser: async () => { throw new Error("must not fetch mapped identity"); } } },
    createId: () => "never", now: () => "2026-08-16T00:00:00.000Z",
  });
  assert.equal(result.status, 200);
  assert.equal(result.user.role, "super_admin");
  assert.equal(result.mutated, true);
  assert.deepEqual(store.userRoleMemberships.map(({ role }) => role), ["super_admin", "client"]);
  assert.equal(store.clientProfiles[0].clientKind, "personal");

  const retry = await activateClerkClientProfile({
    token: signToken(), store, config,
    clerkBackend: { users: { getUser: async () => { throw new Error("must not fetch exact retry"); } } },
    createId: () => "never", now: () => "later",
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.mutated, false);
});

function mappedClientStore() {
  return {
    users: [{ id: "user_client", clerkUserId: "clerk_client", role: "client" }],
    userRoleMemberships: [{ userId: "user_client", role: "client", createdAt: "2026-08-16T00:00:00.000Z" }],
    approvalCases: [],
  };
}

function activationBackend() {
  return {
    users: {
      getUser: async () => ({
        id: "clerk_client",
        firstName: "Fely",
        lastName: "Cia",
        primaryEmailAddress: { emailAddress: "fely@example.com" },
      }),
    },
  };
}

test("session token without azp authenticates and activates", async () => {
  const config = authConfiguration(COMPLETE_ENV);
  const token = signToken({ azp: undefined });
  const authenticated = await authenticateBearerToken(token, mappedClientStore(), config);
  assert.equal(authenticated.status, null);
  assert.equal(authenticated.user.id, "user_client");

  const activated = await activateClerkClientProfile({
    token, store: { users: [] }, config, clerkBackend: activationBackend(),
    createId: () => "user_new_client", now: () => "2026-08-16T00:00:00.000Z",
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.user.id, "user_new_client");
});

test("session token with an unknown azp is rejected", async () => {
  const config = authConfiguration(COMPLETE_ENV);
  const token = signToken({ azp: "https://unknown.example" });
  assert.equal((await authenticateBearerToken(token, mappedClientStore(), config)).status, 401);

  const activated = await activateClerkClientProfile({
    token, store: { users: [] }, config,
    clerkBackend: { users: { getUser: async () => { throw new Error("must not fetch unknown azp"); } } },
    createId: () => "never", now: () => "2026-08-16T00:00:00.000Z",
  });
  assert.equal(activated.status, 401);
});

test("session token with a listed azp still authenticates and activates", async () => {
  const config = authConfiguration(COMPLETE_ENV);
  const token = signToken();
  const authenticated = await authenticateBearerToken(token, mappedClientStore(), config);
  assert.equal(authenticated.status, null);
  assert.equal(authenticated.user.id, "user_client");

  const activated = await activateClerkClientProfile({
    token, store: { users: [] }, config, clerkBackend: activationBackend(),
    createId: () => "user_listed_azp", now: () => "2026-08-16T00:00:00.000Z",
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.user.id, "user_listed_azp");
});

test("client email availability never names the other role", () => {
  const store = {
    users: [
      { id: "user_client", email: "client@gridgo.ph", role: "client" },
      { id: "user_rider", email: "mddprado00290@usep.edu.ph", role: "rider" },
      { id: "user_supplier", email: "shop@gridgo.ph", role: "supplier" },
    ],
  };
  assert.equal(clientEmailAvailable(store, "client@gridgo.ph"), true);
  assert.equal(clientEmailAvailable(store, "CLIENT@gridgo.ph"), true);
  assert.equal(clientEmailAvailable(store, "new.client@gridgo.ph"), true);
  assert.equal(clientEmailAvailable(store, "mddprado00290@usep.edu.ph"), false);
  assert.equal(clientEmailAvailable(store, "shop@gridgo.ph"), false);
  assert.equal(clientEmailAvailable(store, "not-an-email"), false);
});
