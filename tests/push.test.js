import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  ANDROID_NOTIFICATION_CHANNEL_ID,
  PushAudienceError,
  UNCLAIMED_DEVICE_LIMIT,
  announcementPushMessage,
  assertStrangerSafeMessage,
  ensureDeviceTokens,
  claimDeviceToken,
  classifyFcmFailure,
  createPushDelivery,
  createPushDeliveryOrDisable,
  deviceTokensFor,
  fcmRequestBody,
  PRODUCTION_NUDGE_CHANNEL_ID,
  PRODUCTION_NUDGE_SOUND,
  announcementImageOrigin,
  isFcmFetchableImageUrl,
  isFcmTokenShaped,
  loadServiceAccount,
  normalizeAnnouncementImageUrl,
  resolveFcmImageUrl,
  publicDevice,
  pushMessageFor,
  registerDeviceToken,
  registerUnclaimedDeviceToken,
  releaseDeviceToken,
  removeDeviceTokenIds,
  signServiceAccountAssertion,
  unclaimedDeviceLimit,
  unclaimedDeviceTokens,
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

test("device-token snapshot initialization is idempotent", () => {
  const store = { users: [] };
  assert.equal(ensureDeviceTokens(store), true);
  assert.deepEqual(store.deviceTokens, []);
  const afterFirst = JSON.stringify(store);

  assert.equal(ensureDeviceTokens(store), false);
  assert.equal(JSON.stringify(store), afterFirst, "second normalization changed the snapshot");
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
  assert.deepEqual(Object.keys(projected).sort(), ["appRole", "createdAt", "id", "platform", "tokenProvider", "tokenTail", "updatedAt", "userId"]);
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
// Handsets nobody has signed in on
// ---------------------------------------------------------------------------

test("a registration without ownership gains an explicit unclaimed userId once", () => {
  const store = {
    deviceTokens: [{ id: "dev_legacy", token: "legacy-phone", platform: "android", createdAt: AT, updatedAt: AT }],
  };
  assert.equal(ensureDeviceTokens(store), true);
  assert.equal(store.deviceTokens[0].userId, null);
  const afterFirst = JSON.stringify(store);

  assert.equal(ensureDeviceTokens(store), false);
  assert.equal(JSON.stringify(store), afterFirst, "second normalization changed the snapshot");
});

test("an unclaimed registration answers to nobody, not to an empty caller", () => {
  const store = {};
  registerUnclaimedDeviceToken(store, { token: "anonymous-phone", platform: "android", at: AT });
  registerDeviceToken(store, { userId: "user_client", token: "client-phone", platform: "android", at: AT });

  // The load-bearing guard: an unclaimed row stores `userId: null`, so a
  // caller-scoped lookup with a missing id must match nothing rather than
  // matching every anonymous handset on the platform.
  for (const caller of [null, undefined, "", 0, false]) {
    assert.deepEqual(deviceTokensFor(store, caller), [], `deviceTokensFor(${JSON.stringify(caller)}) matched a device`);
  }
  assert.deepEqual(deviceTokensFor(store, "user_client").map(({ token }) => token), ["client-phone"]);
  assert.deepEqual(unclaimedDeviceTokens(store).map(({ token }) => token), ["anonymous-phone"]);
});

test("an unclaimed handset re-registers into one row and is claimed by signing in", () => {
  const store = {};
  const first = registerUnclaimedDeviceToken(store, { token: "handset", platform: "android", at: AT });
  assert.equal(first.created, true);
  assert.equal(first.device.userId, null);

  const again = registerUnclaimedDeviceToken(store, { token: "handset", platform: "ios", at: LATER });
  assert.equal(again.created, false);
  assert.equal(store.deviceTokens.length, 1, "re-registration duplicated an unclaimed handset");
  assert.equal(store.deviceTokens[0].platform, "ios");
  assert.equal(store.deviceTokens[0].createdAt, AT);
  assert.equal(store.deviceTokens[0].updatedAt, LATER);

  const claimed = claimDeviceToken(store, { token: "handset", userId: "user_client", at: LATER });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.previousUserId, null, "claiming an unclaimed handset took it from nobody");
  assert.equal(store.deviceTokens.length, 1);
  assert.deepEqual(deviceTokensFor(store, "user_client").map(({ id }) => id), [first.device.id]);
  assert.deepEqual(unclaimedDeviceTokens(store), []);

  // Signing in again on the same handset is not a second claim.
  assert.equal(claimDeviceToken(store, { token: "handset", userId: "user_client", at: LATER }).claimed, false);
  // A handset the server has never seen cannot be claimed by a login alone: a
  // login knows no platform, so the app registers with its new bearer token.
  assert.equal(claimDeviceToken(store, { token: "unknown", userId: "user_client", at: LATER }).claimed, false);
  assert.equal(store.deviceTokens.length, 1);
});

test("registering under an account claims an unclaimed handset rather than reassigning it", () => {
  const store = {};
  registerUnclaimedDeviceToken(store, { token: "handset", platform: "android", at: AT });
  const registered = registerDeviceToken(store, {
    userId: "user_client",
    token: "handset",
    platform: "android",
    at: LATER,
  });

  assert.equal(registered.created, false);
  assert.equal(registered.reassignedFrom, null, "nobody loses a phone that belonged to nobody");
  assert.equal(registered.claimedFromUnclaimed, true);
  assert.equal(store.deviceTokens.length, 1);
});

test("signing out releases the handset instead of deleting it", () => {
  const store = {};
  registerDeviceToken(store, { userId: "user_client", token: "handset", platform: "android", at: AT });
  registerDeviceToken(store, { userId: "user_rider", token: "rider-phone", platform: "android", at: AT });

  // Another account's sign-out never touches it.
  assert.equal(releaseDeviceToken(store, { userId: "user_client", token: "rider-phone", at: LATER }).released, false);
  assert.equal(deviceTokensFor(store, "user_rider").length, 1);

  const released = releaseDeviceToken(store, { userId: "user_client", token: "handset", at: LATER });
  assert.equal(released.released, true);
  assert.deepEqual(deviceTokensFor(store, "user_client"), []);
  assert.deepEqual(
    unclaimedDeviceTokens(store).map(({ token }) => token),
    ["handset"],
    "signing out closed the app-update channel for this handset",
  );
  // An unclaimed row is not released a second time.
  assert.equal(releaseDeviceToken(store, { userId: "user_client", token: "handset", at: LATER }).released, false);
});

test("an anonymous caller may not move or delete a claimed registration", () => {
  const store = {};
  const owned = registerDeviceToken(store, {
    userId: "user_client",
    token: "handset",
    platform: "android",
    at: AT,
  }).device;
  const before = structuredClone(owned);

  const steal = registerUnclaimedDeviceToken(store, { token: "handset", platform: "web", at: LATER });
  assert.equal(steal.claimedElsewhere, true);
  assert.equal(steal.changed, false);
  assert.deepEqual(store.deviceTokens, [before], "an anonymous registration mutated a claimed row");

  assert.equal(unregisterDeviceToken(store, { userId: null, token: "handset" }).changed, false);
  assert.deepEqual(store.deviceTokens, [before], "an anonymous unregister deleted a claimed row");

  // An unclaimed row is anyone's to remove — the token is the only proof of
  // possession an anonymous handset can offer.
  registerUnclaimedDeviceToken(store, { token: "anonymous-phone", platform: "android", at: LATER });
  assert.equal(unregisterDeviceToken(store, { userId: null, token: "anonymous-phone" }).removed.userId, null);
  assert.deepEqual(unclaimedDeviceTokens(store), []);
});

test("the unclaimed pool is bounded, evicting the least recently seen first", () => {
  const store = {};
  registerDeviceToken(store, { userId: "user_client", token: "owned", platform: "android", at: AT });
  for (const [index, token] of ["oldest", "middle", "newest"].entries()) {
    registerUnclaimedDeviceToken(store, {
      token,
      platform: "android",
      at: `2026-08-11T0${index}:00:00.000Z`,
      limit: 3,
    });
  }
  assert.equal(unclaimedDeviceTokens(store).length, 3);

  const overflow = registerUnclaimedDeviceToken(store, { token: "arrival", platform: "android", at: LATER, limit: 3 });
  assert.equal(overflow.evicted, 1);
  assert.deepEqual(
    unclaimedDeviceTokens(store).map(({ token }) => token),
    ["middle", "newest", "arrival"],
  );
  assert.deepEqual(
    deviceTokensFor(store, "user_client").map(({ token }) => token),
    ["owned"],
    "a claimed registration was evicted to make room for an anonymous one",
  );
});

test("only something shaped like an FCM registration token is accepted anonymously", () => {
  const real = `${"cQ7hK2ZtR0uWx9Yb".repeat(9).slice(0, 140)}:APA91bHu`;
  assert.equal(isFcmTokenShaped(real), true);
  assert.equal(isFcmTokenShaped(`${"a".repeat(80)}-_.:`), true, "a valid token character was rejected");
  for (const junk of ["", "fcm-token", "a".repeat(63), "a".repeat(4097), `${"a".repeat(80)} b`, `${"a".repeat(80)}<`]) {
    assert.equal(isFcmTokenShaped(junk), false, `accepted ${JSON.stringify(junk.slice(0, 20))}`);
  }

  assert.equal(unclaimedDeviceLimit({}), UNCLAIMED_DEVICE_LIMIT);
  assert.equal(unclaimedDeviceLimit({ GRIDGO_MAX_UNCLAIMED_DEVICES: "25" }), 25);
  assert.equal(unclaimedDeviceLimit({ GRIDGO_MAX_UNCLAIMED_DEVICES: "-1" }), UNCLAIMED_DEVICE_LIMIT);
  assert.equal(unclaimedDeviceLimit({ GRIDGO_MAX_UNCLAIMED_DEVICES: "many" }), UNCLAIMED_DEVICE_LIMIT);
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
    supplierSubtotalMinor: 250_000,
    serviceFeeMinor: 25_000,
    payoutMilestones: [{ code: "acceptance", amountMinor: 125_000 }],
  });

  assert.deepEqual(message.data, {
    notificationId: "ntf_1",
    type: "supplier_assignment_final_price",
    orderId: "ord_1",
    at: AT,
  });
  const serialized = JSON.stringify(fcmRequestBody(message, "token"));
  for (const forbidden of ["Minor", "supplierSubtotal", "serviceFee", "payoutMilestones", "250000", "25000"]) {
    assert.equal(serialized.includes(forbidden), false, `push payload leaked ${forbidden}`);
  }
});

test("a notification with no type or order still produces a readable lock-screen message", () => {
  const message = pushMessageFor({ id: "ntf_2", userId: "u", title: "  ", body: "", at: AT });
  assert.equal(message.title, "GRIDGO update");
  assert.equal(message.body, "Open GRIDGO for the latest update.");
  assert.deepEqual(message.data, { notificationId: "ntf_2", at: AT });
});

test("the FCM request body pins the Android channel the apps must create", () => {
  const message = pushMessageFor({ id: "ntf_3", type: "shop_job_may_start", title: "T", body: "B", at: AT });
  const body = fcmRequestBody(message, "device-token");
  assert.equal(body.message.token, "device-token");
  assert.equal(body.message.android.notification.channel_id, ANDROID_NOTIFICATION_CHANNEL_ID);
  assert.equal(body.message.apns.payload.aps.sound, "default");
  assert.equal(body.message.android.priority, "high");
  assert.equal(body.message.apns.headers["apns-priority"], "10");
  assert.equal(message.title, "GRIDGO update");
});

test("a production inactivity reminder names its own channel and sound", () => {
  const message = pushMessageFor({
    id: "ntf_nudge",
    type: "shop_production_inactive",
    orderId: "ord_1",
    title: "Update this job on the press",
    body: "Nothing has moved on this job for a while.",
    at: AT,
  });
  assert.equal(message.title, "GRIDGO update");
  assert.equal(message.body, "Open GRIDGO for the latest update.");
  assert.deepEqual(message.data, {
    notificationId: "ntf_nudge",
    type: "shop_production_inactive",
    orderId: "ord_1",
    at: AT,
  });
  const body = fcmRequestBody(message, "device-token");
  assert.equal(body.message.android.notification.channel_id, PRODUCTION_NUDGE_CHANNEL_ID);
  assert.equal(body.message.apns.payload.aps.sound, PRODUCTION_NUDGE_SOUND);
});

test("an announcement message carries a routing type and nothing else", () => {
  const message = announcementPushMessage({
    title: "  Update your app  ",
    body: "GRIDGO 1.4 is available in the store.",
  });
  assert.equal(message.title, "Update your app");
  assert.deepEqual(message.data, { type: "announcement" });
  assert.equal(message.image, undefined);
  assertStrangerSafeMessage(message);

  const empty = announcementPushMessage({ title: "", body: "" });
  assert.equal(empty.title, "GRIDGO");
  assert.equal(empty.body, "Open GRIDGO for the latest update.");
});

test("a public HTTPS picture rides the FCM notification, never the data map", () => {
  const publicImage = "https://cdn.gridgo.example/update.png";
  const message = announcementPushMessage({
    title: "Update your app",
    body: "1.6 is out.",
    imageUrl: publicImage,
  });
  assert.equal(message.image, publicImage);
  assert.deepEqual(message.data, { type: "announcement" });
  assertStrangerSafeMessage(message);

  const body = fcmRequestBody(message, "device-token");
  assert.equal(body.message.notification.image, publicImage);
  assert.equal(body.message.android.notification.image, publicImage);
  assert.equal(body.message.apns.fcm_options.image, publicImage);
  assert.equal(body.message.apns.payload.aps["mutable-content"], 1);
  assert.equal(JSON.stringify(body.message.data).includes("cdn.gridgo"), false);
});

test("the phone can download a LAN picture; hosted paths need a phone-visible origin", () => {
  const lan = "http://192.168.1.55:8787/public/announcement-images/file_aaaaaaaaaaaa";
  assert.equal(isFcmFetchableImageUrl(lan), true);
  assert.equal(isFcmFetchableImageUrl("https://cdn.gridgo.example/pic.png"), true);
  assert.equal(isFcmFetchableImageUrl("javascript:alert(1)"), false);

  const hosted = "/public/announcement-images/file_aaaaaaaaaaaa";
  assert.equal(resolveFcmImageUrl(hosted, {}), null);
  assert.equal(
    announcementImageOrigin({ MINIO_PUBLIC_URL: "http://192.168.1.55:9000" }),
    "http://192.168.1.55:8787",
  );
  assert.equal(
    announcementImageOrigin({ MINIO_PUBLIC_URL: "https://files.talasora.com" }),
    "",
  );
  assert.equal(
    resolveFcmImageUrl(hosted, { MINIO_PUBLIC_URL: "http://192.168.1.55:9000" }),
    lan,
  );
  assert.equal(
    resolveFcmImageUrl(hosted, { GRIDGO_PUBLIC_API_ORIGIN: "https://gridgo-api.talasora.com" }),
    "https://gridgo-api.talasora.com/public/announcement-images/file_aaaaaaaaaaaa",
  );

  const message = pushMessageFor({
    id: "ntf_img",
    title: "T",
    body: "B",
    at: AT,
    imageUrl: hosted,
  }, { MINIO_PUBLIC_URL: "http://192.168.1.55:9000" });
  assert.equal(message.image, lan);
});

test("announcement image URLs accept hosted paths and http(s) links only", () => {
  assert.deepEqual(normalizeAnnouncementImageUrl("  "), { imageUrl: null });
  assert.deepEqual(
    normalizeAnnouncementImageUrl("/public/announcement-images/file_aaaaaaaaaaaa"),
    { imageUrl: "/public/announcement-images/file_aaaaaaaaaaaa" },
  );
  assert.equal(normalizeAnnouncementImageUrl("javascript:alert(1)").error, "invalid_announcement_image");
  assert.equal(normalizeAnnouncementImageUrl("/public/announcement-images/nope").error, "invalid_announcement_image");
  assert.equal(normalizeAnnouncementImageUrl("https://user:pass@cdn.example/x.png").error, "invalid_announcement_image");
});

test("a personal notification is refused before it can reach a stranger's handset", () => {
  const personal = pushMessageFor({
    id: "ntf_1",
    userId: "user_client",
    type: "supplier_assignment_final_price",
    orderId: "ord_1",
    title: "Supplier assigned and final price ready",
    body: "Review the final price and submit the digital downpayment.",
    at: AT,
  });

  assert.throws(() => assertStrangerSafeMessage(personal), PushAudienceError);
  assert.throws(
    () => assertStrangerSafeMessage({ title: "T", body: "B", data: { type: "announcement", orderId: "ord_1" } }),
    /orderId/,
    "an order id was allowed onto an anonymous handset",
  );
  assert.throws(
    () => assertStrangerSafeMessage({ title: "T", body: "B", data: { type: "payout_released" } }),
    PushAudienceError,
    "a personal message type was allowed onto an anonymous handset",
  );
  assert.throws(() => assertStrangerSafeMessage({ title: "T", body: "B" }), PushAudienceError);
});

test("the delivery client refuses a fan-out that would push personal content to an unclaimed device", async () => {
  const { credentials } = testCredentials();
  const sent = [];
  const push = createPushDelivery(
    {},
    {
      credentials,
      logger: silentLogger,
      fetch: async (url, init) => {
        if (url === credentials.tokenUri) return tokenResponse();
        sent.push(JSON.parse(init.body).message.token);
        return fcmResponse(200, {});
      },
    },
  );

  const store = {};
  registerUnclaimedDeviceToken(store, { token: "anonymous-phone", platform: "android", at: AT });
  registerDeviceToken(store, { userId: "user_client", token: "client-phone", platform: "android", at: AT });
  const personal = pushMessageFor({ id: "ntf_1", userId: "user_client", orderId: "ord_1", title: "T", body: "B", at: AT });

  // The guard sits at the one function that talks to FCM, so it holds even when
  // a caller hands it the wrong audience outright.
  await assert.rejects(() => push.send(personal, store.deviceTokens), PushAudienceError);
  await assert.rejects(() => push.send(personal, unclaimedDeviceTokens(store)), PushAudienceError);
  assert.deepEqual(sent, [], "a personal notification was pushed to an unclaimed device");

  // The two audiences that are allowed still go through.
  await push.send(personal, deviceTokensFor(store, "user_client"));
  await push.send(announcementPushMessage({ title: "Update your app", body: "1.4 is out." }), store.deviceTokens);
  assert.deepEqual(sent, ["client-phone", "anonymous-phone", "client-phone"]);
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

  const devices = [{ id: "dev_1", userId: "user_client", token: "t1" }];
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
    Array.from({ length: 8 }, (_, index) =>
      push.send(message, [{ id: `dev_${index}`, userId: "user_client", token: `t${index}` }]),
    ),
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
    { id: "dev_1", userId: "user_client", token: "t1" },
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
    { id: "dev_live", userId: "user_client", token: "live" },
    { id: "dev_dead", userId: "user_client", token: "dead" },
    { id: "dev_flaky", userId: "user_client", token: "flaky" },
    { id: "dev_boom", userId: "user_client", token: "exploding" },
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
    { id: "dev_1", userId: "user_client", token: "t1" },
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
    { id: "dev_1", userId: "user_client", token: "t1" },
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
    { id: "dev_1", userId: "user_client", token: "t1" },
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

  await push.send(pushMessageFor({ id: "n1", title: "T", body: "B", at: AT }), [{ id: "dev_1", userId: "user_client", token: "t1" }]);
  const health = push.health();
  assert.equal(health.status, "available");
  assert.equal(typeof health.checkedAt, "string");
});

test("claimed and anonymous iOS registrations default to FCM and accept explicit APNs", () => {
  for (const register of [registerDeviceToken, registerUnclaimedDeviceToken]) {
    const store = { deviceTokens: [] };
    const args = { userId: "user", platform: "ios", token: "legacy-fcm-token", at: AT };
    const legacy = register(store, args).device;
    assert.equal(legacy.tokenProvider, "fcm");
    assert.equal(publicDevice(legacy).tokenProvider, "fcm");
    delete legacy.tokenProvider;
    assert.equal(publicDevice(legacy).tokenProvider, "fcm");
    assert.equal(register(store, { ...args, at: LATER }).device.tokenProvider, "fcm");
    const native = register(store, { ...args, token: "a".repeat(64), tokenProvider: "apns" }).device;
    assert.equal(native.tokenProvider, "apns");
    assert.equal(register(store, { ...args, token: native.token, tokenProvider: "apns", at: LATER }).device.tokenProvider, "apns");
  }
});

test("anonymous registration cannot rewrite a claimed device provider", () => {
  const store = { deviceTokens: [] };
  const device = registerDeviceToken(store, { userId: "user", platform: "ios", token: "a".repeat(64), at: AT }).device;
  const result = registerUnclaimedDeviceToken(store, { platform: "ios", token: device.token, tokenProvider: "apns", at: LATER });
  assert.equal(result.changed, false);
  assert.equal(device.tokenProvider, "fcm");
});
