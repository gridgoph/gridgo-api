import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { apnsPayload, apnsToken, createApnsDelivery } from "../src/apns.js";
test("APNs uses native device tokens and minimal data with signed provider JWT", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwt = apnsToken({ keyId: "key", teamId: "team", privateKey }, 100);
  const parts = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(parts[1], "base64url")).iss, "team");
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from(parts.slice(0, 2).join(".")),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  );
  assert.deepEqual(
    apnsPayload({ title: "t", body: "b", data: { notificationId: "n" } }),
    {
      aps: { alert: { title: "t", body: "b" }, sound: "default" },
      notificationId: "n",
    },
  );
});
test("missing APNs credentials remain explicitly disabled", () => {
  const d = createApnsDelivery({});
  assert.equal(d.configured, false);
  assert.equal(d.health().status, "disabled");
});

test("legacy iOS FCM tokens never enter APNs delivery or pruning", async () => {
  const { routePushDelivery } = await import("../src/apns.js");
  const received = [];
  const fcm = {
    configured: true,
    send: async (_message, devices) => {
      received.push(...devices.map((d) => d.id));
      return devices.map((d) => ({ deviceId: d.id, ok: true, prune: false }));
    },
  };
  const apns = createApnsDelivery({ GRIDGO_APNS_TOPIC: "test.app" }, { credentials: {} });
  const devices = [
    { id: "legacy", userId: "u", platform: "ios", token: "existing-fcm-registration" },
    { id: "explicit-fcm", userId: "u", platform: "ios", tokenProvider: "fcm", token: "another-fcm-registration" },
    { id: "explicit-apns", userId: "u", platform: "ios", tokenProvider: "apns", token: "invalid-native-token" },
  ];
  const results = await routePushDelivery(fcm, apns).send({ title: "test", body: "test", data: {} }, devices);
  assert.deepEqual(received, ["legacy", "explicit-fcm"]);
  assert.deepEqual(results.map((r) => r.prune), [false, false, true]);
  assert.equal(results[2].code, "BadDeviceToken");
});
