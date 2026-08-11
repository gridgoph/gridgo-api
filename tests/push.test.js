import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  ANDROID_NOTIFICATION_CHANNEL_ID,
  backfillDeviceTokens,
  classifyFcmFailure,
  createPushDelivery,
  createPushDeliveryOrDisable,
  deviceTokensFor,
  fcmRequestBody,
  loadServiceAccount,
  publicDevice,
  pushMessageFor,
  registerDeviceToken,
  removeDeviceTokenIds,
  signServiceAccountAssertion,
  unregisterDeviceToken,
} from "../src/push.js";

const AT = "2026-08-11T00:00:00.000Z";
const LATER = "2026-08-11T01:00:00.000Z";

/** A throwaway keypair. The captain's real service account never enters a test. */
function testCredentials() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    credentials: {
      projectId: "gridgo-test",
      clientEmail: "push-test@gridgo-test.iam.gserviceaccount.com",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      privateKeyId: "test-key-id",
      tokenUri: "https://oauth2.example.test/token",
    },
    publicKey,
  };
}

function tokenResponse(accessToken = "ya29.test-access-token", expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" }),
  };
}

function fcmResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

const silentLogger = { warn() {} };

// ---------------------------------------------------------------------------
// Store rules
// ---------------------------------------------------------------------------

test("device-token backfill is additive and byte-idempotent", () => {
  const store = { users: [] };
  assert.equal(backfillDeviceTokens(store), true);
  assert.deepEqual(store.deviceTokens, []);
  const afterFirst = JSON.stringify(store);

  assert.equal(backfillDeviceTokens(store), false);
  assert.equal(JSON.stringify(store), afterFirst, "second backfill changed the store");
});

test("re-registering the same token updates one row instead of duplicating it", () => {
  const store = {};
  const first = registerDeviceToken(store, {
    userId: "user_client",
    token: "fcm-token-a",
    platform: "android",
    at: AT,
  });
  assert.equal(first.created, true);
  assert.equal(first.reassignedFrom, null);

  const second = registerDeviceToken(store, {
    userId: "user_client",
    token: "fcm-token-a",
    platform: "android",
    at: LATER,
  });
  assert.equal(second.created, false);
  assert.equal(second.reassignedFrom, null);
  assert.equal(second.device.id, first.device.id);
  assert.equal(store.deviceTokens.length, 1);
  assert.equal(store.deviceTokens[0].createdAt, AT);
  assert.equal(store.deviceTokens[0].updatedAt, LATER);
});

test("a token that reappears under another account changes hands rather than being shared", () => {
  const store = {};
  registerDeviceToken(store, { userId: "user_client", token: "shared-handset", platform: "android", at: AT });
  const moved = registerDeviceToken(store, {
    userId: "user_rider",
    token: "shared-handset",
    platform: "android",
    at: LATER,
  });

  assert.equal(moved.reassignedFrom, "user_client");
  assert.equal(store.deviceTokens.length, 1, "one token must never belong to two users");
  assert.deepEqual(deviceTokensFor(store, "user_client"), []);
  assert.deepEqual(
    deviceTokensFor(store, "user_rider").map(({ token }) => token),
    ["shared-handset"],
  );
});

test("one user keeps several phones, each registered independently", () => {
  const store = {};
  registerDeviceToken(store, { userId: "user_client", token: "phone-1", platform: "android", at: AT });
  registerDeviceToken(store, { userId: "user_client", token: "phone-2", platform: "ios", at: AT });
  registerDeviceToken(store, { userId: "user_rider", token: "phone-3", platform: "android", at: AT });

  assert.deepEqual(
    deviceTokensFor(store, "user_client").map(({ platform }) => platform),
    ["android", "ios"],
  );
  assert.equal(deviceTokensFor(store, "user_rider").length, 1);
});

test("unregister removes only the caller's own token and never a foreign one", () => {
  const store = {};
  registerDeviceToken(store, { userId: "user_client", token: "client-phone", platform: "android", at: AT });
  registerDeviceToken(store, { userId: "user_rider", token: "rider-phone", platform: "android", at: AT });

  const stealing = unregisterDeviceToken(store, { userId: "user_client", token: "rider-phone" });
  assert.equal(stealing.removed, null);
  assert.equal(stealing.changed, false);
  assert.equal(deviceTokensFor(store, "user_rider").length, 1, "a caller must not unregister another phone");

  const own = unregisterDeviceToken(store, { userId: "user_client", token: "client-phone" });
  assert.equal(own.removed.token, "client-phone");
  assert.deepEqual(deviceTokensFor(store, "user_client"), []);

  assert.equal(unregisterDeviceToken(store, { userId: "user_client", token: "client-phone" }).changed, false);
});

test("the public device projection never carries the raw token", () => {
  const store = {};
  const { device } = registerDeviceToken(store, {
    userId: "user_client",
    token: "abcdefghijklmnop",
    platform: "ios",
    at: AT,
  });
  const projected = publicDevice(device);
  assert.deepEqual(Object.keys(projected).sort(), ["createdAt", "id", "platform", "tokenTail", "updatedAt", "userId"]);
  assert.equal(projected.tokenTail, "ijklmnop");
  assert.equal(JSON.stringify(projected).includes("abcdefgh"), false);
});

test("pruning removes exactly the named registrations", () => {
  const store = {};
  const dead = registerDeviceToken(store, { userId: "u", token: "dead", platform: "android", at: AT }).device;
  registerDeviceToken(store, { userId: "u", token: "live", platform: "android", at: AT });

  assert.equal(removeDeviceTokenIds(store, []), 0);
  assert.equal(removeDeviceTokenIds(store, [dead.id]), 1);
  assert.deepEqual(store.deviceTokens.map(({ token }) => token), ["live"]);
  assert.equal(removeDeviceTokenIds(store, [dead.id]), 0, "pruning twice must be a no-op");
});

// ---------------------------------------------------------------------------
// Message shaping and money visibility
// ---------------------------------------------------------------------------

test("push payload carries only allowlisted routing data, never money detail", () => {
  const message = pushMessageFor({
    id: "ntf_1",
    userId: "user_client",
    type: "supplier_assignment_final_price",
    orderId: "ord_1",
    title: "Supplier assigned and final price ready",
    body: "Review the final price and submit the digital downpayment.",
    at: AT,
    read: false,
    // Nothing below may reach a lock screen, whatever a future record carries.
    supplierPriceMinor: 250_000,
    commissionMinor: 25_000,
    payoutMilestones: [{ code: "acceptance", amountMinor: 125_000 }],
  });

  assert.deepEqual(message.data, {
    notificationId: "ntf_1",
    type: "supplier_assignment_final_price",
    orderId: "ord_1",
    at: AT,
  });
  const serialized = JSON.stringify(fcmRequestBody(message, "token"));
  for (const forbidden of ["Minor", "commission", "supplierPrice", "payoutMilestones", "250000", "25000"]) {
    assert.equal(serialized.includes(forbidden), false, `push payload leaked ${forbidden}`);
  }
});

test("a notification with no type or order still produces a readable lock-screen message", () => {
  const message = pushMessageFor({ id: "ntf_2", userId: "u", title: "  ", body: "", at: AT });
  assert.equal(message.title, "GRIDGO");
  assert.equal(message.body, "Open GRIDGO for the latest update.");
  assert.deepEqual(message.data, { notificationId: "ntf_2", at: AT });
});

test("the FCM request body pins the Android channel the apps must create", () => {
  const body = fcmRequestBody(pushMessageFor({ id: "ntf_3", title: "T", body: "B", at: AT }), "device-token");
  assert.equal(body.message.token, "device-token");
  assert.equal(body.message.android.notification.channel_id, ANDROID_NOTIFICATION_CHANNEL_ID);
  assert.equal(body.message.android.priority, "high");
  assert.equal(body.message.apns.headers["apns-priority"], "10");
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

test("only genuinely dead tokens are classified as prunable", () => {
  const unregistered = {
    status: 404,
    payload: {
      error: {
        code: 404,
        status: "NOT_FOUND",
        details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
      },
    },
  };
  assert.deepEqual(classifyFcmFailure(unregistered), { prune: true, code: "UNREGISTERED" });

  const wrongSender = {
    status: 403,
    payload: { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } },
  };
  assert.deepEqual(classifyFcmFailure(wrongSender), { prune: true, code: "SENDER_ID_MISMATCH" });

  assert.equal(classifyFcmFailure({ status: 404, payload: {} }).prune, true);
});

test("a malformed message is never mistaken for a dead token", () => {
  // INVALID_ARGUMENT is FCM's answer both to a bad token and to a payload bug.
  // Pruning on the bare status would wipe every live registration the first
  // time a payload regression shipped.
  const payloadBug = {
    status: 400,
    payload: {
      error: {
        status: "INVALID_ARGUMENT",
        details: [
          { errorCode: "INVALID_ARGUMENT" },
          { fieldViolations: [{ field: "message.android.notification.color", description: "bad colour" }] },
        ],
      },
    },
  };
  assert.deepEqual(classifyFcmFailure(payloadBug), { prune: false, code: "INVALID_ARGUMENT" });

  const badToken = {
    status: 400,
    payload: {
      error: {
        status: "INVALID_ARGUMENT",
        details: [
          { errorCode: "INVALID_ARGUMENT" },
          { fieldViolations: [{ field: "message.token", description: "Invalid registration token" }] },
        ],
      },
    },
  };
  assert.deepEqual(classifyFcmFailure(badToken), { prune: true, code: "INVALID_ARGUMENT" });
});

test("transient FCM failures keep the token", () => {
  for (const status of [429, 500, 503]) {
    const verdict = classifyFcmFailure({ status, payload: { error: { status: "UNAVAILABLE" } } });
    assert.equal(verdict.prune, false, `status ${status} must not prune`);
  }
  assert.equal(
    classifyFcmFailure({
      status: 401,
      payload: { error: { status: "UNAUTHENTICATED", details: [{ errorCode: "THIRD_PARTY_AUTH_ERROR" }] } },
    }).prune,
    false,
  );
});

// ---------------------------------------------------------------------------
// OAuth2 signing
// ---------------------------------------------------------------------------

test("the service-account assertion is a verifiable RS256 JWT with the messaging scope", () => {
  const { credentials, publicKey } = testCredentials();
  const assertion = signServiceAccountAssertion(credentials, 1_770_000_000);
  const [header, claims, signature] = assertion.split(".");

  assert.equal(
    crypto
      .createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url")),
    true,
    "Google could not verify this assertion",
  );
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
    kid: "test-key-id",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    iss: credentials.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: credentials.tokenUri,
    iat: 1_770_000_000,
    exp: 1_770_003_600,
  });
});

test("an unreadable or incomplete service account is refused by name, never by value", () => {
  assert.equal(loadServiceAccount({}), null, "no configured path means push is simply off");

  assert.throws(
    () => loadServiceAccount({ GRIDGO_FCM_SERVICE_ACCOUNT_FILE: "/nonexistent/fcm.json" }),
    /cannot read: \/nonexistent\/fcm\.json/,
  );

  assert.throws(
    () => loadServiceAccount({ GRIDGO_FCM_SERVICE_ACCOUNT_FILE: "/secret/fcm.json" }, () => "not json"),
    /not valid JSON/,
  );

  assert.throws(
    () =>
      loadServiceAccount({ GRIDGO_FCM_SERVICE_ACCOUNT_FILE: "/secret/fcm.json" }, () =>
        JSON.stringify({ project_id: "p", client_email: "e@example.test" }),
      ),
    /missing 'private_key'/,
  );
});

// ---------------------------------------------------------------------------
// Delivery client
// ---------------------------------------------------------------------------

test("the access token is minted once and reused until it nears expiry", async () => {
  const { credentials } = testCredentials();
  const calls = [];
  let clockMs = 1_770_000_000_000;
  const push = createPushDelivery(
    {},
    {
      credentials,
      logger: silentLogger,
      now: () => clockMs,
      fetch: async (url) => {
        calls.push(url);
        if (url === credentials.tokenUri) return tokenResponse("token-1", 3600);
        return fcmResponse(200, { name: "projects/gridgo-test/messages/1" });
      },
    },
  );

  const devices = [{ id: "dev_1", token: "t1" }];
  await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), devices);
  await push.send(pushMessageFor({ id: "n2", title: "T", body: "B", at: AT }), devices);
  assert.equal(calls.filter((url) => url === credentials.tokenUri).length, 1, "minted a token per notification");

  // Past expiry minus the refresh skew, one new token is minted.
  clockMs += 3_500 * 1000;
  await push.send(pushMessageFor({ id: "n3", title: "T", body: "B", at: AT }), devices);
  assert.equal(calls.filter((url) => url === credentials.tokenUri).length, 2);
});

test("a burst of concurrent sends shares one in-flight token mint", async () => {
  const { credentials } = testCredentials();
  let mints = 0;
  const push = createPushDelivery(
    {},
    {
      credentials,
      logger: silentLogger,
      fetch: async (url) => {
        if (url === credentials.tokenUri) {
          mints += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return tokenResponse();
        }
        return fcmResponse(200, {});
      },
    },
  );

  const message = pushMessageFor({ id: "n1", title: "T", body: "B", at: AT });
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => push.send(message, [{ id: `dev_${index}`, token: `t${index}` }])),
  );
  assert.equal(mints, 1, "a burst must not mint one access token per send");
});

test("a revoked access token is refreshed once and the send retried", async () => {
  const { credentials } = testCredentials();
  const bearers = [];
  let mints = 0;
  const push = createPushDelivery(
    {},
    {
      credentials,
      logger: silentLogger,
      fetch: async (url, init) => {
        if (url === credentials.tokenUri) {
          mints += 1;
          return tokenResponse(`token-${mints}`);
        }
        bearers.push(init.headers.Authorization);
        if (bearers.length === 1) return fcmResponse(401, { error: { status: "UNAUTHENTICATED" } });
        return fcmResponse(200, {});
      },
    },
  );

  const [result] = await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), [
    { id: "dev_1", token: "t1" },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(bearers, ["Bearer token-1", "Bearer token-2"]);
  assert.equal(mints, 2);
});

test("one dead phone neither stops the others nor rejects the send", async () => {
  const { credentials } = testCredentials();
  const push = createPushDelivery(
    {},
    {
      credentials,
      logger: silentLogger,
      fetch: async (url, init) => {
        if (url === credentials.tokenUri) return tokenResponse();
        const { token } = JSON.parse(init.body).message;
        if (token === "dead") {
          return fcmResponse(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } });
        }
        if (token === "flaky") {
          return fcmResponse(503, { error: { status: "UNAVAILABLE" } });
        }
        if (token === "exploding") throw new Error("socket hang up");
        return fcmResponse(200, {});
      },
    },
  );

  const results = await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), [
    { id: "dev_live", token: "live" },
    { id: "dev_dead", token: "dead" },
    { id: "dev_flaky", token: "flaky" },
    { id: "dev_boom", token: "exploding" },
  ]);

  assert.deepEqual(
    results.map(({ deviceId, ok, prune }) => ({ deviceId, ok, prune })),
    [
      { deviceId: "dev_live", ok: true, prune: false },
      { deviceId: "dev_dead", ok: false, prune: true },
      { deviceId: "dev_flaky", ok: false, prune: false },
      { deviceId: "dev_boom", ok: false, prune: false },
    ],
  );
});

test("an unreachable Google surfaces as a failed send, not a thrown error", async () => {
  const { credentials } = testCredentials();
  const push = createPushDelivery(
    {},
    {
      credentials,
      logger: silentLogger,
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com");
      },
    },
  );

  const results = await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), [
    { id: "dev_1", token: "t1" },
  ]);
  assert.deepEqual(results, [{ deviceId: "dev_1", ok: false, prune: false, code: "transport_error" }]);
  assert.equal(push.health().status, "unavailable");
});

test("an unconfigured deployment reports disabled and sends nothing", async () => {
  const push = createPushDelivery({}, { logger: silentLogger });
  assert.equal(push.configured, false);
  assert.deepEqual(push.health(), {
    provider: "fcm",
    projectId: null,
    status: "disabled",
    detail: null,
    checkedAt: null,
  });
  assert.deepEqual(await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), [
    { id: "dev_1", token: "t1" },
  ]), []);
});

test("a broken credential disables push loudly instead of refusing to boot", async () => {
  // Docker materialises a bind mount whose host file is missing as a directory,
  // so this is exactly what an uninstalled secret looks like on a fresh deploy.
  const warnings = [];
  const push = createPushDeliveryOrDisable(
    { GRIDGO_FCM_SERVICE_ACCOUNT_FILE: "/run/secrets/fcm-service-account.json" },
    { logger: { warn: (message) => warnings.push(message) } },
  );

  assert.equal(push.configured, false);
  const health = push.health();
  assert.equal(health.status, "misconfigured");
  assert.match(health.detail, /cannot read: \/run\/secrets\/fcm-service-account\.json/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /push notifications are DISABLED/);

  assert.deepEqual(await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), [
    { id: "dev_1", token: "t1" },
  ]), []);
});

test("a working credential is unaffected by the disable-on-error wrapper", () => {
  const { credentials } = testCredentials();
  const push = createPushDeliveryOrDisable({}, { credentials, logger: silentLogger });
  assert.equal(push.configured, true);
  assert.equal(push.health().status, "configured");
  assert.equal(push.health().detail, null);
});

test("health names the Firebase project once a send has succeeded", async () => {
  const { credentials } = testCredentials();
  const push = createPushDelivery(
    {},
    {
      credentials,
      logger: silentLogger,
      fetch: async (url) => (url === credentials.tokenUri ? tokenResponse() : fcmResponse(200, {})),
    },
  );
  assert.deepEqual(push.health(), {
    provider: "fcm",
    projectId: "gridgo-test",
    status: "configured",
    detail: null,
    checkedAt: null,
  });

  await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), [{ id: "dev_1", token: "t1" }]);
  const health = push.health();
  assert.equal(health.status, "available");
  assert.equal(typeof health.checkedAt, "string");
});
